"""Тести backend/registration.py — уточнення georef по тайлах.

Детерміновані, БЕЗ мережі: будуємо синтетичну пару "скріншот <-> світ".
Світ = сам скріншот, warp-нутий відомою similarity (scale 1.1, rot 1.5°,
зсув) + зсув яскравості + легкий blur (імітація іншого провайдера/дати).
Фейковий fetch_tile нарізає з цього світу справжні 256x256 тайли за
web-mercator конвенцією. refine() має відновити відомий трансформ (green),
а на зіпсованому/чужому світі — чесно віддати yellow, ніколи не
впевнено-неправильний green.

Опційний live-тест з реальними Google-тайлами: FMP_NET_TESTS=1.
"""
import math
import os
import sys

import cv2
import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from backend import registration as reg  # noqa: E402

FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "agro_gis_1.jpg")

# --- параметри синтетичного світу -------------------------------------------
TRUE_SCALE = 1.1        # px світу на px скріншота
TRUE_ROT_DEG = 1.5
TRUE_SHIFT = (150.0, 120.0)
SHOT_MPP = 2.2          # mercator-м/px скріншота (z≈16)
WORLD_MPP = SHOT_MPP / TRUE_SCALE
# верхній-лівий кут світу — десь біля Бзова (значення довільне, але реалістичне)
WORLD_X0, WORLD_Y0 = reg.lonlat_to_merc(31.15, 50.36)


@pytest.fixture(scope="module")
def shot():
    img = cv2.imread(FIXTURE)
    assert img is not None, "нема фікстури %s" % FIXTURE
    return img


def make_true_M(shot_img):
    """Відома similarity 'px скріншота -> px світу' (scale/rot/shift)."""
    h, w = shot_img.shape[:2]
    M = cv2.getRotationMatrix2D((w / 2.0, h / 2.0), -TRUE_ROT_DEG, TRUE_SCALE)
    M[0, 2] += TRUE_SHIFT[0]
    M[1, 2] += TRUE_SHIFT[1]
    return M


def make_world(shot_img, degrade="mild"):
    """Світове зображення: warp скріншота + яскравість + blur."""
    M = make_true_M(shot_img)
    h, w = shot_img.shape[:2]
    world_size = (int(w * TRUE_SCALE) + 400, int(h * TRUE_SCALE) + 350)
    world = cv2.warpAffine(shot_img, M, world_size, flags=cv2.INTER_LINEAR,
                           borderMode=cv2.BORDER_REPLICATE)
    if degrade == "mild":
        world = cv2.convertScaleAbs(world, alpha=1.06, beta=12)
        world = cv2.GaussianBlur(world, (3, 3), 0.8)
    elif degrade == "heavy":
        world = cv2.GaussianBlur(world, (31, 31), 12.0)
        rng = np.random.default_rng(7)
        noise = rng.normal(0, 35, world.shape)
        world = np.clip(world.astype(np.float32) + noise, 0, 255).astype(np.uint8)
    return world, M


def world_to_merc_matrix():
    """2x3 'px світу -> mercator' (центри пікселів, y-flip)."""
    return np.array([[WORLD_MPP, 0.0, WORLD_X0 + 0.5 * WORLD_MPP],
                     [0.0, -WORLD_MPP, WORLD_Y0 - 0.5 * WORLD_MPP]])


def true_shot_to_merc(shot_img):
    """Істинний трансформ 'px скріншота -> mercator' = world_merc ∘ M_true."""
    Mh = np.vstack([make_true_M(shot_img), [0, 0, 1]])
    Ch = np.vstack([world_to_merc_matrix(), [0, 0, 1]])
    return (Ch @ Mh)[:2, :]


