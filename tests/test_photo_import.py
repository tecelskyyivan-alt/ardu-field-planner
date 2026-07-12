"""E2E тести фото-імпорту: backend/photo_import.py + HTTP-маршрут serve.py.

Запуск з кореня репо:
    ./.venv-photo/bin/python -m pytest tests/test_photo_import.py -v

Основні тести — БЕЗ мережі (fetch_tile=None -> прив'язка лише по підписах,
band="yellow" завжди). Тест з реальними тайлами — лише за FMP_NET_TESTS=1.
Тести на фікстурах скіпаються, якщо нема tests/fixtures/agro_gis_*.jpg
(особисті скріншоти, гітігнорені) чи data/gazetteer.sqlite.
"""
import base64
import json
import os
import sys
import urllib.error
import urllib.request

import cv2
import numpy as np
import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

from backend import photo_import  # noqa: E402
from backend.geo import haversine  # noqa: E402

FIX1 = os.path.join(REPO_ROOT, "tests", "fixtures", "agro_gis_1.jpg")
FIX2 = os.path.join(REPO_ROOT, "tests", "fixtures", "agro_gis_2.jpg")
GAZETTEER = os.path.join(REPO_ROOT, "data", "gazetteer.sqlite")

needs_fixtures = pytest.mark.skipif(
    not (os.path.exists(FIX1) and os.path.exists(FIX2)),
    reason="нема tests/fixtures/agro_gis_*.jpg (локальні, гітігнорені)")
needs_gazetteer = pytest.mark.skipif(
    not os.path.exists(GAZETTEER),
    reason="нема data/gazetteer.sqlite — запусти scripts/build_gazetteer.py")
needs_net = pytest.mark.skipif(
    os.environ.get("FMP_NET_TESTS") != "1",
    reason="мережевий тест — увімкни FMP_NET_TESTS=1")

# Геокодовані опорні точки (з газетира; перевірені в test_photo_geo.py)
BZIV = (50.31699, 31.21372)          # Бзів, Київська обл.
VOLOSH = (50.3173, 31.3191)          # Волошинівка, Київська обл.
BOBRYK_KYIV = (50.65211, 31.09158)   # Бобрик, Броварський р-н (з 9 Бобриків)

CONTRACT_KEYS = {"ok", "band", "confidence", "needs_confirm",
                 "labels", "georef", "contours", "diag"}


def _synthetic_no_labels():
    """Синтетика: пурпурний прямокутник на «сателітному» зеленому тлі, без
    підписів. LAB пурпурного (a*=55, b*=-47) упевнено проходить гейти
    color_seg; тло (a*=-22, b*=+29) — природна тепла зелень."""
    img = np.full((360, 500, 3), (60, 120, 90), dtype=np.uint8)
    cv2.rectangle(img, (150, 100), (350, 220), (190, 70, 160), -1)
    ok, buf = cv2.imencode(".png", img)
    assert ok
    return buf.tobytes()


def _all_ring_pts(res):
    for c in res["contours"]:
        for p in c["ring"]:
            yield p["lat"], p["lng"]


# ---------------------------------------------------------------- fixtures --

@pytest.fixture(scope="module")
def res1():
    """agro_gis_1 офлайн (fetch_tile=None): 2 підписи -> similarity."""
    with open(FIX1, "rb") as f:
        return photo_import.import_photo(f.read(), fetch_tile=None)


@pytest.fixture(scope="module")
def res2():
    """agro_gis_2 офлайн: 1 підпис «Бобрик» + region_hint (неоднозначність)."""
    with open(FIX2, "rb") as f:
        return photo_import.import_photo(f.read(), fetch_tile=None,
                                         region_hint=(50.4, 31.0))


# ------------------------------------------------------ agro_gis_1 (2 мітки) --

@needs_fixtures
@needs_gazetteer
def test_fixture1_contract_shape(res1):
    assert CONTRACT_KEYS <= set(res1)
    assert res1["ok"] is True
    assert res1["band"] == "yellow"          # без тайлів зеленого НЕ буває
    assert res1["needs_confirm"] is True     # завжди, незалежно від band
    assert 0.0 < res1["confidence"] < 1.0
    json.dumps(res1)                         # відповідь мусить бути чистим JSON


@needs_fixtures
@needs_gazetteer
def test_fixture1_labels_resolved(res1):
    by_text = {l["text"]: l for l in res1["labels"]}
    assert "Бзів" in by_text and "Волошинівка" in by_text
    for text, (lat, lon) in (("Бзів", BZIV), ("Волошинівка", VOLOSH)):
        l = by_text[text]
        assert abs(l["lat"] - lat) < 1e-3 and abs(l["lon"] - lon) < 1e-3
        assert len(l["px"]) == 2
    # пара сіл < 45 км => кластер однозначний
    assert res1["diag"]["geocode"]["confident"] is True
    assert res1["diag"]["geocode"]["n_combos"] == 1


