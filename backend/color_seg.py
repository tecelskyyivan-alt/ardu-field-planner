"""Виділення залитих полігонів полів зі скріншота агро-ГІС (server-only, cv2).

Вхід — скріншот карти, де поля намальовані суцільною напівпрозорою заливкою
(пурпурна/цегляно-червона/синювата) поверх супутникової підкладки, з тонкими
чорними штрихами-межами між сусідніми ділянками.

Метод: працюємо в LAB. Заливка чисто відділяється від підкладки:
  * пурпурна/синя мають b* << 0, тоді як підкладка майже вся має b* > 0
    (зелень/ґрунт — теплі тони);
  * пурпурна/червона мають a* >> 0, підкладка — a* <= ~+5.

Пороги ВИМІРЯНІ на реальних фікстурах tests/fixtures/agro_gis_*.jpg
(перцентилі 5/50/95 по патчах заливки та підкладки):
  * пурпурна заливка:  a* 26..33 (мед. ~30),  b* -24..-14 (мед. ~ -20)
  * червона заливка:   a* 23..31 (мед. ~26),  b* +13..+18,  L* 36..40
  * синювата заливка:  a* ~0..6,              b* -19..-8
  * підкладка:         a* 5-й..95-й = -22..+5, b* = 0..+21 (медіани +8..+15)
  * природний рожевий ґрунт (головний ризик хибної "червоної"):
    a* до +18, b* +15..19, АЛЕ L* ~51..64 — набагато світліший за заливку,
    тому червоний клас додатково обмежено L* < 48.
  * чорні штрихи-межі: L* ~5..21; поверх заливки їхні a*/b* підняті блендом
    (a* до ~+23), тому штрих детектуємо ЛИШЕ по L* — без обмеження хроми.

Конвеєр: маски класів -> морф. closing (заліплює білий текст і JPEG-шум) ->
віднімання розширеної маски штрихів (сусідні ділянки розпадаються по
намальованих межах) -> opening -> connectedComponents по класу ->
зовнішній контур (RETR_EXTERNAL: дірки від тексту ігноруються = заливаються)
-> approxPolyDP. Свідомий ухил у бік НЕДО-розбиття: злиплі сусіди — прийнятно,
хибний розріз — ні.

Модуль server-only: імпортує cv2 на верхньому рівні, у Pyodide не вантажиться
(api.py робить lazy-import).
"""
import cv2
import numpy as np

# --- Каліброванi пороги (справжні одиниці L*a*b*; виміряно на фікстурах) ---
PURPLE_B_MAX = -6.0     # заливка холодна: b* < -6 (підкладка > ~0)
PURPLE_A_MIN = 14.0     # пурпурна проти синьої: a* > 14
BLUE_B_MAX = -8.0       # синювата: теж холодна…
BLUE_A_MAX = 14.0       # …але без пурпурного зсуву a*
RED_A_MIN = 15.0        # червона: a* > 15 (підкладка <= ~+5)
RED_B_MIN = 2.0         # …і тепла (відрізняє від пурпурної)
RED_L_MAX = 48.0        # природний рожевий ґрунт світліший (L* мед. ~57)
STROKE_L_MAX = 22.0     # чорні штрихи-межі: тільки за яскравістю

# Медіани по компоненту — друга, компонентна перевірка (проти строкатих
# природних плям, які випадково пройшли попіксельний поріг).
_COMP_GATES = {
    "purple": lambda L, a, b: a >= 16.0 and b <= -10.0,
    "red":    lambda L, a, b: a >= 20.0 and 8.0 <= b and L <= 48.0,
    "blue":   lambda L, a, b: b <= -8.0 and a < 18.0,
}

MIN_AREA_PX = 250.0     # компоненти дрібніші — шум
APPROX_EPS_PX = 1.5     # епсилон approxPolyDP


def _lab_true(bgr):
    """8-бітний LAB OpenCV -> справжні L* (0..100), a*, b* (зі знаком), float32."""
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
    L = lab[..., 0] * (100.0 / 255.0)
    a = lab[..., 1] - 128.0
    b = lab[..., 2] - 128.0
    return L, a, b


def _class_masks(L, a, b):
    """Попіксельні маски трьох класів заливки (uint8 0/255)."""
    purple = (b < PURPLE_B_MAX) & (a > PURPLE_A_MIN)
    blue = (b < BLUE_B_MAX) & (a <= BLUE_A_MAX)
    red = (a > RED_A_MIN) & (b > RED_B_MIN) & (L < RED_L_MAX)
    to8 = lambda m: (m.astype(np.uint8)) * 255
    return {"purple": to8(purple), "red": to8(red), "blue": to8(blue)}


def _stroke_mask(L):
    """Маска чорних штрихів-меж, трохи розширена, щоб гарантовано розрізати
    сусідні ділянки. Хрому не обмежуємо: поверх заливки штрих має підняті
    a*/b* (виміряно a* до ~+23), і поріг по |a*|,|b*| його б пропустив."""
    stroke = (L < STROKE_L_MAX).astype(np.uint8) * 255
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    return cv2.dilate(stroke, k, iterations=1)


