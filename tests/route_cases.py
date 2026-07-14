"""Спільні тестові поля для бенчмарку (bench_route.py) та еквівалентності
(test_route_equiv.py) движка маршрутів.

4 реалістичні кейси, згенеровані СИНТЕТИЧНО з фіксованим seed — стабільні між
запусками, без приватних даних (репозиторій публічний):

  a) big_irregular   — велике нерегулярне поле ~50 га, ~350 вершин контуру;
  b) big_exclusions  — те саме поле + 2 виключення (дерева/стовп/ставок);
  c) small_simple    — мале просте поле ~3 га, 10 вершин;
  d) long_narrow     — довге вузьке поле, аспект ~8:1.

Параметри build_route відповідають РЕАЛЬНОМУ шляху користувача в APK
(app.js -> FMP_ENGINE.buildRoute -> Api.build_route):
auto_angle=True + optimize="overlap" (небистрий "справжній" build, не live-drag),
spacing 20 м, margin 5 м, розбиття по батареї увімкнено (battery_min).
"""
import math
import os
import random
import sys

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from backend.geo import local_to_latlon, latlon_to_local, centroid  # noqa: E402

# Центр умовного поля (центральна Україна, як у реального оператора).
LAT0, LON0 = 49.0, 32.0

SPACING = 20.0      # крок проходів, м (дефолт UI)
MARGIN = 5.0        # відступ від краю, м (за завданням)
SPEED = 12.0        # м/с (дефолт UI)
ALT = 50.0          # м (дефолт UI)
BATTERY_MIN = 15.0  # хв — battery split увімкнено


def _ring_to_ll(pts_local):
    """Локальні метри навколо (LAT0, LON0) -> [(lat, lon), ...]."""
    return [local_to_latlon(x, y, LAT0, LON0) for x, y in pts_local]


def _blob(n_vtx, r0, seed, amp=(0.18, 0.12, 0.06), jitter=4.0, cx=0.0, cy=0.0):
    """Зіркоподібний (простий, без самоперетинів) полігон із низькочастотною
    синусоїдною нерегулярністю + вершинним шумом. Фіксований seed."""
    rng = random.Random(seed)
    ph = [rng.uniform(0, 2 * math.pi) for _ in range(3)]
    pts = []
    for i in range(n_vtx):
        th = 2 * math.pi * i / n_vtx
        r = r0 * (1.0
                  + amp[0] * math.sin(3 * th + ph[0])
                  + amp[1] * math.sin(7 * th + ph[1])
                  + amp[2] * math.sin(13 * th + ph[2]))
        r += rng.gauss(0.0, jitter)
        r = max(r, 0.2 * r0)
        pts.append((cx + r * math.cos(th), cy + r * math.sin(th)))
    return pts


def big_irregular_boundary():
    """~50 га, ~350 вершин: r0=400 м -> pi*r0^2 ~ 50.3 га."""
    return _ring_to_ll(_blob(350, 400.0, seed=4242))


def big_field_exclusions():
    """2 виключення всередині великого поля: ~0.6 га та ~0.4 га."""
    ex1 = _ring_to_ll(_blob(8, 45.0, seed=101, amp=(0.10, 0.05, 0.0),
                            jitter=2.0, cx=120.0, cy=110.0))
    ex2 = _ring_to_ll(_blob(6, 35.0, seed=202, amp=(0.10, 0.05, 0.0),
                            jitter=2.0, cx=-150.0, cy=-130.0))
    return [ex1, ex2]


def small_simple_boundary():
    """~3 га, 10 вершин."""
    return _ring_to_ll(_blob(10, 103.0, seed=77, amp=(0.06, 0.03, 0.0), jitter=3.0))


def long_narrow_boundary():
    """Довге вузьке поле ~880x110 м (аспект 8:1), 10 вершин, легкий шум."""
    rng = random.Random(9001)
    L, W = 880.0, 110.0
    xs = [0.0, L * 0.25, L * 0.5, L * 0.75, L]
    bottom = [(x, rng.uniform(-4.0, 4.0)) for x in xs]
    top = [(x, W + rng.uniform(-4.0, 4.0)) for x in reversed(xs)]
    ring = bottom + top
    # центруємо навколо (0,0), інакше проєкція навколо LAT0/LON0 зміщена
    ring = [(x - L / 2.0, y - W / 2.0) for x, y in ring]
    return _ring_to_ll(ring)


def _ll_dicts(ring):
    return [{"lat": la, "lng": lo} for la, lo in ring]


def build_params(boundary_ll, exclusions_ll=None):
    """params для Api.build_route — те, що шле APK на «справжньому» build
    (не live), + margin/battery за завданням. viz=False = дефолт чекбокса."""
    return {
        "boundary": _ll_dicts(boundary_ll),
        "spacing": SPACING,
        "angle": 0.0,
        "auto_angle": True,
        "optimize": "overlap",
        "margin": MARGIN,
        "alt": ALT,
        "speed": SPEED,
        "rtl": True,
        "exclusions": [_ll_dicts(e) for e in (exclusions_ll or [])],
        "viz": False,
        "battery_min": BATTERY_MIN,
    }


def make_cases():
    """[{name, boundary, exclusions, params}, ...] у фіксованому порядку."""
    big = big_irregular_boundary()
    cases = [
        {"name": "a_big_irregular", "boundary": big, "exclusions": []},
        {"name": "b_big_exclusions", "boundary": big,
         "exclusions": big_field_exclusions()},
        {"name": "c_small_simple", "boundary": small_simple_boundary(),
         "exclusions": []},
        {"name": "d_long_narrow", "boundary": long_narrow_boundary(),
         "exclusions": []},
    ]
    for c in cases:
        c["params"] = build_params(c["boundary"], c["exclusions"])
    return cases


# ------------------------------------------------------------ аналіз проходів
def extract_passes(wps_ll, angle_deg, spacing, boundary_ll):
    """Виділити ПРОХОДИ з маршруту: у повернутій системі (проходи горизонтальні)
    це ребра з |dy| ~ 0 та довжиною >= 2*spacing. Повертає список
    (y, direction) у польотному порядку; direction = +1 (зліва направо) / -1."""
    if not wps_ll or len(wps_ll) < 2:
        return []
    lat0, lon0 = centroid(boundary_ll)
    a = math.radians(angle_deg)
    ca, sa = math.cos(a), math.sin(a)
    pts = []
    for la, lo in wps_ll:
        x, y = latlon_to_local(la, lo, lat0, lon0)
        pts.append((x * ca + y * sa, -x * sa + y * ca))     # поворот на -angle
    passes = []
    for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
        dx, dy = x2 - x1, y2 - y1
        if abs(dy) <= 0.5 and abs(dx) >= 2.0 * spacing:
            passes.append(((y1 + y2) / 2.0, 1 if dx > 0 else -1))
    return passes


def pass_structure(wps_ll, angle_deg, spacing, boundary_ll):
    """Метрики структури проходів: кількість проходів і скільки СУСІДНІХ пар
    летять в ОДИН бік (порушення чергування напрямку). Пара на одному рядку
    (клітинна декомпозиція навколо виключення) не рахується порушенням."""
    passes = extract_passes(wps_ll, angle_deg, spacing, boundary_ll)
    same_dir = 0
    for (y1, d1), (y2, d2) in zip(passes, passes[1:]):
        if d1 == d2 and abs(y2 - y1) > 0.5:
            same_dir += 1
    return {"n_passes": len(passes), "same_dir_pairs": same_dir}
