"""Геокодування назв сіл з OCR по локальному газетиру GeoNames UA.

Газетир (data/gazetteer.sqlite) будується заздалегідь скриптом
scripts/build_gazetteer.py — рантайм повністю офлайновий. Один населений
пункт має кілька рядків: по одному на кожен варіант назви (основна,
ascii, кириличні alternatenames), усі з однаковим geonameid.

Головна небезпека: назви сіл в Україні масово повторюються (десятки
"Бобриків"). Тому lookup() чесно повертає ВСІ кандидати, а disambiguate()
шукає кластер, де всі підписані на скріншоті села лежать поруч (< 40 км —
більше ніж покриває один скріншот). Якщо однозначного кластера нема —
confident=False, і downstream ЗОБОВ'ЯЗАНИЙ показати підтвердження на мапі.
"""
import os
import re
import sqlite3
import unicodedata

from .geo import haversine

# data/gazetteer.sqlite відносно кореня репозиторію
DB_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       "data", "gazetteer.sqlite")

# Усі схожі на апостроф символи (у назвах типу Мар'янівка / Марʼянівка)
_APOSTROPHES = "ʼ’‘'`´′"
_WS_RE = re.compile(r"[\s ]+")

# Латинські гомогліфи -> кирилиця. OCR (навіть з lang=ukr) любить вставляти
# латинську i/o/e у кириличне слово; для коротких назв (Бзiв) fuzzy це вже
# не рятує, а детермінований фолд — так. Застосовується ЛИШЕ якщо в рядку
# вже є кирилиця (чисто латинські "Bziv" не чіпаємо).
_HOMOGLYPHS = str.maketrans("aceiopxyï", "асеіорхуї")

# Кеш на процес: {db_path: список distinct name_norm для fuzzy}
_FUZZY_CACHE = {}


def normalize_name(name):
    """Нормалізація назви для індексації і пошуку.

    Правила: NFC (НЕ NFKD — інакше ї розпадеться на і+діакритик, а ї/і в
    українській різні літери), lowercase, усі варіанти апострофа геть,
    латинські гомогліфи в кириличному слові -> кирилиця, пробіли схлопнути.
    е/є та и/і свідомо НЕ змішуємо — це різні українські літери.
    """
    s = unicodedata.normalize("NFC", str(name)).lower()
    for ch in _APOSTROPHES:
        s = s.replace(ch, "")
    if any("а" <= ch <= "я" or ch in "єіїґё" for ch in s):
        s = s.translate(_HOMOGLYPHS)
    s = _WS_RE.sub(" ", s).strip()
    return s


def _connect(db_path=None):
    path = db_path or DB_PATH
    if not os.path.exists(path):
        raise FileNotFoundError(
            "Газетир %s не знайдено — запусти scripts/build_gazetteer.py" % path)
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    return con


def _rows_to_candidates(rows, score_by_norm=None):
    """Рядки БД -> список кандидатів, дедуп по geonameid (кращий score)."""
    best = {}
    for r in rows:
        score = 100.0 if score_by_norm is None else score_by_norm.get(r["name_norm"], 0.0)
        cur = best.get(r["geonameid"])
        if cur is None or score > cur["score"]:
            best[r["geonameid"]] = {
                "name": r["name"],
                "lat": r["lat"],
                "lon": r["lon"],
                "admin1": r["admin1"],
                "population": r["population"],
                "score": score,
            }
    out = list(best.values())
    out.sort(key=lambda c: (-c["score"], -c["population"]))
    return out


