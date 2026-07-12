"""Boustrophedon ("lawnmower") coverage path generation over a field polygon.

Approach:
  1. Project the field boundary to local metres around its centroid.
  2. Rotate the polygon by -angle so that sweep lines become horizontal.
  3. Scan horizontal lines spaced `spacing` metres apart, clip each to the
     polygon (handles concave fields -> multiple segments per line).
  4. Order the segments boustrophedon (reverse every other line) so the drone
     snakes back and forth instead of flying empty return legs.
  5. Rotate the resulting waypoints back by +angle and project to lat/lon.
"""
import math

from shapely.geometry import Polygon, LineString, MultiPolygon
from shapely.affinity import rotate
from shapely.ops import unary_union, split

from .geo import latlon_to_local, local_to_latlon, centroid, path_length, haversine


def _extract_segments(geom):
    """Flatten a shapely intersection result into a list of (p0, p1) segments."""
    segs = []
    if geom.is_empty:
        return segs
    gt = geom.geom_type
    if gt == "LineString":
        coords = list(geom.coords)
        if len(coords) >= 2:
            segs.append((coords[0], coords[-1]))
    elif gt in ("MultiLineString", "GeometryCollection"):
        for g in geom.geoms:
            segs.extend(_extract_segments(g))
    # Points / MultiPoint (line just grazing a vertex) are ignored.
    return segs


def _decluster(points, min_gap):
    """Drop points that bunch up within `min_gap` metres of the last kept point.

    A narrow corner / thin spike makes the sweep produce many micro-passes whose
    endpoints pile into one spot — a dense cluster of near-coincident waypoints
    that is useless to fly. Walking the ordered route and skipping points too
    close to the previously kept one collapses each cluster to a single point
    while leaving normal passes (>= spacing apart) untouched. First and last
    points are always kept so the route still starts/ends where it should.
    """
    if len(points) <= 2 or min_gap <= 0:
        return points
    kept = [points[0]]
    for p in points[1:-1]:
        lp = kept[-1]
        if math.hypot(p[0] - lp[0], p[1] - lp[1]) >= min_gap:
            kept.append(p)
    last = points[-1]
    if math.hypot(last[0] - kept[-1][0], last[1] - kept[-1][1]) > 1e-9:
        kept.append(last)
    return kept


def _ring_vertices(geom):
    """All boundary vertices (exterior + holes, every part) of a (Multi)Polygon."""
    parts = list(geom.geoms) if geom.geom_type == "MultiPolygon" else [geom]
    pts = []
    for p in parts:
        if p.is_empty:
            continue
        pts += list(p.exterior.coords)[:-1]
        for r in p.interiors:
            pts += list(r.coords)[:-1]
    return pts


def _vis_path(a, b, nodes, inside):
    """Shortest a→b path over the visibility graph of `nodes` where `inside(p,q)`
    says the straight leg p→q stays in free space. Dijkstra; falls back to the
    direct leg if no path is found."""
    import heapq
    V = [a, b] + list(nodes)
    n = len(V)
    INF = float("inf")
    dist = [INF] * n
    prev = [-1] * n
    dist[0] = 0.0
    pq = [(0.0, 0)]
    # cache edge validity lazily
    while pq:
        d, u = heapq.heappop(pq)
        if d > dist[u]:
            continue
        if u == 1:
            break
        ux, uy = V[u]
        for v in range(n):
            if v == u:
                continue
            vx, vy = V[v]
            w = math.hypot(ux - vx, uy - vy)
            if d + w >= dist[v]:
                continue
            if not inside(V[u], V[v]):
                continue
            dist[v] = d + w
            prev[v] = u
            heapq.heappush(pq, (dist[v], v))
    if dist[1] == INF:
        return [a, b]
    path, u = [], 1
    while u != -1:
        path.append(V[u])
        u = prev[u]
    path.reverse()
    return path


def _route_freespace(pts, free, clearance=1.0):
    """Reroute connector legs so the whole route stays INSIDE the field and
    OUTSIDE exclusions. `free` = field polygon minus exclusion holes (local m).
    Coverage passes are already clipped to `free`; this fixes the connecting legs
    that would cut across a concave notch (outside the contour) or an exclusion.
    """
    if len(pts) < 2 or free is None or free.is_empty:
        return pts
    free_ok = free.buffer(0.5)            # tolerance shell for boundary-following legs
    # Routing corners: simplified boundary (cap cost on dense OSM fields).
    simp = free
    tol = max(1.0, clearance)
    for _ in range(6):
        nodes = _ring_vertices(simp)
        if len(nodes) <= 200:
            break
        simp = free.simplify(tol)
        tol *= 2

    def inside(p, q):
        try:
            return free_ok.contains(LineString([p, q]))
        except Exception:
            return False

    out = [pts[0]]
    for a, b in zip(pts, pts[1:]):
        if inside(a, b):
            out.append(b)
            continue
        path = _vis_path(a, b, nodes, inside)
        out.extend(path[1:])
    return out


def _boustrophedon_cells(seg_rows):
    """Boustrophedon cellular decomposition.

    `seg_rows[r]` = the left->right coverage segments on sweep-row r. A cell
    continues from one row to the next ONLY on a clean 1-to-1 overlap; any split
    (a row opening around an obstacle) or merge (rows rejoining past it) ends the
    old cell(s) and starts new one(s). The result: each cell is a solid strip
    (one segment per row), so it can be snaked straight up/down with NO weaving
    around the obstacle every row — which was the source of double-coverage.
    Returns a list of cells; each cell is a list of (a, b) segments, bottom->top.
    """
    cells = []
    prev = []            # previous row's segments
    prev_cell = []       # the cell each prev segment belongs to (parallel list)
    for segs in seg_rows:
        cur_cell = [None] * len(segs)
        padj = [[] for _ in prev]
        cadj = [[] for _ in segs]
        for i, (pa, pb) in enumerate(prev):
            for j, (ca, cb) in enumerate(segs):
                if not (pb[0] < ca[0] or cb[0] < pa[0]):   # x-intervals overlap
                    padj[i].append(j)
                    cadj[j].append(i)
        for j, seg in enumerate(segs):
            m = cadj[j]
            if len(m) == 1 and len(padj[m[0]]) == 1:       # clean continuation
                cell = prev_cell[m[0]]
                cell.append(seg)
                cur_cell[j] = cell
            else:                                          # split / merge / new
                cell = [seg]
                cells.append(cell)
                cur_cell[j] = cell
        prev, prev_cell = segs, cur_cell
    return cells


