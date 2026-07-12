"""Оркестратор фото-імпорту: скріншот агро-ГІС -> георефовані поля FMP.

Склеює конвеєр з готових модулів:
  color_seg.extract_fields    — залиті полігони полів (пікселі);
  ocr_labels.find_labels      — білі підписи сіл (текст + px-центроїд);
  geocode.lookup/disambiguate — локальний газетир GeoNames: підпис -> lat/lon;
  webmerc.fit_similarity      — px -> EPSG:3857 по контрольних точках;
  registration.refine         — уточнення по реальних тайлах (опційно).

Гілки georef за числом геокодованих підписів N:
  N>=2 — similarity (зсув+поворот+масштаб) по парах (px підпису, мерк.
         координата села); registration.refine уточнює, якщо є fetch_tile;
  N==1 — north-up прив'язка зсувом до єдиного села. Масштаб з підпису не
         визначити: офлайн береться припущений зум DEFAULT_ANCHOR_ZOOM
         (площі орієнтовні!), онлайн — перебір зумів через refine до
         зеленого збігу з тайлами;
  N==0 — автоматичний georef неможливий: чесна помилка, оператор має
         розмістити контури вручну.

ЧЕСНІСТЬ ПОНАД УСЕ: неправильний georef = дрон обробляє ЧУЖЕ поле, тому:
  * band="green" ЛИШЕ коли registration.refine підтвердив збіг по тайлах;
  * лише по підписах (coarse) — ЗАВЖДИ band="yellow";
  * needs_confirm=True ЗАВЖДИ, навіть на зеленому: підтвердження на мапі —
    обов'язковий крок, band лише каже, наскільки точного попадання чекати;
  * confidence — евристичний скаляр для сортування/індикації в UI,
    НЕ ймовірність.

Server-only модуль: cv2 імпортується на верхньому рівні. Pyodide його ніколи
не вантажить — api.import_photo робить lazy-import.
"""
import math
import os
import shutil
import urllib.request

import cv2
import numpy as np
from shapely.geometry import Polygon

from . import color_seg, geocode, ocr_labels, registration, webmerc
from .coverage import polygon_area_ha
from .geo import haversine, latlon_to_local, local_to_latlon

# --- Налаштування конвеєра ---------------------------------------------------
MAX_CLUSTER_KM = 45.0        # disambiguate: попарна відстань сіл одного скріншота.
                             # 40 км виявилось впритул (реальна пара 40.7 км) — 45.
HINT_RADIUS_KM = 150.0       # region_hint: кандидатів далі — відкидаємо (якщо є ближчі)
DEFAULT_ANCHOR_ZOOM = 13.0   # N==1 офлайн: припущений зум скріншота (типовий агро-ГІС)
SWEEP_ZOOMS = [z * 0.5 for z in range(22, 37)]   # 11.0..18.0 крок 0.5 (гейт refine
                             # по масштабу ±25% — півкроку зуму (x1.19) гарантовано влучає)
MAX_VERTICES = 40            # стеля вершин контуру після спрощення
MIN_VERTEX_GAP_M = 3.0       # мінімальний крок вершин у метрах (після трансформу)
MIN_FIELD_HA = 0.3           # дрібніші контури — шум сегментації, не поле

# Публічний шаблон тайлів — ТОЙ САМИЙ, що в serve.py TILE_PROVIDERS["google"].
# Перевизначається параметром make_tile_fetcher або env FMP_TILE_URL (напр.
# VPS може вказати свій проксі) — жодних приватних хостів у коді.
TILE_URL_DEFAULT = "https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}"


# ---------------------------------------------------------------------------
# Тайли: маленький фетчер для registration.refine (інжектиться викликачем)
# ---------------------------------------------------------------------------

