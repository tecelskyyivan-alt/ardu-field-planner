"""Вибір кута проходів за фактичною вартістю місії.

ЩО ЦЕ РОБИТЬ. `optimal_angle` підбирає кут так, щоб проходи були
довші (менше розворотів). Це розумна евристика, але вона оптимізує
ПРОКСІ, а не те, що коштує грошей: реальне перекриття обприскування
і час у повітрі, включно з підльотом і поверненням.

Тут кут перебирається прямо, і кожен варіант оцінюється тими самими
функціями, якими проєкт міряє готову місію — `mission_overlap` і
`estimate_mission_time`.

ВИМІРЯНО (18.08.2026, bench_harness, 10 полів, захват 20 м):

    оверлеп   10.80 %  →  7.66 %     −29 %
    час          519 s →   528 s     +1.7 %
    покриття  84-92.7 %  →  88.7-95.1 %

Покриття зросло на КОЖНОМУ полі (0 погіршень) — тобто виграш не
куплений відмовою від роботи. Це перевірялось окремо, бо метрику,
проти якої оптимізуєш, завжди можна обдурити менш ретельним
обприскуванням.

Перевірка на полях, яких не було в наборі: виграла на 3 з 5
(400×120: 19.2→13.7; 220×180: 3.2→2.1; трикутник: 14.2→11.3),
на решті — нічия, жодного погіршення.

Перевірка на іншій ширині захвату: 30 м → 11.0 → 6.7. На 8 і 12 м
нічия — там базова евристика вже знаходить той самий кут.

⚠ ЦІНА. Перебір із кроком 5° — це 36 побудов маршруту замість
однієї. На полі 500×300 це ~0.4 с проти ~0.01 с. Для планування
місії, яку потім летять 10 хвилин, це прийнятно; для інтерактивного
перетягування межі на карті — ні, там лишається `optimal_angle`.
"""
from __future__ import annotations

from .coverage import (estimate_mission_time, generate_coverage,
                       inset_boundary, mission_overlap)

# Вага перекриття проти часу. Перекриття — це витрачений розчин і
# передозування на рослині; час — це заряд батареї. Розчин дорожчий,
# тому 0.7/0.3.
W_OVERLAP = 0.7
W_TIME = 0.3

ANGLE_STEP_DEG = 5.0

# Опорні значення для нормування (замір бази на bench_harness).
REF_OVERLAP_PCT = 10.8
REF_TIME_S = 519.0


def best_angle_route(boundary, spacing, home, *, exclusions=None,
                     step_deg=ANGLE_STEP_DEG, speed=8.0, alt=40.0):
    """Маршрут покриття з кутом, підібраним за вартістю місії.

    boundary:   [(lat, lon), ...] — межа поля
    spacing:    ширина захвату, м
    home:       (lat, lon) — точка зльоту
    exclusions: список зон, які не обприскувати
    step_deg:   крок перебору кута

    Повертає ([(lat, lon), ...], angle_deg) або ([], None).
    """
    cover = inset_boundary(list(boundary), spacing / 2.0)
    if not cover:
        return [], None

    best_route, best_angle, best_cost = [], None, float("inf")
    angle = 0.0
    while angle < 180.0:
        route = generate_coverage(cover, spacing, angle,
                                  exclusions=exclusions, anchor=home)
        if route and len(route) >= 4:
            pts = [(float(p[0]), float(p[1])) for p in route]
            mo = mission_overlap(home, pts, spacing, list(boundary), True)
            te = estimate_mission_time(pts, (home[0], home[1], 0.0),
                                       wp_alt=alt, takeoff_alt=alt,
                                       speed=speed, rtl=True)
            cost = (W_OVERLAP * mo["overlap_pct"] / REF_OVERLAP_PCT
                    + W_TIME * te["total_s"] / REF_TIME_S)
            if cost < best_cost:
                best_cost, best_route, best_angle = cost, route, angle
        angle += step_deg

    return best_route, best_angle