def _snake_variants(cell):
    """The (up to) 4 boustrophedon traversals of a cell, one per entry corner.

    A solid strip can be snaked starting at any of its 4 corners: bottom- or
    top-row first, and that first row run left->right or right->left. Offering all
    four lets the chainer ENTER a cell at whichever corner is nearest the current
    position — e.g. enter a strip beside an obstacle at its TOP row when the route
    arrives from above, instead of diving to the bottom and back (the "down-jump"
    that double-covered the strip = wasted spray + time). Each variant still
    sweeps every row exactly once. Returns a list of point-lists.
    """
    rows = list(cell)
    out = []
    for bottom_first in (True, False):
        rseq = rows if bottom_first else rows[::-1]
        for left_first in (True, False):
            pts = []
            for k, (a, b) in enumerate(rseq):
                fwd = (a, b) if a[0] <= b[0] else (b, a)
                seg = fwd if (k % 2 == 0) == left_first else (fwd[1], fwd[0])
                pts.extend(seg)
            out.append(pts)
    return out


def _snake_variants_outback(cell):
    """Out-and-back row order: sweep EVEN rows outbound, then ODD rows on the way
    back, so the traversal ENDS adjacent to where it STARTED (the near edge). That
    is what lets the route begin AND finish next to the takeoff/anchor — cutting the
    dead RTL transit. Same pass + U-turn count; a few connector legs span 2× spacing
    at the fold. Falls back to the plain snake for <=2 rows. Same 4-corner variants."""
    rows = list(cell)
    if len(rows) <= 2:
        return _snake_variants(cell)
    n = len(rows)
    # even rows ascending, then odd rows descending -> route ends one row from start.
    idx = list(range(0, n, 2)) + list(range((n - 1) if (n - 1) % 2 else (n - 2), 0, -2))
    out = []
    for from_bottom in (True, False):
        src = rows if from_bottom else rows[::-1]
        seq = [src[i] for i in idx]
        for left_first in (True, False):
            pts = []
            for k, (a, b) in enumerate(seq):
                fwd = (a, b) if a[0] <= b[0] else (b, a)
                seg = fwd if (k % 2 == 0) == left_first else (fwd[1], fwd[0])
                pts.extend(seg)
            out.append(pts)
    return out


def _order_cells(cells, anchor=None, outback=False):
    """Chain the cells into one route with greedy nearest-neighbour hops. Start at
    the lowest cell; then repeatedly jump to the unvisited cell+entry-corner whose
    start point is nearest the current position. Allowing any of a cell's four
    corner traversals (not just an end-for-end flip) lets a strip beside an
    obstacle be entered from the near corner — killing the down-jump that used to
    re-cover it (measured ~57-60% less double-coverage on fields with exclusions,
    convex/concave fields unchanged). Points are in the rotated sweep frame.

    `anchor` (a point in the SAME rotated frame, or None) is the operator's
    takeoff / GPS: when given, the route STARTS at the cell+corner nearest it, so
    the lead-in transit (and thus flight time) is shortest. With `outback`, each
    cell is swept out-and-back so it also FINISHES near its start (≈ the anchor)."""
    vf = _snake_variants_outback if outback else _snake_variants
    variants = [vf(c) for c in cells if c]
    if not variants:
        return []
    used = [False] * len(variants)
    if anchor is not None:
        bk, bv, bd = 0, variants[0][0], None
        for k in range(len(variants)):
            for v in variants[k]:
                d = math.hypot(v[0][0] - anchor[0], v[0][1] - anchor[1])
                if bd is None or d < bd:
                    bk, bv, bd = k, v, d
        out = list(bv)
        used[bk] = True
    else:
        start = min(
            range(len(variants)),
            key=lambda k: (min(p[1] for p in variants[k][0]),
                           min(p[0] for p in variants[k][0])),
        )
        out = list(variants[start][0])
        used[start] = True
    pos = out[-1]
    for _ in range(len(variants) - 1):
        best, bpts, bd = -1, None, None
        for k in range(len(variants)):
            if used[k]:
                continue
            for pts in variants[k]:
                d = math.hypot(pos[0] - pts[0][0], pos[1] - pts[0][1])
                if bd is None or d < bd:
                    best, bpts, bd = k, pts, d
        out.extend(bpts)
        used[best] = True
        pos = out[-1]
    return out


