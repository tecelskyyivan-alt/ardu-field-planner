"""Бенчмарк ПОВНОГО користувацького шляху побудови маршруту (Api.build_route).

Ганяє 4 реалістичні поля (tests/route_cases.py) через той самий виклик, що
робить APK на «справжньому» build: auto_angle=True + optimize="overlap"
(90 повних генерацій покриття в overlap_optimal_angle, step=2), margin 5 м,
spacing 20 м, battery split. Міряє wall-time і фіксує метрики маршруту.

Запуск (з кореня репо):
    ./.venv-photo/bin/python tests/bench_route.py               # таблиця; baseline
                                                                # пишеться лише якщо його ще нема
    ./.venv-photo/bin/python tests/bench_route.py --update      # перезаписати baseline
    ./.venv-photo/bin/python tests/bench_route.py --profile a_big_irregular
                                                                # cProfile top-30 cumulative
    BENCH_REPEATS=3 ./.venv-photo/bin/python tests/bench_route.py   # мін. час із N прогонів

Baseline (tests/bench_baseline.json) — еталон для tests/test_route_equiv.py:
КОЖНА оптимізація движка мусить проходити еквівалентність проти нього.
НЕ перезаписуй baseline разом із зміною алгоритму — спершу тести, потім --update
свідомо (після підтвердження, що маршрут еквівалентний/кращий).
"""
import argparse
import cProfile
import io
import json
import os
import pstats
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests.route_cases import make_cases, pass_structure, SPACING  # noqa: E402
from backend.api import Api  # noqa: E402

BASELINE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                             "bench_baseline.json")


def run_case(case):
    """Один повний build_route; повертає (res, wall_time_s)."""
    api = Api()
    t0 = time.perf_counter()
    res = api.build_route(case["params"])
    dt = time.perf_counter() - t0
    return res, dt


def measure_case(case, repeats=1):
    """repeats прогонів; час = мінімум (метрики детерміновані — беремо останні)."""
    times = []
    res = None
    for _ in range(max(1, repeats)):
        res, dt = run_case(case)
        times.append(dt)
    if not res or not res.get("ok"):
        raise RuntimeError("build_route failed on %s: %s"
                           % (case["name"], (res or {}).get("error")))
    wps = [(p["lat"], p["lng"]) for p in res["waypoints"]]
    ps = pass_structure(wps, res["angle_used"], SPACING, case["boundary"])
    return {
        "name": case["name"],
        "time_s": round(min(times), 3),
        "times_s": [round(t, 3) for t in times],
        "length_m": res["length_m"],
        "count": res["count"],
        "angle_used": res["angle_used"],
        "area_ha": res["area_ha"],
        "sprayed_ha": res["sprayed_ha"],
        "coverage_pct": res["coverage_pct"],
        "overlap_pct": res["overlap_pct"],
        "duration_s": res["duration_s"],
        "flights": res["flights"],
        "n_passes": ps["n_passes"],
        "same_dir_pairs": ps["same_dir_pairs"],
    }


def print_table(rows):
    cols = ["name", "time_s", "length_m", "count", "angle_used", "sprayed_ha",
            "coverage_pct", "overlap_pct", "duration_s", "flights",
            "n_passes", "same_dir_pairs"]
    widths = {c: max(len(c), *(len(str(r[c])) for r in rows)) for c in cols}
    line = "  ".join(c.ljust(widths[c]) for c in cols)
    print(line)
    print("-" * len(line))
    for r in rows:
        print("  ".join(str(r[c]).ljust(widths[c]) for c in cols))


def profile_case(name):
    cases = {c["name"]: c for c in make_cases()}
    if name not in cases:
        raise SystemExit("невідомий кейс %r; є: %s" % (name, ", ".join(cases)))
    case = cases[name]
    api = Api()
    prof = cProfile.Profile()
    prof.enable()
    res = api.build_route(case["params"])
    prof.disable()
    if not res.get("ok"):
        raise SystemExit("build_route failed: %s" % res.get("error"))
    s = io.StringIO()
    st = pstats.Stats(prof, stream=s).sort_stats("cumulative")
    st.print_stats(30)
    print(s.getvalue())


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--update", action="store_true",
                    help="перезаписати tests/bench_baseline.json")
    ap.add_argument("--profile", metavar="CASE",
                    help="cProfile одного кейсу (top-30 cumulative), без бенчу")
    args = ap.parse_args()

    if args.profile:
        profile_case(args.profile)
        return

    repeats = int(os.environ.get("BENCH_REPEATS", "1"))
    rows = []
    for case in make_cases():
        print("running %s ..." % case["name"], flush=True)
        rows.append(measure_case(case, repeats=repeats))
    print()
    print_table(rows)

    baseline = {
        "spacing": SPACING,
        "repeats": repeats,
        "python": sys.version.split()[0],
        "recorded_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "cases": {r["name"]: r for r in rows},
    }
    if args.update or not os.path.exists(BASELINE_PATH):
        with open(BASELINE_PATH, "w", encoding="utf-8") as f:
            json.dump(baseline, f, ensure_ascii=False, indent=2)
        print("\nbaseline записано: %s" % BASELINE_PATH)
    else:
        with open(BASELINE_PATH, encoding="utf-8") as f:
            old = json.load(f)
        print("\nbaseline НЕ перезаписано (є %s; використай --update)."
              % BASELINE_PATH)
        for r in rows:
            o = old.get("cases", {}).get(r["name"])
            if not o:
                continue
            spd = o["time_s"] / r["time_s"] if r["time_s"] > 0 else float("inf")
            dlen = 100.0 * (r["length_m"] - o["length_m"]) / o["length_m"]
            print("  %-18s time %6.2fs -> %6.2fs (x%.2f)   length %+.2f%%"
                  % (r["name"], o["time_s"], r["time_s"], spd, dlen))


if __name__ == "__main__":
    main()
