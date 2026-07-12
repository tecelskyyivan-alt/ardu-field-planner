"""Village-name label detection + OCR on agro-GIS screenshots.

The photo-import pipeline needs *named* control points to georeference a
screenshot: the white village labels the GIS draws over the satellite basemap.
This module finds those labels and reads them with tesseract.

Approach (detect first, OCR second):
  1. Mask bright near-white pixels in HSV (labels are white with a subtle dark
     halo; the halo keeps them separated from bright roofs/roads around them).
  2. Dilate the mask horizontally so individual letters merge into word blobs,
     then take connected components as candidate word boxes.
  3. Filter boxes by geometry (text-like height, aspect, area, letter count,
     fill ratio) — precision matters more than recall here, because every
     label we emit becomes a geocoder query and a potential control point.
  4. OCR each box: crop with padding, 4x Lanczos upscale, grayscale, Otsu
     threshold inverted (white letters -> black-on-white), tesseract --psm 7
     with the Ukrainian model.
  5. Keep only results that still look like a word after cleaning (>= 3
     Cyrillic letters) and pass the confidence floor.

The returned pixel position is the centroid of the *text mask pixels* of the
label in original-image coordinates — this is the georef control point that
gets matched against geocoded village coordinates downstream (geocode module,
not here). Wrong georef sprays the wrong field, so we report tesseract's own
confidence honestly and never guess: unreadable boxes are dropped, not padded.

Server-only module: imports cv2/pytesseract at top level, never loaded by
Pyodide (api.py lazy-imports it).
"""
import re

import cv2
import numpy as np
import pytesseract

# --- Калібровано на tests/fixtures/agro_gis_*.jpg ---
# Білий текст ярлика: висока яскравість, майже нульова насиченість.
V_MIN = 200          # HSV value: білі літери яскравіші за більшість дахів
S_MAX = 40           # HSV saturation: білий = ненасичений
# Геометрія словесного боксу (в пікселях оригінального скріншота).
H_MIN, H_MAX = 15, 60    # висота рядка тексту у веб-ГІС при типовому зумі
ASPECT_MIN = 1.2         # слово завжди ширше за висоту
AREA_MIN = 300           # відсікає дрібний шум і поодинокі відблиски
NCOMP_MIN = 2            # слово = кілька окремих літер; дах = один блоб
FILL_MAX = 0.75          # текст не заповнює бокс суцільно, дах — так
MERGE_KERNEL = (25, 3)   # горизонтальна дилатація: зшити літери у слово
PAD = 6                  # відступ навколо боксу перед OCR
UPSCALE = 4              # Lanczos-масштабування перед tesseract

# Дозволені символи після OCR: кирилиця + апостроф + дефіс + пробіл.
# tessedit_char_whitelist ненадійний для LSTM-движка, тому фільтруємо regex-ом.
_ALLOWED_RE = re.compile(r"[^А-ЩЬЮЯЄІЇҐа-щьюяєіїґ'ʼ\- ]+")


def _white_text_mask(bgr_image):
    """Binary mask (uint8 0/255) of bright near-white pixels (label text)."""
    hsv = cv2.cvtColor(bgr_image, cv2.COLOR_BGR2HSV)
    _, s, v = cv2.split(hsv)
    return ((v > V_MIN) & (s < S_MAX)).astype(np.uint8) * 255


def _word_boxes(mask):
    """Merge letter blobs into word boxes and filter to text-like ones.

    Returns a list of (x, y, w, h) in original-image pixels. The box is the
    tight bounding box of the *undilated* mask pixels inside each merged
    component, so the horizontal dilation does not skew the box (and thus the
    control-point centroid) sideways.
    """
    kern = cv2.getStructuringElement(cv2.MORPH_RECT, MERGE_KERNEL)
    dilated = cv2.dilate(mask, kern)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(dilated, connectivity=8)
    boxes = []
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if not (H_MIN <= h <= H_MAX):
            continue
        if w / max(h, 1) <= ASPECT_MIN or area <= AREA_MIN:
            continue
        # Оригінальні (недилатовані) пікселі тексту всередині компонента.
        sub = mask[y:y + h, x:x + w] & (labels[y:y + h, x:x + w] == i).astype(np.uint8) * 255
        ys, xs = np.nonzero(sub)
        if len(xs) == 0:
            continue
        bx0, bx1 = int(xs.min()), int(xs.max())
        by0, by1 = int(ys.min()), int(ys.max())
        bw, bh = bx1 - bx0 + 1, by1 - by0 + 1
        # Кількість окремих літер: слово має їх декілька, суцільна пляма — одну.
        ncomp, _, _, _ = cv2.connectedComponentsWithStats(sub, connectivity=8)
        if ncomp - 1 < NCOMP_MIN:
            continue
        # Заповненість: текст «дірявий», яскравий дах — суцільний.
        fill = float(np.count_nonzero(sub)) / max(bw * bh, 1)
        if fill > FILL_MAX:
            continue
        boxes.append((x + bx0, y + by0, bw, bh))
    return boxes


