/* Headless unit tests for web-stable/vio-mode.js (GPS-denied panel geometry).
 * Run: node test_viomode.mjs   (Node 18+, no DOM). */
import fs from "fs";
import vm from "vm";
import { fileURLToPath } from "url";
import path from "path";
const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(HERE, "web-stable", "vio-mode.js"), "utf8"), ctx);
const V = ctx.window.VIO_MODE;
let failed = 0;
const check = (n, c) => { console.log((c ? "  OK  " : " FAIL ") + n); if (!c) failed++; };
const near = (a, b, eps) => Math.abs(a - b) <= eps;

const home = { lat: 49.5000, lng: 24.0000 };
// 0.001 deg of latitude = 111.2 m north; 0.001 deg of longitude here = 72.2 m east
check("bearing: due north = 0", near(V.bearingDeg(49.5, 24, 49.501, 24), 0, 0.01));
check("bearing: due east = 90", near(V.bearingDeg(49.5, 24, 49.5, 24.001), 90, 0.01));
check("bearing: due south = 180", near(V.bearingDeg(49.5, 24, 49.499, 24), 180, 0.01));
check("bearing: due west = 270", near(V.bearingDeg(49.5, 24, 49.5, 23.999), 270, 0.01));
check("compass8: 0 Пн, 44 ПнСх, 90 Сх, 359 Пн, 225 ПдЗх",
  V.compass8(0) === "Пн" && V.compass8(44) === "ПнСх" && V.compass8(90) === "Сх" &&
  V.compass8(359) === "Пн" && V.compass8(225) === "ПдЗх");

// relative to the nose: + right, - left, wrap-safe
check("relative: field 90, nose 0 -> +90 праворуч",
  V.relativeDeg(90, 0) === 90 && V.sideWord(90) === "праворуч");
check("relative: field 10, nose 350 -> +20 попереду (wraps through north)",
  near(V.relativeDeg(10, 350), 20, 1e-9) && V.sideWord(20) === "попереду");
check("relative: field 350, nose 10 -> -20 попереду", near(V.relativeDeg(350, 10), -20, 1e-9));
check("relative: field 270, nose 0 -> -90 ліворуч", V.relativeDeg(270, 0) === -90 && V.sideWord(-90) === "ліворуч");
check("relative: field 180, nose 0 -> позаду", V.sideWord(V.relativeDeg(180, 0)) === "позаду");

// a 100 x 100 m-ish field whose SOUTH edge is 111 m north of home
const ring = [
  { lat: 49.5010, lng: 23.9995 }, { lat: 49.5010, lng: 24.0005 },
  { lat: 49.5020, lng: 24.0005 }, { lat: 49.5020, lng: 23.9995 },
];
const np = V.nearestOnRing(home.lat, home.lng, ring);
check("nearestOnRing: the south edge, straight north, ~111 m",
  near(np.dist, 111.2, 0.5) && near(np.lat, 49.5010, 1e-6) && near(np.lng, 24.0, 1e-6));
const inside = V.nearestOnRing(49.5011, 24.0, ring);
check("nearestOnRing: from inside, still the edge (~11 m)", near(inside.dist, 11.1, 0.3));

const route = [[49.5012, 24.0], [49.5018, 24.0], [49.5018, 24.0004]];
const sp = V.routeSpan(home, route);
check("routeSpan: farthest = the far corner, length = 66.7 + 28.9 m",
  near(sp.farthest, V.haversineM(49.5, 24, 49.5018, 24.0004), 1e-6) && near(sp.length, 66.7 + 28.9, 0.5));

// the envelope reads exactly as ardu-gps-denied's reach_for_drift (fmp_import.py)
check("reach 40 m calibrated = 600 m", V.reachM(40, true).reach === 600);
check("reach 20 m calibrated = 200 m", V.reachM(20, true).reach === 200);
check("reach 15 m calibrated = 0 (below the first point)", V.reachM(15, true).reach === 0);
check("reach 40 m as flown = 200 m", V.reachM(40, false).reach === 200);
check("reach 200 m as flown = 4000 m, flagged beyond the data",
  V.reachM(200, false).reach === 4000 && V.reachM(200, false).beyond === true);
