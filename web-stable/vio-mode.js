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

  // MEASURED on the aircraft (ardu-gps-denied flights, home-fix error after the whole
  // route; FMP #55). The MARS-LVIG envelope above comes from public RTK sequences and
  // fires on every useful route; this is what the aircraft itself did. Worst share of
  // path, not the mean: one bad flight sets the line. Re-copy when new flights land.
  const MEASURED = [
    { date: "2026-11-02", v: 13, path: 2680, err: 8.4 },
    { date: "2026-11-02", v: 13, path: 677, err: 5.1 },
    { date: "2026-11-02", v: 10, path: 330, err: 3.2 },   // 5-10 m/s, 8 flights 0.33-0.68 km: worst pairing
    { date: "2026-11-03", v: 13, path: 4600, err: 46.5 },
    { date: "2026-11-03", v: 20, path: 4400, err: 30.9 },
  ];
  function measuredShare() { return Math.max(...MEASURED.map((f) => f.err / f.path)); }
  function measuredMaxPath() { return Math.max(...MEASURED.map((f) => f.path)); }
  // Route length (m) the measured worst share keeps within tolM; beyond = past the longest
  // flown route (the line is then an extrapolation and the panel says so).
  function measuredReachM(tolM) {
    const reach = tolM / measuredShare();
    return { reach, share: measuredShare(), beyond: reach > measuredMaxPath() };
  }

  // ---- time / energy (FMP #56): ardu-gps-denied mission_planner/energy.py model, which
  // reproduced 4 flights of 2026-11-02 to ±4 s. Per segment an accelerate-and-brake
  // penalty (S-curve, WP_ACC 2.5): v/2.5+1 s up to 13 m/s, then linear to 13.65 s at 22.
  function segPenaltyS(v) {
    return v <= 13 ? v / 2.5 + 1 : 6.2 + (v - 13) * (13.65 - 6.2) / (22 - 13);
  }
  // home -> route… -> home, VIO profile: climb at 2.5 m/s, holds 5 + 25 s, ~35 s LAND.
  // Returns {total_s, path_m, segments}. o: {speed, takeoffAlt, holdStart, holdEnd, landS, climb}.
  function missionTime(home, route, o) {
    const v = Math.max(+(o && o.speed) || 0, 0.5);
    const climb = (o && o.climb) || 2.5;
    const pts = [[home.lat, home.lng], ...(route || []), [home.lat, home.lng]];
    let path = 0, segs = 0;
    for (let i = 1; i < pts.length; i++) {
      const d = haversineM(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
      if (d > 0.5) { path += d; segs++; }
    }
    const hold = ((o && o.holdStart != null) ? o.holdStart : 5) + ((o && o.holdEnd != null) ? o.holdEnd : 25);
    const total = path / v + segs * segPenaltyS(v) + ((o && o.takeoffAlt) || 0) / climb + hold +
      ((o && o.landS != null) ? o.landS : 35);
    return { total_s: total, path_m: path, segments: segs };
  }
  // Charge for that time: Ah/min measured at 13 m/s on the 6S Li-ion pack (issue #56: 0.71).
  function energy(totalS, ahPerMin, packAh) {
    const ah = totalS / 60 * ahPerMin;
    return { ah, pct: packAh > 0 ? 100 * ah / packAh : null };
  }

  // ---- short legs (FMP #57): the copter needs ~v²/(2·WP_ACC) to reach v and as much to
  // stop; with S-curve margin 2.5×. Passes = segments longer than 1.5 × the pass spacing
  // (shorter ones are the connectors between passes).
  function legNeedM(v, wpAcc) { return 2.5 * v * v / (2 * (wpAcc || 2.5)); }
  function shortLegs(route, speed, spacing, wpAcc) {
    const need = legNeedM(speed, wpAcc), minPass = 1.5 * (spacing || 0);
    let passes = 0, short = 0;
    for (let i = 1; i < (route || []).length; i++) {
      const d = haversineM(route[i - 1][0], route[i - 1][1], route[i][0], route[i][1]);
      if (d <= minPass) continue;
      passes++;
      if (d < need) short++;
    }
    return { need, passes, short };
  }

  // ---- sorties (FMP #60, owner 02.11): a field over the pack budget is split by legs;
  // each sortie = home → a run of the route → home (the VIO profile), within budgetS by
  // missionTime. Cuts go after a pass end (the next segment is a connector, ≤ 1.5 ×
  // spacing) so the next sortie starts on the next pass; if no connector fits, the cut
  // lands mid-pass and the next sortie starts on that same point (nothing is skipped).
  // Returns [{from, to}] index ranges into route (inclusive), or null if one point alone
  // does not fit.
  function splitSorties(home, route, budgetS, o, spacing) {
    const n = (route || []).length, out = [];
    const minPass = 1.5 * (spacing || 0);
    const seg = (i) => haversineM(route[i][0], route[i][1], route[i + 1][0], route[i + 1][1]);
    let from = 0;
    while (from < n) {
      let to = from;
      if (missionTime(home, route.slice(from, from + 1), o).total_s > budgetS) return null;
      while (to + 1 < n && missionTime(home, route.slice(from, to + 2), o).total_s <= budgetS) to++;
      if (to === n - 1) { out.push({ from, to }); break; }
      let cut = -1;
      for (let j = to; j > from; j--) if (seg(j) <= minPass) { cut = j; break; }
      if (cut >= 0) { out.push({ from, to: cut }); from = cut + 1; }
      else { out.push({ from, to }); from = to; if (to === out[out.length - 1].from) return null; }
    }
    return out;
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

  // The companion's warnings, newest first (2.5.106: the manual flight without the laptop). The VIO row keeps only the
  // newest text of each family, so "VIO MISSION CHANGED since READY" said at arming was gone with the first "VIO: …"
  // after take-off. `log`: [{text, sev, ts}] oldest first (MavLink's msg_log); a warning is MAV_SEVERITY <= 4 or an
  // alarm word; `max` of them within `maxAgeMs`, newest first.
  const VIO_FAMILY = /^(VIOSUP|VIOFS|VIO|MISSION)\b/;
  const VIO_ALARM = /LAND|FAIL|LOST|MISMATCH|DIFF|STOP|NOT READY|CHANGED/i;
  function vioWarnings(log, now, maxAgeMs, max) {
    const out = [];
    for (let i = (log || []).length - 1; i >= 0 && out.length < max; i--) {
      const m = log[i];
      if (!m || !VIO_FAMILY.test(m.text) || now - m.ts > maxAgeMs) continue;
      const alarm = m.sev <= 2 || VIO_ALARM.test(m.text);
      if (m.sev <= 4 || alarm) out.push({ text: m.text, sev: m.sev, ts: m.ts, age: (now - m.ts) / 1000, alarm });
    }
    return out;
  }
  // One beep per NEW warning (`last` = the one beeped for, {text, ts}): only a message that came after it, and not
  // the same text again within 2 min — the companion repeats "VIO NOT READY: …" every 30 s until it is ready.
  function vioAlertDue(w, last) {
    return !!w && (!last || (w.ts > last.ts && (w.text !== last.text || w.ts - last.ts > 120000)));
  }

  // ---- crossing fixes (2.5.107, ardu-gps-denied plan 3.1) ------------------------------------------------
  // The only mid-mission reset without GPS: where the route flies over ground it flew a minute or more before (the
  // transit from home crossing the legs), the companion registers the frame against the earlier one and corrects the
  // VIO. This is ardu-gps-denied's `tools/fmp_check.py` forecast, ported line for line: `mission_executor/
  // crossing_fix.py` (CrossingFix fed the plan by `route_fixes`, `plan_error`) and the numbers of `mission_planner/
  // fmp_import.py` `_aircraft_rows`. Copied, not derived — re-copy when those move.
  const AIRCRAFT_DRIFT = 0.0101;   // the error grows 1.01 % of path: the worst of 12 flights 02-03.11 (AIRCRAFT_DRIFT)
  const CF = { minAgl: 15, minHome: 40, keyEvery: 10, maxKeys: 800, minKeyAge: 60, triggerR: 12, need: 2,
    window: 6, minGap: 0.5, pathStep: 1, hz: 20, latency: 0.45, agl: 40, reach: 25 };   // CrossingFix / route_fixes
  const SCORE_SPEED = 22;          // fmp_check --speed (the ops speed); the mission's own speed when faster
  const R_WGS = 6378137;           // fmp_import scores in geo.ll_to_xy: equirectangular at home, this radius
  const FORECAST_GATE_M = 20;      // plan 3.1: every VIO mission <= 20 m at the end, or a warning
  const CLOSURE_M = 100, CLOSURE_CLEAR_M = 30;   // make_missions_next.closure_point (close100)

  function toNE(home, lat, lng) {
    return [(lat - home.lat) * rad * R_WGS, (lng - home.lng) * rad * R_WGS * Math.cos(home.lat * rad)];
  }
  function fromNE(home, ne) {
    return [home.lat + ne[0] / R_WGS / rad, home.lng + ne[1] / (R_WGS * Math.cos(home.lat * rad)) / rad];
  }

  // The error after x m of route: each fix [path m, its key's path m] puts it back to what it was at the key — the
  // fix aligns to the earlier pass, not to the truth.
  function planError(x, fixes, rate) {
    let last = null;
    for (const f of fixes) { if (f[0] > x) break; last = f; }
    return last === null ? rate * x : planError(last[1], fixes, rate) + rate * (x - last[0]);
  }

  // route_fixes: where the flight program corrects on a planned route [[n, e] m from home, …], flown at `speed`, a
  // frame every 1/hz s; a registration lands `latency` s after it was submitted unless the two frames' errors are
  // more than `reach` apart. Every registration measures exactly the plan's offset, so the deltas are all zero and
  // agree: CrossingFix._agree reduces to `need` of them inside `window` (median 0, under any cap).
  function routeFixes(route, speed, rate) {
    const out = [], keys = [], grid = new Map();     // grid: keys by triggerR-sized cell, so a frame looks at 9 cells
    let clock = 0, pathM = 0, pathRef = null, keyRef = null, job = null, jobDoneT = -Infinity, pending = null;
    let deltas = [];
    const round1 = (x) => Math.round(x * 10) / 10;
    const cellKey = (a, b) => a * 1e6 + b;          // unique while |b| < 5e5 cells (6000 km)
    // _near: the nearest usable key within triggerR, the later one on a tie (the scan's `d <= best_d`).
    function near(n, e, now) {
      let best = null, bestD2 = CF.triggerR * CF.triggerR;
      const cn = Math.floor(n / CF.triggerR), ce = Math.floor(e / CF.triggerR);
      for (let a = cn - 1; a <= cn + 1; a++) for (let b = ce - 1; b <= ce + 1; b++) {
        for (const i of grid.get(cellKey(a, b)) || []) {
          const k = keys[i];
          if (k.spent || now - k.t < CF.minKeyAge) continue;     // one altitude: the AGL gate never binds
          const d2 = (n - k.n) * (n - k.n) + (e - k.e) * (e - k.e);
          if (d2 < bestD2 || (d2 === bestD2 && (best === null || i > best))) { best = i; bestD2 = d2; }
        }
      }
      return best;
    }
    function submit(s, ki, tFrame) {
      const apart = Math.abs(planError(s, out, rate) - planError(keys[ki].path, out, rate));
      job = { doneT: clock + CF.latency, ok: apart <= CF.reach, ki, tFrame };
    }
    function agree(now) {
      deltas = deltas.filter((d) => now - d.t <= CF.window);
      if (deltas.length < CF.need) return null;
      const ki = deltas[deltas.length - 1].ki, k = keys[ki];
      for (const kk of keys) if (Math.hypot(kk.n - k.n, kk.e - k.e) <= 2 * CF.triggerR) kk.spent = true;
      deltas = [];
      return ki;
    }
    function offer(n, e, s) {
      const now = clock;
      if (pathRef === null) pathRef = [n, e];
      const step = Math.hypot(n - pathRef[0], e - pathRef[1]);
      if (step >= CF.pathStep) { pathM += step; pathRef = [n, e]; }
      let fixKi = null;
      if (job !== null && now >= job.doneT) {
        const j = job; job = null; jobDoneT = now;
        if (j.ok) deltas.push({ t: j.tFrame, ki: j.ki });
        fixKi = agree(now);
      }
      if (CF.agl >= CF.minAgl && Math.hypot(n, e) >= CF.minHome && keys.length < CF.maxKeys &&
          (keyRef === null || Math.hypot(n - keyRef[0], e - keyRef[1]) >= CF.keyEvery)) {
        keys.push({ n, e, t: now, path: pathM, spent: false });
        const c = cellKey(Math.floor(n / CF.triggerR), Math.floor(e / CF.triggerR));
        if (!grid.has(c)) grid.set(c, []);
        grid.get(c).push(keys.length - 1);
        keyRef = [n, e];
      }
      const ki = near(n, e, now);
      if (job === null && fixKi === null && now - jobDoneT >= CF.minGap) {
        const p = pending; pending = null;
        if (ki !== null) submit(s, ki, now);
        else if (p !== null && !keys[p.ki].spent) submit(p.s, p.ki, p.t);
      } else if (ki !== null) {
        // busy or pausing while passing a key: keep the frame nearest it, register it when the worker frees (T37)
        const d = Math.hypot(n - keys[ki].n, e - keys[ki].e);
        if (pending === null || d < pending.d) pending = { d, s, ki, t: now };
      }
      return fixKi;
    }
    let s = 0;
    const step = speed / CF.hz;
    for (let i = 1; i < route.length; i++) {
      const [n0, e0] = route[i - 1], [n1, e1] = route[i];
      const seg = Math.hypot(n1 - n0, e1 - e0), k = Math.max(1, Math.ceil(seg / step));
      for (let j = 1; j <= k; j++) {
        s += seg / k;
        clock = s / speed;
        const fk = offer(n0 + (n1 - n0) * j / k, e0 + (e1 - e0) * j / k, s);
        if (fk !== null) out.push([round1(s), round1(keys[fk].path)]);
      }
    }
    return out;
  }

  // fmp_check's drift rows for the waypoints [[n, e] m from home, …] as its loader reads them (every NAV_WAYPOINT in
  // order, the VIO end's "WP home" included), home -> them -> home: {fixes: [[s, key s]…], end_m, worst_m (on the
  // way), nofix_m, path_m, lastFixM (metres before the end), speed}.
  function forecastNE(xy, speed) {
    const pts = [[0, 0], ...xy, [0, 0]];
    let path = 0;
    for (let i = 1; i < pts.length; i++) path += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const v = Math.max(SCORE_SPEED, +speed || 0), fixes = routeFixes(pts, v, AIRCRAFT_DRIFT);
    const end = planError(path, fixes, AIRCRAFT_DRIFT);
    const worst = Math.max(end, ...fixes.map((f) => planError(f[0] - 1e-6, fixes, AIRCRAFT_DRIFT)));
    return { fixes, end_m: end, worst_m: worst, nofix_m: AIRCRAFT_DRIFT * path, path_m: path, speed: v,
      lastFixM: fixes.length ? path - fixes[fixes.length - 1][0] : null };
  }
  // The same for an FMP VIO mission: home -> route -> WP home (mission_items' VIO end).
  function crossingForecast(home, route, speed) {
    return forecastNE([...(route || []).map((p) => toNE(home, p[0], p[1])), [0, 0]], speed);
  }

  // make_missions_next.closure_point: a point on the transit line home -> `first` at CLOSURE_M from home, so the last
  // CLOSURE_M of the return fly over the keys the transit laid (>= 40 m out). null when the route starts closer than
  // CLOSURE_M + 20 m (nothing to close over) or the way from `last` to it passes within CLOSURE_CLEAR_M of home (the
  // home fix would start on a pass over home). first / last: [n, e] m from home.
  function closurePoint(first, last) {
    const d = Math.hypot(first[0], first[1]);
    if (d < CLOSURE_M + 20) return null;
    const cp = [first[0] * CLOSURE_M / d, first[1] * CLOSURE_M / d];
    const bn = cp[0] - last[0], be = cp[1] - last[1];
    const t = Math.max(0, Math.min(1, -(last[0] * bn + last[1] * be) / Math.max(bn * bn + be * be, 1e-9)));
    return Math.hypot(last[0] + t * bn, last[1] + t * be) < CLOSURE_CLEAR_M ? null : cp;
  }

  // The VIO mission FMP flies for `route` (the whole field or one sortie): as built or reversed — so the transit from
  // home crosses the legs — each open or closed over the transit. Chosen by the forecast: the lowest error at the end
  // plus the worst on the way (the home fix and the field both count: a reversal can keep the end and double the
  // error mid-field, M16 20 -> 40 m); a near tie (0.5 m) goes to the simpler one — reversing is free, closing costs
  // path. {route, reversed, closed, fc, extraM, options}.
  function planVioRoute(home, route, speed) {
    if (!home || !route || route.length < 2) return null;
    const opts = [];
    for (const reversed of [false, true]) opts.push({ reversed, closed: false, route: reversed ? route.slice().reverse() : route });
    for (const o of opts.slice()) {
      const r = o.route, cp = closurePoint(toNE(home, r[0][0], r[0][1]), toNE(home, r[r.length - 1][0], r[r.length - 1][1]));
      if (cp) opts.push({ reversed: o.reversed, closed: true, route: [...r, fromNE(home, cp)] });
    }
    let best = null;
    const score = (o) => o.fc.end_m + o.fc.worst_m;
    for (const o of opts) {
      o.fc = crossingForecast(home, o.route, speed);
      if (!best || score(o) < score(best) - 0.5) best = o;
    }
    return Object.assign({}, best, { extraM: best.fc.path_m - opts[0].fc.path_m, options: opts });
  }

  // Does the segment a-b ([lat, lng]) touch the ring ([{lat, lng}…])? Local metric projection at a; a cut-out the
  // straight VIO transit flies over (it is not routed around them).
  function segmentHitsRing(a, b, ring) {
    if (!ring || ring.length < 3) return false;
    const kx = Math.cos(a[0] * rad), P = (p) => [(p.lng - a[1]) * kx, p.lat - a[0]];
    const B = [(b[1] - a[1]) * kx, b[0] - a[0]], A = [0, 0];
    const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const p = P(ring[i]), q = P(ring[j]);
      if ((p[1] > 0) !== (q[1] > 0) && 0 < (q[0] - p[0]) * (0 - p[1]) / (q[1] - p[1]) + p[0]) inside = !inside;
      const d1 = cross(p, q, A), d2 = cross(p, q, B), d3 = cross(A, B, p), d4 = cross(A, B, q);
      if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) return true;
    }
    return inside;
  }

  global.VIO_MODE = { haversineM, bearingDeg, compass8, relativeDeg, sideWord, nearestOnRing,
    routeSpan, reachM, driftWithin, originArgs, parseLatLon, VIO_FAMILY, VIO_ALARM, vioWarnings, vioAlertDue,
    MEASURED, measuredShare, measuredMaxPath, measuredReachM, segPenaltyS, missionTime, energy,
    legNeedM, shortLegs, splitSorties,
    AIRCRAFT_DRIFT, FORECAST_GATE_M, CLOSURE_M, toNE, fromNE, planError, routeFixes, forecastNE, crossingForecast,
    closurePoint, planVioRoute, segmentHitsRing,
    ENVELOPE_M, ENVELOPE_PLAN, ENVELOPE_UNCAL, ORIGIN_TOL_M: 8.0 };
})(typeof window !== "undefined" ? window : globalThis);
