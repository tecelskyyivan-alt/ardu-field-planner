"""Smoke test for the HTTP layer (serve.py) the desktop app actually talks to.

Starts the server on a free port (SAM warmup stubbed out so it stays light), then
exercises static serving + the JSON endpoints, so a broken route fails the suite.
"""
import json
import sys
import urllib.error
import urllib.request

import serve

serve._warmup_sam = lambda: None          # don't load SAM for an HTTP smoke test
PORT = serve.start(0)                      # 0 -> OS picks a free port
BASE = f"http://127.0.0.1:{PORT}"


def check(name, cond):
    print(("  OK  " if cond else " FAIL ") + name)
    if not cond:
        check.failed = True


check.failed = False


def post(path, body):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode("utf-8"),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.status, json.loads(r.read().decode("utf-8"))


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=15) as r:
        return r.status, r.read().decode("utf-8", "replace")


print("== static files ==")
s, body = get("/")
check("GET / -> 200", s == 200)
check("index.html served", "Field Mission" in body)
check("GET /app.js -> 200", get("/app.js")[0] == 200)

print("\n== range requests (resumable installer downloads) ==")


def get_raw(path, headers=None):
    req = urllib.request.Request(BASE + path, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:                 # 416 raises HTTPError
        return e.code, dict(e.headers), e.read()


st, hdr, full = get_raw("/app.js")
check("full GET advertises Accept-Ranges", hdr.get("Accept-Ranges") == "bytes")
total = len(full)
st, hdr, part = get_raw("/app.js", {"Range": "bytes=10-19"})
check("range -> 206 Partial Content", st == 206)
check("Content-Range header correct", hdr.get("Content-Range") == f"bytes 10-19/{total}")
check("returns exactly the requested 10 bytes", part == full[10:20])
st, hdr, part = get_raw("/app.js", {"Range": "bytes=10-"})         # open-ended (resume)
check("open-ended range -> 206 to EOF", st == 206 and part == full[10:])
st, hdr, part = get_raw("/app.js", {"Range": "bytes=-16"})         # suffix
check("suffix range -> last N bytes", st == 206 and part == full[-16:])
st, hdr, _ = get_raw("/app.js", {"Range": f"bytes={total + 5}-{total + 9}"})
check("unsatisfiable range -> 416", st == 416 and hdr.get("Content-Range") == f"bytes */{total}")
st, hdr, body2 = get_raw("/app.js", {"Range": "rows=1-2"})         # non-bytes unit
check("non-bytes Range ignored -> full 200", st == 200 and body2 == full)

print("\n== /api/build_route (full path incl. new params) ==")
field = [{"lat": 49.503, "lng": 23.996}, {"lat": 49.503, "lng": 24.004},
         {"lat": 49.497, "lng": 24.004}, {"lat": 49.497, "lng": 23.996}]
obst = [{"lat": 49.5005, "lng": 23.9995}, {"lat": 49.5005, "lng": 24.0005},
        {"lat": 49.4995, "lng": 24.0005}, {"lat": 49.4995, "lng": 23.9995}]
s, res = post("/api/build_route", {
    "boundary": field, "spacing": 15, "alt": 50, "speed": 12,
    "flow_lha": 200, "tank_l": 600, "exclusions": [obst],
})
check("build_route ok over HTTP", res.get("ok") is True)
check("response carries waypoints", len(res.get("waypoints", [])) > 0)
check("response carries sprayed/excluded area", res.get("excluded_ha", 0) > 0)
check("response carries liquid + refills", res.get("liquid_l", 0) > 0 and res.get("refills", 0) > 0)
check("response carries duration_breakdown",
      isinstance(res.get("duration_breakdown"), dict) and "total_s" in res["duration_breakdown"])

print("\n== anchor + N-area split (v2.4) ==")
s, ra = post("/api/build_route", {
    "boundary": field, "spacing": 15, "alt": 50, "speed": 12,
    "anchor": {"lat": 49.497, "lng": 24.004}, "split": {"mode": "n_area", "n": 3},
})
check("anchor+split build ok", ra.get("ok") is True)
check("split -> 3 sections", ra.get("flights") == 3 and len(ra.get("sections", [])) == 3)

print("\n== removed AI endpoints are gone ==")
for _ep in ("load_field_osm", "detect_obstacle_at", "training_status", "set_learning", "train_field_ai"):
    s, r = post("/api/" + _ep, {})
    check(f"{_ep} -> unknown endpoint", r.get("ok") is False and "unknown" in (r.get("error") or ""))

print("\n== diagnostic log upload ==")
s, lg = post("/api/log", {"device": "test_dev!!", "version": "9.9", "platform": "test",
                          "log": ["line one", "line two — кирилиця"]})
check("log upload -> ok", lg.get("ok") is True and lg.get("bytes", 0) > 0)
import os as _os
_lf = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "logs", "client-test_dev.log")
check("log written to logs/client-<dev>.log (sanitised id)", _os.path.isfile(_lf))
try:
    _txt = open(_lf, encoding="utf-8").read()
    check("log file holds the uploaded lines", "line two" in _txt and "test" in _txt)
finally:
    try: _os.remove(_lf)
    except OSError: pass

print("\n== offline map tile proxy (/tiles/ — desktop offline maps) ==")
import os as _os2
_png = b"\x89PNG\r\n\x1a\n" + b"FAKE-TILE-BYTES"
_tp = _os2.path.join(serve.TILES_DIR, "esri", "3", "4")
_os2.makedirs(_tp, exist_ok=True)
with open(_os2.path.join(_tp, "5"), "wb") as _f:
    _f.write(_png)
st, hdr, body = get_raw("/tiles/esri/3/4/5")           # cache hit (no network needed)
check("cached tile -> 200", st == 200)
check("cached tile bytes round-trip", body == _png)
check("tile served as image with long cache", hdr.get("Content-Type") == "image/png"
      and "immutable" in (hdr.get("Cache-Control") or ""))
check("unknown provider -> 404", get_raw("/tiles/evilhost/3/4/5")[0] == 404)
check("out-of-range tile -> 404", get_raw("/tiles/esri/1/5/0")[0] == 404)   # z=1 → max idx 1
check("non-numeric tile -> 404", get_raw("/tiles/esri/3/x/5")[0] == 404)
try:
    _os2.remove(_os2.path.join(_tp, "5"))
except OSError:
    pass

print("\n== unknown endpoint ==")
s, u = post("/api/does-not-exist", {})
check("unknown endpoint -> ok:false", u.get("ok") is False)

print("\nRESULT: " + ("ALL CHECKS PASSED" if not check.failed else "FAILURES ABOVE"))
sys.exit(1 if check.failed else 0)
