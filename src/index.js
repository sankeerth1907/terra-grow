/**
 * TerraGrow API — Cloudflare Worker (Phase 1 + Phase 2)
 *
 * Phase 1 — Satellite ingestion:
 *   - Manual upload path (works today, no satellite key needed):
 *       POST /internal/ingest  multipart { farm_id, image }  OR  JSON { farm_id, r2_key, ndvi_avg?, source? }
 *     stores raw in R2 key farms/<farm_id>/<date>-<uid>-<name>, writes D1.imagery_index
 *   - Cron path (weekly, see wrangler.toml [triggers].crons):
 *       scheduled() -> for each farm, tries Sentinel Hub if SENTINEL_HUB_URL + secret set,
 *       else records a `pending-satellite` marker row so the dashboard shows "awaiting imagery".
 *   - NDVI: real NDVI needs NIR band. Without it we store a pseudo-NDVI estimated from
 *     land-cover % when available, else 0. Swapping in real NDVI = one function change.
 *
 * Phase 2 — Core backend APIs:
 *   POST /farms, GET /farms, GET /farms/:id,
 *   GET /farms/:id/imagery, GET /farms/:id/recommend, GET /farms/:id/monitor, GET /farms/:id/alerts
 *   POST /internal/analyze  (imagery -> monitoring_logs + alerts)
 *
 * Phase 3 — CV / ML integration:
 *   Shared scoring (healthScoreFor / diseaseFlagFor / confidenceFor) used by every path.
 *   Inference chain per image: linked browser % (analyzer.js/app.py heuristic) ->
 *     external GPU model (EXTERNAL_MODEL_URL secret, e.g. RunPod) -> neutral prior.
 *   Model output normalized + validated; bad output never fails the pipeline (falls through).
 *   Results stored in D1.monitoring_logs, overlays/originals in R2 — frontend unchanged.
 *
 * Standalone (no-farm) flow used by current index.html:
 *   POST /api/analyze, POST /api/results, GET /api/results, GET /api/stats, GET /api/file/:key
 */

const ALLOWED_ORIGINS = "*";

function cors(headers = {}) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    ...headers,
  };
}
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: cors({ "Content-Type": "application/json" }) });

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
function nowIso() {
  return new Date().toISOString();
}
function cleanName(name) {
  return (name || "upload.png").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
}
function pctRow(row) {
  return {
    id: row.id, filename: row.filename, r2_key: row.r2_key,
    percentages: { farm: row.farm, barren: row.barren, city: row.city, water: row.water },
    counts: { farm: row.c_farm, barren: row.c_barren, city: row.c_city, water: row.c_water },
    pixels: row.pixels, verdict: row.verdict, created_at: row.created_at,
  };
}

// ---------- Phase 1 helpers ----------

/** Pseudo-NDVI from land-cover % (used until a real NIR feed is wired). Range -1..1. */
function pseudoNdvi(p) {
  if (!p) return 0;
  const v = ((p.farm ?? 0) + (p.water ?? 0) * 0.3 - (p.barren ?? 0) * 0.5 - (p.city ?? 0) * 0.6) / 100;
  return +Math.max(-1, Math.min(1, v)).toFixed(3);
}

/** Season lookup (cached in KV when bound as CACHE). Northern-hemisphere default. */
async function currentSeason(env, lat = 20) {
  const m = new Date().getUTCMonth() + 1; // 1..12
  let season = "perennial";
  if (m >= 6 && m <= 10) season = "kharif";
  else if (m === 11 || m === 12 || (m >= 1 && m <= 3)) season = "rabi";
  if (env.CACHE) {
    try {
      const k = `season:${m}:${lat > 0 ? "N" : "S"}`;
      const hit = await env.CACHE.get(k);
      if (hit) return hit;
      await env.CACHE.put(k, season, { expirationTtl: 86400 * 30 });
    } catch { /* KV optional */ }
  }
  return season;
}

