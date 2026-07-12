"""Georeference refinement: match a screenshot's satellite background to basemap tiles.

Вхід — скріншот агро-ГІС (north-up web-mercator сателітна підкладка з
напівпрозорими кольоровими заливками полів) і грубий (label-based) трансформ
px -> EPSG:3857, отриманий з геокодованих підписів сіл (webmerc.fit_similarity).
Грубий трансформ точний до сотень метрів — цього замало, щоб дрон обробив
правильне поле. Модуль уточнює його, зіставляючи видимий сателітний фон
скріншота з мозаїкою реальних тайлів тієї самої зони:

  1. З coarse рахуємо приблизний mercator-bbox скріншота та його м/px.
  2. Підбираємо zoom, де роздільність тайлів ~ роздільності скріншота,
     і збираємо мозаїку ~1.5x більшу за bbox (fetch_tile інжектиться ззовні —
     жодних захардкоджених URL тут).
  3. Маскуємо кольорові заливки й білі підписи (LAB-умова, та сама що в
     color_seg) — ознаки беруться лише з видимого фону.
  4. SIFT + ratio-test (0.75) + cv2.estimateAffinePartial2D(RANSAC) дає
     similarity "px скріншота -> px мозаїки"; композиція з відомим
     "px мозаїки -> mercator" дає фінальний px -> mercator.
  5. Ворота впевненості (див. refine): БУДЬ-ЯКИЙ провал -> band="yellow" і
     повертається грубий трансформ + людська причина українською. Зелений
     видається лише коли всі метрики пройдені — краще чесний "жовтий", ніж
     впевнено-неправильний "зелений".

Модуль server-only: імпортує cv2 на верхньому рівні й ніколи не вантажиться
Pyodide (api.py робить lazy-import).
"""
import math

import cv2
import numpy as np

R_EARTH = 6378137.0                    # WGS84 equatorial radius (m)
MERC_MAX = math.pi * R_EARTH           # half-extent of web-mercator world (m)
TILE_PX = 256                          # standard tile size

# Ворота впевненості (усі мають пройти для band="green")
MIN_INLIERS = 30
MIN_INLIER_RATIO = 0.35
MAX_RMSE_PX = 2.5                      # у пікселях скріншота
SCALE_RATIO_RANGE = (0.8, 1.25)        # refined м/px відносно coarse
MAX_ROT_DEG = 5.0
MIN_HULL_FRAC = 0.30                   # частка кадру під опуклою оболонкою інлаєрів
MAX_LABEL_DIST_M = 500.0               # крос-чек: підпис має лягти в 500 м від геокоду

MAX_TILES = 120                        # стеля на розмір мозаїки (захист від сміттєвого coarse)
MAX_MISSING_FRAC = 0.5                 # частка недоотриманих тайлів, після якої не намагаємось
LOWE_RATIO = 0.75
RANSAC_REPROJ_PX = 3.0                 # у пікселях мозаїки

# --- Спроба переюзати LAB-умову з color_seg (пишеться паралельно); фолбек нижче.
try:  # pragma: no cover - залежить від наявності сусіднього модуля
    from . import color_seg as _color_seg
except Exception:  # noqa: BLE001 - модуль опційний
    _color_seg = None


# ---------------------------------------------------------------------------
# Web-mercator helpers
# ---------------------------------------------------------------------------

def lonlat_to_merc(lon, lat):
    """(lon, lat) градуси -> web-mercator (x, y) метри (EPSG:3857)."""
    x = math.radians(lon) * R_EARTH
    y = math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) * R_EARTH
    return x, y


def merc_to_lonlat(x, y):
    """web-mercator (x, y) метри -> (lon, lat) градуси."""
    lon = math.degrees(x / R_EARTH)
    lat = math.degrees(2 * math.atan(math.exp(y / R_EARTH)) - math.pi / 2)
    return lon, lat


def merc_res(z):
    """Роздільність тайлів на зумі z: mercator-метрів на піксель."""
    return 2 * MERC_MAX / (TILE_PX * (1 << z))


def tile_topleft_merc(z, tx, ty):
    """Mercator-координати верхнього-лівого кута тайла (z, tx, ty)."""
    t = 2 * MERC_MAX / (1 << z)
    return -MERC_MAX + tx * t, MERC_MAX - ty * t


