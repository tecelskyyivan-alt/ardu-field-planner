"""Тести webmerc (мерк. математика + similarity fit) і geocode (газетир).

Запуск з кореня репо:  ./.venv-photo/bin/python -m pytest tests/test_photo_geo.py -v

Тести газетира скіпаються, якщо data/gazetteer.sqlite ще не збудовано
(scripts/build_gazetteer.py). Мережевий тест повного білда — лише за
FMP_NET_TESTS=1.
"""
import math
import os
import sys

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

from backend import webmerc
from backend.geo import haversine

GAZETTEER = os.path.join(REPO_ROOT, "data", "gazetteer.sqlite")
needs_gazetteer = pytest.mark.skipif(
    not os.path.exists(GAZETTEER),
    reason="нема data/gazetteer.sqlite — запусти scripts/build_gazetteer.py")
needs_net = pytest.mark.skipif(
    os.environ.get("FMP_NET_TESTS") != "1",
    reason="мережевий тест — увімкни FMP_NET_TESTS=1")


# ---------------------------------------------------------------- webmerc ---

def test_merc_known_values():
    assert webmerc.lonlat_to_merc(0.0, 0.0) == (0.0, 0.0)
    x, _ = webmerc.lonlat_to_merc(180.0, 0.0)
    assert abs(x - 20037508.342789244) < 1e-6
    _, y = webmerc.lonlat_to_merc(0.0, webmerc.MAX_LAT)
    assert abs(y - 20037508.342789244) < 1e-3


def test_merc_roundtrip():
    for lon, lat in [(31.21372, 50.31699), (-122.4, 37.77), (0.0, 0.0),
                     (179.9, -84.0), (-0.001, 0.001)]:
        lon2, lat2 = webmerc.merc_to_lonlat(*webmerc.lonlat_to_merc(lon, lat))
        assert abs(lon2 - lon) < 1e-9 and abs(lat2 - lat) < 1e-9


def test_tile_helpers():
    # Бзів, z=14: точка мусить лежати всередині меркаторних меж свого тайла
    lon, lat = 31.21372, 50.31699
    xt, yt, z = webmerc.tile_xyz_of(lon, lat, 14)
    assert z == 14 and 0 <= xt < 2 ** 14 and 0 <= yt < 2 ** 14
    xmin, ymin, xmax, ymax = webmerc.tile_bounds_merc(xt, yt, 14)
    mx, my = webmerc.lonlat_to_merc(lon, lat)
    assert xmin <= mx < xmax and ymin <= my < ymax
    # Сусідній тайл на південь (yt+1) — нижче в меркаторі
    _, _, _, ymax_s = webmerc.tile_bounds_merc(xt, yt + 1, 14)
    assert abs(ymax_s - ymin) < 1e-6
    # Тайл (0,0) на z=0 — увесь світ
    b = webmerc.tile_bounds_merc(0, 0, 0)
    assert abs(b[0] + webmerc.MERC_MAX) < 1e-6 and abs(b[3] - webmerc.MERC_MAX) < 1e-6


def test_meters_per_pixel():
    assert abs(webmerc.meters_per_pixel(0.0, 0) - 156543.03392804097) < 1e-6
    # cos(60°) = 0.5
    assert abs(webmerc.meters_per_pixel(60.0, 10) -
               156543.03392804097 / 1024 * 0.5) < 1e-9


def _make_transform(scale, rot_deg, tx, ty):
    """Еталонна пряма модель: merc = s*R(rot) @ (px, -py) + (tx, ty)."""
    th = math.radians(rot_deg)

    def fwd(px, py):
        fx, fy = px, -py  # y-flip
        return (scale * (fx * math.cos(th) - fy * math.sin(th)) + tx,
                scale * (fx * math.sin(th) + fy * math.cos(th)) + ty)
    return fwd


def test_fit_similarity_recovers_synthetic():
    # Скріншот ~z16 біля Києва: масштаб ~1.5 м/пкс, поворот 1.7°, зсув у 3857
    scale, rot_deg = 1.53, 1.7
    tx, ty = 3474000.0, 6493000.0  # ~(31.2E, 50.3N) у метрах 3857
    fwd = _make_transform(scale, rot_deg, tx, ty)
    px_pts = [(100, 80), (1050, 130), (600, 640), (250, 500), (900, 420)]
    merc_pts = [fwd(*p) for p in px_pts]
    t = webmerc.fit_similarity(px_pts, merc_pts)
    assert t["rmse_m"] < 0.5  # фактично ~1e-9 — точні синтетичні дані
    assert abs(t["scale"] - scale) < 1e-9
    assert abs(math.degrees(t["rot_rad"]) - rot_deg) < 1e-9
    assert abs(t["tx"] - tx) < 1e-6 and abs(t["ty"] - ty) < 1e-6
    # apply_similarity відтворює контрольні точки
    for (mx, my), (ax, ay) in zip(merc_pts, webmerc.apply_similarity(t, px_pts)):
        assert math.hypot(mx - ax, my - ay) < 1e-6


