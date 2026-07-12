"""Тести backend/color_seg.py — виділення залитих полігонів полів зі скріншота.

Запуск:  ./.venv-photo/bin/python -m pytest tests/test_photo_colorseg.py -v

Фікстури tests/fixtures/agro_gis_*.jpg — у .gitignore (реальні скріншоти
агро-ГІС); тести на них скіпаються, якщо файлів немає. Синтетичні тести
працюють завжди. Мережа не потрібна (гейт FMP_NET_TESTS тут не застосовний).

Дебаг-рендери пишуться в tests/fixtures/out_agro_gis_*.png — власник може
очно перевірити, що полігони лягли на заливки.
"""
import os
import sys

import pytest

np = pytest.importorskip("numpy")
cv2 = pytest.importorskip("cv2")
shapely_geometry = pytest.importorskip("shapely.geometry")
Polygon = shapely_geometry.Polygon

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from backend.color_seg import extract_fields, save_debug  # noqa: E402

FIX = os.path.join(ROOT, "tests", "fixtures")
FIX1 = os.path.join(FIX, "agro_gis_1.jpg")
FIX2 = os.path.join(FIX, "agro_gis_2.jpg")

needs_fix1 = pytest.mark.skipif(not os.path.exists(FIX1),
                                reason="фікстура agro_gis_1.jpg відсутня (gitignored)")
needs_fix2 = pytest.mark.skipif(not os.path.exists(FIX2),
                                reason="фікстура agro_gis_2.jpg відсутня (gitignored)")


def _by_cls(fields):
    out = {}
    for f in fields:
        out.setdefault(f["cls"], []).append(f)
    return out


def _check_rings(fields, img_shape):
    """Спільні інваріанти кожного знайденого поля."""
    h, w = img_shape[:2]
    for f in fields:
        ring = f["ring_px"]
        assert f["cls"] in ("purple", "red", "blue")
        # >= 4 вершин
        assert len(ring) >= 4, f"кільце з {len(ring)} вершин: {ring}"
        # усі вершини в межах кадру
        for x, y in ring:
            assert 0 <= x < w and 0 <= y < h
        # просте кільце: shapely-валідне (після buffer(0)-ремонту), і ремонт
        # не з'їдає площу — інакше кільце було суттєво самоперетинним
        p = Polygon(ring)
        if not p.is_valid:
            p = p.buffer(0)
        assert p.is_valid and not p.is_empty
        assert p.area > 0
        # площа "sane": узгоджена з рапортованою і не мікроскопічна/гігантська
        assert f["area_px"] >= 250
        assert f["area_px"] <= 0.2 * w * h, "поле > 20% кадру — підозріло"
        assert abs(p.area - f["area_px"]) <= 0.1 * max(p.area, f["area_px"]), \
            f"площа shapely {p.area:.0f} != area_px {f['area_px']:.0f}"


# ---------------------------------------------------------------- фікстура 1

@needs_fix1
def test_fixture1_counts_and_geometry():
    img = cv2.imread(FIX1)
    fields = extract_fields(img)
    by = _by_cls(fields)

    # Виміряно на фікстурі: 17 purple (частина ділянок розрізана намальованими
    # межами — це ок), рівно 2 червоних, синіх нема. Пороги в тесті — з
    # запасом на дрібні зміни калібрування.
    n_purple = len(by.get("purple", []))
    n_red = len(by.get("red", []))
    n_blue = len(by.get("blue", []))
    assert n_purple >= 12, f"purple {n_purple} < 12"
    assert n_red == 2, f"red {n_red} != 2"
    assert n_blue == 0, f"blue false positive: {n_blue}"

    _check_rings(fields, img.shape)

    # жодне поле не торкається краю кадру
    h, w = img.shape[:2]
    for f in fields:
        xs = [p[0] for p in f["ring_px"]]
        ys = [p[1] for p in f["ring_px"]]
        assert min(xs) > 0 and min(ys) > 0, f"торкається краю: {f['cls']}"
        assert max(xs) < w - 1 and max(ys) < h - 1, f"торкається краю: {f['cls']}"

    # сумарне покриття — груба рамка проти регресій калібрування
    cov_p = sum(f["area_px"] for f in by["purple"])
    cov_r = sum(f["area_px"] for f in by["red"])
    assert 15000 <= cov_p <= 32000, f"purple покриття {cov_p:.0f} px2 поза рамкою"
    assert 4000 <= cov_r <= 8000, f"red покриття {cov_r:.0f} px2 поза рамкою"

    save_debug(img, fields, os.path.join(FIX, "out_agro_gis_1.png"))
    assert os.path.getsize(os.path.join(FIX, "out_agro_gis_1.png")) > 10000


