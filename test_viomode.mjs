/* Headless unit tests for web-stable/vio-mode.js (GPS-denied panel geometry).
 * Run: node test_viomode.mjs   (Node 18+, no DOM). */
import fs from "fs";
import vm from "vm";
import { fileURLToPath } from "url";
import path from "path";
const HERE = path.dirname(fileURLToPath(import.meta.url));
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

console.log("\nRESULT: " + (failed ? `${failed} FAILURE(S)` : "ALL CHECKS PASSED"));
process.exit(failed ? 1 : 0);
