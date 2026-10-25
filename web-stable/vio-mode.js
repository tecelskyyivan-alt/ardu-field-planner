/* GPS-denied (VIO) mode — pure geometry for the panel in app.js (window.VIO_MODE) and
 * test_viomode.mjs. NO DOM. Points are {lat,lng} (Leaflet); a route is [[lat,lng],…].
 *
 * Without GPS the aircraft knows WHERE IT IS only relative to the EKF origin, which the
 * companion sets to the take-off point (`vio_onboard --origin lat,lon`), and WHICH WAY IT
 * LOOKS from the compass. So the operator puts the home point on the map; this answers,
 * from that point: where the field is, where it is relative to the nose, how far the
 * route goes, and whether that is within what the VIO is measured to hold.
 */
(function (global) {
  "use strict";
  const R = 6371000;
  const rad = Math.PI / 180;

  function haversineM(aLat, aLon, bLat, bLon) {
    const dLat = (bLat - aLat) * rad, dLon = (bLon - aLon) * rad;
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // Initial great-circle bearing a -> b, degrees clockwise from north, [0, 360).
  function bearingDeg(aLat, aLon, bLat, bLon) {
    const y = Math.sin((bLon - aLon) * rad) * Math.cos(bLat * rad);
    const x = Math.cos(aLat * rad) * Math.sin(bLat * rad) -
      Math.sin(aLat * rad) * Math.cos(bLat * rad) * Math.cos((bLon - aLon) * rad);
    return (Math.atan2(y, x) / rad + 360) % 360;
  }

  const POINTS8 = ["Пн", "ПнСх", "Сх", "ПдСх", "Пд", "ПдЗх", "Зх", "ПнЗх"];
  function compass8(deg) {
    return POINTS8[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
  }

  // Target bearing relative to the nose, (-180, 180]: + = to the right.
  function relativeDeg(targetDeg, headingDeg) {
    let d = ((targetDeg - headingDeg) % 360 + 360) % 360;
    return d > 180 ? d - 360 : d;
  }
  function sideWord(rel) {
    const a = Math.abs(rel);
    if (a <= 20) return "попереду";
    if (a >= 160) return "позаду";
    return rel > 0 ? "праворуч" : "ліворуч";
  }

  // Nearest point of a ring's boundary to (lat, lon): local metric projection, which
  // is what a field-sized polygon needs. Inside the ring it is still the edge point.
  function nearestOnRing(lat, lon, ring) {
    if (!ring || ring.length < 2) return null;
    const kx = Math.cos(lat * rad) * R * rad, ky = R * rad;
    const P = (p) => [(p.lng - lon) * kx, (p.lat - lat) * ky];
    let best = null;
    for (let i = 0; i < ring.length; i++) {
      const a = P(ring[i]), b = P(ring[(i + 1) % ring.length]);
      const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
      const t = L2 > 0 ? Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / L2)) : 0;
      const x = a[0] + t * dx, y = a[1] + t * dy, d = Math.hypot(x, y);
      if (!best || d < best.dist) best = { lat: lat + y / ky, lng: lon + x / kx, dist: d };
    }
    return best;
  }

  // Farthest route point from home, metres, and the route's own length.
  function routeSpan(home, route) {
    let far = 0, len = 0;
    for (let i = 0; i < (route || []).length; i++) {
      far = Math.max(far, haversineM(home.lat, home.lng, route[i][0], route[i][1]));
      if (i) len += haversineM(route[i - 1][0], route[i - 1][1], route[i][0], route[i][1]);
    }
    return { farthest: far, length: len };
  }

  // The MEASURED drift envelope of ardu-gps-denied (mission_planner/fmp_import.py,
  // ERROR_BUDGET §3.1.298): worst error within N m of flight from one anchor, worse of
  // two real flights. PLAN = mount yaw measured on the ground; UNCAL = as flown without
  // it. Copied, not derived — re-copy when that table moves.
  const ENVELOPE_M = [100, 200, 400, 600, 1000, 1500, 2000, 3000, 4000];
  const ENVELOPE_PLAN = [17.8, 19.4, 28.4, 28.4, 70.9, 70.9, 70.9, 70.9, 104.9];
  const ENVELOPE_UNCAL = [35.1, 35.5, 75.6, 78.4, 173.9, 190.0, 190.0, 190.0, 190.0];

  // Largest measured flight distance whose worst error is within tolM (0 = not even
  // the first 100 m), as ardu-gps-denied's reach_for_drift reads it. `beyond` = the
  // tolerance is looser than the last measured point (the tool there extrapolates; this
  // panel does not, it says "more than the data").
  function reachM(tolM, calibrated) {
    const env = calibrated ? ENVELOPE_PLAN : ENVELOPE_UNCAL;
    let best = 0;
    for (let i = 0; i < ENVELOPE_M.length; i++) if (env[i] <= tolM) best = ENVELOPE_M[i];
    return { reach: best, beyond: best === ENVELOPE_M[ENVELOPE_M.length - 1] };
  }

  // Worst error the envelope gives for a flight of `distM` from the anchor (rounded UP to
  // the next measured point), or null past the data.
  function driftWithin(distM, calibrated) {
    const env = calibrated ? ENVELOPE_PLAN : ENVELOPE_UNCAL;
    for (let i = 0; i < ENVELOPE_M.length; i++) if (distM <= ENVELOPE_M[i]) return env[i];
    return null;
  }

  // vio.args lines for the companion: one argument per line (#97).
  function originArgs(home) {
    return "--origin\n" + home.lat.toFixed(7) + "," + home.lng.toFixed(7);
  }

  // Parse "lat, lon" typed or pasted by the operator; null if it is not two numbers in range.
  function parseLatLon(s) {
    const m = String(s || "").trim().match(/^(-?\d+(?:\.\d+)?)\s*[,; ]\s*(-?\d+(?:\.\d+)?)$/);
    if (!m) return null;
    const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
    if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) return null;
    return { lat, lng };
  }

  global.VIO_MODE = { haversineM, bearingDeg, compass8, relativeDeg, sideWord, nearestOnRing,
    routeSpan, reachM, driftWithin, originArgs, parseLatLon,
    ENVELOPE_M, ENVELOPE_PLAN, ENVELOPE_UNCAL, ORIGIN_TOL_M: 8.0 };
})(typeof window !== "undefined" ? window : globalThis);
