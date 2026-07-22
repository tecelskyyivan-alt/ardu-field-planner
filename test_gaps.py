"""Regression for #9 swath-gap geometry (backend/coverage.py::coverage_overlap_geo).
Run: .venv/bin/python test_gaps.py   (needs shapely)."""
import sys
sys.path.insert(0, ".")
from backend.coverage import coverage_overlap_geo
from backend.api import Api

failed = 0
def check(name, cond):
    global failed
    print(("  OK  " if cond else " FAIL ") + name)
    if not cond:
        failed += 1

home = (49.4900, 24.0000)
wps = [(49.4900, 24.0000), (49.4900, 24.0020), (49.4902, 24.0020), (49.4902, 24.0000),
       (49.4904, 24.0000), (49.4904, 24.0020)]
cover = [(49.4899, 23.9999), (49.4899, 24.0021), (49.4905, 24.0021), (49.4905, 23.9999)]

d_stitch = coverage_overlap_geo(home, wps, 20, rtl=False, cover=cover)          # boom=None → spacing
d_boom = coverage_overlap_geo(home, wps, 20, rtl=False, cover=cover, boom=8)    # boom<spacing → gaps
check("return has gaps + gap_ha keys", "gaps" in d_stitch and "gap_ha" in d_stitch)
check("stitched (boom=None) → few/no gaps", (d_stitch.get("gap_ha") or 0) < (d_boom.get("gap_ha") or 0))
check("boom<spacing → real gap area", (d_boom.get("gap_ha") or 0) > 0.1)
check("boom<spacing → gap rings drawn", len(d_boom.get("gaps") or []) >= 1)

# exclusion touching the boundary must not crash the gap block
excl = [(49.4901, 24.0009), (49.4901, 24.0013), (49.4903, 24.0013), (49.4903, 24.0009)]
d_ex = coverage_overlap_geo(home, wps, 20, rtl=False, cover=cover, exclusions=[excl], boom=8)
check("exclusion present → no crash, gaps returned", isinstance(d_ex.get("gaps"), list))

# build_route integration + backward-compat
api = Api()
b = [{"lat": 49.4899, "lng": 23.9999}, {"lat": 49.4899, "lng": 24.0025},
     {"lat": 49.4908, "lng": 24.0025}, {"lat": 49.4908, "lng": 23.9999}]
base = dict(boundary=b, spacing=20, angle=0, auto_angle=False, margin=0, alt=30, rtl=False, viz=True)
r0 = api.build_route(dict(base))
r1 = api.build_route(dict(base, boom=8))
check("build_route: coverage_geo/overlap_geo still present", "coverage_geo" in r0 and "overlap_geo" in r0)
check("build_route: stitched gap_ha ~0", (r0.get("gap_ha") or 0) < 0.05)
check("build_route: boom<spacing gap_ha > 0", (r1.get("gap_ha") or 0) > 0)

print("\nRESULT: " + (f"{failed} FAILURE(S)" if failed else "ALL CHECKS PASSED"))
sys.exit(1 if failed else 0)