def merc_to_tile(z, x, y):
    """Mercator (x, y) -> (tx, ty) індекси тайла (float, без округлення)."""
    t = 2 * MERC_MAX / (1 << z)
    return (x + MERC_MAX) / t, (MERC_MAX - y) / t


# ---------------------------------------------------------------------------
# Coarse-трансформ: нормалізація до 2x3 матриці px -> mercator
# ---------------------------------------------------------------------------

def coarse_to_matrix(coarse):
    """Дістати з coarse-словника 2x3 матрицю A: [px_x, px_y, 1] -> [merc_x, merc_y].

    Приймає кілька еквівалентних форм (щоб не залежати жорстко від сусіднього
    webmerc-модуля):
      - {"A": [[a,b,c],[d,e,f]]} або {"M"/"matrix": ...} — 2x3 (nested або flat len 6);
      - {"a","b","tx","ty"} — similarity з y-flip:
            X = a*px + b*py + tx;  Y = b*px - a*py + ty;
      - {"scale","rot_deg","tx","ty"} — scale у mercator-м/px, поворот у градусах,
        y-flip неявний (екран y вниз, mercator y вгору).
    Повертає np.ndarray (2, 3) float64. ValueError якщо форма не розпізнана.
    """
    if not isinstance(coarse, dict):
        raise ValueError("coarse має бути dict")
    for key in ("A", "M", "matrix", "transform"):
        m = coarse.get(key)
        if m is None:
            continue
        arr = np.asarray(m, dtype=np.float64)
        if arr.size == 6:
            return arr.reshape(2, 3)
        if arr.shape == (3, 3):
            return arr[:2, :]
        raise ValueError("coarse[%r] має бути 2x3 (або flat len 6)" % key)
    if all(k in coarse for k in ("a", "b", "tx", "ty")):
        a, b = float(coarse["a"]), float(coarse["b"])
        tx, ty = float(coarse["tx"]), float(coarse["ty"])
        return np.array([[a, b, tx], [b, -a, ty]], dtype=np.float64)
    if all(k in coarse for k in ("scale", "rot_deg", "tx", "ty")):
        s = float(coarse["scale"])
        th = math.radians(float(coarse["rot_deg"]))
        c, sn = math.cos(th), math.sin(th)
        # y-flip: спершу (x, -y), потім поворот+масштаб, потім зсув
        return np.array([[s * c, s * sn, float(coarse["tx"])],
                         [s * sn, -s * c, float(coarse["ty"])]], dtype=np.float64)
    raise ValueError("не розпізнано форму coarse-трансформа (очікую A/M/matrix, "
                     "a-b-tx-ty або scale-rot_deg-tx-ty)")


def coarse_anchors(coarse):
    """Дістати з coarse список якорів-підписів: [((px_x, px_y), (merc_x, merc_y), name)].

    Шукає ключі "anchors" / "labels" / "points"; кожен запис — dict з "px" і
    "merc" (та опційним "name"), або пара ((px), (merc)). Відсутні якорі -> [].
    """
    if not isinstance(coarse, dict):
        return []
    entries = None
    for key in ("anchors", "labels", "points"):
        if coarse.get(key):
            entries = coarse[key]
            break
    if not entries:
        return []
    out = []
    for e in entries:
        if isinstance(e, dict):
            px, mc = e.get("px"), e.get("merc")
            name = e.get("name", "?")
        else:
            px, mc = e[0], e[1]
            name = e[2] if len(e) > 2 else "?"
        if px is None or mc is None:
            continue
        out.append(((float(px[0]), float(px[1])),
                    (float(mc[0]), float(mc[1])), str(name)))
    return out


def apply_transform(A, pts):
    """Застосувати 2x3 матрицю A до масиву точок (N, 2) -> (N, 2)."""
    pts = np.asarray(pts, dtype=np.float64).reshape(-1, 2)
    return pts @ A[:, :2].T + A[:, 2]


def _matrix_scale(A):
    """Ізотропний масштаб 2x3 матриці: sqrt(|det|) — mercator-м на піксель."""
    return math.sqrt(abs(float(np.linalg.det(A[:, :2]))))