@needs_fixtures
@needs_gazetteer
def test_fixture1_contours(res1):
    cs = res1["contours"]
    assert len(cs) >= 14                     # color_seg дає 17 purple + 2 red
    for c in cs:
        assert c["name"].startswith("Поле ") and "з фото" in c["name"]
        assert c["cls"] in ("purple", "red", "blue")
        assert c["holes"] == []
        assert 1.0 <= c["area_ha"] <= 200.0
        assert 3 <= len(c["ring"]) <= photo_import.MAX_VERTICES
    # УСІ вершини — в межах 30 км від Бзова (правдоподібна геолокація)
    for lat, lng in _all_ring_pts(res1):
        assert haversine(lat, lng, *BZIV) < 30_000.0
    # мін. крок вершин у метрах після трансформу
    for c in cs:
        ring = c["ring"]
        for p, q in zip(ring, ring[1:]):
            assert haversine(p["lat"], p["lng"], q["lat"], q["lng"]) \
                >= photo_import.MIN_VERTEX_GAP_M - 0.01


@needs_fixtures
@needs_gazetteer
def test_fixture1_georef_honest(res1):
    g = res1["georef"]
    assert g["method"] == "labels"           # similarity по 2 підписах
    # 2 контрольні точки -> fit точний, rmse 0.0. Це НЕ означає точність —
    # тому band lишається yellow і needs_confirm=True.
    assert g["rmse_m"] == 0.0
    assert g["inliers"] == 0                 # registration не запускалась
    # масштаб у diag — справжні метри на піксель, правдоподібний для веб-ГІС
    assert 5.0 < res1["diag"]["scale_m_per_px"] < 40.0


# ------------------------------------------- agro_gis_2 (1 мітка, 9 Бобриків) --

@needs_fixtures
@needs_gazetteer
def test_fixture2_bobryk_hint(res2):
    assert res2["ok"] is True
    assert res2["band"] == "yellow"
    assert res2["needs_confirm"] is True
    by_text = {l["text"]: l for l in res2["labels"]}
    assert "Бобрик" in by_text
    # region_hint (50.4, 31.0) вибирає київський Бобрик з 9 однойменних…
    l = by_text["Бобрик"]
    assert abs(l["lat"] - BOBRYK_KYIV[0]) < 0.02
    assert abs(l["lon"] - BOBRYK_KYIV[1]) < 0.02
    # …але неоднозначність ЧЕСНО зафіксована: не confident + альтернативи
    assert res2["diag"]["geocode"]["confident"] is False
    assert len(res2["diag"]["geocode"]["alternates"]["Бобрик"]) >= 1
    assert res2["georef"]["method"] == "label1_anchor"
    assert res2["georef"]["rmse_m"] is None  # 1 точка: залишку не існує
    assert "assumed_zoom" in res2["diag"]    # масштаб припущений -> площі орієнтовні


@needs_fixtures
@needs_gazetteer
def test_fixture2_contours_near_bobryk(res2):
    assert len(res2["contours"]) >= 4        # великі блоки ріжуться на частини
    for lat, lng in _all_ring_pts(res2):
        assert haversine(lat, lng, *BOBRYK_KYIV) < 30_000.0
    json.dumps(res2)


# ----------------------------------------------------------- краї конвеєра --

def test_no_labels_yields_manual_placement_error():
    res = photo_import.import_photo(_synthetic_no_labels(), fetch_tile=None)
    assert res["ok"] is False
    assert res["band"] == "yellow"
    assert res["needs_confirm"] is True
    assert "вручну" in res["error"]          # пояснює ручне розміщення
    assert res["diag"]["n_fields_px"] >= 1   # поле знайдено, прив'язати нема чим
    assert res["contours"] == []
    json.dumps(res)


def test_garbage_and_empty_bytes():
    bad = photo_import.import_photo(b"this is not an image", fetch_tile=None)
    assert bad["ok"] is False and bad["band"] == "red" and bad["error"]
    empty = photo_import.import_photo(b"", fetch_tile=None)
    assert empty["ok"] is False and empty["band"] == "red"


def test_region_hint_normalization():
    f = photo_import._norm_hint
    assert f((50.4, 31.0)) == (50.4, 31.0)
    assert f([50.4, 31.0]) == (50.4, 31.0)
    assert f({"lat": 50.4, "lng": 31.0}) == (50.4, 31.0)
    assert f({"lat": 50.4, "lon": 31.0}) == (50.4, 31.0)
    assert f(None) is None
    assert f({"lat": 999, "lng": 31.0}) is None
    assert f("сміття") is None


