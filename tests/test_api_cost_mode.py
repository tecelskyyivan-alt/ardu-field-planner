"""Перевірка режиму optimize='cost' ЧЕРЕЗ API, не в обхід.

⚠ Тест напряму на route_optimizer вже є. Тут інше: чи доходить
режим крізь build_route — чи не загубився параметр, чи не падає
на exclusions, чи не ламає наявні режими.
"""
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.coverage import mission_overlap

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


# Дістаємо клас, що містить _plan (ім'я може відрізнятись)
import backend.api as api

Cls = None
for nm in dir(api):
    o = getattr(api, nm)
    if isinstance(o, type) and hasattr(o, "build_route"):
        Cls = o
        break

print(f"клас API: {Cls.__name__ if Cls else 'не знайдено'}")
if Cls is None:
    print("не знайдено класу з build_route")
    sys.exit(1)

# знаходимо внутрішній планувальник
planner = "_route_for"
print(f"метод планування: {planner}")

inst = Cls.__new__(Cls)          # без __init__: нам треба лише метод
B = rect(49.0, 32.0, 250, 250)
HOME = (49.0, 32.0)
SP = 20.0

fn = getattr(inst, planner)

print("\n── режим cost доходить крізь API ──────────────")
wps_c, ang_c, cover_c = fn(B, SP, 0.0, SP / 2.0, True, None, HOME, False,
                           optimize="cost", speed=8.0)
check("cost: маршрут побудовано", wps_c is not None and len(wps_c) >= 4,
      f"{len(wps_c) if wps_c else 0} точок")
check("cost: кут повернуто", ang_c is not None and 0 <= ang_c < 180,
      f"{ang_c}")

print("\n── наявні режими не зламані ───────────────────")
wps_o, ang_o, _ = fn(B, SP, 0.0, SP / 2.0, True, None, HOME, False,
                     optimize="overlap", speed=8.0)
check("overlap: працює як раніше", wps_o is not None and len(wps_o) >= 4)
wps_l, ang_l, _ = fn(B, SP, 0.0, SP / 2.0, True, None, HOME, False,
                     optimize="length", speed=8.0)
check("length: працює як раніше", wps_l is not None and len(wps_l) >= 4)

print("\n── cost справді кращий за overlap ─────────────")
o_c = mission_overlap(HOME, [(float(p[0]), float(p[1])) for p in wps_c],
                      SP, B, True)["overlap_pct"]
o_o = mission_overlap(HOME, [(float(p[0]), float(p[1])) for p in wps_o],
                      SP, B, True)["overlap_pct"]
check(f"cost {o_c:.2f}% <= overlap {o_o:.2f}%", o_c <= o_o,
      f"{o_c} проти {o_o}")

print("\n── ручний кут не чіпає режим ──────────────────")
wps_m, ang_m, _ = fn(B, SP, 45.0, SP / 2.0, False, None, HOME, False,
                     optimize="cost", speed=8.0)
check("auto_angle=False ігнорує optimize", ang_m == 45.0, f"{ang_m}")

print(f"\nПРОЙДЕНО {OK} · ПРОВАЛЕНО {FAIL}")
sys.exit(1 if FAIL else 0)