def make_fetch_tile(world_img):
    """Фейковий тайл-сервер: ресемплить 256x256 тайли зі світового зображення."""
    Cw = world_to_merc_matrix()

    def fetch_tile(z, tx, ty):
        res = reg.merc_res(z)
        ox, oy = reg.tile_topleft_merc(z, tx, ty)
        # тайловий px (i, j), центр -> merc -> px світу (p, q)
        #   X = ox + (i+0.5)*res ; p = (X - Cw[0,2]) / WORLD_MPP
        sx = res / WORLD_MPP
        cx = (ox + 0.5 * res - Cw[0, 2]) / WORLD_MPP
        cy = (Cw[1, 2] - (oy - 0.5 * res)) / WORLD_MPP
        Minv = np.array([[sx, 0.0, cx], [0.0, sx, cy]], dtype=np.float64)
        # тайл повністю поза світом -> None (як відсутній тайл у кеші)
        h, w = world_img.shape[:2]
        corners = np.array([[0, 0], [255, 0], [255, 255], [0, 255]], dtype=np.float64)
        pts = corners @ Minv[:, :2].T + Minv[:, 2]
        if (pts[:, 0].max() < 0 or pts[:, 0].min() > w or
                pts[:, 1].max() < 0 or pts[:, 1].min() > h):
            return None
        return cv2.warpAffine(world_img, Minv, (256, 256),
                              flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
                              borderMode=cv2.BORDER_CONSTANT, borderValue=(127, 127, 127))

    return fetch_tile


def make_coarse(shot_img, scale_err=1.03, shift_px=(28.0, -18.0)):
    """Грубий (label-подібний) трансформ: без повороту, масштаб і зсув з помилкою."""
    A_true = true_shot_to_merc(shot_img)
    mpp = reg._matrix_scale(A_true) * scale_err
    # axis-aligned: беремо істинний merc центру кадру, зсуваємо на shift_px
    h, w = shot_img.shape[:2]
    cx, cy = w / 2.0, h / 2.0
    mc = reg.apply_transform(A_true, [(cx, cy)])[0]
    tx = mc[0] - mpp * cx + shift_px[0] * mpp
    ty = mc[1] + mpp * cy + shift_px[1] * mpp
    A = np.array([[mpp, 0.0, tx], [0.0, -mpp, ty]])
    # якорі-підписи: px з фікстури, merc = істина (як точний геокод)
    anchors = []
    for name, px in (("Бзів", (265.0, 248.0)), ("Волошинівка", (790.0, 255.0))):
        mc = reg.apply_transform(A_true, [px])[0]
        anchors.append({"name": name, "px": px, "merc": (float(mc[0]), float(mc[1]))})
    return {"A": A.tolist(), "anchors": anchors}


# ---------------------------------------------------------------------------
# Основні тести
# ---------------------------------------------------------------------------

def test_green_recovers_known_transform(shot):
    cv2.setRNGSeed(1234)
    world, _ = make_world(shot, degrade="mild")
    res = reg.refine(shot, make_coarse(shot), make_fetch_tile(world))
    assert res["band"] == "green", res["reason"]
    assert res["ok"] is True
    # масштаб: refined м/px проти істини — в межах 2%
    A_ref = np.array(res["transform"]["A"])
    A_true = true_shot_to_merc(shot)
    s_ref, s_true = reg._matrix_scale(A_ref), reg._matrix_scale(A_true)
    assert abs(s_ref / s_true - 1) < 0.02, (s_ref, s_true)
    # поворот: 1.5° ± 0.5° (A_ref має y-flip, тож φ = atan2(-A[1,0], A[0,0]))
    rot_ref = math.degrees(math.atan2(-A_ref[1, 0], A_ref[0, 0]))
    assert abs(res["rot_deg"] - TRUE_ROT_DEG) < 0.5, res["rot_deg"]
    assert abs(rot_ref - TRUE_ROT_DEG) < 0.5, rot_ref
    # точки кадру лягають туди, куди має класти істина (< 2 px * mpp)
    pts = [(100, 100), (1000, 600), (580, 335)]
    err = np.linalg.norm(reg.apply_transform(A_ref, pts) -
                         reg.apply_transform(A_true, pts), axis=1)
    assert err.max() < 2.0 * SHOT_MPP, err
    assert res["rmse_px"] < 2.5
    assert res["inliers"] >= 30
    assert res["hull_frac"] > 0.30


