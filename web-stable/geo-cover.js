/* Pure covered-area geometry, shared by app.js (window.GEO_COVER) and test_geocover.mjs.
 * NO DOM. Ring vertices are {lat,lng} (Leaflet field ring); telemetry samples are {lat,lon}. */
(function (global) {
  "use strict";
  const R = 6371000;                       // mean Earth radius, metres
  function haversineM(aLat, aLon, bLat, bLon) {
    const rad = Math.PI / 180;
    const dLat = (bLat - aLat) * rad, dLon = (bLon - aLon) * rad;
    const la1 = aLat * rad, la2 = bLat * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  // Ray-cast point-in-polygon. lon is the sample's X; ring vertices read .lng as X, .lat as Y.
  function pointInRing(lat, lon, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const yi = ring[i].lat, xi = ring[i].lng, yj = ring[j].lat, xj = ring[j].lng;
      const hit = ((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi);
      if (hit) inside = !inside;
    }
    return inside;
  }
  // Sum of track-segment lengths whose BOTH endpoints lie inside the ring. null ring (<3) → null.
  function distInField(samples, ring) {
    if (!ring || ring.length < 3) return null;
    let d = 0;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1], b = samples[i];
      if (a.lat == null || b.lat == null) continue;
      if (pointInRing(a.lat, a.lon, ring) && pointInRing(b.lat, b.lon, ring)) {
        d += haversineM(a.lat, a.lon, b.lat, b.lon);
      }
    }
    return d;
  }
  // Mission-completion decision (spec §8). lastCoverageSeq excludes lead + trailing RTL.
  function coverageCompletion(o) {
    const wt = o.wpTotal || 0, wr = o.wpReached || 0;
    const lastCoverageSeq = wt - 1 - (o.hasRtl ? 1 : 0);
    const compFrac = lastCoverageSeq > 0 ? Math.min(1, wr / lastCoverageSeq) : 0;
    const covComplete = !!o.sawComplete || (lastCoverageSeq > 0 && wr >= lastCoverageSeq) || compFrac >= 0.90;
    return { covComplete: covComplete, compFrac: compFrac, completionPct: Math.round(compFrac * 100) };
  }
  // "Reached the last waypoint" only proves the UPLOADED list finished — a short test hop or a
  // battery-swap REMAINDER also ends on its own last WP. Crediting the whole field for that gave
  // 51 га за 3 хвилини (field report). Full credit needs the flown distance to plausibly cover
  // the field: distance×swath ≥ 60% of the area (no swath info → trust the complete flag, legacy).
  function fullCreditOk(o) {
    if (!o.covComplete) return false;
    if (!(o.areaHa > 0)) return true;
    if (!o.swathM || o.swathM <= 0) return true;
    const dz = (o.distM == null ? 0 : o.distM) * o.swathM / 1e4;
    return dz >= 0.6 * o.areaHa;
  }
  // covered_ha: plausibly-complete → the planned field area; otherwise distance × swath, capped.
  function coveredHa(o) {
    if (fullCreditOk(o)) return o.areaHa || 0;
    if (!o.swathM || o.swathM <= 0) return null;         // unknown swath → «—», never divide/zero
    const d = o.distM == null ? 0 : o.distM;
    const raw = d * o.swathM / 1e4;
    return o.areaHa > 0 ? Math.min(raw, o.areaHa) : raw;  // cap at field area when known
  }
  // Apply a finished flight's coverage to a field record's cycle counters (pure, returns a copy).
  // complete → increment completed_count and reset the cycle (done_ha=0); partial → accumulate done_ha.
  function applyFieldCredit(rec, coveredHa, covComplete) {
    const out = Object.assign({}, rec);
    if (covComplete) { out.completed_count = (out.completed_count | 0) + 1; out.done_ha = 0; }
    else { out.done_ha = (+out.done_ha || 0) + (coveredHa || 0); }
    return out;
  }
  // ---- relief limit zones (#13-доопрацювання: небезпеки не лише з OSM) --------------------
  // Convex hull (Andrew monotone chain) over {lat,lng} points; lng plays x, lat plays y.
  function _hull(pts) {
    const p = pts.slice().sort((a, b) => (a.lng - b.lng) || (a.lat - b.lat));
    if (p.length <= 2) return p;
    const cross = (o, a, b) => (a.lng - o.lng) * (b.lat - o.lat) - (a.lat - o.lat) * (b.lng - o.lng);
    const lo = [], up = [];
    for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    lo.pop(); up.pop();
    return lo.concat(up);
  }
  // Zones where the SURFACE (Copernicus ~90 м DSM via the elevation API) rises to within
  // `limit` metres of the flight plane: elev - ref >= limit. Grid is row-major (idx = iy*nx+ix),
  // cells with elev == null are ignored. 4-connected hot cells cluster into zones; each ring is
  // the hull of member cell centers inflated by half a grid step. Coarse data by design — this
  // catches hills/ridges/forest bulks, NOT individual poles (the UI must say so).
  function reliefZones(o) {
    const nx = o.nx, ny = o.ny, pts = o.pts, thr = o.limit;
    const hLat = o.halfLatDeg || 0, hLng = o.halfLngDeg || 0;
    const hot = new Array(nx * ny).fill(false);
    let maxDz = null, worst = null;
    for (let i = 0; i < nx * ny; i++) {
      const p = pts[i]; if (!p || p.elev == null) continue;
      const dz = p.elev - o.ref;
      if (maxDz == null || dz > maxDz) { maxDz = dz; worst = { lat: p.lat, lng: p.lng, dz: dz }; }
      if (dz >= thr) hot[i] = true;
    }
    const seen = new Array(nx * ny).fill(false);
    const zones = [];
    for (let s = 0; s < nx * ny; s++) {
      if (!hot[s] || seen[s]) continue;
      const cells = [], q = [s]; seen[s] = true;
      while (q.length) {
        const c = q.pop(); cells.push(c);
        const cx = c % nx, cy = (c / nx) | 0;
        [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach((d) => {
          const x = cx + d[0], y = cy + d[1];
          if (x < 0 || y < 0 || x >= nx || y >= ny) return;
          const j = y * nx + x;
          if (hot[j] && !seen[j]) { seen[j] = true; q.push(j); }
        });
      }
      let zMax = null;
      const corners = [];
      cells.forEach((c) => {
        const p = pts[c], dz = p.elev - o.ref;
        if (zMax == null || dz > zMax) zMax = dz;
        [[1, 1], [1, -1], [-1, 1], [-1, -1]].forEach((sgn) =>
          corners.push({ lat: p.lat + sgn[1] * hLat, lng: p.lng + sgn[0] * hLng }));
      });
      const ring = _hull(corners);
      if (ring.length >= 3) zones.push({ ring: ring, maxDz: zMax, cells: cells.length });
    }
    return { zones: zones, maxDz: maxDz, worst: worst };
  }
  global.GEO_COVER = { haversineM, pointInRing, distInField, coveredHa, coverageCompletion, applyFieldCredit, fullCreditOk, reliefZones };
})(typeof window !== "undefined" ? window : globalThis);
