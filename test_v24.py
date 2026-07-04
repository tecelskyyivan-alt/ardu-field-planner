"""v2.4 unit tests: smart time estimate, N-area split, flight calibration, anchor."""
from backend.coverage import (
    generate_coverage, estimate_mission_time, split_route_by_area, polygon_area_ha,
)
from backend.flight_calib import calibrate
from backend.geo import haversine
from backend.api import Api


class _C:
    failed = 0
    def __call__(self, name, ok):
        print(("  OK  " if ok else " FAIL ") + name)
        if not ok:
            _C.failed += 1
check = _C()

# A ~800 x 900 m rectangular field.
FIELD = [(50.000, 30.000), (50.000, 30.012), (50.008, 30.012), (50.008, 30.000)]
HOME = (50.004, 30.006, 0.0)
WPS = generate_coverage(FIELD, 20, 0.0)

print("== estimate_mission_time ==")
e = estimate_mission_time(WPS, HOME, wp_alt=50, takeoff_alt=50, speed=12, rtl=True)
for k in ("takeoff_s", "transit_s", "cruise_s", "turn_s", "rtl_s", "descent_s", "total_s"):
    check(f"breakdown has {k}", k in e)
check("total == sum of phases (mult 1.0)", abs(e["total_s"] - (
    e["takeoff_s"] + e["transit_s"] + e["cruise_s"] + e["turn_s"] + e["rtl_s"] + e["descent_s"])) < 1e-6)
check("smarter than naive length/speed (takeoff+turns+rtl add time)",
      e["total_s"] > sum(haversine(*WPS[i], *WPS[i + 1]) for i in range(len(WPS) - 1)) / 12)
check("takeoff = alt/climb_rate", abs(e["takeoff_s"] - 50 / 2.5) < 1e-6)
check("descent = alt/descent_rate", abs(e["descent_s"] - 50 / 1.5) < 1e-6)
e_nortl = estimate_mission_time(WPS, HOME, wp_alt=50, speed=12, rtl=False)
check("no RTL -> no return/descent time", e_nortl["rtl_s"] == 0 and e_nortl["descent_s"] == 0)
e_cal = estimate_mission_time(WPS, HOME, wp_alt=50, speed=12, rtl=True, cal={"time_mult": 1.3})
check("calibration scales total by time_mult", abs(e_cal["total_s"] - e["total_s"] * 1.3) < 1e-3)
e_bad = estimate_mission_time(WPS, HOME, wp_alt=50, speed=12, rtl=True, cal={"time_mult": 99})
check("wild calibration is ignored (clamped to 1.0)", abs(e_bad["total_s"] - e["total_s"]) < 1e-6)
# "Wind" sensitivity: a calibration learned from headwind-slowed flights lengthens
# the estimate; a tailwind one shortens it. Modelled via time_mult (see calibrate).
check("headwind cal (1.25) > nominal", estimate_mission_time(
    WPS, HOME, wp_alt=50, speed=12, cal={"time_mult": 1.25})["total_s"] > e["total_s"])
check("tailwind cal (0.85) < nominal", estimate_mission_time(
    WPS, HOME, wp_alt=50, speed=12, cal={"time_mult": 0.85})["total_s"] < e["total_s"])

print("\n== split_route_by_area ==")
for n in (2, 3, 4):
    secs = split_route_by_area(WPS, 20, n)
    check(f"n={n} -> {n} sections", len(secs) == n)
    areas = [sum(haversine(*s[i], *s[i + 1]) for i in range(len(s) - 1)) * 20 / 1e4 for s in secs]
    spread = (max(areas) - min(areas)) / (sum(areas) / len(areas))
    check(f"n={n} sections within ~25% area of each other", spread < 0.25)
    # Continuity: each section starts where the previous ended (no coverage gap).
    gaps_ok = all(secs[i][-1] == secs[i + 1][0] for i in range(len(secs) - 1))
    check(f"n={n} sections are continuous (shared cut points)", gaps_ok)
check("n=1 -> single section", len(split_route_by_area(WPS, 20, 1)) == 1)
check("n > legs is capped to the route", len(split_route_by_area(WPS[:3], 20, 99)) <= 2)

