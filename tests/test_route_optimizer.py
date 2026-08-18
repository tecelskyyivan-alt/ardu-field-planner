"""Тести route_optimizer: виграш реальний і не куплений роботою."""
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from shapely.geometry import LineString, Polygon
from backend.coverage import (estimate_mission_time, generate_coverage,
                              inset_boundary, mission_overlap,
                              optimal_angle)
from backend.route_optimizer import best_angle_route

OK = FAIL = 0


def check(name, cond, detail=""):
    global OK, FAIL
    if cond:
        OK += 1
        print(f"  OK    {name}")
    else:
        FAIL += 1
        print(f"  ПРОВАЛ {name}")
        if detail:
            print(f"         {detail}")


def rect(lat0, lng0, w, h):
    dlat = h / 111320.0
    dlng = w / (111320.0 * math.cos(math.radians(lat0)))
    return [(lat0, lng0), (lat0, lng0 + dlng),
            (lat0 + dlat, lng0 + dlng), (lat0 + dlat, lng0)]


def covered_pct(wps, b, spacing):
    kx = 111320.0 * math.cos(math.radians(b[0][0]))
    f = Polygon([((lo - b[0][1]) * kx, (la - b[0][0]) * 111320.0)
                 for la, lo in b])
    sp = LineString([((lo - b[0][1]) * kx, (la - b[0][0]) * 111320.0)
                     for la, lo in wps]).buffer(spacing / 2.0,
                                                cap_style="flat")
    return f.intersection(sp).area / f.area * 100.0


def baseline(b, spacing, home):
    cover = inset_boundary(list(b), spacing / 2.0)
    ang, wps = optimal_angle(cover, spacing, return_route=True, anchor=home)
    return wps or generate_coverage(cover, spacing, ang, anchor=home)


SP = 20.0
CASES = [
    ("130x130", rect(49.0, 32.0, 130, 130), (49.0, 32.0)),
    ("300x200", rect(49.0, 32.0, 300, 200), (49.0, 32.0)),
    ("250x250", rect(49.0, 32.0, 250, 250), (49.0, 32.0)),
]

print("── маршрут будується й покриває поле ──────────")
for name, b, home in CASES:
    route, ang = best_angle_route(b, SP, home)
    check(f"{name}: маршрут не порожній", len(route) >= 4,
          f"{len(route)} точок")
    check(f"{name}: кут у діапазоні 0-180", ang is not None and 0 <= ang < 180,
          f"{ang}")
    pts = [(float(p[0]), float(p[1])) for p in route]
    cov = covered_pct(pts, b, SP)
    check(f"{name}: покриття >= 80%", cov >= 80.0, f"{cov:.1f}%")

print("\n── ГОЛОВНЕ: виграш не куплений меншою роботою ──")
# ⚠ Оптимізатор зменшує перекриття. Найпростіший спосіб це зробити —
# обприскати менше. Тому покриття мусить бути НЕ ГІРШИМ за базове.
for name, b, home in CASES:
    route, _ = best_angle_route(b, SP, home)
    base = baseline(b, SP, home)
    p_new = [(float(p[0]), float(p[1])) for p in route]
    p_old = [(float(p[0]), float(p[1])) for p in base]
    c_new, c_old = covered_pct(p_new, b, SP), covered_pct(p_old, b, SP)
    check(f"{name}: покриття не гірше за базове",
          c_new >= c_old - 0.5, f"нове {c_new:.1f}% проти {c_old:.1f}%")

print("\n── перекриття не гірше за базове ──────────────")
for name, b, home in CASES:
    route, _ = best_angle_route(b, SP, home)
    base = baseline(b, SP, home)
    o_new = mission_overlap(home, [(float(p[0]), float(p[1]))
                                   for p in route], SP, b, True)["overlap_pct"]
    o_old = mission_overlap(home, [(float(p[0]), float(p[1]))
                                   for p in base], SP, b, True)["overlap_pct"]
    check(f"{name}: перекриття {o_new:.2f} <= базового {o_old:.2f}",
          o_new <= o_old + 0.01, f"{o_new} проти {o_old}")

print("\n── межа: крок перебору справді щось міняє ─────")
# Якщо результат однаковий за будь-якого кроку, перебір нічого не дає.
b, home = rect(49.0, 32.0, 400, 120), (49.0, 32.0)
r_fine, a_fine = best_angle_route(b, SP, home, step_deg=5.0)
r_coarse, a_coarse = best_angle_route(b, SP, home, step_deg=90.0)
o_fine = mission_overlap(home, [(float(p[0]), float(p[1]))
                                for p in r_fine], SP, b, True)["overlap_pct"]
o_coarse = mission_overlap(home, [(float(p[0]), float(p[1]))
                                  for p in r_coarse], SP, b, True)["overlap_pct"]
check("дрібний крок не гірший за грубий", o_fine <= o_coarse + 0.01,
      f"5°: {o_fine:.2f} проти 90°: {o_coarse:.2f}")

print(f"\nПРОЙДЕНО {OK} · ПРОВАЛЕНО {FAIL}")
sys.exit(1 if FAIL else 0)
