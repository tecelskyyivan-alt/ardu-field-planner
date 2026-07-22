"""Plane turn planning: replace sharp pass-end U-turns with contained arcs.

For a fixed-wing the autopilot flies a min-radius arc it cannot tighten, which
overshoots the field inset. This inserts an explicit rounded U-turn of radius
R = (lateral pass gap)/2 at each reversal, and SHORTENS both passes by R so the
arc's apex reaches only the original pass end (the inset edge) and no further —
so the whole turn stays inside the coverage boundary. The headland strip of
depth R at each turn is left unsprayed (accepted, as in real fixed-wing agro).

Every inserted arc is validated against free space (the cover ring minus
expanded exclusions, when the caller supplies them) before it is used: an arc
that cannot be PROVEN clear falls back to the original sharp turn for that
reversal only (fail-closed — never bake an unproven arc into the mission).
"""
import math
from shapely.geometry import Polygon, LineString
from .geo import latlon_to_local, local_to_latlon


def plane_turn_params(spacing, cruise_speed, bank_deg=45.0, min_airspeed=12.0):
    """Autopilot params so a fixed-wing actually FLIES the planned R=spacing/2 arcs
    instead of cutting them. Derived, not per-plane: FMP pushes these at upload
    (like WP_RADIUS_M for a copter). Returns ArduPlane param names/values, or
    None if the arcs are UNFLYABLE at this spacing (see min_airspeed) — the
    caller must then skip arc insertion entirely rather than command an
    impossible/stall-adjacent cruise speed to the airframe.

    - AIRSPEED_CRUISE: capped so min turn radius V²/(g·tanφ) ≤ R (else can't fit).
    - ROLL_LIMIT_DEG:  bank ceiling that makes R reachable.
    - NAVL1_PERIOD:    L1 look-ahead (NAVL1·V/π) ≈ R, so it tracks the arc not smooths it.
    - WP_RADIUS:       small, so it doesn't skip the closely-spaced arc waypoints.

    min_airspeed: floor below any real fixed-wing's minimum flying speed. If the
    R-feasible cruise (capped by the spacing-derived turn radius) falls below
    this, the turn radius is simply too tight to fly safely at any airspeed the
    airframe can sustain — return None instead of writing a below-floor
    AIRSPEED_CRUISE that degrades wind penetration on every later RTL/manual
    flight and flies min-radius turns with zero margin.
    """
    R = max(spacing / 2.0, 1.0)
    g = 9.81
    # Cap cruise so the plane's min turn radius sits WELL inside the arc (≈0.4·R, not
    # exactly R) — flying at the theoretical limit leaves no margin and it overshoots
    # (SITL: V at min-radius=R overshot; V at min-radius≈0.4R held to ~2-5 m).
    v_max = math.sqrt(0.4 * g * R * math.tan(math.radians(bank_deg)))
    V = min(float(cruise_speed), v_max)
    if V < min_airspeed:
        return None
    # look-ahead (NAVL1·V/π) ≈ 0.6·R tracks the arc tightly; = R over-smooths. Clamp.
    navl1 = max(6.0, min(20.0, 0.6 * math.pi * R / V))
    return {
        "AIRSPEED_CRUISE": round(V, 1),
        "ROLL_LIMIT_DEG": round(bank_deg, 0),
        "NAVL1_PERIOD": round(navl1, 1),
        "WP_RADIUS": max(3.0, round(R / 8.0, 0)),
    }


def _sub(a, b): return (b[0] - a[0], b[1] - a[1])
def _len(a, b): return math.hypot(b[0] - a[0], b[1] - a[1])
def _norm(v):
    m = math.hypot(v[0], v[1])
    return (v[0] / m, v[1] / m) if m > 1e-9 else (0.0, 0.0)
def _add(a, u, s): return (a[0] + u[0] * s, a[1] + u[1] * s)


def _semicircle(Bp, Cp, out_dir, npts, r_apex=None):
    """Interior points of the arc from Bp to Cp bulging toward out_dir.

    The along-chord half-extent a=|Bp-Cp|/2 is fixed by the (already
    shortened) endpoints, so the curve still meets Bp and Cp exactly. The
    OUTWARD bulge is a separate parameter r_apex (defaults to a, giving a
    true semicircle): when r_apex < a this is an ellipse-arc through the same
    Bp/Cp whose apex is capped at r_apex metres from the chord, instead of a
    full semicircle whose apex is fixed at a regardless of the caller's
    intended turn radius.

    This distinction matters because a stays ~constant (≈ half the lateral
    pass gap) even when the caller's turn radius R is capped down for a short
    pass — Bp and Cp shift by (near) the same vector for anti-parallel passes,
    so their separation doesn't shrink with R. Using a (uncapped) as the arc
    radius would let the apex overshoot past where the capped R says it must
    stop; r_apex=R fixes that (see add_plane_turns)."""
    Mx, My = (Bp[0] + Cp[0]) / 2.0, (Bp[1] + Cp[1]) / 2.0
    a = _len(Bp, Cp) / 2.0
    if a < 1e-9:
        return []
    b = a if r_apex is None else max(0.0, min(r_apex, a))
    ux, uy = (Bp[0] - Mx) / a, (Bp[1] - My) / a        # unit vector M -> Bp
    aB = math.atan2(uy, ux)
    apex = math.atan2(out_dir[1], out_dir[0])
    sign = 1.0
    for s in (1.0, -1.0):                      # pick sweep whose midpoint faces out_dir
        mid = aB + s * math.pi / 2.0
        if abs(math.atan2(math.sin(mid - apex), math.cos(mid - apex))) < 0.6:
            sign = s
            break
    vx, vy = -sign * uy, sign * ux                     # unit vector, u rotated +/-90 deg
    out = []
    for k in range(1, npts + 1):
        th = math.pi * k / (npts + 1)
        c, s_ = math.cos(th), math.sin(th)
        out.append((Mx + a * c * ux + b * s_ * vx, My + a * c * uy + b * s_ * vy))
    return out


