/* Headless unit tests for web-stable/geo-cover.js (pure covered-area geometry).
 * Run: node test_geocover.mjs   (Node 18+, no DOM). */
import fs from "fs";
import vm from "vm";
import { fileURLToPath } from "url";
import path from "path";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(HERE, "web-stable", "geo-cover.js"), "utf8"), ctx);
const G = ctx.window.GEO_COVER;
let failed = 0;
const check = (n, c) => { console.log((c ? "  OK  " : " FAIL ") + n); if (!c) failed++; };
const near = (a, b, eps) => Math.abs(a - b) <= eps;

// A ~100 m square ring near 49.49N (ring uses .lng).
const ring = [
  { lat: 49.4900, lng: 24.0000 }, { lat: 49.4900, lng: 24.0014 },
  { lat: 49.4909, lng: 24.0014 }, { lat: 49.4909, lng: 24.0000 },
];
check("pointInRing: centre is inside", G.pointInRing(49.49045, 24.0007, ring) === true);
check("pointInRing: far point is outside", G.pointInRing(49.60, 24.10, ring) === false);

// distInField: a track that stays inside the ring returns > 0 (the {lat,lon} contract).
const inside = [
  { lat: 49.4902, lon: 24.0003 }, { lat: 49.4902, lon: 24.0011 }, { lat: 49.4907, lon: 24.0011 },
];
check("distInField: in-field track > 0 (lon/lng contract)", G.distInField(inside, ring) > 0);
check("distInField: null ring → null (caller falls back)", G.distInField(inside, null) === null);
// A track entirely outside contributes 0.
const outside = [{ lat: 49.60, lon: 24.10 }, { lat: 49.61, lon: 24.11 }];
check("distInField: out-of-field track = 0", G.distInField(outside, ring) === 0);

// coverageCompletion: sawComplete / threshold / fraction.
check("completion: sawComplete → covComplete", G.coverageCompletion({ sawComplete: true, wpReached: 0, wpTotal: 10, hasRtl: true }).covComplete === true);
check("completion: >=90% → covComplete", G.coverageCompletion({ sawComplete: false, wpReached: 9, wpTotal: 11, hasRtl: true }).covComplete === true); // lastCoverageSeq=9, wr/9=1.0
check("completion: 50% → not complete", G.coverageCompletion({ sawComplete: false, wpReached: 5, wpTotal: 21, hasRtl: true }).covComplete === false); // last=19, 5/19≈0.26
check("completion: pct rounds", G.coverageCompletion({ sawComplete: false, wpReached: 10, wpTotal: 21, hasRtl: true }).completionPct === 53); // 10/19=0.526→53

// coveredHa: complete → area_ha; partial → dist*swath/1e4 capped; no swath → null.
// (distM must plausibly cover the area — the old fixture's 999 м for 12.5 га encoded the
// full-credit bug the plausibility gate now closes; 5000 м × 20 м = 10 га ≥ 60% of 12.5.)
check("coveredHa: complete → area_ha", G.coveredHa({ covComplete: true, areaHa: 12.5, swathM: 20, distM: 5000 }) === 12.5);
check("coveredHa: partial = dist*swath/1e4", near(G.coveredHa({ covComplete: false, areaHa: 100, swathM: 20, distM: 5000 }), 10, 1e-6)); // 5000*20/1e4=10
check("coveredHa: partial capped at area_ha", G.coveredHa({ covComplete: false, areaHa: 3, swathM: 20, distM: 5000 }) === 3);
check("coveredHa: no swath → null", G.coveredHa({ covComplete: false, areaHa: 100, swathM: 0, distM: 5000 }) === null);

// applyFieldCredit: partial accumulates, complete resets + increments the counter.
{
  let r = { done_ha: 0, completed_count: 0 };
  r = G.applyFieldCredit(r, 2.5, false);
  check("credit: partial accumulates done_ha", r.done_ha === 2.5 && r.completed_count === 0);
  r = G.applyFieldCredit(r, 1.5, false);
  check("credit: second partial adds up", r.done_ha === 4.0 && r.completed_count === 0);
  r = G.applyFieldCredit(r, 0, true);
  check("credit: complete resets cycle + bumps count", r.done_ha === 0 && r.completed_count === 1);
  r = G.applyFieldCredit(r, 3.0, false);
  check("credit: next cycle starts fresh", r.done_ha === 3.0 && r.completed_count === 1);
  const orig = { done_ha: 5, completed_count: 2 };
  G.applyFieldCredit(orig, 1, false);
  check("credit: does not mutate the input record", orig.done_ha === 5 && orig.completed_count === 2);
}

{
  // Plausibility gate (field report: 51 га за 3 хв). Ivan's exact numbers: Бзів 6 ≈ 51.35 га,
  // 1374 м треку, захват 80 м, sawComplete=true (a SHORT uploaded list finished its last WP).
  const hop = { covComplete: true, areaHa: 51.35, swathM: 80, distM: 1374 };
  check("plausibility: short 'complete' hop is NOT full credit", G.fullCreditOk(hop) === false);
  const hopHa = G.coveredHa(hop);
  check("plausibility: hop covered = distance-based (~10.99), not the field",
        Math.abs(hopHa - 1374 * 80 / 1e4) < 0.01 && hopHa < 12);
  // A real full mission: enough distance to plausibly sweep the field → full area.
  const full = { covComplete: true, areaHa: 51.35, swathM: 80, distM: 51.35 * 1e4 / 80 * 0.9 };
  check("plausibility: real complete keeps full-area credit", G.fullCreditOk(full) === true && G.coveredHa(full) === 51.35);
  // Legacy record without swath info: trust the complete flag (old behaviour).
  const legacy = { covComplete: true, areaHa: 20, swathM: 0, distM: 500 };
  check("plausibility: no-swath legacy complete keeps full credit", G.coveredHa(legacy) === 20);
  // Partial path untouched.
  const part = { covComplete: false, areaHa: 20, swathM: 8, distM: 5000 };
  check("plausibility: partial stays distance-based capped", G.coveredHa(part) === 4);
}

console.log("\nRESULT: " + (failed ? `${failed} FAILURE(S)` : "ALL CHECKS PASSED"));
process.exit(failed ? 1 : 0);
