"""Randomised invariant sweep over the route engine that flies a real sprayer.

Until now the engine's only broad gate was `tests/route_cases.py` — four hand-picked
fields. Everything else is a targeted unit test. That leaves the whole parameter space
untried: a field shape nobody drew, a spacing nobody typed, an exclusion touching the
boundary, a nested cutout, a strip narrower than one swath.

This does not check that a route is GOOD. It checks the handful of things that must
hold for any route the engine is willing to hand to an aircraft:

  * it either builds or refuses in words — never raises, never hangs
  * every coordinate it emits is finite
  * `count` matches the waypoints actually returned
  * nothing lands wildly outside the field (turn overshoot is legitimate and expected,
    so the bound is generous — this catches sign flips and coordinate-frame mistakes,
    not tight geometry)
  * no waypoint sits INSIDE an exclusion zone, which is where the drone would fly
  * the reported numbers are finite, non-negative and in range

Seeded, so a failure reduces to one integer. Offline. Failures print the seed and the
parameters, and the intended workflow is to paste that seed into `test_seed` below.
"""
from __future__ import annotations

import math
import random
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.api import Api  # noqa: E402

shapely = pytest.importorskip("shapely")
from shapely.geometry import Point, Polygon  # noqa: E402

#: A patch of Ukrainian farmland; the engine works in lat/lng so the tests do too.
LAT0, LNG0 = 49.5275, 24.0040

CASES = int(__import__("os").environ.get("ROUTE_SWEEP_CASES", "160"))


def m_to_deg(dn_m, de_m, lat=LAT0):
    return dn_m / 111_320.0, de_m / (111_320.0 * math.cos(math.radians(lat)))


def blob(rng, n_vtx, r_m, aspect=1.0, wobble=0.35):
    """A closed ring: convex-ish at low wobble, genuinely concave at high."""
    ring = []
    for i in range(n_vtx):
        a = 2 * math.pi * i / n_vtx
        r = r_m * (1.0 + wobble * math.sin(3 * a + rng.uniform(0, 6.28))
                   + rng.uniform(-0.08, 0.08))
        dn, de = m_to_deg(r * math.sin(a), r * math.cos(a) * aspect)
        ring.append({"lat": LAT0 + dn, "lng": LNG0 + de})
    return ring


def strip(rng, length_m, width_m):
    """A long narrow field — the shape that breaks swath planners."""
    out = []
    for dn_m, de_m in ((0, 0), (0, length_m), (width_m, length_m), (width_m, 0)):
        dn, de = m_to_deg(dn_m, de_m)
        out.append({"lat": LAT0 + dn, "lng": LNG0 + de})
    return out


def make_field(rng):
    kind = rng.choice(["blob", "blob", "concave", "strip", "small"])
    if kind == "blob":
        return blob(rng, rng.randint(6, 40), rng.uniform(90, 400),
                    aspect=rng.uniform(0.5, 2.0), wobble=0.15), kind
    if kind == "concave":
        return blob(rng, rng.randint(12, 60), rng.uniform(120, 350),
                    aspect=rng.uniform(0.6, 1.6), wobble=rng.uniform(0.3, 0.55)), kind
    if kind == "strip":
        return strip(rng, rng.uniform(200, 900), rng.uniform(25, 90)), kind
    return blob(rng, rng.randint(5, 10), rng.uniform(35, 80), wobble=0.1), kind


def make_exclusions(rng, field_ring):
    """Cutouts of the awkward kinds: inside, nested, and touching the boundary."""
    poly = Polygon([(p["lng"], p["lat"]) for p in field_ring])
    if not poly.is_valid or poly.is_empty:
        return []
    out = []
    for _ in range(rng.choice([0, 0, 1, 1, 2, 3])):
        c = poly.representative_point()
        style = rng.choice(["inside", "edge", "big"])
        r_m = {"inside": rng.uniform(10, 45), "edge": rng.uniform(15, 60),
               "big": rng.uniform(60, 130)}[style]
        cx, cy = c.x, c.y
        if style == "edge":                       # nudge it out over the boundary
            b = poly.bounds
            cx = rng.uniform(b[0], b[2])
            cy = rng.uniform(b[1], b[3])
        ring = []
        for i in range(rng.randint(4, 10)):
            a = 2 * math.pi * i / 8
            dn, de = m_to_deg(r_m * math.sin(a), r_m * math.cos(a))
            ring.append({"lat": cy + dn, "lng": cx + de})
        out.append(ring)
    return out


