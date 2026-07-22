"""Plane turn planning: replace sharp pass-end U-turns with contained arcs.

For a fixed-wing the autopilot flies a min-radius arc it cannot tighten, which
overshoots the field inset. This inserts an explicit rounded U-turn of radius
R = (lateral pass gap)/2 at each reversal, and SHORTENS both passes by R so the
arc's apex reaches only the original pass end (the inset edge) and no further —
so the whole turn stays inside the coverage boundary. The headland strip of
depth R at each turn is left unsprayed (accepted, as in real fixed-wing agro).
"""
import math
from .geo import latlon_to_local, local_to_latlon


def plane_turn_params(spacing, cruise_speed, bank_deg=45.0):
    """Autopilot params so a fixed-wing actually FLIES the planned R=spacing/2 arcs
    instead of cutting them. Derived, not per-plane: FMP pushes these at upload
    (like WP_RADIUS_M for a copter). Returns ArduPlane param names/values.

    - AIRSPEED_CRUISE: capped so min turn radius V²/(g·tanφ) ≤ R (else can't fit).
    - ROLL_LIMIT_DEG:  bank ceiling that makes R reachable.
    - NAVL1_PERIOD:    L1 look-ahead (NAVL1·V/π) ≈ R, so it tracks the arc not smooths it.
    - WP_RADIUS:       small, so it doesn't skip the closely-spaced arc waypoints.
    """
    R = max(spacing / 2.0, 1.0)
    g = 9.81
    # Cap cruise so the plane's min turn radius sits WELL inside the arc (≈0.4·R, not
    # exactly R) — flying at the theoretical limit leaves no margin and it overshoots
    # (SITL: V at min-radius=R overshot; V at min-radius≈0.4R held to ~2-5 m).
    v_max = math.sqrt(0.4 * g * R * math.tan(math.radians(bank_deg)))
    V = max(1.0, min(float(cruise_speed), v_max))
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


def _semicircle(Bp, Cp, out_dir, npts):
    """Interior points of the 180° arc from Bp to Cp bulging toward out_dir."""
    Mx, My = (Bp[0] + Cp[0]) / 2.0, (Bp[1] + Cp[1]) / 2.0
    R = _len(Bp, Cp) / 2.0
    aB = math.atan2(Bp[1] - My, Bp[0] - Mx)
    apex = math.atan2(out_dir[1], out_dir[0])
    sign = 1.0
    for s in (1.0, -1.0):                      # pick sweep whose midpoint faces out_dir
        mid = aB + s * math.pi / 2.0
        if abs(math.atan2(math.sin(mid - apex), math.cos(mid - apex))) < 0.6:
            sign = s
            break
    return [(Mx + R * math.cos(aB + sign * math.pi * k / (npts + 1)),
             My + R * math.sin(aB + sign * math.pi * k / (npts + 1)))
            for k in range(1, npts + 1)]


def add_plane_turns(wps_ll, spacing, arc_pts=9, reversal_dot=-0.5, inset_slack=6.0):
    """wps_ll: [(lat,lon),...] pass waypoints in flight order. Returns the same
    with each pass-end U-turn replaced by a contained arc.

    inset_slack: extra metres to pull the pass ends inward beyond R, so the arc
    apex sits `inset_slack` INSIDE the inset edge. This absorbs the autopilot's
    L1 tracking lag (~a few m) so the FLOWN path stays inside, not just the
    waypoints. Arc radius stays spacing/2 (both ends move equally)."""
    if len(wps_ll) < 4:
        return wps_ll
    lat0, lon0 = wps_ll[0]
    P = [latlon_to_local(la, lo, lat0, lon0) for la, lo in wps_ll]
    n = len(P)
    out = [P[0]]
    i = 1
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
                    out.append(Bp)
                    out.extend(_semicircle(Bp, Cp, d_prev, arc_pts))  # radius = |Bp-Cp|/2 = R
                    out.append(Cp)
                    i += 2
                    turned = True
        if not turned:
            out.append(P[i])
            i += 1
    out.append(P[-1])
    return [local_to_latlon(x, y, lat0, lon0) for x, y in out]
