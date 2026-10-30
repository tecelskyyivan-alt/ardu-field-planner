"""Engine regressions found by the 2026-10-29 UI sweep (real browser, drawn shapes)."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from backend.api import Api, MAX_FIELD_HA  # noqa: E402

# Drawn at zoom 16 near Kyiv: field ~300 m square + a square exclusion, spacing 15 m.
# The overlap overlay came back as a GeometryCollection -> AttributeError '.exterior'
# failed the WHOLE build, not just the cosmetic layer.
FIELD = [{"lat": 50.452012, "lng": 30.5226803}, {"lat": 50.452012, "lng": 30.5286884}, {"lat": 50.4481863, "lng": 30.5286884}, {"lat": 50.4481863, "lng": 30.5226803}]
EXCL = [[{"lat": 50.4502924, "lng": 30.5261863}, {"lat": 50.4502924, "lng": 30.5267932}, {"lat": 50.4499059, "lng": 30.5267932}, {"lat": 50.4499059, "lng": 30.5261863}]]


def test_overlap_geometrycollection_does_not_fail_build():
    res = Api().build_route({"boundary": FIELD, "exclusions": EXCL, "spacing": 15, "angle": 178,
                             "auto_angle": True, "alt": 30, "speed": 12, "rtl": True, "viz": True})
    assert res["ok"], res.get("error")
    assert res["count"] > 10


def test_region_sized_contour_is_refused_with_a_reason():
    # ~370 x 380 km: a contour drawn on a zoomed-out map.
    huge = [{"lat": 50.117, "lng": 30.579}, {"lat": 50.117, "lng": 35.753},
            {"lat": 46.684, "lng": 35.753}, {"lat": 46.684, "lng": 30.579}]
    res = Api().build_route({"boundary": huge, "spacing": 20})
    assert not res["ok"] and "завелике" in res["error"]


def test_area_limit_does_not_touch_real_fields():
    field = [{"lat": 50.45, "lng": 30.52}, {"lat": 50.45, "lng": 30.53},
             {"lat": 50.455, "lng": 30.53}, {"lat": 50.455, "lng": 30.52}]
    res = Api().build_route({"boundary": field, "spacing": 20})
    assert res["ok"] and res["area_ha"] < MAX_FIELD_HA


def test_export_files_work_without_a_server():
    # The web/APK export buttons used /api/export (desktop only) -> 404 on GitHub Pages.
    api = Api()
    assert not api.export_files("waypoints")["ok"]            # nothing built yet
    assert api.build_route({"boundary": FIELD, "spacing": 20})["ok"]
    for fmt, name, head in [("waypoints", "mission.waypoints", "QGC WPL 110"), ("plan", "mission.plan", "{"),
                            ("fence_plan", "field_fence.plan", "{"), ("fence_mp", "field.fence", ""),
                            ("contour_geojson", "field_contour.geojson", "{")]:
        r = api.export_files(fmt)
        assert r["ok"], (fmt, r)
        assert [f["name"] for f in r["files"]] == [name]
        assert r["files"][0]["content"].lstrip().startswith(head) and len(r["files"][0]["content"]) > 20
    assert not api.export_files("nope")["ok"]


# 287 ha, concave, 4 cut-outs: in the browser/APK engine (Pyodide, GEOS 3.12) angle 30° (spacing 20)
# and 5° (spacing 12) threw TopologyException from the swath overlays — fatal there. Native GEOS
# doesn't throw, so this guards the geometry path, and _swath must keep the old buffer's area.
BIG_FIELD = [{"lat": 50.4, "lng": 30.3}, {"lat": 50.3986525, "lng": 30.329595}, {"lat": 50.4053899, "lng": 30.3324135}, {"lat": 50.411678, "lng": 30.3267764}, {"lat": 50.4103306, "lng": 30.3155021}, {"lat": 50.4125764, "lng": 30.3056371}, {"lat": 50.4071865, "lng": 30.2985907}]
BIG_EXCL = [[{"lat": 50.4035932, "lng": 30.3070464}, {"lat": 50.4035932, "lng": 30.3087376}, {"lat": 50.4046712, "lng": 30.3087376}, {"lat": 50.4046712, "lng": 30.3070464}], [{"lat": 50.4026949, "lng": 30.3169114}, {"lat": 50.4029644, "lng": 30.3187435}, {"lat": 50.4041322, "lng": 30.3184616}, {"lat": 50.4039526, "lng": 30.3167705}], [{"lat": 50.4062882, "lng": 30.3239578}, {"lat": 50.4064678, "lng": 30.3253671}, {"lat": 50.407456, "lng": 30.3250852}, {"lat": 50.4072763, "lng": 30.3238169}], [{"lat": 50.4080848, "lng": 30.3112743}, {"lat": 50.4080848, "lng": 30.3126836}, {"lat": 50.4089831, "lng": 30.3126836}, {"lat": 50.4089831, "lng": 30.3112743}]]


def test_big_field_with_cutouts_builds_at_every_angle():
    for spacing, angles in ((20, range(0, 180, 15)), (12, (5, 30, 95))):
        for a in angles:
            res = Api().build_route({"boundary": BIG_FIELD, "exclusions": BIG_EXCL, "spacing": spacing,
                                      "angle": a, "auto_angle": False, "viz": True})
            assert res["ok"], (spacing, a, res.get("error"))
            assert res["coverage_pct"] > 95, (spacing, a, res["coverage_pct"])


def test_swath_matches_line_buffer_area():
    import random
    from shapely.geometry import LineString
    from backend.coverage import _swath
    rnd = random.Random(1)
    for _ in range(30):
        pts = [(0.0, 0.0)]
        for _i in range(rnd.randint(2, 40)):
            pts.append((pts[-1][0] + rnd.uniform(-200, 200), pts[-1][1] + rnd.uniform(-200, 200)))
        h = rnd.uniform(3, 15)
        ref = LineString(pts).buffer(h, cap_style=2).area
        assert abs(_swath(pts, h).area - ref) / ref < 1e-3


if __name__ == "__main__":
    for _n, _f in list(globals().items()):
        if _n.startswith("test_") and callable(_f):
            _f()
            print("  OK ", _n)
    print("RESULT: ALL CHECKS PASSED")
