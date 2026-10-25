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

print("\nRESULT: " + (f"{failed} FAILURE(S)" if failed else "ALL CHECKS PASSED"))
sys.exit(1 if failed else 0)
