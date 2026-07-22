"""Regression for the JS-facing Api.safe_transit bridge (#12 part 2). It must read the last-built
route from _state, return {lat,lng}-shaped legs, honour a home override, and preserve the engine's
fail-safe (empty leg + *_ok False when no provably-contained path exists).
Run: .venv/bin/python test_api_safe_transit.py"""
import sys
sys.path.insert(0, ".")
from backend.api import Api

failed = 0
def check(name, cond):
    global failed
    print(("  OK  " if cond else " FAIL ") + name)
    if not cond: failed += 1

# same ~200 m square field / route as test_safe_transit.py
field = [(49.4890, 24.0000), (49.4890, 24.0028), (49.4908, 24.0028), (49.4908, 24.0000)]
home_in = (49.4892, 24.0014)
wps = [(49.4906, 24.0010), (49.4906, 24.0018), (49.4904, 24.0018)]

def api_with_state(exclusions, home=home_in, margin=1):
    a = Api()
    a._state = {"home": (home[0], home[1], 0.0), "waypoints": wps, "contour": field,
                "exclusions": exclusions, "margin": margin}
    return a

# 0) no route built yet → clean error, never a crash
check("no state → ok False", Api().safe_transit({}).get("ok") is False)

# 1) clear field: JS-shaped ingress/egress, contained, egress ends at home
r = api_with_state([]).safe_transit({})
check("clear: ok", r["ok"] is True)
check("clear: ingress_ok + egress_ok", r["ingress_ok"] and r["egress_ok"])
check("clear: legs are {lat,lng} dicts", isinstance(r["ingress"][0], dict) and "lat" in r["ingress"][0] and "lng" in r["ingress"][0])
check("clear: egress ends at home",
      abs(r["egress"][-1]["lat"]-home_in[0]) < 1e-4 and abs(r["egress"][-1]["lng"]-home_in[1]) < 1e-4)

# 2) obstacle between home and wp0 → detour (>2 pts), still ok
obst = [(49.4898, 24.0011), (49.4898, 24.0017), (49.4900, 24.0017), (49.4900, 24.0011)]
r2 = api_with_state([obst]).safe_transit({})
check("obstacle: ingress ok + detours (>2 pts)", r2["ingress_ok"] and len(r2["ingress"]) > 2)

# 3) fail-safe: a strip disconnecting home from wp0 → ingress_ok False + EMPTY leg
strip = [(49.4898, 23.9999), (49.4898, 24.0029), (49.4900, 24.0029), (49.4900, 23.9999)]
r3 = api_with_state([strip]).safe_transit({})
check("split: ok True but ingress_ok False", r3["ok"] is True and r3["ingress_ok"] is False)
check("split: ingress EMPTY (fail-safe)", r3["ingress"] == [])

# 4) home override (live vehicle home) is honoured over the route's stored home
r4 = api_with_state([], home=(49.4900, 24.0014)).safe_transit(
        {"home": {"lat": 49.4892, "lng": 24.0014}})
check("override: egress ends at the OVERRIDE home, not the state home",
      abs(r4["egress"][-1]["lat"]-49.4892) < 1e-4)

print("\nRESULT: " + (f"{failed} FAILURE(S)" if failed else "ALL CHECKS PASSED"))
sys.exit(1 if failed else 0)