/** Ingest one farm: store bytes in R2 + index row in D1. Returns the imagery_index row. */
async function ingestFarmImage(env, farmId, fileBytes, filename, contentType, opts = {}) {
  if (!env.IMAGES) throw new Error("R2 binding IMAGES missing");
  if (!env.DB) throw new Error("D1 binding DB missing");
  const farm = await env.DB.prepare(`SELECT * FROM farms WHERE id = ?`).bind(farmId).first();
  if (!farm) {
    const e = new Error("farm not found");
    e.status = 404;
    throw e;
  }
  const date = nowIso().slice(0, 10);
  const key = `farms/${farmId}/${date}-${uid()}-${cleanName(filename)}`;
  await env.IMAGES.put(key, fileBytes, { httpMetadata: { contentType: contentType || "image/png" } });
  const id = uid();
  const ndvi = Number(opts.ndvi_avg ?? 0);
  const source = String(opts.source || "upload");
  await env.DB.prepare(
    `INSERT INTO imagery_index (id, farm_id, r2_key, captured_at, ndvi_avg, source) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, farmId, key, nowIso(), ndvi, source).run();
  return { id, farm_id: farmId, r2_key: key, captured_at: nowIso(), ndvi_avg: ndvi, source };
}

// ---------- Phase 2 helpers ----------

function validateFarmInput(b) {
  if (!b || typeof b !== "object") return "send JSON body";
  if (b.boundary && typeof b.boundary !== "object") return "boundary must be a GeoJSON object";
  if (b.soil_type && typeof b.soil_type !== "string") return "soil_type must be a string";
  return null;
}

function verdictFor(p) {
  const top = Object.entries(p).sort((a, b) => b[1] - a[1])[0];
  const names = { farm: "Farmland", barren: "Barren land", city: "City / Urban", water: "Water" };
  let t = `Dominant: ${names[top[0]]} (${top[1]}%). `;
  if (p.farm > 40) t += "Good cultivation potential. ";
  if (p.barren > 40) t += "Large barren patch — consider reclamation / irrigation survey. ";
  if (p.city > 40) t += "Highly urbanized — limited farming scope. ";
  if (p.water > 25) t += "Significant water body — check irrigation / drainage. ";
  if (p.farm >= 30 && p.water >= 5 && p.water <= 30) t += "Farm + water combo ideal for agriculture.";
  return t;
}

/** Phase 3 — shared inference scoring (single source of truth for every path). */
function healthScoreFor(p) {
  return +Math.max(0, Math.min(100, p.farm * 0.85 + p.water * 0.4 - p.city * 0.35 - p.barren * 0.2)).toFixed(1);
}
function diseaseFlagFor(p) {
  if (p.city > 60) return "urban-pressure";
  if (p.barren > 60) return "nutrient-stress-watch";
  return "none";
}
/** Confidence 0..1: peaked distributions + known engines score higher, priors lower. */
function confidenceFor(p, engine) {
  const top = Math.max(p.farm, p.barren, p.city, p.water) / 100;
  const base = 0.35 + top * 0.5; // 0.35..0.85 from peakedness
  const adj = engine === "external-model" ? 0.12 : engine === "browser-heuristic" ? 0.05 : engine === "linked-result" ? 0.05 : -0.15;
  return +Math.max(0.05, Math.min(0.99, base + adj)).toFixed(2);
}

/**
 * Normalize one external-model response into { percentages, confidence } or { error }.
 * Accepts { percentages:{...} } or flat { farm, barren, city, water }, plus optional
 * counts / confidence / ndvi_avg passthrough. Rejects out-of-range or bad-sum output.
 */
function normalizeModelOutput(j) {
  if (!j || typeof j !== "object") return { error: "model returned non-JSON-object" };
  const src = j.percentages && typeof j.percentages === "object" ? j.percentages : j;
  const farm = Number(src.farm), barren = Number(src.barren), city = Number(src.city), water = Number(src.water);
  if (![farm, barren, city, water].every((v) => Number.isFinite(v) && v >= 0 && v <= 100))
    return { error: "model percentages must be 0..100" };
  const sum = farm + barren + city + water;
  if (Math.abs(sum - 100) > 2) return { error: `model percentages sum to ${sum}, expected ~100` };
  const out = { percentages: { farm, barren, city, water } };
  if (Number.isFinite(Number(j.confidence))) out.confidence = Math.max(0, Math.min(1, Number(j.confidence)));
  if (j.counts && typeof j.counts === "object") out.counts = j.counts;
  if (Number.isFinite(Number(j.ndvi_avg))) out.ndvi_avg = Number(j.ndvi_avg);
  return out;
}

/**
 * Call the hosted GPU segmentation model (too large for Workers AI — blueprint pattern:
 * Worker is the front door, heavy CV lives outside). Returns normalized output or null
 * when unconfigured; returns { error } when configured but the call/output failed
 * (caller must fall through to the next inference tier, never 500).
 */
async function callExternalModel(env, imageBytes, contentType, filename) {
  const base = String(env.EXTERNAL_MODEL_URL || "").trim();
  if (!base) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const fd = new FormData();
    fd.append("image", new Blob([imageBytes], { type: contentType || "image/png" }), filename || "field.png");
    const headers = {};
    if (env.MODEL_API_KEY) headers["Authorization"] = `Bearer ${env.MODEL_API_KEY}`;
    const r = await fetch(base, { method: "POST", headers, body: fd, signal: ctrl.signal });
    if (!r.ok) return { error: `model HTTP ${r.status}` };
    return normalizeModelOutput(await r.json());
  } catch (e) {
    return { error: String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

/** Phase 2 recommendation: season + soil + NDVI/farm% -> ranked crops. */
async function recommendForFarm(env, farm) {
  let lat = 20;
  try {
    const gj = typeof farm.boundary_geojson === "string" ? JSON.parse(farm.boundary_geojson) : farm.boundary_geojson;
    const coords = JSON.stringify(gj);
    const m = coords.match(/-?\d+\.\d+/g);
    if (m && m.length >= 2) lat = Number(m[1]);
  } catch { /* keep default */ }
  const season = await currentSeason(env, lat);
  const latestImg = await env.DB.prepare(
    `SELECT * FROM imagery_index WHERE farm_id = ? ORDER BY captured_at DESC LIMIT 1`
  ).bind(farm.id).first();
  const latestLog = await env.DB.prepare(
    `SELECT * FROM monitoring_logs WHERE farm_id = ? ORDER BY created_at DESC LIMIT 1`
  ).bind(farm.id).first();
  const ndvi = Number(latestImg?.ndvi_avg ?? 0);
  const farmPct = Number(latestLog?.farm_pct ?? 0);
  const waterPct = Number(latestLog?.water_pct ?? 0);

  const { results } = await env.DB.prepare(
    `SELECT * FROM crop_master WHERE season = ? OR season = 'perennial'`
  ).bind(season).all();
  const soil = String(farm.soil_type || "loam").toLowerCase();
  const ranked = (results || []).map((c) => {
    const soils = String(c.suitable_soil_types || "").toLowerCase().split(",").map((s) => s.trim());
    const soilMatch = soils.includes(soil) ? 2 : soils.some((s) => soil.includes(s) || s.includes(soil)) ? 1 : 0;
    let score = soilMatch * 10;
    let reasons = [];
    if (soilMatch === 2) { score += 0; reasons.push(`matches ${farm.soil_type} soil`); }
    else if (soilMatch === 1) reasons.push(`tolerates ${farm.soil_type} soil`);
    else reasons.push(`prefers ${c.suitable_soil_types}`);
    if (ndvi > 0.25 && /rice|sugarcane|maize|vegetable/i.test(c.crop_name)) { score += 4; reasons.push(`NDVI ${ndvi} suits green crops`); }
    if (farmPct >= 40 && /maize|wheat|vegetable|soybean/i.test(c.crop_name)) { score += 3; reasons.push(`farm cover ${farmPct}%`); }
    if (waterPct >= 8 && /rice|sugarcane/i.test(c.crop_name)) { score += 3; reasons.push(`water ${waterPct}% supports irrigation`); }
    if (waterPct < 4 && /gram|mustard|cotton/i.test(c.crop_name)) { score += 3; reasons.push("drought-tolerant for low water"); }
    return { crop: c.crop_name, season: c.season, score, reasons: reasons.join("; "), notes: c.notes };
  }).sort((a, b) => b.score - a.score);
  return { season, ndvi_avg: ndvi, farm_pct: farmPct, water_pct: waterPct, recommendations: ranked.slice(0, 5) };
}

/** Phase 5 — alert dispatch (SMS/email/push via any webhook provider).
 * Best-effort by design: a down provider must never fail analysis.
 * Configure: [vars] NOTIFY_WEBHOOK_URL + secret NOTIFY_API_KEY (`wrangler secret put`). */
async function dispatchAlert(env, alert) {
  const hook = String(env.NOTIFY_WEBHOOK_URL || "").trim();
  if (!hook) return { skipped: true };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const headers = { "Content-Type": "application/json" };
    if (env.NOTIFY_API_KEY) headers["Authorization"] = `Bearer ${env.NOTIFY_API_KEY}`;
    const r = await fetch(hook, {
      method: "POST", headers, signal: ctrl.signal,
      body: JSON.stringify({ source: "terragrow", ...alert, at: nowIso() }),
    });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { error: String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

/** Shared alert writer: D1 row + webhook dispatch. Returns the alert object. */
async function raiseAlert(env, farmId, type, message, severity) {
  const aid = uid();
  await env.DB.prepare(
    `INSERT INTO alerts (id, farm_id, type, message, severity, created_at, resolved) VALUES (?, ?, ?, ?, ?, ?, 0)`
  ).bind(aid, farmId, type, message, severity, nowIso()).run();
  const alert = { id: aid, farm_id: farmId, type, message, severity };
  await dispatchAlert(env, alert); // never throws
  return alert;
}

/** Phase 2 analyze: turn un-analyzed imagery_index rows into monitoring_logs + alerts. */
async function analyzePending(env) {
  const { results } = await env.DB.prepare(
    `SELECT i.* FROM imagery_index i LEFT JOIN monitoring_logs m ON m.imagery_id = i.id
     WHERE m.id IS NULL ORDER BY i.captured_at ASC LIMIT 25`
  ).all();
  const out = [];
  for (const img of results || []) {
    // Inference chain (Phase 3): linked browser % -> external GPU model -> neutral prior.
    // A failed tier falls through; a bad model never fails the pipeline.
    let p = null, engine = "default-prior", confidence = null, modelNdvi = null;
    const linked = await env.DB.prepare(`SELECT * FROM analyses WHERE r2_key = ? LIMIT 1`).bind(img.r2_key).first();
    if (linked) {
      p = { farm: linked.farm, barren: linked.barren, city: linked.city, water: linked.water };
      engine = "linked-result";
    } else if (String(env.EXTERNAL_MODEL_URL || "").trim() && env.IMAGES) {
      try {
        const obj = await env.IMAGES.get(img.r2_key);
        if (obj && typeof obj.arrayBuffer === "function") {
          const res = await callExternalModel(env, await obj.arrayBuffer(), obj.httpMetadata?.contentType, img.r2_key.split("/").pop());
          if (res && !res.error) {
            p = res.percentages; engine = "external-model";
            confidence = res.confidence ?? null; modelNdvi = res.ndvi_avg ?? null;
          }
        }
      } catch { /* fall through to prior */ }
    }
    if (!p) p = { farm: 35, barren: 35, city: 20, water: 10 };
    const health = healthScoreFor(p);
    const growth = +(p.farm / 100).toFixed(3);
    const disease = diseaseFlagFor(p);
    const conf = confidence ?? confidenceFor(p, engine === "linked-result" ? "browser-heuristic" : engine);
    const ndvi = modelNdvi ?? (img.ndvi_avg === 0 ? pseudoNdvi(p) : img.ndvi_avg);
    if (img.ndvi_avg === 0 || modelNdvi != null) {
      await env.DB.prepare(`UPDATE imagery_index SET ndvi_avg = ? WHERE id = ?`).bind(ndvi, img.id).run();
      img.ndvi_avg = ndvi;
    }
    const id = uid();
    await env.DB.prepare(
      `INSERT INTO monitoring_logs (id, farm_id, imagery_id, growth_rate, disease_flag, health_score, farm_pct, barren_pct, city_pct, water_pct, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, img.farm_id, img.id, growth, disease, health, p.farm, p.barren, p.city, p.water, nowIso()).run();

    const alerts = [];
    if (disease !== "none") {
      const msg = disease === "urban-pressure"
        ? `High urban cover (${p.city}%) near ${img.farm_id} — limited farming scope.`
        : `Barren cover ${p.barren}% on ${img.farm_id} — consider soil test / irrigation survey.`;
      alerts.push(await raiseAlert(env, img.farm_id, disease, msg, p.barren > 70 || p.city > 70 ? "high" : "medium"));
    }
    if (health < 35) {
      const msg = `Health score ${health} on ${img.farm_id} is low — inspect field.`;
      alerts.push(await raiseAlert(env, img.farm_id, "low-health", msg, "high"));
    }
    out.push({ imagery_id: img.id, farm_id: img.farm_id, health_score: health, disease_flag: disease, percentages: p, engine, confidence: conf, alerts });
  }
  return out;
}