def generate_coverage(boundary, spacing, angle_deg, exclusions=None, anchor=None,
                      start_finish_anchor=False):
    """Generate lawnmower waypoints covering a field.

    Args:
        boundary:  list of (lat, lon) field polygon vertices.
        spacing:   distance between adjacent sweep lines, metres.
        angle_deg: sweep heading in degrees (0 = lines run W->E, advancing N).

    Returns:
        list of (lat, lon) waypoints, in flight order.
    """
    if len(boundary) < 3:
        return []
    spacing = max(float(spacing), 0.5)

    lat0, lon0 = centroid(boundary)
    local = [latlon_to_local(lat, lon, lat0, lon0) for lat, lon in boundary]

    poly = Polygon(local)
    if not poly.is_valid:
        poly = poly.buffer(0)  # repair self-intersections
    # Subtract obstacle/exclusion polygons (trees, poles, ponds) so the coverage
    # route does not pass over them.
    if exclusions:
        ex = []
        for e in exclusions:
            if len(e) >= 3:
                ep = Polygon([latlon_to_local(la, lo, lat0, lon0) for la, lo in e])
                if not ep.is_valid:
                    ep = ep.buffer(0)
                if not ep.is_empty and ep.area > 0:
                    ex.append(ep)
        if ex:
            poly = poly.difference(unary_union(ex))
    if poly.is_empty or poly.area <= 0:
        return []

    # Rotate field so sweep lines are horizontal.
    rpoly = rotate(poly, -angle_deg, origin=(0, 0), use_radians=False)
    minx, miny, maxx, maxy = rpoly.bounds

    # Project the anchor (operator takeoff / GPS / chosen point) into this rotated
    # sweep frame so the route can begin at the field point nearest it.
    anchor_rot = None
    if anchor and len(anchor) == 2:
        ax, ay = latlon_to_local(float(anchor[0]), float(anchor[1]), lat0, lon0)
        c0, s0 = math.cos(math.radians(angle_deg)), math.sin(math.radians(angle_deg))
        anchor_rot = (ax * c0 + ay * s0, -ax * s0 + ay * c0)    # rotate by -angle_deg

    # Y positions of sweep lines. If the field is narrower than the spacing we
    # still want at least one pass, so fall back to a single centre line.
    # Passes are CENTRED to reach as close to the contour as the step allows, both edges
    # symmetric (Ivan "Б"): the remainder after fitting a whole number of uniform gaps is
    # split evenly, so the outermost pass sits only `leftover/2` inside each parallel edge
    # (instead of a fixed half-swath). The step is ALWAYS exactly `spacing` ("крок не
    # повинен мінятися"); a small floor keeps the outermost pass off the exact boundary so
    # its scan isn't degenerate. The swath then spills a little OUTSIDE the field (the
    # accepted cost of the route hugging the edge) — pull it in with the `margin` field.
    extent = maxy - miny
    if extent <= spacing:
        ys = [(miny + maxy) / 2.0]
    else:
        g = int(extent / spacing + 1e-9)            # whole uniform gaps that fit
        off = (extent - g * spacing) / 2.0          # centre the remainder
        if off < 0.5 and g >= 1:                    # outermost pass on the boundary → drop one gap
            g -= 1
            off = (extent - g * spacing) / 2.0
        ys = [miny + off + i * spacing for i in range(g + 1)]

    # Collect the left->right coverage segments per sweep-row, dropping only
    # DEGENERATE slivers (shorter than the gap) so corner micro-passes don't
    # become spurious cells. Keep the single longest raw segment as a fallback.
    min_gap = min(max(2.0, 0.25 * spacing), 0.5 * spacing)
    seg_rows = []
    longest = None
    for y in ys:
        scan = LineString([(minx - 10.0, y), (maxx + 10.0, y)])
        raw = []
        for a, b in _extract_segments(rpoly.intersection(scan)):
            if a[0] > b[0]:
                a, b = b, a
            length = math.hypot(b[0] - a[0], b[1] - a[1])
            if longest is None or length > longest[0]:
                longest = (length, (a, b))
            raw.append((a, b, length))
        norm = [(a, b) for (a, b, length) in raw if length >= min_gap]
        if not norm and raw:
            # Every segment on this sweep row is shorter than min_gap, yet the row
            # DOES cross the field — this is a genuine NARROW ARM (star/cross/E/T/
            # diagonal-protrusion fields), not a corner micro-sliver. Keep all of
            # its real segments so the arm is still sprayed instead of skipped.
            norm = [(a, b) for (a, b, length) in raw]
        norm.sort(key=lambda s: s[0][0])
        seg_rows.append(norm)

    # Boustrophedon CELLULAR decomposition: split into solid strips at obstacle
    # split/merge events and snake each strip whole, so the route never weaves
    # around an exclusion row-by-row (which double-covered the ground = wasted
    # spray + time). Cells are chained by nearest endpoint to keep transits short.
    # The route start is NOT pulled toward the take-off point (Ivan) — only the opt-in
    # "finish at the take-off" (start_finish_anchor) still uses the anchor, for its
    # deliberate out-and-back. Otherwise the snake starts at its natural corner.
    ordered_pts = _order_cells(_boustrophedon_cells(seg_rows),
                               anchor=(anchor_rot if start_finish_anchor else None),
                               outback=start_finish_anchor)
    if not ordered_pts and longest:
        # Whole field narrower than min_gap — keep the single longest pass.
        a, b = longest[1]
        ordered_pts = [a, b]

    # Rotate points back by +angle (CCW) to local metres.
    ca = math.cos(math.radians(angle_deg))
    sa = math.sin(math.radians(angle_deg))
    local_pts = [(x * ca - y * sa, x * sa + y * ca) for x, y in ordered_pts]

    # Keep the WHOLE path inside the field and outside exclusions: reroute any
    # connector leg that would cut across a concave notch (outside the contour)
    # or across an exclusion. `poly` is the field minus exclusions = free space.
    local_pts = _route_freespace(local_pts, poly, clearance=min(max(1.0, 0.1 * spacing), 5.0))

    # Collapse any point pile-ups (e.g. micro-passes at a thin spike) so the route has
    # no clustered waypoints — the centred pass placement can otherwise leave tiny gaps.
    local_pts = _decluster(local_pts, min_gap)

    return [local_to_latlon(x, y, lat0, lon0) for x, y in local_pts]


def polygon_area_ha(boundary):
    """Area of the field polygon in hectares."""
    if len(boundary) < 3:
        return 0.0
    lat0, lon0 = centroid(boundary)
    local = [latlon_to_local(lat, lon, lat0, lon0) for lat, lon in boundary]
    poly = Polygon(local)
    if not poly.is_valid:
        poly = poly.buffer(0)
    return poly.area / 10000.0


def covered_area_ha(boundary, exclusions=None):
    """Area actually sprayed — the field MINUS obstacle exclusions — in hectares.
    Uses the same exclusion subtraction as generate_coverage, so the number
    matches the route the drone flies."""
    if len(boundary) < 3:
        return 0.0
    lat0, lon0 = centroid(boundary)
    poly = Polygon([latlon_to_local(la, lo, lat0, lon0) for la, lo in boundary])
    if not poly.is_valid:
        poly = poly.buffer(0)
    if exclusions:
        ex = []
        for e in exclusions:
            if len(e) >= 3:
                ep = Polygon([latlon_to_local(la, lo, lat0, lon0) for la, lo in e])
                if not ep.is_valid:
                    ep = ep.buffer(0)
                if not ep.is_empty and ep.area > 0:
                    ex.append(ep)
        if ex:
            poly = poly.difference(unary_union(ex))
    if poly.is_empty or poly.area <= 0:
        return 0.0
    return poly.area / 10000.0


def _largest_polygon(geom):
    """Return the largest Polygon from a (Multi)Polygon, or None."""
    if geom is None or geom.is_empty:
        return None
    if geom.geom_type == "Polygon":
        return geom
    if geom.geom_type == "MultiPolygon":
        return max(geom.geoms, key=lambda g: g.area)
    return None


