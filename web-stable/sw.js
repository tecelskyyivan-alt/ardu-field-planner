/* Field Mission Planner service worker — OFFLINE-FIRST, split-cache.
 *
 * The app must run in the field with NO wifi; only updates come online. So:
 *   • the app SHELL (HTML/JS/CSS/Leaflet/icons + the engine *.py modules) lives
 *     in a MUTABLE cache (fmp-shell-vN) — precached on install, served
 *     stale-while-revalidate, wiped+refreshed whenever the version is bumped;
 *   • the IMMUTABLE Pyodide runtime (~28 MB wasm/wheels/stdlib) lives in a
 *     SEPARATE, Pyodide-version-named cache (fmp-pyodide-X.Y.Z) that survives
 *     shell bumps — so a normal app update (a JS/CSS/.py tweak) NEVER
 *     re-downloads the 28 MB runtime. It's refetched only on a real Pyodide
 *     upgrade (the version string below changes -> old cache purged).
 *   • BOTH are precached on install, so a freshly-installed PWA can build routes
 *     fully offline even if the user never built one while online.
 *   • /api/* , /downloads/* and non-GET requests are never cached.
 */
const SHELL_CACHE = "fmp-shell-v105";         // bump this on every app deploy
const PYO_VERSION = "0.26.4";                // == pyodide-lock.json info.version
const PYO_CACHE = "fmp-pyodide-" + PYO_VERSION;

// Mutable app code (incl. the backend engine modules the Pyodide worker mounts).
const SHELL = [
  "./", "index.html", "app.js", "vendor/clipper.min.js", "sw-register.js", "style.css", "manifest.json",
  "icon-192.png", "icon-512.png",
  "engine.js", "engine-worker.js", "mav/mavlink.js", "mav/transport.js", "mav/link.js", "mav/specs.json",
  "engine/__init__.py", "engine/geo.py", "engine/coverage.py", "engine/plane_turns.py", "engine/mission.py", "engine/api.py", "engine/flight_calib.py",
  "lib/leaflet.css", "lib/leaflet.js", "lib/leaflet.draw.css", "lib/leaflet.draw.js",
  "lib/images/marker-icon.png", "lib/images/marker-icon-2x.png", "lib/images/marker-shadow.png",
  "lib/images/layers.png", "lib/images/layers-2x.png",
  "lib/images/spritesheet.png", "lib/images/spritesheet-2x.png", "lib/images/spritesheet.svg",
];

// Immutable Pyodide runtime — version-named cache, never re-downloaded on app updates.
const PYODIDE = [
  "pyodide/pyodide.js", "pyodide/pyodide.asm.js", "pyodide/pyodide.asm.wasm",
  "pyodide/python_stdlib.zip", "pyodide/pyodide-lock.json",
  "pyodide/numpy-1.26.4-cp312-cp312-pyodide_2024_0_wasm32.whl",
  "pyodide/shapely-2.0.2-cp312-cp312-pyodide_2024_0_wasm32.whl",
];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil((async () => {
    // allSettled so one slow/blocked URL can't abort the whole install.
    const shell = await caches.open(SHELL_CACHE);
    await Promise.allSettled(SHELL.map((u) => shell.add(new Request(u, { cache: "reload" }))));
    const pyo = await caches.open(PYO_CACHE);
    await Promise.allSettled(PYODIDE.map((u) => pyo.add(new Request(u, { cache: "reload" }))));
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, PYO_CACHE]);
    const keys = await caches.keys();
    // Drop old shell versions AND old Pyodide versions, but KEEP the current
    // Pyodide cache across shell bumps (that's the whole point).
    await Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;                    // API POSTs etc.: network only
  const url = new URL(req.url);
  if (url.pathname.includes("/api/")) return;          // live backend only, never cached
  if (url.pathname.includes("/downloads/")) return;    // big installers: network only
  if (url.pathname.endsWith("/version.json")) return;  // update check: always the live version

  // Immutable Pyodide runtime: cache-first from the stable cache, NO refresh.
  if (url.pathname.includes("/pyodide/")) {
    e.respondWith((async () => {
      const cache = await caches.open(PYO_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req).catch(() => null);
      if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone()).catch(() => {});
      return res || new Response("offline", { status: 503 });
    })());
    return;
  }

  // App shell + engine .py + Leaflet: stale-while-revalidate from the shell cache
  // (instant + offline, refreshed in the background so updates land next launch).
  e.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match(req);
    const network = fetch(req).then((res) => {
      if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone()).catch(() => {});
      return res;
    }).catch(() => null);
    return cached || (await network) || new Response("offline", { status: 503 });
  })());
});
