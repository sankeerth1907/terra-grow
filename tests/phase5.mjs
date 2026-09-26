// Phase 5 test: alert engine + webhook dispatch + resolve (mocked D1/R2, stub webhook server)
import worker from "../src/index.js";
import http from "node:http";

const received = [];
const webhook = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/hook") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body: JSON.parse(body) });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    });
  } else { res.writeHead(404); res.end(); }
});
await new Promise((r) => webhook.listen(0, "127.0.0.1", r));
const HOOK_URL = `http://127.0.0.1:${webhook.address().port}/hook`;

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
          if (q.startsWith("SELECT * FROM alerts WHERE id = ?")) return T.alerts.find((r) => r.id === p[0]) || null;
          return null;
        },
        all: async () => {
          if (q.startsWith("SELECT i.* FROM imagery_index i LEFT JOIN")) {
            const done = new Set(T.monitoring_logs.map((m) => m.imagery_id));
            return { results: T.imagery_index.filter((r) => !done.has(r.id)).slice(0, 25) };
          }
          if (q.startsWith("SELECT * FROM alerts WHERE farm_id = ? AND resolved = 0"))
            return { results: T.alerts.filter((r) => r.farm_id === p[0] && !r.resolved).slice(0, 50) };
          if (q.startsWith("SELECT * FROM alerts WHERE farm_id = ?"))
            return { results: T.alerts.filter((r) => r.farm_id === p[0]).slice(0, 50) };
          return { results: [] };
        },
        run: async () => {
          if (q.startsWith("INSERT INTO farms")) { const [id, owner_id, name, boundary_geojson, soil_type, created_at] = p; T.farms.push({ id, owner_id, name, boundary_geojson, soil_type, created_at }); return { success: true }; }
          if (q.startsWith("INSERT INTO imagery_index")) { const [id, farm_id, r2_key, captured_at, ndvi_avg, source] = p; T.imagery_index.push({ id, farm_id, r2_key, captured_at, ndvi_avg, source }); return { success: true }; }
          if (q.startsWith("UPDATE imagery_index SET ndvi_avg")) { const row = T.imagery_index.find((r) => r.id === p[1]); if (row) row.ndvi_avg = p[0]; return { success: true }; }
          if (q.startsWith("INSERT INTO monitoring_logs")) { const [id, farm_id, imagery_id, growth_rate, disease_flag, health_score, farm_pct, barren_pct, city_pct, water_pct, created_at] = p; T.monitoring_logs.push({ id, farm_id, imagery_id, growth_rate, disease_flag, health_score, farm_pct, barren_pct, city_pct, water_pct, created_at }); return { success: true }; }
          if (q.startsWith("INSERT INTO alerts")) { const [id, farm_id, type, message, severity, created_at, resolved] = p; T.alerts.push({ id, farm_id, type, message, severity, created_at, resolved }); return { success: true }; }
          if (q.startsWith("UPDATE alerts SET resolved = 1")) { const row = T.alerts.find((r) => r.id === p[0]); if (row) row.resolved = 1; return { success: true }; }
          if (q.startsWith("INSERT INTO analyses")) { const [id, filename, r2_key, farm, barren, city, water, c_farm, c_barren, c_city, c_water, pixels, verdict, created_at] = p; T.analyses.push({ id, filename, r2_key, farm, barren, city, water, c_farm, c_barren, c_city, c_water, pixels, verdict, created_at }); return { success: true }; }
          throw new Error("mock unhandled: " + q.slice(0, 60));
        },
      });
      return { bind: (...p) => bound(p), first: () => bound([]).first(), all: () => bound([]).all(), run: () => bound([]).run() };
    },
  };
  return db;
}
const mkEnv = (extra = {}) => ({
  DB: makeMockDB(),
  IMAGES: {
    async put() {},
    async get() { return null; },
  },
  EXTERNAL_MODEL_URL: "",
  NOTIFY_WEBHOOK_URL: HOOK_URL,
  ...extra,
});
const J = async (r) => ({ status: r.status, body: JSON.parse(await r.text()) });
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n, x); };

