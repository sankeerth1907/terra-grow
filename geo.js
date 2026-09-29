/* TerraGrow geo math — pure functions, no DOM.
 * Browser: loaded as classic script before analyzer.js -> window.Geo.
 * Node tests: loaded via `new Function('window', src + ';return Geo;')`.
 *
 * Area model: area_total_ha = origW * origH * gsdM^2 / 10000.
 * Percentages come from the (possibly downsampled) analysis grid; they scale
 * to real area because class share is resolution-independent.
 *
 * Underutilised model (transparent, documented in README):
 *   underPct  = barren%                       -> potentially reclaimable for crops
 *   waterStatus: deficit (<5%) | ideal (5-30%) | excess (>30%)
 *   cultivationScore 0..100 = farm + min(water,15)*0.6 - max(0,5-water)*2
 *                             - max(0,water-30)*0.6 - city*0.1, clamped.
 */
var Geo = (function () {
  var M2_PER_HA = 10000;
  var HA_PER_ACRE = 0.404686;
  var r1 = function (v) { return Math.round(v * 10) / 10; };
  var r2 = function (v) { return Math.round(v * 100) / 100; };

  function hectares(origW, origH, gsdM) {
    var w = Number(origW), h = Number(origH), g = Number(gsdM);
    if (!(w > 0 && h > 0 && g > 0)) return 0;
    return r2((w * h * g * g) / M2_PER_HA);
  }
  function haToAcres(ha) { return r2(ha / HA_PER_ACRE); }

  function waterStatus(waterPct) {
    var w = Number(waterPct);
    if (w < 5) return "deficit";
    if (w <= 30) return "ideal";
    return "excess";
  }

  function cultivationScore(p) {
    var farm = +p.farm || 0, water = +p.water || 0, city = +p.city || 0;
    var s = farm + Math.min(water, 15) * 0.6 - Math.max(0, 5 - water) * 2
      - Math.max(0, water - 30) * 0.6 - city * 0.1;
    return r1(Math.max(0, Math.min(100, s)));
  }

  /** Pseudo-NDVI from land-cover % (-1..1). Replaced by real NIR NDVI when available. */
  function pseudoNdvi(p) {
    if (!p) return 0;
    var v = ((+p.farm || 0) + (+p.water || 0) * 0.3 - (+p.barren || 0) * 0.5 - (+p.city || 0) * 0.6) / 100;
    return r2(Math.max(-1, Math.min(1, v)) * 10) / 10;
  }

  /**
   * Full per-image detail object.
   * p: {farm,barren,city,water} percentages. o: {origW,origH,analyzedPx,counts,gsdM,engine}
   */
  function detailsFor(p, o) {
    o = o || {};
    var totalHa = hectares(o.origW, o.origH, o.gsdM);
    var perClass = {};
    ["farm", "barren", "city", "water"].forEach(function (k) {
      var pct = +p[k] || 0;
      perClass[k] = { pct: pct, ha: r2((totalHa * pct) / 100), acres: haToAcres((totalHa * pct) / 100) };
      if (o.counts && o.counts[k] != null) perClass[k].px = o.counts[k];
    });
    var underPct = r2(+p.barren || 0);
    var underHa = r2((totalHa * underPct) / 100);
    var ws = waterStatus(p.water);
    var advice = "Underutilised (reclaimable barren): " + underPct + "% (~" + underHa + " ha). ";
    if (ws === "deficit") advice += "Water deficit (<5%) — yield limited by irrigation; check borewell/canal access. ";
    else if (ws === "excess") advice += "Water excess (>30%) — check drainage/waterlogging before sowing. ";
    else advice += "Water share ideal (5-30%) for most crops. ";
    return {
      totalHa: totalHa, totalAcres: haToAcres(totalHa),
      perClass: perClass,
      underPct: underPct, underHa: underHa, underAcres: haToAcres(underHa),
      score: cultivationScore(p), waterStatus: ws, ndvi: pseudoNdvi(p),
      advice: advice,
    };
  }

  return {
    hectares: hectares, haToAcres: haToAcres,
    waterStatus: waterStatus, cultivationScore: cultivationScore,
    pseudoNdvi: pseudoNdvi, detailsFor: detailsFor,
  };
})();
if (typeof window !== "undefined") window.Geo = Geo;