# ---------------------------------------------------------------------------
# Маска перекриттів: заливки полів + білі підписи
# ---------------------------------------------------------------------------

def overlay_mask(bgr):
    """Маска пікселів, закритих накладками (255 = закрито, 0 = видимий фон).

    Та сама LAB-умова, що й у color_seg: заливки полів (маджента/фіолет/цегляний/
    синій) мають a > 10 або b < -10 (натуральний сателітний фон — ні). Додатково
    глушимо білі підписи сіл (яскраві низькохромні пікселі) і розширюємо маску,
    щоб накрити тонкі чорні контури та темне гало навколо тексту.
    """
    if _color_seg is not None and hasattr(_color_seg, "overlay_mask"):
        try:
            return _color_seg.overlay_mask(bgr)
        except Exception:  # noqa: BLE001 - фолбек на локальну умову
            pass
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB).astype(np.int16)
    a = lab[:, :, 1] - 128
    b = lab[:, :, 2] - 128
    fills = ((a > 10) | (b < -10)).astype(np.uint8) * 255
    # білі підписи: яскраво і майже без хроми
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    text = ((gray > 225) & (np.abs(a) < 12) & (np.abs(b) < 12)).astype(np.uint8) * 255
    mask = cv2.bitwise_or(fills, text)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    mask = cv2.dilate(mask, np.ones((9, 9), np.uint8))
    return mask


# ---------------------------------------------------------------------------
# Мозаїка тайлів
# ---------------------------------------------------------------------------

def _build_mosaic(z, tx0, ty0, tx1, ty1, fetch_tile):
    """Зібрати мозаїку тайлів [tx0..tx1] x [ty0..ty1] на зумі z.

    Повертає (img BGR, missing_frac). Недоотримані тайли (fetch_tile -> None
    або виняток) заповнюються сірим і не дають ознак для матчингу.
    """
    nx, ny = tx1 - tx0 + 1, ty1 - ty0 + 1
    mosaic = np.full((ny * TILE_PX, nx * TILE_PX, 3), 127, dtype=np.uint8)
    missing = 0
    for iy in range(ny):
        for ix in range(nx):
            try:
                tile = fetch_tile(z, tx0 + ix, ty0 + iy)
            except Exception:  # noqa: BLE001 - мережеві збої = missing tile
                tile = None
            if tile is None:
                missing += 1
                continue
            t = np.asarray(tile)
            if t.ndim == 2:
                t = cv2.cvtColor(t, cv2.COLOR_GRAY2BGR)
            if t.shape[0] != TILE_PX or t.shape[1] != TILE_PX:
                t = cv2.resize(t, (TILE_PX, TILE_PX), interpolation=cv2.INTER_AREA)
            mosaic[iy * TILE_PX:(iy + 1) * TILE_PX,
                   ix * TILE_PX:(ix + 1) * TILE_PX] = t[:, :, :3]
    return mosaic, missing / float(nx * ny)


def _mosaic_to_merc_matrix(z, tx0, ty0):
    """2x3 матриця 'px мозаїки -> mercator' (центри пікселів: px u -> u + 0.5)."""
    res = merc_res(z)
    ox, oy = tile_topleft_merc(z, tx0, ty0)
    return np.array([[res, 0.0, ox + 0.5 * res],
                     [0.0, -res, oy - 0.5 * res]], dtype=np.float64)


