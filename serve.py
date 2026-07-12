"""Browser mode: serve the Field Mission Planner UI over local HTTP and open it
in the default browser. Reliable alternative to the pywebview desktop window
(WebView2 is unstable on repeated launches here).

Run:  python serve.py
"""
import json
import os
import shutil
import sys
import threading
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# When packaged with PyInstaller the source dir doesn't exist; bundled data
# (web/) lives under sys._MEIPASS.
if getattr(sys, "frozen", False):
    HERE = getattr(sys, "_MEIPASS", os.path.dirname(sys.executable))
else:
    HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from backend.api import Api  # noqa: E402

# Which frontend to serve. Defaults to web-stable/ (the canonical, released
# frontend). Override with FMP_WEB_DIR to serve a different folder.
_web_override = os.environ.get("FMP_WEB_DIR")
if _web_override:
    WEB = _web_override if os.path.isabs(_web_override) else os.path.join(HERE, _web_override)
else:
    WEB = os.path.join(HERE, "web-stable")
api = Api()                  # window stays None -> export writes to exports/
_lock = threading.Lock()

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png", ".json": "application/json", ".ico": "image/x-icon",
    ".svg": "image/svg+xml",          # Leaflet-draw toolbar icons are an SVG sprite
                                       # — without this they render as empty squares.
    # Pyodide runtime (self-hosted under web/pyodide/ for offline use).
    ".wasm": "application/wasm",      # MUST be exact for instantiateStreaming
    ".zip": "application/octet-stream",
    ".whl": "application/octet-stream",
    ".apk": "application/vnd.android.package-archive",  # downloadable Android app
}

# The browser planning engine (Pyodide) loads these backend modules into its
# in-memory FS and runs them verbatim — same code as the desktop, no rewrite.
ENGINE_MODULES = frozenset({"__init__.py", "geo.py", "coverage.py", "mission.py",
                            "api.py", "flight_calib.py"})

# Offline map tiles for the DESKTOP. The Qt app has NO service worker (it's served
# locally), so it can't use the browser's tile cache the PWA relies on. Instead
# serve.py proxies + caches tiles to disk: a request hits the local cache first;
# on a miss WITH internet it fetches upstream and saves it; offline it 404s (blank
# tile). `provider` is an ALLOW-LIST mapped to fixed URL templates (never an
# arbitrary URL), and z/x/y are range-checked — so this is not an open proxy.
TILE_PROVIDERS = {
    "esri":       "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    "esrilabels": "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
    "google":     "https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
    "carto":      "https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
    "topo":       "https://a.tile.opentopomap.org/{z}/{x}/{y}.png",
}
TILES_DIR = os.path.join(HERE, "tiles_cache")


def _photo_debug_keep(payload, res, keep=20):
    """Retain each photo-import request (image + response summary) under
    logs/photo/ so a field report («контури зʼїхали») is reproducible: without
    the operator's exact screenshot the georef pipeline can't be debugged.
    Off with FMP_PHOTO_KEEP=0. Keeps the newest `keep` pairs."""
    if os.environ.get("FMP_PHOTO_KEEP", "1") == "0":
        return
    try:
        import base64 as _b64, json as _json, time as _time
        d = os.path.join(HERE, "logs", "photo")
        os.makedirs(d, exist_ok=True)
        ts = _time.strftime("%Y%m%d-%H%M%S", _time.gmtime())
        b64 = (payload or {}).get("image_b64") or ""
        if "," in b64[:80]:                      # data:-URL prefix
            b64 = b64.split(",", 1)[1]
        with open(os.path.join(d, ts + ".jpg"), "wb") as f:
            f.write(_b64.b64decode(b64))
        summary = {k: res.get(k) for k in ("ok", "band", "confidence", "error",
                                           "labels", "georef", "diag")}
        summary["region_hint"] = (payload or {}).get("region_hint")
        summary["n_contours"] = len(res.get("contours") or [])
        with open(os.path.join(d, ts + ".json"), "w", encoding="utf-8") as f:
            _json.dump(summary, f, ensure_ascii=False, indent=1, default=str)
        old = sorted(os.listdir(d))
        for name in old[:-keep * 2]:             # .jpg + .json per request
            try: os.remove(os.path.join(d, name))
            except OSError: pass
    except Exception:
        pass                                     # діагностика ніколи не валить запит