def make_tile_fetcher(url_template=None, cache_dir=None, timeout=6.0):
    """Зібрати fetch_tile(z, x, y) -> BGR ndarray 256x256 або None.

    Тайл-проксі serve.py живе всередині HTTP-хендлера і чисто не дістається,
    тому тут власний мінімальний фетчер (urllib) з тим САМИМ дисковим кешем
    tiles_cache/google/z/x/y — обидва шляхи діляться кешем. Кастомний
    url_template кешується окремо (tiles_cache/custom/), щоб не отруїти
    кеш штатного провайдера.

    url_template: параметр -> env FMP_TILE_URL -> публічний дефолт (Google,
    як у serve.py). Мережеві збої повертають None (missing tile) — refine
    сам вирішує, чи тайлів достатньо.
    """
    tpl = url_template or os.environ.get("FMP_TILE_URL") or TILE_URL_DEFAULT
    if cache_dir is None:
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        sub = "google" if tpl == TILE_URL_DEFAULT else "custom"
        cache_dir = os.path.join(root, "tiles_cache", sub)

    def fetch_tile(z, x, y):
        local = os.path.join(cache_dir, str(z), str(x), str(y))
        data = None
        if os.path.isfile(local):
            try:
                with open(local, "rb") as f:
                    data = f.read()
            except OSError:
                data = None
        if not data:
            url = tpl.format(z=z, x=x, y=y)
            try:
                req = urllib.request.Request(
                    url, headers={"User-Agent": "FieldMissionPlanner/1.0"})
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    data = r.read()
            except Exception:      # noqa: BLE001 — офлайн/збій = відсутній тайл
                return None
            if data:
                try:
                    # Той самий disk-fill guard, що в serve.py: кешуємо лише
                    # коли вільно >= 700 МБ.
                    if shutil.disk_usage(cache_dir if os.path.isdir(cache_dir)
                                         else os.path.dirname(cache_dir) or ".").free \
                            > 700 * 1024 * 1024:
                        os.makedirs(os.path.dirname(local), exist_ok=True)
                        with open(local, "wb") as f:
                            f.write(data)
                except OSError:
                    pass
        if not data:
            return None
        img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        return img

    return fetch_tile


# ---------------------------------------------------------------------------
# Трансформи: усе зводимо до 2x3 матриці A (px -> EPSG:3857)
# ---------------------------------------------------------------------------

def _merc_res_f(z):
    """Мерк. метрів на піксель тайлової сітки на (дробовому) зумі z."""
    return 2.0 * webmerc.MERC_MAX / (256.0 * 2.0 ** float(z))


def _similarity_to_matrix(t):
    """dict з webmerc.fit_similarity -> 2x3 матриця A.

    Модель webmerc: merc = s*R(rot) @ (px, -py) + (tx, ty), розгорнуто:
        X = s·cosθ·px + s·sinθ·py + tx
        Y = s·sinθ·px − s·cosθ·py + ty
    """
    s, th = t["scale"], t["rot_rad"]
    c, sn = math.cos(th), math.sin(th)
    return [[s * c, s * sn, t["tx"]],
            [s * sn, -s * c, t["ty"]]]


def _anchor_matrix(px, merc, mpp):
    """North-up матриця з одним якорем: px підпису лягає точно в merc села."""
    ax, ay = px
    mx, my = merc
    return [[mpp, 0.0, mx - mpp * ax],
            [0.0, -mpp, my + mpp * ay]]


def _apply_a(A, x, y):
    """Одна точка через 2x3 матрицю (чистий Python — без numpy у відповіді)."""
    return (A[0][0] * x + A[0][1] * y + A[0][2],
            A[1][0] * x + A[1][1] * y + A[1][2])


def _matrix_mpp(A):
    """Ізотропний масштаб матриці (мерк. м/px): sqrt(|det|)."""
    return math.sqrt(abs(A[0][0] * A[1][1] - A[0][1] * A[1][0]))


def _ring_px_to_latlng(A, ring_px):
    """Піксельне кільце -> [(lat, lon), ...] через матрицю A."""
    out = []
    for (x, y) in ring_px:
        lon, lat = webmerc.merc_to_lonlat(*_apply_a(A, float(x), float(y)))
        out.append((lat, lon))
    return out


# ---------------------------------------------------------------------------
# Спрощення кілець: мін. крок у МЕТРАХ + стеля вершин (після трансформу)
# ---------------------------------------------------------------------------

def _largest_polygon(geom):
    """Найбільший Polygon з (Multi)Polygon, або None."""
    if geom is None or geom.is_empty:
        return None
    if geom.geom_type == "Polygon":
        return geom
    if geom.geom_type == "MultiPolygon":
        return max(geom.geoms, key=lambda g: g.area)
    return None