def _ring_from_component(comp_mask, eps_px):
    """Зовнішній контур компонента -> спрощене кільце [(x, y), ...].

    RETR_EXTERNAL ігнорує внутрішні дірки (білий текст, темні плями під
    напівпрозорою заливкою) — полігон виходить "залитим". Якщо спрощення
    з'їдає кільце до <4 вершин, пробуємо дрібніший епсилон, потім сирий контур.
    """
    contours, _ = cv2.findContours(comp_mask, cv2.RETR_EXTERNAL,
                                   cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    cnt = max(contours, key=cv2.contourArea)
    for eps in (eps_px, eps_px * 0.5, 0.0):
        approx = cv2.approxPolyDP(cnt, eps, True) if eps > 0 else cnt
        if len(approx) >= 4:
            return [(int(p[0][0]), int(p[0][1])) for p in approx]
    return None


def extract_fields(bgr_image, min_area_px=MIN_AREA_PX, approx_eps_px=APPROX_EPS_PX):
    """Витягнути залиті полігони полів зі скріншота агро-ГІС.

    Args:
        bgr_image:     BGR-зображення (np.uint8 HxWx3, як з cv2.imread).
        min_area_px:   мінімальна площа компонента в пікселях (дрібніше — шум).
        approx_eps_px: епсилон спрощення контуру approxPolyDP, пікселі.

    Returns:
        Список словників, відсортований за площею (спадання):
          {"ring_px": [(x, y), ...],   # зовнішнє кільце, пікселі зображення
           "cls": "purple"|"red"|"blue",
           "area_px": float}           # площа полігона кільця, px²
        Дірки не повертаються — заливки трактуються як суцільні (дірки в
        масці — це текст/тіні, а не реальні "вирізи" поля).
    """
    if bgr_image is None or getattr(bgr_image, "ndim", 0) != 3 \
            or bgr_image.shape[2] != 3:
        raise ValueError("extract_fields: очікується BGR-зображення HxWx3")

    L, a, b = _lab_true(bgr_image)
    masks = _class_masks(L, a, b)
    stroke = _stroke_mask(L)

    k_close = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    k_open = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))

    fields = []
    for cls, mask in masks.items():
        # 1) closing — заліплює білий текст, JPEG-рябизну і 1-2px розриви
        #    (СПОЧАТКУ closing, ПОТІМ віднімання штрихів — інакше closing
        #    назад заліпить розрізи по намальованих межах);
        m = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k_close)
        # 2) віднімаємо штрихи — сусідні ділянки розпадаються по межах;
        m = cv2.bitwise_and(m, cv2.bitwise_not(stroke))
        # 3) opening — прибирає волоски й 1-2px перемички, що лишилися.
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, k_open)

        n, labels, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
        for i in range(1, n):
            if stats[i, cv2.CC_STAT_AREA] < min_area_px:
                continue
            sel = labels == i
            # Компонентна перевірка медіан: строката природна пляма, що
            # просочилася крізь попіксельний поріг, тут відсіюється. Чесність
            # важливіша за повноту — сумнівний блоб краще НЕ рапортувати.
            medL = float(np.median(L[sel]))
            meda = float(np.median(a[sel]))
            medb = float(np.median(b[sel]))
            if not _COMP_GATES[cls](medL, meda, medb):
                continue
            comp = np.zeros(m.shape, dtype=np.uint8)
            comp[sel] = 255
            ring = _ring_from_component(comp, approx_eps_px)
            if ring is None:
                continue
            area = float(cv2.contourArea(
                np.asarray(ring, dtype=np.int32).reshape(-1, 1, 2)))
            if area < min_area_px:
                continue
            fields.append({"ring_px": ring, "cls": cls, "area_px": area})

    fields.sort(key=lambda f: -f["area_px"])
    return fields


# Кольори дебаг-рендера (BGR): контур + напівпрозора заливка
_DEBUG_COLORS = {"purple": (255, 0, 255), "red": (0, 0, 255), "blue": (255, 128, 0)}


def save_debug(img, fields, path):
    """Дебаг-рендер: намалювати знайдені полігони поверх зображення і зберегти.

    Кожне поле — контур + напівпрозора заливка кольором класу і підпис
    "<cls> <площа>". Для очного контролю власником (wrong georef = дрон
    поливає чуже поле, тому картинку треба вміти швидко перевірити оком).
    """
    canvas = img.copy()
    overlay = img.copy()
    for f in fields:
        pts = np.asarray(f["ring_px"], dtype=np.int32).reshape(-1, 1, 2)
        color = _DEBUG_COLORS.get(f["cls"], (255, 255, 255))
        cv2.fillPoly(overlay, [pts], color)
        cv2.polylines(canvas, [pts], True, color, 2)
    canvas = cv2.addWeighted(overlay, 0.35, canvas, 0.65, 0)
    for f in fields:
        pts = np.asarray(f["ring_px"], dtype=np.int32)
        cx, cy = pts[:, 0].mean(), pts[:, 1].mean()
        cv2.putText(canvas, f"{f['cls']} {int(f['area_px'])}",
                    (int(cx) - 30, int(cy)), cv2.FONT_HERSHEY_SIMPLEX,
                    0.4, (255, 255, 255), 1, cv2.LINE_AA)
    cv2.imwrite(str(path), canvas)
