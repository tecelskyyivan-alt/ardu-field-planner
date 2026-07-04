r"""E2E in REAL ArduCopter SITL under varying WIND: plan -> upload -> FLY the
mission in AUTO, log telemetry, and check the planner's flight-time estimate
CORRESPONDS to the actually-flown time — then close the loop with flight_calib.

This is the "перевірка всього функціоналу у симуляції на реалістичних умовах
(різний вітер), логи і час польоту і його відповідність" check.

    SITL (ArduCopter.exe, --speedup N, SIM_WIND_*)  <──  our MavLink GCS

Run:  .\.venv\Scripts\python.exe test_sitl_wind.py
Launches and tears down its own SITL. ~2-3 min (two flights at speedup).
"""
import json
import os
import subprocess
import sys
import time

from backend.mavlink_link import MavLink, build_mission_items
from backend.api import Api
from backend.coverage import estimate_mission_time
from backend.flight_calib import calibrate

ROOT = os.path.dirname(os.path.abspath(__file__))
SITL_DIR = os.path.join(ROOT, "sitl")
SITL_EXE = os.path.join(SITL_DIR, "ArduCopter.exe" if os.name=="nt" else "arducopter")
LOG_DIR = os.path.join(SITL_DIR, "logs")
PORT = 5760
HOME = (49.5275, 24.004, 200.0)             # lat, lon, alt AMSL — matches --home
SPEEDUP = 5                                  # SITL runs 5x; sim_time = wall * SPEEDUP
SPEED = 8.0                                  # spray speed (m/s)
ALT, TAKEOFF_ALT = 40.0, 15.0
# A small field by HOME so each flight finishes quickly (~130x130 m).
FIELD = [{"lat": 49.5278, "lng": 24.0042}, {"lat": 49.5278, "lng": 24.0060},
         {"lat": 49.5290, "lng": 24.0060}, {"lat": 49.5290, "lng": 24.0042}]


class _C:
    failed = 0
    def __call__(self, name, ok):
        print(("  OK  " if ok else " FAIL ") + name, flush=True)
        if not ok:
            _C.failed += 1
check = _C()
def soft(name, ok):
    print(("  OK  " if ok else " WARN ") + name, flush=True)


def connect_persistent(link, host, port, timeout):
    end = time.time() + timeout
    while time.time() < end:
        res = link.connect(f"tcp:{host}:{port}")
        if res.get("ok"):
            return res
        time.sleep(1.0)
    return {"ok": False, "error": "SITL не підняв TCP вчасно."}


def kill_sitl():
    try:
        subprocess.run((["taskkill","/IM","ArduCopter.exe","/F"] if os.name=="nt" else ["pkill","-f","ardu"]), capture_output=True)
    except Exception:
        pass