def test_fit_similarity_two_points_exact():
    fwd = _make_transform(0.6, -2.0, 3470000.0, 6490000.0)
    px_pts = [(200, 300), (950, 550)]
    merc_pts = [fwd(*p) for p in px_pts]
    t = webmerc.fit_similarity(px_pts, merc_pts)
    assert t["rmse_m"] < 1e-6  # 2 точки -> точний розв'язок
    assert abs(t["scale"] - 0.6) < 1e-9
    assert abs(math.degrees(t["rot_rad"]) + 2.0) < 1e-9


def test_fit_similarity_yflip_direction():
    """Точка нижче на екрані (більший py) мусить лягти південніше (менший y)."""
    fwd = _make_transform(1.0, 0.0, 3474000.0, 6493000.0)
    px_pts = [(0, 0), (500, 0), (0, 400)]
    t = webmerc.fit_similarity(px_pts, [fwd(*p) for p in px_pts])
    (_, y_top), (_, y_bottom) = webmerc.apply_similarity(t, [(100, 50), (100, 350)])
    assert y_bottom < y_top


def test_fit_similarity_reports_honest_rmse():
    """Зашумлені контрольні точки -> rmse_m відображає реальний залишок."""
    fwd = _make_transform(1.5, 1.0, 3474000.0, 6493000.0)
    px_pts = [(100, 100), (1000, 120), (550, 600), (150, 550), (980, 580)]
    noise = [(2.0, -1.5), (-1.8, 2.2), (1.1, 1.9), (-2.4, -0.7), (1.6, -2.0)]  # пкс
    merc_pts = [fwd(px + nx, py + ny) for (px, py), (nx, ny) in zip(px_pts, noise)]
    t = webmerc.fit_similarity(px_pts, merc_pts)
    # ~2 пкс шуму * 1.5 м/пкс -> залишок метрового порядку, НЕ нуль
    assert 0.5 < t["rmse_m"] < 10.0


def test_fit_similarity_degenerate_raises():
    with pytest.raises(ValueError):
        webmerc.fit_similarity([(1, 1)], [(2, 2)])
    with pytest.raises(ValueError):
        webmerc.fit_similarity([(1, 1), (1, 1)], [(0, 0), (5, 5)])
    with pytest.raises(ValueError):
        webmerc.fit_similarity([(1, 1), (2, 2), (3, 3)], [(0, 0), (1, 1)])


def test_px_ring_to_lonlat():
    fwd = _make_transform(1.2, 0.5, 3474000.0, 6493000.0)
    anchors = [(50, 50), (1100, 90), (600, 620)]
    t = webmerc.fit_similarity(anchors, [fwd(*p) for p in anchors])
    ring_px = [(300, 200), (500, 200), (500, 400), (300, 400)]
    ring_ll = webmerc.px_ring_to_lonlat(t, ring_px)
    assert len(ring_ll) == 4
    for (lon, lat), (px, py) in zip(ring_ll, ring_px):
        elon, elat = webmerc.merc_to_lonlat(*fwd(px, py))
        assert haversine(lat, lon, elat, elon) < 0.01  # < 1 см
    # правдоподібний район (Київщина)
    assert all(30.0 < lon < 33.0 and 49.0 < lat < 52.0 for lon, lat in ring_ll)


# ---------------------------------------------------------------- geocode ---

def test_normalize_name():
    from backend.geocode import normalize_name
    assert normalize_name("Мар'янівка") == normalize_name("Марʼянівка") == "марянівка"
    assert normalize_name("  БЗІВ ") == "бзів"
    # гомогліфи: латинська i в кириличному слові -> і; чиста латиниця не чіпається
    assert normalize_name("Бзiв") == "бзів"
    assert normalize_name("Bziv") == "bziv"
    # е/є та и/і НЕ змішуються
    assert normalize_name("Березань") != normalize_name("Бєрєзань")


@needs_gazetteer
def test_gazetteer_bziv_voloshynivka():
    from backend.geocode import lookup
    bziv = lookup("Бзів")
    assert len(bziv) == 1
    assert abs(bziv[0]["lat"] - 50.31699) < 1e-4
    assert abs(bziv[0]["lon"] - 31.21372) < 1e-4
    assert bziv[0]["admin1"] == "13"  # Київська область

    vol = lookup("Волошинівка")
    assert len(vol) == 1
    assert abs(vol[0]["lat"] - 50.3173) < 1e-4
    assert abs(vol[0]["lon"] - 31.3191) < 1e-4

    # пара з agro_gis_1.jpg — один скріншот, < 40 км (фактично ~7.5 км)
    d_km = haversine(bziv[0]["lat"], bziv[0]["lon"],
                     vol[0]["lat"], vol[0]["lon"]) / 1000.0
    assert d_km < 40.0