def lookup(name, fuzzy=True, db_path=None, min_score=85.0, limit=10):
    """Кандидати населених пунктів на OCR-назву.

    Спершу точний збіг по name_norm (score=100). Якщо порожньо і fuzzy=True —
    rapidfuzz по всіх нормалізованих назвах у пам'яті (score >= min_score,
    рятує від OCR-помилок на 1-2 літери). Повертає список dict
    {name, lat, lon, admin1, population, score}, кращі перші, до `limit`.
    """
    norm = normalize_name(name)
    if not norm:
        return []
    con = _connect(db_path)
    try:
        rows = con.execute(
            "SELECT * FROM places WHERE name_norm = ?", (norm,)).fetchall()
        if rows:
            return _rows_to_candidates(rows)[:limit]
        if not fuzzy:
            return []

        # Fuzzy: один раз читаємо всі name_norm у пам'ять (≈сотні тисяч
        # коротких рядків — дешево), далі rapidfuzz по кешу.
        from rapidfuzz import fuzz, process
        path_key = db_path or DB_PATH
        if path_key not in _FUZZY_CACHE:
            all_norms = [r["name_norm"] for r in con.execute(
                "SELECT DISTINCT name_norm FROM places")]
            _FUZZY_CACHE[path_key] = all_norms
        # fuzz.ratio (Indel), НЕ WRatio: партіал-бонуси WRatio піднімають
        # підрядки ("Волошнівка" на запит "Волошиновка") вище правильної назви
        matches = process.extract(
            norm, _FUZZY_CACHE[path_key], scorer=fuzz.ratio,
            score_cutoff=min_score, limit=limit * 3)
        if not matches:
            return []
        score_by_norm = {m[0]: float(m[1]) for m in matches}
        qmarks = ",".join("?" * len(score_by_norm))
        rows = con.execute(
            "SELECT * FROM places WHERE name_norm IN (%s)" % qmarks,
            list(score_by_norm)).fetchall()
        return _rows_to_candidates(rows, score_by_norm)[:limit]
    finally:
        con.close()


def disambiguate(cands_by_label, max_km=40.0, max_per_label=8):
    """Вибір узгодженої комбінації кандидатів для міток одного скріншота.

    cands_by_label: {назва_мітки: [кандидати з lookup()], ...}.
    Логіка кластерного консенсусу: скріншот покриває < max_km, тож правильні
    села лежать поруч. Перебираємо комбінації (до max_per_label кандидатів
    на мітку) і лишаємо ті, де ВСІ попарні відстані < max_km.

    Повертає dict:
      chosen     — {мітка: кандидат або None}
      confident  — True лише коли комбінація рівно одна (для 1 мітки — коли
                   кандидат рівно один); інакше downstream мусить питати
      n_combos   — скільки валідних комбінацій знайдено
      alternates — {мітка: список інших кандидатів з валідних комбінацій}
      reason     — людське пояснення (для логів/UI)
    """
    labels = [lb for lb in cands_by_label if cands_by_label[lb]]
    empty = [lb for lb in cands_by_label if not cands_by_label[lb]]
    result = {"chosen": {lb: None for lb in cands_by_label},
              "confident": False, "n_combos": 0,
              "alternates": {lb: [] for lb in cands_by_label}, "reason": ""}
    if not labels:
        result["reason"] = "жодна мітка не знайдена в газетирі"
        return result

    if len(labels) == 1:
        # Одна мітка — географічно перевіряти нема з чим.
        lb = labels[0]
        cands = cands_by_label[lb][:max_per_label]
        result["chosen"][lb] = cands[0]  # кращий (score, населення) — але це лише гіпотеза
        result["alternates"][lb] = cands[1:]
        result["n_combos"] = len(cands)
        result["confident"] = len(cands) == 1 and not empty
        result["reason"] = ("єдиний кандидат" if len(cands) == 1 else
                            "%d кандидатів на «%s», перехресної перевірки нема — "
                            "потрібне підтвердження" % (len(cands), lb))
        return result

    # 2+ міток: перебір комбінацій із перевіркою попарних відстаней.
    pools = [cands_by_label[lb][:max_per_label] for lb in labels]
    valid = []

    def _walk(i, picked):
        if i == len(pools):
            valid.append(list(picked))
            return
        for cand in pools[i]:
            ok = all(haversine(cand["lat"], cand["lon"], p["lat"], p["lon"]) < max_km * 1000.0
                     for p in picked)
            if ok:
                picked.append(cand)
                _walk(i + 1, picked)
                picked.pop()

    _walk(0, [])
    result["n_combos"] = len(valid)
    if not valid:
        result["reason"] = "жодної комбінації з попарними відстанями < %g км" % max_km
        return result

    # Ранжуємо комбінації: сумарний score, потім сумарне населення.
    valid.sort(key=lambda combo: (-sum(c["score"] for c in combo),
                                  -sum(c["population"] for c in combo)))
    best = valid[0]
    for lb, cand in zip(labels, best):
        result["chosen"][lb] = cand
    for combo in valid[1:]:
        for lb, cand in zip(labels, combo):
            if cand is not result["chosen"][lb] and cand not in result["alternates"][lb]:
                result["alternates"][lb].append(cand)
    result["confident"] = len(valid) == 1 and not empty
    result["reason"] = ("однозначний кластер < %g км" % max_km if result["confident"]
                        else "%d валідних комбінацій — потрібне підтвердження" % len(valid))
    return result
