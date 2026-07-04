"""v2.5: manual field split into sectors — split_field_by_line + the build_route wire."""
from backend.coverage import split_field_by_line, polygon_area_ha
from backend.api import Api
from shapely.geometry import Polygon, Point


class _C:
    failed = 0
    def __call__(self, name, ok):
        print(("  OK  " if ok else " FAIL ") + name)
        if not ok:
            _C.failed += 1
check = _C()

B = [(50.0, 30.0), (50.0, 30.01), (50.008, 30.01), (50.008, 30.0)]

print("== split_field_by_line ==")
mid = [(50.003, 30.005), (50.005, 30.005)]      # short interior line -> must be extended
secs = split_field_by_line(B, mid)
check("mid line -> 2 sectors", len(secs) == 2)
areas = [polygon_area_ha(s) for s in secs]
check("2 sectors ~equal area", abs(areas[0] - areas[1]) / max(areas) < 0.05)
check("sectors sum ~= field area", abs(sum(areas) - polygon_area_ha(B)) < 0.5)
check("miss line -> 1 sector", len(split_field_by_line(B, [(50.02, 30.02), (50.03, 30.03)])) == 1)
check("degenerate (1-point) line -> 1 sector", len(split_field_by_line(B, [(50.004, 30.005)])) == 1)
zig = [(50.001, 30.003), (50.004, 30.006), (50.007, 30.003)]
check("zigzag line -> >=2 sectors", len(split_field_by_line(B, zig)) >= 2)

print("\n== build_route manual_line ==")
api = Api()
bd = [{"lat": a, "lng": b} for a, b in B]
line = [{"lat": 50.003, "lng": 30.005}, {"lat": 50.005, "lng": 30.005}]
r = api.build_route({"boundary": bd, "spacing": 20, "speed": 12, "alt": 50,
                     "split": {"mode": "manual_line", "line": line}})
check("manual_line build ok", r["ok"] is True)
check("2 flights", r["flights"] == 2)
check("2 sections (per-sector stats)", len(r["sections"]) == 2)
check("2 sector outlines returned", len(r["sectors"]) == 2)
polys = [Polygon([(p["lng"], p["lat"]) for p in sec]) for sec in r["sectors"]]
inside = sum(1 for w in r["waypoints"]
             if any(pp.buffer(1e-4).contains(Point(w["lng"], w["lat"])) for pp in polys))
check("waypoints fall inside a sector (coverage stays in-field)", inside >= 0.9 * len(r["waypoints"]))
miss = api.build_route({"boundary": bd, "spacing": 20, "alt": 50, "split": {
    "mode": "manual_line", "line": [{"lat": 50.02, "lng": 30.02}, {"lat": 50.03, "lng": 30.03}]}})
check("miss-line build -> single flight", miss["flights"] == 1 and len(miss["sectors"]) == 0)

print("\nRESULT: " + ("ALL CHECKS PASSED" if not check.failed else f"{check.failed} FAILURES ABOVE"))
import sys
sys.exit(1 if check.failed else 0)