check("driftWithin: 350 m calibrated -> 28.4 (rounds up to 400)", V.driftWithin(350, true) === 28.4);
check("driftWithin: past 4000 m -> null", V.driftWithin(4500, true) === null);
check("ENVELOPE_PLAN = pointwise max(CAL, PHYS) of fmp_import.py",
  JSON.stringify(V.ENVELOPE_PLAN) === JSON.stringify(
    [17.8, 19.4, 28.4, 28.4, 70.6, 70.6, 70.6, 70.6, 94.2].map((c, i) =>
      Math.max(c, [12.5, 13.0, 17.9, 27.0, 70.9, 70.9, 70.9, 70.9, 104.9][i]))));

check("originArgs: two vio.args lines, 7 decimals",
  V.originArgs({ lat: 49.12345678, lng: 24.5 }) === "--origin\n49.1234568,24.5000000");
check("parseLatLon: '49.5, 24.0' / '49.5 24' / '49.5;24'",
  V.parseLatLon("49.5, 24.0").lat === 49.5 && V.parseLatLon("49.5 24").lng === 24 &&
  V.parseLatLon("49.5;24").lng === 24);
check("parseLatLon: junk and out of range -> null",
  V.parseLatLon("abc") === null && V.parseLatLon("95, 24") === null && V.parseLatLon("") === null);

// ---- #55 measured reach line ----
check("measured worst share = 46.5 m / 4.6 km (03.11, 1.01 %)", near(V.measuredShare(), 46.5 / 4600, 1e-12));
const mr = V.measuredReachM(40);
check("measured reach at 40 m ~3.96 km, within the flown data", near(mr.reach, 40 / (46.5 / 4600), 1e-6) && !mr.beyond);
check("measured reach at 100 m is past the longest flight -> beyond", V.measuredReachM(100).beyond === true);
check("the measured line is far longer than MARS-LVIG's 200 m at 40 m", mr.reach > 10 * V.reachM(40, false).reach);

// ---- #56 time / energy ----
check("segment penalty 13 m/s = 6.2 s, 22 m/s = 13.65 s, 5 m/s = 3 s",
  near(V.segPenaltyS(13), 6.2, 1e-9) && near(V.segPenaltyS(22), 13.65, 1e-9) && near(V.segPenaltyS(5), 3, 1e-9));
// home -> 1 km north -> home at 10 m/s, 40 m: 2000/10 + 2 × 5 + 40/2.5 + 30 + 35 = 291 s
const far = [[49.5 + 1000 / 111195, 24.0]];
const mt = V.missionTime(home, far, { speed: 10, takeoffAlt: 40 });
check("missionTime out-and-back 1 km @10 m/s = 291 s (2 segments)",
  near(mt.total_s, 291, 0.5) && mt.segments === 2 && near(mt.path_m, 2000, 1));
const en = V.energy(600, 0.71, 8);
check("energy: 10 min × 0.71 Ah/min = 7.1 Ah = 88.75 % of 8 Ah", near(en.ah, 7.1, 1e-9) && near(en.pct, 88.75, 1e-9));

// ---- #57 short legs ----
check("leg need: 22 m/s -> 242 m, 13 m/s -> 84.5 m", near(V.legNeedM(22), 242, 1e-9) && near(V.legNeedM(13), 84.5, 1e-9));
// two 115 m passes 20 m apart (the 02.11 case), connector 20 m
const dN = 115 / 111195, dE = 20 / (111195 * Math.cos(49.5 * Math.PI / 180));
const legs = [[49.5, 24], [49.5 + dN, 24], [49.5 + dN, 24 + dE], [49.5, 24 + dE]];
const sl22 = V.shortLegs(legs, 22, 20), sl10 = V.shortLegs(legs, 10, 20);
check("115 m passes: short at 22 m/s (2 of 2), fine at 10 m/s; the 20 m connector is not a pass",
  sl22.passes === 2 && sl22.short === 2 && sl10.short === 0);

// ---- #60 sorties ----
// 12 passes of 400 m, 20 m apart; budget 4 min at 10 m/s
const field = [];
for (let k = 0; k < 12; k++) {
  const a = [49.501, 24 + k * dE], b = [49.501 + 400 / 111195, 24 + k * dE];
  if (k % 2) field.push(b, a); else field.push(a, b);
}
const o = { speed: 10, takeoffAlt: 40 };
const so = V.splitSorties(home, field, 240, o, 20);
const covered = new Set();
so.forEach((r) => { for (let i = r.from; i <= r.to; i++) covered.add(i); });
check("sorties: more than one, every point flown, each within the budget",
  so.length > 1 && covered.size === field.length &&
  so.every((r) => V.missionTime(home, field.slice(r.from, r.to + 1), o).total_s <= 240));
