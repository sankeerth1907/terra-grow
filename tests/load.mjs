// Phase 6 load check: 30 rapid standalone analyses through the real worker (mocked D1/R2)
import worker from "../src/index.js";

const rows = [];
const env = {
  DB: {
    prepare(sql) {
      const q = sql.replace(/\s+/g, " ").trim();
      const bound = (p) => ({
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => {
          if (q.startsWith("INSERT INTO analyses")) { rows.push(p); return { success: true }; }
          throw new Error("unexpected SQL: " + q.slice(0, 50));
        },
      });
      return { bind: (...p) => bound(p), first: () => bound([]).first(), all: () => bound([]).all(), run: () => bound([]).run() };
    },
  },
  IMAGES: null,
};
const t0 = Date.now();
let okCount = 0;
for (let i = 0; i < 30; i++) {
  const r = await worker.fetch(new Request("http://x/api/results", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: `tile_${i}.png`, percentages: { farm: 50, barren: 20, city: 15, water: 15 }, counts: { farm: 500, barren: 200, city: 150, water: 150 }, pixels: 1000 }),
  }), env);
  if (r.status === 201) okCount++;
}
const dt = Date.now() - t0;
console.log(`LOAD: ${okCount}/30 stored in ${dt}ms (avg ${(dt / 30).toFixed(1)}ms/req, rows=${rows.length})`);
process.exit(okCount === 30 && rows.length === 30 ? 0 : 1);
