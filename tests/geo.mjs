// Geo lib tests (loads classic geo.js via Function, no DOM needed)
import fs from "node:fs";

const src = fs.readFileSync(new URL("../geo.js", import.meta.url), "utf8");
const Geo = new Function("window", `${src}; return (typeof Geo !== "undefined" ? Geo : null);`)({});

let pass = 0, fail = 0;
const ok = (n, c, x = "") => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n, x); };
const near = (a, b, e = 0.01) => Math.abs(a - b) <= e;

ok("hectares 100x100px @10m = 100ha", Geo.hectares(100, 100, 10) === 100);
ok("hectares 512x512 @10m = 2621.44ha", near(Geo.hectares(512, 512, 10), 2621.44));
ok("hectares bad input -> 0", Geo.hectares(0, 100, 10) === 0 && Geo.hectares(100, 100, 0) === 0 && Geo.hectares(100, 100, -5) === 0);
ok("acres convert 10ha = 24.71ac", near(Geo.haToAcres(10), 24.71));

ok("water deficit", Geo.waterStatus(4.9) === "deficit");
ok("water ideal bounds", Geo.waterStatus(5) === "ideal" && Geo.waterStatus(30) === "ideal");
ok("water excess", Geo.waterStatus(30.1) === "excess");

ok("score known 55/20/10/15 = 63", Geo.cultivationScore({ farm: 55, barren: 20, city: 10, water: 15 }) === 63);
ok("score clamped 0..100", Geo.cultivationScore({ farm: 0, barren: 90, city: 10, water: 0 }) >= 0 && Geo.cultivationScore({ farm: 100, barren: 0, city: 0, water: 15 }) <= 100);
ok("score deficit penalty", Geo.cultivationScore({ farm: 50, barren: 40, city: 5, water: 2 }) < Geo.cultivationScore({ farm: 50, barren: 40, city: 5, water: 10 }));

const d = Geo.detailsFor({ farm: 50, barren: 30, city: 10, water: 10 }, { origW: 100, origH: 100, gsdM: 10, counts: { farm: 5, barren: 3, city: 1, water: 1 } });
ok("details total 100ha", d.totalHa === 100);
ok("details class ha sum", near(d.perClass.farm.ha + d.perClass.barren.ha + d.perClass.city.ha + d.perClass.water.ha, 100));
ok("details under = barren 30% / 30ha", d.underPct === 30 && d.underHa === 30);
ok("details advice mentions water ideal", /ideal/.test(d.advice) && /reclaimable/.test(d.advice));
ok("details px passthrough", d.perClass.farm.px === 5);
const d0 = Geo.detailsFor({ farm: 50, barren: 30, city: 10, water: 10 }, { origW: 100, origH: 100, gsdM: 0 });
ok("details zero gsd -> ha 0, pct intact", d0.totalHa === 0 && d0.underPct === 30 && d0.score > 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