async function makeFarmImagery(env) {
  let r = await worker.fetch(new Request("http://x/farms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "P5", soil_type: "loam", boundary: { type: "Point", coordinates: [77, 28] } }) }), env);
  const farmId = (await J(r)).body.farm_id;
  const fd = new FormData();
  fd.append("farm_id", farmId);
  fd.append("image", new Blob(["img"], { type: "image/png" }), "f.png");
  r = await worker.fetch(new Request("http://x/internal/ingest", { method: "POST", body: fd }), env);
  return { farmId, r2key: (await J(r)).body.r2_key };
}

// 1. barren-heavy result -> disease alert + webhook dispatched
{
  const env = mkEnv();
  const { farmId, r2key } = await makeFarmImagery(env);
  received.length = 0;
  const r = await worker.fetch(new Request("http://x/api/results", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: "f.png", r2_key: r2key, percentages: { farm: 10, barren: 75, city: 5, water: 10 }, counts: {}, pixels: 100 }) }), env);
  ok("barren-heavy accepted", r.status === 201);
  const a = await worker.fetch(new Request(`http://x/farms/${farmId}/alerts`), env).then(J);
  const types = (a.body.alerts || []).map((x) => x.type).sort();
  ok("disease + low-health alerts raised", JSON.stringify(types) === JSON.stringify(["low-health", "nutrient-stress-watch"]), types.join(","));
  ok("high severity set", a.body.alerts.every((x) => x.severity === "high"));
  ok("webhook got both alerts", received.length === 2 && received.every((w) => w.body.farm_id === farmId && w.body.source === "terragrow"), `hooks=${received.length}`);
  var farmA = farmId;
  var alertId = a.body.alerts[0].id;
}
// 2. resolve flow + unresolved filter
{
  const env = mkEnv();
  // reuse farmA? fresh env per block — rebuild quickly via direct rows
  void env;
  const env2 = mkEnv();
  const { farmId, r2key } = await makeFarmImagery(env2);
  received.length = 0;
  await worker.fetch(new Request("http://x/api/results", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: "f.png", r2_key: r2key, percentages: { farm: 10, barren: 75, city: 5, water: 10 }, counts: {}, pixels: 100 }) }), env2);
  const all = await worker.fetch(new Request(`http://x/farms/${farmId}/alerts`), env2).then(J);
  const first = all.body.alerts[0].id;
  const rr = await worker.fetch(new Request(`http://x/alerts/${first}/resolve`, { method: "POST" }), env2).then(J);
  ok("resolve 200 + flag", rr.status === 200 && rr.body.resolved === 1);
  const un = await worker.fetch(new Request(`http://x/farms/${farmId}/alerts?unresolved=1`), env2).then(J);
  ok("unresolved filter excludes resolved", un.body.alerts.length === all.body.alerts.length - 1 && un.body.alerts.every((x) => !x.resolved));
  const rr404 = await worker.fetch(new Request("http://x/alerts/nope/resolve", { method: "POST" }), env2).then(J);
  ok("resolve unknown -> 404", rr404.status === 404);
  void farmA; void alertId;
}
// 3. cron path (prior -> low-health) also dispatches
{
  const env = mkEnv();
  await makeFarmImagery(env);
  received.length = 0;
  const r = await worker.fetch(new Request("http://x/internal/analyze", { method: "POST" }), env).then(J);
  const types = (r.body.analyzed[0]?.alerts || []).map((x) => x.type);
  ok("cron prior raises low-health + dispatches", types.includes("low-health") && received.length >= 1, `alerts=${types} hooks=${received.length}`);
}
// 4. no webhook configured -> alerts still work
{
  const env = mkEnv({ NOTIFY_WEBHOOK_URL: "" });
  const { farmId, r2key } = await makeFarmImagery(env);
  const r = await worker.fetch(new Request("http://x/api/results", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: "f.png", r2_key: r2key, percentages: { farm: 10, barren: 75, city: 5, water: 10 }, counts: {}, pixels: 100 }) }), env);
  const a = await worker.fetch(new Request(`http://x/farms/${farmId}/alerts`), env).then(J);
  ok("alerts without webhook", r.status === 201 && a.body.alerts.length === 2);
}
// 5. webhook down -> pipeline survives
{
  const env = mkEnv({ NOTIFY_WEBHOOK_URL: "http://127.0.0.1:1/dead" });
  const { farmId, r2key } = await makeFarmImagery(env);
  const r = await worker.fetch(new Request("http://x/api/results", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: "f.png", r2_key: r2key, percentages: { farm: 60, barren: 20, city: 10, water: 10 }, counts: {}, pixels: 100 }) }), env);
  const m = await worker.fetch(new Request(`http://x/farms/${farmId}/monitor`), env).then(J);
  ok("dead webhook never fails analysis", r.status === 201 && m.body.status === "ok");
}

webhook.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