def _clear_checker(within, avoid, lat0, lon0):
    """Build a predicate clear(points_local) -> bool checking that a candidate
    arc polyline (list of (east,north) points in the SAME local frame as
    within/avoid, once projected) stays INSIDE the `within` ring (if given)
    and OUTSIDE every `avoid` ring (if given). Returns None when neither
    constraint is usable — caller then treats every candidate as clear,
    same as before this fix (backward compatible with no containment info)."""
    within_poly = None
    if within and len(within) >= 3:
        p = Polygon([latlon_to_local(la, lo, lat0, lon0) for la, lo in within])
        if not p.is_valid:
            p = p.buffer(0)
        if not p.is_empty:
            within_poly = p

    avoid_polys = []
    for ring in (avoid or []):
        if len(ring) < 3:
            continue
        g = Polygon([latlon_to_local(la, lo, lat0, lon0) for la, lo in ring])
        if not g.is_valid:
            g = g.buffer(0)
        if not g.is_empty:
            avoid_polys.append(g)

    if within_poly is None and not avoid_polys:
        return None

    def clear(points):
        if within_poly is not None:
            for a, b in zip(points, points[1:]):
                if not within_poly.contains(LineString([a, b])):
                    return False
        if avoid_polys:
            line = LineString(points)
            for g in avoid_polys:
                if line.intersects(g):
                    return False
        return True

    return clear


def add_plane_turns(wps_ll, spacing, arc_pts=9, reversal_dot=-0.5, inset_slack=6.0,
                     within=None, avoid=None):
    """wps_ll: [(lat,lon),...] pass waypoints in flight order. Returns
    (wps_out, skipped): wps_out is the same list with each pass-end U-turn
    replaced by a contained arc where one could be PROVEN clear; skipped
    counts reversals that kept their original sharp turn instead, because no
    candidate arc could be validated against within/avoid.

    inset_slack: extra metres to pull the pass ends inward beyond R, so the arc
    apex sits `inset_slack` INSIDE the inset edge. This absorbs the autopilot's
    L1 tracking lag (~a few m) so the FLOWN path stays inside, not just the
    waypoints. Arc radius stays spacing/2 (both ends move equally), capped for
    short passes — and the semicircle's own bulge is capped to match (see
    _semicircle's r_apex), so the apex never crosses the original pass-end line
    regardless of capping.

    within: optional [(lat,lon),...] ring the arc must stay inside (e.g. the
    cover ring already computed for the route). avoid: optional list of
    [(lat,lon),...] rings the arc must not intersect (e.g. expanded
    exclusions/hazards). When a candidate arc fails validation, THAT reversal
    alone falls back to the original sharp turn (no shortening, no arc) —
    other reversals are unaffected. Omitting both (the defaults) skips
    validation entirely, matching the old unconditional-arc behaviour."""
    if len(wps_ll) < 4:
        return wps_ll, 0
    lat0, lon0 = wps_ll[0]
    P = [latlon_to_local(la, lo, lat0, lon0) for la, lo in wps_ll]
    n = len(P)
    clear = _clear_checker(within, avoid, lat0, lon0)
    out = [P[0]]
    i = 1
    skipped = 0
    while i < n - 1:
        turned = False
        if i + 2 <= n - 1:
            d_prev = _norm(_sub(P[i - 1], P[i]))          # heading of pass ending at B=P[i]
            d_next = _norm(_sub(P[i + 1], P[i + 2]))       # heading of pass starting at C=P[i+1]
            conn = _len(P[i], P[i + 1])                    # connector length ≈ lateral gap
            dot = d_prev[0] * d_next[0] + d_prev[1] * d_next[1]
            len_prev = _len(P[i - 1], P[i])
            len_next = _len(P[i + 1], P[i + 2])
            if dot < reversal_dot and 0.3 * spacing < conn < 1.8 * spacing:
                R = conn / 2.0
                R = min(R, 0.45 * len_prev, 0.45 * len_next)  # never eat a whole pass
                if R > 0.5:
                    B, C = P[i], P[i + 1]
                    pull = min(R + inset_slack, 0.45 * len_prev, 0.45 * len_next)
                    Bp = _add(B, d_prev, -pull)            # pull pass-prev end inward (R + slack)
                    Cp = _add(C, d_next, +pull)            # pull pass-next start inward
                    candidate = [Bp] + _semicircle(Bp, Cp, d_prev, arc_pts, r_apex=R) + [Cp]
                    if clear is None or clear(candidate):
                        out.extend(candidate)
                        i += 2
                        turned = True
                    else:
                        skipped += 1        # arc not provably clear -> keep sharp turn
        if not turned:
            out.append(P[i])
            i += 1
    out.append(P[-1])
    return [local_to_latlon(x, y, lat0, lon0) for x, y in out], skipped