check("sorties cut after a pass end: each sortie has whole passes (even count, starts on a pass start)",
  so.every((r) => (r.to - r.from + 1) % 2 === 0 && r.from % 2 === 0));
check("sorties: one fits -> one", V.splitSorties(home, field, 1e6, o, 20).length === 1);
check("sorties: budget below one point -> null", V.splitSorties(home, field, 10, o, 20) === null);


// 2.5.106: the companion's warnings, newest first, and one beep per new one
{
  const now = 1_000_000;
  const log = [
    { text: "VIO READY 41wp 8.7km 61% 24.6V", sev: 6, ts: now - 50_000 },          // info: not a warning
    { text: "VIO MISSION CHANGED since READY", sev: 4, ts: now - 40_000 },
    { text: "PreArm: Throttle below failsafe", sev: 2, ts: now - 35_000 },          // the FC's own: not the companion
    { text: "VIO: crossing fix 6.6 m (+1 N -6 E)", sev: 6, ts: now - 30_000 },
    { text: "VIOSUP: LAND no integrated frame 1.5 s", sev: 6, ts: now - 20_000 },   // info severity, alarm word
    { text: "VIO NOT READY: pack 21.5V < 24.9V", sev: 4, ts: now - 10_000 },
    { text: "VIOFS: posVar 2.60 >= hold thr 2.5", sev: 4, ts: now - 700_000 },     // older than 10 min
  ];
  const w = V.vioWarnings(log, now, 600_000, 3);
  check("warnings: companion families only, warning severity or an alarm word, newest first, 3 at most",
    w.length === 3 && w[0].text.startsWith("VIO NOT READY") && w[1].text.startsWith("VIOSUP: LAND") &&
    w[2].text.startsWith("VIO MISSION CHANGED"));
  check("warnings: NOT READY, LAND and CHANGED are alarms", w.every((x) => x.alarm));
  check("warnings: age in seconds", Math.abs(w[0].age - 10) < 1e-9);
  check("warnings: an empty or missing log is no warning", V.vioWarnings(undefined, now, 600_000, 3).length === 0);
  check("alarm word: READY alone is not one", !V.VIO_ALARM.test("VIO READY 41wp 8.7km"));

  const a = { text: "VIO NOT READY: pack 21.5V < 24.9V", ts: 100_000 };
  check("alert: the first warning beeps", V.vioAlertDue(a, null));
  check("alert: the same message again (the next render) does not",
    !V.vioAlertDue(a, { text: a.text, ts: a.ts }));
  check("alert: the same text repeated 30 s later does not",
    !V.vioAlertDue({ text: a.text, ts: 130_000 }, { text: a.text, ts: 100_000 }));
  check("alert: ...after 2 min it beeps again", V.vioAlertDue({ text: a.text, ts: 221_000 }, { text: a.text, ts: 100_000 }));
  check("alert: another text beeps at once",
    V.vioAlertDue({ text: "VIO MISSION CHANGED since READY", ts: 101_000 }, { text: a.text, ts: 100_000 }));
  check("alert: nothing newer, no beep", !V.vioAlertDue(undefined, a));
  check("alert: an OLDER warning with another text does not (only what came after the one beeped for)",
    !V.vioAlertDue({ text: "VIO MISSION CHANGED since READY", ts: 90_000 }, a));
}