# ---------------------------------------------------------------- фікстура 2

@needs_fix2
def test_fixture2_counts_and_geometry():
    img = cv2.imread(FIX2)
    fields = extract_fields(img)
    by = _by_cls(fields)

    # Великий багаточастинний блок розпадається по намальованих межах на
    # >= 4 компонентів (недо-розбиття/злиття сусідів — прийнятно), плюс
    # >= 1 синюватий полігон угорі.
    n_purple = len(by.get("purple", []))
    n_blue = len(by.get("blue", []))
    assert n_purple >= 4, f"purple {n_purple} < 4"
    assert n_blue >= 1, f"blue {n_blue} < 1"

    _check_rings(fields, img.shape)

    cov_p = sum(f["area_px"] for f in by["purple"])
    assert 50000 <= cov_p <= 110000, f"purple покриття {cov_p:.0f} px2 поза рамкою"

    save_debug(img, fields, os.path.join(FIX, "out_agro_gis_2.png"))
    assert os.path.getsize(os.path.join(FIX, "out_agro_gis_2.png")) > 10000


# ------------------------------------------------------------ синтетика (без фікстур)

def _synthetic_scene():
    """Синтетичний "скріншот": тепла зелена підкладка + заливки трьох класів.

    Кольори підібрано так, щоб їхні LAB попадали в реально виміряні діапазони
    заливок (див. пороги в color_seg.py):
      підкладка BGR(90,140,120)  -> L*56  a*-16 b*+24 (тепла, як супутник)
      пурпурна  BGR(180,84,168)  -> L*49  a*+49 b*-36
      червона   BGR(60,60,150)   -> L*38  a*+38 b*+20
      синювата  BGR(170,110,100) -> L*48  a*+12 b*-33
    """
    img = np.zeros((400, 600, 3), np.uint8)
    img[:] = (90, 140, 120)
    # дві пурпурні ділянки впритул, розділені чорним штрихом 2px
    img[50:150, 50:250] = (180, 84, 168)
    img[50:150, 148:150] = (10, 10, 10)
    # білий підпис поверх лівої ділянки (має заповнитися, не поділити поле)
    cv2.putText(img, "Bziv", (65, 105), cv2.FONT_HERSHEY_SIMPLEX,
                0.8, (255, 255, 255), 2, cv2.LINE_AA)
    # червоний трикутник
    cv2.fillPoly(img, [np.array([(350, 60), (520, 80), (420, 190)])], (60, 60, 150))
    # синюватий прямокутник
    img[250:340, 380:540] = (170, 110, 100)
    return img


def test_synthetic_classes_and_stroke_split():
    img = _synthetic_scene()
    fields = extract_fields(img)
    by = _by_cls(fields)

    # штрих РОЗРІЗАЄ пурпурний блок на 2 ділянки; текст НЕ ріже і не лишає дірок
    assert len(by.get("purple", [])) == 2, by
    assert len(by.get("red", [])) == 1, by
    assert len(by.get("blue", [])) == 1, by
    _check_rings(fields, img.shape)

    # ліва пурпурна ділянка (з текстом) — суцільна: площа ~ 98x98
    left = min(by["purple"], key=lambda f: min(p[0] for p in f["ring_px"]))
    assert left["area_px"] >= 0.9 * 98 * 98, "текст пробив дірку/розрізав поле"

    # червоний трикутник за площею ~ половини свого bbox
    tri = by["red"][0]
    assert 0.8 * 0.5 * 170 * 130 <= tri["area_px"] <= 1.2 * 0.5 * 170 * 130


def test_synthetic_min_area_filter():
    img = np.zeros((200, 200, 3), np.uint8)
    img[:] = (90, 140, 120)
    img[20:32, 20:32] = (180, 84, 168)          # 144 px2 < 250 — шум, відкинути
    assert extract_fields(img) == []


def test_rejects_bad_input():
    with pytest.raises(ValueError):
        extract_fields(None)
    with pytest.raises(ValueError):
        extract_fields(np.zeros((50, 50), np.uint8))       # grayscale
