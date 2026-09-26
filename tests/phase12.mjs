// Phase 1+2 smoke test with mocked R2 + D1 (node, no wrangler needed)
import worker from "../src/index.js";

function makeMockDB() {
  const T = { farms: [], imagery_index: [], crop_master: [], monitoring_logs: [], alerts: [], analyses: [] };
  // seed 2 crops
  T.crop_master.push(
    { crop_name: "Maize (Corn)", season: "kharif", suitable_soil_types: "loam,sandy-loam,black", notes: "t" },
    { crop_name: "Wheat", season: "rabi", suitable_soil_types: "loam,clay", notes: "t" },
    { crop_name: "Sugarcane", season: "perennial", suitable_soil_types: "loam,clay,black", notes: "t" },
  );
  const db = {
    tables: T,
    prepare(sql) {
      const q = sql.replace(/\s+/g, " ").trim();
      const stmt = (p) => ({
          first: async () => bound(p).first(),
          all: async () => bound(p).all(),
          run: async () => bound(p).run(),
        });
      const bound = (p) => {
          const first = async () => {
            if (q.startsWith("SELECT * FROM farms WHERE id = ?")) return T.farms.find((r) => r.id === p[0]) || null;
            if (q.startsWith("SELECT * FROM imagery_index WHERE farm_id = ? ORDER BY captured_at DESC LIMIT 1"))
              return T.imagery_index.filter((r) => r.farm_id === p[0]).sort((a, b) => (a.captured_at < b.captured_at ? 1 : -1))[0] || null;
            if (q.startsWith("SELECT * FROM monitoring_logs WHERE farm_id = ? ORDER BY created_at DESC LIMIT 1"))
              return T.monitoring_logs.filter((r) => r.farm_id === p[0]).sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0] || null;
            if (q.startsWith("SELECT * FROM analyses WHERE r2_key = ? LIMIT 1")) return T.analyses.find((r) => r.r2_key === p[0]) || null;
            if (q.startsWith("SELECT COUNT(*) n,")) {
              const sum = (k) => T.analyses.reduce((a, r) => a + (r[k] || 0), 0);
              return { n: T.analyses.length, f: sum("c_farm"), b: sum("c_barren"), c: sum("c_city"), w: sum("c_water"), t: sum("pixels") };
            }
            if (q.startsWith("SELECT * FROM imagery_index WHERE r2_key = ? LIMIT 1")) return T.imagery_index.find((r) => r.r2_key === p[0]) || null;
            return null;
          };
          const all = async () => {
            if (q.startsWith("SELECT * FROM farms ORDER BY")) return { results: [...T.farms].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, p[0]) };
            if (q.startsWith("SELECT * FROM imagery_index WHERE farm_id = ? ORDER BY captured_at DESC"))
              return { results: T.imagery_index.filter((r) => r.farm_id === p[0]).sort((a, b) => (a.captured_at < b.captured_at ? 1 : -1)).slice(0, 20) };
            if (q.startsWith("SELECT * FROM crop_master")) return { results: T.crop_master.filter((r) => r.season === p[0] || r.season === "perennial") };
            if (q.startsWith("SELECT i.* FROM imagery_index i LEFT JOIN")) {
              const done = new Set(T.monitoring_logs.map((m) => m.imagery_id));
              return { results: T.imagery_index.filter((r) => !done.has(r.id)).sort((a, b) => (a.captured_at > b.captured_at ? 1 : -1)).slice(0, 25) };
            }
            if (q.startsWith("SELECT * FROM alerts WHERE farm_id = ?")) return { results: T.alerts.filter((r) => r.farm_id === p[0]).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 50) };
            if (q.startsWith("SELECT * FROM analyses ORDER BY")) return { results: [...T.analyses].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, p[0]) };
            return { results: [] };
          };
          const run = async () => {
            if (q.startsWith("INSERT INTO farms")) { const [id, owner_id, name, boundary_geojson, soil_type, created_at] = p; T.farms.push({ id, owner_id, name, boundary_geojson, soil_type, created_at }); return { success: true }; }
            if (q.startsWith("INSERT INTO imagery_index")) { const [id, farm_id, r2_key, captured_at, ndvi_avg, source] = p; T.imagery_index.push({ id, farm_id, r2_key, captured_at, ndvi_avg, source }); return { success: true }; }
            if (q.startsWith("UPDATE imagery_index SET ndvi_avg")) { const row = T.imagery_index.find((r) => r.id === p[1]); if (row) row.ndvi_avg = p[0]; return { success: true }; }
            if (q.startsWith("INSERT INTO monitoring_logs")) { const [id, farm_id, imagery_id, growth_rate, disease_flag, health_score, farm_pct, barren_pct, city_pct, water_pct, created_at] = p; T.monitoring_logs.push({ id, farm_id, imagery_id, growth_rate, disease_flag, health_score, farm_pct, barren_pct, city_pct, water_pct, created_at }); return { success: true }; }
            if (q.startsWith("INSERT INTO alerts")) { const [id, farm_id, type, message, severity, created_at, resolved] = p; T.alerts.push({ id, farm_id, type, message, severity, created_at, resolved }); return { success: true }; }
            if (q.startsWith("INSERT INTO analyses")) { const [id, filename, r2_key, farm, barren, city, water, c_farm, c_barren, c_city, c_water, pixels, verdict, created_at] = p; T.analyses.push({ id, filename, r2_key, farm, barren, city, water, c_farm, c_barren, c_city, c_water, pixels, verdict, created_at }); return { success: true }; }
            throw new Error("mock run: unhandled SQL: " + q.slice(0, 80));
          };
          return { first, all, run };
        };
      return { bind: (...p) => bound(p), first: () => bound([]).first(), all: () => bound([]).all(), run: () => bound([]).run() };
    },
  };
  return db;
}
const store = new Map();
const env = {
  DB: makeMockDB(),
  IMAGES: {
    async put(k, body, opts) { store.set(k, { body, opts }); },
    async get(k) { return store.has(k) ? { body: "bytes", httpMetadata: store.get(k).opts?.httpMetadata || {} } : null; },
  },
};
const J = async (r) => ({ status: r.status, body: JSON.parse(await r.text()) });
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log((cond ? "PASS " : "FAIL ") + name, extra); };