def make_params(rng, ring, exclusions):
    auto = rng.random() < 0.5
    return {
        "boundary": ring,
        "spacing": rng.choice([5.0, 10.0, 20.0, 50.0, 80.0]),
        "boom": rng.choice([0, 0, 4.0, 12.0]),
        "angle": rng.uniform(0, 180),
        "auto_angle": auto,
        "optimize": rng.choice(["length", "overlap"]),
        "margin": rng.choice([0.0, 0.0, 5.0, 30.0, 50.0]),
        "alt": rng.choice([20.0, 35.0, 50.0]),
        "speed": rng.choice([8.0, 12.0, 22.0]),
        "rtl": rng.random() < 0.8,
        "plane_turn": rng.random() < 0.3,
        "exclusions": exclusions,
        "viz": False,
    }


# --------------------------------------------------------------------------- #
# the invariants
# --------------------------------------------------------------------------- #

def check(res, params, seed):
    ctx = (f"seed={seed} spacing={params['spacing']} margin={params['margin']} "
           f"auto_angle={params['auto_angle']} plane_turn={params['plane_turn']} "
           f"excl={len(params['exclusions'])} verts={len(params['boundary'])}")

    assert isinstance(res, dict) and "ok" in res, f"{ctx}: malformed result {res!r}"
    if not res["ok"]:
        # A refusal is a legitimate outcome — but it must say why, in words a user
        # can act on, not an empty string or a stack trace.
        err = res.get("error")
        assert isinstance(err, str) and err.strip(), f"{ctx}: refused with no reason"
        assert "Traceback" not in err, f"{ctx}: a traceback reached the user: {err[:120]}"
        return "refused"

    wps = res["waypoints"]
    assert wps, f"{ctx}: ok=True with no waypoints"
    assert res["count"] == len(wps), f"{ctx}: count={res['count']} but {len(wps)} points"

    for i, p in enumerate(wps):
        assert math.isfinite(p["lat"]) and math.isfinite(p["lng"]), \
            f"{ctx}: waypoint {i} is not finite: {p}"
        assert -90 <= p["lat"] <= 90 and -180 <= p["lng"] <= 180, \
            f"{ctx}: waypoint {i} is off the planet: {p}"

    # Generous containment: turn overshoot legitimately leaves the field, so this is
    # sized to catch a sign flip or a frame mistake, not tight geometry.
    ring = Polygon([(p["lng"], p["lat"]) for p in params["boundary"]])
    slack_m = 6 * params["spacing"] + params["margin"] + 200
    dn, de = m_to_deg(slack_m, slack_m)
    envelope = ring.buffer(max(dn, de))
    for i, p in enumerate(wps):
        assert envelope.contains(Point(p["lng"], p["lat"])), \
            f"{ctx}: waypoint {i} is {slack_m:.0f} m+ outside the field: {p}"

    # No waypoint may sit inside a cutout — that is where the aircraft would fly.
    for j, ex in enumerate(params["exclusions"]):
        ep = Polygon([(q["lng"], q["lat"]) for q in ex])
        if not ep.is_valid or ep.is_empty:
            continue
        inner = ep.buffer(-max(*m_to_deg(1.0, 1.0)))     # 1 m of tolerance
        if inner.is_empty:
            continue
        for i, p in enumerate(wps):
            assert not inner.contains(Point(p["lng"], p["lat"])), \
                f"{ctx}: waypoint {i} lies inside exclusion {j}: {p}"

    for key in ("length_m", "area_ha", "sprayed_ha", "duration_s"):
        v = res.get(key)
        assert v is None or (math.isfinite(v) and v >= 0), f"{ctx}: {key}={v}"
    cov = res.get("coverage_pct")
    assert cov is None or (math.isfinite(cov) and -0.01 <= cov <= 100.01), \
        f"{ctx}: coverage_pct={cov}"
    return "built"