def inset_boundary(boundary, margin_m):
    """Shrink the field inward by `margin_m` metres (safety margin from edges).

    Returns the inset contour as [(lat, lon), ...], or None if the margin eats
    the whole field. margin_m <= 0 returns the boundary unchanged.
    """
    if len(boundary) < 3:
        return None
    if margin_m <= 0:
        return [(la, lo) for la, lo in boundary]

    lat0, lon0 = centroid(boundary)
    local = [latlon_to_local(la, lo, lat0, lon0) for la, lo in boundary]
    poly = Polygon(local)
    if not poly.is_valid:
        poly = poly.buffer(0)

    # A field with a narrow neck/waist/notch gets SPLIT by the inset, and keeping only
    # the largest piece silently SKIPS a big area (the other lobe is never covered).
    # Back the margin off until the inset stays in ONE connected piece, so the whole
    # field is covered (with a smaller safety gap only at the neck); fall back to the
    # largest lobe only if even a tiny inset still splits it (pathological shapes).
    m = float(margin_m)
    shrunk = poly.buffer(-m, join_style=2, mitre_limit=2.0)
    tries = 0
    while isinstance(shrunk, MultiPolygon) and len(shrunk.geoms) > 1 and m > 0.5 and tries < 14:
        m *= 0.6
        shrunk = poly.buffer(-m, join_style=2, mitre_limit=2.0)
        tries += 1
    shrunk = _largest_polygon(shrunk)
    if shrunk is None or shrunk.is_empty or shrunk.area <= 0:
        return None

    ext = list(shrunk.exterior.coords)
    if len(ext) >= 2 and ext[0] == ext[-1]:
        ext = ext[:-1]
    return [local_to_latlon(x, y, lat0, lon0) for (x, y) in ext]


def buffer_boundary(boundary, meters):
    """Grow (meters > 0) or shrink (meters < 0) the boundary by |meters| metres.

    Returns [(lat, lon), ...], or None if a shrink dissolves the field.
    meters == 0 returns the boundary unchanged. Used to apply the learned
    boundary bias to a detected field contour.
    """
    if len(boundary) < 3:
        return None
    if abs(meters) < 1e-9:
        return [(la, lo) for la, lo in boundary]

    lat0, lon0 = centroid(boundary)
    local = [latlon_to_local(la, lo, lat0, lon0) for la, lo in boundary]
    poly = Polygon(local)
    if not poly.is_valid:
        poly = poly.buffer(0)

    # join_style=2 (mitre) keeps corners SHARP. The default round join turns every
    # corner into an arc of ~8 near-coincident vertices — the "скруглення"/point
    # clusters we must avoid. mitre_limit bevels only impossibly-acute spikes.
    out = _largest_polygon(poly.buffer(float(meters), join_style=2, mitre_limit=2.0))
    if out is None or out.is_empty or out.area <= 0:
        return None
    ext = list(out.exterior.coords)
    if len(ext) >= 2 and ext[0] == ext[-1]:
        ext = ext[:-1]
    return [local_to_latlon(x, y, lat0, lon0) for (x, y) in ext]


def optimal_angle(boundary, spacing, step=5, exclusions=None, return_route=False,
                  anchor=None, start_finish_anchor=False):
    """Sweep heading (deg) giving the SHORTEST total coverage path.

    We actually generate the lawnmower route at each candidate heading and keep
    the one with the least flown distance. This is correct for concave/irregular
    fields (where a "fewest passes" heuristic can be worse), at the cost of
    running the sweep ~180/step times — fine for an explicit optimise action.

    The route is generated WITH the real `exclusions`, so the chosen heading is
    the one that's actually shortest around the obstacles (an exclusion-blind
    optimum can pick a heading that's longer once the holes are cut back in).
    With `return_route=True` it also returns the winning route, so the caller can
    reuse it instead of rebuilding the coverage a second time.
    """
    if len(boundary) < 3:
        return (0.0, None) if return_route else 0.0
    best_a, best_len, best_wps = 0.0, None, None
    for a in range(0, 180, step):
        wps = generate_coverage(boundary, spacing, float(a), exclusions=exclusions,
                                anchor=anchor, start_finish_anchor=start_finish_anchor)
        if not wps:
            continue
        length = path_length(wps)
        if best_len is None or length < best_len:
            best_len, best_a, best_wps = length, float(a), wps
    return (best_a, best_wps) if return_route else best_a


def split_route_by_time(waypoints, speed_mps, max_seconds, reserve=0.2):
    """Split a coverage route into separate flights, each within `max_seconds` of
    flying time (a fraction `reserve` is held back for take-off / return-to-home).
    Returns a list of waypoint sub-lists. One flight if it all fits."""
    if not waypoints or len(waypoints) < 2 or speed_mps <= 0 or max_seconds <= 0:
        return [list(waypoints)]
    budget = max_seconds * (1.0 - reserve)
    flights, cur, t = [], [waypoints[0]], 0.0
    for a, b in zip(waypoints, waypoints[1:]):
        seg = haversine(a[0], a[1], b[0], b[1]) / speed_mps
        if t + seg > budget and len(cur) >= 2:
            # End this flight at a; the NEXT flight RESUMES at a and re-flies the
            # a->b leg, so the segment is never dropped (drone returns home,
            # relaunches, flies back to a, continues). seg may exceed budget for
            # one very long leg — we still fly it rather than lose coverage.
            flights.append(cur)
            cur, t = [a, b], seg
        else:
            cur.append(b)
            t += seg
    if len(cur) >= 2:
        flights.append(cur)
    elif flights:                       # a lone trailing point joins the last flight
        flights[-1].append(cur[-1])
    return flights


# Default vehicle dynamics — ArduCopter WPNAV factory defaults (m/s, m/s²). These
# MUST stay in sync with the JS mirror in web-stable/app.js (estimateMissionTime); a
# cross-check test asserts the two agree.
TAKEOFF_CLIMB_RATE = 2.5     # WPNAV_SPEED_UP 250 cm/s
LAND_DESCENT_RATE = 1.5      # WPNAV_SPEED_DN 150 cm/s
WP_ACCEL = 2.5               # WPNAV_ACCEL 250 cm/s²