def test_similarity_matrix_matches_webmerc():
    """Матриця з fit_similarity відтворює webmerc.apply_similarity точно."""
    from backend import webmerc
    t = {"scale": 22.36, "rot_rad": 0.0174, "tx": 3468728.4, "ty": 6506897.9}
    A = photo_import._similarity_to_matrix(t)
    for px in [(0.0, 0.0), (262.5, 252.5), (1100.0, 640.0)]:
        mx, my = webmerc.apply_similarity(t, [px])[0]
        ax, ay = photo_import._apply_a(A, *px)
        assert abs(mx - ax) < 1e-6 and abs(my - ay) < 1e-6


# ------------------------------------------------------------- HTTP (serve) --

@pytest.fixture(scope="module")
def base_url():
    import serve
    port = serve.start(0)                    # ОС вибере вільний порт
    return "http://127.0.0.1:%d" % port


def _post(base, path, body, timeout=180):
    req = urllib.request.Request(
        base + path, data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, json.loads(r.read().decode("utf-8"))


def test_serve_import_photo_contract(base_url):
    """Малий base64-скріншот через POST /api/import_photo: форма контракту."""
    b64 = base64.b64encode(_synthetic_no_labels()).decode("ascii")
    st, res = _post(base_url, "/api/import_photo",
                    {"image_b64": b64, "allow_net": False})
    assert st == 200
    assert CONTRACT_KEYS <= set(res)
    assert res["needs_confirm"] is True
    assert res["ok"] is False and res["error"]      # синтетика без підписів
    assert res["diag"]["n_fields_px"] >= 1


def test_serve_import_photo_data_url(base_url):
    """data:-URL префікс має зрізатись в api.import_photo."""
    b64 = base64.b64encode(_synthetic_no_labels()).decode("ascii")
    st, res = _post(base_url, "/api/import_photo",
                    {"image_b64": "data:image/png;base64," + b64,
                     "allow_net": False})
    assert st == 200 and res["diag"]["n_fields_px"] >= 1


@needs_fixtures
@needs_gazetteer
def test_serve_import_photo_fixture2_e2e(base_url):
    """Повний шлях по HTTP: реальний скріншот + region_hint як {lat, lng}."""
    with open(FIX2, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    st, res = _post(base_url, "/api/import_photo",
                    {"image_b64": b64, "allow_net": False,
                     "region_hint": {"lat": 50.4, "lng": 31.0}})
    assert st == 200
    assert res["ok"] is True and res["band"] == "yellow"
    assert res["needs_confirm"] is True
    assert len(res["contours"]) >= 4
    assert any(l["text"] == "Бобрик" for l in res["labels"])


def _post_refused(base, path, body_bytes):
    """POST, який сервер мусить відкинути по Content-Length: чекаємо 413.
    Тіло > сокет-буфера, тож клієнт може впертись у скинуте з'єднання ще до
    того, як прочитає відповідь — це ТЕЖ доказ відмови, приймаємо обидва."""
    req = urllib.request.Request(base + path, data=body_bytes,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except (urllib.error.URLError, ConnectionError, OSError):
        return 413                            # з'єднання скинуто = відкинуто


def test_serve_body_caps(base_url):
    # 2.5 МБ у import_photo ПРОХОДИТЬ (старий глобальний кап був 1 МБ)…
    junk = json.dumps({"image_b64": "QUJD" * 700_000, "allow_net": False})
    st, res = _post(base_url, "/api/import_photo",
                    json.loads(junk), timeout=60)
    assert st == 200
    assert res["ok"] is False and res["band"] == "red"   # сміття ≠ зображення
    # …той самий розмір у build_route — 413 (кап піднято ЛИШЕ import_photo)
    assert _post_refused(base_url, "/api/build_route",
                         junk.encode("utf-8")) == 413
    # 9 МБ навіть в import_photo — 413 (стеля 8 МБ)
    big = json.dumps({"image_b64": "QUJD" * 2_300_000}).encode("utf-8")
    assert _post_refused(base_url, "/api/import_photo", big) == 413


# ------------------------------------------------------------ мережа (opt-in) --

@needs_net
@needs_fixtures
@needs_gazetteer
def test_fixture1_with_real_tiles():
    """FMP_NET_TESTS=1: agro_gis_1 + реальні тайли через make_tile_fetcher.

    Живий band може бути yellow (крос-чек по вузлах GeoNames ~0.5–1 км —
    задокументовано в registration) — головне, що конвеєр не падає, контури
    лишаються правдоподібними, а green без підстав не видається."""
    fetch = photo_import.make_tile_fetcher()
    with open(FIX1, "rb") as f:
        res = photo_import.import_photo(f.read(), fetch_tile=fetch)
    assert res["ok"] is True
    assert res["band"] in ("green", "yellow")
    assert res["needs_confirm"] is True
    assert "registration" in res["diag"]     # уточнення справді запускалось
    if res["band"] == "green":
        assert res["georef"]["method"] == "registration"
        assert res["georef"]["inliers"] >= 30
    for lat, lng in _all_ring_pts(res):
        assert haversine(lat, lng, *BZIV) < 30_000.0
    json.dumps(res)