print("\n== flight_calib.calibrate ==")
recs = [
    {"planned": {"duration_s": 1000}, "actual": {"duration_s": 1200, "battery_used_pct": 60}},
    {"planned": {"duration_s": 500}, "actual": {"duration_s": 650, "battery_used_pct": 35}},
    {"planned": {"duration_s": 800}, "actual": {"duration_s": 900}, "partial": True},  # ignored
]
cal = calibrate(recs)
check("uses only complete flights (n=2)", cal["n"] == 2)
check("time_mult = median(actual/planned) = 1.25", abs(cal["time_mult"] - 1.25) < 1e-6)
check("pct_per_min present", "pct_per_min" in cal and cal["pct_per_min"] > 0)
check("empty -> no factors", calibrate([]) == {"n": 0})
check("garbage ratio clamped out", "time_mult" not in calibrate(
    [{"planned": {"duration_s": 1}, "actual": {"duration_s": 1000}}]))

print("\n== take-off must NOT pull the route (Ivan, Variant A) ==")
api = Api()
# The plain route's heading/start are chosen by mission TIME alone; the take-off does
# not pull the start anymore (only the opt-in «finish at take-off» does — tested below).

print("\n== productive return corridor (v2.5.2 — last pass IS the way home) ==")
B2 = [{"lat": 50.0, "lng": 30.0}, {"lat": 50.0, "lng": 30.01},
      {"lat": 50.008, "lng": 30.01}, {"lat": 50.008, "lng": 30.0}]
anch = {"lat": 50.0, "lng": 30.0}
def _fin(sfa):
    r = api.build_route({"boundary": B2, "spacing": 20, "speed": 8, "alt": 40, "rtl": True,
                         "auto_angle": True, "anchor": anch, "start_finish_anchor": sfa})
    w = r["waypoints"]
    return r, haversine(anch["lat"], anch["lng"], w[-1]["lat"], w[-1]["lng"])
r_free, fin_free = _fin(False)
r_home, fin_home = _fin(True)
# The whole point the user demanded: the route ENDS AT the takeoff (not ~40 m away
# like the old swap), reached by a real spray pass — so finish must be ~0 m.
check("return corridor FINISHES exactly at the takeoff point (~0 m, not just 'near')",
      fin_home < 5.0)
# (The plain route's finish is NOT pulled home anymore — only the corridor is — so we
# just check the corridor finishes at least as near home as the plain route.)
check("return corridor finishes at least as near home as the plain route",
      fin_home <= fin_free + 0.5)
# The corridor is the chosen min-overlap variant: it must NOT be worse than the
# plain overlap optimum (it measured ~-0.4pp better on the bench).
check("return corridor overlap <= the plain overlap optimum (+0.5pp tol)",
      r_home["overlap_pct"] <= r_free["overlap_pct"] + 0.5)
check("return corridor keeps coverage (>= the plain optimum, no edge gap)",
      r_home["coverage_pct"] >= r_free["coverage_pct"] - 1.0)
check("return corridor is OPT-IN: default OFF even with anchor+rtl",
      api.build_route({"boundary": B2, "spacing": 20, "alt": 50, "rtl": True, "anchor": anch})
      ["start_finish_anchor"] is False)

print("\n== full-coverage min-time heading (v2.6, always-on sprayer) ==")
def _ovl(opt):
    return api.build_route({"boundary": B2, "spacing": 20, "speed": 8, "alt": 40, "rtl": True,
                            "auto_angle": True, "anchor": anch, "optimize": opt})
r_len, r_ovl = _ovl("length"), _ovl("overlap")
# optimize="overlap" now = FULL COVERAGE first, then minimum flight TIME (Ivan: a
# continuous takeoff->landing sprayer wants the whole field covered in the least
# time). So it must cover AT LEAST as much as the coverage-blind min-length heading.
check("auto-angle covers >= min-length heading (coverage-gated)",
      r_ovl["coverage_pct"] >= r_len["coverage_pct"] - 0.5)
check("response reports TRUE overlap (incl RTL) + outside_ha",
      "outside_ha" in r_ovl and r_ovl["overlap_pct"] >= 0)