@needs_gazetteer
def test_gazetteer_bobryk_many():
    from backend.geocode import lookup
    cands = lookup("Бобрик", limit=20)
    assert len(cands) >= 5  # Бобриків в Україні багато — так і має бути
    # серед них є київський (Броварський р-н) — потрібен для agro_gis_2.jpg
    assert any(abs(c["lat"] - 50.65211) < 1e-3 and abs(c["lon"] - 31.09158) < 1e-3
               for c in cands)


@needs_gazetteer
def test_lookup_fuzzy_ocr_errors():
    from backend.geocode import lookup
    # гомогліф (латинська i) -> точний збіг через normalize_name
    assert lookup("Бзiв")[0]["name"] == "Бзів"
    assert lookup("Бзiв")[0]["score"] == 100.0
    # реальна OCR-помилка літери -> fuzzy >= 85. Перше місце НЕ гарантоване:
    # "Волошиновка" ближча (1 правка) до рос. варіанта сумської Волошнівки,
    # ніж до Волошинівки (2 правки) — модуль чесно віддає обидві, вибирає
    # disambiguate/підтвердження на мапі.
    cands = lookup("Волошиновка")  # и замість і
    names = [c["name"] for c in cands]
    assert "Волошинівка" in names
    assert all(c["score"] >= 85.0 for c in cands)
    # сміття не мусить нічого знаходити
    assert lookup("Кзхйцщш") == []


@needs_gazetteer
def test_disambiguate_pair_confident():
    from backend.geocode import lookup, disambiguate
    d = disambiguate({"Бзів": lookup("Бзів"), "Волошинівка": lookup("Волошинівка")})
    assert d["confident"] is True
    assert d["n_combos"] == 1
    assert abs(d["chosen"]["Бзів"]["lat"] - 50.31699) < 1e-4
    assert abs(d["chosen"]["Волошинівка"]["lon"] - 31.3191) < 1e-4


@needs_gazetteer
def test_disambiguate_bobryk_alone_ambiguous():
    from backend.geocode import lookup, disambiguate
    d = disambiguate({"Бобрик": lookup("Бобрик")})
    assert d["confident"] is False        # багато Бобриків, перевірити нема чим
    assert d["n_combos"] > 1
    assert d["chosen"]["Бобрик"] is not None   # найкраща гіпотеза все ж є
    assert len(d["alternates"]["Бобрик"]) >= 4  # ...але альтернатив повно


@needs_gazetteer
def test_disambiguate_cluster_consensus_picks_kyiv_bobryk():
    """3 мітки: з 9 Бобриків географічний кластер лишає рівно київський.

    Київський Бобрик за 38.3 км від Бзова, але за 40.7 км від Волошинівки,
    тому строгий поріг 40 км чесно дає 0 комбінацій, а 45 км — рівно одну.
    """
    from backend.geocode import lookup, disambiguate
    labels = {"Бзів": lookup("Бзів"), "Волошинівка": lookup("Волошинівка"),
              "Бобрик": lookup("Бобрик")}
    strict = disambiguate(labels, max_km=40.0)
    assert strict["confident"] is False and strict["n_combos"] == 0
    wide = disambiguate(labels, max_km=45.0)
    assert wide["confident"] is True and wide["n_combos"] == 1
    assert abs(wide["chosen"]["Бобрик"]["lat"] - 50.65211) < 1e-3
    assert abs(wide["chosen"]["Бобрик"]["lon"] - 31.09158) < 1e-3
    assert wide["chosen"]["Бобрик"]["admin1"] == "13"


def test_build_gazetteer_offline_parse(tmp_path):
    """build() на синтетичному UA.txt — без мережі."""
    from scripts.build_gazetteer import build
    from backend.geocode import lookup
    fake = (
        "1\tBziv\tBziv\tБзів,Bzev\t50.317\t31.2137\tP\tPPL\tUA\t\t13\t\t\t\t819\t\t120\tEurope/Kyiv\t2024-01-01\n"
        "2\tKyiv\tKyiv\tКиїв,Kiev\t50.45\t30.52\tP\tPPLC\tUA\t\t12\t\t\t\t2963199\t\t180\tEurope/Kyiv\t2024-01-01\n"
        "3\tDnipro River\tDnipro\tДніпро\t50.0\t30.0\tH\tSTM\tUA\t\t\t\t\t\t0\t\t90\tEurope/Kyiv\t2024-01-01\n"
    ).encode("utf-8")
    out = str(tmp_path / "gaz.sqlite")
    places, rows = build(out, txt_bytes=fake)
    assert places == 2                      # H (річка) відфільтрована
    assert rows == 6                        # bziv,бзів,bzev + kyiv,київ,kiev
    got = lookup("Бзів", db_path=out, fuzzy=False)
    assert len(got) == 1 and got[0]["population"] == 819
    assert lookup("Дніпро", db_path=out, fuzzy=False) == []


@needs_net
def test_build_gazetteer_network(tmp_path):
    """Повний білд із download.geonames.org (FMP_NET_TESTS=1)."""
    from scripts.build_gazetteer import build
    places, rows = build(str(tmp_path / "gaz_net.sqlite"))
    assert places > 25000 and rows > 100000