// 1. register farm
let r = await worker.fetch(new Request("http://x/farms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Demo Plot", soil_type: "loam", boundary: { type: "Point", coordinates: [77.2, 28.6] } }) }), env);
let j = await J(r);
ok("POST /farms 201", r.status === 201, JSON.stringify({ farm_id: j.body.farm_id }));
const farmId = j.body.farm_id;

// 2. ingest via multipart
const fd = new FormData();
fd.append("farm_id", farmId);
fd.append("image", new Blob(["fakepng"], { type: "image/png" }), "field.png");
r = await worker.fetch(new Request("http://x/internal/ingest", { method: "POST", body: fd }), env);
j = await J(r);
ok("POST /internal/ingest 201", r.status === 201, JSON.stringify({ r2_key: j.body.r2_key }));
const r2key = j.body.r2_key;

// 3. imagery pending
r = await worker.fetch(new Request(`http://x/farms/${farmId}/imagery`), env);
j = await J(r);
ok("GET imagery has 1 row", (j.body.imagery || []).length === 1);

// 4. submit browser % linked to r2_key -> auto-promotes to monitoring
r = await worker.fetch(new Request("http://x/api/results", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: "field.png", r2_key: r2key, percentages: { farm: 55, barren: 20, city: 10, water: 15 }, counts: { farm: 550, barren: 200, city: 100, water: 150 }, pixels: 1000 }) }), env);
j = await J(r);
ok("POST /api/results 201", r.status === 201);

// 5. monitor ok
r = await worker.fetch(new Request(`http://x/farms/${farmId}/monitor`), env);
j = await J(r);
ok("GET monitor ok", j.body.status === "ok" && j.body.monitor.farm_pct === 55, JSON.stringify(j.body.monitor && { health: j.body.monitor.health_score }));

// 6. recommend returns crops
r = await worker.fetch(new Request(`http://x/farms/${farmId}/recommend`), env);
j = await J(r);
ok("GET recommend", Array.isArray(j.body.recommendations) && j.body.recommendations.length > 0, JSON.stringify({ season: j.body.season, top: j.body.recommendations?.[0]?.crop }));

// 7. internal/analyze on second farm-less imagery still works (pending=0 now since promoted? imagery already has monitoring -> 0)
r = await worker.fetch(new Request("http://x/internal/analyze", { method: "POST" }), env);
j = await J(r);
ok("POST /internal/analyze", r.status === 200 && Array.isArray(j.body.analyzed), `pending=${j.body.analyzed.length}`);

// 8. alerts list (may be empty — health 55*0.85+... > 35, no disease)
r = await worker.fetch(new Request(`http://x/farms/${farmId}/alerts`), env);
j = await J(r);
ok("GET alerts", r.status === 200 && Array.isArray(j.body.alerts));

// 9. validation: bad percentages rejected
r = await worker.fetch(new Request("http://x/api/results", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: "x", percentages: { farm: 90, barren: 90, city: 0, water: 0 } }) }), env);
ok("bad % rejected 400", r.status === 400);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