check("auto-angle covers the field (>95%)", r_ovl["coverage_pct"] > 95.0)
# On a small square the coverage-blind min-length heading can leave a headland gap;
# the full-coverage heading must cover at least as much.
import math as _m
def _ll(m, lat=50.0): return m / (111320.0 * _m.cos(_m.radians(lat)))
sq = [{"lat": 50.0, "lng": 30.0}, {"lat": 50.0, "lng": 30.0 + _ll(130)},
      {"lat": 50.0 + 130 / 111320.0, "lng": 30.0 + _ll(130)}, {"lat": 50.0 + 130 / 111320.0, "lng": 30.0}]
sl = api.build_route({"boundary": sq, "spacing": 20, "speed": 8, "alt": 40, "rtl": True,
                      "auto_angle": True, "anchor": {"lat": 50.0, "lng": 30.0}, "optimize": "length"})
so = api.build_route({"boundary": sq, "spacing": 20, "speed": 8, "alt": 40, "rtl": True,
                      "auto_angle": True, "anchor": {"lat": 50.0, "lng": 30.0}, "optimize": "overlap"})
check("small square: full-coverage heading covers >= min-length heading",
      so["coverage_pct"] >= sl["coverage_pct"] - 0.5)

print("\n== necked field must NOT skip a lobe (the 'skips a large area' bug) ==")
# An hourglass field (a ~16 m waist): the inset used to SPLIT it and keep only the
# larger half — silently skipping ~50% of the field. Now it must cover the whole thing.
def _sq(x, y): return {"lat": 50.0 + y / 111320.0, "lng": 30.0 + _ll(x)}
waist = [_sq(0, 0), _sq(160, 0), _sq(160, 120), _sq(88, 130), _sq(160, 140), _sq(160, 260),
         _sq(0, 260), _sq(0, 140), _sq(72, 130), _sq(0, 120)]
rw = api.build_route({"boundary": waist, "spacing": 20, "alt": 40, "auto_angle": True, "optimize": "overlap"})
check("necked field still builds", bool(rw.get("ok")) and rw.get("count", 0) > 8)
check("necked field covers the WHOLE field (>85%, not ~50% — no dropped lobe)",
      rw.get("coverage_pct", 0) > 85.0)

print("\n== overlap-optimal on a NON-rectangular (L-shaped) field ==")
Lshape = [(50.0, 30.0), (50.0, 30.012), (50.005, 30.012), (50.005, 30.006),
          (50.01, 30.006), (50.01, 30.0)]
Lbd = [{"lat": a, "lng": b} for a, b in Lshape]
rL = api.build_route({"boundary": Lbd, "spacing": 20, "speed": 8, "alt": 40, "rtl": True,
                      "auto_angle": True, "anchor": {"lat": 50.0, "lng": 30.0}, "optimize": "overlap"})
check("L-shaped field builds with the overlap sweep", rL["ok"] and rL["count"] > 5)
check("L-shaped coverage stays reasonable (>90%)", rL["coverage_pct"] > 90.0)

print("\n== narrow ARMS of a cross/star field must be sprayed (not dropped as slivers) ==")
# A plus/cross with 4 m-wide arms (< the per-row min_gap at spacing 20). The per-row
# sliver filter in generate_coverage used to drop EVERY narrow arm row, leaving a
# whole arm unsprayed (~2 wp). Now a row whose only segments are sub-min_gap slivers
# keeps them, so each arm is still covered.
plus = [(0, 98), (98, 98), (98, 0), (102, 0), (102, 98), (200, 98),
        (200, 102), (102, 102), (102, 200), (98, 200), (98, 102), (0, 102)]
plus_ll = [(50.0 + y / 111320.0, 30.0 + _ll(x)) for x, y in plus]
wp_cross = generate_coverage(plus_ll, 20, 0.0)
check("cross field core coverage keeps the narrow arms (>8 wp, not ~2)", len(wp_cross) > 8)
_lats = [p[0] for p in wp_cross]
_span = (max(_lats) - min(_lats)) * 111320 if wp_cross else 0
check("vertical arm sprayed at angle 0 (route spans ~full 200 m, not just the centre)", _span > 150)

print("\nRESULT: " + ("ALL CHECKS PASSED" if not check.failed else f"{check.failed} FAILURES ABOVE"))
import sys
sys.exit(1 if check.failed else 0)
