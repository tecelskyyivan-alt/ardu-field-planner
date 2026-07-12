"""Будує локальний газетир населених пунктів України з дампа GeoNames.

Це build-крок (потрібна мережа), НЕ рантайм: качає UA.zip (~2 МБ) з
download.geonames.org, фільтрує feature_class='P' (populated places) і пише
data/gazetteer.sqlite. Рантайм (backend/geocode.py) читає лише sqlite.

Один населений пункт -> кілька рядків: по одному на кожен варіант назви
(основна, asciiname, кириличні alternatenames), щоб точний пошук по
name_norm ловив і «Бзів», і «Bziv». Дедуп кандидатів у geocode.lookup()
іде по geonameid.

Запуск:  python scripts/build_gazetteer.py [--out data/gazetteer.sqlite]
"""
import argparse
import io
import os
import sqlite3
import sys
import urllib.request
import zipfile

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

from backend.geocode import normalize_name  # єдине джерело правди нормалізації

GEONAMES_URL = "https://download.geonames.org/export/dump/UA.zip"
DEFAULT_OUT = os.path.join(REPO_ROOT, "data", "gazetteer.sqlite")

# Колонки таб-розділеного UA.txt (формат GeoNames "geoname" table)
COL_ID, COL_NAME, COL_ASCII, COL_ALT = 0, 1, 2, 3
COL_LAT, COL_LON, COL_FCLASS = 4, 5, 6
COL_ADMIN1, COL_POP = 10, 14


def _has_cyrillic(s):
    return any("Ѐ" <= ch <= "ӿ" for ch in s)


def _is_plain_latin(s):
    """Латиниця/цифри/пунктуація без екзотичних скриптів (грузинська, CJK...)."""
    return all(ord(ch) < 0x250 for ch in s)


def _pick_display_name(name, alt_list):
    """Показова назва: українська кирилиця > будь-яка кирилиця > основна.

    В UA.txt alternatenames без мовних тегів, тож україномовний варіант
    вгадуємо по літерах є/і/ї/ґ; це евристика, але для UI достатньо.
    """
    ua_letters = set("єіїґЄІЇҐ")
    cyr = [a for a in alt_list if _has_cyrillic(a)]
    for a in cyr:
        if set(a) & ua_letters:
            return a
    return cyr[0] if cyr else name


def build(out_path, url=GEONAMES_URL, txt_bytes=None):
    """Качає дамп (або бере готові txt_bytes у тестах) і пише sqlite.

    Повертає (place_count, row_count).
    """
    if txt_bytes is None:
        print("Завантажую %s ..." % url)
        with urllib.request.urlopen(url, timeout=120) as resp:
            zip_bytes = resp.read()
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
            txt_bytes = zf.read("UA.txt")

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    tmp_path = out_path + ".tmp"
    if os.path.exists(tmp_path):
        os.remove(tmp_path)
    con = sqlite3.connect(tmp_path)
    con.execute("""
        CREATE TABLE places (
            geonameid  INTEGER NOT NULL,
            name_norm  TEXT NOT NULL,
            name       TEXT NOT NULL,
            alt_names  TEXT NOT NULL,
            lat        REAL NOT NULL,
            lon        REAL NOT NULL,
            admin1     TEXT NOT NULL,
            population INTEGER NOT NULL
        )""")

    place_count = 0
    row_count = 0
    for line in txt_bytes.decode("utf-8").splitlines():
        parts = line.split("\t")
        if len(parts) < 15 or parts[COL_FCLASS] != "P":
            continue
        gid = int(parts[COL_ID])
        name = parts[COL_NAME]
        alt_raw = parts[COL_ALT]
        alt_list = [a.strip() for a in alt_raw.split(",") if a.strip()]
        lat, lon = float(parts[COL_LAT]), float(parts[COL_LON])
        admin1 = parts[COL_ADMIN1]
        try:
            pop = int(parts[COL_POP] or 0)
        except ValueError:
            pop = 0

        display = _pick_display_name(name, alt_list)
        # Індексуємо: основна назва + ascii + кириличні/латинські варіанти
        # (варіанти в інших скриптах — грецька, CJK тощо — OCR не дасть).
        variants = [name, parts[COL_ASCII]] + [
            a for a in alt_list if _has_cyrillic(a) or _is_plain_latin(a)]
        seen = set()
        alt_joined = ",".join(alt_list)
        for v in variants:
            norm = normalize_name(v)
            if not norm or norm in seen:
                continue
            seen.add(norm)
            con.execute("INSERT INTO places VALUES (?,?,?,?,?,?,?,?)",
                        (gid, norm, display, alt_joined, lat, lon, admin1, pop))
            row_count += 1
        place_count += 1

    con.execute("CREATE INDEX idx_places_norm ON places(name_norm)")
    con.commit()
    con.close()
    os.replace(tmp_path, out_path)
    print("Готово: %s — %d населених пунктів, %d рядків-варіантів"
          % (out_path, place_count, row_count))
    return place_count, row_count


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default=DEFAULT_OUT, help="шлях до gazetteer.sqlite")
    args = ap.parse_args()
    build(args.out)
