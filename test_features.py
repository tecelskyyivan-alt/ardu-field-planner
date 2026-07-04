"""Tests for margin (inset), optimal angle, and contour/geofence exports."""
import json
import sys

from backend.coverage import inset_boundary, optimal_angle, polygon_area_ha
from backend.mission import to_geofence_plan, to_fence_mp, to_contour_geojson
from backend.api import Api

# E-W elongated rectangle near Lviv: ~289 m (E-W) x ~111 m (N-S).
rect = [
    (49.5000, 24.0000),
    (49.5000, 24.0040),
    (49.5010, 24.0040),
    (49.5010, 24.0000),
]


def check(name, cond):
    print(("  OK  " if cond else " FAIL ") + name)
    if not cond:
        check.failed = True


check.failed = False

print("== inset / margin ==")
a0 = polygon_area_ha(rect)
inset10 = inset_boundary(rect, 10)
a10 = polygon_area_ha(inset10)
print(f"  area full={a0:.3f} ha  inset10={a10:.3f} ha")
check("margin 0 returns same polygon", len(inset_boundary(rect, 0)) == len(rect))
check("margin 10 shrinks area", a10 < a0 and a10 > 0)
check("huge margin (100m) dissolves field -> None", inset_boundary(rect, 100) is None)

print("\n== route stays inside contour + avoids exclusions ==")
from backend.coverage import generate_coverage as _gc
from backend.geo import latlon_to_local as _l2l2, centroid as _cen2
from shapely.geometry import Polygon as _P2, LineString as _LS2
_field = [(49.50, 24.00), (49.50, 24.012), (49.512, 24.012), (49.512, 24.00)]
_excl = [[(49.504, 24.004), (49.504, 24.008), (49.508, 24.008), (49.508, 24.004)]]
_wps = _gc(_field, 18, 0.0, exclusions=_excl)
_la0, _lo0 = _cen2(_field)
_fp = _P2([_l2l2(la, lo, _la0, _lo0) for la, lo in _field])
_ep = _P2([_l2l2(la, lo, _la0, _lo0) for la, lo in _excl[0]])
_loc = [_l2l2(la, lo, _la0, _lo0) for la, lo in _wps]
_outside = sum(1 for a, b in zip(_loc, _loc[1:]) if not _fp.buffer(1.0).contains(_LS2([a, b])))
_thru = sum(1 for a, b in zip(_loc, _loc[1:]) if _LS2([a, b]).intersection(_ep.buffer(-0.5)).length > 0.5)
check("coverage produced with central exclusion", len(_wps) > 8)
check("no route segment leaves the field", _outside == 0)
check("no route segment crosses the exclusion", _thru == 0)

print("\n== optimal angle ==")
ang = optimal_angle(rect, 15)
print(f"  optimal angle = {ang}")
# E-W elongated -> passes should run E-W (angle near 0 or 180)
check("optimal angle aligns to long (E-W) axis", ang <= 12 or ang >= 168)

print("\n== build_route with margin + auto_angle ==")
api = Api()
res = api.build_route({
    "boundary": [{"lat": la, "lng": lo} for la, lo in rect],
    "spacing": 15, "auto_angle": True, "margin": 15,
    "alt": 50, "takeoff_alt": 10, "speed": 12, "rtl": True,
})
check("build ok", res["ok"])
check("returns inset contour", "contour" in res and len(res["contour"]) >= 3)
check("reports angle_used", "angle_used" in res)
check("reports margin=15", res["margin"] == 15)
check("inset area < full area", res["area_ha"] < a0)

print("\n== contour / geofence exports ==")
contour = [(p["lat"], p["lng"]) for p in res["contour"]]
home = (res["home"]["lat"], res["home"]["lng"], 0.0)

plan = json.loads(to_geofence_plan(contour, home))
check("geofence .plan valid JSON, fileType Plan", plan["fileType"] == "Plan")
polys = plan["geoFence"]["polygons"]
check("has one inclusion polygon", len(polys) == 1 and polys[0]["inclusion"] is True)
check("polygon has >=3 verts as [lat,lon]", len(polys[0]["polygon"]) >= 3 and len(polys[0]["polygon"][0]) == 2)
check("geofence mission has no items", plan["mission"]["items"] == [])

