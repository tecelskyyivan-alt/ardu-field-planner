"""Smoke test for the mission core (no GUI). Run: python test_core.py"""
import json
import sys

from backend.coverage import generate_coverage, polygon_area_ha
from backend.geo import centroid, path_length, haversine
from backend.mission import to_waypoints, to_plan

# A ~roughly 300 x 200 m rectangular field near Kyiv.
field = [
    (50.4500, 30.5200),
    (50.4500, 30.5242),
    (50.4518, 30.5242),
    (50.4518, 30.5200),
]


def check(name, cond):
    print(("  OK  " if cond else " FAIL ") + name)
    if not cond:
        check.failed = True


check.failed = False

print("== coverage ==")
wps = generate_coverage(field, spacing=25, angle_deg=0)
check("waypoints generated", len(wps) >= 4)
check("even number of endpoints", len(wps) % 2 == 0)
area = polygon_area_ha(field)
print(f"  area = {area:.3f} ha   waypoints = {len(wps)}   length = {path_length(wps):.0f} m")
check("area in sane range (4-7 ha)", 4.0 < area < 7.0)

# All waypoints must lie within the field bounding box (with small tolerance).
lats = [p[0] for p in field]; lons = [p[1] for p in field]
inb = all(min(lats) - 1e-4 <= a <= max(lats) + 1e-4 and
          min(lons) - 1e-4 <= b <= max(lons) + 1e-4 for a, b in wps)
check("all waypoints inside field bbox", inb)

# Angled sweep should still produce a valid path.
wps45 = generate_coverage(field, spacing=25, angle_deg=45)
check("angled (45deg) sweep works", len(wps45) >= 4)

print("\n== WPL 110 export ==")
home = (*centroid(field), 0.0)
wpl = to_waypoints(home, 10, wps, 50, add_rtl=True)
lines = wpl.strip().splitlines()
check("header present", lines[0] == "QGC WPL 110")
check("WP0 is home (cmd 16, current 1)", lines[1].split("\t")[3] == "16" and lines[1].split("\t")[1] == "1")
check("takeoff is cmd 22", lines[2].split("\t")[3] == "22")
check("last item is RTL (cmd 20)", lines[-1].split("\t")[3] == "20")
check("12 columns per row", all(len(l.split("\t")) == 12 for l in lines[1:]))
check("seq is contiguous", [int(l.split("\t")[0]) for l in lines[1:]] == list(range(len(lines) - 1)))

print("\n== .plan export ==")
plan_str = to_plan(home, 10, wps, 50, add_rtl=True, cruise_speed=12)
plan = json.loads(plan_str)  # must be valid JSON
check("fileType Plan", plan["fileType"] == "Plan")
check("ArduPilot firmware (3)", plan["mission"]["firmwareType"] == 3)
check("quad vehicle (2)", plan["mission"]["vehicleType"] == 2)
check("plannedHomePosition len 3", len(plan["mission"]["plannedHomePosition"]) == 3)
items = plan["mission"]["items"]
check("first item takeoff (22)", items[0]["command"] == 22)
check("last item RTL (20)", items[-1]["command"] == 20)
check("doJumpId is 1..N", [it["doJumpId"] for it in items] == list(range(1, len(items) + 1)))
check("every item has 7 params", all(len(it["params"]) == 7 for it in items))

print("\n== edge cases ==")
check("degenerate polygon -> []", generate_coverage([(0, 0), (0, 1)], 10, 0) == [])
check("huge spacing still returns path", len(generate_coverage(field, 500, 0)) >= 2)

print()
if check.failed:
    print("RESULT: FAILURES PRESENT")
    sys.exit(1)
print("RESULT: ALL CHECKS PASSED")