def estimate_mission_time(waypoints, home, *, wp_alt=0.0, takeoff_alt=None,
                          speed=12.0, transit_speed=None,
                          climb_rate=TAKEOFF_CLIMB_RATE,
                          descent_rate=LAND_DESCENT_RATE, accel=WP_ACCEL,
                          turn_penalty_s=None, rtl=True, cal=None):
    """Realistic mission flight-time estimate, broken into phases.

    Unlike a naive path_length / speed, this accounts for:
      * takeoff climb to mission altitude (takeoff_alt / climb_rate),
      * the lead-in transit home -> first waypoint,
      * coverage cruise (waypoint-to-waypoint at the spray `speed`),
      * deceleration/acceleration lost at each turn — scaled by how sharp it is
        (≈0 on a straight pass, ≈ speed/accel at a 180° U-turn end-of-pass),
      * RTL transit back to home + the landing descent (wp_alt / descent_rate).

    `cal` is an optional calibration dict from logged real flights (flight_calib):
    its `time_mult` median(actual/planned) scales the whole estimate so it tracks
    THIS operator's drone. Returns a phase breakdown plus `total_s`.
    """
    speed = max(float(speed), 0.1)
    transit_speed = max(float(transit_speed or speed), 0.1)
    wp_alt = float(wp_alt or 0.0)
    takeoff_alt = float(takeoff_alt if takeoff_alt is not None else wp_alt)
    climb_rate = max(float(climb_rate), 0.1)
    descent_rate = max(float(descent_rate), 0.1)
    accel = max(float(accel), 0.1)

    res = {"takeoff_s": 0.0, "transit_s": 0.0, "cruise_s": 0.0, "turn_s": 0.0,
           "rtl_s": 0.0, "descent_s": 0.0, "total_s": 0.0, "time_mult": 1.0}
    wps = [(float(p[0]), float(p[1])) for p in (waypoints or [])]
    if not wps:
        return res

    res["takeoff_s"] = takeoff_alt / climb_rate

    if home is not None:
        res["transit_s"] = haversine(home[0], home[1], wps[0][0], wps[0][1]) / transit_speed

    cruise_len = 0.0
    for a, b in zip(wps, wps[1:]):
        cruise_len += haversine(a[0], a[1], b[0], b[1])
    res["cruise_s"] = cruise_len / speed

    # Turn penalty: time lost slowing into and out of each interior corner. A full
    # 180° reversal costs ~speed/accel; a straight-through vertex costs ~0.
    if len(wps) >= 3:
        lat0, lon0 = (home[0], home[1]) if home is not None else centroid(wps)
        pts = [latlon_to_local(la, lo, lat0, lon0) for la, lo in wps]
        full_stop = speed / accel
        per = float(turn_penalty_s) if turn_penalty_s is not None else full_stop
        total_turn = 0.0
        for i in range(1, len(pts) - 1):
            ax, ay = pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]
            bx, by = pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]
            na, nb = math.hypot(ax, ay), math.hypot(bx, by)
            if na < 1e-6 or nb < 1e-6:
                continue
            cosang = max(-1.0, min(1.0, (ax * bx + ay * by) / (na * nb)))
            turn = math.acos(cosang) / math.pi      # 0 = straight, 1 = U-turn
            total_turn += turn * per
        res["turn_s"] = total_turn

    if rtl and home is not None:
        res["rtl_s"] = haversine(wps[-1][0], wps[-1][1], home[0], home[1]) / transit_speed
        res["descent_s"] = wp_alt / descent_rate

    total = (res["takeoff_s"] + res["transit_s"] + res["cruise_s"]
             + res["turn_s"] + res["rtl_s"] + res["descent_s"])

    mult = 1.0
    if isinstance(cal, dict):
        try:
            mult = float(cal.get("time_mult") or 1.0)
        except (TypeError, ValueError):
            mult = 1.0
        if not (0.2 <= mult <= 5.0):     # guard against a wild calibration value
            mult = 1.0
    res["time_mult"] = mult
    res["total_s"] = total * mult
    return res


def split_route_by_area(waypoints, spacing, n_sections):
    """Split a coverage route into `n_sections` sub-routes of ~equal sprayed AREA.

    Area per leg ≈ leg_length × spacing (the swath). Sections are cut when the
    accumulated area reaches the per-section share (total / n); each new section
    RESUMES at the cut point, so coverage is continuous with no gap and no
    re-flown overlap. The last section takes the remainder. Each section is meant
    to be flown as its own flight (take off near the anchor, cover, return).
    Returns a list of waypoint sub-lists (one if n<=1 or the route is trivial)."""
    wps = [(float(p[0]), float(p[1])) for p in (waypoints or [])]
    n = int(n_sections)
    if len(wps) < 2 or n <= 1:
        return [wps]
    swath = max(float(spacing), 0.1)
    legs = [haversine(a[0], a[1], b[0], b[1]) * swath for a, b in zip(wps, wps[1:])]
    total = sum(legs)
    if total <= 0:
        return [wps]
    # Cut at GLOBAL cumulative-area boundaries k*total/n (not per-section resets),
    # so quantization error doesn't accumulate and the sections stay near-equal.
    flights, cur, cum, k = [], [wps[0]], 0.0, 1
    for i, b in enumerate(wps[1:]):
        cur.append(b)
        cum += legs[i]
        if k < n and cum >= total * k / n and len(cur) >= 2 and i < len(wps) - 2:
            flights.append(cur)
            cur = [b]                       # next section resumes at the cut point
            k += 1
    if len(cur) >= 2:
        flights.append(cur)
    elif flights:
        flights[-1].append(cur[-1])
    return flights


def _free_polygon(boundary, exclusions=None):
    """Field polygon minus exclusions, as a shapely geometry in LOCAL metres around
    the field centroid. Returns (geom_or_None, lat0, lon0). Same projection +
    exclusion subtraction as generate_coverage / covered_area_ha."""
    if len(boundary) < 3:
        return None, 0.0, 0.0
    lat0, lon0 = centroid(boundary)
    poly = Polygon([latlon_to_local(la, lo, lat0, lon0) for la, lo in boundary])
    if not poly.is_valid:
        poly = poly.buffer(0)
    if exclusions:
        ex = []
        for e in exclusions:
            if len(e) >= 3:
                ep = Polygon([latlon_to_local(la, lo, lat0, lon0) for la, lo in e])
                if not ep.is_valid:
                    ep = ep.buffer(0)
                if not ep.is_empty and ep.area > 0:
                    ex.append(ep)
        if ex:
            poly = poly.difference(unary_union(ex))
    if poly.is_empty or poly.area <= 0:
        return None, lat0, lon0
    return poly, lat0, lon0


