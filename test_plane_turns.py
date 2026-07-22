"""Regression for the audit fix wave on backend/plane_turns.py (fix/audit-planeturns):
  1. CRITICAL: arcs must respect exclusions/boundary (fall back to sharp turn per-reversal).
  2. IMPORTANT: capped R must cap the semicircle's apex too (no pass-end-line overshoot).
  3. IMPORTANT: plane_turn_params floors AIRSPEED_CRUISE at min_airspeed, else returns None.
Run: .venv/bin/python test_plane_turns.py"""
import math
import sys
sys.path.insert(0, ".")
from shapely.geometry import Polygon, LineString
from backend.geo import latlon_to_local, local_to_latlon
from backend.plane_turns import add_plane_turns, plane_turn_params

failed = 0
def check(name, cond):
    global failed
    print(("  OK  " if cond else " FAIL ") + name)
    if not cond:
        failed += 1

LAT0, LON0 = 49.49, 24.00
def mk(x, y):
    return local_to_latlon(x, y, LAT0, LON0)
def to_local(wps_ll):
    return [latlon_to_local(la, lo, LAT0, LON0) for la, lo in wps_ll]

# ---------------------------------------------------------------- (a) CRITICAL: containment
# 3 antiparallel passes at x=0, x=20, x=40 (spacing 20, len 200) -> two reversals:
#   reversal 1 at the TOP (y=200, between x=0 and x=20 passes)
#   reversal 2 at the BOTTOM (y=0, between x=20 and x=40 passes)
# An 8 m-ish octagon pole sits ON reversal 1's arc sweep (between the shortened chord at
# y=184 and the apex at y=194) but well clear (>2 m) of the ORIGINAL straight connector
# at y=200 -- the exact audit shape: original route provably clear, inserted arc is not.
wps_local_a = [(0, 0), (0, 200), (20, 200), (20, 0), (40, 0), (40, 200)]
wps_ll_a = [mk(x, y) for x, y in wps_local_a]

pole_cx, pole_cy = 6.91, 193.51   # a known point on reversal-1's undefended arc
POLE_R = 4.0
pole_local = [(pole_cx + POLE_R * math.cos(k * math.pi / 4),
               pole_cy + POLE_R * math.sin(k * math.pi / 4)) for k in range(8)]
pole_ll = [mk(x, y) for x, y in pole_local]
pole_poly = Polygon(pole_local)

# Original (plane_turn off) route: must be clear of the pole.
orig_line = LineString(wps_local_a)
check("(a) original straight-turn route is clear of the pole", not orig_line.intersects(pole_poly))

# WITHOUT containment inputs: reproduces the audit bug -- arc hits the pole.
out_noavoid, sk_noavoid = add_plane_turns(wps_ll_a, spacing=20)
route_noavoid = LineString(to_local(out_noavoid))
check("(a) WITHOUT avoid: uncontained arc DOES cross the pole (bug reproduction)",
      route_noavoid.intersects(pole_poly))
check("(a) WITHOUT avoid: nothing reported skipped", sk_noavoid == 0)

# WITH containment inputs: the affected reversal falls back to a sharp turn, the whole
# route stays clear, and the OTHER reversal (bottom) still gets its arc.
cover_local = [(-100, -100), (100, -100), (100, 300), (-100, 300)]
cover_ll = [mk(x, y) for x, y in cover_local]
out_avoid, sk_avoid = add_plane_turns(wps_ll_a, spacing=20, within=cover_ll, avoid=[pole_ll])
route_avoid = LineString(to_local(out_avoid))
check("(a) WITH avoid: fixed route is provably clear of the pole (shapely)",
      not route_avoid.intersects(pole_poly))
check("(a) WITH avoid: exactly the one affected reversal was skipped", sk_avoid == 1)
check("(a) WITH avoid: OTHER reversal still got its arc (route longer than all-sharp, "
      "shorter than all-arc)", len(out_noavoid) > len(out_avoid) > len(wps_ll_a))

# ------------------------------------------------------------- (b) capped R caps the apex
# Short passes (len 20) at spacing 30 -> R gets capped by 0.45*len_prev/len_next well below
# conn/2 -- the pre-fix bug let the apex land 6 m past the pass-end line (y=20 here).
wps_local_b = [(0, 0), (0, 20), (30, 20), (30, 0)]
wps_ll_b = [mk(x, y) for x, y in wps_local_b]
out_b, sk_b = add_plane_turns(wps_ll_b, spacing=30)
local_b = to_local(out_b)
max_y_b = max(y for _, y in local_b[1:-1])   # exclude the untouched pass-start/end wps
check("(b) capped-R arc apex does not cross the original pass-end line (y=20)",
      max_y_b <= 20.0 + 1e-6)
check("(b) sanity: arc points were actually inserted (not a degenerate/empty case)",
      len(out_b) > len(wps_ll_b))

# ---------------------------------------------------------- (c) unflyable R -> params None
# Realistic small agro spacing (20 m) -> derived cruise ~6.3 m/s, well under the 12 m/s floor.
p_tiny = plane_turn_params(20, 12.0)
check("(c) tiny-R/unflyable spacing -> plane_turn_params returns None", p_tiny is None)

# Sanity: a large enough spacing (R well above the floor) still returns real params.
p_ok = plane_turn_params(100, 15.0)
check("(c) sanity: feasible spacing still returns params", p_ok is not None)
if p_ok is not None:
    check("(c) sanity: returned AIRSPEED_CRUISE respects the floor",
          p_ok["AIRSPEED_CRUISE"] >= 12.0)

# --------------------------------------------------- (d) regression: plain case still arcs
# No within/avoid at all (back-compat call shape) -- arcs must still be inserted normally.
wps_local_d = [(0, 0), (0, 200), (20, 200), (20, 0)]
wps_ll_d = [mk(x, y) for x, y in wps_local_d]
out_d, sk_d = add_plane_turns(wps_ll_d, spacing=20)
check("(d) plain no-obstacle case still inserts arc points (count grows)",
      len(out_d) > len(wps_ll_d))
check("(d) plain no-obstacle case: nothing skipped", sk_d == 0)

print("\nRESULT: " + (f"{failed} FAILURE(S)" if failed else "ALL CHECKS PASSED"))
sys.exit(1 if failed else 0)