# obstacles -> exclusion polygons in the geofence (keep the copter out of them)
_obs1 = [(49.5003, 24.0010), (49.5003, 24.0020), (49.5007, 24.0020)]
plan2 = json.loads(to_geofence_plan(contour, home, [_obs1]))
polys2 = plan2["geoFence"]["polygons"]
check("geofence gains an exclusion polygon per obstacle", len(polys2) == 2)
check("first polygon stays the field inclusion", polys2[0]["inclusion"] is True)
check("obstacle polygon is an exclusion (inclusion=False)", polys2[1]["inclusion"] is False)
check("degenerate (<3 vtx) obstacles are skipped",
      len(json.loads(to_geofence_plan(contour, home, [[(49.5, 24.0)]]))["geoFence"]["polygons"]) == 1)

fence = to_fence_mp(contour)
flines = fence.strip().splitlines()
check("MP fence: return point + verts + close", len(flines) == len(contour) + 2)
check("MP fence lines are 'lat lon'", all(len(l.split()) == 2 for l in flines))
check("MP fence closes (last == first vertex)", flines[1] == flines[-1])

gj = json.loads(to_contour_geojson(contour))
check("geojson is FeatureCollection Polygon", gj["features"][0]["geometry"]["type"] == "Polygon")
ring = gj["features"][0]["geometry"]["coordinates"][0]
check("geojson ring closed (lon,lat)", ring[0] == ring[-1])

print("\n== declustering (no point pile-ups at narrow corners) ==")
import math as _math
from backend.coverage import generate_coverage, _decluster
from backend.geo import latlon_to_local as _l2l, centroid as _cen
# rectangle body + a thin diagonal spike -> would spawn micro-pass clusters
spiky = [(49.500, 24.000), (49.500, 24.0035), (49.4978, 24.0035),
         (49.4969, 24.0050), (49.4966, 24.0048), (49.4978, 24.0030),
         (49.4978, 24.000)]
sp = 15.0
wps = generate_coverage(spiky, sp, 0.0)
_lat0, _lon0 = _cen(spiky)
_loc = [_l2l(la, lo, _lat0, _lon0) for la, lo in wps]
_gaps = [_math.hypot(_loc[i + 1][0] - _loc[i][0], _loc[i + 1][1] - _loc[i][1])
         for i in range(len(_loc) - 1)]
_target = min(max(2.0, 0.25 * sp), 0.5 * sp)
_tiny = sum(1 for g in _gaps if g < _target - 1e-6)
check("no clustered waypoints (<=1 small gap)", _tiny <= 1)
check("coverage still produced", len(wps) >= 6)
# direct: a dense 20-point cluster collapses, normal passes are untouched
_clu = [(0.0, i * 0.3) for i in range(20)] + [(0.0, 100.0), (50.0, 100.0)]
check("dense cluster collapses", len(_decluster(_clu, 4.0)) < 8)
_norm = [(0, 0), (200, 0), (200, 15), (0, 15), (0, 30), (200, 30)]
check("normal passes unchanged by declustering", _decluster(_norm, 4.0) == _norm)

print("\n== buffer keeps SHARP corners (no rounding-arc vertex clusters) ==")
from backend.coverage import buffer_boundary, inset_boundary
_sqr = [(49.500, 24.000), (49.500, 24.004), (49.497, 24.004), (49.497, 24.000)]
_grown = buffer_boundary(_sqr, 3)       # the learned-bias outset
_inset = inset_boundary(_sqr, 5)        # the edge margin
# round join would fan each corner into ~8 vertices (~32 total); mitre keeps 4
check("bias outset keeps corners sharp (<=6 vtx, not ~32)",
      _grown is not None and len(_grown) <= 6)
check("margin inset keeps corners sharp (<=6 vtx)",
      _inset is not None and len(_inset) <= 6)

print("\n== obstacle exclusion is cut from coverage ==")
# Obstacles are now segmented by SAM under a click (detect_blob, needs imagery,
# covered ad-hoc). Here we lock the part that must never silently break: an
# obstacle polygon, fed back as an exclusion, is cut out of the coverage route.
from shapely.geometry import Point as _Point, Polygon as _Poly
_ofld = [(49.503, 23.996), (49.503, 24.004), (49.497, 24.004), (49.497, 23.996)]
_ob = [(49.5005, 23.9995), (49.5005, 24.0005), (49.4995, 24.0005), (49.4995, 23.9995)]
_wps = generate_coverage(_ofld, 12, 0.0, exclusions=[_ob])
_hole = _Poly([(lo, la) for la, lo in _ob]).buffer(-1e-6)
_inside = [w for w in _wps if _hole.contains(_Point(w[1], w[0]))]
check("coverage avoids the obstacle exclusion (no waypoint inside)", len(_inside) == 0)
check("coverage still produced around the obstacle", len(_wps) >= 6)

