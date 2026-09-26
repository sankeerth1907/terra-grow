// Phase 3 test: external-model tier + fallbacks + shared scoring (mocked D1/R2, stub HTTP model)
import worker from "../src/index.js";
import http from "node:http";

const mode = { name: "happy", hits: 0 };
const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/segment") {
    mode.hits++;
    req.resume();
    req.on("end", () => {
      if (mode.name === "happy") send(res, 200, { percentages: { farm: 70, barren: 10, city: 5, water: 15 }, confidence: 0.9, ndvi_avg: 0.4 });
      else if (mode.name === "flat") send(res, 200, { farm: 20, barren: 50, city: 20, water: 10 });
      else if (mode.name === "bad") send(res, 200, { percentages: { farm: 30, barren: 10, city: 5, water: 5 } }); // sums to 50
      else if (mode.name === "http500") send(res, 500, { error: "gpu busy" });
    });
  } else { send(res, 404, {}); }
});
const send = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const MODEL_URL = `http://127.0.0.1:${server.address().port}/segment`;

function makeMockDB() {
  const T = { farms: [], imagery_index: [], crop_master: [], monitoring_logs: [], alerts: [], analyses: [] };
  T.crop_master.push({ crop_name: "Maize (Corn)", season: "kharif", suitable_soil_types: "loam", notes: "t" });
  const db = {
    tables: T,
    prepare(sql) {
      const q = sql.replace(/\s+/g, " ").trim();
      const bound = (p) => ({
        first: async () => {
          if (q.startsWith("SELECT * FROM farms WHERE id = ?")) return T.farms.find((r) => r.id === p[0]) || null;
          if (q.startsWith("SELECT * FROM monitoring_logs WHERE farm_id = ? ORDER BY created_at DESC LIMIT 1"))
            return T.monitoring_logs.filter((r) => r.farm_id === p[0]).sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0] || null;
          if (q.startsWith("SELECT * FROM analyses WHERE r2_key = ? LIMIT 1")) return T.analyses.find((r) => r.r2_key === p[0]) || null;
          if (q.startsWith("SELECT * FROM imagery_index WHERE r2_key = ? LIMIT 1")) return T.imagery_index.find((r) => r.r2_key === p[0]) || null;
          return null;
        },
        all: async () => {
          if (q.startsWith("SELECT i.* FROM imagery_index i LEFT JOIN")) {
            const done = new Set(T.monitoring_logs.map((m) => m.imagery_id));
            return { results: T.imagery_index.filter((r) => !done.has(r.id)).slice(0, 25) };
          }
          if (q.startsWith("SELECT * FROM crop_master")) return { results: T.crop_master.filter((r) => r.season === p[0] || r.season === "perennial") };
          return { results: [] };
        },
        run: async () => {
          if (q.startsWith("INSERT INTO farms")) { const [id, owner_id, name, boundary_geojson, soil_type, created_at] = p; T.farms.push({ id, owner_id, name, boundary_geojson, soil_type, created_at }); return { success: true }; }
          if (q.startsWith("INSERT INTO imagery_index")) { const [id, farm_id, r2_key, captured_at, ndvi_avg, source] = p; T.imagery_index.push({ id, farm_id, r2_key, captured_at, ndvi_avg, source }); return { success: true }; }
          if (q.startsWith("UPDATE imagery_index SET ndvi_avg")) { const row = T.imagery_index.find((r) => r.id === p[1]); if (row) row.ndvi_avg = p[0]; return { success: true }; }
          if (q.startsWith("INSERT INTO monitoring_logs")) { const [id, farm_id, imagery_id, growth_rate, disease_flag, health_score, farm_pct, barren_pct, city_pct, water_pct, created_at] = p; T.monitoring_logs.push({ id, farm_id, imagery_id, growth_rate, disease_flag, health_score, farm_pct, barren_pct, city_pct, water_pct, created_at }); return { success: true }; }
          if (q.startsWith("INSERT INTO alerts")) { const [id, farm_id, type, message, severity, created_at, resolved] = p; T.alerts.push({ id, farm_id, type, message, severity, created_at, resolved }); return { success: true }; }
          if (q.startsWith("INSERT INTO analyses")) { const [id, filename, r2_key, farm, barren, city, water, c_farm, c_barren, c_city, c_water, pixels, verdict, created_at] = p; T.analyses.push({ id, filename, r2_key, farm, barren, city, water, c_farm, c_barren, c_city, c_water, pixels, verdict, created_at }); return { success: true }; }
          throw new Error("mock unhandled: " + q.slice(0, 60));
        },
      });
      return { bind: (...p) => bound(p), first: () => bound([]).first(), all: () => bound([]).all(), run: () => bound([]).run() };
    },
  };
  return db;
}
const r2bytes = new Map();
const baseEnv = (extra = {}) => ({
  DB: makeMockDB(),
  IMAGES: {
    async put(k, body) { r2bytes.set(k, body instanceof ArrayBuffer ? body : new Uint8Array([1]).buffer); },
    async get(k) {
      if (!r2bytes.has(k)) return null;
      const buf = r2bytes.get(k);
      return { arrayBuffer: async () => buf, httpMetadata: { contentType: "image/png" } };
    },
  },
  EXTERNAL_MODEL_URL: MODEL_URL,
  ...extra,
});
const J = async (r) => ({ status: r.status, body: JSON.parse(await r.text()) });
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n, x); };