def _guided_matches(kp1, des1, kp2, des2, M, radius_px):
    """Другий (guided) прохід матчингу: шукаємо відповідники біля передбачення.

    Перший RANSAC дає грубу similarity M (px скріншота -> px мозаїки). Для
    КОЖНОЇ ознаки скріншота передбачаємо позицію в мозаїці й розглядаємо лише
    ознаки мозаїки в радіусі radius_px від неї — глобальний ratio-тест Лоу
    відкидає багато правильних пар (сателітні знімки самоподібні), а локальний
    пошук їх повертає. Хибні пари далі відсіює повторний RANSAC.

    Повертає (src, dst) масиви (N, 1, 2) float32.
    """
    pts1 = np.float32([kp.pt for kp in kp1])
    pts2 = np.float32([kp.pt for kp in kp2])
    pred = cv2.transform(pts1.reshape(-1, 1, 2), M).reshape(-1, 2)
    r2 = float(radius_px) ** 2
    src, dst = [], []
    # грубе сіткове хешування мозаїчних ознак, щоб не рахувати повну матрицю
    cell = max(int(radius_px), 1)
    grid = {}
    for j, (x, y) in enumerate(pts2):
        grid.setdefault((int(x) // cell, int(y) // cell), []).append(j)
    for i, (px, py) in enumerate(pred):
        cx, cy = int(px) // cell, int(py) // cell
        cand = []
        for gx in (cx - 1, cx, cx + 1):
            for gy in (cy - 1, cy, cy + 1):
                cand.extend(grid.get((gx, gy), ()))
        if not cand:
            continue
        cand = [j for j in cand
                if (pts2[j][0] - px) ** 2 + (pts2[j][1] - py) ** 2 <= r2]
        if not cand:
            continue
        d = np.linalg.norm(des2[cand] - des1[i], axis=1)
        order = np.argsort(d)
        best = cand[int(order[0])]
        # локальний ratio-тест якщо є з чого вибирати; одинак приймаємо —
        # хибні одинаки відсіє RANSAC
        if len(order) >= 2 and d[order[0]] >= 0.85 * d[order[1]]:
            continue
        src.append(pts1[i])
        dst.append(pts2[best])
    if not src:
        return None, None
    return (np.float32(src).reshape(-1, 1, 2),
            np.float32(dst).reshape(-1, 1, 2))


# ---------------------------------------------------------------------------
# Основна функція
# ---------------------------------------------------------------------------

def _result(band, reason, transform, **metrics):
    """Зібрати словник результату з дефолтами для непорахованих метрик."""
    out = {
        "ok": band == "green",
        "band": band,
        "reason": reason,
        "transform": transform,
        "inliers": 0,
        "inlier_ratio": 0.0,
        "rmse_px": None,
        "scale_ratio": None,
        "rot_deg": None,
        "hull_frac": None,
    }
    out.update(metrics)
    return out


def refine(bgr_image, coarse, fetch_tile=None):
    """Уточнити грубий georef скріншота матчингом сателітного фону з тайлами.

    Args:
        bgr_image: скріншот, np.ndarray HxWx3 (BGR).
        coarse: label-based similarity px -> EPSG:3857 від webmerc.fit_similarity
            (див. coarse_to_matrix щодо прийнятних форм; опційний ключ
            "anchors"/"labels" з парами px/merc підписів вмикає крос-чек).
        fetch_tile: callable (z, x, y) -> BGR ndarray 256x256 або None.
            Інжектиться викликачем — модуль не знає жодних URL.

    Returns:
        dict: {ok, transform, inliers, inlier_ratio, rmse_px, scale_ratio,
               rot_deg, hull_frac, band: "green"|"yellow", reason}.
        transform = {"A": [[...],[...]]} — 2x3 px -> mercator; на "yellow" це
        нормалізований coarse (уточнення не вдалося, працюємо з грубим),
        reason — людською мовою чому. "green" лише якщо ВСІ ворота пройдені.
    """
    # --- 0. Валідація входів -------------------------------------------------
    try:
        A0 = coarse_to_matrix(coarse)
    except ValueError as e:
        return _result("yellow", "некоректний coarse-трансформ: %s" % e, None)
    coarse_tf = {"A": A0.tolist()}

    if bgr_image is None or getattr(bgr_image, "ndim", 0) != 3:
        return _result("yellow", "некоректне зображення (очікую HxWx3 BGR)", coarse_tf)
    if fetch_tile is None:
        return _result("yellow", "не задано fetch_tile — уточнення по тайлах неможливе",
                       coarse_tf)

    h, w = bgr_image.shape[:2]
    mpp0 = _matrix_scale(A0)
    if not math.isfinite(mpp0) or mpp0 <= 0:
        return _result("yellow", "вироджений coarse-трансформ (масштаб <= 0)", coarse_tf)

    # --- 1. Bbox скріншота в mercator + вибір зума ---------------------------
    corners = apply_transform(A0, [(0, 0), (w, 0), (w, h), (0, h)])
    xmin, ymin = corners.min(axis=0)
    xmax, ymax = corners.max(axis=0)
    # мозаїка ~1.5x bbox: паддінг по 25% розміру з кожного боку
    pad_x, pad_y = 0.25 * (xmax - xmin), 0.25 * (ymax - ymin)
    xmin, xmax = xmin - pad_x, xmax + pad_x
    ymin, ymax = ymin - pad_y, ymax + pad_y

    z = int(round(math.log2(2 * MERC_MAX / (TILE_PX * mpp0))))
    z = max(3, min(21, z))
    while True:
        fx0, fy0 = merc_to_tile(z, xmin, ymax)   # верхній-лівий кут
        fx1, fy1 = merc_to_tile(z, xmax, ymin)   # нижній-правий кут
        n = 1 << z
        tx0 = max(0, min(n - 1, int(math.floor(fx0))))
        ty0 = max(0, min(n - 1, int(math.floor(fy0))))
        tx1 = max(0, min(n - 1, int(math.floor(fx1))))
        ty1 = max(0, min(n - 1, int(math.floor(fy1))))
        if (tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= MAX_TILES:
            break
        if z <= 3:
            return _result("yellow", "coarse-bbox завеликий — не вдалося підібрати зум",
                           coarse_tf)
        z -= 1

    # --- 2. Мозаїка ----------------------------------------------------------
    mosaic, missing_frac = _build_mosaic(z, tx0, ty0, tx1, ty1, fetch_tile)
    if missing_frac > MAX_MISSING_FRAC:
        return _result(
            "yellow",
            "замало тайлів базової карти (отримано лише %d%%)" % round(100 * (1 - missing_frac)),
            coarse_tf)
    C = _mosaic_to_merc_matrix(z, tx0, ty0)

    # --- 3. Ознаки: SIFT по фону (заливки/підписи замасковані) ---------------
    shot_gray = cv2.cvtColor(bgr_image, cv2.COLOR_BGR2GRAY)
    feat_mask = cv2.bitwise_not(overlay_mask(bgr_image))
    mosaic_gray = cv2.cvtColor(mosaic, cv2.COLOR_BGR2GRAY)

    sift = cv2.SIFT_create(nfeatures=6000)
    kp1, des1 = sift.detectAndCompute(shot_gray, feat_mask)
    # мозаїка більша за скріншот — їй окремий, більший бюджет ознак
    sift_mosaic = cv2.SIFT_create(nfeatures=14000)
    kp2, des2 = sift_mosaic.detectAndCompute(mosaic_gray, None)
    if des1 is None or des2 is None or len(kp1) < 8 or len(kp2) < 8:
        return _result("yellow", "замало ознак на фоні (%d/%d)" %
                       (len(kp1 or []), len(kp2 or [])), coarse_tf)

    matcher = cv2.BFMatcher(cv2.NORM_L2)
    knn = matcher.knnMatch(des1, des2, k=2)
    good = [m for m, n in (p for p in knn if len(p) == 2)
            if m.distance < LOWE_RATIO * n.distance]
    if len(good) < 8:
        return _result("yellow", "замало збігів ознак після ratio-тесту (%d)" % len(good),
                       coarse_tf)

    src = np.float32([kp1[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
    dst = np.float32([kp2[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)

    # --- 4. Similarity (4DOF) через RANSAC ------------------------------------
    M, inl = cv2.estimateAffinePartial2D(
        src, dst, method=cv2.RANSAC, ransacReprojThreshold=RANSAC_REPROJ_PX,
        maxIters=5000, confidence=0.995, refineIters=10)
    if M is None or inl is None:
        return _result("yellow", "RANSAC не знайшов узгодженого трансформа", coarse_tf)

    # --- 4b. Guided другий прохід: локальний пошук біля передбачення ----------
    # (глобальний ratio-тест губить правильні пари на самоподібних знімках;
    #  локальний повертає їх і розширює покриття кадру інлаєрами)
    if int(inl.ravel().sum()) >= 15:
        g_src, g_dst = _guided_matches(kp1, des1, kp2, des2, M, radius_px=6.0)
        if g_src is not None and len(g_src) >= len(src[inl.ravel().astype(bool)]):
            M2, inl2 = cv2.estimateAffinePartial2D(
                g_src, g_dst, method=cv2.RANSAC,
                ransacReprojThreshold=RANSAC_REPROJ_PX,
                maxIters=5000, confidence=0.995, refineIters=10)
            if M2 is not None and inl2 is not None and \
                    int(inl2.sum()) > int(inl.sum()):
                M, inl, src, dst = M2, inl2, g_src, g_dst

    inl = inl.ravel().astype(bool)
    n_inl = int(inl.sum())
    inlier_ratio = n_inl / float(len(src))

    s_px = math.hypot(M[0, 0], M[1, 0])          # px мозаїки на px скріншота
    rot_deg = math.degrees(math.atan2(M[1, 0], M[0, 0]))
    refined_mpp = s_px * merc_res(z)             # mercator-м/px скріншота після уточнення
    scale_ratio = refined_mpp / mpp0

    # RMSE у пікселях СКРІНШОТА (залишки в мозаїці ділимо на масштаб)
    rmse_px = None
    if n_inl:
        pred = cv2.transform(src[inl], M).reshape(-1, 2)
        resid = np.linalg.norm(pred - dst[inl].reshape(-1, 2), axis=1)
        rmse_px = float(np.sqrt(np.mean(resid ** 2)) / max(s_px, 1e-12))

    hull_frac = 0.0
    if n_inl >= 3:
        hull = cv2.convexHull(src[inl].reshape(-1, 2))
        hull_frac = float(cv2.contourArea(hull)) / float(w * h)

    # --- 5. Фінальний трансформ px -> mercator --------------------------------
    Mh = np.vstack([M, [0.0, 0.0, 1.0]])
    A_ref = (np.vstack([C, [0.0, 0.0, 1.0]]) @ Mh)[:2, :]
    refined_tf = {"A": A_ref.tolist()}

    metrics = dict(inliers=n_inl, inlier_ratio=round(inlier_ratio, 3),
                   rmse_px=None if rmse_px is None else round(rmse_px, 3),
                   scale_ratio=round(scale_ratio, 4),
                   rot_deg=round(rot_deg, 3), hull_frac=round(hull_frac, 3))

    # --- 6. Ворота впевненості -------------------------------------------------
    reasons = []
    if n_inl < MIN_INLIERS:
        reasons.append("замало інлаєрів: %d < %d" % (n_inl, MIN_INLIERS))
    if inlier_ratio < MIN_INLIER_RATIO:
        reasons.append("низька частка інлаєрів: %.2f < %.2f" % (inlier_ratio, MIN_INLIER_RATIO))
    if rmse_px is None or rmse_px >= MAX_RMSE_PX:
        reasons.append("великий RMSE: %s px (поріг %.1f)" %
                       ("?" if rmse_px is None else "%.2f" % rmse_px, MAX_RMSE_PX))
    if not (SCALE_RATIO_RANGE[0] <= scale_ratio <= SCALE_RATIO_RANGE[1]):
        reasons.append("масштаб розходиться з coarse: %.3f поза [%.2f, %.2f]" %
                       (scale_ratio, *SCALE_RATIO_RANGE))
    if abs(rot_deg) >= MAX_ROT_DEG:
        reasons.append("завеликий поворот: %.1f° (поріг %.0f°)" % (rot_deg, MAX_ROT_DEG))
    if hull_frac <= MIN_HULL_FRAC:
        reasons.append("інлаєри покривають замалу частину кадру: %.2f <= %.2f" %
                       (hull_frac, MIN_HULL_FRAC))

    # крос-чек по підписах: куди уточнений трансформ кладе піксель підпису
    for (px, mc, name) in coarse_anchors(coarse):
        pred = apply_transform(A_ref, [px])[0]
        _, lat = merc_to_lonlat(mc[0], mc[1])
        dist_m = math.hypot(pred[0] - mc[0], pred[1] - mc[1]) * math.cos(math.radians(lat))
        if dist_m > MAX_LABEL_DIST_M:
            reasons.append("підпис «%s» лягає за %.0f м від геокодованої позиції (> %.0f м)"
                           % (name, dist_m, MAX_LABEL_DIST_M))

    if reasons:
        return _result("yellow", "; ".join(reasons), coarse_tf, **metrics)
    return _result("green", "", refined_tf, **metrics)