def coverage_metrics(waypoints, boundary, exclusions=None, spacing=20.0):
    """Coverage quality of a route over a field (pure shapely, runs in Pyodide):
      coverage_pct = % of the field (minus exclusions) within a swath of the path;
      overlap_pct  = double-covered fraction (summed swath area − area actually
                     covered) as a % of the field. Lower overlap = less waste."""
    free, lat0, lon0 = _free_polygon(boundary, exclusions)
    if free is None or len(waypoints) < 2:
        return {"coverage_pct": 0.0, "overlap_pct": 0.0}
    local = [latlon_to_local(la, lo, lat0, lon0) for la, lo in waypoints]
    swath = max(float(spacing), 0.5)
    band = LineString(local).buffer(swath / 2.0, cap_style=2)    # flat-capped swath
    covered = band.intersection(free).area
    sum_swaths = 0.0
    for a, b in zip(local, local[1:]):
        sum_swaths += math.hypot(b[0] - a[0], b[1] - a[1]) * swath
    farea = free.area
    if farea <= 0:
        return {"coverage_pct": 0.0, "overlap_pct": 0.0}
    cov = 100.0 * covered / farea
    ov = 100.0 * max(0.0, sum_swaths - covered) / farea
    return {"coverage_pct": round(min(100.0, cov), 1), "overlap_pct": round(ov, 1)}


def split_field_by_line(boundary, split_line, exclusions=None):
    """Split a field polygon by an operator-drawn line into sub-polygons (sectors),
    each meant to be covered as its own flight (and later: its own drone).

    The line is EXTENDED beyond the field's bbox so it crosses edge-to-edge —
    shapely.ops.split only cuts on a FULL crossing. Returns a list of sector
    boundaries [[(lat,lon),...], ...]; a single-entry list (the whole field) when
    the line does not actually divide it. `exclusions` are untouched — each sector
    subtracts them at coverage time."""
    if len(boundary) < 3 or not split_line or len(split_line) < 2:
        return [list(boundary)]
    lat0, lon0 = centroid(boundary)
    poly = Polygon([latlon_to_local(la, lo, lat0, lon0) for la, lo in boundary])
    if not poly.is_valid:
        poly = poly.buffer(0)
    if poly.is_empty or poly.area <= 0:
        return [list(boundary)]
    pts = []                                  # project + drop consecutive duplicates
    for la, lo in split_line:
        p = latlon_to_local(la, lo, lat0, lon0)
        if not pts or math.hypot(p[0] - pts[-1][0], p[1] - pts[-1][1]) > 1e-6:
            pts.append(p)
    if len(pts) < 2:
        return [list(boundary)]
    minx, miny, maxx, maxy = poly.bounds
    ext = 2.0 * (math.hypot(maxx - minx, maxy - miny) or 1.0)

    def _stretch(inner, outer):               # push `outer` further out along inner->outer
        dx, dy = outer[0] - inner[0], outer[1] - inner[1]
        n = math.hypot(dx, dy) or 1.0
        return (outer[0] + dx / n * ext, outer[1] + dy / n * ext)

    pts[0] = _stretch(pts[1], pts[0])
    pts[-1] = _stretch(pts[-2], pts[-1])
    try:
        pieces = split(poly, LineString(pts))
    except Exception:
        return [list(boundary)]
    sectors = []
    for g in getattr(pieces, "geoms", [pieces]):
        if g.geom_type == "Polygon" and g.area > 1.0:   # drop sub-1 m² slivers
            ring = list(g.exterior.coords)
            if len(ring) >= 2 and ring[0] == ring[-1]:
                ring = ring[:-1]
            sectors.append([local_to_latlon(x, y, lat0, lon0) for x, y in ring])
    if len(sectors) < 2:
        return [list(boundary)]
    # stable sector numbering by centroid (lon then lat)
    sectors.sort(key=lambda s: (sum(p[1] for p in s) / len(s), sum(p[0] for p in s) / len(s)))
    return sectors


def mission_overlap(home, waypoints, spacing, boundary=None, rtl=True):
    """TRUE spray overlap for an ALWAYS-ON sprayer (sprays from takeoff to landing).
    The drone sprays the ENTIRE flown path — the lead-in home->first-wp, every pass,
    every connector AND the RTL back home. So the real waste is where the path flies
    over ground it already sprayed.

    Buffers the WHOLE flown polyline by half a swath: its area = ground covered at
    least once (shapely merges overlaps), while Σ(leg×swath) counts re-flights, so
    overlap = Σ − union. `outside_ha` is spray that lands outside the field (lead-in
    / RTL beyond the field edge). Lower overlap = less double-spray AND less time."""
    wps = [(float(p[0]), float(p[1])) for p in (waypoints or [])]
    if len(wps) < 2:
        return {"sprayed_ha": 0.0, "overlap_ha": 0.0, "overlap_pct": 0.0, "outside_ha": 0.0}
    lat0, lon0 = float(home[0]), float(home[1])
    path = [(lat0, lon0)] + wps + ([(lat0, lon0)] if rtl else [])
    local = [latlon_to_local(la, lo, lat0, lon0) for la, lo in path]
    swath = max(float(spacing), 0.5)
    band = LineString(local).buffer(swath / 2.0, cap_style=2)     # flat-capped swath
    union_area = band.area
    sum_swaths = 0.0
    for a, b in zip(local, local[1:]):
        sum_swaths += math.hypot(b[0] - a[0], b[1] - a[1]) * swath
    overlap = max(0.0, sum_swaths - union_area)
    res = {"sprayed_ha": round(union_area / 1e4, 3),
           "overlap_ha": round(overlap / 1e4, 3),
           "overlap_pct": round(100.0 * overlap / union_area, 1) if union_area > 0 else 0.0,
           "outside_ha": 0.0}
    if boundary and len(boundary) >= 3:
        fpoly = Polygon([latlon_to_local(la, lo, lat0, lon0) for la, lo in boundary])
        if not fpoly.is_valid:
            fpoly = fpoly.buffer(0)
        if not fpoly.is_empty and fpoly.area > 0:
            res["outside_ha"] = round(max(0.0, band.area - band.intersection(fpoly).area) / 1e4, 3)
    return res