def run_seed(seed):
    rng = random.Random(seed)
    ring, _kind = make_field(rng)
    excl = make_exclusions(rng, ring)
    params = make_params(rng, ring, excl)
    res = Api().build_route(params)
    return check(res, params, seed), params


@pytest.mark.parametrize("seed", range(CASES))
def test_sweep(seed):
    run_seed(seed)


def test_the_sweep_is_not_all_refusals():
    """A sweep that refuses everything asserts nothing. Guard against that."""
    built = sum(run_seed(s)[0] == "built" for s in range(60))
    assert built >= 20, (
        f"only {built}/60 cases produced a route — the generator has drifted into "
        "shapes the engine cannot plan, so the invariants above are barely exercised")


@pytest.mark.parametrize("seed", [])
def test_seed(seed):
    """Paste a failing seed from the sweep here to reproduce it on its own."""
    run_seed(seed)


# --------------------------------------------------------------------------- #
# does the checker actually check anything?
# --------------------------------------------------------------------------- #

def _a_case_that_builds_with_an_exclusion():
    for seed in range(400):
        rng = random.Random(seed)
        ring, _kind = make_field(rng)
        excl = make_exclusions(rng, ring)
        params = make_params(rng, ring, excl)
        if not excl:
            continue
        res = Api().build_route(params)
        if res.get("ok"):
            return seed, params, res
    pytest.skip("no seed under 400 produced a route with an exclusion")


MUTATIONS = [
    ("nan latitude", lambda r, p: r["waypoints"].__setitem__(
        3, {"lat": float("nan"), "lng": r["waypoints"][3]["lng"]})),
    ("infinite latitude", lambda r, p: r["waypoints"].__setitem__(
        3, {"lat": float("inf"), "lng": r["waypoints"][3]["lng"]})),
    ("count disagrees with the list", lambda r, p: r.__setitem__("count", r["count"] + 1)),
    ("waypoint 400 km away", lambda r, p: r["waypoints"].__setitem__(
        3, {"lat": LAT0, "lng": LNG0 + 6.0})),
    ("coverage over 100 %", lambda r, p: r.__setitem__("coverage_pct", 140.0)),
    ("negative length", lambda r, p: r.__setitem__("length_m", -5.0)),
    ("ok with no waypoints", lambda r, p: r.__setitem__("waypoints", [])),
    ("refusal with no reason", lambda r, p: (r.__setitem__("ok", False),
                                             r.__setitem__("error", ""))),
    ("waypoint inside an exclusion", lambda r, p: r["waypoints"].__setitem__(
        3, {"lat": sum(q["lat"] for q in p["exclusions"][0]) / len(p["exclusions"][0]),
            "lng": sum(q["lng"] for q in p["exclusions"][0]) / len(p["exclusions"][0])})),
]


@pytest.mark.parametrize("label,mutate", MUTATIONS, ids=[m[0] for m in MUTATIONS])
def test_the_checker_catches_an_injected_fault(label, mutate):
    """A sweep that passes on everything may simply be measuring nothing.

    1200 seeds produced zero violations, which is only evidence if these checks can
    fail at all. Each mutation below breaks one invariant in an otherwise real result
    and must be caught — the last one especially: a waypoint moved into a cutout is
    the defect with a physical consequence, because that is where the aircraft flies.
    """
    import copy
    _seed, params, res = _a_case_that_builds_with_an_exclusion()
    broken = copy.deepcopy(res)
    mutate(broken, params)
    with pytest.raises(AssertionError):
        check(broken, params, "mutation")