def _ocr_box(bgr_image, box):
    """OCR one word box. Returns (raw_text, conf 0..1); ('', 0.0) if unreadable."""
    x, y, w, h = box
    img_h, img_w = bgr_image.shape[:2]
    x0, y0 = max(0, x - PAD), max(0, y - PAD)
    x1, y1 = min(img_w, x + w + PAD), min(img_h, y + h + PAD)
    crop = bgr_image[y0:y1, x0:x1]
    up = cv2.resize(crop, None, fx=UPSCALE, fy=UPSCALE, interpolation=cv2.INTER_LANCZOS4)
    gray = cv2.cvtColor(up, cv2.COLOR_BGR2GRAY)
    # Білі літери -> чорні на білому: tesseract навчений на такому контрасті.
    _, binarized = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    data = pytesseract.image_to_data(
        binarized, lang="ukr", config="--psm 7",
        output_type=pytesseract.Output.DICT,
    )
    words, confs = [], []
    for text, conf in zip(data["text"], data["conf"]):
        conf = float(conf)
        if text.strip() and conf >= 0:  # -1 = не слово (службовий рядок layout-у)
            words.append(text.strip())
            confs.append(conf)
    if not words:
        return "", 0.0
    return " ".join(words), sum(confs) / len(confs) / 100.0


def clean_text(raw):
    """Strip non-letter junk from an OCR string, collapse whitespace.

    Keeps Ukrainian Cyrillic letters, apostrophe and hyphen (Мар'янівка,
    Новосілки-на-Дніпрі). Leading/trailing hyphens/apostrophes are OCR
    artifacts and are trimmed too.
    """
    cleaned = _ALLOWED_RE.sub(" ", raw)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned.strip("'ʼ- ")


def _letter_count(text):
    """Number of Cyrillic letters in a cleaned string."""
    return len(re.findall(r"[А-ЩЬЮЯЄІЇҐа-щьюяєіїґ]", text))


def find_labels(bgr_image, min_conf=0.4):
    """Find white village-name labels on an agro-GIS screenshot and read them.

    Args:
        bgr_image: numpy uint8 BGR image (as from cv2.imread / imdecode).
        min_conf: drop labels whose mean tesseract confidence (0..1) is below
            this floor. False labels feed the geocoder, so the default is
            deliberately conservative.

    Returns:
        List of dicts, one per accepted label:
          text: cleaned name (letters/apostrophe/hyphen only, spaces collapsed)
          px:   (cx, cy) float centroid of the label's text pixels in
                original-image coordinates — the georef control point
          conf: mean tesseract word confidence, 0..1
          raw:  the raw OCR string before cleaning (for debugging/logging)
        Sorted by confidence, highest first. Unreadable or non-text boxes are
        dropped silently — better to miss a label than to invent one.
    """
    if bgr_image is None or bgr_image.size == 0:
        return []
    if bgr_image.ndim == 2:  # про всяк випадок: grayscale -> BGR
        bgr_image = cv2.cvtColor(bgr_image, cv2.COLOR_GRAY2BGR)

    mask = _white_text_mask(bgr_image)
    results = []
    for box in _word_boxes(mask):
        raw, conf = _ocr_box(bgr_image, box)
        text = clean_text(raw)
        if _letter_count(text) < 3 or conf < min_conf:
            continue
        x, y, w, h = box
        sub = mask[y:y + h, x:x + w]
        ys, xs = np.nonzero(sub)
        if len(xs):  # центроїд саме пікселів тексту, не боксу
            cx, cy = float(x + xs.mean()), float(y + ys.mean())
        else:
            cx, cy = x + w / 2.0, y + h / 2.0
        results.append({"text": text, "px": (cx, cy), "conf": conf, "raw": raw})
    results.sort(key=lambda r: -r["conf"])
    return results