def _simplify_ring(ring_ll, max_vertices=MAX_VERTICES, min_gap_m=MIN_VERTEX_GAP_M):
    """Спростити кільце [(lat, lon), ...] у ЛОКАЛЬНИХ МЕТРАХ.

    1) викинути вершини ближче min_gap_m до попередньої збереженої (і хвіст,
       що налазить на початок кільця);
    2) якщо вершин > max_vertices — shapely.simplify з ескалацією tolerance;
       якщо навіть це не допомогло (виродження) — рівномірний прорідж.
    Повертає [(lat, lon), ...] без дубля-замикання, або None якщо кільце
    виродилось (< 3 вершин / нульова площа) — таке чесно викидаємо.
    """
    if len(ring_ll) < 3:
        return None
    lat0 = sum(p[0] for p in ring_ll) / len(ring_ll)
    lon0 = sum(p[1] for p in ring_ll) / len(ring_ll)
    pts = [latlon_to_local(lat, lon, lat0, lon0) for lat, lon in ring_ll]

    kept = [pts[0]]
    for p in pts[1:]:
        if math.hypot(p[0] - kept[-1][0], p[1] - kept[-1][1]) >= min_gap_m:
            kept.append(p)
    if len(kept) >= 2 and math.hypot(kept[-1][0] - kept[0][0],
                                     kept[-1][1] - kept[0][1]) < min_gap_m:
        kept.pop()                      # хвіст замкнувся на початок
    if len(kept) < 3:
        return None

    if len(kept) > max_vertices:
        poly = Polygon(kept)
        if not poly.is_valid:
            poly = poly.buffer(0)
        poly = _largest_polygon(poly)
        if poly is None or poly.is_empty:
            return None
        tol = 1.0
        while tol <= 512.0:
            simp = _largest_polygon(poly.simplify(tol, preserve_topology=True))
            if simp is not None and not simp.is_empty \
                    and len(simp.exterior.coords) - 1 <= max_vertices:
                kept = [(x, y) for x, y in list(simp.exterior.coords)[:-1]]
                break
            tol *= 1.7
        else:  # виродження: рівномірний прорідж (форма грубішає, але чесно є)
            idx = np.linspace(0, len(kept) - 1, max_vertices, dtype=int)
            kept = [kept[int(i)] for i in dict.fromkeys(idx.tolist())]
    if len(kept) < 3:
        return None
    return [local_to_latlon(x, y, lat0, lon0) for x, y in kept]


# ---------------------------------------------------------------------------
# Геокодування підписів
# ---------------------------------------------------------------------------

def _norm_hint(region_hint):
    """region_hint -> (lat, lon) або None. Приймає (lat, lon), [lat, lon],
    {"lat":..,"lng"/"lon":..} — формат клієнтів різний, нормалізуємо тут."""
    if region_hint is None:
        return None
    try:
        if isinstance(region_hint, dict):
            lat = float(region_hint["lat"])
            lon = float(region_hint.get("lon", region_hint.get("lng")))
        else:
            lat, lon = float(region_hint[0]), float(region_hint[1])
    except (KeyError, TypeError, ValueError, IndexError):
        return None
    if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
        return None
    return (lat, lon)


def _geocode_labels(labels, hint):
    """OCR-підписи -> кандидати газетира + консенсус disambiguate.

    hint (lat, lon) переранжовує кандидатів кожного підпису за відстанню і
    відкидає тих, хто далі HINT_RADIUS_KM (лише якщо є ближчі — інакше чесно
    лишаємо всіх). Ключі cands_by_label — тексти підписів; дублікати текстів
    отримують суфікс "#2", щоб не загубити контрольну точку.
    """
    cands_by_key = {}
    key_of = []                                # ключ для кожного label (той самий порядок)
    for lb in labels:
        key = lb["text"]
        k = 2
        while key in cands_by_key:
            key = "%s#%d" % (lb["text"], k)
            k += 1
        try:
            cands = geocode.lookup(lb["text"])
        except FileNotFoundError:
            raise                              # нема газетира — хай летить нагору з поясненням
        if hint and cands:
            lat0, lon0 = hint
            ranked = sorted(cands, key=lambda c: haversine(lat0, lon0, c["lat"], c["lon"]))
            near = [c for c in ranked
                    if haversine(lat0, lon0, c["lat"], c["lon"]) <= HINT_RADIUS_KM * 1000.0]
            cands = near or ranked
        cands_by_key[key] = cands
        key_of.append(key)
    disamb = geocode.disambiguate(cands_by_key, max_km=MAX_CLUSTER_KM)
    return cands_by_key, key_of, disamb


