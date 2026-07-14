"""Відступ від ВИРІЗІВ: маршрут має триматися від краю перешкоди на ту саму
дистанцію, що й від краю поля («Відступ від країв»). До цієї фічі вирізи
різались впритул — обприскування діставало гілки дерева, від якого користувач
і малював виріз."""
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from backend.api import Api
from backend.coverage import expand_exclusions
from backend.geo import latlon_to_local
from shapely.geometry import LineString, Polygon

LAT0, LON0 = 50.40, 30.60
M = 1.0 / 111320.0          # ~метр у градусах широти


def _rect(clat, clon, w_m, h_m):
    dlat = h_m / 2 * M
    dlon = w_m / 2 * M / math.cos(math.radians(clat))
    return [(clat - dlat, clon - dlon), (clat - dlat, clon + dlon),
            (clat + dlat, clon + dlon), (clat + dlat, clon - dlon)]


FIELD = _rect(LAT0, LON0, 400, 400)          # 16 га квадрат
TREE = _rect(LAT0, LON0, 30, 30)             # виріз 30×30 м у центрі


def _min_dist_to_exclusion(waypoints, exclusion):
    """Мінімальна відстань МАРШРУТУ (сегментів, не лише вершин) до полігона
    вирізу, в метрах (локальна проєкція навколо вирізу)."""
    clat = sum(p[0] for p in exclusion) / len(exclusion)
    clon = sum(p[1] for p in exclusion) / len(exclusion)
    ex = Polygon([latlon_to_local(la, lo, clat, clon) for la, lo in exclusion])
    def _ll(p):
        return (p["lat"], p["lng"]) if isinstance(p, dict) else (p[0], p[1])
    path = LineString([latlon_to_local(*_ll(p), clat, clon) for p in waypoints])
    return path.distance(ex)


def _d(ring):
    """У форматі, який шле фронтенд: список {lat, lng}."""
    return [{"lat": la, "lng": lo} for la, lo in ring]


def _build(margin):
    r = Api().build_route({
        "boundary": _d(FIELD), "spacing": 15, "angle": 0, "auto_angle": False,
        "margin": margin, "exclusions": [_d(TREE)], "battery_min": 0,
    })
    assert r.get("ok"), r.get("error")
    return r


def test_route_keeps_margin_from_exclusion():
    margin = 8.0
    r = _build(margin)
    d = _min_dist_to_exclusion(r["waypoints"], TREE)
    # Свот = spacing/2 по обидва боки лінії — центрлайн і так тримає半 свота;
    # вимога фічі: ЩЕ margin від краю вирізу. Допуск 1 м на дискретизацію.
    assert d >= margin - 1.0, f"маршрут за {d:.1f} м від вирізу, потрібно ≥ {margin}"


def test_margin_zero_cuts_flush():
    r = _build(0)
    d = _min_dist_to_exclusion(r["waypoints"], TREE)
    assert d < 6.0, f"без відступу маршрут мав іти близько до вирізу, а йде за {d:.1f} м"


def test_excluded_area_grows_with_margin():
    a0 = _build(0)
    a8 = _build(8.0)
    assert a8["excluded_ha"] > a0["excluded_ha"], (
        f"excluded_ha має вирости з буфером: {a0['excluded_ha']} -> {a8['excluded_ha']}")


def test_expand_exclusions_geometry():
    out = expand_exclusions([TREE], 10.0)
    assert len(out) == 1 and len(out[0]) >= 4
    clat = sum(p[0] for p in TREE) / len(TREE)
    clon = sum(p[1] for p in TREE) / len(TREE)
    raw = Polygon([latlon_to_local(la, lo, clat, clon) for la, lo in TREE])
    grown = Polygon([latlon_to_local(la, lo, clat, clon) for la, lo in out[0]])
    assert grown.contains(raw)
    # 30×30 + 10 м мітра-буфер ≈ 50×50 = 2500 м² (мітра тримає гострі кути)
    assert abs(grown.area - 2500.0) < 150.0, grown.area
    # мітра: вершин небагато, без дугових скупчень
    assert len(out[0]) <= 12
    # margin 0 → без змін
    same = expand_exclusions([TREE], 0)
    assert same == [[(la, lo) for la, lo in TREE]]


if __name__ == "__main__":
    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print("  ok ", name)
            except AssertionError as e:
                fails += 1
                print("  FAIL", name, "—", e)
    raise SystemExit(1 if fails else 0)