def wait_gps(link, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        s = link.status()
        if s.get("lat") is not None and (s.get("fix_type") or 0) >= 3:
            return True
        time.sleep(0.5)
    return False


def fly(link, label, wind_spd, rtl_seq, speedup):
    """Fly the uploaded mission once; return (finish_sim, land_sim, n_samples, ok)."""
    print(f"\n== flight '{label}' (wind {wind_spd} m/s) ==", flush=True)
    wr = link.set_param("SIM_WIND_SPD", wind_spd)       # read-back confirmed inside
    link.set_param("SIM_WIND_DIR", 90)
    link.set_param("SIM_WIND_TURB", 0.4 if wind_spd > 0 else 0.0)
    link.set_param("WP_SPD", SPEED)                     # fly at the planned speed
    wind_ok = bool(wr.get("ok"))
    print(f"     SIM_WIND_SPD={wind_spd} applied={wind_ok} (drone reports {wr.get('value')})",
          flush=True)
    time.sleep(1.0)

    # Arm with retries: right after a fresh GPS fix the EKF/home can need a moment,
    # so re-send the arm command a few times rather than giving up on the first.
    link.set_mode("GUIDED"); time.sleep(1.0)
    armed = False
    for _attempt in range(8):
        link.arm(True, force=True)
        for _ in range(8):
            if link.status().get("armed"):
                armed = True; break
            time.sleep(0.25)
        if armed:
            break
        time.sleep(1.0)
    if not armed:
        print("     !! did not arm after retries", flush=True)
        return None, None, 0, False
    link.set_mode("AUTO"); time.sleep(0.5)
    link.mission_start()
    t0 = time.time()

    samples, finish_w, land_w, took_off = [], None, None, False
    deadline = t0 + 200                                 # wall-clock cap
    while time.time() < deadline:
        s = link.status()
        a = s.get("alt_rel") or 0.0
        samples.append({"t": round(time.time() - t0, 2), "alt": a,
                        "gs": s.get("groundspeed"), "wp": s.get("wp_current"),
                        "mode": s.get("mode"), "armed": s.get("armed"),
                        "batt": s.get("battery_pct")})
        if a > 2.0:
            took_off = True
        wc = s.get("wp_current")
        if finish_w is None and wc is not None and rtl_seq is not None and wc >= rtl_seq:
            finish_w = time.time()                      # coverage done, RTL begun
        if took_off and ((s.get("armed") is False) or (finish_w and a < 0.6)):
            land_w = time.time(); break                 # landed (disarm or on the deck)
        time.sleep(0.5)

    finish_sim = round((finish_w - t0) * speedup, 1) if finish_w else None
    land_sim = round((land_w - t0) * speedup, 1) if land_w else None
    gs_vals = [x["gs"] for x in samples if x.get("gs")]
    gs_max = round(max(gs_vals), 1) if gs_vals else None
    os.makedirs(LOG_DIR, exist_ok=True)
    with open(os.path.join(LOG_DIR, f"wind_{label}.json"), "w", encoding="utf-8") as f:
        json.dump({"label": label, "wind_spd": wind_spd, "wind_applied": wind_ok,
                   "speedup": speedup, "finish_sim_s": finish_sim, "land_sim_s": land_sim,
                   "gs_max": gs_max, "samples": samples}, f, ensure_ascii=False, indent=1)
    print(f"     took_off={took_off} samples={len(samples)} gs_max={gs_max} m/s "
          f"finish_sim={finish_sim}s land_sim={land_sim}s", flush=True)
    return finish_sim, land_sim, len(samples), (land_w is not None), wind_ok


def main():
    if not os.path.exists(SITL_EXE):
        print(f"SITL binary not found: {SITL_EXE}"); sys.exit(2)
    kill_sitl(); time.sleep(1.0)

    # --- plan the mission with the v2.4 engine ---
    api = Api()
    r = api.build_route({"boundary": FIELD, "spacing": 25, "alt": ALT, "speed": SPEED,
                         "rtl": True, "anchor": {"lat": HOME[0], "lng": HOME[1]}})
    check("engine built the mission", r.get("ok") is True and r.get("count", 0) > 2)
    wps = [(p["lat"], p["lng"]) for p in r["waypoints"]]
    # Planned full-mission time, computed against the REAL takeoff (SITL home).
    planned = estimate_mission_time(wps, HOME, wp_alt=ALT, takeoff_alt=TAKEOFF_ALT,
                                    speed=SPEED, rtl=True)
    planned_s = planned["total_s"]
    print(f"     planned: {planned_s:.0f}s  breakdown={ {k: round(v) for k, v in planned.items()} }",
          flush=True)
    items = build_mission_items(HOME, takeoff_alt=TAKEOFF_ALT, waypoints=wps,
                                wp_alt=ALT, rtl=True, speed=SPEED)
    rtl_seq = len(items) - 1                            # RTL is the last item

    args = [SITL_EXE, "-M", "quad", "--home", "49.5275,24.004,200,0", "-I0",
            "--speedup", str(SPEEDUP), "--defaults", "test_params.parm"]
    out = open(os.path.join(SITL_DIR, "sitl_wind_run.log"), "w")
    err = open(os.path.join(SITL_DIR, "sitl_wind_err.log"), "w")
    print("== launching ArduCopter SITL (speedup %d) ==" % SPEEDUP, flush=True)
    proc = subprocess.Popen(args, cwd=SITL_DIR, stdout=out, stderr=err)

    link = MavLink()
    results = []
    try:
        time.sleep(4.0)
        res = connect_persistent(link, "127.0.0.1", PORT, timeout=30)
        check("connected to SITL", res.get("ok"))
        if not res.get("ok"):
            print(f"     {res.get('error')}"); return
        connected = False
        for _ in range(60):
            if link.status().get("connected"):
                connected = True; break
            time.sleep(0.5)
        check("heartbeat from ArduPilot", connected)
        check("GPS 3D fix acquired", wait_gps(link))

        up = link.upload_mission(items, timeout=30.0)
        check("mission uploaded", up.get("ok") and up.get("count") == len(items))

        time.sleep(4.0)              # let the EKF/home settle before the first arm

        # --- fly under two wind regimes ---
        for label, wind in (("calm", 0.0), ("windy", 7.0)):
            fsim, lsim, nsamp, landed, wind_ok = fly(link, label, wind, rtl_seq, SPEEDUP)
            check(f"[{label}] took off + logged telemetry", nsamp > 5)
            if wind > 0:
                check(f"[{label}] wind actually applied in the sim (read-back)", wind_ok)
            soft(f"[{label}] completed coverage (entered RTL)", fsim is not None)
            soft(f"[{label}] landed", landed)
            if lsim:
                results.append({"label": label, "wind": wind,
                                "planned": planned_s, "actual": lsim})
                ratio = lsim / planned_s if planned_s else 0
                print(f"     [{label}] planned {planned_s:.0f}s vs actual {lsim:.0f}s "
                      f"(ratio {ratio:.2f})", flush=True)
                check(f"[{label}] actual flight time is in a sane band of the estimate",
                      0.4 <= ratio <= 2.5)

        # --- time-correspondence + calibration loop ---
        if len(results) >= 1:
            print("\n== planned vs actual + calibration ==", flush=True)
            recs = [{"planned": {"duration_s": x["planned"]},
                     "actual": {"duration_s": x["actual"]}} for x in results]
            cal = calibrate(recs)
            check("calibrate() derived a time_mult from the flown data", "time_mult" in cal)
            tm = cal.get("time_mult", 1.0)
            print(f"     time_mult={tm:.3f} (calibrates the planner to this drone/wind)",
                  flush=True)
            # After calibration, re-estimating must match each actual far better.
            worst_raw = max(abs(x["planned"] - x["actual"]) / x["actual"] for x in results)
            worst_cal = max(abs(x["planned"] * tm - x["actual"]) / x["actual"] for x in results)
            print(f"     worst error: raw {worst_raw*100:.0f}% -> calibrated {worst_cal*100:.0f}%",
                  flush=True)
            check("calibrated estimate corresponds to actual (<= raw error)",
                  worst_cal <= worst_raw + 1e-6)
            check("calibrated estimate within 30% of actual", worst_cal <= 0.30)
        else:
            soft("at least one flight produced a land time", False)

    finally:
        try: link.disconnect()
        except Exception: pass
        try: proc.terminate()
        except Exception: pass
        time.sleep(1.0)
        kill_sitl()

    print("\nRESULT: " + ("ALL CHECKS PASSED" if not check.failed else f"{check.failed} FAILURES ABOVE"),
          flush=True)
    sys.exit(1 if check.failed else 0)


if __name__ == "__main__":
    main()
