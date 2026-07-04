r"""End-to-end MAVLink test against the REAL ArduCopter SITL binary.

Unlike test_mavlink.py (a fake UDP vehicle that only echoes our own framing),
this drives the actual ArduPilot mission storage over TCP — so it catches the
quirks a fake can't: how ArduPilot rewrites altitude frames, stores the home /
DO_CHANGE_SPEED / RTL items, and rounds coordinates. This is the "перевірка на
реальному дроні" the backlog asks for, done locally without hardware.

    SITL (ArduCopter.exe :5760 TCP server)  <──  our MavLink GCS (this test)

Run:  .\.venv\Scripts\python.exe test_sitl.py
The script launches and tears down its own SITL; no start_sitl.ps1 needed.
"""
import os
import subprocess
import sys
import time

from backend.mavlink_link import MavLink, build_mission_items, CMD_DO_CHANGE_SPEED

ROOT = os.path.dirname(os.path.abspath(__file__))
SITL_DIR = os.path.join(ROOT, "sitl")
SITL_EXE = os.path.join(SITL_DIR, "ArduCopter.exe")
PORT = 5760
HOME = (49.5275, 24.004, 200.0)        # matches the --home below (lat,lon,alt AMSL)


def check(name, cond):
    print(("  OK  " if cond else " FAIL ") + name, flush=True)
    if not cond:
        check.failed = True


check.failed = False


def soft(name, cond):
    """Like check() but never fails the run — for behaviour whose timing the SITL
    can't guarantee (e.g. how fast it publishes HOME_POSITION)."""
    print(("  OK  " if cond else " WARN ") + name, flush=True)


def connect_persistent(link, host, port, timeout):
    """Open the ONE persistent GCS link to SITL, retrying past the startup race.

    Never use a throwaway probe socket: ArduCopter SITL's SERIAL0 is a
    single-client TCP server, and a connect/disconnect on :5760 makes SITL exit
    (the very reason start_sitl.ps1 runs a mux to hold the port open). So the
    first socket we open must be the link we keep — we just retry link.connect()
    until the listener is up, and the attempt that succeeds stays connected."""
    end = time.time() + timeout
    while time.time() < end:
        res = link.connect(f"tcp:{host}:{port}")
        if res.get("ok"):
            return res
        time.sleep(1.0)
    return {"ok": False, "error": "SITL не підняв TCP :5760 вчасно."}


def kill_sitl():
    """Belt-and-suspenders cleanup of any ArduCopter SITL on this machine."""
    try:
        subprocess.run(["taskkill", "/IM", "ArduCopter.exe", "/F"],
                       capture_output=True)
    except Exception:
        pass


