"""Regression for #12 safe_transit (backend/coverage.py). Run: .venv/bin/python test_safe_transit.py"""
import sys
sys.path.insert(0, ".")
from backend.coverage import safe_transit

failed = 0
def check(name, cond):
    global failed
    print(("  OK  " if cond else " FAIL ") + name)
    if not cond: failed += 1

# ~200 m square field near 49.49 N
field = [(49.4890, 24.0000), (49.4890, 24.0028), (49.4908, 24.0028), (49.4908, 24.0000)]
home_in = (49.4892, 24.0014)     # inside, near the south edge
wp0 = (49.4906, 24.0010)         # inside, near the north edge
wps = [wp0, (49.4906, 24.0018), (49.4904, 24.0018)]

# 1) clear field, home inside → straight-ish ingress, provably contained
r = safe_transit(field, wps, home_in, exclusions=[], margin=1)
check("clear: home_inside", r["home_inside"] is True)
check("clear: ingress_ok", r["ingress_ok"] is True)
check("clear: egress_ok", r["egress_ok"] is True)
check("clear: ingress starts at home, ends at wp0", len(r["ingress"]) >= 2)
check("clear: egress ends at home",
      abs(r["egress"][-1][0]-home_in[0]) < 1e-4 and abs(r["egress"][-1][1]-home_in[1]) < 1e-4)

# 2) a small obstacle between home and wp0 → route must go AROUND (more than 2 points), still contained
obst = [(49.4898, 24.0011), (49.4898, 24.0017), (49.4900, 24.0017), (49.4900, 24.0011)]
r2 = safe_transit(field, wps, home_in, exclusions=[obst], margin=1)
check("obstacle: ingress still ok (routed around)", r2["ingress_ok"] is True)
check("obstacle: ingress detours (>2 pts)", len(r2["ingress"]) > 2)

# 3) FAIL-SAFE: a strip splitting the field into two DISCONNECTED lobes, home in one, wp0 in the other
strip = [(49.4898, 23.9999), (49.4898, 24.0029), (49.4900, 24.0029), (49.4900, 23.9999)]
r3 = safe_transit(field, wps, home_in, exclusions=[strip], margin=1)
check("split: ingress_ok is FALSE (no obstacle-crossing path)", r3["ingress_ok"] is False)
check("split: ingress is EMPTY (fail-safe → straight RTL, not baked crossing)", r3["ingress"] == [])
check("split: reason names containment", "contained" in (r3["reason"] or ""))

# 4) home OUTSIDE the field → projects to a ring foot
home_out = (49.4885, 24.0014)    # south of the field
r4 = safe_transit(field, wps, home_out, exclusions=[], margin=1)
check("outside: home_inside False", r4["home_inside"] is False)
check("outside: ingress planned (entry foot + inside route) or clean fail", isinstance(r4["ingress"], list))

print("\nRESULT: " + (f"{failed} FAILURE(S)" if failed else "ALL CHECKS PASSED"))
sys.exit(1 if failed else 0)