def flown_path_length(home, waypoints, rtl=True):
    """Total distance actually FLOWN (and sprayed): the take-off lead-in
    home→first-waypoint, the passes + connectors, and the RTL last-waypoint→home.
    Flight time is proportional to this, so the auto-heading minimizes THIS rather than
    the bare pass length — the take-off run and the return leg are counted too (Ivan)."""
    wps = waypoints or []
    if len(wps) < 1:
        return 0.0
    h0, h1 = float(home[0]), float(home[1])
    d = haversine(h0, h1, wps[0][0], wps[0][1]) + path_length(wps)
    if rtl:
        d += haversine(wps[-1][0], wps[-1][1], h0, h1)
    return d


def coverage_overlap_geo(home, waypoints, spacing, rtl=True, max_segments=900):
    """Map-overlay geometry for the spray footprint. An always-on sprayer paints a
    swath of width ≈ spacing along the WHOLE flown path; this returns that swept band
    as `coverage`, and the ground it sprays a SECOND time (turns, lead-in, RTL, passes
    that run too close) as `overlap` — each a list of lat/lng rings the UI fills in
    different colours. Overlap is found in ~O(n): sweep the path and intersect every
    segment's swath with the union of the swaths already laid down."""
    wps = [(float(p[0]), float(p[1])) for p in (waypoints or [])]
    if len(wps) < 2:
        return {"coverage": [], "overlap": []}
    lat0, lon0 = float(home[0]), float(home[1])
    path = [(lat0, lon0)] + wps + ([(lat0, lon0)] if rtl else [])
    local = [latlon_to_local(la, lo, lat0, lon0) for la, lo in path]
    r = max(float(spacing), 0.5) / 2.0
    band = LineString(local).buffer(r, cap_style=2)            # the whole swept swath

    overlap_geom = None
    segs = [LineString([a, b]).buffer(r, cap_style=2) for a, b in zip(local, local[1:])]
    if 0 < len(segs) <= max_segments:
        laid = None                       # union of swaths laid down so far
        parts = []
        for s in segs:
            if laid is not None:
                x = s.intersection(laid)
                if (not x.is_empty) and x.area > 0.25:          # drop sub-0.25 m² slivers
                    parts.append(x)
                laid = laid.union(s)
            else:
                laid = s
        if parts:
            try:
                overlap_geom = unary_union(parts)
            except Exception:
                overlap_geom = None

    def rings(geom):
        if geom is None or geom.is_empty:
            return []
        polys = list(geom.geoms) if geom.geom_type == "MultiPolygon" else [geom]
        out = []
        for p in polys:
            if p.is_empty or p.area <= 0:
                continue
            ring = []
            for x, y in p.exterior.coords:
                la, lo = local_to_latlon(x, y, lat0, lon0)
                ring.append({"lat": la, "lng": lo})
            out.append(ring)
        return out
    return {"coverage": rings(band), "overlap": rings(overlap_geom)}


def overlap_optimal_angle(cover, spacing, home, field_boundary=None, exclusions=None,
                          anchor=None, step=2, return_route=False, rtl=True, speed=12.0):
    """Sweep heading (deg) giving the LEAST true spray overlap for an ALWAYS-ON
    sprayer. Unlike optimal_angle (which minimizes pass LENGTH), this scores each
    candidate by mission_overlap over the FULL flown path (lead-in + passes +
    connectors + RTL) — where almost all the double-spray actually comes from,
    because the lead-in/RTL geometry depends on the sweep heading. Measured ~-46%
    overlap vs min-path on the benchmark fields, for ~+1% time.

    `cover` = the (already-inset) area the passes run on; `field_boundary` = the
    real field, scored for overlap; `home`/`anchor` are (lat,lon). step=2 is the
    validated sweet spot (step=1 is ~equal for 2x compute). With return_route the
    winning route is returned too (no rebuild)."""
    if not cover or len(cover) < 3:
        return (0.0, None) if return_route else 0.0
    fb = field_boundary if (field_boundary and len(field_boundary) >= 3) else cover
    a0 = anchor if anchor is not None else home
    # THE ONLY criterion is MINIMUM MISSION TIME (Ivan, Variant A: "рахуєш лише час").
    # For each heading score ONLY the time = take-off climb + coverage cruise along the
    # passes + the decel/accel lost at each turn + landing descent. ZLIT (take-off) and
    # POSADKA (landing) ARE counted ("зліт і посадка повинні бути") — they're equal for
    # every heading so they don't bias it; the lead-in (home→first) and RTL (last→home)
    # are EXCLUDED so the heading is never tilted just to bring the start/finish near the
    # take-off. Coverage is NOT scored and there is NO gate — the fastest heading wins
    # outright (it may tilt a few degrees and leave small edge slivers on some fields).
    cands = []
    for a in range(0, 180, max(1, int(step))):
        wps = generate_coverage(cover, spacing, float(a), exclusions=exclusions, anchor=a0)
        if not wps or len(wps) < 2:
            continue
        e = estimate_mission_time(wps, home, speed=speed, rtl=rtl)
        t = e["takeoff_s"] + e["cruise_s"] + e["turn_s"] + e["descent_s"]
        cands.append((float(a), wps, t))
    if not cands:
        return (0.0, None) if return_route else 0.0
    best = min(cands, key=lambda c: c[2])
    return (best[0], best[1]) if return_route else best[0]


def finish_home_angle(cover, spacing, home, field_boundary=None, exclusions=None,
                      anchor=None, step=2, return_route=False, rtl=True, near_factor=3.0):
    """Least-overlap heading that ALSO makes the route FINISH near `home`, so the
    drone returns to the takeoff with NO dead RTL re-spray — the spirit of "the
    return should be part of coverage". Among every heading AND each route's two
    directions, pick the min-overlap candidate whose finish is within
    near_factor*spacing of home; fall back to the global overlap optimum if none
    qualifies. Because a snake that naturally ENDS near home has no overlapping
    return leg, this costs only ~+0.6pp overlap vs the unconstrained optimum — far
    better than the old out-and-back (~+16pp). Returns (angle, [route]) like above."""
    if not cover or len(cover) < 3:
        return (0.0, None) if return_route else 0.0
    fb = field_boundary if (field_boundary and len(field_boundary) >= 3) else cover
    a0 = anchor if anchor is not None else home
    thr = near_factor * max(float(spacing), 0.5)
    glob, near = None, None
    for a in range(0, 180, max(1, int(step))):
        wps = generate_coverage(cover, spacing, float(a), exclusions=exclusions, anchor=a0)
        if not wps or len(wps) < 2:
            continue
        for cand in (wps, wps[::-1]):
            ov = mission_overlap(home, cand, spacing, fb, rtl=rtl)["overlap_pct"]
            key = (ov, path_length(cand))
            if glob is None or key < glob[0]:
                glob = (key, float(a), cand)
            fin = haversine(home[0], home[1], cand[-1][0], cand[-1][1])
            if fin < thr and (near is None or key < near[0]):
                near = (key, float(a), cand)
    pick = near if near is not None else glob
    return (pick[1], pick[2]) if return_route else pick[1]