def main():
    if not os.path.exists(SITL_EXE):
        print(f"SITL binary not found: {SITL_EXE}")
        sys.exit(2)

    kill_sitl()
    time.sleep(1.0)

    # Launch ArduCopter SITL (home near Lviv), output to the usual sitl logs.
    args = [SITL_EXE, "-M", "quad", "--home", "49.5275,24.004,200,0", "-I0",
            "--defaults", "test_params.parm"]
    out = open(os.path.join(SITL_DIR, "sitl_run.log"), "w")
    err = open(os.path.join(SITL_DIR, "sitl_err.log"), "w")
    print("== launching ArduCopter SITL ==", flush=True)
    proc = subprocess.Popen(args, cwd=SITL_DIR, stdout=out, stderr=err)

    link = MavLink()
    try:
        # Give SITL a moment to bind the listener, then attach the ONE link that
        # drives it past clock init (no throwaway probe — see connect_persistent).
        time.sleep(4.0)
        print("== connecting GCS to SITL ==", flush=True)
        res = connect_persistent(link, "127.0.0.1", PORT, timeout=30)
        check("connect call ok", res.get("ok"))
        if not res.get("ok"):
            print(f"     connect error: {res.get('error')}", flush=True)
            return

        # Wait for a live heartbeat (SITL needs a few seconds after first connect).
        connected = False
        for _ in range(60):
            if link.status().get("connected"):
                connected = True
                break
            time.sleep(0.5)
        check("heartbeat from real ArduPilot", connected)
        if not connected:
            return

        tl = link.status()
        check("flight mode parsed from SITL", isinstance(tl.get("mode"), str) and tl["mode"])
        print(f"     mode={tl.get('mode')} armed={tl.get('armed')} "
              f"sats={tl.get('sats')} fix={tl.get('fix_type')}", flush=True)

        # Wait for ArduPilot to publish HOME_POSITION. This exercises the periodic
        # GET_HOME_POSITION re-request: a single early ask (before GPS lock) goes
        # unanswered, so home only ever arrives if we keep asking. Soft check —
        # home timing in SITL varies, so a miss warns instead of failing the run.
        got_home = False
        for _ in range(90):                       # up to ~45 s
            if link.status().get("home_lat") is not None:
                got_home = True
                break
            time.sleep(0.5)
        s = link.status()
        print(f"     home_lat={s.get('home_lat')} gps_lat={s.get('lat')} "
              f"fix={s.get('fix_type')}", flush=True)
        soft("HOME_POSITION learned from ArduPilot (periodic re-request works)",
             got_home)

        # Representative spraying mission: home + takeoff + DO_CHANGE_SPEED + a
        # small lawnmower + RTL. speed>0 forces the DO_CHANGE_SPEED item, the one
        # most likely to expose a real-vehicle storage difference.
        wps = [(49.5280, 24.0045), (49.5285, 24.0045), (49.5285, 24.0055),
               (49.5280, 24.0055), (49.5280, 24.0065), (49.5285, 24.0065)]
        items = build_mission_items(HOME, takeoff_alt=15.0, waypoints=wps,
                                    wp_alt=40.0, rtl=True, speed=6.0)
        has_speed = any(it["command"] == CMD_DO_CHANGE_SPEED for it in items)
        check("mission includes a DO_CHANGE_SPEED item", has_speed)
        print(f"     built {len(items)} items "
              f"(home+takeoff+speed+{len(wps)}wp+rtl)", flush=True)

        print("== upload to real ArduPilot ==", flush=True)
        up = link.upload_mission(items, timeout=30.0)
        check("upload accepted by ArduPilot", up.get("ok"))
        check("upload count matches", up.get("count") == len(items))
        if not up.get("ok"):
            print(f"     upload error: {up.get('error')}", flush=True)
            return

        print("== verify (read-back compare) against real ArduPilot ==", flush=True)
        v = link.verify_mission(items, timeout=30.0)
        check("verify ran ok", v.get("ok"))
        check("verify VERIFIED — real ArduPilot stored exactly what we sent",
              v.get("verified") is True)
        check("verify counts agree",
              v.get("count_expected") == v.get("count_actual") == len(items))
        if v.get("mismatches"):
            print(f"     mismatches: {v['mismatches']}", flush=True)

        print("== raw download (inspect what the vehicle holds) ==", flush=True)
        dl = link.download_mission(timeout=30.0)
        check("download ok", dl.get("ok"))
        if dl.get("items"):
            check("downloaded count == uploaded", len(dl["items"]) == len(items))
            for d in dl["items"]:
                print(f"     #{d['seq']:>2} cmd={d['command']:>3} frame={d['frame']} "
                      f"x={d['x']} y={d['y']} z={d['z']}", flush=True)
            # Spot-check the first real waypoint round-trips its coordinate.
            first_wp_seq = next(it["seq"] for it in items
                                if it["command"] == 16 and it["seq"] != 0)
            dwp = next((d for d in dl["items"] if d["seq"] == first_wp_seq), None)
            exp_x = int(round(wps[0][0] * 1e7))
            check("first waypoint lat round-trips through ArduPilot",
                  dwp is not None and abs(dwp["x"] - exp_x) <= 5)

        print("== sanity: verify FLAGS a deliberately wrong mission ==", flush=True)
        wrong = build_mission_items(HOME, takeoff_alt=15.0,
                                    waypoints=[(49.9, 24.9)], wp_alt=40.0,
                                    rtl=True, speed=6.0)
        vbad = link.verify_mission(wrong, timeout=30.0)
        check("wrong-mission verify ran", vbad.get("ok"))
        check("wrong-mission flagged NOT verified", vbad.get("verified") is False)
        check("wrong-mission lists differences", len(vbad.get("mismatches", [])) > 0)

    finally:
        try:
            link.disconnect()
        except Exception:
            pass
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        kill_sitl()
        try:
            out.close(); err.close()
        except Exception:
            pass

    print(flush=True)
    if check.failed:
        print("RESULT: FAILURES PRESENT")
        sys.exit(1)
    print("RESULT: ALL CHECKS PASSED")


if __name__ == "__main__":
    main()
