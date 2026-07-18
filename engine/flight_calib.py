"""Offline flight-log calibration — turn logged real flights into planner factors.

No ML, no torch, no network: the operator's app records each real mission
(planned-vs-actual duration + battery) locally, and this module derives robust
median factors that feed back into the time/battery estimate
(`coverage.estimate_mission_time`). It runs in the in-browser Pyodide engine
exactly like the rest of backend/, so calibration works fully offline.

Each record is a compact summary (samples are kept on the device for export, not
needed here):
    {
      "planned": {"duration_s": float, ...},
      "actual":  {"duration_s": float, "battery_used_pct": float, ...},
      "partial": bool,        # aborted mid-mission -> excluded from calibration
    }
"""


def _num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f != f:                       # NaN guard
        return None
    return f


def _median(xs):
    s = sorted(xs)
    n = len(s)
    if n == 0:
        return None
    mid = n // 2
    if n % 2:
        return s[mid]
    return (s[mid - 1] + s[mid]) / 2.0


def calibrate(records):
    """Derive {time_mult, pct_per_min, n} from logged flights (robust medians).

    time_mult  = median(actual_duration / planned_duration) — scales the a-priori
                 flight-time estimate to THIS operator's drone (wind, real climb
                 rates, loiter, etc.).
    pct_per_min = median(battery_used_pct / actual_minutes) — battery burn rate,
                 for endurance/section sizing.
    Ratios are clamped to a sane band so one bad log can't poison the planner.
    Partial (aborted) flights are ignored.
    """
    mults, ppm = [], []
    for r in (records or []):
        if not isinstance(r, dict) or r.get("partial"):
            continue
        planned = r.get("planned") or {}
        actual = r.get("actual") or {}
        pd = _num(planned.get("duration_s"))
        ad = _num(actual.get("duration_s"))
        if pd and ad and pd > 0 and ad > 0:
            ratio = ad / pd
            if 0.2 <= ratio <= 5.0:
                mults.append(ratio)
            if ad > 0:
                bu = _num(actual.get("battery_used_pct"))
                if bu and bu > 0:
                    ppm.append(bu / (ad / 60.0))

    out = {"n": len(mults)}
    tm = _median(mults)
    if tm is not None and 0.2 <= tm <= 5.0:
        out["time_mult"] = tm
    pm = _median(ppm)
    if pm is not None and pm > 0:
        out["pct_per_min"] = pm
    return out