# ---------------------------------------------------------------------------
# Відповідь
# ---------------------------------------------------------------------------

def _confidence(band, disamb_confident, n_resolved):
    """Евристичний скаляр 0..1 для UI (сортування/індикація). НЕ ймовірність:
    порядок чесний (зелений > впевнений жовтий > неоднозначний), числа — ні."""
    if band == "green":
        return 0.9 if disamb_confident else 0.75
    if band == "yellow" and n_resolved >= 2:
        return 0.55 if disamb_confident else 0.4
    if band == "yellow" and n_resolved == 1:
        return 0.45 if disamb_confident else 0.3
    return 0.0


def _labels_out(labels, chosen_by_key, key_of):
    """Список підписів для відповіді: text + px + lat/lon вибраного села
    (None, якщо підпис не геокодувався — чесно видно, що з ним не так)."""
    out = []
    for lb, key in zip(labels, key_of):
        cand = chosen_by_key.get(key)
        out.append({
            "text": lb["text"],
            "lat": None if cand is None else round(float(cand["lat"]), 6),
            "lon": None if cand is None else round(float(cand["lon"]), 6),
            "px": [round(float(lb["px"][0]), 1), round(float(lb["px"][1]), 1)],
        })
    return out


def _fail(band, error, labels=None, diag=None):
    """Уніфікована невдача: усі ключі контракту на місці, ok=False."""
    return {
        "ok": False,
        "band": band,
        "confidence": 0.0,
        "needs_confirm": True,
        "labels": labels or [],
        "georef": {"method": None, "rmse_m": None, "inliers": 0},
        "contours": [],
        "diag": diag or {},
        "error": error,
    }


def _reg_diag(ref):
    """Метрики registration.refine для diag (без матриці трансформа)."""
    return {k: ref.get(k) for k in ("band", "reason", "inliers", "inlier_ratio",
                                    "rmse_px", "scale_ratio", "rot_deg", "hull_frac")}


# ---------------------------------------------------------------------------
# Головна функція
# ---------------------------------------------------------------------------