def _img_ctype(b):
    """Sniff an image MIME from magic bytes (tiles are JPEG from Esri/Google, PNG
    from Carto). Avoids trusting/guessing the upstream's declared type."""
    if b[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if b[:2] == b"\xff\xd8":
        return "image/jpeg"
    return "application/octet-stream"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # quiet

    def _sec_headers(self):
        """Defence-in-depth headers on every response. Cheap and can't break the app:
        stop MIME-sniffing, framing (clickjacking), and referrer leakage. (A full CSP
        is a worthwhile follow-up but must be verified to not break the Pyodide worker
        + WASM in a real browser before shipping — the primary XSS sinks are already
        escaped via esc()/textContent, so CSP would be a backstop, not the fix.)"""
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        # geolocation=(self): the planner uses navigator.geolocation for the
        # "my position" anchor (start/finish near the operator). Same-origin only.
        self.send_header("Permissions-Policy", "geolocation=(self), microphone=(), camera=()")

    def _send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, (bytes, bytearray)) else body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        # Never cache: QtWebEngine (and browsers) otherwise keep serving the old
        # index.html/app.js/style.css after an update, so changes don't appear.
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self._sec_headers()
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    @staticmethod
    def _parse_range(header, size):
        """Parse a single 'bytes=START-END' Range header against a file of `size`.
        Returns False when no usable range is asked (serve the whole file), None
        when a range is asked but unsatisfiable (caller sends 416), or an inclusive
        (start, end) tuple. Multi-range / malformed headers fall back to False."""
        header = (header or "").strip()
        if not header.startswith("bytes="):
            return False
        spec = header[len("bytes="):].strip()
        if "," in spec or "-" not in spec:       # multi-range or garbage -> serve whole
            return False
        a, b = (x.strip() for x in spec.split("-", 1))
        try:
            if a == "":                          # suffix range: last N bytes
                n = int(b)
                if n <= 0:
                    return None
                start, end = max(0, size - n), size - 1
            else:
                start = int(a)
                end = int(b) if b else size - 1
        except ValueError:
            return False
        if start >= size or start > end:
            return None                          # unsatisfiable
        return (start, min(end, size - 1))

    def _send_file(self, fp, ctype, range_header=None):
        """Stream a static file from disk in chunks. Large installers (the PC zip
        is ~170 MB) must NOT be read fully into RAM — the VPS is memory-tight.
        Honours a single HTTP Range so an interrupted installer download resumes
        instead of restarting from byte 0."""
        try:
            size = os.path.getsize(fp)
            rng = self._parse_range(range_header, size) if range_header else False
            if rng is None:                      # range present but unsatisfiable
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.send_header("Accept-Ranges", "bytes")
                self.end_headers()
                return
            partial = rng is not False
            start, end = rng if partial else (0, size - 1)
            length = end - start + 1
            self.send_response(206 if partial else 200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(length))
            self.send_header("Accept-Ranges", "bytes")
            if partial:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
            self.send_header("Pragma", "no-cache")
            self._sec_headers()
            self.end_headers()
            with open(fp, "rb") as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(262144, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def do_HEAD(self):
        # Browsers / download managers probe large files with HEAD before GET.
        # http.server doesn't implement it (→ 501), so handle it explicitly.
        path = self.path.split("?")[0]
        if path in ("/", ""):
            path = "/index.html"
        fp = None
        ctype = "application/octet-stream"
        if path.startswith("/engine/"):
            name = path[len("/engine/"):]
            cand = os.path.join(HERE, "backend", name)
            if name in ENGINE_MODULES and os.path.isfile(cand):
                fp, ctype = cand, "text/plain; charset=utf-8"
        else:
            cand = os.path.normpath(os.path.join(WEB, path.lstrip("/")))
            if (cand == WEB or cand.startswith(WEB + os.sep)) and os.path.isfile(cand):
                fp = cand
                ctype = CONTENT_TYPES.get(os.path.splitext(cand)[1].lower(), "application/octet-stream")
        if not fp:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(os.path.getsize(fp)))
        self.send_header("Accept-Ranges", "bytes")   # advertise resumable downloads
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self._sec_headers()
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/", ""):
            path = "/index.html"
        # Serve the planning engine's Python modules straight from backend/ (no
        # duplicate copy under web/) so the in-browser Pyodide engine runs the
        # exact same code as the desktop.
        if path.startswith("/engine/"):
            name = path[len("/engine/"):]
            if name in ENGINE_MODULES:
                fp = os.path.join(HERE, "backend", name)
                if os.path.isfile(fp):
                    with open(fp, "rb") as f:
                        self._send(200, f.read(), "text/plain; charset=utf-8")
                    return
            self._send(404, "not found", "text/plain"); return
        # Offline map tiles: /tiles/<provider>/<z>/<x>/<y> — disk cache, else fetch.
        if path.startswith("/tiles/"):
            self._serve_tile(path); return
        fp = os.path.normpath(os.path.join(WEB, path.lstrip("/")))
        # Stay strictly inside WEB/ — compare against WEB + separator so a sibling
        # dir like web.bak can't be reached by prefix match.
        if not (fp == WEB or fp.startswith(WEB + os.sep)) or not os.path.isfile(fp):
            self._send(404, "not found", "text/plain"); return
        ext = os.path.splitext(fp)[1].lower()
        self._send_file(fp, CONTENT_TYPES.get(ext, "application/octet-stream"),
                        self.headers.get("Range"))

    def _serve_tile(self, path):
        """Serve a map tile from the on-disk cache; on a miss, fetch it upstream
        (online) and save it. Offline + not cached -> 404 (Leaflet shows a blank
        tile). Path: /tiles/<provider>/<z>/<x>/<y>."""
        parts = path.strip("/").split("/")            # ["tiles", provider, z, x, y]
        if len(parts) != 5:
            self._send(404, "bad tile path", "text/plain"); return
        _, prov, z, x, y = parts
        if prov not in TILE_PROVIDERS or not (z.isdigit() and x.isdigit() and y.isdigit()):
            self._send(404, "unknown tile", "text/plain"); return
        zi, xi, yi = int(z), int(x), int(y)
        if not (0 <= zi <= 21 and 0 <= xi < (1 << zi) and 0 <= yi < (1 << zi)):
            self._send(404, "tile out of range", "text/plain"); return
        local = os.path.join(TILES_DIR, prov, z, x, y)
        if os.path.isfile(local):
            try:
                with open(local, "rb") as f:
                    self._send_tile(f.read()); return
            except OSError:
                pass
        url = TILE_PROVIDERS[prov].format(z=zi, x=xi, y=yi)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "FieldMissionPlanner/1.0"})
            with urllib.request.urlopen(req, timeout=8) as r:
                data = r.read()
        except Exception:
            self._send(404, "tile unavailable offline", "text/plain"); return
        if not data:
            self._send(404, "empty tile", "text/plain"); return
        try:
            # DoS cap (security audit S11): an authed client can request unlimited
            # distinct z/x/y and fill the disk. Only CACHE while there's ample free
            # space; below the floor we still SERVE the tile, just don't write it.
            if shutil.disk_usage(HERE).free > 700 * 1024 * 1024:   # keep ≥700 MB free
                os.makedirs(os.path.dirname(local), exist_ok=True)
                with open(local, "wb") as f:
                    f.write(data)
        except OSError:
            pass
        self._send_tile(data)

    def _send_tile(self, data):
        """Send tile bytes with an immutable long cache (tiles never change), so the
        WebView/browser also keeps them — unlike _send which forbids caching."""
        self.send_response(200)
        self.send_header("Content-Type", _img_ctype(data))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        self._sec_headers()
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    # Endpoint -> Api call. MAV_PATHS run WITHOUT the global lock (they're already
    # serialized inside MavLink); holding _lock across a ~40 s upload would freeze
    # telemetry polling and the Disconnect button.
    def _dispatch(self, path, payload):
        if path == "/api/build_route":
            return api.build_route(payload)
        if path == "/api/export":
            return api.export(payload.get("fmt"))
        if path == "/api/save_project":
            return api.save_project(payload)
        if path == "/api/mav_ports":
            return api.mav_ports(payload)
        if path == "/api/mav_connect":
            return api.mav_connect(payload)
        if path == "/api/mav_disconnect":
            return api.mav_disconnect(payload)
        if path == "/api/mav_status":
            return api.mav_status(payload)
        if path == "/api/mav_upload_mission":
            return api.mav_upload_mission(payload)
        if path == "/api/mav_download_mission":
            return api.mav_download_mission(payload)
        if path == "/api/mav_verify_mission":
            return api.mav_verify_mission(payload)
        if path == "/api/mav_command":
            return api.mav_command(payload)
        if path == "/api/import_photo":
            res = api.import_photo(payload)
            _photo_debug_keep(payload, res)
            return res
        return {"ok": False, "error": "unknown endpoint"}

    MAV_PATHS = frozenset({
        "/api/mav_status", "/api/mav_disconnect", "/api/mav_upload_mission",
        "/api/mav_download_mission", "/api/mav_verify_mission", "/api/mav_connect",
        "/api/mav_ports", "/api/mav_command",
    })

    def _store_log(self, payload):
        """Save a client's diagnostic log under logs/ so it can be analysed remotely
        (the operator just taps «Лог для аналізу» and the device uploads it here)."""
        import re
        dev = re.sub(r"[^A-Za-z0-9_-]", "", str(payload.get("device", "anon"))[:40]) or "anon"
        log = payload.get("log")
        if isinstance(log, list):
            log = "\n".join(str(x) for x in log)
        log = str(log or "")[:600000]                     # cap ~600 KB per device
        logdir = os.path.join(HERE, "logs")
        try:
            os.makedirs(logdir, exist_ok=True)
            # Disk-fill guard: cap the number of distinct device logs (a real user
            # has 1–2). Prune the oldest beyond the cap so a flood of fake device
            # ids can't fill the disk. Per-file size is already bounded above.
            try:
                files = sorted(
                    (os.path.join(logdir, x) for x in os.listdir(logdir) if x.startswith("client-")),
                    key=os.path.getmtime)
                for old in files[:-300]:
                    os.remove(old)
            except OSError:
                pass
            _clean = lambda s, n: str(s or "?")[:n].replace("\n", " ").replace("\r", " ")
            head = (f"=== {_clean(payload.get('platform'), 40)} v{_clean(payload.get('version'), 40)} "
                    f"dev={dev} ua={_clean(payload.get('ua'), 120)} ===")
            with open(os.path.join(logdir, f"client-{dev}.log"), "w", encoding="utf-8") as f:
                f.write(head + "\n" + log + "\n")
            return {"ok": True, "bytes": len(log)}
        except Exception as exc:
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        # Body cap: /api/import_photo несе base64-скріншот (~1–6 МБ), тому лише
        # цьому маршруту — 8 МБ; решті лишається жорсткий 1 МБ (legit /api/log
        # body ~600 KB). Захист від Content-Length: 2GB, що OOM-ить сервер.
        cap = 8_000_000 if self.path == "/api/import_photo" else 1_000_000
        if n > cap:
            self._send(413, json.dumps({"ok": False, "error": "too large"}))
            return
        raw = self.rfile.read(n) if n else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            payload = {}
        # Client diagnostic-log upload — stored to logs/, never goes through the Api.
        if self.path == "/api/log":
            self._send(200, json.dumps(self._store_log(payload)))
            return
        # Live drone (MAVLink) endpoints open outbound sockets to arbitrary host:port
        # (SSRF). They belong to the local desktop only — the VPS deploy sets
        # FMP_DISABLE_MAV=1 so they're refused server-side (defence-in-depth; today
        # pymavlink isn't even installed there).
        if self.path in self.MAV_PATHS and os.environ.get("FMP_DISABLE_MAV"):
            self._send(200, json.dumps({"ok": False, "error": "MAVLink вимкнено на сервері."}))
            return
        # Never let an Api exception escape to a bare HTTP 500 (the frontend's
        # r.json() would throw). MAV calls bypass the global lock.
        try:
            if self.path in self.MAV_PATHS:
                res = self._dispatch(self.path, payload)
            else:
                with _lock:
                    res = self._dispatch(self.path, payload)
        except Exception as exc:
            res = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        self._send(200, json.dumps(res))


def start(port=8731):
    """Start the API/static server on a daemon thread. Returns the actual port.
    Used by the Qt desktop host (app_qt.py) and by standalone browser mode."""
    try:
        server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    except OSError:
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)  # fallback free port
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return port


def main():
    """Standalone browser mode: serve + open the default browser."""
    port = start(int(os.environ.get("FMP_PORT", "8731")))
    url = f"http://127.0.0.1:{port}/"
    print("Field Mission Planner serving at", url, flush=True)
    webbrowser.open(url)
    threading.Event().wait()   # block forever


if __name__ == "__main__":
    main()
