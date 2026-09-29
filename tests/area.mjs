// Area + details API tests (mocked D1; worker math cross-checked against geo.js)
import worker from "../src/index.js";
import fs from "node:fs";

const geoSrc = fs.readFileSync(new URL("../geo.js", import.meta.url), "utf8");
const Geo = new Function("window", `${geoSrc}; return (typeof Geo !== "undefined" ? Geo : null);`)({});

function makeMockDB() {
  const T = { farms: [], imagery_index: [], crop_master: [], monitoring_logs: [], alerts: [], analyses: [] };
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
          if (q.startsWith("SELECT * FROM analyses ORDER BY")) return { results: [...T.analyses].slice(0, p[0]) };
          return { results: [] };
        },
        run: async () => {
          if (q.startsWith("INSERT INTO farms")) { const [id, owner_id, name, boundary_geojson, soil_type, created_at] = p; T.farms.push({ id, owner_id, name, boundary_geojson, soil_type, created_at }); return { success: true }; }
          if (q.startsWith("INSERT INTO imagery_index")) { const [id, farm_id, r2_key, captured_at, ndvi_avg, source] = p; T.imagery_index.push({ id, farm_id, r2_key, captured_at, ndvi_avg, source }); return { success: true }; }
          if (q.startsWith("UPDATE imagery_index SET ndvi_avg")) { const row = T.imagery_index.find((r) => r.id === p[1]); if (row) row.ndvi_avg = p[0]; return { success: true }; }
          if (q.startsWith("INSERT INTO monitoring_logs")) { const [id, farm_id, imagery_id, growth_rate, disease_flag, health_score, farm_pct, barren_pct, city_pct, water_pct, created_at] = p; T.monitoring_logs.push({ id, farm_id, imagery_id, growth_rate, disease_flag, health_score, farm_pct, barren_pct, city_pct, water_pct, created_at }); return { success: true }; }
          if (q.startsWith("INSERT INTO analyses")) {
            const [id, filename, r2_key, farm, barren, city, water, c_farm, c_barren, c_city, c_water, pixels, verdict, created_at, gsd_mpx, area_total_ha, area_under_ha] = p;
            T.analyses.push({ id, filename, r2_key, farm, barren, city, water, c_farm, c_barren, c_city, c_water, pixels, verdict, created_at, gsd_mpx, area_total_ha, area_under_ha });
            return { success: true };
          }
          throw new Error("mock unhandled: " + q.slice(0, 60));
        },
      });
      return { bind: (...p) => bound(p), first: () => bound([]).first(), all: () => bound([]).all(), run: () => bound([]).run() };
    },
  };
  return db;
}
const env = { DB: makeMockDB(), IMAGES: null, EXTERNAL_MODEL_URL: "" };
const J = async (r) => ({ status: r.status, body: JSON.parse(await r.text()) });
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n, x); };
const PCT = { farm: 50, barren: 30, city: 10, water: 10 };

// 1. area stored + returned, matches geo.js
let r = await worker.fetch(new Request("http://x/api/results", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ filename: "f.png", percentages: PCT, counts: {}, pixels: 100, width: 100, height: 100, gsd_mpx: 10 }) }), env);
let j = await J(r);
const exp = Geo.detailsFor(PCT, { origW: 100, origH: 100, gsdM: 10 });
ok("area stored+returned", r.status === 201 && j.body.area.total_ha === exp.totalHa && j.body.area.under_ha === exp.underHa,
  JSON.stringify(j.body.area));
ok("details match geo", j.body.details.under_pct === exp.underPct && j.body.details.cultivation_score === exp.score && j.body.details.water_status === exp.waterStatus);
ok("verdict mentions reclaimable", /reclaimable/.test(env.DB.tables.analyses[0].verdict));

// 2. history row carries area + details
r = await worker.fetch(new Request("http://x/api/results?limit=5"), env);
j = await J(r);
const row = j.body.results[0];
ok("history area+details", row.area.total_ha === 100 && row.area.under_ha === 30 && row.details.cultivation_score === exp.score);

// 3. no gsd -> zeros, still 201
r = await worker.fetch(new Request("http://x/api/results", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ filename: "g.png", percentages: PCT, counts: {}, pixels: 100, width: 100, height: 100 }) }), env);
j = await J(r);
ok("missing gsd -> zero area", r.status === 201 && j.body.area.total_ha === 0 && j.body.details.water_status === "ideal");

// 4. monitor carries details (farm pipeline)
r = await worker.fetch(new Request("http://x/farms", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "A", soil_type: "loam" }) }), env);
const fid = (await J(r)).body.farm_id;
await env.DB.prepare("x").bind(); // no-op keep shape
env.DB.tables.imagery_index.push({ id: "im1", farm_id: fid, r2_key: "k1", captured_at: "t", ndvi_avg: 0, source: "u" });
await worker.fetch(new Request("http://x/api/results", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ filename: "k1.png", r2_key: "k1", percentages: { farm: 10, barren: 75, city: 5, water: 10 }, counts: {}, pixels: 50, width: 200, height: 200, gsd_mpx: 5 }) }), env);
r = await worker.fetch(new Request(`http://x/farms/${fid}/monitor`), env);
j = await J(r);
ok("monitor details", j.body.details.under_pct === 75 && j.body.details.water_status === "ideal" && j.body.monitor.disease_flag === "nutrient-stress-watch");
const stored = env.DB.tables.analyses.find((a) => a.r2_key === "k1");
ok("stored area 200x200@5m=100ha/75under", stored.area_total_ha === 100 && stored.area_under_ha === 75);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
