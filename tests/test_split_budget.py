"""A flight the planner produces must never be one the planner calls too long.

`split_route_by_time` decides how many sorties a field needs; `estimate_mission_time`
tells the pilot how long each one takes. Until 2026-07-29 they used different models:
the split counted cruise seconds only and held back a flat 20 % of the budget for
everything else, while the reported duration added the take-off climb, the home->start
transit, the decel/accel lost at every turn, RTL and the landing descent.

That 20 % is a fraction of the BUDGET, but what it must cover does not scale with the
budget: the climb scales with altitude, the turn loss with how many passes the spacing
produces, the transit and RTL with how far home is. Swept over the four bench fields at
spacing 10/20/40 m, battery 8-30 min and 35 m AGL, the real overhead ran 22-57 % of the
budget and 25 configurations came back over — worst +3.47 min on a 12 min battery.

The invariant is one line: for every flight returned, the duration the pilot is shown
must fit the endurance the split was asked to respect.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import coverage as C           # noqa: E402
from tests.route_cases import make_cases    # noqa: E402

SPEED = 12.0
ALT = 35.0                                  # Ivan's real operating altitude, 30-40 m AGL

#: The sweep that exposed the defect. Kept whole rather than reduced to the single
#: worst cell, because the failure is a RATIO — overhead against budget — and it
#: appears at different spacings for different fields.
SPACINGS = (10.0, 20.0, 40.0)
BATTERIES = (8, 12, 15, 20, 30)


def _cases():
    return {c["name"]: c for c in make_cases()}


def _route(case, spacing):
    b = case["boundary"]
    return b[0], C.generate_coverage(b, spacing, 0.0,
                                     exclusions=case.get("exclusions") or [],
                                     anchor=b[0])


def _reported(section, home):
    return C.estimate_mission_time(section, home, speed=SPEED, rtl=True,
                                   wp_alt=ALT, takeoff_alt=ALT)["total_s"]


@pytest.mark.parametrize("name", sorted(_cases()))
@pytest.mark.parametrize("spacing", SPACINGS)
@pytest.mark.parametrize("battery_min", BATTERIES)
def test_every_split_flight_fits_the_battery(name, spacing, battery_min):
    """The invariant. Fails on the pre-2026-07-29 fractional-reserve split."""
    case = _cases()[name]
    home, wps = _route(case, spacing)
    if len(wps) < 4:
        pytest.skip("route too short to split meaningfully")

    budget_s = battery_min * 60
    flights = C.split_route_by_time(wps, SPEED, budget_s, home=home,
                                    wp_alt=ALT, takeoff_alt=ALT, rtl=True)

    for i, f in enumerate(flights, 1):
        got = _reported(f, home)
        # A single leg longer than the whole budget is flown rather than dropped —
        # that is a documented, deliberate escape hatch, not a budgeting failure.
        if len(f) == 2:
            continue
        assert got <= budget_s + 1e-6, (
            f"{name} spacing={spacing:.0f} battery={battery_min}min: flight {i} of "
            f"{len(flights)} is reported as {got/60:.2f} min against a "
            f"{battery_min} min endurance (+{(got-budget_s)/60:.2f})")


def test_coverage_is_not_lost_by_splitting():
    """Sections must resume where the previous one stopped — no dropped legs."""
    case = _cases()["a_big_irregular"]
    home, wps = _route(case, 20.0)
    flights = C.split_route_by_time(wps, SPEED, 12 * 60, home=home,
                                    wp_alt=ALT, takeoff_alt=ALT, rtl=True)
    assert len(flights) > 1, "expected this field to need several sorties"
    for prev, nxt in zip(flights, flights[1:]):
        assert prev[-1] == nxt[0], "a flight does not resume where the last one ended"
    rejoined = flights[0] + [p for f in flights[1:] for p in f[1:]]
    assert rejoined == [(float(a), float(b)) for a, b in wps], \
        "the concatenated sections are not the original route"


def test_legacy_mode_without_home_still_works():
    """Callers that pass no home keep the old cruise-only behaviour."""
    case = _cases()["a_big_irregular"]
    _, wps = _route(case, 20.0)
    flights = C.split_route_by_time(wps, SPEED, 12 * 60)
    assert flights and all(len(f) >= 2 for f in flights)


def test_the_fractional_reserve_really_was_not_enough():
    """The defect itself, A/B on one input, both paths available in this build.

    Written because the obvious regression proof is not available: reverting the
    source makes the other tests raise TypeError on the new `home=` argument,
    which shows the signature changed and says nothing about behaviour. This
    compares the two BUDGETING MODELS on identical waypoints instead, so it is a
    statement about the arithmetic rather than about the API.
    """
    case = _cases()["a_big_irregular"]
    home, wps = _route(case, 10.0)
    budget_s = 12 * 60

    legacy = C.split_route_by_time(wps, SPEED, budget_s)            # cruise-only + 20 %
    fixed = C.split_route_by_time(wps, SPEED, budget_s, home=home,
                                  wp_alt=ALT, takeoff_alt=ALT, rtl=True)

    legacy_worst = max(_reported(f, home) for f in legacy if len(f) > 2)
    fixed_worst = max(_reported(f, home) for f in fixed if len(f) > 2)

    assert legacy_worst > budget_s, (
        "expected the fractional reserve to overrun on this field; it did not, so "
        "this test no longer documents anything")
    assert fixed_worst <= budget_s + 1e-6, (
        f"the replacement overruns too: {fixed_worst/60:.2f} min against "
        f"{budget_s/60:.0f} min")
    # The measured overrun that motivated the change: ~+3.5 min on a 12 min battery.
    assert legacy_worst - budget_s > 60, (
        f"the overrun shrank to {(legacy_worst-budget_s)/60:.2f} min — re-derive the "
        "numbers in this module's docstring before trusting them")


def test_a_short_route_is_one_flight():
    case = _cases()["c_small_simple"] if "c_small_simple" in _cases() else None
    if case is None:
        pytest.skip("no small case in this fixture set")
    home, wps = _route(case, 40.0)
    flights = C.split_route_by_time(wps, SPEED, 60 * 60, home=home,
                                    wp_alt=ALT, takeoff_alt=ALT, rtl=True)
    assert len(flights) == 1


def test_the_two_engine_copies_are_identical():
    """backend/ and web-stable/engine/ are the same engine; a fix to one is a fix
    to neither unless it lands in both. This has bitten before."""
    root = Path(__file__).resolve().parent.parent
    for name in ("coverage.py", "api.py"):
        a = (root / "backend" / name).read_text(encoding="utf-8")
        b = (root / "web-stable" / "engine" / name).read_text(encoding="utf-8")
        assert a == b, f"backend/{name} and web-stable/engine/{name} have diverged"