def test_yellow_on_heavy_degradation(shot):
    cv2.setRNGSeed(1234)
    world, _ = make_world(shot, degrade="heavy")
    res = reg.refine(shot, make_coarse(shot), make_fetch_tile(world))
    assert res["band"] == "yellow", "деградований світ не має давати green: %r" % res
    assert res["ok"] is False
    assert res["reason"]  # причина людською мовою
    # yellow повертає САМЕ coarse-трансформ
    assert np.allclose(res["transform"]["A"], make_coarse(shot)["A"])


def test_yellow_on_unrelated_world(shot):
    """Чужа зона: тайли з іншого зображення. Ніколи не впевнено-неправильний green."""
    cv2.setRNGSeed(1234)
    other = cv2.imread(os.path.join(os.path.dirname(__file__), "fixtures", "agro_gis_2.jpg"))
    assert other is not None
    world_shape = make_world(shot)[0].shape
    unrelated = cv2.resize(other, (world_shape[1], world_shape[0]))
    res = reg.refine(shot, make_coarse(shot), make_fetch_tile(unrelated))
    if res["band"] == "green":
        # якщо раптом green — трансформ зобов'язаний збігатися з істиною
        A_ref = np.array(res["transform"]["A"])
        A_true = true_shot_to_merc(shot)
        pts = [(100, 100), (1000, 600)]
        err = np.linalg.norm(reg.apply_transform(A_ref, pts) -
                             reg.apply_transform(A_true, pts), axis=1)
        assert err.max() < 10 * SHOT_MPP, "впевнено-неправильний green!"
    else:
        assert res["band"] == "yellow"
        assert res["reason"]


def test_yellow_without_fetch_tile(shot):
    res = reg.refine(shot, make_coarse(shot), None)
    assert res["band"] == "yellow"
    assert "fetch_tile" in res["reason"]
    assert res["transform"] is not None  # coarse повернуто


def test_yellow_on_bad_coarse(shot):
    res = reg.refine(shot, {"щось": 1}, lambda z, x, y: None)
    assert res["band"] == "yellow"
    assert "coarse" in res["reason"]


def test_yellow_on_label_crosscheck_failure(shot):
    """Якорі зсунуті далеко за поріг (5 км > MAX_LABEL_DIST_M=2 км — реальний
    промах «не те село»): навіть ідеальний матч має стати yellow."""
    cv2.setRNGSeed(1234)
    world, _ = make_world(shot, degrade="mild")
    coarse = make_coarse(shot)
    for a in coarse["anchors"]:
        a["merc"] = (a["merc"][0] + 5000.0, a["merc"][1])
    res = reg.refine(shot, coarse, make_fetch_tile(world))
    assert res["band"] == "yellow"
    assert "підпис" in res["reason"]


def test_coarse_format_variants(shot):
    """coarse_to_matrix приймає еквівалентні форми і дає ту саму матрицю."""
    A = np.array([[2.0, 0.1, 100.0], [0.1, -2.0, 200.0]])
    m1 = reg.coarse_to_matrix({"A": A.tolist()})
    m2 = reg.coarse_to_matrix({"A": A.ravel().tolist()})
    m3 = reg.coarse_to_matrix({"a": 2.0, "b": 0.1, "tx": 100.0, "ty": 200.0})
    assert np.allclose(m1, A) and np.allclose(m2, A) and np.allclose(m3, A)
    m4 = reg.coarse_to_matrix({"scale": 2.0, "rot_deg": 0.0, "tx": 5.0, "ty": 6.0})
    assert np.allclose(m4, [[2.0, 0.0, 5.0], [0.0, -2.0, 6.0]])
    with pytest.raises(ValueError):
        reg.coarse_to_matrix({"foo": 1})


