"""ЕКВІВАЛЕНТНІСТЬ маршруту — ворота для будь-якої оптимізації движка.

Порівнює свіжий Api.build_route (повний користувацький шлях: auto_angle +
optimize="overlap", margin 5, battery split) на 4 полях із tests/route_cases.py
проти зафіксованого еталона tests/bench_baseline.json:

  * довжина маршруту: не гірше ніж +1% від baseline (коротше — можна;
    інший кут допустимий ЛИШЕ якщо вкладається в цей 1%);
  * покриття не падає (coverage_pct >= baseline - 0.5 п.п.) — захист від
    «скорочення» маршруту викиданням проходів;
  * КОЖНА точка маршруту всередині поля-мінус-виключення (епсилон 0.75 м —
    толеранс _route_freespace 0.5 м + запас);
  * sprayed_ha у межах 0.5% від baseline;
  * структура проходів «змійкою»: сусідні проходи чергують напрямок
    (порушень не більше, ніж у baseline, +1 на дребезг), кількість проходів
    зіставна;
  * розбиття по батареї живе (flights у межах ±1 від baseline).

Запуск:  ./.venv-photo/bin/python -m pytest tests/test_route_equiv.py -v
(повний прогін ~1.5 хв — кожен кейс будується один раз і кешується).

Baseline оновлюється СВІДОМО: tests/bench_route.py --update — лише після
підтвердження, що новий маршрут еквівалентний або кращий.
"""
import json
import os
import sys

import pytest
from shapely.geometry import Point

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests.route_cases import make_cases, pass_structure, SPACING  # noqa: E402
from backend.api import Api  # noqa: E402
from backend.coverage import _free_polygon  # noqa: E402
from backend.geo import latlon_to_local  # noqa: E402

BASELINE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                             "bench_baseline.json")

CASES = {c["name"]: c for c in make_cases()}
NAMES = list(CASES)

_results = {}          # кеш: один build_route на кейс за сесію


def _result(name):
    if name not in _results:
        _results[name] = Api().build_route(CASES[name]["params"])
    return _results[name]


@pytest.fixture(scope="session")
def baseline():
    if not os.path.exists(BASELINE_PATH):
        pytest.skip("нема tests/bench_baseline.json — спершу запусти "
                    "tests/bench_route.py")
    with open(BASELINE_PATH, encoding="utf-8") as f:
        data = json.load(f)
    return data["cases"]


def _wps(res):
    return [(p["lat"], p["lng"]) for p in res["waypoints"]]


@pytest.mark.parametrize("name", NAMES)
def test_build_ok(name, baseline):
    assert name in baseline, "кейс %s відсутній у baseline — онови еталон" % name
    res = _result(name)
    assert res.get("ok"), "build_route впав: %s" % res.get("error")
    assert res["count"] >= 2
    assert 0.0 <= res["angle_used"] < 180.0


@pytest.mark.parametrize("name", NAMES)
def test_route_length_within_1pct(name, baseline):
    """Довжина не гірше +1% від еталона (коротше — дозволено)."""
    res, base = _result(name), baseline[name]
    limit = base["length_m"] * 1.01
    assert res["length_m"] <= limit, (
        "%s: довжина %.1f м > %.1f м (baseline %.1f м +1%%)"
        % (name, res["length_m"], limit, base["length_m"]))


@pytest.mark.parametrize("name", NAMES)
def test_coverage_not_worse(name, baseline):
    """Коротший маршрут не має досягатися викиданням покриття."""
    res, base = _result(name), baseline[name]
    assert res["coverage_pct"] >= base["coverage_pct"] - 0.5, (
        "%s: coverage %.1f%% < baseline %.1f%% - 0.5"
        % (name, res["coverage_pct"], base["coverage_pct"]))


@pytest.mark.parametrize("name", NAMES)
def test_waypoints_inside_field_minus_exclusions(name, baseline):
    """Всі точки в полі-мінус-виключення (епсилон 0.75 м)."""
    res = _result(name)
    case = CASES[name]
    free, lat0, lon0 = _free_polygon(case["boundary"], case["exclusions"])
    assert free is not None
    ok_zone = free.buffer(0.75)
    bad = []
    for i, (la, lo) in enumerate(_wps(res)):
        x, y = latlon_to_local(la, lo, lat0, lon0)
        if not ok_zone.covers(Point(x, y)):
            d = free.exterior.distance(Point(x, y)) if free.geom_type == "Polygon" else -1
            bad.append((i, la, lo, round(d, 2)))
    assert not bad, ("%s: %d точок поза полем-мінус-виключення "
                     "(перші: %s)" % (name, len(bad), bad[:5]))


@pytest.mark.parametrize("name", NAMES)
def test_sprayed_area_within_half_pct(name, baseline):
    res, base = _result(name), baseline[name]
    tol = base["sprayed_ha"] * 0.005
    assert abs(res["sprayed_ha"] - base["sprayed_ha"]) <= tol, (
        "%s: sprayed %.3f га проти baseline %.3f га (толеранс 0.5%%)"
        % (name, res["sprayed_ha"], base["sprayed_ha"]))


@pytest.mark.parametrize("name", NAMES)
def test_boustrophedon_pass_structure(name, baseline):
    """Проходи чергують напрямок (змійка); порушень не більше за еталон (+1),
    кількість проходів зіставна з еталоном."""
    res, base = _result(name), baseline[name]
    ps = pass_structure(_wps(res), res["angle_used"], SPACING,
                        CASES[name]["boundary"])
    assert ps["n_passes"] >= 2, "%s: не знайдено проходів" % name
    lo = int(base["n_passes"] * 0.9)
    hi = int(base["n_passes"] * 1.15) + 1
    assert lo <= ps["n_passes"] <= hi, (
        "%s: %d проходів проти baseline %d (допустимо %d..%d)"
        % (name, ps["n_passes"], base["n_passes"], lo, hi))
    allowed = base["same_dir_pairs"] + 1
    assert ps["same_dir_pairs"] <= allowed, (
        "%s: %d пар сусідніх проходів в один бік (baseline %d, допустимо %d)"
        % (name, ps["same_dir_pairs"], base["same_dir_pairs"], allowed))


@pytest.mark.parametrize("name", NAMES)
def test_battery_split_alive(name, baseline):
    """Розбиття по батареї не зникло і не рознеслося (±1 виліт від еталона)."""
    res, base = _result(name), baseline[name]
    assert res["flights"] >= 1
    assert abs(res["flights"] - base["flights"]) <= 1, (
        "%s: %d вильотів проти baseline %d"
        % (name, res["flights"], base["flights"]))