// 2.5.107: crossing fixes — the port of ardu-gps-denied's fmp_check forecast. Every expected number here is what
// ardu-gps-denied's own code gives for the same input (mission_executor/crossing_fix.py route_fixes / plan_error,
// tests/test_crossing_fix.py and tests/test_fmp_check.py vectors), not what this port gives.
{
  check("planError: the error goes back to the key's and grows again (test_crossing_fix vectors 30 / 10 / 16)",
    near(V.planError(3000, [], 0.01), 30, 1e-9) && near(V.planError(3000, [[2500, 500]], 0.01), 10, 1e-9) &&
    near(V.planError(5000, [[2500, 500], [4000, 2600]], 0.01), 16, 1e-9));
  // rate 0 = route_fixes without drift_frac: every registration lands
  const square = V.routeFixes([[0, 0], [0, 2500], [300, 2500], [300, 1200], [-300, 1200]], 22, 0);
  check("routeFixes: a leg square to the transit 100+ s later corrects once, at route_fixes' [4423.1, 1194.5]",
    square.length === 1 && square[0][0] === 4423.1 && square[0][1] === 1194.5);
  check("routeFixes: the same crossing 36 s after the key does not (key age 60 s)",
    V.routeFixes([[0, 0], [0, 800], [300, 800], [300, 700], [-300, 700]], 22, 0).length === 0);
  check("routeFixes: a route that never crosses itself does not",
    V.routeFixes([[0, 0], [0, 1500], [300, 1500]], 22, 0).length === 0);
  const loop = [[0, 0], [0, 1200], [300, 1200], [300, 500], [-300, 500]];
  const l1 = V.routeFixes(loop, 22, 0.0101);
  check("routeFixes: 2 km between the passes at 1.01 % is inside the 25 m reach -> [2523.1, 501.6]; at 2 % it is not",
    l1.length === 1 && l1[0][0] === 2523.1 && l1[0][1] === 501.6 && V.routeFixes(loop, 22, 0.02).length === 0);
  // test_fmp_check LOOP: 1 fix, 13.75 m at the end (34.17 without), 25.48 m just before the crossing
  const fl = V.forecastNE([[1200, 0], [1200, 300], [500, 300], [500, -300]], 0);
  check("forecastNE: fmp_check's LOOP — 1 fix, end 13.75, worst 25.48, 34.17 without, scored at 22 m/s",
    fl.fixes.length === 1 && near(fl.end_m, 13.752, 0.005) && near(fl.worst_m, 25.483, 0.005) &&
    near(fl.nofix_m, 34.169, 0.005) && fl.speed === 22);
  check("forecastNE: a faster mission is scored at its own speed", V.forecastNE([[100, 0]], 25).speed === 25);

  // A real 30 ha field's route as N, E metres from its home (M16, 10 points; flown 03.11 at 13 m/s). fmp_check on
  // that flight's file: 5 fixes, 15.55 m at the end, 20.44 m on the way; route_fixes with the closure point: 7, 0.91.
  const M16 = [[-667.7, 431.1], [-12.4, 315.6], [-24.5, 236.5], [-682.8, 352.6], [-698.0, 274.0], [-36.6, 157.4],
    [-48.8, 78.3], [-713.2, 195.5], [-728.3, 116.9], [-60.9, -0.8]];
  const f16 = V.forecastNE([...M16, [0, 0]], 13);
  check("forecastNE: M16 as fmp_check scores it — 5 fixes, 15.55 / 20.44 m, the first at [2024.0, 578.2]",
    f16.fixes.length === 5 && near(f16.end_m, 15.549, 0.005) && near(f16.worst_m, 20.442, 0.005) &&
    f16.fixes[0][0] === 2024.0 && f16.fixes[0][1] === 578.2);
  const cp = V.closurePoint(M16[0], M16[M16.length - 1]);
  check("closurePoint: 100 m out on the transit line", near(cp[0], -84.011, 0.001) && near(cp[1], 54.242, 0.001));
  const c16 = V.forecastNE([...M16, cp, [0, 0]], 13);
  check("closure: the return over the transit's keys — 7 fixes, 0.91 m at the end (route_fixes: 7, 0.910)",
    c16.fixes.length === 7 && near(c16.end_m, 0.910, 0.005) && near(c16.worst_m, 20.442, 0.005));
  check("closurePoint: none when the route starts within 120 m (nothing to close over)",
    V.closurePoint([0, 110], [500, 500]) === null);
  check("closurePoint: none when the way to it passes within 30 m of home (the home fix would start on a pass)",
    V.closurePoint([0, 400], [0, -300]) === null && V.closurePoint([0, 400], [200, -300]) !== null);

  // The planner on that route, placed at this file's synthetic home (no real coordinates in the repo)
  const ll = M16.map((ne) => V.fromNE(home, ne));
  check("toNE / fromNE round-trip to 1 mm", ll.every((p, i) => near(V.toNE(home, p[0], p[1])[0], M16[i][0], 1e-3) &&
    near(V.toNE(home, p[0], p[1])[1], M16[i][1], 1e-3)));
  const p16 = V.planVioRoute(home, ll, 13);
  check("plan: M16 as built + closure — 0.91 m at the end instead of 15.55, +99 m of path",
    !p16.reversed && p16.closed && p16.route.length === 11 && near(p16.fc.end_m, 0.910, 0.01) &&
    near(p16.extraM, 98.8, 0.5) && p16.options.length === 3);
  check("plan: the reversal kept M16's end (15.56) but doubled the error mid-field (39.9) — not chosen",
    p16.options.some((o) => o.reversed && !o.closed && near(o.fc.end_m, 15.561, 0.01) && near(o.fc.worst_m, 39.883, 0.01)));
  const pr = V.planVioRoute(home, ll.slice().reverse(), 13);
  check("plan: a route built from the near end is turned round so the transit crosses the legs, then closed",
    pr.reversed && pr.closed && near(pr.fc.end_m, 0.910, 0.01) && pr.route[0] === ll[0]);
  const pa = V.planVioRoute(home, ll.slice().reverse(), 13, true);
  check("plan asBuilt (a resumed remainder): the forecast of the route as uploaded, nothing turned or added",
    !pa.reversed && !pa.closed && pa.options.length === 1 && pa.route.length === ll.length && near(pa.fc.end_m, 15.561, 0.01));
  // no crossing either way, the start too close to close over: 4 km of legs north of home, as built kept
  const lane = [[0, 100], [2000, 100], [2000, 180], [0, 180]].map((ne) => V.fromNE(home, ne));
  const pl = V.planVioRoute(home, lane, 13);
  check("plan: no crossing either way -> as built, open, over the 20 m gate (the panel warns)",
    !pl.reversed && !pl.closed && pl.fc.fixes.length === 0 && pl.fc.end_m > V.FORECAST_GATE_M);
  check("plan: no route -> null", V.planVioRoute(home, [ll[0]], 13) === null && V.planVioRoute(null, ll, 13) === null);
  // 4 legs of 500 m, 80 m apart, home 60 m west of the first. route_fixes: as built 2 fixes, 0.874 m at the end,
  // 25.13 m on the way; reversed 2, 0.885, 15.09 — the same end, the field flown with 10 m less error
  const four = [[0, 60], [500, 60], [500, 140], [0, 140], [0, 220], [500, 220], [500, 300], [0, 300]];
  const p4 = V.planVioRoute(home, four.map((ne) => V.fromNE(home, ne)), 22);
  const o4 = p4.options.find((o) => !o.reversed && !o.closed);
  check("plan: the same end either way (0.87 / 0.89 m) -> the direction with 15.1 m on the way, not 25.1",
    p4.reversed && !p4.closed && near(p4.fc.end_m, 0.885, 0.005) && near(p4.fc.worst_m, 15.09, 0.005) &&
    near(o4.fc.end_m, 0.874, 0.005) && near(o4.fc.worst_m, 25.128, 0.005));
  // two keys exactly as near: CrossingFix's scan (`d <= best_d`) takes the later one — route_fixes: [1573.0, 49.0]
  const tie = V.routeFixes([[0, 0], [200, 0], [200, 600], [45, 600], [45, -600]], 20, 0);
  check("routeFixes: of two equally near keys the later one, as route_fixes ([1573.0, 49.0])",
    tie.length === 1 && tie[0][0] === 1573.0 && tie[0][1] === 49.0);

  const sq = [{ lat: 49.501, lng: 23.999 }, { lat: 49.501, lng: 24.001 }, { lat: 49.502, lng: 24.001 }, { lat: 49.502, lng: 23.999 }];
  check("segmentHitsRing: across a cut-out, out of it, wholly inside it, and past it",
    V.segmentHitsRing([49.5, 24.0], [49.503, 24.0], sq) && V.segmentHitsRing([49.5015, 24.0], [49.5, 24.0], sq) &&
    V.segmentHitsRing([49.5015, 24.0], [49.5016, 24.0002], sq) &&
    !V.segmentHitsRing([49.5, 24.0], [49.5, 24.003], sq) && !V.segmentHitsRing([49.5, 24.0], [49.503, 24.0], [sq[0], sq[1]]));
}

console.log("\nRESULT: " + (failed ? `${failed} FAILURE(S)` : "ALL CHECKS PASSED"));
process.exit(failed ? 1 : 0);
