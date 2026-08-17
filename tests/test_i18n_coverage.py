#!/usr/bin/env python3
"""
test_i18n_coverage.py — стежить, щоб покриття перекладом не деградувало.

ЩО ЛОВИТЬ. Українська — мова-джерело; динамічні рядки мусять іти через
t(), інакше в англійському режимі лишаються українськими. Легко забути
при додаванні нового коду: воно працює й виглядає правильно, поки не
перемкнути мову.

ЧОМУ САМЕ ТАК. Тест не вимагає 100% покриття — це нереалістично й
призвело б до того, що його вимкнуть. Він фіксує ДОСЯГНУТИЙ рівень і
падає лише на регресії: якщо необгорнутих із наявним перекладом стало
більше, ніж було, — хтось додав рядок і забув t().

Запуск: python3 tests/test_i18n_coverage.py
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, "web-stable", "app.js")
I18N = os.path.join(ROOT, "web-stable", "i18n.js")

# Досягнутий рівень на 2026-08-17 після масової обгортки 178 рядків.
# Лишилися 12 — усі всередині шаблонних літералів із ${...}, де
# автоматична правка небезпечна (треба руками).
MAX_UNWRAPPED_WITH_TRANSLATION = 12

CYR = re.compile(r"[а-яїєіґА-ЯЇЄІҐ]")
LIT = re.compile(r"""(['"`])((?:\\.|(?!\1)[^\\])*)\1""")


def scan():
    i18n_src = open(I18N, encoding="utf-8").read()
    keys = set(re.findall(r'"((?:[^"\\]|\\.)+)"\s*:', i18n_src))
    app = open(APP, encoding="utf-8").read()

    wrapped = 0
    unwrapped_have = []
    unwrapped_missing = []

    for i, line in enumerate(app.split("\n"), 1):
        s = line.strip()
        if s.startswith("//") or s.startswith("*"):
            continue
        for m in LIT.finditer(line):
            text = m.group(2)
            if not CYR.search(text):
                continue
            before = line[max(0, m.start() - 3):m.start()]
            if re.search(r"\bt\(\s*$", before):
                wrapped += 1
                continue
            if line[m.end():m.end() + 2].strip().startswith(":"):
                continue
            if "<" in text and ">" in text:
                continue
            if len(text.strip()) < 4:
                continue
            # ⚠ ТОЧНИЙ збіг, БЕЗ нормалізації. 17.08 .strip() призвів до
            # того, що "Поле " (із пробілом у кінці) вважався наявним у
            # словнику за ключем "Поле", був обгорнутий у t() — і CI впав:
            # t() шукає ключ ДОСЛІВНО, пробіл робить його іншим ключем.
            if text in keys:
                unwrapped_have.append((i, text))
            else:
                unwrapped_missing.append((i, text))

    return keys, wrapped, unwrapped_have, unwrapped_missing


keys, wrapped, have, missing = scan()

print("── покриття i18n ──────────────────────────────────")
print(f"  ключів у i18n.js:               {len(keys)}")
print(f"  обгорнуто в t():                {wrapped}")
print(f"  необгорнуто, переклад Є:        {len(have)}  (ліміт {MAX_UNWRAPPED_WITH_TRANSLATION})")
print(f"  необгорнуто, перекладу нема:    {len(missing)}")

fail = False

if len(have) > MAX_UNWRAPPED_WITH_TRANSLATION:
    fail = True
    print(f"\n  ✗ РЕГРЕСІЯ: {len(have)} рядків мають переклад, але не обгорнуті")
    print(f"    було не більше {MAX_UNWRAPPED_WITH_TRANSLATION}. Нові:")
    for ln, t_ in have[:10]:
        print(f"      рядок {ln}: {t_[:60]}")
    print("    Обгорни у t(\"…\") — переклад уже лежить в i18n.js.")
else:
    print("\n  ✓ регресії немає")

# Мертві ключі: є в словнику, але ніде не вживаються — словник росте
# сміттям, і згодом ніхто не знає, що можна прибрати.
app_src = open(APP, encoding="utf-8").read()
html_path = os.path.join(ROOT, "web-stable", "index.html")
html_src = open(html_path, encoding="utf-8").read() if os.path.exists(html_path) else ""
dead = [k for k in keys
        if k not in app_src and k not in html_src]
if dead:
    print(f"\n  ⓘ мертвих ключів у словнику: {len(dead)} (не помилка)")
    for k in dead[:5]:
        print(f"      {k[:60]}")

sys.exit(1 if fail else 0)