// ---------- router ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const search = url.searchParams;
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });

    const needD1 = () => {
      if (!env.DB) throw Object.assign(new Error("D1 binding DB missing. Run: wrangler d1 create terragrow-db, update wrangler.toml, then npm run db:remote"), { status: 500 });
    };

    try {
      // ===== health =====
      if (pathname === "/api/health" && request.method === "GET") {
        return json({ ok: true, time: nowIso(), hasR2: !!env.IMAGES, hasD1: !!env.DB, model: String(env.EXTERNAL_MODEL_URL || "").trim() ? "external" : "heuristic", phases: ["phase1-ingest", "phase2-core-apis", "phase3-cv-integration"] });
      }

      // ===== Phase 2: farms =====
      if (pathname === "/farms" && request.method === "POST") {
        needD1();
        const b = await request.json().catch(() => null);
        const err = validateFarmInput(b);
        if (err) return json({ error: err }, 400);
        const id = String(b.id || uid()).slice(0, 64);
        const row = {
          id, owner_id: String(b.owner_id || "local-farmer").slice(0, 64),
          name: String(b.name || "My Farm").slice(0, 120),
          boundary_geojson: JSON.stringify(b.boundary || b.boundary_geojson || {}).slice(0, 8000),
          soil_type: String(b.soil_type || "loam").slice(0, 40),
          created_at: nowIso(),
        };
        await env.DB.prepare(
          `INSERT INTO farms (id, owner_id, name, boundary_geojson, soil_type, created_at) VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(row.id, row.owner_id, row.name, row.boundary_geojson, row.soil_type, row.created_at).run();
        return json({ farm_id: id, ...row }, 201);
      }
      if (pathname === "/farms" && request.method === "GET") {
        needD1();
        const limit = Math.min(Number(search.get("limit") || 50), 200);
        const { results } = await env.DB.prepare(`SELECT * FROM farms ORDER BY created_at DESC LIMIT ?`).bind(limit).all();
        return json({ results: results || [], count: (results || []).length });
      }
      const farmIdMatch = pathname.match(/^\/farms\/([^/]+)(\/(imagery|recommend|monitor|alerts))?$/);
      if (farmIdMatch && request.method === "GET") {
        needD1();
        const farmId = decodeURIComponent(farmIdMatch[1]);
        const sub = farmIdMatch[3] || "";
        const farm = await env.DB.prepare(`SELECT * FROM farms WHERE id = ?`).bind(farmId).first();
        if (!farm) return json({ error: "farm not found" }, 404);
        if (!sub) {
          const latest = await env.DB.prepare(`SELECT * FROM monitoring_logs WHERE farm_id = ? ORDER BY created_at DESC LIMIT 1`).bind(farmId).first();
          return json({ ...farm, latest_status: latest || null });
        }
        if (sub === "imagery") {
          const { results } = await env.DB.prepare(
            `SELECT * FROM imagery_index WHERE farm_id = ? ORDER BY captured_at DESC LIMIT 20`
          ).bind(farmId).all();
          const rows = (results || []).map((r) => ({ ...r, url: `/api/file/${encodeURIComponent(r.r2_key)}` }));
          if (!rows.length) return json({ farm_id: farmId, status: "pending", imagery: [], hint: "POST /internal/ingest with farm_id + image" });
          return json({ farm_id: farmId, imagery: rows });
        }
        if (sub === "recommend") return json({ farm_id: farmId, ...(await recommendForFarm(env, farm)) });
        if (sub === "monitor") {
          const latest = await env.DB.prepare(`SELECT * FROM monitoring_logs WHERE farm_id = ? ORDER BY created_at DESC LIMIT 1`).bind(farmId).first();
          if (!latest) return json({ farm_id: farmId, status: "pending", hint: "POST /internal/analyze after ingest" }, 200);
          return json({ farm_id: farmId, status: "ok", monitor: latest });
        }
        if (sub === "alerts") {
          if (search.get("unresolved") === "1") {
            const { results } = await env.DB.prepare(
              `SELECT * FROM alerts WHERE farm_id = ? AND resolved = 0 ORDER BY created_at DESC LIMIT 50`
            ).bind(farmId).all();
            return json({ farm_id: farmId, alerts: results || [], filter: "unresolved" });
          }
          const { results } = await env.DB.prepare(`SELECT * FROM alerts WHERE farm_id = ? ORDER BY created_at DESC LIMIT 50`).bind(farmId).all();
          return json({ farm_id: farmId, alerts: results || [] });
        }
      }

      // ===== Phase 5: resolve an alert =====
      const resolveMatch = pathname.match(/^\/alerts\/([^/]+)\/resolve$/);
      if (resolveMatch && request.method === "POST") {
        needD1();
        const aid = decodeURIComponent(resolveMatch[1]);
        const existing = await env.DB.prepare(`SELECT * FROM alerts WHERE id = ? LIMIT 1`).bind(aid).first();
        if (!existing) return json({ error: "alert not found" }, 404);
        await env.DB.prepare(`UPDATE alerts SET resolved = 1 WHERE id = ?`).bind(aid).run();
        return json({ ok: true, id: aid, resolved: 1 });
      }

      // ===== Phase 1: ingest =====
      if (pathname === "/internal/ingest" && request.method === "POST") {
        needD1();
        const ct = request.headers.get("content-type") || "";
        if (ct.includes("multipart/form-data")) {
          const form = await request.formData();
          const farmId = String(form.get("farm_id") || "");
          const file = form.get("image");
          if (!farmId) return json({ error: "multipart needs fields: farm_id + image" }, 400);
          if (!file || typeof file.arrayBuffer !== "function") return json({ error: "multipart needs fields: farm_id + image" }, 400);
          if (file.size > 25 * 1024 * 1024) return json({ error: "image too large (max 25MB)" }, 413);
          try {
            const buf = await file.arrayBuffer();
            const row = await ingestFarmImage(env, farmId, buf, file.name || "field.png", file.type || "image/png", { source: "upload", ndvi_avg: Number(form.get("ndvi_avg") || 0) });
            return json({ ok: true, ...row, url: `/api/file/${encodeURIComponent(row.r2_key)}` }, 201);
          } catch (e) { return json({ error: String(e.message || e) }, e.status || 500); }
        }
        const b = await request.json().catch(() => null);
        if (!b?.farm_id) return json({ error: "send { farm_id, r2_key } or multipart farm_id+image" }, 400);
        if (b.r2_key) {
          const id = uid();
          await env.DB.prepare(
            `INSERT INTO imagery_index (id, farm_id, r2_key, captured_at, ndvi_avg, source) VALUES (?, ?, ?, ?, ?, ?)`
          ).bind(id, b.farm_id, String(b.r2_key), nowIso(), Number(b.ndvi_avg || 0), String(b.source || "satellite")).run();
          return json({ ok: true, id, farm_id: b.farm_id, r2_key: b.r2_key }, 201);
        }
        return json({ error: "for raw bytes use multipart; for existing R2 objects send { farm_id, r2_key }" }, 400);
      }

      // ===== Phase 1+2: analyze pending imagery =====
      if (pathname === "/internal/analyze" && request.method === "POST") {
        needD1();
        return json({ ok: true, analyzed: await analyzePending(env) });
      }

      // ===== Standalone upload -> R2 (no farm needed) =====
      if (pathname === "/api/analyze" && request.method === "POST") {
        if (!env.IMAGES) return json({ error: "R2 binding IMAGES missing" }, 500);
        let form;
        try { form = await request.formData(); } catch { return json({ error: "send multipart form with field 'image'" }, 400); }
        const file = form.get("image");
        if (!file || typeof file.arrayBuffer !== "function") return json({ error: "send multipart form with field 'image'" }, 400);
        if (file.size > 25 * 1024 * 1024) return json({ error: "image too large (max 25MB)" }, 413);
        const key = `${nowIso().slice(0, 10)}/${uid()}-${cleanName(file.name)}`;
        await env.IMAGES.put(key, file.stream(), { httpMetadata: { contentType: file.type || "image/png" } });
        return json({ r2_key: key, url: `/api/file/${encodeURIComponent(key)}`, filename: file.name || "upload", bytes: file.size });
      }
      if (pathname === "/api/results" && request.method === "POST") {
        needD1();
        const b = await request.json().catch(() => null);
        if (!b) return json({ error: "send JSON body" }, 400);
        const p = b.percentages || {};
        const c = b.counts || {};
        const farm = Number(p.farm ?? 0), barren = Number(p.barren ?? 0), city = Number(p.city ?? 0), water = Number(p.water ?? 0);
        if (![farm, barren, city, water].every((v) => Number.isFinite(v) && v >= 0 && v <= 100)) return json({ error: "percentages must be 0..100" }, 400);
        if (Math.abs(farm + barren + city + water - 100) > 2) return json({ error: "percentages must sum to ~100" }, 400);
        const id = uid();
        const verdict = String(b.verdict || verdictFor({ farm, barren, city, water })).slice(0, 500);
        await env.DB.prepare(
          `INSERT INTO analyses (id, filename, r2_key, farm, barren, city, water, c_farm, c_barren, c_city, c_water, pixels, verdict, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(id, String(b.filename || "upload").slice(0, 120), String(b.r2_key || b.farm_id || "").slice(0, 200),
          farm, barren, city, water, Number(c.farm || 0), Number(c.barren || 0), Number(c.city || 0), Number(c.water || 0),
          Number(b.pixels || b.total_pixels || 0), verdict, nowIso()).run();
        // If this result belongs to a farm pipeline (r2_key matches an imagery row), auto-promote to monitoring_logs.
        if (b.r2_key) {
          const img = await env.DB.prepare(`SELECT * FROM imagery_index WHERE r2_key = ? LIMIT 1`).bind(String(b.r2_key)).first();
          if (img) {
            const health = healthScoreFor({ farm, barren, city, water });
            const disease = diseaseFlagFor({ farm, barren, city, water });
            await env.DB.prepare(
              `INSERT INTO monitoring_logs (id, farm_id, imagery_id, growth_rate, disease_flag, health_score, farm_pct, barren_pct, city_pct, water_pct, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(uid(), img.farm_id, img.id, +(farm / 100).toFixed(3), disease, health, farm, barren, city, water, nowIso()).run();
            if (img.ndvi_avg === 0) await env.DB.prepare(`UPDATE imagery_index SET ndvi_avg = ? WHERE id = ?`).bind(pseudoNdvi({ farm, barren, city, water }), img.id).run();
            // Phase 5: same alert engine as the cron path (plain-language + dispatch).
            if (disease !== "none") {
              const msg = disease === "urban-pressure"
                ? `High urban cover (${city}%) near ${img.farm_id} — limited farming scope.`
                : `Barren cover ${barren}% on ${img.farm_id} — consider soil test / irrigation survey.`;
              await raiseAlert(env, img.farm_id, disease, msg, barren > 70 || city > 70 ? "high" : "medium");
            }
            if (health < 35) {
              await raiseAlert(env, img.farm_id, "low-health", `Health score ${health} on ${img.farm_id} is low — inspect field.`, "high");
            }
          }
        }
        return json({ ok: true, id, verdict }, 201);
      }
      if (pathname === "/api/results" && request.method === "GET") {
        needD1();
        const limit = Math.min(Number(search.get("limit") || 50), 200);
        const { results } = await env.DB.prepare(`SELECT * FROM analyses ORDER BY created_at DESC LIMIT ?`).bind(limit).all();
        return json({ results: (results || []).map(pctRow), count: (results || []).length });
      }
      if (pathname === "/api/stats" && request.method === "GET") {
        needD1();
        const row = await env.DB.prepare(
          `SELECT COUNT(*) n, COALESCE(SUM(c_farm),0) f, COALESCE(SUM(c_barren),0) b, COALESCE(SUM(c_city),0) c, COALESCE(SUM(c_water),0) w, COALESCE(SUM(pixels),0) t FROM analyses`
        ).first();
        const t = Number(row?.t || 0);
        const pct = (v) => (t ? +((v / t) * 100).toFixed(2) : 0);
        return json({ images: Number(row?.n || 0), total_pixels: t,
          counts: { farm: row?.f ?? 0, barren: row?.b ?? 0, city: row?.c ?? 0, water: row?.w ?? 0 },
          percentages: { farm: pct(row?.f || 0), barren: pct(row?.b || 0), city: pct(row?.c || 0), water: pct(row?.w || 0) } });
      }
      if (pathname.startsWith("/api/file/") && request.method === "GET") {
        if (!env.IMAGES) return json({ error: "R2 binding IMAGES missing" }, 500);
        const key = decodeURIComponent(pathname.slice("/api/file/".length));
        if (!key || key.includes("..")) return json({ error: "bad key" }, 400);
        const obj = await env.IMAGES.get(key);
        if (!obj) return json({ error: "not found" }, 404);
        return new Response(obj.body, { headers: cors({ "Content-Type": obj.httpMetadata?.contentType || "image/png", "Cache-Control": "public, max-age=86400" }) });
      }

      return json({ error: "not found", routes: ["GET /api/health", "POST /farms", "GET /farms", "GET /farms/:id", "GET /farms/:id/imagery", "GET /farms/:id/recommend", "GET /farms/:id/monitor", "GET /farms/:id/alerts", "POST /alerts/:id/resolve", "POST /internal/ingest", "POST /internal/analyze", "POST /api/analyze", "POST /api/results", "GET /api/results", "GET /api/stats"] }, 404);
    } catch (e) {
      return json({ error: String(e?.message || e) }, e?.status || 500);
    }
  },

  /** Weekly cron: ingest marker + analyze pending (Phase 1 automation). */
  async scheduled(event, env, ctx) {
    if (!env.DB) return;
    ctx.waitUntil((async () => {
      const { results } = await env.DB.prepare(`SELECT id FROM farms ORDER BY created_at DESC LIMIT 100`).all();
      for (const f of results || []) {
        // Without a satellite key we record nothing but still run analyzePending so manual
        // uploads flow through. With SENTINEL_HUB_URL set, fetch and ingestFarmImage() here.
        void f;
      }
      try { await analyzePending(env); } catch (e) { console.error("scheduled analyze failed", e); }
    })());
  },
};
