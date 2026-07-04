"""Benchmark harness for coverage strategies under an ALWAYS-ON sprayer.

The drone sprays from takeoff to landing, so the cost = the WHOLE flown path
(lead-in + passes + connectors + RTL). A strategy is a function
    route_fn(boundary, spacing, home) -> [(lat,lon), ...]   # coverage waypoints
We score it on a fixed set of fields/home positions by the TRUE spray overlap
(coverage.mission_overlap, which counts the full flown path incl. RTL) and the
estimated flight time. Lower overlap AND lower time = better.

Helpers a strategy may reuse:
    from backend.coverage import generate_coverage, inset_boundary, optimal_angle
    generate_coverage(boundary, spacing, angle_deg, exclusions=None, anchor=None,
                      start_finish_anchor=False)  -> [(lat,lon), ...]
"""
import math

from backend.coverage import mission_overlap, estimate_mission_time

SPACING = 20.0
SPEED = 8.0
ALT = 40.0


def _rect(lat0, lng0, w, h):
    dlat = h / 111320.0
    dlng = w / (111320.0 * math.cos(math.radians(lat0)))
    return [(lat0, lng0), (lat0, lng0 + dlng), (lat0 + dlat, lng0 + dlng), (lat0 + dlat, lng0)]


def fields():
    """(name, boundary[(lat,lon)], home(lat,lon)) cases — rectangles of various
    aspect ratios, with the takeoff at a corner and at a bottom-edge midpoint."""
    out = []
    for w, h in [(130, 130), (300, 200), (500, 300), (150, 400), (250, 250)]:
        b = _rect(50.0, 30.0, w, h)
        out.append((f"{w}x{h}_corner", b, b[0]))
        em = ((b[0][0] + b[1][0]) / 2.0, (b[0][1] + b[1][1]) / 2.0)
        out.append((f"{w}x{h}_edge", b, em))
    return out


def _as_latlon(wps):
    out = []
    for p in wps:
        if isinstance(p, dict):
            out.append((float(p["lat"]), float(p["lng"])))
        else:
            out.append((float(p[0]), float(p[1])))
    return out


def score(route_fn, verbose=False):
    """Run route_fn over all fields; return {avg_overlap_pct, avg_time_s, rows}."""
    rows = []
    for name, b, home in fields():
        try:
            wps = _as_latlon(route_fn([{"lat": la, "lng": lo} for la, lo in b], SPACING,
                                      {"lat": home[0], "lng": home[1]}))
        except Exception as exc:
            rows.append((name, None, None, f"ERR {type(exc).__name__}: {exc}"))
            continue
        if len(wps) < 2:
            rows.append((name, None, None, "no route"))
            continue
        mo = mission_overlap((home[0], home[1]), wps, SPACING, b, True)
        te = estimate_mission_time(wps, (home[0], home[1], 0.0), wp_alt=ALT,
                                   takeoff_alt=ALT, speed=SPEED, rtl=True)
        rows.append((name, mo["overlap_pct"], round(te["total_s"]), round(mo["overlap_ha"], 3)))
    valid = [r for r in rows if r[1] is not None]
    avg_ovl = sum(r[1] for r in valid) / len(valid) if valid else 999.0
    avg_t = sum(r[2] for r in valid) / len(valid) if valid else 999.0
    if verbose:
        for r in rows:
            print(f"  {r[0]:16} overlap={r[1]} time={r[2]} ovl_ha={r[3]}")
    return {"avg_overlap_pct": round(avg_ovl, 2), "avg_time_s": round(avg_t), "rows": rows}


if __name__ == "__main__":
    # Baseline: the current engine (auto-angle snake, anchor-start, no out-and-back).
    from backend.coverage import inset_boundary, optimal_angle, generate_coverage

    def baseline_snake(boundary, spacing, home):
        b = [(p["lat"], p["lng"]) for p in boundary]
        cover = inset_boundary(b, spacing / 2.0)
        if not cover:
            return []
        ang, wps = optimal_angle(cover, spacing, return_route=True,
                                 anchor=(home["lat"], home["lng"]))
        return wps or generate_coverage(cover, spacing, ang, anchor=(home["lat"], home["lng"]))

    print("BASELINE auto-angle snake:", score(baseline_snake, verbose=True))