async function makeFarm(env) {
  let r = await worker.fetch(new Request("http://x/farms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "P3", soil_type: "loam", boundary: { type: "Point", coordinates: [77, 28] } }) }), env);
  const farmId = (await J(r)).body.farm_id;
  const fd = new FormData();
  fd.append("farm_id", farmId);
  fd.append("image", new Blob(["imgbytes"], { type: "image/png" }), "f.png");
  r = await worker.fetch(new Request("http://x/internal/ingest", { method: "POST", body: fd }), env);
  const r2key = (await J(r)).body.r2_key;
  return { farmId, r2key };
}

// 1. happy path: model % used, engine + confidence + ndvi recorded
{
  const env = baseEnv();
  const { farmId } = await makeFarm(env);
  mode.name = "happy"; mode.hits = 0;
  const r = await worker.fetch(new Request("http://x/internal/analyze", { method: "POST" }), env);
  const j = await J(r);
  const a = j.body.analyzed[0];
  ok("model happy: farm 70 used", a?.percentages?.farm === 70, JSON.stringify({ engine: a?.engine, conf: a?.confidence }));
  ok("model happy: engine+confidence+ndvi", a?.engine === "external-model" && a?.confidence === 0.9 && env.DB.tables.imagery_index[0].ndvi_avg === 0.4, `hits=${mode.hits}`);
  const m = await worker.fetch(new Request(`http://x/farms/${farmId}/monitor`), env);
  const mj = await J(m);
  ok("monitor health from model %", mj.body.monitor.health_score === 61.8, `health=${mj.body.monitor?.health_score}`);
}
// 2. flat format accepted
{
  const env = baseEnv();
  await makeFarm(env);
  mode.name = "flat";
  const r = await worker.fetch(new Request("http://x/internal/analyze", { method: "POST" }), env);
  const a = (await J(r)).body.analyzed[0];
  ok("flat model output accepted", a?.engine === "external-model" && a?.percentages?.barren === 50);
}
// 3. bad-sum output falls back, pipeline survives
{
  const env = baseEnv();
  await makeFarm(env);
  mode.name = "bad";
  const r = await worker.fetch(new Request("http://x/internal/analyze", { method: "POST" }), env);
  const a = (await J(r)).body.analyzed[0];
  ok("bad model output -> prior fallback", r.status === 200 && a?.engine === "default-prior" && a?.percentages?.farm === 35);
}
// 4. model 500 falls back
{
  const env = baseEnv();
  await makeFarm(env);
  mode.name = "http500";
  const r = await worker.fetch(new Request("http://x/internal/analyze", { method: "POST" }), env);
  ok("model 500 -> prior fallback", (await J(r)).body.analyzed[0]?.engine === "default-prior");
}
// 5. unreachable model falls back (refused port)
{
  const env = baseEnv({ EXTERNAL_MODEL_URL: "http://127.0.0.1:1/none" });
  await makeFarm(env);
  const r = await worker.fetch(new Request("http://x/internal/analyze", { method: "POST" }), env);
  ok("unreachable model -> prior fallback", (await J(r)).body.analyzed[0]?.engine === "default-prior");
}
// 6. linked browser result wins over model (model never consulted)
{
  const env = baseEnv();
  const { farmId, r2key } = await makeFarm(env);
  env.DB.tables.analyses.push({ id: "a1", filename: "f.png", r2_key: r2key, farm: 55, barren: 20, city: 10, water: 15, c_farm: 0, c_barren: 0, c_city: 0, c_water: 0, pixels: 100, verdict: "t", created_at: new Date().toISOString() });
  mode.name = "happy"; mode.hits = 0;
  const r = await worker.fetch(new Request("http://x/internal/analyze", { method: "POST" }), env);
  const a = (await J(r)).body.analyzed[0];
  ok("linked result wins over model", a?.engine === "linked-result" && a?.percentages?.farm === 55 && mode.hits === 0, `hits=${mode.hits}`);
  void farmId;
}
// 7. no model configured -> prior, no fetch attempted
{
  const env = baseEnv({ EXTERNAL_MODEL_URL: "" });
  await makeFarm(env);
  mode.hits = 0;
  const r = await worker.fetch(new Request("http://x/internal/analyze", { method: "POST" }), env);
  ok("unconfigured -> prior, model untouched", (await J(r)).body.analyzed[0]?.engine === "default-prior" && mode.hits === 0);
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
