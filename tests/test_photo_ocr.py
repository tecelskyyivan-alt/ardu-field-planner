"""Tests for backend/ocr_labels.py — village label detection + OCR.

Run:  ./.venv-photo/bin/python -m pytest tests/test_photo_ocr.py -v

Fixtures (tests/fixtures/agro_gis_*.jpg) are gitignored screenshots; tests
that need them are skipped when they are absent. OCR misreads of a letter or
two are tolerated the same way geocode will tolerate them: via rapidfuzz
similarity >= 85 against the true village name.
"""
import math
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

FIXTURES = Path(__file__).resolve().parent / "fixtures"
FIX1 = FIXTURES / "agro_gis_1.jpg"
FIX2 = FIXTURES / "agro_gis_2.jpg"

# Tolerance for the control-point centroid, px. Wrong georef sprays the wrong
# field, so this must stay tight relative to the image size.
PX_TOL = 60.0
# Minimum rapidfuzz similarity to the true name (mirrors geocode's snap gate).
FUZZ_MIN = 85


def _fuzz(a, b):
    from rapidfuzz import fuzz
    return fuzz.ratio(a.lower(), b.lower())


def _load(path):
    import cv2
    img = cv2.imread(str(path))
    assert img is not None, f"failed to read fixture {path}"
    return img


def _dist(px, target):
    return math.hypot(px[0] - target[0], px[1] - target[1])


def _report(name, labels):
    """Print what OCR actually saw — the caller wants raw strings + confs."""
    print(f"\n[{name}] labels found: {len(labels)}")
    for lab in labels:
        print(f"  raw={lab['raw']!r} text={lab['text']!r} "
              f"px=({lab['px'][0]:.1f},{lab['px'][1]:.1f}) conf={lab['conf']:.2f}")


# ---------------------------------------------------------------- unit tests

def test_clean_text():
    from backend.ocr_labels import clean_text
    assert clean_text("Бзів") == "Бзів"
    assert clean_text(" Волошинівка. ") == "Волошинівка"
    assert clean_text("Мар'янівка!") == "Мар'янівка"
    assert clean_text("Ново-Петрівці 123") == "Ново-Петрівці"
    assert clean_text("|Бобрик_») ") == "Бобрик"
    assert clean_text("a1b2 ...") == ""          # латиниця/цифри геть
    assert clean_text("Село  \n Нове") == "Село Нове"  # collapse spaces
    assert clean_text("-Бзів-") == "Бзів"        # обрізати крайові дефіси


def test_find_labels_empty_image():
    import numpy as np
    from backend.ocr_labels import find_labels
    blank = np.zeros((200, 300, 3), dtype=np.uint8)
    assert find_labels(blank) == []


# ------------------------------------------------------------- fixture tests

@pytest.mark.skipif(not FIX1.exists(), reason="gitignored fixture missing")
def test_agro_gis_1_labels():
    from backend.ocr_labels import find_labels
    labels = find_labels(_load(FIX1))
    _report("agro_gis_1", labels)

    expected = {"бзів": (265, 248), "волошинівка": (790, 255)}
    matched = {}
    for lab in labels:
        for true_name, target in expected.items():
            if _fuzz(lab["text"], true_name) >= FUZZ_MIN:
                matched[true_name] = lab
                assert _dist(lab["px"], target) <= PX_TOL, (
                    f"{true_name}: centroid {lab['px']} too far from {target}")
    assert set(matched) == set(expected), (
        f"missing labels: {set(expected) - set(matched)}; got "
        f"{[(l['text'], l['conf']) for l in labels]}")

    # Precision gate: EVERY emitted label must be one of the two real names.
    # False labels feed the geocoder and can drag the georef to a wrong place.
    for lab in labels:
        best = max(_fuzz(lab["text"], n) for n in expected)
        assert best >= FUZZ_MIN, f"false label: {lab['text']!r} (raw {lab['raw']!r})"

    for lab in matched.values():
        assert lab["conf"] >= 0.5


@pytest.mark.skipif(not FIX2.exists(), reason="gitignored fixture missing")
def test_agro_gis_2_labels():
    from backend.ocr_labels import find_labels
    labels = find_labels(_load(FIX2))
    _report("agro_gis_2", labels)

    hits = [l for l in labels if _fuzz(l["text"], "бобрик") >= FUZZ_MIN]
    assert hits, f"'Бобрик' not found; got {[(l['text'], l['conf']) for l in labels]}"
    lab = hits[0]
    assert _dist(lab["px"], (510, 235)) <= PX_TOL
    assert lab["conf"] >= 0.5

    # Precision: nothing else on this screenshot is a label.
    for l in labels:
        assert _fuzz(l["text"], "бобрик") >= FUZZ_MIN, (
            f"false label: {l['text']!r} (raw {l['raw']!r})")


# ------------------------------------------------- network-dependent (none)

@pytest.mark.skipif(os.environ.get("FMP_NET_TESTS") != "1",
                    reason="network tests disabled (set FMP_NET_TESTS=1)")
def test_placeholder_net():
    """OCR needs no network; placeholder keeps the env-gate convention visible."""
    assert True
