import os as _root_os, sys as _root_sys  # moved from the repo root into tests/: keep the root importable
ROOT_DIR = _root_os.path.dirname(_root_os.path.dirname(_root_os.path.abspath(__file__)))
_root_sys.path.insert(0, ROOT_DIR)
"""GPS-denied (VIO) mode: the upload's home item is the operator's take-off point.
Without a fix the FC has no GPS home to offer; the mission's seq 0 / takeoff must sit on
the point the companion uses as the EKF origin, not on the field centroid fallback.
Run: .venv/bin/python test_vio_home_upload.py"""
import sys
sys.path.insert(0, ".")
import backend.mavlink_link as ml
from backend.api import Api

failed = 0
def check(name, cond):
    global failed
    print(("  OK  " if cond else " FAIL ") + name)
    if not cond: failed += 1

class FakeLink:
    def __init__(self, st): self.st, self.items = st, None
    def status(self): return self.st
    def upload_mission(self, items): self.items = items; return {"ok": True, "count": len(items)}
    def set_param(self, name, value): return {"ok": True}
    def set_origin(self, lat, lon, alt_m=0.0):
        self.origin = (lat, lon); return {"ok": True}

def upload(st, **params):
    ml.LINK = FakeLink(st)
    a = Api()
    a._state = {"home": (49.60, 24.10, 0.0), "takeoff_alt": 30.0,
                "waypoints": [(49.501, 24.0), (49.502, 24.0)], "wp_alt": 30.0, "rtl": True, "speed": 0}
    r = a.mav_upload_mission(dict(params, verify=False))
    return ml.LINK.items, r

pad = {"lat": 49.5275, "lng": 24.004}
items, r = upload({}, vio_home=pad)
check("vio_home -> home item on the pad", r["ok"] and abs(items[0]["lat"] - 49.5275) < 1e-9
      and abs(items[0]["lon"] - 24.004) < 1e-9)
check("vio_home -> takeoff on the pad too", abs(items[1]["lat"] - 49.5275) < 1e-9)
check("vio_home -> written to the FC as the EKF origin",
      r.get("origin", {}).get("ok") is True and ml.LINK.origin == (49.5275, 24.004))
items, _ = upload({"home_lat": 49.7, "home_lon": 24.2}, vio_home=pad)
check("vio_home wins over an FC HOME_POSITION", abs(items[0]["lat"] - 49.5275) < 1e-9)
items, r = upload({"home_lat": 49.7, "home_lon": 24.2})
check("no vio_home -> the FC home, as before", abs(items[0]["lat"] - 49.7) < 1e-9)
check("no vio_home -> no origin written (GPS mode keeps EKF3's own)",
      "origin" not in r and not hasattr(ml.LINK, "origin"))

# ---- #52-#54, #60: the file export carries the same mission as the upload --------------
import json as _json
def state_api(speed=12.0):
    a = Api()
    a._state = {"home": (49.60, 24.10, 0.0), "takeoff_alt": 30.0,
                "waypoints": [(49.501, 24.0), (49.502, 24.0)], "wp_alt": 30.0, "rtl": True,
                "speed": speed, "contour": [(49.5, 24.0), (49.51, 24.0), (49.51, 24.01)]}
    return a

def wpl_rows(text):
    return [l.split("\t") for l in text.strip().split("\n")[1:]]

ml.LINK = FakeLink({})
a = state_api()
up = a._mission_items(pad)
f = a.export_files({"fmt": "waypoints", "vio_home": pad})
rows = wpl_rows(f["files"][0]["content"])
check("#52 export row 0 = the VIO home, not the field centroid",
      abs(float(rows[0][8]) - 49.5275) < 1e-7 and abs(float(rows[0][9]) - 24.004) < 1e-7)
check("#52 export takeoff row on the VIO home", abs(float(rows[1][8]) - 49.5275) < 1e-7)
check("#52 export and upload: same rows (command, frame, lat, lon, alt)",
      len(rows) == len(up) and all(
          int(r[3]) == it["command"] and int(r[2]) == it["frame"] and abs(float(r[8]) - it["lat"]) < 1e-7
          and abs(float(r[9]) - it["lon"]) < 1e-7 and abs(float(r[10]) - it["alt"]) < 1e-5
          for r, it in zip(rows, up)))
cmds = [int(r[3]) for r in rows]
check("#54 VIO profile: home, TAKEOFF, LOITER 5, LOITER 105 m, LOITER back, SPEED, legs, WP home, LOITER 25, LAND",
      cmds == [16, 22, 19, 19, 19, 178, 16, 16, 16, 19, 21])
check("#54 holds are 5 s and 25 s, over home", float(rows[2][4]) == 5 and float(rows[9][4]) == 25
      and abs(float(rows[9][8]) - 49.5275) < 1e-7 and abs(float(rows[10][9]) - 24.004) < 1e-7)
check("climb over home to 105 m (home keys to 100 m, Ivan 05.11), then back to 30 m before the legs",
      float(rows[3][10]) == 105.0 and float(rows[3][4]) == 3 and int(rows[3][2]) == 3
      and abs(float(rows[3][8]) - 49.5275) < 1e-7 and float(rows[4][10]) == 30.0 and abs(float(rows[4][9]) - 24.004) < 1e-7)
check("#54 back over home at mission altitude", float(rows[8][10]) == 30.0 and abs(float(rows[8][8]) - 49.5275) < 1e-7)
check("#53 DO_CHANGE_SPEED: type 1 (ground), the panel's speed", float(rows[5][4]) == 1 and float(rows[5][5]) == 12)
g = wpl_rows(a.export_files("waypoints")["files"][0]["content"])
check("#53 GPS export carries the speed too, ends in RTL; row 0 = centroid as before",
      [int(r[3]) for r in g] == [16, 22, 178, 16, 16, 20] and abs(float(g[0][8]) - 49.60) < 1e-7)