def test_merc_helpers_roundtrip():
    x, y = reg.lonlat_to_merc(31.3, 50.3)
    lon, lat = reg.merc_to_lonlat(x, y)
    assert abs(lon - 31.3) < 1e-9 and abs(lat - 50.3) < 1e-9
    # тайл 0/0/0 покриває весь світ
    assert reg.tile_topleft_merc(0, 0, 0) == (-reg.MERC_MAX, reg.MERC_MAX)
    assert abs(reg.merc_res(0) - 2 * reg.MERC_MAX / 256) < 1e-9


# ---------------------------------------------------------------------------
# Live-тест (мережа): FMP_NET_TESTS=1
# ---------------------------------------------------------------------------

@pytest.mark.skipif(os.environ.get("FMP_NET_TESTS") != "1",
                    reason="мережевий тест: увімкнути FMP_NET_TESTS=1")
def test_live_google_tiles(shot):
    """Реальний coarse з геокоду Nominatim + реальні Google-тайли.

    Друкує inliers/band — «грошове число» доцільності підходу. Тайловий URL
    захардкоджено ЛИШЕ тут (модуль отримує fetch_tile ін'єкцією).
    """
    import json
    import urllib.request

    def geocode(name):
        url = ("https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" +
               urllib.parse.quote(name))
        req = urllib.request.Request(url, headers={"User-Agent": "fmp-tests/1.0"})
        data = json.loads(urllib.request.urlopen(req, timeout=30).read())
        assert data, "нема геокоду для %s" % name
        return float(data[0]["lon"]), float(data[0]["lat"])

    labels = [("Бзів", (265.0, 248.0)), ("Волошинівка", (790.0, 255.0))]
    anchors = []
    for name, px in labels:
        lon, lat = geocode(name + ", Київська область, Україна")
        anchors.append({"name": name, "px": px, "merc": reg.lonlat_to_merc(lon, lat)})

    # 2-точковий similarity px->merc з y-flip (комплексна форма: m = α·conj-ish·p + β)
    p = [complex(a["px"][0], -a["px"][1]) for a in anchors]   # y-flip
    m = [complex(*a["merc"]) for a in anchors]
    alpha = (m[1] - m[0]) / (p[1] - p[0])
    beta = m[0] - alpha * p[0]
    A = np.array([[alpha.real, alpha.imag, beta.real],
                  [alpha.imag, -alpha.real, beta.imag]])
    coarse = {"A": A.tolist(), "anchors": anchors}

    def fetch_tile(z, x, y):
        url = "https://mt1.google.com/vt/lyrs=s&x=%d&y=%d&z=%d" % (x, y, z)
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        try:
            raw = urllib.request.urlopen(req, timeout=30).read()
        except Exception:
            return None
        buf = np.frombuffer(raw, dtype=np.uint8)
        return cv2.imdecode(buf, cv2.IMREAD_COLOR)

    res = reg.refine(shot, coarse, fetch_tile)
    print("\nLIVE: band=%(band)s inliers=%(inliers)s ratio=%(inlier_ratio)s "
          "rmse=%(rmse_px)s scale_ratio=%(scale_ratio)s rot=%(rot_deg)s "
          "hull=%(hull_frac)s reason=%(reason)r" % res)
    assert res["band"] in ("green", "yellow")
    if res["band"] == "green":
        # sanity: центр кадру має лишатись у Київській області
        A_ref = np.array(res["transform"]["A"])
        mc = reg.apply_transform(A_ref, [(shot.shape[1] / 2, shot.shape[0] / 2)])[0]
        lon, lat = reg.merc_to_lonlat(*mc)
        assert 49.5 < lat < 51.5 and 29.5 < lon < 32.5, (lon, lat)
