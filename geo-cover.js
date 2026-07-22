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
  // covered_ha: complete → the planned field area; partial → distance × swath, capped at area.
  function coveredHa(o) {
    if (o.covComplete) return o.areaHa || 0;
    if (!o.swathM || o.swathM <= 0) return null;         // unknown swath → «—», never divide/zero
    const d = o.distM == null ? 0 : o.distM;
    const raw = d * o.swathM / 1e4;
    return o.areaHa > 0 ? Math.min(raw, o.areaHa) : raw;  // cap at field area when known
  }
  global.GEO_COVER = { haversineM, pointInRing, distInField, coveredHa, coverageCompletion };
})(typeof window !== "undefined" ? window : globalThis);
