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

console.log("\nRESULT: " + (failed ? `${failed} FAILURE(S)` : "ALL CHECKS PASSED"));
process.exit(failed ? 1 : 0);