def import_photo(image_bytes, fetch_tile=None, region_hint=None):
    """Скріншот агро-ГІС (bytes JPEG/PNG) -> георефовані контури полів.

    Args:
        image_bytes: сирі байти зображення (JPEG/PNG/WebP — усе, що вміє
            cv2.imdecode).
        fetch_tile: callable (z, x, y) -> BGR ndarray 256x256 або None
            (див. make_tile_fetcher). None = офлайн: без уточнення по тайлах,
            band ніколи не буде "green".
        region_hint: приблизний район оператора (lat, lon) / {"lat","lng"} —
            переранжовує однойменні села (в Україні десятки «Бобриків»).

    Returns:
        dict (усі рядки — українською, придатні для UI):
          ok           — чи є придатні контури з georef;
          band         — "green" (підтверджено тайлами) | "yellow" (лише
                         підписи/припущення) | "red" (зображення не годиться);
          confidence   — евристика 0..1 (див. _confidence), НЕ ймовірність;
          needs_confirm— ЗАВЖДИ True: оператор мусить підтвердити на мапі;
          labels       — [{text, lat, lon, px}] усі OCR-підписи (lat/lon=None
                         коли не геокодовано);
          georef       — {method: "registration"|"labels"|"label1_anchor"|None,
                          rmse_m: залишок по контрольних точках (для 2 точок
                          fit точний => 0.0 — це НЕ означає точність!),
                          inliers: інлаєри registration (0 без уточнення)};
          contours     — [{name: "Поле N (з фото)", cls, ring: [{lat, lng}],
                          holes: [] (заливки суцільні), area_ha}], площа —
                         shapely у локальних метрах, вершин <= ~40;
          diag         — діагностика (числа конвеєра, причини, альтернативи);
          error        — лише коли ok=False.
    """
    # --- 1. Декодування -------------------------------------------------------
    if not image_bytes:
        return _fail("red", "Порожнє зображення — надішли скріншот ще раз.")
    img = cv2.imdecode(np.frombuffer(image_bytes, np.uint8), cv2.IMREAD_COLOR)
    if img is None or img.ndim != 3:
        return _fail("red", "Не вдалося декодувати зображення (очікую JPEG/PNG).")
    h, w = img.shape[:2]
    diag = {"image_px": [int(w), int(h)], "notes": []}

    # --- 2. Сегментація заливок + OCR підписів --------------------------------
    fields_px = color_seg.extract_fields(img)
    labels = ocr_labels.find_labels(img)
    diag["n_fields_px"] = len(fields_px)
    diag["n_labels_ocr"] = len(labels)
    diag["ocr"] = [{"text": l["text"], "conf": round(float(l["conf"]), 2),
                    "px": [round(float(l["px"][0]), 1), round(float(l["px"][1]), 1)]}
                   for l in labels]

    if not fields_px:
        return _fail("yellow", "Залиті полігони полів на зображенні не знайдено — "
                               "перевір, що це скріншот ГІС із кольоровими полями.",
                     labels=_labels_out(labels, {}, [l["text"] for l in labels]),
                     diag=diag)

    # --- 3. Геокодування підписів ---------------------------------------------
    hint = _norm_hint(region_hint)
    diag["region_hint"] = list(hint) if hint else None
    try:
        cands_by_key, key_of, disamb = _geocode_labels(labels, hint)
    except FileNotFoundError:
        return _fail("yellow", "Немає локального газетира (data/gazetteer.sqlite) — "
                               "запусти scripts/build_gazetteer.py на сервері.",
                     diag=diag)
    chosen = disamb["chosen"]
    resolved = [(lb, key, chosen[key]) for lb, key in zip(labels, key_of)
                if chosen.get(key) is not None]
    n_res = len(resolved)
    diag["n_labels_geocoded"] = n_res
    diag["geocode"] = {
        "confident": bool(disamb["confident"]),
        "n_combos": int(disamb["n_combos"]),
        "reason": disamb["reason"],
        # альтернативи — для UI підтвердження (оператор може перемкнути село)
        "alternates": {key: [{"name": c["name"], "lat": c["lat"], "lon": c["lon"],
                              "admin1": c["admin1"]}
                             for c in disamb["alternates"].get(key, [])[:5]]
                       for key in cands_by_key},
    }
    labels_out = _labels_out(labels, chosen, key_of)

    if n_res == 0:
        if labels:
            msg = ("Підписи розпізнано (%s), але в газетирі їх не знайдено — "
                   "автоматична прив'язка неможлива. Розмісти поля на мапі вручну."
                   % ", ".join("«%s»" % l["text"] for l in labels))
        else:
            msg = ("На зображенні немає підписів населених пунктів — "
                   "автоматична прив'язка неможлива. Розмісти поля на мапі вручну.")
        return _fail("yellow", msg, labels=labels_out, diag=diag)

    # --- 4. Coarse-трансформ по підписах ---------------------------------------
    anchors = [{"px": [float(lb["px"][0]), float(lb["px"][1])],
                "merc": list(webmerc.lonlat_to_merc(c["lon"], c["lat"])),
                "name": lb["text"]}
               for lb, _, c in resolved]
    method, rmse_m, A = None, None, None
    if n_res >= 2:
        try:
            t = webmerc.fit_similarity(
                [(a["px"][0], a["px"][1]) for a in anchors],
                [(a["merc"][0], a["merc"][1]) for a in anchors])
            A = _similarity_to_matrix(t)
            method, rmse_m = "labels", float(t["rmse_m"])
        except ValueError as e:
            diag["notes"].append("similarity по підписах не зійшлась (%s) — "
                                 "падаю на прив'язку по одному підпису" % e)
    if A is None:
        # N==1 (або вироджений fit): north-up якір по найвпевненішому підпису.
        lb, _, c = resolved[0]
        merc = webmerc.lonlat_to_merc(c["lon"], c["lat"])
        A = _anchor_matrix(lb["px"], merc, _merc_res_f(DEFAULT_ANCHOR_ZOOM))
        method, rmse_m = "label1_anchor", None
        diag["assumed_zoom"] = DEFAULT_ANCHOR_ZOOM
        diag["notes"].append(
            "масштаб не визначити з одного підпису — припущено зум %.1f; "
            "площі та розміри полів ОРІЄНТОВНІ" % DEFAULT_ANCHOR_ZOOM)

    # --- 5. Уточнення по тайлах (коли є fetch_tile) -----------------------------
    band, inliers = "yellow", 0
    if fetch_tile is not None:
        if method == "labels":
            ref = registration.refine(img, {"A": A, "anchors": anchors}, fetch_tile)
            diag["registration"] = _reg_diag(ref)
            if ref["band"] == "green":
                A, band, inliers = ref["transform"]["A"], "green", int(ref["inliers"])
                method = "registration"
        else:
            # N==1: перебір зумів — refine сам скаже, на якому зумі фон зійшовся.
            lb, _, c = resolved[0]
            merc = webmerc.lonlat_to_merc(c["lon"], c["lat"])
            sweep = []
            for z in sorted(SWEEP_ZOOMS, key=lambda zz: abs(zz - DEFAULT_ANCHOR_ZOOM)):
                cand_A = _anchor_matrix(lb["px"], merc, _merc_res_f(z))
                ref = registration.refine(img, {"A": cand_A, "anchors": anchors},
                                          fetch_tile)
                sweep.append({"zoom": z, "band": ref["band"],
                              "inliers": int(ref["inliers"])})
                if ref["band"] == "green":
                    A, band, inliers = ref["transform"]["A"], "green", int(ref["inliers"])
                    method = "registration"
                    diag["registration"] = _reg_diag(ref)
                    diag.pop("assumed_zoom", None)
                    break
            diag["zoom_sweep"] = sweep
            if band != "green":
                diag["notes"].append("перебір зумів по тайлах не дав зеленого "
                                     "збігу — лишаюсь на припущеному масштабі")
    # band-правила: green ЛИШЕ від registration; coarse по підписах — завжди yellow.

    # --- 6. Контури: px -> lat/lng, спрощення, площі ----------------------------
    contours, dropped = [], 0
    for f in fields_px:
        ring = _simplify_ring(_ring_px_to_latlng(A, f["ring_px"]))
        if ring is None:
            dropped += 1
            continue
        area_ha = polygon_area_ha(ring)
        if area_ha < MIN_FIELD_HA:
            dropped += 1
            continue
        contours.append({
            "cls": f["cls"],
            "ring": [{"lat": round(lat, 7), "lng": round(lon, 7)} for lat, lon in ring],
            "holes": [],            # заливки суцільні: дірки маски — текст/тіні, не вирізи
            "area_ha": round(float(area_ha), 2),
        })
    contours.sort(key=lambda c: -c["area_ha"])
    for i, c in enumerate(contours, 1):
        c["name"] = "Поле %d (з фото)" % i
    diag["dropped_rings"] = dropped
    diag["transform_A"] = [[float(v) for v in row] for row in A]
    mpp = _matrix_mpp(A)
    lat_c = _ring_px_to_latlng(A, [(w / 2.0, h / 2.0)])[0][0]
    diag["scale_m_per_px"] = round(mpp * math.cos(math.radians(lat_c)), 3)  # СПРАВЖНІ метри

    if not contours:
        return _fail(band, "Полігони знайдено, але після прив'язки жоден не дав "
                           "придатного контуру (%d відкинуто)." % dropped,
                     labels=labels_out, diag=diag)

    return {
        "ok": True,
        "band": band,
        "confidence": _confidence(band, bool(disamb["confident"]), n_res),
        "needs_confirm": True,     # ЗАВЖДИ: підтвердження на мапі обов'язкове
        "labels": labels_out,
        "georef": {"method": method,
                   "rmse_m": None if rmse_m is None else round(rmse_m, 2),
                   "inliers": inliers},
        "contours": contours,
        "diag": diag,
    }