check("no speed -> no DO_CHANGE_SPEED row (file flies the FC's)",
      178 not in [int(r[3]) for r in wpl_rows(state_api(0).export_files("waypoints")["files"][0]["content"])])
t = wpl_rows(a.export_files({"fmt": "waypoints", "vio_home": pad, "terrain": True})["files"][0]["content"])
check("terrain: legs + end over home in frame 10, takeoff, climb and land relative (3)",
      [int(r[2]) for r in t] == [0, 3, 3, 3, 3, 3, 10, 10, 10, 10, 3])
pl = _json.loads(a.export_files({"fmt": "plan", "vio_home": pad, "terrain": True})["files"][0]["content"])
m = pl["mission"]
check(".plan: plannedHome = VIO home, same command list as the file (minus row 0)",
      abs(m["plannedHomePosition"][0] - 49.5275) < 1e-9 and
      [it["command"] for it in m["items"]] == cmds[1:])
check(".plan: terrain items AltitudeMode 4, global mixed (0)",
      m["globalPlanAltitudeMode"] == 0 and m["items"][5]["AltitudeMode"] == 4 and m["items"][0]["AltitudeMode"] == 1)
fl = a.export_files({"fmt": "waypoints", "vio_home": pad,
                     "flights": [[[49.501, 24.0], [49.502, 24.0]], [[49.503, 24.0], [49.504, 24.0]]]})
check("#60 sorties: one file each, each with the VIO profile",
      [x["name"] for x in fl["files"]] == ["mission_f1.waypoints", "mission_f2.waypoints"] and
      all([int(r[3]) for r in wpl_rows(x["content"])][-3:] == [16, 19, 21] for x in fl["files"]))
# Ivan 07.11: no climb to 105 m when the forecast at the end is <= 40 m (vio-mode.js climbNeeded decides, per flight)
fc = a.export_files({"fmt": "waypoints", "vio_home": pad, "climbs": [False, True],
                     "flights": [[[49.501, 24.0], [49.502, 24.0]], [[49.503, 24.0], [49.504, 24.0]]]})
f1, f2 = (wpl_rows(x["content"]) for x in fc["files"])
check("climbs [False, True]: flight 1 without the climb (home, TAKEOFF, LOITER 5, SPEED, legs, ...), flight 2 with it",
      [int(r[3]) for r in f1][:4] == [16, 22, 19, 178] and not any(float(r[10]) == 105.0 for r in f1) and
      [float(r[10]) for r in f2][3] == 105.0)
check("no climbs given -> every file climbs (the safe side)",
      all(any(float(r[10]) == 105.0 for r in wpl_rows(x["content"])) for x in fl["files"]))
pc = _json.loads(a.export_files({"fmt": "plan", "vio_home": pad, "climbs": [False]})["files"][0]["content"])
check(".plan without the climb: the same command list as the file without it (minus row 0)",
      [it["command"] for it in pc["mission"]["items"]] == [22, 19, 178, 16, 16, 16, 19, 21])
ml.LINK = FakeLink({})
a = state_api()
a.mav_upload_mission({"vio_home": pad, "vio_climb": False, "verify": False})
check("desktop upload with vio_climb False: no 105 m item; left out -> the climb",
      not any(it["alt"] == 105.0 for it in ml.LINK.items) and [it["command"] for it in ml.LINK.items][:4] == [16, 22, 19, 178])
ml.LINK = FakeLink({})
a = state_api()
a.mav_upload_mission({"vio_home": pad, "verify": False})
check("desktop upload, vio_climb left out -> climbs to 105 m", any(it["alt"] == 105.0 for it in ml.LINK.items))
ml.LINK = FakeLink({})
a = state_api()
a.mav_upload_mission({"vio_home": pad, "terrain": True, "verify": False})
check("upload with terrain -> frame 10 on the legs", [it["frame"] for it in ml.LINK.items][6] == 10)
ml.LINK = FakeLink({})
a = state_api()
r = a.mav_upload_mission({"vio_home": pad, "route": [[49.503, 24.0]], "verify": False})
check("#60 desktop upload of one sortie: only its points between the VIO start and end",
      [(it["command"], round(it["lat"], 3)) for it in ml.LINK.items][6:8] == [(16, 49.503), (16, 49.528)]
      and r["tail"] == 3 and r["vio"] is True)
r = state_api().mav_upload_mission({"verify": False})
check("GPS upload reports tail 1 (RTL)", r["tail"] == 1 and r["vio"] is False)
class RfLink(FakeLink):
    def __init__(self, st, rf): super().__init__(st); self.rf = rf
    def get_param(self, name): return {"ok": True, "value": self.rf} if self.rf is not None else {"ok": False}
for rf, want_ok, label in ((0, False, "RNGFND1_TYPE 0 -> refused, nothing uploaded"),
                           (8, True, "RNGFND1_TYPE 8 (rangefinder) -> uploaded"),
                           (None, True, "param read failed -> not blocked (flaky link)")):
    ml.LINK = RfLink({}, rf)
    r = state_api().mav_upload_mission({"vio_home": pad, "terrain": True, "verify": False})
    check("terrain guard: " + label, bool(r.get("ok")) == want_ok and ((ml.LINK.items is None) != want_ok))

print("\nRESULT: " + (f"{failed} FAILURE(S)" if failed else "ALL CHECKS PASSED"))
sys.exit(1 if failed else 0)