print("\n== sprayed vs excluded area (obstacles subtracted) ==")
from backend.coverage import covered_area_ha
_full = polygon_area_ha(_ofld)
_cov = covered_area_ha(_ofld, [_ob])
check("covered area < full field when an obstacle is cut",
      0 < _cov < _full)
check("no exclusions -> covered == full field",
      abs(covered_area_ha(_ofld, None) - _full) < 1e-9)
_rb = api.build_route({
    "boundary": [{"lat": la, "lng": lo} for la, lo in _ofld],
    "spacing": 12, "alt": 50, "speed": 12,
    "exclusions": [[{"lat": la, "lng": lo} for la, lo in _ob]],
})
check("build_route reports excluded_ha > 0 with an obstacle", _rb["excluded_ha"] > 0)
check("build_route: sprayed + excluded == field area",
      abs(_rb["sprayed_ha"] + _rb["excluded_ha"] - _rb["area_ha"]) < 0.01)

print("\n== all build_route features together (margin + auto-angle + exclusion + battery) ==")
_rc = api.build_route({
    "boundary": [{"lat": la, "lng": lo} for la, lo in _ofld],
    "spacing": 12, "auto_angle": True, "margin": 8, "alt": 50,
    "takeoff_alt": 10, "speed": 12, "rtl": True, "battery_min": 2,
    "exclusions": [[{"lat": la, "lng": lo} for la, lo in _ob]],
})
check("combined build ok", _rc["ok"])
check("combined: inset contour returned", len(_rc["contour"]) >= 3)
check("combined: obstacle still excluded", _rc["excluded_ha"] > 0)
check("combined: sprayed + excluded == area", abs(_rc["sprayed_ha"] + _rc["excluded_ha"] - _rc["area_ha"]) < 0.01)
check("combined: battery split into >=1 flight(s)", _rc["flights"] >= 1)
check("combined: angle_used reported", "angle_used" in _rc)

print("\n== spray-liquid planning (l/ha + tank refills) ==")
import math as _math
_rl = api.build_route({
    "boundary": [{"lat": la, "lng": lo} for la, lo in _ofld],
    "spacing": 15, "alt": 50, "speed": 12, "flow_lha": 200, "tank_l": 600,
})
check("liquid_l == sprayed_ha * rate", abs(_rl["liquid_l"] - _rl["sprayed_ha"] * 200) < 0.5)
check("refills == ceil(liquid / tank)", _rl["refills"] == _math.ceil(_rl["liquid_l"] / 600))
_r0 = api.build_route({
    "boundary": [{"lat": la, "lng": lo} for la, lo in _ofld],
    "spacing": 15, "alt": 50, "speed": 12,
})
check("no rate -> liquid 0 and no refills", _r0["liquid_l"] == 0 and _r0["refills"] == 0)

print("\n== bad-polygon robustness (no crash, graceful errors) ==")
# self-intersecting "bowtie" — easy to make by dragging a vertex across the field
_bow = api.build_route({"boundary": [
    {"lat": 49.500, "lng": 24.000}, {"lat": 49.500, "lng": 24.004},
    {"lat": 49.497, "lng": 24.000}, {"lat": 49.497, "lng": 24.004}],
    "spacing": 15, "alt": 50, "speed": 12})
check("self-intersecting polygon is repaired, not a crash", _bow["ok"] and _bow["count"] > 0)
_col = api.build_route({"boundary": [
    {"lat": 49.5, "lng": 24.0}, {"lat": 49.5, "lng": 24.001}, {"lat": 49.5, "lng": 24.002}],
    "spacing": 15})
check("collinear polygon -> graceful error (no crash)", _col["ok"] is False and "error" in _col)
_two = api.build_route({"boundary": [{"lat": 49.5, "lng": 24.0}, {"lat": 49.5, "lng": 24.001}],
                        "spacing": 15})
check("under 3 points -> graceful error", _two["ok"] is False and "error" in _two)

print("\n== export via Api (headless writes file) ==")
import os
os.chdir(os.path.dirname(os.path.abspath(__file__)))
for fmt, name in [("fence_plan", "field_fence.plan"), ("fence_mp", "field.fence"),
                  ("contour_geojson", "field_contour.geojson")]:
    r = api.export(fmt)
    ok = r["ok"] and os.path.exists(r["path"])
    check(f"export {fmt} wrote file", ok)
    if ok:
        os.remove(r["path"])

print()
if check.failed:
    print("RESULT: FAILURES PRESENT"); sys.exit(1)
print("RESULT: ALL CHECKS PASSED")