def _project_to_ring(P, ring):
    """Nearest point on the closed polygon boundary `ring` (open list of local pts)
    to point P. Returns (dist, foot, edge_index) or None."""
    n = len(ring)
    best = None
    for i in range(n):
        a, c = ring[i], ring[(i + 1) % n]
        ex, ey = c[0] - a[0], c[1] - a[1]
        elen = math.hypot(ex, ey)
        if elen < 1e-9:
            continue
        ux, uy = ex / elen, ey / elen
        t = max(0.0, min(elen, (P[0] - a[0]) * ux + (P[1] - a[1]) * uy))
        foot = (a[0] + ux * t, a[1] + uy * t)
        d = math.hypot(P[0] - foot[0], P[1] - foot[1])
        if best is None or d < best[0]:
            best = (d, foot, i)
    return best


def _dedupe_ll(pts, tol_m=0.3):
    out = []
    for p in pts:
        if not out or haversine(out[-1][0], out[-1][1], p[0], p[1]) > tol_m:
            out.append(p)
    return out


def return_corridor_route(cover, spacing, home, field_boundary=None, exclusions=None,
                          anchor=None, step=2, return_route=False, rtl=True):
    """Least-overlap snake whose RETURN to `home` is a PRODUCTIVE spray pass ending
    EXACTLY at the takeoff point — not a dead RTL, and not merely "the snake happens
    to end near home" (the rejected finish_home_angle).

    The engine insets the field by ~spacing/2 before covering, so the snake never
    touches a thin bare strip around the field edge. We turn that wasted edge strip
    INTO the return: cover the interior with the validated least-true-overlap heading
    (overlap_optimal_angle, anchored to START near home so the lead-in is short),
    then walk the bare perimeter the SHORTER way round from the snake's end to the
    edge point nearest home and into home. Every metre of that tail lays
    previously-UNsprayed edge ground and the route finishes at home (finish ~0 m).
    Benchmarked ~5.1% true overlap (below even the plain overlap optimum) at ~equal
    time over the bench fields — the operator-chosen "min-overlap productive return".

    `cover` = the already-inset pass area; `field_boundary` = the REAL field whose
    edge strip the tail sprays. Returns (angle, route) when return_route else angle."""
    if not cover or len(cover) < 3:
        return (0.0, None) if return_route else 0.0
    fb = field_boundary if (field_boundary and len(field_boundary) >= 3) else cover
    a0 = anchor if anchor is not None else home
    ang, wps = overlap_optimal_angle(cover, spacing, home, field_boundary=fb,
                                     exclusions=exclusions, anchor=a0, step=step,
                                     return_route=True, rtl=rtl)
    hlat, hlon = home[0], home[1]

    def _finish(route):
        out = list(route or [])
        if out and haversine(out[-1][0], out[-1][1], hlat, hlon) > 1.0:
            out.append((hlat, hlon))
        return _dedupe_ll(out)

    if not wps or len(wps) < 2:
        return (ang, _finish(wps) or None) if return_route else ang

    lat0, lon0 = centroid(fb)
    poly = Polygon([latlon_to_local(la, lo, lat0, lon0) for la, lo in fb])
    if not poly.is_valid:
        poly = poly.buffer(0)
    if isinstance(poly, MultiPolygon):
        poly = max(poly.geoms, key=lambda g: g.area) if not poly.is_empty else poly
    if poly.is_empty or poly.area <= 0:
        return (ang, _finish(wps)) if return_route else ang
    ring = list(poly.exterior.coords)
    if len(ring) >= 2 and ring[0] == ring[-1]:
        ring = ring[:-1]
    n = len(ring)
    if n < 3:
        return (ang, _finish(wps)) if return_route else ang

    end_loc = latlon_to_local(wps[-1][0], wps[-1][1], lat0, lon0)
    H = latlon_to_local(hlat, hlon, lat0, lon0)
    fe = _project_to_ring(end_loc, ring)     # snake end -> nearest edge foot
    fh = _project_to_ring(H, ring)           # home -> nearest edge foot
    if fe is None or fh is None:
        return (ang, _finish(wps)) if return_route else ang

    # Pull edge points slightly toward the centroid so the tail's flat-capped swath
    # stays inside the field rather than spilling over the boundary.
    cx, cy = poly.centroid.x, poly.centroid.y
    inset_d = min(max(float(spacing), 0.5) * 0.5, 3.0)

    def _pull(foot):
        dx, dy = cx - foot[0], cy - foot[1]
        nrm = math.hypot(dx, dy) or 1.0
        return (foot[0] + dx / nrm * inset_d, foot[1] + dy / nrm * inset_d)

    # Walk boundary vertices from fe's edge to fh's edge the SHORTER way round, so
    # the tail hugs the near perimeter (all inset-bare = new ground) toward home.
    ie, ih = fe[2], fh[2]
    fwd, i = [], (ie + 1) % n
    for _ in range(n + 1):
        fwd.append(i)
        if i == ih:
            break
        i = (i + 1) % n
    bwd, i = [], ie
    for _ in range(n + 1):
        bwd.append(i)
        if i == ih:
            break
        i = (i - 1) % n
    seq = fwd if len(fwd) <= len(bwd) else bwd

    tail = [_pull(fe[1])]
    for vi in seq:
        if vi == ih:
            break
        tail.append(_pull(ring[vi]))
    tail.append(_pull(fh[1]))
    tail_ll = [local_to_latlon(x, y, lat0, lon0) for x, y in tail]
    out = list(wps) + tail_ll + [(hlat, hlon)]
    return (ang, _dedupe_ll(out)) if return_route else ang
