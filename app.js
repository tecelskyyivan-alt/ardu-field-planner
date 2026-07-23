/* Field Mission Planner — frontend.
 * Leaflet satellite map + Leaflet.draw for the field polygon, talking to the
 * Python core through window.pywebview.api.
 */
(function () {
  "use strict";

  // The Qt desktop has a local Python server (build_route + drone link), so it
  // keeps using /api there. A real browser / installed PWA has no Python, so it
  // runs the planning engine (Pyodide) and the drone link (JS MAVLink) in-page.
  const IS_QT = /QtWebEngine/i.test(navigator.userAgent);
  // Native Android shell (the APK): full GCS, drone link over the USB bridge.
  const IS_ANDROID = typeof window !== "undefined" && !!window.AndroidSerial;
  // Native iOS shell (ios/): full GCS, drone link over the WiFi/UDP bridge (iOS has
  // no WebSerial/WebUSB, so USB-to-FC isn't possible — the backpack is the link).
  const IS_IOS = typeof window !== "undefined" &&
    (!!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.fmpUdp)
     || /FMPiOS/.test(navigator.userAgent || ""));
  // Visible build tag so you can confirm an update actually landed (the APK does
  // NOT auto-update — you must reinstall it; the PWA updates on reopen).
  const APP_VERSION = "2.5.81";
  // The deployed app on the VPS — used by the APK (different origin, native fetch)
  // to check for / download updates. The PWA/desktop use same-origin paths.
  const VPS_BASE = "";  // self-host: optional external server for logs/updates; empty = same-origin only

  // ---- i18n (UA / EN) -------------------------------------------------------
  // Ukrainian is the SOURCE language; `window.FMP_TR` (i18n.js) maps each UA string
  // to English. Static HTML is translated by walking the DOM on a language switch
  // (no per-element markup needed); dynamic strings are wrapped in t() at build time.
  const TR = (typeof window !== "undefined" && window.FMP_TR) ? window.FMP_TR : {};
  let LANG = "uk";
  try {
    const saved = localStorage.getItem("fmp_lang");
    LANG = saved === "en" || saved === "uk" ? saved
         : ((navigator.language || "").toLowerCase().startsWith("uk") ? "uk" : "uk");
  } catch (e) {}
  // Translate a dynamic (JS-built) user-facing string. UA in → EN out when LANG=en.
  function t(s) {
    if (LANG !== "en" || s == null) return s;
    const k = String(s);
    return Object.prototype.hasOwnProperty.call(TR, k) ? TR[k] : s;
  }
  // Walk the static DOM and swap UA↔EN by matching text/att/value against TR. The UA
  // original is cached on the node the first time so switching back restores exactly.
  function applyLangToDom(root) {
    const en = LANG === "en";
    const scope = root || document.getElementById("app") || document.body;
    if (!scope) return;
    // 1) text nodes
    const tw = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, null);
    const texts = []; let node;
    while ((node = tw.nextNode())) texts.push(node);
    for (const n of texts) {
      const el = n.parentElement;
      if (!el || el.closest("script,style,textarea")) continue;
      const src = n.__ua !== undefined ? n.__ua : n.nodeValue;
      const m = src.match(/^(\s*)([\s\S]*?)(\s*)$/);          // lead, core, trail
      const core = m[2].replace(/\s+/g, " ").trim();          // collapse to match TR keys
      if (!core || !Object.prototype.hasOwnProperty.call(TR, core)) continue;
      if (n.__ua === undefined) n.__ua = src;                 // cache original once
      n.nodeValue = en ? m[1] + TR[core] + m[3] : n.__ua;
    }
    // 2) attributes: placeholder, title, aria-label, value (buttons)
    const ATTRS = ["placeholder", "title", "aria-label"];
    scope.querySelectorAll("[placeholder],[title],[aria-label]").forEach((el) => {
      for (const a of ATTRS) {
        if (!el.hasAttribute(a)) continue;
        const cacheKey = "__ua_" + a;
        if (el[cacheKey] === undefined) {
          const v = el.getAttribute(a).trim();
          if (!Object.prototype.hasOwnProperty.call(TR, v)) continue;
          el[cacheKey] = el.getAttribute(a);
        }
        const orig = el[cacheKey], key = orig.trim();
        if (Object.prototype.hasOwnProperty.call(TR, key))
          el.setAttribute(a, en ? orig.replace(key, TR[key]) : orig);
      }
    });
  }
  function setLang(lang, opts) {
    LANG = lang === "en" ? "en" : "uk";
    try { localStorage.setItem("fmp_lang", LANG); } catch (e) {}
    document.documentElement.setAttribute("lang", LANG);
    applyLangToDom();
    const btn = document.getElementById("lang-toggle");
    if (btn) btn.textContent = LANG === "en" ? "UA" : "EN";   // shows the OTHER language
    if (!(opts && opts.silent) && typeof rerenderDynamic === "function") { try { rerenderDynamic(); } catch (e) {} }
  }

  // ---- diagnostic log -------------------------------------------------------
  // A rolling in-memory log of connection / telemetry / mission / error events,
  // persisted to localStorage so a crash or a bad field session can still be
  // exported and analysed afterwards. The «Лог для аналізу» button packages it.
  const LOG = [];
  let _logDirty = false;
  // Count problems (JS errors / promise rejects / console.error) since the last
  // successful remote upload, so the native shells can auto-send the log when a
  // real problem happens during a field session (see maybeAutoUploadLog below).
  let _errSinceUpload = 0;
  function appLog(s) {
    let t; try { t = new Date().toISOString().slice(11, 23); } catch (e) { t = ""; }
    LOG.push(t + " " + s);
    if (LOG.length > 1500) LOG.shift();
    _logDirty = true;
  }
  try {
    const prev = localStorage.getItem("fmp_log");
    if (prev) { LOG.push("=== попередня сесія ==="); for (const l of prev.split("\n").slice(-400)) if (l) LOG.push(l); LOG.push("=== нова сесія ==="); }
  } catch (e) {}
  function flushLog() { if (_logDirty) { try { localStorage.setItem("fmp_log", LOG.slice(-1000).join("\n")); } catch (e) {} _logDirty = false; } }
  setInterval(flushLog, 10000);   // slower cadence (#6) — background/kill flush (visibilitychange/beforeunload) covers the tail
  if (typeof window !== "undefined") {
    // Full stack traces (not just message@file:line) so an uploaded log pinpoints
    // the exact failing call — the single most useful thing for remote diagnosis.
    const _stackOf = (o) => (o && o.stack) ? " | " + String(o.stack).replace(/\s+/g, " ").slice(0, 500) : "";
    window.addEventListener("error", (e) => {
      _errSinceUpload++;
      appLog("JS ERROR: " + ((e && e.message) || e) + " @ " + ((e && e.filename) || "")
        + ":" + ((e && e.lineno) || "") + ":" + ((e && e.colno) || "") + _stackOf(e && e.error));
    });
    window.addEventListener("unhandledrejection", (e) => {
      _errSinceUpload++;
      const r = e && e.reason;
      appLog("PROMISE REJECT: " + ((r && r.message) || r || "") + _stackOf(r));
    });
    // Mirror console.error / console.warn into the diagnostic log, so errors from
    // libraries (Leaflet, MAVLink) and explicit console.error(...) calls (e.g. an
    // engine failure) are captured — previously they were lost, leaving the log
    // silent about the actual problem. Capped per line; the original still prints.
    ["error", "warn"].forEach((lvl) => {
      const orig = console[lvl] ? console[lvl].bind(console) : null;
      if (!orig) return;
      console[lvl] = function () {
        try {
          if (lvl === "error") _errSinceUpload++;
          const parts = Array.prototype.map.call(arguments, (a) =>
            (a && a.stack) ? String(a.stack)
              : (a && typeof a === "object") ? (function () { try { return JSON.stringify(a); } catch (e) { return String(a); } })()
              : String(a));
          appLog("CONSOLE." + lvl.toUpperCase() + ": " + parts.join(" ").replace(/\s+/g, " ").slice(0, 500));
        } catch (e) {}
        orig.apply(console, arguments);
      };
    });
    // The Pyodide engine (engine.js) reports its boot stages/failures here, so an
    // uploaded log shows EXACTLY where the offline engine failed on a device.
    window.FMP_ENGINE_LOG = appLog;
  }
  appLog("start " + APP_VERSION + (IS_ANDROID ? " APK" : IS_IOS ? " iOS" : IS_QT ? " Qt" : " web") + " ua=" + (navigator.userAgent || "").slice(0, 70));

  // ---- map ----------------------------------------------------------------
  // Start over a farmland-rich area (well mapped in OSM) so the auto-contour
  // works on the first click; pan anywhere you like.
  // worldCopyJump + maxBounds keep ONE world only (no infinite repeated copies
  // of the field/route/drone when you zoom out). minZoom 3 stops zooming out so
  // far the globe tiles.
  const map = L.map("map", {
    zoomControl: true, worldCopyJump: true, minZoom: 3,
    // preferCanvas: render the route / markers / exclusions on a CANVAS instead of
    // SVG — far smoother zoom/pan (SVG re-rendering every frame was the jerk).
    preferCanvas: true,
    // Canvas renderer at the DEFAULT small padding (0.1): a bigger padding (tried 0.5)
    // makes the canvas ~4× the viewport area → far MORE pixels to clear+redraw every
    // frame, which LAGGED phones instead of helping. `tolerance` widens touch hit-testing
    // so taps on thin lines/markers still register easily.
    renderer: L.canvas({ padding: 0.1, tolerance: 8 }),
    // Skip the zoom animation for big jumps (>2 levels) — the tween of a canvas full
    // of vectors is where the stutter shows on weaker phones.
    zoomAnimationThreshold: 2,
    // fadeAnimation off: the per-tile fade-in (×2 stacked layers: satellite + the
    // labels overlay) reads as "map blinking" on weak/hybrid-GPU compositing (the
    // Optimus laptop). Tiles just appear — snappier and no flicker.
    fadeAnimation: false,
    // Soft bounds (viscosity 0) instead of hard (1.0): the hard bounds fought the
    // user on zoom-out and felt like stutter.
    maxBounds: [[-85, -180], [85, 180]], maxBoundsViscosity: 0.0,
  });
  // On entry, open showing the WHOLE of Ukraine (Ivan's request) — fitBounds adapts
  // the zoom to the screen (phone or desktop) so the whole country is always visible.
  map.fitBounds([[44.0, 22.0], [52.5, 40.4]]);
  { const _av = document.getElementById("app-ver");
    if (_av) {
      _av.textContent = "v" + APP_VERSION + (IS_ANDROID ? " APK" : IS_IOS ? " iOS" : IS_QT ? " ПК" : " web");
      // Tap the version (visible on every platform, incl. the APK where the «Додаток»
      // tab is hidden) to check the server for an update.
      _av.title = "Перевірити оновлення";
      _av.style.cursor = "pointer";
      _av.addEventListener("click", () => checkUpdate());
    } }
  // Version chip in the Plan tab too, so the running build is visible at a glance
  // (lets the user confirm an update actually landed). Tap = check for updates.
  { const _pv = document.getElementById("plan-ver");
    if (_pv) {
      _pv.textContent = "v" + APP_VERSION;
      _pv.style.cursor = "pointer";
      _pv.addEventListener("click", () => checkUpdate());
    } }
  // Language toggle (UA / EN) — see i18n.js. The button shows the OTHER language.
  { const _lt = document.getElementById("lang-toggle");
    if (_lt) _lt.addEventListener("click", () => setLang(LANG === "en" ? "uk" : "en")); }
  setLang(LANG, { silent: true });   // apply saved/default language + set the button label

  // Base layers --------------------------------------------------------------
  // maxNativeZoom = last zoom with real tiles; beyond it Leaflet upscales them
  // (blurry but visible) instead of showing blank.
  // On the Qt DESKTOP (no service worker → no browser tile cache) the tiles go
  // through serve.py's same-origin /tiles/<provider>/ proxy, which caches them to
  // disk so the map works offline. Everywhere else (PWA/APK) we hit the CDN direct
  // (the PWA's service worker caches them). Same provider, two delivery paths.
  const TILE_URLS = IS_QT ? {
    esri: "/tiles/esri/{z}/{x}/{y}",
    esrilabels: "/tiles/esrilabels/{z}/{x}/{y}",
    google: "/tiles/google/{z}/{x}/{y}",
    carto: "/tiles/carto/{z}/{x}/{y}",
    topo: "/tiles/topo/{z}/{x}/{y}",
  } : {
    esri: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    esrilabels: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
    google: "https://{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
    carto: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    topo: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
  };
  // Mobile-smoothness tile options on EVERY base layer: don't fetch+decode tiles
  // mid-drag/zoom — wait until the gesture SETTLES (updateWhenIdle) — and keep a small
  // off-screen buffer so a short pan doesn't blank. This is the main pan-lag fix: the
  // default was loading tiles every frame during a drag, which janks on phones.
  const TP = { updateWhenIdle: true, updateWhenZooming: false, keepBuffer: 2 };
  const esriSat = L.tileLayer(TILE_URLS.esri,
    { ...TP, maxZoom: 21, maxNativeZoom: 19, noWrap: true, attribution: "Esri World Imagery" }
  );
  // Transparent reference overlay: city/country names, admin borders, roads.
  const esriLabels = L.tileLayer(TILE_URLS.esrilabels,
    { ...TP, maxZoom: 21, maxNativeZoom: 19, noWrap: true }
  );
  // Google satellite — a different capture; helps where Esri is cloudy.
  const googleSat = L.tileLayer(TILE_URLS.google,
    { ...TP, subdomains: ["mt0", "mt1", "mt2", "mt3"], maxZoom: 21, maxNativeZoom: 20, noWrap: true, attribution: "© Google" }
  );
  // Google-like labelled street map.
  const streets = L.tileLayer(TILE_URLS.carto,
    { ...TP, maxZoom: 21, maxNativeZoom: 19, noWrap: true, attribution: "© OpenStreetMap, © CARTO" }
  );
  // Relief / elevation basemap (OpenTopoMap): contour lines + hillshade — a real
  // «height map» selectable like the other bases (Ivan). maxNativeZoom 17 (upscales
  // beyond). Cached offline the same way as the other tiles.
  const topoRelief = L.tileLayer(TILE_URLS.topo,
    { ...TP, subdomains: ["a", "b", "c"], maxZoom: 21, maxNativeZoom: 17, noWrap: true,
      attribution: "© OpenTopoMap (CC-BY-SA)" }
  );
  // «Висоти поля» is an OVERLAY toggle (NOT a base layer): turning it on marks the
  // field's highest / lowest contour points + the relief ON TOP of the current
  // (satellite) map — the base map never changes. The layer itself is empty; it's
  // purely the on/off switch (its add/remove drives the elevation query + markers).
  const elevOverlay = L.layerGroup();
  // Default = Google satellite + names: deeper high-zoom coverage of Ukraine
  // (Esri shows "Map data not yet available" past z17-18 in rural areas).
  // DEFAULT = Google hybrid (lyrs=y): satellite WITH names/roads baked into ONE tile
  // layer, instead of stacking a separate labels overlay. Halving the tile layers is
  // the biggest pan-smoothness win on phones (was 2 layers rendered every frame).
  const hybrid = googleSat.addTo(map);
  const esriHybrid = L.layerGroup([esriSat, esriLabels]);

  L.control.layers(
    {
      "Супутник + назви (Google)": hybrid,
      "Esri супутник + назви": esriHybrid,
      "Схема (назви)": streets,
      "Карта висот (рельєф)": topoRelief,
    },
    // «Висоти поля» — an OVERLAY toggle so it shows ON the satellite (doesn't replace it).
    { "Висоти поля (макс · мін · перепад)": elevOverlay },
    // Collapsed (a small icon) on phones so it doesn't cover half the map;
    // expanded on desktop where there's room.
    { position: "topright", collapsed: window.innerWidth <= 760 }
  ).addTo(map);

  // «Моє місце» button ON THE MAP toolbar (top-left, under the zoom control) — a
  // standard locate control (Ivan moved it off the panel). Toggles the live blue
  // dot. Calls toggleMyLocation() (defined with the geolocation code below — a
  // hoisted function, so it resolves at click time).
  let _locateBtn = null;
  const LocateControl = L.Control.extend({
    options: { position: "topleft" },
    onAdd: function () {
      const div = L.DomUtil.create("div", "leaflet-bar leaflet-control locate-ctl");
      const a = L.DomUtil.create("a", "", div);
      a.href = "#"; a.title = "Моє місце (наживо)"; a.setAttribute("role", "button");
      a.innerHTML = '<svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/></svg>';
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.on(a, "click", function (e) { L.DomEvent.stop(e); toggleMyLocation(); });
      _locateBtn = a;
      return div;
    },
  });
  map.addControl(new LocateControl());

  // «Стежити за дроном» toolbar button next to «Моє місце» (moved off the Flight
  // panel). Drives the hidden #mav-follow checkbox, so its wiring (mavFollow +
  // session persistence) is unchanged. `.active` = accent highlight when following.
  let _followBtn = null;
  const FollowControl = L.Control.extend({
    options: { position: "topleft" },
    onAdd: function () {
      const div = L.DomUtil.create("div", "leaflet-bar leaflet-control follow-ctl");
      const a = L.DomUtil.create("a", "", div);
      a.href = "#"; a.title = "Стежити за дроном"; a.setAttribute("role", "button");
      a.innerHTML = '<svg class="ic" viewBox="0 0 24 24"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/><circle cx="12" cy="12" r="2.2"/></svg>';
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.on(a, "click", function (e) { L.DomEvent.stop(e); toggleFollow(); });
      _followBtn = a;
      return div;
    },
  });
  map.addControl(new FollowControl());
  function syncFollowBtn() { if (_followBtn) _followBtn.classList.toggle("active", !!mavFollow); }
  function setFollow(v) {
    const cb = $("mav-follow");
    if (cb) { if (cb.checked !== !!v) { cb.checked = !!v; cb.dispatchEvent(new Event("change")); } }
    else { mavFollow = !!v; }
    syncFollowBtn();
  }
  function toggleFollow() { setFollow(!mavFollow); }

  // ---- on-map telemetry overlay toggle (#11) — top-left, below the follow button ----
  let mavOverlayOn = true, _overlayBtn = null;
  const OverlayControl = L.Control.extend({
    options: { position: "topleft" },
    onAdd: function () {
      const div = L.DomUtil.create("div", "leaflet-bar leaflet-control overlay-ctl");
      const a = L.DomUtil.create("a", "", div);
      a.href = "#"; a.title = "Телеметрія на карті"; a.setAttribute("role", "button");
      a.innerHTML = '<svg class="ic" viewBox="0 0 24 24"><path d="M3 5h18M3 12h13M3 19h9"/></svg>';
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.on(a, "click", function (e) { L.DomEvent.stop(e); toggleOverlay(); });
      _overlayBtn = a;
      return div;
    },
  });
  map.addControl(new OverlayControl());
  function syncOverlayBtn() { if (_overlayBtn) _overlayBtn.classList.toggle("active", !!mavOverlayOn); }
  function setOverlay(v) {
    mavOverlayOn = !!v; sessionPatch({ overlay: mavOverlayOn }); syncOverlayBtn();
    if (_overlay && (!mavOverlayOn || !mavConnected)) _overlay.card.classList.add("hidden");
  }
  function toggleOverlay() { setOverlay(!mavOverlayOn); }
  syncOverlayBtn();

  // User grabs the map to look around → stop following (re-enable via the button).
  map.on("dragstart", function () { if (mavFollow) setFollow(false); });

  // ---- Elevation map: highest / lowest point of the field contour -------------
  // Selecting «Карта висот» shows a relief basemap; if a field is drawn it queries
  // the elevation of points sampled ALONG THE CONTOUR (Open-Meteo — free, no key)
  // and marks the highest and lowest points, so the field's slope is obvious.
  let elevActive = false;
  let elevMarkers = null;
  let elevBadge = null;
  // A small PERSISTENT on-map badge with the relief — stays while the «Карта висот»
  // layer is on (unlike the #msg line, which fades): highest · мін lowest · перепад.
  function setElevBadge(html) {
    if (html == null) { if (elevBadge) elevBadge.style.display = "none"; return; }
    if (!elevBadge) {
      elevBadge = L.DomUtil.create("div", "elev-badge", map.getContainer());
      L.DomEvent.disableClickPropagation(elevBadge);
    }
    elevBadge.innerHTML = html;
    elevBadge.style.display = "flex";
  }
  function clearElevExtremes() {
    if (elevMarkers) { map.removeLayer(elevMarkers); elevMarkers = null; }
    setElevBadge(null);
  }
  // Sample points evenly ALONG the contour edges (densify) up to ~90 pts (Open-Meteo
  // batch limit is 100) so min/max isn't limited to the few drawn vertices.
  function sampleContour(boundary, want) {
    const ring = boundary.slice();
    const f = ring[0], l = ring[ring.length - 1];
    if (f.lat !== l.lat || f.lng !== l.lng) ring.push(f);     // close the ring
    const segs = []; let total = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const a = ring[i], b = ring[i + 1];
      const dx = (b.lng - a.lng) * Math.cos(a.lat * Math.PI / 180) * 111320;
      const dy = (b.lat - a.lat) * 111320;
      const len = Math.hypot(dx, dy);
      segs.push({ a, b, len }); total += len;
    }
    if (total <= 0) return [f];
    const n = Math.max(4, Math.min(want, 90));
    const pts = [];
    for (const s of segs) {
      const k = Math.max(1, Math.round(n * (s.len / total)));
      for (let j = 0; j < k; j++) {
        const t = j / k;
        pts.push({ lat: s.a.lat + (s.b.lat - s.a.lat) * t, lng: s.a.lng + (s.b.lng - s.a.lng) * t });
      }
    }
    return pts.length ? pts : [f];
  }
  async function showElevExtremes() {
    clearElevExtremes();
    const boundary = boundaryFromPolygon();
    if (!boundary || boundary.length < 3) {
      setMsg("Намалюй контур поля — тоді на «Карті висот» з'являться найвища й найнижча точки.", null);
      return;
    }
    const pts = sampleContour(boundary, 80);
    setMsg("Рахую висоти точок контуру…", null);
    // Also fetch MY ground elevation (Ivan) — live position if «Моє місце» is on,
    // else a one-shot fix — so the badge can show my height + Δ to the field's max.
    let me = myPosition;
    if (!me && navigator.geolocation) {
      me = await new Promise((res) => navigator.geolocation.getCurrentPosition(
        (p) => res({ lat: p.coords.latitude, lng: p.coords.longitude }),
        () => res(null), { enableHighAccuracy: false, timeout: 7000, maximumAge: 120000 }));
    }
    try {
      const q = (me ? [me] : []).concat(pts);   // my point rides in the same batch request
      const lat = q.map((p) => p.lat.toFixed(6)).join(",");
      const lon = q.map((p) => p.lng.toFixed(6)).join(",");
      const res = await fetch("https://api.open-meteo.com/v1/elevation?latitude=" + lat + "&longitude=" + lon);
      const j = await res.json();
      const all = j && j.elevation;
      if (!all || !all.length) { setMsg("Не вдалося отримати висоти (потрібен інтернет).", "error"); return; }
      if (!elevActive) return;     // user switched layers while the request was in flight
      const myElev = me ? all[0] : null;
      const e = me ? all.slice(1) : all;
      if (!e.length) { setMsg("Не вдалося отримати висоти.", "error"); return; }
      let hi = 0, lo = 0;
      for (let i = 1; i < e.length; i++) { if (e[i] > e[hi]) hi = i; if (e[i] < e[lo]) lo = i; }
      const mk = (p, v, kind, tip) => L.marker([p.lat, p.lng], {
        keyboard: false, zIndexOffset: 1200,
        icon: L.divIcon({ className: "elev-marker " + kind,
          html: (kind === "hi" ? "макс " : kind === "lo" ? "мін " : "я ") + Math.round(v) + " м",
          iconSize: [80, 26], iconAnchor: [40, 13] }),
      }).bindTooltip(tip);
      // Only the field's highest/lowest markers on the map. NOT a «me» marker at your
      // own position — it sat under the live blue «my location» dot and got covered
      // (Ivan). Your elevation is shown in the badge («моя …») instead.
      const layers = [mk(pts[hi], e[hi], "hi", "Найвища точка контуру"),
                      mk(pts[lo], e[lo], "lo", "Найнижча точка контуру")];
      elevMarkers = L.layerGroup(layers).addTo(map);
      const dz = Math.round(e[hi] - e[lo]);
      let badge = `<div class="eb-row"><span class="hi"><span class="eb-k">макс</span> ${Math.round(e[hi])}</span>`
        + `<span class="lo"><span class="eb-k">мін</span> ${Math.round(e[lo])}</span>`
        + `<span class="dz">Δ <b>${dz} м</b></span></div>`;
      let msg = `Висоти поля: макс ${Math.round(e[hi])} · мін ${Math.round(e[lo])} · Δ ${dz} м`;
      if (me && myElev != null) {
        const dMy = Math.round(myElev - e[hi]);
        const sMy = (dMy >= 0 ? "+" : "") + dMy;
        badge += `<div class="eb-row"><span class="me"><span class="eb-k">я</span> ${Math.round(myElev)} м</span>`
          + `<span class="dz">до макс <b>${sMy} м</b></span></div>`;
        msg += ` · моя ${Math.round(myElev)} м · до макс ${sMy} м`;
      } else {
        msg += " · увімкни «Моє місце» для своєї висоти";
      }
      setElevBadge(badge);
      setMsg(msg + ".", "ok");
    } catch (err) {
      setMsg("Не вдалося отримати висоти (потрібен інтернет).", "error");
    }
  }
  map.on("overlayadd", (ev) => { if (ev.layer === elevOverlay) { elevActive = true; showElevExtremes(); } });
  map.on("overlayremove", (ev) => { if (ev.layer === elevOverlay) { elevActive = false; clearElevExtremes(); } });

  // ALL drawn geometry lives in ONE FeatureGroup so the native Leaflet.draw edit
  // (pencil = drag every vertex) and delete (trash = click each to remove) toolbars
  // operate on the field + exclusions + split lines together. Each layer is tagged
  // `_k`: "field" | "excl" | "split". Logical accessors below filter by tag.
  const drawnItems = new L.FeatureGroup().addTo(map);
  function exclLayers() { const o = []; drawnItems.eachLayer((l) => { if (l._k === "excl") o.push(l); }); return o; }
  function splitLayers() { const o = []; drawnItems.eachLayer((l) => { if (l._k === "split") o.push(l); }); return o; }
  function removeByKind(k) { drawnItems.eachLayer((l) => { if (l._k === k) drawnItems.removeLayer(l); }); }
  // Back-compat shim: a few call sites still say exclusionItems.* — map those onto
  // the tagged layers in drawnItems so nothing else has to change.
  const exclusionItems = {
    addLayer: (l) => { l._k = "excl"; drawnItems.addLayer(l); },
    removeLayer: (l) => drawnItems.removeLayer(l),
    getLayers: () => exclLayers(),
    eachLayer: (fn) => exclLayers().forEach(fn),
    clearLayers: () => removeByKind("excl"),
  };
  let drawingExclusion = false;       // next CREATED polygon is an exclusion
  let exclusionEditMode = false;      // vertex-editing exclusions (like the contour)
  let routeLayer = null;
  let routeMarkers = null;        // start/finish dots (FeatureGroup)
  let homeMarker = null;
  let insetLayer = null;
  let parcelsLayer = null;
  let fieldPolygon = null;
  let startMode = false;          // next click picks where the coverage route begins
  let startPoint = null;          // {lat,lng} chosen mission start
  let startMarker = null;         // green "S" marker for the start point
  function nativeEditActive() {
    try { return !!(drawControl._toolbars.edit && drawControl._toolbars.edit._activeMode); }
    catch (e) { return false; }
  }
  let sectorsLayer = null;        // rendered sector sub-polygons
  let coverageLayer = null;       // sprayed-swath fill (spray footprint overlay)
  let overlapLayer = null;        // double-sprayed area (drawn over the swath)
  let gapLayer = null;            // unsprayed gaps between passes (#9)
  let transitLayer = null;        // safe ingress/egress detour legs (#12, viz only)

  const drawControl = new L.Control.Draw({
    draw: {
      polygon: { allowIntersection: false, showArea: true,
                 shapeOptions: { color: "#2d7ff9", weight: 2 } },
      polyline: false,               // sector-split line removed (Ivan) — polygon-only toolbar
      rectangle: false, circle: false,
      marker: false, circlemarker: false,
    },
    edit: { featureGroup: drawnItems, remove: true },
  });
  map.addControl(drawControl);

  // A SECOND tap on an active toolbar tool FINISHES its task (Ivan) — no hunting for
  // the tiny «Фініш» in the action bar. Draw: complete the polygon. Edit: save the
  // vertex drags. Delete: apply the marked deletions. Capture-phase so we intercept
  // BEFORE Leaflet's own handler re-toggles the tool.
  (function wireToolbarFinish() {
    const bar = document.querySelector(".leaflet-draw");
    if (!bar) return;
    bar.addEventListener("click", (e) => {
      const a = e.target.closest("a"); if (!a) return;
      const cls = a.className || "";
      try {
        if (/leaflet-draw-draw-/.test(cls)) {
          const h = drawControl._toolbars.draw && drawControl._toolbars.draw._activeMode
                 && drawControl._toolbars.draw._activeMode.handler;
          if (h && h.enabled && h.enabled()) {
            e.preventDefault(); e.stopPropagation();
            const n = (h._markers && h._markers.length) || 0;
            const min = (h.type === "polyline") ? 2 : 3;
            if (n >= min && h.completeShape) h.completeShape();   // finish → CREATED fires
            else if (h.disable) h.disable();                       // too few points → cancel
          }
        } else if (/leaflet-draw-edit-/.test(cls)) {
          const em = drawControl._toolbars.edit && drawControl._toolbars.edit._activeMode;
          const h = em && em.handler;
          if (h && h.enabled && h.enabled()) {
            e.preventDefault(); e.stopPropagation();
            if (h.save) h.save();
            if (h.disable) h.disable();
          }
        }
      } catch (err) { /* ignore */ }
    }, true);
  })();

  // All drawing goes through the SAME Leaflet.draw toolbar handlers as the field
  // contour (proven reliable), disambiguated by shape: a POLYLINE is always a
  // sector-split line; a POLYGON is an exclusion when in that mode, else the field.
  map.on(L.Draw.Event.CREATED, (e) => {
    // A marker or polyline is ALWAYS a hazard (the toolbar is polygon-only; these types are used
    // nowhere else) → never falls through to field/exclusion adoption.
    if (e.layerType === "polyline" && cutDrawing) {   // ЛЕП-виріз вручну (ТЗ Івана)
      makeManualCut(e.layer);
      return;
    }
    if (e.layerType === "marker" || e.layerType === "polyline") {
      const kind = e.layerType === "marker" ? "pole" : "line";
      addHazardFromLayer(e.layer, kind); hazardMode = null; _hazHandler = null;
      setMsg(kind === "pole" ? "Стовп додано." : "ЛЕП додано.", "ok");
      return;
    }
    // Only treat a polygon as an exclusion when a field already exists — so an
    // auto-finished first polygon (with a stale drawingExclusion flag) is always
    // adopted as the CONTOUR, never silently turned into an exclusion. (bug-hunt #5)
    if (drawingExclusion && fieldPolygon) {
      drawingExclusion = false;
      addExclusionLayer(e.layer);
      clearRoute();
      setMsg("Виріз додано.", "ok");
      return;
    }
    adoptField(e.layer);
    currentFieldName = "";        // a freshly-drawn contour is a NEW unnamed field → mint a name on
                                  // upload, never UPSERT over the previously-loaded field's record
    setMsg("Контур поля задано.", "ok");
  });
  // Reset the "next polygon is an exclusion" flag whenever a draw ends (finish or
  // cancel), so a cancelled "Додати виріз" can't turn the next field into a cutout.
  map.on(L.Draw.Event.DRAWSTOP, () => { drawingExclusion = false; hazardMode = null; _hazHandler = null; cutDrawing = false; });

  // ---- Контур / Виріз chooser INJECTED into the Leaflet.draw action bar, right
  // beside «Фініш / Видалити останню точку / Скасувати», in the SAME toolbar style
  // (Ivan's request). The polygon tool draws the CONTOUR by default; pick «Виріз» to
  // cut an obstacle. Sets `drawingExclusion`, read by the CREATED handler.
  function visibleDrawActions() {
    return [...document.querySelectorAll(".leaflet-draw-actions")]
      .find((a) => getComputedStyle(a).display !== "none");
  }
  function syncDrawChooser() {
    const acts = visibleDrawActions();
    if (!acts) return;
    acts.querySelectorAll(".dc-a").forEach((a) =>
      a.classList.toggle("dc-on", (a.dataset.k === "excl") === drawingExclusion));
  }
  function injectDrawChooser() {
    const acts = visibleDrawActions();
    if (!acts || acts.querySelector(".dc-li")) { syncDrawChooser(); return; }
    const mk = (k, label) => {
      const li = document.createElement("li"); li.className = "dc-li";
      const a = document.createElement("a");
      a.href = "#"; a.className = "dc-a"; a.dataset.k = k; a.textContent = label;
      L.DomEvent.on(a, "click", (e) => {
        L.DomEvent.stop(e);
        drawingExclusion = (k === "excl");
        syncDrawChooser();
        setMsg(drawingExclusion ? "Малюєш ВИРІЗ-перешкоду." : "Малюєш КОНТУР поля.", null);
      });
      // Contain EVERY pointer/touch event so tapping the chooser never falls through to
      // the map and drops a polygon vertex behind the button (mobile bug, Ivan).
      L.DomEvent.disableClickPropagation(li);
      L.DomEvent.on(li, "mousedown mouseup touchstart touchend pointerdown pointerup dblclick",
        L.DomEvent.stopPropagation);
      li.appendChild(a); return li;
    };
    acts.insertBefore(mk("excl", "Виріз"), acts.firstChild);
    acts.insertBefore(mk("field", "Контур"), acts.firstChild);
    syncDrawChooser();
  }
  map.on(L.Draw.Event.DRAWSTART, (e) => {
    if (e.layerType !== "polygon") return;
    setTimeout(injectDrawChooser, 0);   // Leaflet.draw (re)builds its actions on start
  });

  // Add a polygon as an obstacle exclusion (red, click-to-delete).
  function addExclusionLayer(layer) {
    if (layer.setStyle) {
      layer.setStyle({ color: "#ff4d4d", weight: 2, fillOpacity: 0.2, dashArray: "4 4" });
    }
    layer.bindTooltip("Виріз — клікни, щоб видалити (або «Редагувати вирізи» для вузлів)");
    layer.on("click", () => {
      // In ANY editing mode (custom exclusion-edit OR the native Leaflet.draw
      // edit/delete toolbar) the click belongs to that tool — don't quick-delete.
      if (exclusionEditMode || nativeEditActive()) return;
      exclusionItems.removeLayer(layer);
      clearRoute();
      scheduleSaveField();
      setMsg("Виріз видалено.", null);
    });
    exclusionItems.addLayer(layer);
    if (exclusionEditMode && layer.editing) layer.editing.enable();   // stay editable
    scheduleSaveField();
  }

  // Enable the SAME Leaflet.draw toolbar handler the field contour uses (the
  // reliable path) — direct `new L.Draw.*(map,...)` was flaky on some devices.
  function enableToolbarDraw(type) {                  // 'polygon' | 'polyline'
    try {
      const m = drawControl._toolbars.draw._modes[type];
      if (m && m.handler) { m.handler.enable(); return true; }
    } catch (e) { /* fall back below */ }
    try {
      const opt = (drawControl.options.draw || {})[type] || {};
      new L.Draw[type === "polyline" ? "Polyline" : "Polygon"](map, opt).enable();
      return true;
    } catch (e) { return false; }
  }
  function cancelToolbarDraw() {
    try {
      const ms = drawControl._toolbars.draw._modes;
      ["polygon", "polyline"].forEach((t) => {
        const h = ms[t] && ms[t].handler;
        if (h && h.enabled && h.enabled()) h.disable();
      });
    } catch (e) { /* ignore */ }
  }
  // Auto-FINISH an in-progress drawing/edit before a major action (Build, Upload,
  // Export) so a forgotten «Фініш» can't leave a half-drawn contour out of the plan
  // (Ivan: "кнопка фініш має натискатися сама"). A shape with too few points is cancelled.
  function commitActiveDraw() {
    try {
      const dm = drawControl._toolbars.draw._activeMode;
      if (dm && dm.handler) {
        const h = dm.handler;
        const n = (h._markers && h._markers.length) || 0;
        const min = (h.type === "polyline") ? 2 : 3;
        if (n >= min && h.completeShape) h.completeShape();   // auto-«Фініш» → CREATED fires
        else if (h.disable) h.disable();                       // too few points → cancel
      }
      const eb = drawControl._toolbars.edit;
      const em = eb && eb._activeMode;
      if (em && em.handler) {
        // EDIT (vertex drag) → save the geometry. DELETE (trash) → REVERT: never
        // commit deletions the user only MARKED but didn't confirm (bug-hunt #4).
        if (L.EditToolbar && L.EditToolbar.Delete && em.handler instanceof L.EditToolbar.Delete) {
          if (em.handler.revertLayers) em.handler.revertLayers();
        } else if (em.handler.save) {
          em.handler.save();
        }
        if (em.handler.disable) em.handler.disable();
      }
    } catch (e) { /* ignore */ }
  }

  // Draw an obstacle exclusion via the toolbar polygon tool (same as the contour).
  function startExclusionDraw() {
    drawingExclusion = true;
    enableToolbarDraw("polygon");
    setMsg("Намалюй полігон-перешкоду на карті (вирізається з покриття).", null);
  }

  // Toggle vertex-editing of exclusion polygons — same drag-the-nodes editing as
  // the field contour, via Leaflet.draw's per-layer editing handler.
  function setExclusionEdit(on) {
    exclusionEditMode = on;
    const btn = $("edit-exclusions");
    if (btn) {
      btn.classList.toggle("active", on);
      btn.textContent = on ? t("ГОТОВО — зберегти вузли") : t("Редагувати вирізи");
    }
    let n = 0;
    exclusionItems.eachLayer((layer) => {
      if (!layer.editing) return;
      if (on) { layer.editing.enable(); n++; } else { layer.editing.disable(); }
    });
    if (on) {
      setMsg(n ? "Тягни вузли вирізів. Натисни «ГОТОВО» коли завершиш."
               : "Спершу додай виріз (), потім редагуй вузли.", null);
    } else {
      clearRoute();                       // geometry changed -> mission stale
      setMsg("Вирізи оновлено.", "ok");
    }
  }

  // Collect exclusion polygons as [[{lat,lng}…], …] for the backend.
  function collectExclusions() {
    const out = [];
    exclusionItems.eachLayer((layer) => {
      let ll = layer.getLatLngs();
      while (Array.isArray(ll) && ll.length && Array.isArray(ll[0])) ll = ll[0];
      if (ll.length >= 3) out.push(ll.map((p) => ({ lat: p.lat, lng: p.lng })));
    });
    return out;
  }

  // ---- hazards (#13): manual pole / power-line markers the route (and #12 transit/fence) avoids ----
  let hazardMode = null;      // 'pole' | 'line' while a hazard is being drawn
  let _hazHandler = null;     // the active L.Draw.Marker/Polyline (so a new/abandoned one can be disabled)
  const HAZARD_LINE = "#ffb020", HAZARD_OSM = "#b06a2e";
  function hazardLayers() { const o = []; drawnItems.eachLayer((l) => { if (l._k === "hazard") o.push(l); }); return o; }
  const hazardItems = {
    addLayer: (l) => { l._k = "hazard"; drawnItems.addLayer(l); },
    clearLayers: () => removeByKind("hazard"),
    eachLayer: (fn) => hazardLayers().forEach(fn),
  };
  function hazardClearanceM() { return parseFloat(($("hazard-clearance") || {}).value) || 25; }
  function hazardStyle(m) {
    return m && m.source === "osm"
      ? { color: HAZARD_OSM, weight: 3, dashArray: "6 8", lineCap: "round" }
      : { color: HAZARD_LINE, weight: 4, dashArray: "1 8", lineCap: "round" };
  }
  function hazardPoleIcon(m) {
    const c = m.source === "osm" ? HAZARD_OSM : HAZARD_LINE;
    return L.divIcon({ className: "area-label hazard", iconSize: [20, 20], iconAnchor: [10, 10],
      html: '<span style="color:' + c + '"><svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg></span>' });
  }
  function _hzGeom(l, kind) {
    if (kind === "pole") { const ll = l.getLatLng(); return [{ lat: ll.lat, lng: ll.lng }]; }
    let ll = l.getLatLngs(); while (Array.isArray(ll) && ll.length && Array.isArray(ll[0])) ll = ll[0];
    return ll.map((p) => ({ lat: p.lat, lng: p.lng }));
  }
  function addHazardLayer(m) {
    let layer;
    if (m.kind === "pole") layer = L.marker([m.geom[0].lat, m.geom[0].lng], { icon: hazardPoleIcon(m), keyboard: false });
    else if (m.kind === "zone") layer = L.polygon(m.geom.map((p) => [p.lat, p.lng]),
      { color: "#d84315", weight: 2, dashArray: "4 6", fillColor: "#ff7043", fillOpacity: 0.12 });
    else layer = L.polyline(m.geom.map((p) => [p.lat, p.lng]), hazardStyle(m));
    layer._hz = m;
    layer.bindTooltip((m.kind === "pole" ? "Стовп" : m.kind === "zone"
        ? "Рельєф" + (m.dz != null ? " +" + m.dz + " м" : "") + " (карта висот ~90 м — перевір очима!)"
        : "ЛЕП") + (m.source === "osm" ? " (OSM — перевір очима!)" : "") + " — клікни, щоб видалити");
    layer.on("click", () => { if (nativeEditActive()) return; drawnItems.removeLayer(layer); clearRoute(); scheduleSaveField(); renderHazardList(); });
    hazardItems.addLayer(layer);
  }
  function addHazardFromLayer(layer, kind) {
    const geom = _hzGeom(layer, kind);
    if (kind === "line" && geom.length < 2) return;
    addHazardLayer({ kind, geom, source: "manual", avoid: true, osm: null });
    clearRoute(); scheduleSaveField(); renderHazardList();
  }
  function collectHazards() {
    return hazardLayers().map((l) => {
      const m = l._hz || {};
      return { kind: m.kind, geom: _hzGeom(l, m.kind), source: m.source || "manual", avoid: m.avoid !== false, osm: m.osm || null, dz: (m.dz != null ? m.dz : null) };
    });
  }
  // ClipperLib open-offset: pole (1 vertex) → circle, line → capsule, of half-width metres. These
  // polygons are fed to the route engine as extra exclusions (and to #12 transit/fence).
  function hazardCorridors(halfWidthM) {
    const C = window.ClipperLib;
    // Perf (verified finding): filter avoid===false layers OUT before the per-vertex _hzGeom
    // extraction, not after — collectHazards() extracts full geometry for EVERY hazard
    // (needed by its other callers: save/restore, the hazard-count list), but here only
    // avoid:true ones are ever used. After an OSM power-line import (up to 800 objects,
    // each possibly 100+ vertices, all avoid:false) buildRoute() runs this on EVERY live
    // angle-drag rebuild (~7 Hz) — skipping the extraction for the ones we'd throw away
    // anyway removes that allocation without changing which hazards end up in `hz` (same
    // avoid!==false && geom.length filter as before).
    const active = hazardLayers().filter((l) => (l._hz || {}).avoid !== false);   // same default as collectHazards()
    // Relief ZONES are already area polygons — no Clipper offset needed, pass their rings through.
    const zoneOut = [];
    active.forEach((l) => {
      const m = l._hz || {};
      if (m.kind === "zone") { const g = _hzGeom(l, "zone"); if (g.length >= 3) zoneOut.push(g); }
    });
    const hz = active
      .filter((l) => (l._hz || {}).kind !== "zone")
      .map((l) => ({ geom: _hzGeom(l, (l._hz || {}).kind) }))
      .filter((m) => m.geom && m.geom.length);
    if (!C || !hz.length || !(halfWidthM > 0)) { if (!C && hz.length) appLog("[hazard] ClipperLib відсутній — коридори уникання пропущено (небезпеки лишаються видимими)"); return zoneOut; }
    let la = 0, lo = 0, n = 0;
    hz.forEach((m) => m.geom.forEach((p) => { la += p.lat; lo += p.lng; n++; }));
    la /= n; lo /= n;
    const mlat = 111320, mlng = (111320 * Math.cos(la * Math.PI / 180)) || 1, SC = 100;
    const toClip = (g) => g.map((p) => ({ X: Math.round((p.lng - lo) * mlng * SC), Y: Math.round((p.lat - la) * mlat * SC) }));
    const toLL = (path) => path.map((pt) => ({ lng: lo + pt.X / SC / mlng, lat: la + pt.Y / SC / mlat }));
    const out = [];
    try {
      hz.forEach((m) => {
        const co = new C.ClipperOffset(2, 0.25 * SC);
        co.AddPath(toClip(m.geom), C.JoinType.jtRound, C.EndType.etOpenRound);   // round ends → point=circle, line=capsule
        const sol = new C.Paths(); co.Execute(sol, halfWidthM * SC);
        sol.forEach((path) => { if (path.length >= 3) out.push(toLL(path)); });
      });
    } catch (e) { appLog("[hazard] офсет коридору не вдався: " + e); return zoneOut; }
    return out.concat(zoneOut);
  }
  function startHazardDraw(kind) {
    cancelToolbarDraw();                                    // stop any active field/exclusion polygon draw
    if (_hazHandler) { try { _hazHandler.disable(); } catch (e) {} _hazHandler = null; }   // and any abandoned hazard draw
    hazardMode = kind;
    _hazHandler = kind === "pole" ? new L.Draw.Marker(map, {})
      : new L.Draw.Polyline(map, { shapeOptions: hazardStyle({ source: "manual" }) });
    _hazHandler.enable();
    setMsg(kind === "pole" ? "Постав стовп на карті." : "Малюй лінію ЛЕП (подвійний клік = кінець).", null);
  }
  function renderHazardList() {
    const host = $("hazard-list"); if (!host) return;
    const hz = collectHazards();
    const warn = $("hazard-osm-warn");
    if (warn) warn.style.display = hz.some((m) => m.source === "osm") ? "" : "none";
    if (!hz.length) { host.innerHTML = ""; return; }
    const poles = hz.filter((m) => m.kind === "pole").length;
    const zones = hz.filter((m) => m.kind === "zone").length;
    const lines = hz.length - poles - zones;
    host.innerHTML = `<div class="hz-sum">${tf("Небезпек: {0} (стовпів {1} · ліній {2} · рельєф {3})", hz.length, poles, lines, zones)}</div>`;
  }
  // EXPERIMENTAL OSM power-line import (Ivan asked «підтягнути ЛЕП для тесту»). NEVER authoritative:
  // a line missing from OSM = false "clear" = danger → imported as source:'osm', avoid:false (display
  // only, does NOT reroute the mission) with a permanent "verify with your eyes" warning.
  // (hazard-button wiring lives AFTER the `const $` declaration below — a top-level
  // `$(...)` call up here is a TemporalDeadZone ReferenceError that kills the whole
  // IIFE at boot: map renders, every later feature is dead. Field incident 2.5.72.)

  // Adopt a polygon layer (drawn or OSM-loaded) as the active field.
  function adoptField(layer) {
    if (editingContour) setContourEdit(false);   // off() the OLD polygon's edit listeners first (bug-hunt #2)
    removeByKind("field");          // replace only the OLD field — keep exclusions + split lines
    clearRoute();
    layer._k = "field";
    fieldPolygon = layer;
    drawnItems.addLayer(fieldPolygon);
    map.fitBounds(fieldPolygon.getBounds(), { padding: [40, 40] });
    const _eb = $("edit-contour"); if (_eb) _eb.disabled = false;
    if (elevActive) showElevExtremes();    // refresh highest/lowest if elevation map is on
    scheduleSaveField();                   // auto-save the contour so it's restored next open
    setFieldArea();                        // always-on «X.XX га» label centred in the field
    fieldPolygon.on("edit", setFieldArea); // live-update the area while editing vertices
  }

  // ---- LIVE field area label centred inside the contour (during draw + edit) -----
  function areaHa(latlngs) {
    try { return (L.GeometryUtil.geodesicArea(latlngs) / 1e4) || 0; } catch (e) { return 0; }
  }
  // Permanent area label that follows the current field; updated on adopt + every edit.
  let fieldAreaMarker = null;
  function setFieldArea() {
    if (!fieldPolygon) { if (fieldAreaMarker) { map.removeLayer(fieldAreaMarker); fieldAreaMarker = null; } return; }
    let ring; try { ring = fieldPolygon.getLatLngs()[0]; } catch (e) { return; }
    if (!ring || ring.length < 3) return;
    const ic = L.divIcon({ className: "area-label field",
      html: "<span>" + areaHa(ring).toFixed(2) + " га</span>", iconSize: [110, 24], iconAnchor: [55, 12] });
    const c = fieldPolygon.getBounds().getCenter();
    if (!fieldAreaMarker) fieldAreaMarker = L.marker(c, { interactive: false, keyboard: false, zIndexOffset: 500, icon: ic }).addTo(map);
    else { fieldAreaMarker.setLatLng(c); fieldAreaMarker.setIcon(ic); }
  }
  // Live area WHILE drawing a polygon (updates as each vertex is added).
  let drawAreaMarker = null;
  function clearDrawArea() { if (drawAreaMarker) { map.removeLayer(drawAreaMarker); drawAreaMarker = null; } }
  map.on(L.Draw.Event.DRAWVERTEX, () => {
    const dm = drawControl._toolbars.draw._activeMode;
    const h = dm && dm.handler;
    if (!h || h.type === "polyline") { clearDrawArea(); return; }   // area only for the polygon
    const ll = (h._markers || []).map((m) => m.getLatLng());
    if (ll.length < 3) { clearDrawArea(); return; }
    const ic = L.divIcon({ className: "area-label",
      html: "<span>" + areaHa(ll).toFixed(2) + " га</span>", iconSize: [96, 22], iconAnchor: [48, 11] });
    const c = L.latLngBounds(ll).getCenter();
    if (!drawAreaMarker) drawAreaMarker = L.marker(c, { interactive: false, keyboard: false, zIndexOffset: 600, icon: ic }).addTo(map);
    else { drawAreaMarker.setLatLng(c); drawAreaMarker.setIcon(ic); }
  });
  map.on(L.Draw.Event.DRAWSTOP, clearDrawArea);   // remove the temp label when the draw ends

  // ---- Auto-save the CURRENT field contour (+ exclusions) so it survives closing
  // the app and is restored on the next open — no manual «Зберегти поле» needed.
  // Stored locally (localStorage), private to this device.
  function ringOf(layer) {
    let ll = layer.getLatLngs();
    while (Array.isArray(ll) && ll.length && Array.isArray(ll[0])) ll = ll[0];
    return ll.map((p) => ({ lat: p.lat, lng: p.lng }));
  }
  let _fieldTimer = null;
  function saveLastField() {
    try {
      const contour = boundaryFromPolygon();
      if (!contour || contour.length < 3) { localStorage.removeItem("fmp_last_field"); return; }
      // Store each exclusion as {r:ring, c:cut-tag} so auto-cuts stay replaceable across a reopen
      // (legacy bare-array saves still load — see restoreLastField). Hand-drawn cuts have c=null.
      const exclusions = exclusionItems.getLayers()
        .map((l) => ({ r: ringOf(l), c: l._cut || null }))
        .filter((o) => o.r.length >= 3);
      const hazards = collectHazards();
      try {
        localStorage.setItem("fmp_last_field", JSON.stringify({ contour, exclusions, hazards }));
      } catch (e) {
        // QuotaExceededError: an OSM power-line import (importOsmPowerLines, capped at 800
        // WAYS but not vertices) can carry thousands of vertices per way and blow the ~5 MB
        // localStorage budget on its own. OSM hazards are display-only (avoid:false,
        // non-authoritative) and re-importable with one tap — drop THEM from this save first
        // rather than lose the field contour/exclusions too (verified finding: the whole save
        // was failing silently, so the next reopen restored NOTHING).
        const trimmed = hazards.filter((h) => h.source !== "osm");
        let saved = false;
        if (trimmed.length !== hazards.length) {
          try {
            localStorage.setItem("fmp_last_field", JSON.stringify({ contour, exclusions, hazards: trimmed }));
            appLog("saveLastField: quota exceeded with " + (hazards.length - trimmed.length) +
              " OSM hazard(s) — saved without them (contour/exclusions kept; re-import ЛЕП з OSM after reopen)");
            saved = true;
          } catch (e2) { /* still too big — fall through to the last-resort save below */ }
        }
        if (!saved) {
          // Either no OSM hazards to drop, or it still doesn't fit — last resort: contour +
          // exclusions only (the field itself is the one thing that must never silently vanish).
          try {
            localStorage.setItem("fmp_last_field", JSON.stringify({ contour, exclusions, hazards: [] }));
            appLog("saveLastField: quota exceeded — saved contour/exclusions only, ALL hazards dropped: " + e);
          } catch (e3) {
            appLog("saveLastField: FAILED even without hazards — field contour NOT persisted: " + e3);
          }
        }
      }
    } catch (e) { /* boundaryFromPolygon/collectHazards threw, or private-mode denies localStorage entirely — ignore */ }
  }
  function scheduleSaveField() {
    if (_fieldTimer) clearTimeout(_fieldTimer);
    _fieldTimer = setTimeout(saveLastField, 500);
  }
  function restoreLastField() {
    let s;
    try { s = JSON.parse(localStorage.getItem("fmp_last_field") || "null"); } catch (e) { return; }
    if (!s || !s.contour || s.contour.length < 3) return;
    try {
      adoptField(L.polygon(s.contour.map((p) => [p.lat, p.lng]), { color: "#2d7ff9", weight: 2 }));
      (s.exclusions || []).forEach((item) => {
        const ring = Array.isArray(item) ? item : (item && item.r);   // legacy array | {r,c}
        if (ring && ring.length >= 3) {
          const poly = L.polygon(ring.map((p) => [p.lat, p.lng]), { color: "#ff4d4d", weight: 2 });
          addExclusionLayer(poly);
          if (item && item.c) poly._cut = item.c;                     // keep auto/manual tag on restore
        }
      });
      hazardItems.clearLayers();
      (s.hazards || []).forEach((m) => { if (m && m.geom && m.geom.length) addHazardLayer(m); });
      renderHazardList();
      setMsg("Відновлено останнє поле.", null);
    } catch (e) { /* malformed save — ignore */ }
  }

  // ---- ПОВНА сесія (2.5.49): маршрут, вкладка, карта, зʼєднання ------------
  // Мета: закрив додаток → відкрив — і ВСЕ на місці, нічого не натискаєш заново.
  // Контур+вирізи й параметри вже персистяться (fmp_last_field/fmp_last_settings);
  // тут — решта: побудований маршрут (без перерахунку і без холодного старту
  // рушія), активна вкладка, позиція карти, тип зʼєднання і авто-реконект BLE.
  const SESSION_KEY = "fmp_session";
  let _bootRestoring = false;      // під час відновлення clearRoute НЕ стирає знімок
  function sessionLoad() { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "{}"); } catch (e) { return {}; } }
  function sessionPatch(part) { try { localStorage.setItem(SESSION_KEY, JSON.stringify(Object.assign(sessionLoad(), part))); } catch (e) {} }
  function saveLastRoute(res) {
    try {
      if (!res || !res.ok || !res.waypoints || res.waypoints.length < 2) return;
      const lite = {
        waypoints: res.waypoints, cover: res.cover || null, home: res.home || null,
        duration_s: res.duration_s, length_m: res.length_m, sprayed_ha: res.sprayed_ha,
        area_ha: res.area_ha, liquid_l: res.liquid_l, flights: res.flights,
        calibration: res.calibration || null,
      };
      const st = $("stats");
      localStorage.setItem("fmp_last_route", JSON.stringify({
        res: lite,
        statsHtml: (st && !st.classList.contains("hidden")) ? st.innerHTML : "",
        rtl: $("rtl") ? $("rtl").checked : true,
        ts: Date.now(),
      }));
    } catch (e) { /* quota — ignore */ }
  }
  function restoreLastRoute(raw) {
    // raw = знімок, зчитаний ДО restoreLastField: adoptField() викликає
    // clearRoute(), який інакше стер би збережений маршрут раніше, ніж ми
    // встигли б його відновити (польовий баг 2.5.49 — «будуй заново»).
    let s;
    try { s = JSON.parse(raw || localStorage.getItem("fmp_last_route") || "null"); } catch (e) { return; }
    if (!s || !s.res || !s.res.waypoints || s.res.waypoints.length < 2) return;
    const res = s.res;
    try {
      if (res.cover && res.cover.length)
        insetLayer = L.polygon(res.cover.map((p) => [p.lat, p.lng]), {
          color: "#5fd3a3", weight: 1.5, dashArray: "6 5", fill: false,
        }).addTo(map).bindTooltip("Межа проходів (півширини внесення від краю)");
      const pts = res.waypoints.map((p) => [p.lat, p.lng]);
      lastRoute = pts;
      lastHome = res.home ? { lat: res.home.lat, lng: res.home.lng } : null;
      lastRtl = !!s.rtl;
      lastBuildStats = { duration_s: res.duration_s, length_m: res.length_m, sprayed_ha: res.sprayed_ha };
      lastFieldAreaHa = res.area_ha || 0;
      lastWorkContext = { field: currentFieldName || "поле", area_ha: res.area_ha || 0,
        sprayed_ha: res.sprayed_ha || 0, liquid_l: res.liquid_l || 0, sections: res.flights || 1,
        swath_m: parseFloat($("spacing").value) || 0, boundary: boundaryFromPolygon() || null };   // field already adopted by restoreLastField
      if (res.calibration) lastCalibration = res.calibration;
      routeLayer = L.polyline(pts, { color: "#ff8c2d", weight: 2.5, opacity: 0.95 }).addTo(map);
      routeMarkers = L.featureGroup([
        L.circleMarker(pts[0], { radius: 5, color: "#5fd3a3", fillOpacity: 1 }).bindTooltip("Старт"),
        L.circleMarker(pts[pts.length - 1], { radius: 5, color: "#ff7b72", fillOpacity: 1 }).bindTooltip("Фініш"),
      ]).addTo(map);
      if (s.statsHtml && $("stats")) { $("stats").innerHTML = s.statsHtml; $("stats").classList.remove("hidden"); }
      ["exp-wp", "exp-plan", "exp-fence", "exp-fencemp", "exp-geojson"]
        .forEach((id) => { if ($(id)) $(id).disabled = false; });
      updateMissionStatus();
      if (raw) { try { localStorage.setItem("fmp_last_route", raw); } catch (e) {} }
      appLog("[restore] маршрут відновлено: " + pts.length + " точок (без перерахунку)");
    } catch (e) { appLog("[restore] маршрут не відновився: " + e); }
  }

  // Edit the field contour's vertices in place, rebuilding the route LIVE as the
  // user drags (uses leaflet.draw's per-layer editing handler — no extra library,
  // and more discoverable + live than the modal toolbar pencil).
  let editingContour = false;
  function setContourEdit(on) {
    const btn = $("edit-contour");
    if (on && (!fieldPolygon || !fieldPolygon.editing)) return;
    if (on) {
      try { fieldPolygon.editing.enable(); } catch (e) { return; }
      fieldPolygon.on("edit", scheduleLiveBuild);
      fieldPolygon.on("edit", scheduleSaveField);
      editingContour = true;
      if (btn) { btn.textContent = "Готово (редагування)"; btn.classList.add("active"); }
      setMsg("Тягни вершини контуру — маршрут оновлюється наживо.", null);
    } else {
      if (fieldPolygon) {
        fieldPolygon.off("edit", scheduleLiveBuild);
        fieldPolygon.off("edit", scheduleSaveField);
        try { fieldPolygon.editing.disable(); } catch (e) {}
      }
      editingContour = false;
      if (btn) { btn.textContent = "Редагувати вершини контуру"; btn.classList.remove("active"); }
    }
  }

  // A vertex edit changes the geometry — the built route is now stale.
  map.on(L.Draw.Event.EDITED, () => {
    clearRoute();
    scheduleSaveField();
  });
  map.on(L.Draw.Event.DELETED, (e) => {
    // Tag-aware: deleting an exclusion or a split line must NOT wipe the field.
    let fieldGone = false;
    if (e && e.layers) e.layers.eachLayer((l) => { if (l === fieldPolygon || l._k === "field") fieldGone = true; });
    if (fieldGone) {
      setContourEdit(false);
      const _eb = $("edit-contour"); if (_eb) _eb.disabled = true;
      fieldPolygon = null;
      removeByKind("split");           // a split line must not outlive its field (bug-hunt #3)
      setFieldArea();                  // drop the live area label
    }
    if (!splitLayers().length && sectorsLayer) { map.removeLayer(sectorsLayer); sectorsLayer = null; }
    clearRoute();
    scheduleSaveField();
  });

  // ---- helpers ------------------------------------------------------------
  const $ = (id) => document.getElementById(id);

  // #13-доопрацювання (Іван): небезпеки не лише з OSM — ЛІМІТИ З КАРТИ ВИСОТ. Семпліює
  // сітку висот (open-meteo, Copernicus ~90 м DSM) над полем і позначає зони, де ПОВЕРХНЯ
  // (пагорб, гребінь, лісовий масив) підходить до площини польоту ближче, ніж «запас обходу».
  // ~90 м — це рельєф і великі об'єкти; ОКРЕМІ СТОВПИ/ДРОТИ ТУТ НЕ ВИДНО (повідомлення каже
  // це прямо). Зони — лише показ (avoid=false, як OSM): рішення завжди за очима оператора.
  async function importReliefLimits() {
    const boundary = boundaryFromPolygon();
    if (!boundary || boundary.length < 3) { setMsg("Спочатку задай поле — рельєф перевіряється в його межах.", "error"); return; }
    if (!navigator.onLine) { setMsg("Немає інтернету — карта висот недоступна офлайн.", "error"); return; }
    const alt = parseFloat($("alt").value) || 0;
    const clr = hazardClearanceM();
    const limit = alt - clr;
    if (!(alt > 0) || limit <= 0) {
      setMsg(tf("Висота {0} м мінус запас {1} м → ліміт ≤ 0: на цій висоті лімітує будь-який рельєф. Збільш висоту або зменш запас.", alt, clr), "warn");
      return;
    }
    const bb = fieldPolygon.getBounds().pad(0.08);
    const cLat = (bb.getNorth() + bb.getSouth()) / 2;
    const mlat = 111320, mlng = 111320 * Math.cos(cLat * Math.PI / 180) || 1;
    const wM = (bb.getEast() - bb.getWest()) * mlng, hM = (bb.getNorth() - bb.getSouth()) * mlat;
    const step = Math.max(90, Math.max(wM, hM) / 16);      // ≥ роздільність даних (~90 м)
    const nx = Math.max(2, Math.min(24, Math.round(wM / step) + 1));
    const ny = Math.max(2, Math.min(24, Math.round(hM / step) + 1));
    const dLng = (bb.getEast() - bb.getWest()) / (nx - 1), dLat = (bb.getNorth() - bb.getSouth()) / (ny - 1);
    const pts = [];
    for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++)
      pts.push({ lat: bb.getSouth() + iy * dLat, lng: bb.getWest() + ix * dLng, elev: null });
    // Точка відліку = місце зльоту: дім останньої збірки, або центроїд контуру.
    let rp = lastHome;
    if (!rp) { let la = 0, lo = 0; boundary.forEach((p) => { la += p.lat; lo += p.lng; }); rp = { lat: la / boundary.length, lng: lo / boundary.length }; }
    setMsg(tf("Рахую карту висот ({0} точок)…", nx * ny), null);
    const all = [rp].concat(pts);
    let elevs = [];
    try {
      for (let off = 0; off < all.length; off += 100) {
        const chunk = all.slice(off, off + 100);
        const res = await fetch("https://api.open-meteo.com/v1/elevation?latitude=" +
          chunk.map((p) => p.lat.toFixed(6)).join(",") + "&longitude=" + chunk.map((p) => p.lng.toFixed(6)).join(","));
        const j = await res.json();
        elevs = elevs.concat((j && j.elevation) || []);
      }
    } catch (e) { setMsg("Карта висот недоступна: " + e, "error"); return; }
    if (elevs.length !== all.length) { setMsg("Карта висот недоступна (сервіс відповів не повністю).", "error"); return; }
    const ref = elevs[0];
    pts.forEach((p, i) => { p.elev = elevs[i + 1]; });
    // Повторний запуск замінює попередні рельєф-зони (не дублює).
    hazardLayers().forEach((l) => { if ((l._hz || {}).source === "relief") drawnItems.removeLayer(l); });
    const rz = window.GEO_COVER.reliefZones({ nx: nx, ny: ny, pts: pts, ref: ref, limit: limit, halfLatDeg: dLat / 2, halfLngDeg: dLng / 2 });
    rz.zones.forEach((z) => addHazardLayer({ kind: "zone", geom: z.ring, source: "relief", avoid: false, dz: Math.round(z.maxDz), osm: null }));
    scheduleSaveField(); renderHazardList();
    const mx = rz.maxDz != null ? Math.round(rz.maxDz) : 0;
    if (rz.zones.length) {
      setMsg(tf("Рельєф: {0} зон(и), де поверхня ближче ніж {1} м до площини польоту (макс +{2} м від зльоту). Дані ~90 м — стовпи/дроти НЕ видно, перевір очима! Зони лише показуються (клік — видалити).", rz.zones.length, clr, mx), "warn");
    } else {
      setMsg(tf("Рельєф ок: макс перепад +{0} м від точки зльоту, запас до площини польоту ≥ {1} м. (Дані ~90 м — стовпи не видно.)", mx, clr), "ok");
    }
  }

  // ---- ІНСТРУМЕНТ ВИРІЗУ ЛЕП (#13, ТЗ Івана: одна кнопка авто, одна ручна) --------------
  // Лінія/точка ЛЕП → полігон-виріз заданої ШИРИНИ (капсула / коло). Це справжні вирізи:
  // маршрут їх обходить, вони зберігаються з полем і йдуть у геозону/safe-transit. Кожен
  // виріз тегується (_cut='auto'|'manual'): АВТО-вирізи повністю замінюються при повторному
  // запуску (зміна ширини → новий виріз замість старого, без накладання); ручні — лишаються.
  function cutWidthM() { return parseFloat(($("cut-width") || {}).value) || 0; }
  function _offsetToRings(geoms, kind, widthM) {
    const C = window.ClipperLib;
    if (!C || !(widthM > 0)) return [];
    let la = 0, lo = 0, n = 0;
    geoms.forEach((g) => g.forEach((p) => { la += p.lat; lo += p.lng; n++; }));
    if (!n) return [];
    la /= n; lo /= n;
    const mlat = 111320, mlng = (111320 * Math.cos(la * Math.PI / 180)) || 1, SC = 100;
    const toClip = (g) => g.map((p) => ({ X: Math.round((p.lng - lo) * mlng * SC), Y: Math.round((p.lat - la) * mlat * SC) }));
    const toLL = (path) => path.map((pt) => [la + pt.Y / SC / mlat, lo + pt.X / SC / mlng]);
    const rings = [];
    geoms.forEach((g) => {
      if (!g.length) return;
      const co = new C.ClipperOffset(2, 0.25 * SC);
      const et = (kind === "point" || g.length < 2) ? C.EndType.etOpenRound : C.EndType.etOpenRound;
      co.AddPath(toClip(g.length < 2 ? [g[0], g[0]] : g), C.JoinType.jtRound, et);
      const sol = new C.Paths(); co.Execute(sol, (widthM / 2) * SC);
      sol.forEach((path) => { if (path.length >= 3) rings.push(toLL(path)); });
    });
    return rings;
  }
  function addCutLayer(ringLL, tag) {
    const poly = L.polygon(ringLL);
    addExclusionLayer(poly);
    poly._cut = tag || "manual";
    return poly;
  }
  function clearAutoCuts() {
    exclusionItems.getLayers().forEach((l) => { if (l._cut === "auto") exclusionItems.removeLayer(l); });
  }
  // АВТО: знайти ЛЕП в OSM у межах поля і одразу вирізати (замінюючи попередні авто-вирізи).
  async function cutAutoFromOsm() {
    if (!fieldPolygon) { setMsg("Спочатку задай поле — пошук ЛЕП іде в його межах.", "error"); return; }
    if (!navigator.onLine) { setMsg("Немає інтернету — авто-пошук ЛЕП недоступний офлайн.", "error"); return; }
    const w = cutWidthM();
    if (!(w > 0)) { setMsg("Задай ширину вирізу, м.", "error"); return; }
    const b = fieldPolygon.getBounds().pad(0.15);
    const bbox = b.getSouth() + "," + b.getWest() + "," + b.getNorth() + "," + b.getEast();
    const q = "[out:json][timeout:25];(way[\"power\"~\"^(line|minor_line)$\"](" + bbox + ");node[\"power\"~\"^(tower|pole)$\"](" + bbox + "););out geom;";
    setMsg("Шукаю ЛЕП в OSM…", null);
    const mirrors = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
    let data = null;
    for (const url of mirrors) {
      const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 25000);
      try {
        const r = await fetch(url, { method: "POST", signal: ac.signal,
          headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(q) });
        clearTimeout(to);
        if (!r.ok) continue;
        data = await r.json(); break;
      } catch (e) { clearTimeout(to); }
    }
    if (!data || !data.elements) { setMsg("Overpass недоступний — спробуй пізніше або накресли виріз вручну (планування не заблоковано).", "error"); return; }
    const lines = [], points = [];
    let taken = 0;
    for (const el of data.elements) {
      if (taken >= 800) break;
      if (el.type === "way" && Array.isArray(el.geometry) && el.geometry.length >= 2) {
        lines.push(el.geometry.map((p) => ({ lat: p.lat, lng: p.lon }))); taken++;
      } else if (el.type === "node" && el.lat != null) {
        points.push([{ lat: el.lat, lng: el.lon }]); taken++;
      }
    }
    if (!taken) { setMsg("ЛЕП не знайдено в OSM для цього поля — це НЕ доказ, що їх нема. Перевір очима або накресли вручну!", "warn"); return; }
    clearAutoCuts();                                   // replace previous auto cuts (no stacking)
    const rings = _offsetToRings(lines, "line", w).concat(_offsetToRings(points, "point", w));
    rings.forEach((r) => addCutLayer(r, "auto"));
    clearRoute(); scheduleSaveField(); renderHazardList();
    const warn = $("hazard-osm-warn"); if (warn) warn.style.display = "";
    setMsg(tf("Вирізано {0} ділянок ЛЕП з OSM (ширина {1} м). OSM неповний — ПЕРЕВІР ОЧИМА! Зміни ширину й тисни ще раз — старі авто-вирізи заміняться. Перебудуй маршрут.", rings.length, w), "warn");
  }
  // ВРУЧНУ: увімкнути креслення лінії; на завершенні — виріз-капсула поточної ширини.
  let cutDrawing = false;
  function startCutDraw() {
    if (!fieldPolygon) { setMsg("Спочатку задай поле.", "error"); return; }
    if (!(cutWidthM() > 0)) { setMsg("Задай ширину вирізу, м.", "error"); return; }
    cancelToolbarDraw();
    if (_hazHandler) { try { _hazHandler.disable(); } catch (e) {} _hazHandler = null; }
    cutDrawing = true; hazardMode = "cut";
    _hazHandler = new L.Draw.Polyline(map, { shapeOptions: { color: "#ff4d4d", weight: 3, dashArray: "4 4" } });
    _hazHandler.enable();
    setMsg("Веди лінію вздовж ЛЕП (подвійний клік = кінець) — стане вирізом заданої ширини.", null);
  }
  function makeManualCut(layer) {
    const geom = _hzGeom(layer, "line");
    cutDrawing = false; hazardMode = null; _hazHandler = null;
    if (geom.length < 2) { setMsg("Замало точок для лінії.", "error"); return; }
    const rings = _offsetToRings([geom], "line", cutWidthM());
    rings.forEach((r) => addCutLayer(r, "manual"));
    clearRoute(); scheduleSaveField(); renderHazardList();
    setMsg(tf("Виріз завширшки {0} м створено. Перебудуй маршрут — він його обійде.", cutWidthM()), "ok");
  }

  // Hazard-subsystem buttons (#13): wired HERE, not next to their functions above —
  // `$` is a const and does not exist before this line (TDZ). See the note at the
  // hazards section.
  if ($("cut-auto")) $("cut-auto").addEventListener("click", () => cutAutoFromOsm());
  if ($("cut-manual")) $("cut-manual").addEventListener("click", () => startCutDraw());
  if ($("haz-relief")) $("haz-relief").addEventListener("click", () => importReliefLimits());

  function setMsg(text, kind) {
    text = t(text);                            // i18n: translate whole-string messages (EN)
    // Auto-capture EVERY red (error) message in the diagnostic log with its cause
    // (the text carries it; the lines just above give the context) and flag a new
    // problem so the log auto-uploads — the operator never relays a red one by hand.
    if (kind === "error" && text) { appLog("[ЧЕРВОНЕ] " + text); _errSinceUpload++; }
    const el = $("msg");
    if (el) {                                  // persistent status line (bottom of panel)
      el.textContent = text || "";
      el.className = "msg" + (kind ? " " + kind : "");
    }
    showToast(text, kind);                     // + transient popup at the top of the map
  }
  // Transient popup: appears while a process runs and briefly after its RESULT, then
  // auto-hides. In-progress messages (ending with «…») stay up until the next message;
  // final ones auto-hide (errors linger longer). Dismiss early by tap or swipe.
  let _toastTimer = null, _toastTouchX = null;
  function showToast(text, kind) {
    const t = $("toast");
    if (!t) return;
    if (!text) { hideToast(); return; }
    t.textContent = text;
    t.className = "toast show" + (kind ? " " + kind : "");
    t.style.transform = ""; t.style.opacity = "";
    if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }
    if (!/…\s*$/.test(text)) _toastTimer = setTimeout(hideToast, (kind === "error" || kind === "warn") ? 8000 : 4000);
  }
  function hideToast() {
    const t = $("toast");
    if (!t) return;
    if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }
    t.classList.remove("show");
    t.style.transform = ""; t.style.opacity = "";
  }
  (function wireToastDismiss() {
    const t = $("toast");
    if (!t) return;
    t.addEventListener("click", hideToast);
    t.addEventListener("touchstart", (e) => { _toastTouchX = e.touches[0].clientX; }, { passive: true });
    t.addEventListener("touchmove", (e) => {
      if (_toastTouchX == null) return;
      const dx = e.touches[0].clientX - _toastTouchX;
      t.style.transform = "translate(calc(-50% + " + dx + "px), 0)";
      t.style.opacity = String(Math.max(0, 1 - Math.abs(dx) / 160));
      if (Math.abs(dx) > 80) { _toastTouchX = null; hideToast(); }
    }, { passive: true });
    t.addEventListener("touchend", () => {
      _toastTouchX = null;
      if (t.classList.contains("show")) { t.style.transform = ""; t.style.opacity = ""; }
    }, { passive: true });
  })();

  function clearRoute(keepViz) {
    if (!_bootRestoring) { try { localStorage.removeItem("fmp_last_route"); } catch (e) {} }
    lastRoute = null;               // editing buffer; flownRoute keeps the uploaded one
    if (typeof updateMissionStatus === "function") updateMissionStatus();
    if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
    if (routeMarkers) { map.removeLayer(routeMarkers); routeMarkers = null; }
    if (homeMarker) { map.removeLayer(homeMarker); homeMarker = null; }
    if (insetLayer) { map.removeLayer(insetLayer); insetLayer = null; }
    if (parcelsLayer) { map.removeLayer(parcelsLayer); parcelsLayer = null; }
    if (sectorsLayer) { map.removeLayer(sectorsLayer); sectorsLayer = null; }
    // A LIVE rebuild (angle drag / vertex edit) sends viz=false, so it would otherwise
    // strip the spray overlay and never redraw it. Keep the last overlay during live
    // builds; it is refreshed on the next full "Побудувати".
    if (!keepViz) {
      if (coverageLayer) { map.removeLayer(coverageLayer); coverageLayer = null; }
      if (overlapLayer) { map.removeLayer(overlapLayer); overlapLayer = null; }
      if (gapLayer) { map.removeLayer(gapLayer); gapLayer = null; }
      // #12: safe-path viz, like the overlays above, is only (re)computed on a full
      // (non-live) build — drop the stale one here; the async safe_transit call below
      // repaints it once it resolves.
      if (transitLayer) { map.removeLayer(transitLayer); transitLayer = null; }
    }
    $("stats").classList.add("hidden");
    ["exp-wp", "exp-plan", "exp-fence", "exp-fencemp", "exp-geojson"]
      .forEach((id) => { $(id).disabled = true; });
    if ($("cancel-build")) $("cancel-build").disabled = true;   // no route → nothing to cancel
  }
  if ($("cancel-build")) $("cancel-build").addEventListener("click", () => {
    clearRoute();
    setMsg("Побудову маршруту скасовано.", null);
  });

  function boundaryFromPolygon() {
    if (!fieldPolygon) return null;
    // Leaflet returns latlngs as [ [ring], ... ]; take the outer ring.
    let latlngs = fieldPolygon.getLatLngs();
    while (Array.isArray(latlngs) && latlngs.length && Array.isArray(latlngs[0])) {
      latlngs = latlngs[0];
    }
    return latlngs.map((p) => ({ lat: p.lat, lng: p.lng }));
  }

  function fmtDuration(sec) {
    const m = Math.floor(sec / 60), s = Math.round(sec % 60);
    return m + " хв " + String(s).padStart(2, "0") + " с";
  }

  // Backend bridge: pywebview JS API when in the desktop window, otherwise an
  // HTTP shim talking to serve.py (browser mode).
  // API calls resolve relative to wherever the app is hosted — "/" on the
  // desktop, or a sub-path like "/ai" behind the VPS reverse-proxy — so absolute
  // "/api/..." paths keep working under any base path.
  const API_BASE = location.pathname.replace(/[^/]*$/, "").replace(/\/$/, "");
  async function postJSON(url, body) {
    const full = url[0] === "/" ? API_BASE + url : url;
    const r = await fetch(full, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    return r.json();
  }
  const httpApi = {
    build_route: (p) => postJSON("/api/build_route", p),
    safe_transit: (p) => postJSON("/api/safe_transit", p),
    export: (fmt) => postJSON("/api/export", { fmt }),
    save_project: (p) => postJSON("/api/save_project", p),
    mav_ports: (p) => postJSON("/api/mav_ports", p || {}),
    mav_connect: (p) => postJSON("/api/mav_connect", p),
    mav_disconnect: (p) => postJSON("/api/mav_disconnect", p || {}),
    mav_status: (p) => postJSON("/api/mav_status", p || {}),
    mav_upload_mission: (p) => postJSON("/api/mav_upload_mission", p || {}),
    mav_download_mission: (p) => postJSON("/api/mav_download_mission", p || {}),
    mav_verify_mission: (p) => postJSON("/api/mav_verify_mission", p || {}),
    mav_command: (p) => postJSON("/api/mav_command", p),
  };
  function api() {
    if (window.pywebview && window.pywebview.api) return window.pywebview.api;
    return httpApi;
  }

  // ---- build --------------------------------------------------------------
  let buildSeq = 0;          // newest dispatched build wins (drop stale live results)
  let liveTimer = null;      // debounce handle for live angle rebuilds

  async function buildRoute(opts = {}) {
    const live = !!opts.live;             // quiet rebuild while the user drags the angle
    if (!live) commitActiveDraw();        // auto-finish a forgotten in-progress drawing first
    const boundary = boundaryFromPolygon();
    if (!boundary || boundary.length < 3) {
      if (!live) setMsg("Спочатку задайте контур поля на карті.", "error");
      return;
    }
    const params = {
      boundary,
      spacing: parseFloat($("spacing").value),
      boom: (parseFloat(($("boom") || {}).value) || 0),   // #9: physical spray width (0/empty → engine uses spacing)
      angle: parseFloat($("angle").value),
      auto_angle: $("auto_angle").checked,
      // Auto-angle = FULL COVERAGE first, then minimum TIME (passes along the
      // longest edge, fewest turns) — for a continuous takeoff→landing sprayer (Ivan).
      optimize: live ? "length" : "overlap",
      margin: parseFloat($("margin").value) || 0,
      alt: parseFloat($("alt").value),
      speed: parseFloat($("speed").value),
      rtl: $("rtl").checked,
      // Fixed-wing (auto by connected FC type): engine replaces sharp pass-end U-turns
      // with contained arcs (R=spacing/2, passes shortened). THIS is the param the
      // engine reads — plane_turn in collectParams() was save/load only, not the build.
      plane_turn: !!($("round-turn") && $("round-turn").checked && isPlaneVehicle()),
      // Hazard corridors (poles→circles, power lines→capsules) are added ONLY here, not in
      // collectExclusions() — KML/geozone/project stores stay clean (#13). avoid=false hazards skipped.
      exclusions: collectExclusions().concat(hazardCorridors(hazardClearanceM())),
      // Spray-footprint overlay (swath + double-spray): only on a real build, and only
      // if the toggle is on — keeps live angle drags fast (no buffer geometry then).
      viz: !live && (!$("viz-coverage") || $("viz-coverage").checked),
      // Logged real flights -> the engine calibrates the time/battery estimate.
      flight_records: flightSummaries.length ? flightSummaries : undefined,
    };

    const myToken = ++buildSeq;          // only the latest dispatched build may draw
    let res = null;
    // Prefer the in-browser Pyodide engine — runs the route entirely on-device,
    // so it works OFFLINE (no wifi). Fall back to the server API only if the
    // engine isn't available (e.g. it failed to load).
    const eng = window.FMP_ENGINE;
    if (!IS_QT && eng && eng.available()) {
      if (!live) setMsg(eng.isReady() ? "Будую…" : "Готую офлайн-рушій…", null);
      try {
        res = await eng.buildRoute(params);   // Pyodide (worker, or main thread on the APK)
      } catch (err) {
        console.error("offline engine failed:", err);
        appLog("build: offline engine error: " + ((err && err.message) || err));
      }
    }
    if (res === null) {
      // The native APK has NO local server — the in-browser engine is the ONLY option,
      // so a /api fetch would just throw "Failed to fetch" in the field. Say it plainly.
      if (IS_ANDROID) {
        if (!live) setMsg("Офлайн-рушій не зміг побудувати маршрут. Онови застосунок у вкладці «Додаток» (або перевстанови APK).", "error");
        return;
      }
      const a = api();
      if (!a) { if (!live) setMsg("Рушій недоступний (немає ні офлайн-рушія, ні сервера).", "error"); return; }
      if (!live) setMsg("Будую…", null);
      try {
        res = await a.build_route(params);
      } catch (err) {
        if (myToken === buildSeq && !live) setMsg(navigator.onLine
          ? "Помилка виклику сервера: " + ((err && err.message) || err)
          : "Немає інтернету, а офлайн-рушій недоступний. Перезапусти застосунок.", "error");
        return;
      }
    }
    if (myToken !== buildSeq) return;     // a newer angle build superseded this one
    if (!res || !res.ok) {
      if (!live) setMsg((res && res.error) || "Невідома помилка.", "error");
      return;
    }

    // Remember the plan (for flight-logging planned-vs-actual) and cache the
    // calibration the engine applied (for the live telemetry ETA).
    lastBuildStats = { duration_s: res.duration_s, length_m: res.length_m, sprayed_ha: res.sprayed_ha };
    lastFieldAreaHa = res.area_ha || 0;
    lastWorkContext = { field: currentFieldName || "поле", area_ha: res.area_ha || 0,
      sprayed_ha: res.sprayed_ha || 0, liquid_l: res.liquid_l || 0, sections: res.flights || 1,
      swath_m: parseFloat($("spacing").value) || 0, boundary: boundary };   // field ring for covered-area (§8)
    if (res.calibration) lastCalibration = res.calibration;

    clearRoute(live);   // on a live rebuild keep the last spray overlay (viz isn't recomputed)

    // Coverage boundary = field inset by half the spray swath (+ extra margin):
    // the passes live here so the spray reaches the field edge.
    if (res.cover && res.cover.length) {
      const ins = res.cover.map((p) => [p.lat, p.lng]);
      insetLayer = L.polygon(ins, {
        color: "#5fd3a3", weight: 1.5, dashArray: "6 5", fill: false,
      }).addTo(map).bindTooltip("Межа проходів (півширини внесення від краю)");
    }

    // Spray footprint overlay: the swept SWATH (green, width = spacing) and the
    // DOUBLE-sprayed area (red) drawn over it. interactive:false so they never block
    // map clicks (drawing / takeoff-pin). Route line is drawn after, so it sits on top.
    // High-contrast over GREEN farmland satellite: CYAN swath (a green fill on a green
    // field was invisible), VIVID RED double-spray. Higher opacity so it reads on a
    // phone in daylight.
    // Spray overlays (N swath + M double-spray polygons) are the heaviest paint.
    // Defer them a frame so the route line + markers + stats appear FIRST; they fill
    // in after and the route is lifted back on top. Guard drops a superseded build.
    if ((res.coverage_geo && res.coverage_geo.length) || (res.overlap_geo && res.overlap_geo.length) || (res.gap_geo && res.gap_geo.length)) {
      setTimeout(() => {
        if (myToken !== buildSeq) return;
        if (res.coverage_geo && res.coverage_geo.length) {
          coverageLayer = L.featureGroup(res.coverage_geo.map((ring) =>
            L.polygon(ring.map((p) => [p.lat, p.lng]), {
              color: "#0077b6", weight: 1.5, opacity: 0.9,
              fillColor: "#00c2ff", fillOpacity: 0.35, interactive: false,
            }))).addTo(map).bindTooltip("Площа внесення (ширина смуги = крок)");
        }
        if (res.overlap_geo && res.overlap_geo.length) {
          overlapLayer = L.featureGroup(res.overlap_geo.map((ring) =>
            L.polygon(ring.map((p) => [p.lat, p.lng]), {
              color: "#c0392b", weight: 0.5, opacity: 0.55,
              fillColor: "#ff3b30", fillOpacity: 0.3, interactive: false,
            }))).addTo(map).bindTooltip("Накладання — подвійне внесення");
        }
        if (res.gap_geo && res.gap_geo.length) {
          gapLayer = L.featureGroup(res.gap_geo.map((ring) =>
            L.polygon(ring.map((p) => [p.lat, p.lng]), {
              color: "#b8860b", weight: 1, opacity: 0.9,
              fillColor: "#ffd166", fillOpacity: 0.4, interactive: false,
            }))).addTo(map).bindTooltip("Прогалини — пропущено (не оброблено)");
        }
        if (routeLayer && routeLayer.bringToFront) routeLayer.bringToFront();
        if (routeMarkers && routeMarkers.bringToFront) routeMarkers.bringToFront();
      }, 0);
    }

    const pts = res.waypoints.map((p) => [p.lat, p.lng]);
    lastRoute = pts;                 // editing buffer; snapshotted on upload
    lastHome = res.home ? { lat: res.home.lat, lng: res.home.lng } : null;
    lastRtl = $("rtl").checked;
    updateMissionStatus();           // plan changed -> "not uploaded / re-upload"
    routeLayer = L.polyline(pts, { color: "#ff8c2d", weight: 2.5, opacity: 0.95 }).addTo(map);

    // #12: draw the safe ingress/egress detour — PURE VISUALIZATION (the actual splice
    // into the uploaded mission happens independently in mav_upload_mission). Only
    // worth computing when exclusions exist (a straight hop only risks cutting through
    // one of those); skip on every live angle-drag to keep dragging snappy. Runs async
    // and never blocks the rest of the build — a newer build's higher myToken drops a
    // stale result, and any failure here is purely cosmetic (upload has its own splice).
    if (!live && exclLayers().length > 0) {
      (async () => {
        try {
          const tParams = { home: lastHome ? { lat: lastHome.lat, lng: lastHome.lng } : undefined };
          const t = (!IS_QT && eng && eng.available())
            ? await eng.safeTransit(tParams)
            : await api().safe_transit(tParams);
          if (myToken !== buildSeq) return;   // a newer build superseded this one
          if (transitLayer) { map.removeLayer(transitLayer); transitLayer = null; }
          if (t && t.ok) {
            const legs = [];
            if (t.ingress_ok && t.ingress.length > 1) legs.push(L.polyline(t.ingress.map((p) => [p.lat, p.lng]),
              { color: "#2ecc71", weight: 3, opacity: 0.9, dashArray: "6 6", interactive: false }));
            if (t.egress_ok && t.egress.length > 1) legs.push(L.polyline(t.egress.map((p) => [p.lat, p.lng]),
              { color: "#2f80ed", weight: 3, opacity: 0.9, dashArray: "6 6", interactive: false }));
            if (legs.length) transitLayer = L.featureGroup(legs).addTo(map)
              .bindTooltip("Безпечний шлях на старт / додому");
            if (!t.ingress_ok) setMsg("Безпечний шлях до старту не побудовано — політ напряму. Перевір межу поля та вирізи.", "warn");
            if (!t.egress_ok) setMsg("Безпечний шлях додому не побудовано — політ напряму. Перевір межу поля та вирізи.", "warn");
          }
          // !t.ok (or an engine that lacks safe_transit) → no detour drawn, no warning —
          // this is cosmetic-only; the upload path makes its own independent decision.
        } catch (e) {
          console.error("safe_transit viz failed:", e);
        }
      })();
    }

    // start/end markers — in their OWN FeatureGroup on the map. (A polyline has
    // no addLayer, so `.addTo(routeLayer)` would throw and abort the whole build.)
    if (pts.length) {
      routeMarkers = L.featureGroup([
        L.circleMarker(pts[0], { radius: 5, color: "#5fd3a3", fillOpacity: 1 })
          .bindTooltip("Старт"),
        L.circleMarker(pts[pts.length - 1], { radius: 5, color: "#ff7b72", fillOpacity: 1 })
          .bindTooltip("Фініш"),
      ]).addTo(map);
    }
    // (The takeoff "HOME" marker at the field centroid was removed — it cluttered
    // the field; the real takeoff is the anchor / the drone's GPS.)
    // Manual sectors: render each sub-polygon in its own colour.
    if (sectorsLayer) { map.removeLayer(sectorsLayer); sectorsLayer = null; }
    if (res.sectors && res.sectors.length) {
      const palette = ["#5fd3a3", "#ffd166", "#ff8c2d", "#c792ea", "#2d7ff9", "#ff7b72"];
      sectorsLayer = L.featureGroup(res.sectors.map((sec, i) =>
        L.polygon(sec.map((p) => [p.lat, p.lng]),
          { color: palette[i % palette.length], weight: 2, fillOpacity: 0.06 })
          .bindTooltip("Сектор " + (i + 1)))).addTo(map);
    }

    $("stats").innerHTML =
      row("Точок маршруту", res.count) +
      row("Площа", res.area_ha + " га") +
      (res.excluded_ha > 0 ? row("Вирізано (перешкоди)", res.excluded_ha + " га") : "") +
      (res.excluded_ha > 0 ? row("Покрита площа", res.sprayed_ha + " га") : "") +
      (res.liquid_l > 0 ? row("Робочий розчин", res.liquid_l + " л") : "") +
      (res.refills > 0 ? row("Заправок бака", res.refills) : "") +
      row("Довжина", (res.length_m / 1000).toFixed(2) + " км") +
      row("Орієнт. час", fmtDuration(res.duration_s)) +
      (res.coverage_pct != null ? row("Покриття поля", res.coverage_pct + "%") : "") +
      (res.gap_ha > 0.001 ? row("Прогалини", res.gap_ha.toFixed(3) + " га") : "") +
      (res.overlap_pct != null ? row("Перекриття", res.overlap_pct + "%") : "") +
      row("Кут проходів", res.angle_used + "°" + ($("auto_angle").checked ? " (авто)" : "")) +
      row("Відступ", res.margin + " м") +
      (res.flights > 1 ? row("Секцій (рівні за площею)", res.flights) : "") +
      ((res.sections && res.sections.length) ? res.sections.map((s, i) =>
        row("• Секція " + (i + 1), s.area_ha + " га · " + fmtDuration(s.duration_s))).join("") : "");
    $("stats").classList.remove("hidden");
    ["exp-wp", "exp-plan", "exp-fence", "exp-fencemp", "exp-geojson"]
      .forEach((id) => { $(id).disabled = false; });
    if ($("cancel-build")) $("cancel-build").disabled = false;   // route built → can cancel

    // Reflect the angle actually used back into the controls (esp. auto-angle).
    syncAngleDisplay(res.angle_used);
    updateTakeoffInfo(res.home);   // show the takeoff point + its ground elevation
    // Overlay was requested but the engine returned no geometry → an OLD cached engine
    // (e.g. a half-finished update). Tell the user to reopen the app to finish updating.
    if (!live && params.viz && pts.length >= 2 && !(res.coverage_geo && res.coverage_geo.length)) {
      setMsg("Площа внесення недоступна — застаріла версія рушія. Повністю закрий і знову відкрий додаток, щоб завершити оновлення.", "error");
    } else {
      setMsg(live
        ? `Кут ${res.angle_used}° — маршрут оновлено наживо.`
        : "Маршрут готовий. Можна експортувати маршрут або контур.", "ok");
    }
    setTimeout(() => saveLastRoute(res), 0);   // #8: JSON.stringify+localStorage off the paint frame
  }

  function row(label, value) {
    label = t(label);
    if (LANG === "en") value = enUnits(value);
    return `<div class="row"><span>${esc(label)}</span><span>${esc(value)}</span></div>`;
  }
  // Translate trailing UA measurement units inside a rendered VALUE string (EN mode).
  function enUnits(v) {
    if (v == null) return v;
    return String(v)
      .replace(/ га/g, " ha").replace(/ км/g, " km").replace(/ л(?![а-яіїєґ'А-ЯІЇЄҐ])/g, " l")
      .replace(/ хв/g, " min").replace(/ с(?![а-яіїєґ'А-ЯІЇЄҐ])/g, " s")
      .replace(/ м(?![а-яіїєґ'А-ЯІЇЄҐ])/g, " m").replace(/ \(авто\)/g, " (auto)");
  }
  // Translate a template with {0},{1}… placeholders, then substitute args (EN mode).
  function tf(tmpl, ...args) {
    let s = t(tmpl);
    args.forEach((a, i) => { s = s.split("{" + i + "}").join(String(a)); });
    return s;
  }
  // Pluralise a count word: UA раз/рази/разів, EN time/times.
  function plurCount(n) {
    if (LANG === "en") return n === 1 ? "time" : "times";
    const a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return "разів";
    if (b === 1) return "раз";
    if (b >= 2 && b <= 4) return "рази";
    return "разів";
  }

  // Escape HTML before putting any untrusted string into innerHTML. The drone's
  // STATUSTEXT / mode strings flow into the HUD, so a spoofed or malformed
  // vehicle must not be able to inject markup/script into a GCS that can arm and
  // command a real drone.
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  async function doExport(fmt) {
    const a = api();
    if (!a) { setMsg("pywebview API недоступний.", "error"); return; }
    const res = await a.export(fmt);
    if (res && res.ok) setMsg("Збережено: " + res.path, "ok");
    else if (res && res.cancelled) setMsg("Скасовано.", null);
    else setMsg((res && res.error) || "Не вдалося зберегти.", "error");
  }

  // ---- tabs (План / Політ) ------------------------------------------------
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = btn.getAttribute("data-tab");
      document.querySelectorAll(".tab").forEach((b) =>
        b.classList.toggle("active", b === btn));
      document.querySelectorAll(".tab-pane").forEach((p) =>
        p.classList.toggle("active", p.id === "tab-" + name));
      if (name === "stats" && typeof renderFlightStats === "function") renderFlightStats();
      // Leaflet needs a nudge after the panel content changes width/visibility.
      setTimeout(() => map.invalidateSize(), 50);
    });
  });

  // ---- install / download tab --------------------------------------------
  // The «Додаток» tab is only meaningful in a plain browser (PWA install + file
  // downloads). Inside the native APK or the Qt desktop the app is ALREADY
  // installed and there's no /downloads on the local server, so hide it — keeps
  // the field UI (План/Політ) the only things present.
  if (IS_ANDROID || IS_QT || IS_IOS) {
    const tb = $("tab-btn-app");
    if (tb) tb.style.display = "none";
  }
  // PWA install (Android web / PC): capture the browser's install prompt so the
  // «Встановити веб-версію» button can trigger it; otherwise show manual steps.
  let _deferredInstall = null;
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); _deferredInstall = e; });
  const _installBtn = $("install-pwa");
  if (_installBtn) {
    _installBtn.addEventListener("click", async () => {
      if (_deferredInstall) {
        _deferredInstall.prompt();
        try { await _deferredInstall.userChoice; } catch (e) {}
        _deferredInstall = null;
      } else {
        const h = $("install-pwa-hint");      // already installed, or iOS/Firefox
        if (h) h.style.display = "";
      }
    });
  }

  // ---- live angle: slider <-> number, debounced rebuild -------------------
  function syncAngleEnabled() {
    // When auto-angle is on the backend ignores the manual angle, so grey the
    // controls out to make that obvious.
    const auto = $("auto_angle") && $("auto_angle").checked;
    if ($("angle")) $("angle").disabled = auto;
    if ($("angle-range")) $("angle-range").disabled = auto;
  }
  function syncAngleDisplay(angle) {
    if (angle == null || isNaN(angle)) return;
    const v = Math.round(angle);
    if ($("angle-val")) $("angle-val").textContent = v + "°";
    // With auto-angle on, mirror the computed optimum into the controls so the
    // user sees it (and can fine-tune from there after switching to manual).
    if ($("auto_angle") && $("auto_angle").checked) {
      if ($("angle")) $("angle").value = v;
      if ($("angle-range")) $("angle-range").value = v;
    }
  }
  function scheduleLiveBuild() {
    const b = boundaryFromPolygon();
    if (!b || b.length < 3) return;        // no field yet — nothing to rebuild
    if (liveTimer) clearTimeout(liveTimer);
    liveTimer = setTimeout(() => buildRoute({ live: true }), 140);
  }
  // Touching the angle by hand means the user is choosing it → drop auto-angle.
  function onAngleInput(value, fromRange) {
    let v = parseInt(value, 10);
    if (isNaN(v)) return;
    v = Math.max(0, Math.min(179, v));
    if (fromRange) { if ($("angle")) $("angle").value = v; }
    else { if ($("angle-range")) $("angle-range").value = v; }
    if ($("angle-val")) $("angle-val").textContent = v + "°";
    if ($("auto_angle") && $("auto_angle").checked) {
      $("auto_angle").checked = false;
      syncAngleEnabled();
    }
    scheduleLiveBuild();
  }

  // ---- wiring -------------------------------------------------------------
  if ($("angle")) $("angle").addEventListener("input", (e) => onAngleInput(e.target.value, false));
  if ($("angle-range")) $("angle-range").addEventListener("input", (e) => onAngleInput(e.target.value, true));
  if ($("auto_angle")) $("auto_angle").addEventListener("change", () => { syncAngleEnabled(); scheduleLiveBuild(); });
  // Auto-save the working settings on every change; restore them on launch so the
  // last mission's settings are pre-filled next time the app opens.
  ["spacing", "alt", "speed", "margin", "angle", "angle-range"].forEach((id) => {
    if ($(id)) $(id).addEventListener("input", scheduleSaveSettings);
  });
  ["rtl", "auto_angle", "viz-coverage", "round-turn"].forEach((id) => {
    if ($(id)) $(id).addEventListener("change", scheduleSaveSettings);
  });
  function syncRoundTurnHint() {
    const h = $("round-turn-hint");
    if (h && $("round-turn")) h.style.display = $("round-turn").checked ? "" : "none";
  }
  if ($("round-turn")) $("round-turn").addEventListener("change", syncRoundTurnHint);
  window.addEventListener("beforeunload", () => {
    saveLastSettings(); saveLastField(); flightRecPersist(true); flushLog();
    try { localStorage.setItem("fmp_current_field", currentFieldName || ""); } catch (e) {}
  });
  restoreLastSettings();          // pre-fill last session's settings before first render
  // Deferred so ALL module-level `let`s (lastRoute, …) are initialized first —
  // adoptField()→clearRoute() touches them, which would hit a TDZ error if run inline.
  setTimeout(() => {
    let _routeSnap = null;
    try { _routeSnap = localStorage.getItem("fmp_last_route"); } catch (e) {}
    _bootRestoring = true;
    try {
      try { const _cf = localStorage.getItem("fmp_current_field"); if (_cf) currentFieldName = _cf; } catch (e) {}
      restoreLastField();          // контур + вирізи (adoptField кличе clearRoute)
      restoreLastRoute(_routeSnap); // маршрут — зі знімка (будує lastWorkContext.field з currentFieldName)
    } finally { _bootRestoring = false; }
    flownRestore();               // "що залито в дрон" — щоб статус місії й прогрес пережили reopen (#2)
    updateMissionStatus();
    flightRecRestore();           // згорнути перерваний kill-ом запис польоту в журнал (як partial) (#2)
    const ss = sessionLoad();
    // Позиція карти користувача перемагає fitBounds відновленого поля.
    if (ss.map && ss.map.z != null) {
      try { map.setView([ss.map.lat, ss.map.lng], ss.map.z, { animate: false }); } catch (e) {}
    }
    if (ss.connType) {
      try {
        const tsel = $("mav-conn-type");
        if (tsel && tsel.querySelector('option[value="' + ss.connType + '"]')) {
          tsel.value = ss.connType; mavSyncRows();
        }
      } catch (e) {}
    }
    if (ss.addr) { try { if ($("mav-address")) $("mav-address").value = ss.addr; } catch (e) {} }
    if (ss.tab && ss.tab !== "plan") {
      try { const b = document.querySelector('.tab[data-tab="' + ss.tab + '"]'); if (b) b.click(); } catch (e) {}
    }
    // Сесія закінчилась підключеною → тихо перепідключаємось самі (BLE/UDP/TCP/cable, #2).
    bootAutoReconnect(ss);
    if (ss.overlay != null) { mavOverlayOn = !!ss.overlay; syncOverlayBtn(); }   // #11 overlay toggle (default ON)
    // Хуки збереження решти сесії.
    let _mvTimer = null;
    map.on("moveend zoomend", () => {
      if (_mvTimer) clearTimeout(_mvTimer);
      _mvTimer = setTimeout(() => {
        const c = map.getCenter();
        sessionPatch({ map: { lat: c.lat, lng: c.lng, z: map.getZoom() } });
      }, 400);
    });
    const tsel = $("mav-conn-type");
    if (tsel) tsel.addEventListener("change", () => sessionPatch({ connType: tsel.value }));
    const addr = $("mav-address");
    if (addr) addr.addEventListener("change", () => sessionPatch({ addr: addr.value }));
    const baud = $("mav-baud");
    if (baud) {
      if (ss.baud && baud.querySelector('option[value="' + ss.baud + '"]')) baud.value = ss.baud;
      baud.addEventListener("change", () => sessionPatch({ baud: baud.value }));
    }
    const mres = $("mission-resume");
    if (mres) {
      if (ss.resume != null) mres.checked = !!ss.resume;
      mres.addEventListener("change", () => { sessionPatch({ resume: mres.checked }); resumeHint(); });
      resumeHint();
    }
    const fol = $("mav-follow");
    if (fol) {
      if (ss.follow != null) { fol.checked = !!ss.follow; fol.dispatchEvent(new Event("change")); }
      fol.addEventListener("change", () => sessionPatch({ follow: fol.checked }));
    }
    const disc = $("mav-disconnect");
    if (disc) disc.addEventListener("click", () => sessionPatch({ wasConnected: false }));
    document.querySelectorAll(".tab").forEach((b) =>
      b.addEventListener("click", () => sessionPatch({ tab: b.getAttribute("data-tab") })));
    scheduleAutoSync("boot");        // #10: opt-in backup-sync — try once after boot restore settles
  }, 0);
  syncAngleEnabled();
  $("build").addEventListener("click", () => buildRoute());
  // Toggling the spray-footprint overlay rebuilds at once so it appears/disappears
  // immediately (viz is only honoured at build time, so a plain toggle did nothing).
  if ($("viz-coverage")) $("viz-coverage").addEventListener("change", () => {
    if (boundaryFromPolygon()) buildRoute();
  });
  if ($("edit-contour")) $("edit-contour").addEventListener("click", () => setContourEdit(!editingContour));

  // Warm the offline planning engine (Pyodide) when the app is idle, so the
  // FIRST "Build" isn't a 2-5 s cold boot. Deferred until AFTER the map settles
  // and scheduled in an idle slot, so it can't contend with tile loading (that
  // contention is what made an earlier eager warm stutter). Skipped on the Qt
  // desktop (it uses the Python /api engine, not Pyodide).
  //
  // NOT on the native APK: there the engine runs MAIN-THREAD (a Web Worker can't fetch
  // through the WebView asset bridge), so warming Pyodide (~28 MB WASM) right after
  // launch JANKS the UI — exactly the "lags right after opening" Ivan saw. On the APK it
  // loads lazily on the first «Побудувати» (with its own progress message) instead.
  const _engineMainThread = /FMPAndroid/i.test(navigator.userAgent || "");
  if (!IS_QT && !_engineMainThread && window.FMP_ENGINE) {
    let _warmed = false;
    const warm = () => {
      if (_warmed) return;
      _warmed = true;
      const idle = window.requestIdleCallback || ((f) => setTimeout(f, 1500));
      idle(() => { try { if (FMP_ENGINE.available()) FMP_ENGINE.init().catch(() => {}); } catch (e) {} });
    };
    map.whenReady(() => setTimeout(warm, 2000));
  }

  // ---- mobile panel drawer ------------------------------------------------
  function setPanel(open) {
    // SAFETY: always clear any leftover inline transform / dragging class so the panel
    // can never end up shoved off-screen while `panel-open` hides the map controls (that
    // left the app with NO reachable controls — a swipe whose touchend never fired).
    const pnl = $("panel");
    if (pnl) { pnl.classList.remove("panel-dragging"); pnl.style.transform = ""; }
    document.body.classList.toggle("panel-open", open);
    // Leaflet must re-measure after the panel slides over / off the map.
    setTimeout(() => { try { map.invalidateSize(); } catch (e) {} }, 260);
  }
  if ($("panel-toggle")) $("panel-toggle").addEventListener("click",
    () => setPanel(!document.body.classList.contains("panel-open")));
  if ($("panel-scrim")) $("panel-scrim").addEventListener("click", () => setPanel(false));
  if ($("panel-close")) $("panel-close").addEventListener("click", () => setPanel(false));
  // Swipe the panel LEFT to close it. We DO NOT move the panel with the finger — an
  // interrupted swipe (system back-gesture, lost touchend) would otherwise leave the
  // panel translated off-screen with `panel-open` still on = no controls, app stuck
  // (Ivan's screenshot). Instead we just detect a completed left-swipe and close.
  (function panelSwipe() {
    const panel = $("panel");
    if (!panel) return;
    let sx = null, sy = null, mode = 0;   // 0=undecided, 1=horizontal(close), -1=vertical(scroll)
    panel.addEventListener("touchstart", (e) => {
      if (!document.body.classList.contains("panel-open") || e.touches.length !== 1) { sx = null; return; }
      sx = e.touches[0].clientX; sy = e.touches[0].clientY; mode = 0;
    }, { passive: true });
    panel.addEventListener("touchmove", (e) => {
      if (sx == null || mode !== 0) return;
      const dx = e.touches[0].clientX - sx, dy = e.touches[0].clientY - sy;
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      mode = Math.abs(dx) > Math.abs(dy) + 6 ? 1 : -1;   // decide once; no live transform
    }, { passive: true });
    const endSwipe = (e) => {
      if (sx == null) { mode = 0; return; }
      const t = (e.changedTouches && e.changedTouches[0]) || null;
      const dx = t ? t.clientX - sx : 0;
      if (mode === 1 && dx < -55) setPanel(false);   // completed left-swipe → close
      sx = null; mode = 0;
    };
    panel.addEventListener("touchend", endSwipe, { passive: true });
    panel.addEventListener("touchcancel", endSwipe, { passive: true });
  })();

  // The offline engine (Pyodide, ~28 MB) loads LAZILY on the first "Build route"
  // — not on page open — so opening the app and zooming the map stay smooth.
  // buildRoute() shows a "preparing engine…" message and runs it in a worker.

  $("exp-wp").addEventListener("click", () => doExport("waypoints"));
  $("exp-plan").addEventListener("click", () => doExport("plan"));
  $("exp-fence").addEventListener("click", () => doExport("fence_plan"));
  $("exp-fencemp").addEventListener("click", () => doExport("fence_mp"));
  $("exp-geojson").addEventListener("click", () => doExport("contour_geojson"));

  // ---- offline map: pre-download satellite tiles for the field / current view
  // so the map renders with no internet in the field. Fetching each tile makes
  // the service worker cache it (it caches opaque cross-origin GETs); offline,
  // Leaflet's tile <img> requests are then served from that cache.
  function lon2tile(lon, z) { return Math.floor((lon + 180) / 360 * Math.pow(2, z)); }
  function lat2tile(lat, z) {
    const r = lat * Math.PI / 180;
    return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z));
  }
  function tileUrlFor(layer, x, y, z) {
    const o = layer.options;
    const s = o.subdomains ? o.subdomains[Math.abs(x + y) % o.subdomains.length] : "";
    return L.Util.template(layer._url, L.Util.extend({ s, x, y, z, r: "" }, o));
  }
  async function downloadOfflineMap() {
    // Qt desktop caches tiles server-side (serve.py /tiles/ → disk); the PWA caches
    // them in the service worker. Only block a plain browser that has neither.
    if (!IS_QT && !("serviceWorker" in navigator)) {
      setMsg("Офлайн-карта недоступна в цьому середовищі.", null);
      return;
    }
    const layers = [];
    map.eachLayer((l) => { if (l instanceof L.TileLayer) layers.push(l); });
    if (!layers.length) { setMsg("Немає активного шару карти.", "error"); return; }
    const b = drawnItems.getLayers().length ? drawnItems.getBounds().pad(0.25) : map.getBounds();
    const zmin = Math.max(11, Math.min(13, Math.floor(map.getZoom())));
    const urls = [];
    for (const layer of layers) {
      const zmax = Math.min(18, layer.options.maxNativeZoom || layer.options.maxZoom || 18);
      for (let z = zmin; z <= zmax; z++) {
        const xs = [lon2tile(b.getWest(), z), lon2tile(b.getEast(), z)];
        const ys = [lat2tile(b.getNorth(), z), lat2tile(b.getSouth(), z)];
        for (let x = Math.min(...xs); x <= Math.max(...xs); x++)
          for (let y = Math.min(...ys); y <= Math.max(...ys); y++)
            urls.push(tileUrlFor(layer, x, y, z));
      }
    }
    if (!urls.length) { setMsg("Немає тайлів для завантаження.", "error"); return; }
    if (urls.length > 4000 && !confirm(`Це ~${urls.length} тайлів — багато. Намалюй поле або зменши масштаб. Все одно качати?`)) return;
    $("dl-map").disabled = true;
    let done = 0, fail = 0, i = 0;
    setMsg(`Завантажую карту офлайн: 0/${urls.length}…`, null);
    await new Promise((resolve) => {
      const next = () => {
        if (i >= urls.length) return;
        const u = urls[i++];
        fetch(u, { mode: "no-cors" }).catch(() => { fail++; }).finally(() => {
          done++;
          if (done % 30 === 0) setMsg(`Завантажую карту офлайн: ${done}/${urls.length}…`, null);
          if (done >= urls.length) resolve(); else next();
        });
      };
      for (let k = 0; k < 8; k++) next();
    });
    $("dl-map").disabled = false;
    setMsg(`Карту збережено офлайн: ${urls.length} тайлів${fail ? ` (${fail} пропущено)` : ""}. Район працює без мережі.`, "ok");
  }
  $("dl-map").addEventListener("click", downloadOfflineMap);
  $("clear").addEventListener("click", () => {
    setContourEdit(false);
    const _eb = $("edit-contour"); if (_eb) _eb.disabled = true;
    drawnItems.clearLayers();
    exclusionItems.clearLayers();
    renderHazardList();            // #13: hazards live in drawnItems (already cleared) → refresh the sidebar
    if (sectorsLayer) { map.removeLayer(sectorsLayer); sectorsLayer = null; }
    fieldPolygon = null;
    setFieldArea();                // remove the live area label
    clearAnchor(true);
    clearRoute();
    scheduleSaveField();           // field cleared → drop the auto-saved contour
    setMsg("", null);
  });
  $("add-exclusion").addEventListener("click", () => {
    if (exclusionEditMode) setExclusionEdit(false);
    startExclusionDraw();
  });
  $("edit-exclusions").addEventListener("click", () => setExclusionEdit(!exclusionEditMode));
  $("clear-exclusions").addEventListener("click", () => {
    if (exclusionEditMode) setExclusionEdit(false);
    exclusionItems.clearLayers();
    clearRoute();
    setMsg("Вирізи очищено.", null);
  });
  // Explicit "save cutouts" — mirrors the field contour's "Готово": commit any
  // in-progress draw or vertex-edit so the cutout is finalized and applied to the
  // route. Cutouts persist with the project (collectExclusions -> «Зберегти»).
  $("save-exclusions").addEventListener("click", () => {
    cancelToolbarDraw(); drawingExclusion = false;
    if (exclusionEditMode) setExclusionEdit(false);   // commits nodes + clearRoute
    const n = collectExclusions().length;
    clearRoute();                                      // next build uses the saved cutouts
    setMsg(n ? `Вирізи збережено (${n}). Зберігаються з проєктом («Зберегти»). Перебудуй маршрут.`
             : "Немає вирізів. Намалюй виріз (Додати виріз).", n ? "ok" : null);
  });
  // ---- operator «my location» (live blue dot) + field elevation --------------
  // NOTE: no route anchor any more — «my location» and the drone marker are pure
  // display and DO NOT affect mission building (Ivan).
  let myPosition = null;          // operator GPS (geolocation), {lat,lng}
  // Show the route home (= field centroid, computed by the engine) + its ground
  // elevation beside «Висота польоту (над точкою зльоту)» after a build.
  let _takeoffElevSeq = 0;
  function updateTakeoffInfo(home) {
    const el = $("takeoff-info");
    if (!el) return;
    const pt = (home && home.lat != null) ? home : null;
    if (!pt) {
      el.textContent = "Точка зльоту: центр поля (з'явиться після побудови маршруту).";
      return;
    }
    const ll = pt.lat.toFixed(5) + ", " + pt.lng.toFixed(5);
    el.textContent = "Точка зльоту (центр поля): " + ll + " · висота ґрунту…";
    const seq = ++_takeoffElevSeq;
    fetch("https://api.open-meteo.com/v1/elevation?latitude=" + pt.lat.toFixed(6) + "&longitude=" + pt.lng.toFixed(6))
      .then((r) => r.json())
      .then((j) => {
        if (seq !== _takeoffElevSeq) return;        // a newer takeoff superseded this
        const e = j && j.elevation && j.elevation[0];
        el.textContent = "Точка зльоту (центр поля): " + ll +
          (e != null ? " · висота ґрунту ~" + Math.round(e) + " м" : "");
      })
      .catch(() => { if (seq === _takeoffElevSeq) el.textContent = "Точка зльоту (центр поля): " + ll; });
  }
  // ---- LIVE «my location»: a blue dot that follows the operator (DISPLAY ONLY,
  // does NOT affect mission building). Toggled by the «Моє місце» button.
  let myWatchId = null, myLocMarker = null, myLocCircle = null, myCentered = false, myLocOn = false;
  function updateMyLocBtn() { if (_locateBtn) _locateBtn.classList.toggle("active", myLocOn); }
  function myLocIcon(hdg) {
    const beam = (hdg != null && !isNaN(hdg))
      ? '<div class="myloc-beam" style="transform:translate(-50%,-100%) rotate(' + hdg + 'deg)"></div>' : "";
    return L.divIcon({ className: "myloc", html: beam + '<div class="myloc-dot"></div>',
      iconSize: [30, 30], iconAnchor: [15, 15] });
  }
  function onMyPos(pos) {
    const ll = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    myPosition = ll;
    const acc = pos.coords.accuracy || 0;
    const hdg = (pos.coords.heading != null && !isNaN(pos.coords.heading)
      && pos.coords.speed != null && pos.coords.speed > 0.6) ? pos.coords.heading : null;
    if (!myLocMarker) {
      myLocMarker = L.marker([ll.lat, ll.lng], { icon: myLocIcon(hdg), zIndexOffset: 1600 })
        .addTo(map).bindTooltip("Я тут");
    } else { myLocMarker.setLatLng([ll.lat, ll.lng]); myLocMarker.setIcon(myLocIcon(hdg)); }
    if (acc > 0) {
      if (!myLocCircle) myLocCircle = L.circle([ll.lat, ll.lng], { radius: acc, color: "#2d7ff9",
        weight: 1, opacity: 0.4, fillColor: "#2d7ff9", fillOpacity: 0.10, interactive: false }).addTo(map);
      else { myLocCircle.setLatLng([ll.lat, ll.lng]); myLocCircle.setRadius(acc); }
    }
    if (!myCentered) { myCentered = true; map.setView([ll.lat, ll.lng], Math.max(map.getZoom(), 15)); }
  }
  function startMyLocation() {
    if (!navigator.geolocation) { setMsg("Геолокація недоступна на цьому пристрої.", "error"); return; }
    myLocOn = true; myCentered = false; updateMyLocBtn();
    setMsg("Шукаю ваше розташування…", null);
    // fast first dot via network, then continuous precise tracking
    navigator.geolocation.getCurrentPosition(
      (pos) => { onMyPos(pos); setMsg("Показую ваше розташування наживо.", "ok");
        appLog("GPS «мій»: live ON ±" + Math.round(pos.coords.accuracy || 0) + "м"); },
      () => {}, { enableHighAccuracy: false, timeout: 8000, maximumAge: 120000 });
    if (myWatchId == null) {
      myWatchId = navigator.geolocation.watchPosition(onMyPos, (err) => {
        appLog("GPS «мій» watch FAIL code=" + ((err && err.code) || "?") + " " + ((err && err.message) || ""));
        if (err && err.code === 1)
          setMsg("Локація заборонена. Дозволь: Налаштування → Додатки → Field Mission Planner → Дозволи → Локація.", "error");
        else if (!myLocMarker)
          setMsg("Не вдалося отримати GPS. Вийди на відкрите небо й спробуй ще раз.", "error");
      }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 1500 });
    }
  }
  function stopMyLocation() {
    if (myWatchId != null) { try { navigator.geolocation.clearWatch(myWatchId); } catch (e) {} myWatchId = null; }
    if (myLocMarker) { map.removeLayer(myLocMarker); myLocMarker = null; }
    if (myLocCircle) { map.removeLayer(myLocCircle); myLocCircle = null; }
    myLocOn = false; updateMyLocBtn();
  }
  // Toggle live my-location — called by the map «» toolbar control.
  function toggleMyLocation() {
    if (myWatchId != null) { stopMyLocation(); setMsg("Показ розташування вимкнено.", null); }
    else startMyLocation();
  }
  // Kept for the «Очистити» button: stop my-location + reset the takeoff line.
  function clearAnchor(quiet) {
    stopMyLocation();
    updateTakeoffInfo();
    if (!quiet) setMsg("", null);
  }

  // ---- project save / load -------------------------------------------------
  function collectParams() {
    return {
      spacing: parseFloat($("spacing").value),
      boom: parseFloat($("boom").value) || "",
      angle: parseFloat($("angle").value),
      auto_angle: $("auto_angle").checked,
      margin: parseFloat($("margin").value) || 0,
      alt: parseFloat($("alt").value),
      speed: parseFloat($("speed").value),
      rtl: $("rtl").checked,
      viz: $("viz-coverage") ? $("viz-coverage").checked : false,
      round_turn: $("round-turn") ? $("round-turn").checked : false,
      // Fixed-wing (auto by connected FC type = fixed_wing): the engine replaces sharp
      // pass-end U-turns with contained arcs (R=spacing/2, passes shortened). Copter
      // keeps the WP_RADIUS round-turn. Needs the round-turn toggle on + a plane heartbeat.
      plane_turn: !!($("round-turn") && $("round-turn").checked && isPlaneVehicle()),
      // #12p3: opt-in geofence upload — persisted like the neighbours, default OFF.
      fence_upload: $("fence-upload") ? $("fence-upload").checked : false,
    };
  }
  // A plane is a plane even if you plan the route BEFORE connecting: remember the
  // last-seen fixed-wing so an offline build still adds the arcs.
  function isPlaneVehicle() {
    if (lastStatus && lastStatus.vehicle_type === 1) return true;
    try { return localStorage.getItem("fmp_is_plane") === "1"; } catch (e) { return false; }
  }
  // Autopilot params so a fixed-wing FLIES the planned R=spacing/2 arcs instead of
  // cutting them (mirror of engine backend/plane_turns.py:plane_turn_params — keep the
  // two in sync): cap cruise so min turn radius V²/(g·tanφ) ≤ R; L1 look-ahead
  // (NAVL1·V/π) ≈ 0.6·R to track the arc; small WP_RADIUS.
  //
  // MIN_AIRSPEED is a floor below any real fixed-wing's minimum flying speed. At a
  // tight enough spacing/turn radius, the R-feasible cruise (capped by vMax below) can
  // fall BELOW that floor — audit finding: the old code then clamped it back UP to an
  // arbitrary 1 m/s "safe-looking" positive number instead of admitting the arc is
  // unflyable, which would have commanded a stall-adjacent AIRSPEED_CRUISE to the
  // airframe. Return null instead — the caller must skip pushing plane params entirely
  // (arcs stay untuned / effectively off) rather than fly an impossible cruise speed.
  const PLANE_MIN_AIRSPEED = 12.0;
  function planeTurnParams(spacing, cruise) {
    const R = Math.max(spacing / 2, 1), g = 9.81, bank = 45;
    const vMax = Math.sqrt(0.4 * g * R * Math.tan(bank * Math.PI / 180));
    const V = Math.min(cruise || 12, vMax);
    if (V < PLANE_MIN_AIRSPEED) return null;
    const navl1 = Math.max(6, Math.min(20, 0.6 * Math.PI * R / V));
    return {
      AIRSPEED_CRUISE: Math.round(V * 10) / 10,
      ROLL_LIMIT_DEG: bank,
      NAVL1_PERIOD: Math.round(navl1 * 10) / 10,
      WP_RADIUS: Math.max(3, Math.round(R / 8)),
    };
  }
  function applyParams(p) {
    if (!p) return;
    const set = (id, v) => { if (v !== undefined && v !== null && $(id)) $(id).value = v; };
    set("spacing", p.spacing); set("boom", p.boom); set("angle", p.angle); set("margin", p.margin);
    set("alt", p.alt); set("speed", p.speed);
    if ($("auto_angle")) $("auto_angle").checked = !!p.auto_angle;
    if ($("rtl")) $("rtl").checked = p.rtl !== false;
    // viz-coverage (spray-footprint overlay) persists its state; default OFF when
    // unset so a fresh install / a project saved before this field doesn't force it on.
    if ($("viz-coverage")) $("viz-coverage").checked = !!p.viz;
    if ($("round-turn")) { $("round-turn").checked = !!p.round_turn; syncRoundTurnHint(); }
    if ($("fence-upload")) $("fence-upload").checked = !!p.fence_upload;
    if (p.angle != null) {
      set("angle-range", p.angle);
      if ($("angle-val")) $("angle-val").textContent = Math.round(p.angle) + "°";
    }
    syncAngleEnabled();
  }

  // ---- persist the last-used mission settings (auto-restore next launch) -----
  // Separate from named projects: just the working params of the last session, so
  // reopening the app pre-fills what you used last time.
  function saveLastSettings() {
    try {
      localStorage.setItem("fmp_last_settings", JSON.stringify({
        params: collectParams(),
      }));
    } catch (e) { /* private mode / quota — ignore */ }
  }
  function restoreLastSettings() {
    let s;
    try { s = JSON.parse(localStorage.getItem("fmp_last_settings") || "null"); }
    catch (e) { return; }
    if (!s) return;
    applyParams(s.params);
    // The anchor (a live GPS pick) is intentionally NOT restored — it needs a fresh fix.
  }
  let _settingsTimer = null;
  function scheduleSaveSettings() {
    if (_settingsTimer) clearTimeout(_settingsTimer);
    _settingsTimer = setTimeout(saveLastSettings, 400);
  }
  // Projects are stored LOCALLY in the browser (localStorage) — offline, private
  // to this device, never on the server. So sharing the app with someone else
  // never mixes your saved fields with theirs.
  function lpAll() { try { return JSON.parse(localStorage.getItem("fmp_projects") || "{}"); } catch (e) { return {}; } }
  function lpSaveAll(o) { localStorage.setItem("fmp_projects", JSON.stringify(o)); }
  function lpSave(name, data) { const o = lpAll(); o[name] = Object.assign({ ts: Date.now() }, data); lpSaveAll(o); }
  function lpDelete(name) { const o = lpAll(); delete o[name]; lpSaveAll(o); }

  // ---- field store: IndexedDB (v2.5), migrated from the localStorage projects --
  // Structured + larger capacity than the localStorage blob; localStorage stays as
  // a fallback (private mode) and for the .json file import/export.
  let currentFieldName = "";        // name of the loaded/saved field (for work records)
  let lastFieldAreaHa = 0;          // total field area from the last build (for the store)
  let lastWorkContext = null;       // {field,area_ha,sprayed_ha,liquid_l,sections} of last build
  const FLD_DB = "fmp_fields", FLD_STORE = "fields";
  function fldOpen() {
    return new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(FLD_DB, 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => { req.result.createObjectStore(FLD_STORE, { keyPath: "name" }); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function fldPut(rec) {
    try {
      const db = await fldOpen();
      await new Promise((res, rej) => {
        const tx = db.transaction(FLD_STORE, "readwrite");
        tx.objectStore(FLD_STORE).put(rec);
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
      return true;
    } catch (e) { return false; }
  }
  async function fldAll() {
    try {
      const db = await fldOpen();
      return await new Promise((res, rej) => {
        const rq = db.transaction(FLD_STORE, "readonly").objectStore(FLD_STORE).getAll();
        rq.onsuccess = () => res(rq.result || []);
        rq.onerror = () => rej(rq.error);
      });
    } catch (e) { return null; }     // null = IDB unavailable -> caller uses localStorage
  }
  async function fldDelete(name) {
    try {
      const db = await fldOpen();
      await new Promise((res, rej) => {
        const tx = db.transaction(FLD_STORE, "readwrite");
        tx.objectStore(FLD_STORE).delete(name);
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
      return true;
    } catch (e) { return false; }
  }
  // Wipe every saved field. Used ONLY by a backup-sync restore (#10 review I2) — an
  // honest overwrite must not let a field deleted on another device resurrect here.
  async function fldClearAll() {
    try {
      const db = await fldOpen();
      await new Promise((res, rej) => {
        const tx = db.transaction(FLD_STORE, "readwrite");
        tx.objectStore(FLD_STORE).clear();
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
      return true;
    } catch (e) { return false; }
  }
  async function migrateProjectsToIDB() {     // one-time, idempotent
    try {
      if (localStorage.getItem("fmp_fields_migrated")) return;
      const old = JSON.parse(localStorage.getItem("fmp_projects") || "{}");
      for (const name of Object.keys(old)) {
        const p = old[name] || {};
        await fldPut({ name, field: p.field || [], params: p.params || {},
          exclusions: p.exclusions || [], created: p.ts || Date.now(),
          updated: p.ts || Date.now(), area_ha: p.area_ha || 0 });
      }
      localStorage.setItem("fmp_fields_migrated", "1");
    } catch (e) { /* private mode / parse error — keep using localStorage */ }
  }
  migrateProjectsToIDB();

  // Apply a loaded project (field + params + exclusions) to the map/UI.
  function applyProject(proj) {
    applyParams(proj.params);
    exclusionItems.clearLayers();
    removeByKind("split");          // drop the previous field's split lines (bug-hunt #1)
    hazardItems.clearLayers();      // #13: drop the previous field's hazards (else they leak into the new build/save)
    (Array.isArray(proj.hazards) ? proj.hazards : []).forEach((m) => { if (m && m.geom && m.geom.length) addHazardLayer(m); });
    renderHazardList();
    if (sectorsLayer) { map.removeLayer(sectorsLayer); sectorsLayer = null; }
    if (Array.isArray(proj.exclusions)) {
      proj.exclusions.forEach((ex) => {
        if (ex && ex.length >= 3) addExclusionLayer(L.polygon(ex.map((p) => [p.lat, p.lng])));
      });
    }
    if (proj.field && proj.field.length >= 3) {
      const poly = L.polygon(proj.field.map((p) => [p.lat, p.lng]), { color: "#2d7ff9", weight: 2 });
      adoptField(poly);
    }
  }

  // ---- «Показати всі поля на карті»: visualise every saved contour at once; tap
  // one to SELECT it for work + mission building. ------------------------------
  let overviewLayer = null;
  function clearSavedOverview() { if (overviewLayer) { map.removeLayer(overviewLayer); overviewLayer = null; } }
  async function showSavedFields() {
    let recs = await fldAll();
    if (recs === null) { const o = lpAll(); recs = Object.keys(o).map((n) => Object.assign({ name: n }, o[n])); }
    recs = (recs || []).filter((r) => r.field && r.field.length >= 3);
    if (!recs.length) { setMsg("Немає збережених полів. Намалюй контур і збережи ().", null); return; }
    clearSavedOverview();
    overviewLayer = L.layerGroup().addTo(map);
    let bounds = null;
    recs.forEach((r) => {
      const ll = r.field.map((p) => [p.lat, p.lng]);
      const poly = L.polygon(ll, { color: "#2d7ff9", weight: 2, fillOpacity: 0.14 }).addTo(overviewLayer);
      bounds = bounds ? bounds.extend(poly.getBounds()) : poly.getBounds();
      (r.exclusions || []).forEach((ex) => {
        if (ex && ex.length >= 3) L.polygon(ex.map((p) => [p.lat, p.lng]),
          { color: "#ff4d4d", weight: 1.5, fillOpacity: 0.18, dashArray: "4 4", interactive: false }).addTo(overviewLayer);
      });
      const ha = (L.GeometryUtil.geodesicArea(ll.map((c) => L.latLng(c[0], c[1]))) / 1e4) || 0;
      const doneHa = +(r.done_ha) || 0, areaHa = r.area_ha || ha, cc = r.completed_count | 0;
      const leftHa = Math.max(0, areaHa - doneHa);            // done_ha NOT capped (cumulative partials)
      L.marker(poly.getBounds().getCenter(), { interactive: false, keyboard: false, zIndexOffset: 500,
        icon: L.divIcon({ className: "area-label field",
          html: "<span><b>" + esc(r.name || "Поле") + "</b><br>" + ha.toFixed(2) + " га<br>"
            + tf("зроблено {0} · лишилось {1} га", doneHa.toFixed(1), leftHa.toFixed(1)) + "<br>"
            + tf("виконано {0} {1}", cc, plurCount(cc)) + "</span>",
          iconSize: [178, 62], iconAnchor: [89, 31] }) }).addTo(overviewLayer);
      poly.bindTooltip("Натисни, щоб працювати з «" + esc(r.name || "Поле") + "»");
      poly.on("click", (e) => {
        L.DomEvent.stop(e); clearSavedOverview();
        applyProject(r); currentFieldName = r.name || "";
        setMsg("Поле «" + (r.name || "Поле") + "» обрано для роботи. Натисни «Побудувати маршрут».", "ok");
      });
    });
    if (bounds) map.fitBounds(bounds, { padding: [50, 50] });
    setMsg(tf("{0} збережених полів на карті — натисни на поле, щоб обрати для роботи.", recs.length), "ok");
  }
  if ($("show-saved")) $("show-saved").addEventListener("click", showSavedFields);

  // Cheap contour-identity heuristic for the promoteFieldOnUpload guard below: same
  // centroid (within GPS/redraw noise) AND comparable area. Good enough to tell "this is a
  // WHOLE DIFFERENT field" apart from "the same field, re-surveyed/nudged a bit" without
  // an expensive polygon-overlap computation.
  function sameFieldGeometry(a, b) {
    if (!a || !b || a.length < 3 || b.length < 3) return false;
    const centroid = (r) => {
      let la = 0, lo = 0; r.forEach((p) => { la += p.lat; lo += p.lng; });
      return { lat: la / r.length, lng: lo / r.length };
    };
    const ca = centroid(a), cb = centroid(b);
    if (haversineM(ca.lat, ca.lng, cb.lat, cb.lng) > 250) return false;   // centroids far apart -> different field
    const areaA = _haOf(a), areaB = _haOf(b);
    if (areaA > 0 && areaB > 0) {
      const ratio = areaA > areaB ? areaA / areaB : areaB / areaA;
      if (ratio > 1.75) return false;                                    // wildly different size -> different field
    }
    return true;
  }
  // On upload: promote the current contour to a persistent named record (the promise
  // "Автозбереження — при заливці в дрон"). UPSERT by name so a re-upload of the same field
  // updates rather than duplicates; a freshly-drawn (unnamed) field mints "Поле N" ONCE and
  // adopts that name so subsequent uploads hit the same record.
  async function promoteFieldOnUpload() {
    const field = boundaryFromPolygon();
    if (!field || field.length < 3) return;                 // nothing to save
    let recs = await fldAll();
    const useLp = recs === null;                            // IDB unavailable → localStorage fallback
    if (useLp) { const o = lpAll(); recs = Object.keys(o).map((n) => Object.assign({ name: n }, o[n])); }
    let name = currentFieldName;
    if (!name) {
      const names = new Set((recs || []).map((r) => r.name));
      let n = 1; while (names.has("Поле " + n)) n++;
      name = "Поле " + n; currentFieldName = name;          // adopt so re-uploads UPSERT this record
    }
    // Propagate the (possibly just-minted) name into the work context so a flight armed after
    // this upload — without a rebuild — credits THIS field (#8), not the stale generic "поле".
    if (lastWorkContext) lastWorkContext.field = name;
    let prev = (recs || []).find((r) => r.name === name);
    // Guard (verified finding): fmp_current_field is only persisted on beforeunload and
    // right here — NOT on a field switch (showSavedFields tap / load-project), so an
    // Android kill between switching fields and this upload can leave currentFieldName
    // pointing at a DIFFERENT saved record than what's actually on screen now. UPSERTing
    // blindly by that stale name would silently overwrite an unrelated field's saved
    // contour/params/hazards with THIS field's geometry. If the existing record under
    // `name` looks nothing like the contour we're about to save, treat it as a stale
    // pairing — mint a fresh name instead of clobbering it.
    if (prev && prev.field && prev.field.length >= 3 && !sameFieldGeometry(prev.field, field)) {
      appLog("promoteFieldOnUpload: currentFieldName «" + name + "» geometry doesn't match its saved record " +
             "(stale fmp_current_field after a kill/restore?) — minting a new name instead of UPSERT-clobbering it");
      const names = new Set((recs || []).map((r) => r.name));
      let n = 1; while (names.has("Поле " + n)) n++;
      name = "Поле " + n; currentFieldName = name;
      if (lastWorkContext) lastWorkContext.field = name;
      prev = null;
    }
    const now = Date.now();
    const rec = { name, field, params: collectParams(), exclusions: collectExclusions(), hazards: collectHazards(),
      created: (prev && prev.created) || now, updated: now, area_ha: lastFieldAreaHa || 0, uploaded_at: now,
      // MERGE-preserve #8 cycle progress across re-uploads (else every upload zeroes it)
      done_ha: (prev && +prev.done_ha) || 0, completed_count: (prev && prev.completed_count) || 0,
      last_flight_at: (prev && prev.last_flight_at) || null };
    const ok = useLp ? false : await fldPut(rec);
    if (!ok) { try { lpSave(name, rec); } catch (e) {} }
    try { localStorage.setItem("fmp_current_field", name); } catch (e) {}   // for boot restore (Task 7)
    appLog("field promoted on upload: «" + name + "» (upsert)");
  }
  $("save-project").addEventListener("click", async () => {
    const field = boundaryFromPolygon();
    if (!field || field.length < 3) { setMsg("Спочатку задай поле.", "error"); return; }
    // AUTOMATIC unique name — no prompt, never overwrites an existing field (Ivan).
    // «Поле N» with the smallest free N among the already-saved fields.
    let recs = await fldAll();
    if (recs === null) { const o = lpAll(); recs = Object.keys(o).map((n) => ({ name: n })); }
    const names = new Set((recs || []).map((r) => r.name));
    let n = 1; while (names.has("Поле " + n)) n++;
    const name = "Поле " + n;
    const now = Date.now();
    const rec = { name, field, params: collectParams(), exclusions: collectExclusions(), hazards: collectHazards(),
      created: now, updated: now, area_ha: lastFieldAreaHa || 0,
      done_ha: 0, completed_count: 0, last_flight_at: null };
    const ok = await fldPut(rec);
    if (!ok) { try { lpSave(name, rec); } catch (e) { setMsg("Не вдалося зберегти: " + e, "error"); return; } }
    currentFieldName = name;
    setMsg(`Поле збережено автоматично як «${name}» (на цьому пристрої).`, "ok");
  });

  $("load-project").addEventListener("click", async () => {
    let recs = await fldAll();
    if (recs === null) {                       // IDB unavailable -> localStorage fallback
      const o = lpAll(); recs = Object.keys(o).map((n) => Object.assign({ name: n }, o[n]));
    }
    if (!recs.length) { setMsg("Збережених полів немає — імпортую з файлу…", null); $("load-file").click(); return; }
    recs.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    const list = recs.map((r, i) => {
      const ha = r.area_ha ? ` · ${r.area_ha} га` : "";
      const d = r.updated ? " · " + new Date(r.updated).toISOString().slice(0, 10) : "";
      const dn = +(r.done_ha) || 0, cc = r.completed_count | 0;
      const prog = (dn > 0 || cc > 0) ? ` · зроблено ${dn.toFixed(1)} га · ×${cc}` : "";
      return `${i + 1}. ${r.name}${ha}${prog}${d}`;
    }).join("\n");
    const ans = (prompt(`Поля на цьому пристрої:\n${list}\n\nНОМЕР — відкрити · «del N» — видалити · «file» — з файлу:`) || "").trim();
    if (!ans) return;
    if (ans.toLowerCase() === "file") { $("load-file").click(); return; }
    const dm = ans.match(/^del\s+(\d+)$/i);
    if (dm) {
      const r = recs[+dm[1] - 1];
      if (r) { if (!(await fldDelete(r.name))) { try { lpDelete(r.name); } catch (e) {} } setMsg(`Поле «${r.name}» видалено.`, "ok"); }
      return;
    }
    const idx = parseInt(ans, 10) - 1;
    if (idx >= 0 && idx < recs.length) {
      applyProject(recs[idx]); currentFieldName = recs[idx].name;
      setMsg(`Поле «${recs[idx].name}» завантажено.`, "ok");
    } else setMsg("Невірний вибір.", "error");
  });

  // File import (for projects shared as a .fmproj.json file) stays available.
  $("load-file").addEventListener("change", (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try { applyProject(JSON.parse(reader.result)); setMsg("Проєкт завантажено з файлу.", "ok"); }
      catch (e) { setMsg("Помилка читання проєкту: " + e, "error"); }
    };
    reader.readAsText(file);
    ev.target.value = "";
  });

  // ---- KML import/export of the field contour (offline, no deps) -------------
  // KML rings are `lon,lat,alt` triples; the field is the outer ring, each cutout
  // an inner ring (= a polygon hole), so it round-trips through other GIS tools.
  function buildKml(field, exclusions) {
    const ring = (pts) => {
      const body = pts.map((p) => `${p.lng},${p.lat},0`).join(" ");
      return pts.length ? `${body} ${pts[0].lng},${pts[0].lat},0` : "";   // close ring
    };
    const inner = (exclusions || []).filter((e) => e.length >= 3).map((ex) =>
      `<innerBoundaryIs><LinearRing><coordinates>${ring(ex)}</coordinates></LinearRing></innerBoundaryIs>`
    ).join("");
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>\n' +
      '<Placemark><name>Field Mission Planner</name><Polygon>' +
      `<outerBoundaryIs><LinearRing><coordinates>${ring(field)}</coordinates></LinearRing></outerBoundaryIs>` +
      `${inner}</Polygon></Placemark>\n</Document></kml>\n`;
  }
  async function exportKml() {
    const field = boundaryFromPolygon();
    if (!field || field.length < 3) { setMsg("Спочатку задай поле на карті.", "error"); return; }
    await downloadBlob("field.kml", "application/vnd.google-earth.kml+xml", buildKml(field, collectExclusions()));
    setMsg("Контур експортовано в .kml.", "ok");
  }
  // Real-world KMLs vary a lot — namespace prefixes (<kml:Polygon>), LineString-
  // traced fields, "lon, lat" with spaces, a UTF-8 BOM. Parse defensively into a
  // LIST of named contours so a multi-field KML can be browsed on the map like the
  // saved-fields overview, and any subset unioned into one field.
  function _kmlTags(root, name) {                 // namespace-agnostic element lookup
    let els = [];
    if (root.getElementsByTagNameNS) els = Array.prototype.slice.call(root.getElementsByTagNameNS("*", name));
    if (!els.length) els = Array.prototype.slice.call(root.getElementsByTagName(name));
    return els;
  }
  function _kmlCoords(text) {          // "lon,lat[,alt] ..." (tolerating "lon, lat") -> [{lat,lng}]
    if (!text) return [];
    return String(text).replace(/\s*,\s*/g, ",").trim().split(/\s+/).map((tok) => {
      const a = tok.split(","); return { lng: parseFloat(a[0]), lat: parseFloat(a[1]) };
    }).filter((p) => isFinite(p.lat) && isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180);
  }
  // KML text -> { ok, error, contours:[{ name, ring:[{lat,lng}], holes:[[{lat,lng}]] }] }
  function parseKmlContours(text) {
    const s = String(text || "").replace(/^﻿/, "").replace(/^\s+/, "");   // strip BOM + leading WS
    const doc = new DOMParser().parseFromString(s, "application/xml");
    if (_kmlTags(doc, "parsererror").length) return { ok: false, error: "Файл не є коректним KML/XML (можливо, це KMZ-архів — розпакуй у .kml)." };
    const out = [];
    const pms = _kmlTags(doc, "Placemark");
    const scopes = pms.length ? pms : [doc];
    scopes.forEach((pm) => {
      const nm = ((_kmlTags(pm, "name")[0] || {}).textContent || "").trim();
      const polys = _kmlTags(pm, "Polygon");
      if (polys.length) {
        polys.forEach((poly) => {
          const outerEl = _kmlTags(poly, "outerBoundaryIs")[0];
          let oc = outerEl ? _kmlTags(outerEl, "coordinates")[0] : null;
          if (!oc) oc = _kmlTags(poly, "coordinates")[0];
          const ring = oc ? _kmlCoords(oc.textContent) : [];
          if (ring.length < 3) return;
          const holes = [];
          _kmlTags(poly, "innerBoundaryIs").forEach((inr) =>
            _kmlTags(inr, "coordinates").forEach((c) => { const h = _kmlCoords(c.textContent); if (h.length >= 3) holes.push(h); }));
          out.push({ name: nm, ring: ring, holes: holes });
        });
      } else {                          // no Polygon → accept a traced LineString / LinearRing
        _kmlTags(pm, "LineString").concat(_kmlTags(pm, "LinearRing")).forEach((ln) => {
          const c = _kmlTags(ln, "coordinates")[0];
          const ring = c ? _kmlCoords(c.textContent) : [];
          if (ring.length >= 3) out.push({ name: nm, ring: ring, holes: [] });
        });
      }
    });
    if (!out.length) return { ok: false, error: "У KML не знайдено контуру (Polygon/LineString)." };
    out.forEach((c, i) => { if (!c.name) c.name = "Контур " + (i + 1); });
    return { ok: true, contours: out };
  }
  function _ptInRing(pt, ring) {         // ray-cast even-odd test (for union hole classification)
    let inside = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i].lng, yi = ring[i].lat, xj = ring[j].lng, yj = ring[j].lat;
      if (((yi > pt.lat) !== (yj > pt.lat)) && (pt.lng < (xj - xi) * (pt.lat - yi) / (yj - yi) + xi)) inside = !inside;
    } return inside;
  }
  function _haOf(ring) { try { return L.GeometryUtil.geodesicArea(ring.map((p) => L.latLng(p.lat, p.lng))) / 1e4; } catch (e) { return 0; } }
  // Merge several contours into ONE field via a morphological CLOSE (offset out →
  // union → offset in) so small gaps — the roads/paths between adjacent fields —
  // get filled and the fields become one continuous boundary. Worked in local metres
  // so the gap distance is real. -> { ok, outers:[[{lat,lng}]], holes:[[{lat,lng}]] }
  function unionContours(list) {
    const C = window.ClipperLib;
    if (!C) return { ok: false, error: "Модуль об'єднання недоступний." };
    let la = 0, lo = 0, n = 0;
    list.forEach((c) => c.ring.forEach((p) => { la += p.lat; lo += p.lng; n++; }));
    if (!n) return { ok: false, error: "Порожньо." };
    la /= n; lo /= n;
    const mlat = 111320, mlng = (111320 * Math.cos(la * Math.PI / 180)) || 1;
    const SC = 100, GAP = 20, D = GAP / 2;              // fill gaps (field roads) up to GAP metres
    const toClip = (ring) => ring.map((p) => ({ X: Math.round((p.lng - lo) * mlng * SC), Y: Math.round((p.lat - la) * mlat * SC) }));
    const toLL = (path) => path.map((pt) => ({ lng: lo + pt.X / SC / mlng, lat: la + pt.Y / SC / mlat }));
    const co = new C.ClipperOffset(2, 0.25 * SC);
    list.forEach((c) => co.AddPath(toClip(c.ring), C.JoinType.jtMiter, C.EndType.etClosedPolygon));
    let outP = new C.Paths(); co.Execute(outP, D * SC);             // 1) grow each field by D
    const cl = new C.Clipper(); cl.AddPaths(outP, C.PolyType.ptSubject, true);
    let uni = new C.Paths(); cl.Execute(C.ClipType.ctUnion, uni, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);  // 2) union
    const co2 = new C.ClipperOffset(2, 0.25 * SC); co2.AddPaths(uni, C.JoinType.jtMiter, C.EndType.etClosedPolygon);
    let fin = new C.Paths(); co2.Execute(fin, -D * SC);             // 3) shrink back by D
    if (!fin.length) return { ok: false, error: "Порожньо." };
    const outers = [], holes = [];
    fin.forEach((path) => { if (path.length >= 3) (C.Clipper.Area(path) > 0 ? outers : holes).push(toLL(path)); });
    list.forEach((c) => (c.holes || []).forEach((h) => { if (h.length >= 3) holes.push(h.slice()); }));  // keep exclusions
    return { ok: true, outers: outers, holes: holes };
  }
  // Adopt one parsed contour as the active field (+ its inner rings as exclusions).
  function adoptContour(c) {
    exclusionItems.clearLayers();
    removeByKind("split");          // drop the previous field's split lines
    if (sectorsLayer) { map.removeLayer(sectorsLayer); sectorsLayer = null; }
    adoptField(L.polygon(c.ring.map((p) => [p.lat, p.lng]), { color: "#2d7ff9", weight: 2 }));
    (c.holes || []).forEach((h) => { if (h.length >= 3) addExclusionLayer(L.polygon(h.map((p) => [p.lat, p.lng]))); });
    clearRoute();
  }
  // Multi-contour browse overlay (mirrors the saved-fields overview): draw every
  // imported contour, tap one to work with it, or 🔗 to union a contiguous subset.
  let importPickLayer = null, importPickBtn = null, importPickShowLbl = null, importPickHideLbl = null;
  function clearImportPick() {
    if (importPickShowLbl) { map.off("moveend zoomend", importPickShowLbl); map.off("movestart zoomstart", importPickHideLbl); importPickShowLbl = importPickHideLbl = null; }
    if (importPickLayer) { map.removeLayer(importPickLayer); importPickLayer = null; }
    if (importPickBtn && importPickBtn.parentNode) { importPickBtn.parentNode.removeChild(importPickBtn); importPickBtn = null; }
  }
  function showImportedContours(contours) {
    clearImportPick();
    if (typeof builder !== "undefined" && builder.cancel) builder.cancel(true);
    importPickLayer = L.layerGroup().addTo(map);
    const selected = new Set();          // indices the user has tapped
    const UNSEL = { color: "#2d7ff9", weight: 2, fillOpacity: 0.10 };
    const SEL = { color: "#2d7ff9", weight: 4, fillOpacity: 0.42 };   // same accent, clearly filled
    const areas = contours.map((c) => _haOf(c.ring));     // precompute once â geodesicArea is not cheap
    const polys = new Array(contours.length), centers = new Array(contours.length), labels = new Array(contours.length).fill(null);
    const LABEL_CAP = 50;                // guard vs a pathological huge file; normal multi-field files show all labels when idle
    let bounds = null;
    function labelIcon(i) {
      const on = selected.has(i);
      return L.divIcon({ className: "area-label field", html: "<span>" + (on ? "✓ " : "") + "<b>" + esc(contours[i].name) + "</b><br>" + areas[i].toFixed(2) + " га</span>", iconSize: [150, 38], iconAnchor: [75, 19] });
    }
    function paint(i) {
      polys[i].setStyle(selected.has(i) ? SEL : UNSEL);
      if (labels[i]) labels[i].setIcon(labelIcon(i));       // keep an existing label's check-mark in sync
    }
    // Perf: only labels for contours in view (or selected) exist as DOM markers; off-screen
    // ones are removed so panning/zooming a 40-field import stays smooth. Zoomed out so far
    // that too many are in view -> keep only the selected labels (the rest are unreadable anyway).
    function refreshLabels() {
      if (!importPickLayer) return;
      const vb = map.getBounds();
      const inView = [];
      for (let i = 0; i < contours.length; i++) if (selected.has(i) || vb.contains(centers[i])) inView.push(i);
      const show = inView.length <= LABEL_CAP ? new Set(inView) : new Set(selected);
      for (let i = 0; i < contours.length; i++) {
        if (show.has(i) && !labels[i]) labels[i] = L.marker(centers[i], { icon: labelIcon(i), interactive: false, keyboard: false, zIndexOffset: 500 }).addTo(importPickLayer);
        else if (!show.has(i) && labels[i]) { importPickLayer.removeLayer(labels[i]); labels[i] = null; }
      }
    }
    contours.forEach((c, i) => {
      const ll = c.ring.map((p) => [p.lat, p.lng]);
      const poly = L.polygon(ll, UNSEL).addTo(importPickLayer);
      polys[i] = poly;
      const pb = poly.getBounds(); centers[i] = pb.getCenter();
      bounds = bounds ? bounds.extend(pb) : pb;
      (c.holes || []).forEach((h) => { if (h.length >= 3) L.polygon(h.map((p) => [p.lat, p.lng]), { color: "#ff4d4d", weight: 1.5, fillOpacity: 0.18, dashArray: "4 4", interactive: false }).addTo(importPickLayer); });
      poly.bindTooltip("«" + esc(c.name) + "» — " + areas[i].toFixed(2) + " га · торкнись, щоб вибрати");
      poly.on("click", (e) => { L.DomEvent.stop(e); if (selected.has(i)) selected.delete(i); else selected.add(i); paint(i); refreshLabels(); updateBtn(); });
    });
    if (bounds) map.fitBounds(bounds, { padding: [50, 50] });
    function hideLabels() { for (let k = 0; k < labels.length; k++) if (labels[k]) { importPickLayer.removeLayer(labels[k]); labels[k] = null; } }
    importPickShowLbl = refreshLabels; importPickHideLbl = hideLabels;
    map.on("moveend zoomend", refreshLabels);
    map.on("movestart zoomstart", hideLabels);   // labels vanish DURING an active pan/zoom (no per-frame DOM reposition -> smooth), reappear when the map settles
    refreshLabels();

    // One adaptive action button: pick the single selected field, or union several.
    const b = document.createElement("button");
    b.style.cssText = "position:absolute;z-index:1000;left:50%;bottom:16px;transform:translateX(-50%);padding:12px 20px;border-radius:10px;border:none;color:#fff;font-size:15px;box-shadow:0 2px 10px rgba(0,0,0,.45);transition:opacity .15s";
    function updateBtn() {
      const n = selected.size;
      b.textContent = n === 0 ? "Торкнись контуру на карті" : n === 1 ? "Працювати з полем" : "Об'єднати " + n + " контурів у одне";
      b.disabled = n === 0;
      b.style.opacity = n === 0 ? "0.55" : "1";
      b.style.background = "#2d7ff9";
    }
    b.addEventListener("click", () => {
      const idxs = Array.from(selected);
      if (!idxs.length) return;
      if (idxs.length === 1) {
        const c = contours[idxs[0]]; clearImportPick(); adoptContour(c); currentFieldName = c.name;
        setMsg("Обрано «" + c.name + "». Автозбереження — при заливці в дрон.", "ok"); return;
      }
      if (!window.ClipperLib) { setMsg("Модуль об'єднання недоступний.", "error"); return; }
      const u = unionContours(idxs.map((n) => contours[n]));
      if (!u.ok) { setMsg(u.error, "error"); return; }
      if (u.outers.length !== 1) { setMsg("Вибрані контури не суміжні — в одне суцільне поле не зливаються (" + u.outers.length + " окремих частин). Обери контури, що торкаються.", "error"); return; }
      clearImportPick();
      adoptContour({ name: "Об'єднане поле", ring: u.outers[0], holes: u.holes });
      currentFieldName = "Об'єднане поле";
      setMsg("Об'єднано " + idxs.length + " контурів у одне поле.", "ok");
    });
    map.getContainer().appendChild(b); importPickBtn = b;
    updateBtn();
    setMsg(contours.length + " контурів у файлі — торкайся, щоб вибрати (один або кілька), далі кнопка знизу.", "ok");
  }
  // ---- Recent imported KMLs: remember the last few files so re-importing is one tap
  // (the phone file picker buries KMLs deep — this saves the hunt). We store the file
  // TEXT (KMLs are tiny), so a recent re-import works offline with no file re-access.
  const RECENT_KML_KEY = "fmp_recent_kml", RECENT_KML_MAX = 8;
  function recentKmlLoad() { try { return JSON.parse(localStorage.getItem(RECENT_KML_KEY) || "[]"); } catch (e) { return []; } }
  function recentKmlPush(name, text) {
    try {
      if (text && text.length <= 800000) {              // don't bloat storage with huge files
        let list = recentKmlLoad().filter((r) => r && r.text !== text);
        list.unshift({ name: (name || "KML").slice(0, 40), text: text, ts: Date.now() });
        localStorage.setItem(RECENT_KML_KEY, JSON.stringify(list.slice(0, RECENT_KML_MAX)));
      }
    } catch (e) { /* quota — ignore */ }
    renderRecentKml();
  }
  function renderRecentKml() {
    const box = $("recent-kml"); if (!box) return;
    const list = recentKmlLoad();
    box.innerHTML = "";
    if (!list.length) { box.style.cssText = ""; return; }
    box.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:6px 0";
    const lbl = document.createElement("span"); lbl.className = "hint"; lbl.textContent = "Недавні:"; lbl.style.margin = "0 2px 0 0"; box.appendChild(lbl);
    list.forEach((r) => {
      const chip = document.createElement("button");
      chip.className = "ghost"; chip.textContent = r.name;
      chip.style.cssText = "padding:4px 10px;font-size:13px;flex:0 0 auto";
      chip.title = "Переімпортувати " + r.name;
      chip.addEventListener("click", () => importKmlText(r.text, r.name));
      box.appendChild(chip);
    });
  }
  // Entry point — also called by the native shells via window.__fmpImportKml(text[, name]).
  function importKmlText(text, fileName) {
    const res = parseKmlContours(text);
    if (!res.ok) { setMsg(res.error, "error"); return; }
    recentKmlPush(fileName || (res.contours[0] && res.contours[0].name) || "KML", text);
    if (res.contours.length === 1) {
      const c = res.contours[0];
      adoptContour(c); currentFieldName = c.name;
      setMsg("Імпортовано контур із .kml" + (c.holes.length ? " (+" + c.holes.length + " вирізів)" : "") + ".", "ok");
    } else {
      showImportedContours(res.contours);
    }
  }
  window.__fmpImportKml = function (text, name) { try { importKmlText(String(text), name); } catch (e) { setMsg("Помилка читання KML: " + e, "error"); } };
  // Native bridges (Android UDP/serial) push socket-level diagnostics here so a failed
  // WiFi/MAVLink connection is visible in the app log (тап на версію → «Лог»).
  window.__fmpNativeLog = function (s) { try { appLog(String(s)); } catch (e) {} };
  $("exp-kml").addEventListener("click", exportKml);
  $("import-kml").addEventListener("click", () => $("kml-file").click());
  $("kml-file").addEventListener("change", (ev) => {
    const f = ev.target.files && ev.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onerror = () => setMsg("Не вдалося прочитати файл. Спробуй «Відкрити через FMP» з файлового менеджера.", "error");
    r.onload = () => importKmlText(String(r.result), f.name);
    r.readAsText(f);
    ev.target.value = "";
  });
  renderRecentKml();      // show any previously-imported files on load

  // Using the toolbar field-polygon tool cancels any pending exclusion draw,
  // so the next finished polygon is treated as the field, not an obstacle.
  const polyBtn = document.querySelector(".leaflet-draw-draw-polygon");
  if (polyBtn) {
    polyBtn.addEventListener("click", () => {
      drawingExclusion = false;       // a direct toolbar-polygon click means "field"
    });
  }

  // ---- MAVLink: live link to the drone (connect, telemetry, upload) --------
  let mavConnected = false;
  let mavConnecting = false;       // synchronous guard: true from the top of mavConnect until it settles
  let _autoReconnectTimer = null;  // pending boot auto-reconnect timer (cleared on manual connect/disconnect)
  let mavPollTimer = null;
  let droneMarker = null;
  let droneTrack = null;          // flown-path polyline
  let lastRoute = null;           // [[lat,lng],…] of the last-built route (editing buffer)
  let lastHome = null;            // {lat,lng} home of the last-built route
  let lastRtl = true;             // whether the last build had RTL
  // Snapshot of the mission ACTUALLY uploaded — progress is driven off THIS,
  // not the live editing buffer, so editing/rebuilding after upload can't make
  // the in-flight HUD lie.
  let flownRoute = null;          // [[lat,lng],…] coverage waypoints uploaded
  let flownHome = null;           // {lat,lng}
  let flownHasRtl = true;
  let flownWpTotal = 0;           // total mission items uploaded (progress/completion)
  let flownSplicePost = 0;        // safe-transit EGRESS waypoints appended after coverage (#12) — HUD lead math
  let flownRestored = false;      // flown snapshot came from disk (unverified) → not green until re-checked
  let targetMarker = null;        // ring on the active (next) waypoint
  let targetLine = null;          // dashed line drone -> next waypoint
  let liveHomeMarker = null;      // ArduPilot's actual HOME (arm point)
  let droneMissionLayer = null;   // mission downloaded FROM the drone (visual)

  // ---- продовження місії після заміни батареї -------------------------------
  // Тумблер #mission-resume. Поки дрон летить, ми памʼятаємо, до якої точки він
  // дійшов. Після заміни батареї «Старт місії» пропонує ЗАЛИТИ ЗАЛИШОК як
  // повноцінну нову місію: вона теж починається ВЕРТИКАЛЬНИМ ЗЛЬОТОМ на задану
  // висоту і лише потім іде по точках. Тобто дрон ніколи не летить по діагоналі
  // низько через поле — ні на старті, ні на продовженні (вимога Івана).
  //
  // Свідомо НЕ використовуємо стрибок DO_SET_MISSION_CURRENT у повітрі: він
  // веде дрон прямо до точки, набираючи висоту по дорозі (можна зачепити
  // дерево/стовп). Заливка залишку йде тим самим перевіреним шляхом, що й
  // звичайна місія.
  const RESUME_KEY = "fmp_mission_progress";   // {wp,total,ts} — прогрес у ПОЛЬОТІ
  const FLOWN_KEY = "fmp_flown";               // {route,rtl,lead,ts} — що саме залито
  function resumeOn() { const c = $("mission-resume"); return !!(c && c.checked); }
  function resumeLoad() { try { return JSON.parse(localStorage.getItem(RESUME_KEY) || "null"); } catch (e) { return null; } }
  function flownLoad() { try { return JSON.parse(localStorage.getItem(FLOWN_KEY) || "null"); } catch (e) { return null; } }
  // Restore "what's uploaded to the drone" on boot so mission-status + the progress overlay
  // survive a reopen. Marked flownRestored: after a kill/reboot the drone could be power-cycled/
  // reflashed/a different airframe, so this is NOT trusted like a fresh read-back-verified upload.
  function flownRestore() {
    const f = flownLoad();
    if (!f || !f.route || !f.route.length) return;
    flownRoute = f.route;
    flownHome = f.home || null;
    flownHasRtl = (f.rtl != null ? f.rtl : true);
    flownWpTotal = f.wpTotal || 0;
    flownSplicePost = f.post || 0;
    flownRestored = true;              // disk-restored → mission-status shows "verify", never green
    // Intent-marker safety (verified finding): mavUpload() overwrites FLOWN_KEY with
    // {route:NEW route, status:"uploading"} the INSTANT an upload starts, before the
    // transfer is confirmed — so an app kill mid-upload leaves this bare marker on disk.
    // RESUME_KEY, however, was recorded against whatever mission was flying BEFORE this
    // upload attempt (a different route). Pairing that stale wp-progress with the marker's
    // NEW route (as resumeRemaining() would, unchecked) can offer "continue from wp N" at
    // an index that has nothing to do with this route — silently skipping a large, real
    // stretch of never-flown coverage if accepted. We don't know what's actually on the
    // drone after an unconfirmed upload, so drop the stale progress rather than risk
    // pairing it with the wrong route; the operator re-verifies/re-uploads from scratch.
    if (f.status === "uploading") {
      try { localStorage.removeItem(RESUME_KEY); } catch (e) {}
      appLog("flownRestore: marker left mid-upload (killed before confirm) — cleared stale resume progress");
    }
  }
  function resumeClear() {
    try { localStorage.removeItem(RESUME_KEY); } catch (e) {}
    resumeHint();
  }
  // Скільки службових пунктів іде ПЕРЕД точками маршруту: home + takeoff
  // (+ do_change_speed, якщо задана швидкість) — див. buildMissionItems.
  function missionLead() { return 2 + ((parseFloat($("speed").value) || 0) > 0 ? 1 : 0); }
  // splicePre: how many safe-transit INGRESS waypoints (#12) were spliced onto the FRONT
  // of `route` before it was uploaded (0 for INAV, resumes, or a plain/unspliced mission).
  // The real "service points before coverage wp 0" that the FC's wp_current counts against
  // is missionLead() + splicePre — store the SUM as `lead` so resumeRemaining()'s
  // idx = wp - lead maps back to the right coverage waypoint (CRITICAL fix: previously only
  // missionLead() was stored, silently skipping `splicePre` never-flown waypoints on every
  // battery-swap resume of a spliced upload).
  function flownSave(route, home, hasRtl, status, splicePre, splicePost) {
    try {
      localStorage.setItem(FLOWN_KEY, JSON.stringify({
        route: route, home: home || null,
        rtl: (hasRtl != null ? hasRtl : $("rtl").checked),
        lead: missionLead() + (splicePre || 0), name: currentFieldName || null, wpTotal: flownWpTotal || 0,
        post: splicePost || 0,          // egress splice length (#12) — HUD lead math on restore
        status: status || "confirmed", ts: Date.now(),
      }));
    } catch (e) {}
  }
  // Залишок маршруту від збереженої точки; null — нема чого продовжувати.
  function resumeRemaining() {
    if (!resumeOn()) return null;
    const p = resumeLoad(), f = flownLoad();
    if (!p || !f || !f.route || !f.route.length) return null;
    // f.lead already carries missionLead()+splicePre for anything saved by flownSave above
    // (this build); records from before splice_pre tracking existed were saved with the
    // same call and have no splicePre concept, so they fall back to the historical default
    // (3) exactly as before — safe, since an unspliced mission's real lead is 2 or 3 anyway.
    const lead = f.lead != null ? f.lead : 3;
    const idx = Math.max(0, Math.min((p.wp | 0) - lead, f.route.length - 1));
    if (idx < 1) return null;                       // майже нічого не пролетів
    const rest = f.route.slice(idx);
    if (rest.length < 2) return null;               // місія фактично завершена
    return { rest: rest, idx: idx, total: f.route.length, wp: p.wp };
  }
  function resumeHint() {
    const el = $("resume-hint");
    if (!el) return;
    const r = resumeRemaining();
    if (r) {
      el.style.display = "";
      el.textContent = "Збережено прогрес: пройдено " + r.idx + " з " + r.total +
        " точок. Щоб продовжити — натисни «Старт місії» ТУТ (і на землі, і в повітрі): " +
        "додаток заллє залишок (" + r.rest.length + " точок) і дрон підніметься на задану висоту, " +
        "перш ніж летіти далі. УВАГА: якщо просто повернути AUTO тумблером на пульті, ArduPilot " +
        "полетить до точки навскіс з поточної висоти — саме тому продовжуй через додаток.";
    } else { el.style.display = "none"; }
  }
  let _resumeSavedAt = 0;
  function missionProgressTick(s) {
    if (!resumeOn() || !s || !s.armed) return;
    const wp = s.wp_current, tot = s.wp_total;
    if (wp == null || wp < 1) return;
    const now = Date.now();
    if (now - _resumeSavedAt < 3000) return;
    _resumeSavedAt = now;
    try {
      const prev = resumeLoad();
      // прогрес не «відкочується» (ребут FC обнуляє лічильник місії)
      if (prev && prev.total === tot && prev.wp > wp) return;
      localStorage.setItem(RESUME_KEY, JSON.stringify({ wp: wp, total: tot, ts: now }));
      resumeHint();
    } catch (e) {}
  }

  let lastStatus = null;          // latest telemetry snapshot (for upload-time home)
  let mavFollow = false;          // off by default; user opts in via the checkbox

  // Signature of a route, to tell whether what's planned == what's uploaded.
  function routeSig(r) {
    if (!r || !r.length) return null;
    const a = r[0], b = r[r.length - 1];
    return r.length + "|" + a[0].toFixed(5) + "," + a[1].toFixed(5) +
           "|" + b[0].toFixed(5) + "," + b[1].toFixed(5);
  }

  // Tell the operator, at a glance, whether the CURRENT plan is what's on the
  // drone — so they never fly a stale mission.
  function updateMissionStatus() {
    const el = $("mission-status");
    if (!el) return;
    const plan = routeSig(lastRoute), flown = routeSig(flownRoute);
    if (!plan) {
      el.textContent = t("Маршрут не побудовано."); el.className = "mission-status";
    } else if (!flown) {
      el.textContent = t("Маршрут НЕ залито в дрон. Натисни «Залити місію».");
      el.className = "mission-status warn";
    } else if (flownRestored) {
      // Disk-restored flown snapshot — never route it into the same green pill as a fresh
      // read-back-verified upload (the drone may have changed since). Connect + re-check first.
      el.textContent = t("Остання відома місія (з пам'яті) — підключись і перевір, чи вона ще в дроні.");
      el.className = "mission-status warn";
    } else if (plan === flown) {
      el.textContent = tf("У дроні поточна місія: {0} точок.", lastRoute.length);
      el.className = "mission-status ok";
    } else {
      el.textContent = t("План ЗМІНЕНО після заливки — у дроні СТАРА місія. Залий заново!");
      el.className = "mission-status stale";
    }
  }

  // Great-circle distance in metres (for live mission progress).
  function haversineM(aLat, aLng, bLat, bLng) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (bLat - aLat) * rad, dLng = (bLng - aLng) * rad;
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  // ---- in-browser MAVLink backend (offline, no Python) --------------------
  // The Qt desktop has a local Python server (pyserial) → keep using /api there.
  // A real browser / installed PWA has no Python, so it talks to the drone
  // directly via the JS link (WebSerial / WebUSB / WebSocket). Same method names
  // and result shapes as the HTTP backend, so the UI code is unchanged.
  let _mavLink = null;
  let _specsP = null;
  let mavSerialPorts = [];   // Web Serial ports the user has granted (getPorts)
  function loadMavSpecs() {
    if (!_specsP) {
      _specsP = fetch(API_BASE + "/mav/specs.json")
        .then((r) => r.json()).then((s) => MAVLINK.setSpecs(s))
        .catch((e) => { _specsP = null; throw e; });
    }
    return _specsP;
  }
  const jsMav = {
    async mav_ports() {
      // Native Android: enumerate the actually-attached USB devices so the user
      // sees their flight controller by name and baud applies on connect.
      if (IS_ANDROID) {
        try {
          const list = JSON.parse(window.AndroidSerial.listDevices() || "[]");
          if (list.length)
            return {
              ok: true,
              ports: list.map((d) => ({
                device: String(d.id),
                desc: `${d.name} (${d.vid}:${d.pid})${d.driver ? "" : " — драйвер невідомий"}`,
              })),
            };
          return { ok: true, ports: [], note: "USB-пристрій не знайдено — під'єднай політник кабелем (OTG) і онови." };
        } catch (e) { return { ok: true, ports: [] }; }
      }
      // Desktop browser (Chrome/Edge): list the serial ports the user already
      // granted (Web Serial getPorts) — like Betaflight/ESC Configurator. New
      // devices are added with the «Вибрати пристрій» button (requestPort).
      if (MAV_TRANSPORT.serialSupported()) {
        mavSerialPorts = await MAV_TRANSPORT.serialGetPorts();
        const ports = mavSerialPorts.map((p, i) => {
          let d = "USB-послідовний пристрій";
          try {
            const info = p.getInfo && p.getInfo();
            if (info && info.usbVendorId != null)
              d = "USB " + info.usbVendorId.toString(16).padStart(4, "0") + ":" +
                  (info.usbProductId || 0).toString(16).padStart(4, "0");
          } catch (e) {}
          return { device: String(i), desc: d };
        });
        if (ports.length) return { ok: true, ports };
        return { ok: true, ports: [], note: "Натисни «Вибрати пристрій» і обери свій політник у вікні браузера." };
      }
      // Android browser (no Web Serial) / other: can't do direct USB here.
      return { ok: true, ports: [], note: "Прямий USB недоступний у цьому браузері. На Android встанови APK (кнопка «Android» нижче) або під'єднайся через мережу (UDP/TCP)." };
    },
    async mav_connect(p) {
      if (!window.MAVLINK || !window.MAV_LINK) return { ok: false, error: "MAVLink-модуль не завантажено." };
      const conn = (p && p.conn) || "";
      let transport;
      // Open the port FIRST — the WebSerial/WebUSB device picker MUST be opened
      // synchronously inside the click. Any await before it (e.g. fetching specs)
      // consumes the user gesture, and Chrome then silently refuses to show the
      // picker → "не бачить порт". So request the device, THEN load specs.
      try {
        if (conn.startsWith("ble:")) {
          // Bluetooth LE to a SpeedyBee-style FC / BLE-UART module. slice(4), NOT
          // split(":") — the address is a MAC and is full of colons.
          if (!window.AndroidBle)
            return { ok: false, error: "Bluetooth доступний лише в Android-застосунку (APK)." };
          const addr = conn.slice(4);
          if (!addr)
            return { ok: false, error: "BLE-пристрій не вибрано — натисни «Сканувати» і вибери зі списку." };
          transport = await MAV_TRANSPORT.openAndroidBle(addr);
        } else if (conn.startsWith("udp:") && IS_ANDROID && window.AndroidUdp) {
          // Native UDP for the ELRS backpack over WiFi. Bind the given port on
          // the phone (host is ignored — we listen on all interfaces).
          const port = parseInt(conn.split(":").pop(), 10) || 14550;
          transport = await MAV_TRANSPORT.openAndroidUdp(port);
        } else if (conn.startsWith("udp:") && IS_IOS) {
          // Native UDP on the iOS shell (the only way to reach the drone on iOS —
          // no USB to the FC). Listens on the given port; learns the backpack peer.
          const port = parseInt(conn.split(":").pop(), 10) || 14550;
          transport = await MAV_TRANSPORT.openIosUdp(port);
        } else if (conn.startsWith("tcp:") || conn.startsWith("udp:")) {
          transport = await MAV_TRANSPORT.openWebSocket("ws://" + conn.replace(/^(tcp|udp):/, ""));
        } else if (IS_ANDROID) {
          // `conn` is the deviceId chosen in the port dropdown (or "cable"/empty
          // -> the bridge falls back to the only attached device). USB CDC ignores
          // baud, so default to 115200 when "auto".
          const baud = p && p.baud && p.baud !== "auto" ? parseInt(p.baud, 10) : 115200;
          transport = await MAV_TRANSPORT.openAndroidSerial(conn, baud);
        } else if (MAV_TRANSPORT.serialSupported()) {
          const idx = parseInt(conn, 10);
          let port = mavSerialPorts[idx];
          if (!port) {
            // nothing pre-selected — open the picker now (still inside the click
            // gesture, so Chrome shows it), then open whatever the user grants.
            try { port = await MAV_TRANSPORT.serialRequestPort(); }
            catch (e) { return { ok: false, error: "Пристрій не вибрано. Натисни «Вибрати пристрій», обери політник у списку, тоді «Підключити»." }; }
          }
          const baud = p && p.baud && p.baud !== "auto" ? parseInt(p.baud, 10) : 115200;
          transport = await MAV_TRANSPORT.openSerial(port, baud);
        } else if (navigator.usb) {
          transport = await MAV_TRANSPORT.openWebUSB();
        } else {
          return { ok: false, error: "Цей браузер не підтримує USB. На Android потрібен Chrome; або під'єднайся через мережу (TCP/UDP до WiFi-моста)." };
        }
      } catch (e) {
        const m = (e && e.message) || String(e);
        if (/No device selected|cancell|not allowed|gesture/i.test(m))
          return { ok: false, error: "Пристрій не вибрано (або діалог не відкрився). Натисни «Підключити» ще раз і обери порт у списку." };
        return { ok: false, error: "USB-порт не відкрився: " + m + ". На Android Chrome частина польотників невидна для WebUSB (система перехоплює USB-serial) — тоді треба нативний APK або підключення через WiFi/мережу." };
      }
      try { await loadMavSpecs(); } catch (e) { return { ok: false, error: "Не вдалося завантажити MAVLink-специфікації." }; }
      _mavLink = new MAV_LINK.MavLink();
      _mavLink.onLog = appLog;          // capture low-level MAVLink events into the diagnostic log
      appLog("jsMav connect: " + ((p && p.conn) || "cable"));
      return _mavLink.connect(transport);
    },
    async mav_disconnect() { if (_mavLink) _mavLink.disconnect(); _mavLink = null; return { ok: true }; },
    async mav_status() { return _mavLink ? Object.assign({ ok: true }, _mavLink.status()) : { ok: false }; },
    async mav_download_mission() { return _mavLink ? _mavLink.downloadMission() : { ok: false, error: "Немає звʼязку." }; },
    async mav_upload_mission(p) {
      if (!_mavLink) return { ok: false, error: "Немає звʼязку." };
      // p.route (необовʼязково) — залити НЕ поточний план, а конкретний маршрут:
      // так працює продовження після заміни батареї (заливаємо ЗАЛИШОК як
      // повноцінну місію — з власним вертикальним зльотом на задану висоту).
      const route = (p && p.route && p.route.length) ? p.route : lastRoute;
      if (!route || !route.length) return { ok: false, error: "Спочатку побудуй маршрут." };
      const alt = parseFloat($("alt").value);
      const speed = Math.max(parseFloat($("speed").value) || 0, 0);
      const rtl = $("rtl").checked;
      const st = _mavLink.status();
      let home;
      if (st.home_lat != null) home = [st.home_lat, st.home_lon, 0];
      else if (st.lat != null && (st.fix_type || 0) >= 3) home = [st.lat, st.lon, 0];
      else if (lastHome) home = [lastHome.lat, lastHome.lng, 0];
      else home = [route[0][0], route[0][1], 0];
      // Місія ЗАВЖДИ починається вертикальним зльотом на задану висоту
      // (NAV_TAKEOFF), і лише потім — горизонтальний політ по точках. Це
      // стосується і продовження після батареї: залишок теж має свій зліт.
      // Dual-stack: INAV accepts only bare NAV_WAYPOINT + RTL (no home/takeoff/speed
      // items). Pick the builder by the detected autopilot (3 = ArduPilot).
      const _wps = route.map((pt) => [pt[0], pt[1]]);
      const isInav = st && st.autopilot != null && st.autopilot !== 3;
      // #12: splice a provably-safe ingress/egress detour (around the field edge and any
      // exclusions) onto the flown mission — ArduPilot only (INAV path below is untouched).
      // FAIL-SAFE (safety-critical, do not weaken): a safe_transit failure, an {ok:false},
      // an unavailable engine, or ANY exception here must DEGRADE to the plain `_wps`
      // mission (today's behaviour) — this must never throw out of the upload, and must
      // never prepend/append a leg whose *_ok is false.
      let flown = _wps;
      // splicePre = how many ingress waypoints got PREPENDED onto `flown` ahead of the
      // coverage route (0 when no splice happens). CRITICAL: this must travel back to the
      // caller (res.splice_pre below) so flownSave() can store lead = missionLead() +
      // splicePre — resumeRemaining()'s `idx = wp - lead` otherwise stays off by `pre.length`
      // on EVERY spliced upload, silently dropping the first `pre.length` coverage waypoints
      // of a battery-swap resume (verified finding — the duplicated Critical).
      let splicePre = 0;
      let splicePost = 0;
      // Partial-route upload (resume after a battery swap passes p.route = the REMAINDER):
      // safe_transit plans against the engine's _state = the FULL last-built route, so its
      // ingress would target the ORIGINAL field start, not the mid-field resume point —
      // leaving an unverified straight jump that can cut an exclusion. Skip the splice and
      // fly the remainder plain (today's behaviour). (review Critical)
      if (!isInav && !(p && p.route && p.route.length)) {
        try {
          const tParams = { home: { lat: home[0], lng: home[1] } };
          const eng = window.FMP_ENGINE;
          const t = (!IS_QT && eng && eng.available())
            ? await eng.safeTransit(tParams)
            : await api().safe_transit(tParams);
          if (t && t.ok) {
            // slice(0,-1)/slice(1) drop the shared endpoint (ingress ends at _wps[0],
            // egress starts at _wps[last]) so it isn't duplicated in `flown`.
            const pre  = t.ingress_ok ? t.ingress.slice(0, -1).map((p) => [p.lat, p.lng]) : [];
            const post = t.egress_ok  ? t.egress.slice(1).map((p) => [p.lat, p.lng])       : [];
            flown = [...pre, ..._wps, ...post];
            splicePre = pre.length;
            splicePost = post.length;
            if (!t.ingress_ok) setMsg("Безпечний шлях до старту не побудовано — зліт напряму до першої точки.", "warn");
            if (!t.egress_ok)  setMsg("Безпечний шлях додому не побудовано — RTL напряму.", "warn");
          }
          // on !t.ok or engine unavailable → flown stays = _wps (NEVER block the upload; just no detour)
        } catch (e) {
          appLog("safe_transit splice failed: " + ((e && e.message) || e) + " -> плоска місія без обходу");
          // flown stays = _wps — degrade to the plain mission, never throw out of the upload
        }
      }
      const items = isInav
        ? MAV_LINK.buildMissionItemsInav(_wps, alt, rtl)
        : MAV_LINK.buildMissionItems(home, Math.max(alt, 2), flown, alt, rtl, speed);
      const res = await _mavLink.uploadMission(items, undefined, p && p.onProgress);
      // CRITICAL: report the splice length back to the caller — see splicePre comment
      // above. 0 for INAV/resume uploads (no splice attempted) and for a plain _wps
      // mission (no safe_transit ingress, or it failed/was unavailable).
      res.splice_pre = splicePre;
      res.splice_post = splicePost;   // egress splice length — HUD lead math only (display)
      if (!res.ok) return res;
      if (speed > 0 && !isInav) {   // INAV: MAVLink param-set is a stub; speed is a vehicle setting
        let ps = await _mavLink.setParam("WP_SPD", speed);
        if (!ps.ok) ps = await _mavLink.setParam("WPNAV_SPEED", speed * 100);
        res.cruise_speed_set = ps.ok;
      }
      // Round-turn: set the autopilot's waypoint acceptance/turn radius so the copter
      // flies a rounded U-turn at each pass end. Copter ≥4.7 uses WP_RADIUS_M (m); older
      // firmware WPNAV_RADIUS (cm). No extra waypoints — the autopilot does the arc.
      const trm = p && p.turn_radius_m;
      if (trm && trm > 0 && !isInav) {
        let pr = await _mavLink.setParam("WP_RADIUS_M", trm);
        if (!pr.ok) pr = await _mavLink.setParam("WPNAV_RADIUS", trm * 100);
        res.turn_radius_set = pr.ok;
        appLog("round-turn: WP_RADIUS_M " + trm + "m -> " + (pr.ok ? "ok" : "FAILED"));
      }
      // Fixed-wing arc-turn params (analog of the copter WP_RADIUS_M). MAVLink
      // param-set only → ArduPilot. INAV is transmit-only: it flies the arc geometry
      // natively, but nav_fw_wp_turn_smoothing must be set OFF once on the board.
      const pp = p && p.plane_params;
      if (pp && !isInav) {
        for (const k in pp) {
          const pr = await _mavLink.setParam(k, pp[k]);
          appLog("plane-turn: " + k + "=" + pp[k] + " -> " + (pr && pr.ok ? "ok" : "FAILED"));
        }
        res.plane_params_set = true;
      } else if (pp && isInav) {
        appLog("plane-turn: INAV — параметри по MAVLink не залити; постав nav_fw_wp_turn_smoothing=OFF у Configurator (дуги летять нативно)");
      }
      // Додому — КАМЕРОЮ ВПЕРЕД: дефолтний WP_YAW_BEHAVIOR=2 тримає останній
      // курс під час RTL (дрон вертається боком/хвостом — оператор не бачить
      // перешкод у камеру). 1 = ніс за курсом і в RTL теж. На проходи місії не
      // впливає (1 і 2 в місії ідентичні), діє і на ручний RTL з пульта/кнопки.
      if (!isInav) {   // ArduPilot-only param (INAV has no WP_YAW_BEHAVIOR)
        const py = await _mavLink.setParam("WP_YAW_BEHAVIOR", 1);
        res.yaw_forward_set = py.ok;
        appLog("камерою вперед у RTL: WP_YAW_BEHAVIOR=1 -> " + (py.ok ? "ok" : "FAILED"));
      }
      // Verify FULL by default (geometry read-back) — count-only proves the RIGHT NUMBER of
      // points but a mission with shifted coordinates would pass. `verify:'count'` = informed
      // opt-out (marginal ELRS link); `verify:false` = explicit skip. Wrapped in try/catch so a
      // flaky read-back never paints a successfully-stored mission red: the mission was ACK'd
      // (res.ok stays true) → a verify throw becomes VERIFY-INCOMPLETE (amber), not a failure.
      const mode = (!p || p.verify === undefined) ? "full" : p.verify;
      if (mode !== false) {
        try {
          const v = (mode === "count")
            ? await _mavLink.verifyMissionCount(items.length)
            : await _mavLink.verifyMission(items, 60000);
          res.verify = v;
          if (v.ok && !v.verified) res.verify_warning = "Зчитана місія не збігається — перевір.";
        } catch (e) {
          res.verify = { ok: false, verified: false, error: (e && e.message) || String(e) };
          res.verify_incomplete = true;
        }
      }
      // #12p3: OPT-IN geofence upload — AFTER the mission itself is safely stored (above).
      // Strictly gated on the checkbox (default OFF), ArduPilot-only, and a FULL-mission
      // upload (not a battery-swap resume of a partial route — resuming the remainder isn't
      // the moment to re-splice the fence, mirrors the safe_transit gate above). NEVER
      // touches FENCE_ENABLE/FENCE_ACTION (storage only — the pilot arms the fence
      // themselves). A fence failure must NEVER fail/undo the mission upload: res.ok stays
      // whatever it already is (true, since we're past the early `if (!res.ok) return res;`
      // above). The outcome is attached as res.fence — the CALLER composes the one message
      // actually painted to the pilot (a setMsg here would just be silently overwritten).
      if (!isInav && !(p && p.route && p.route.length) && $("fence-upload") && $("fence-upload").checked) {
        try {
          const boundary = boundaryFromPolygon();
          const exclusions = collectExclusions();
          if (boundary && boundary.length >= 3) {
            const fenceItems = MAV_LINK.buildFenceItems(boundary, exclusions);
            if (!fenceItems.length) {
              // Degenerate boundary after closing-vertex dedupe (<3 real vertices left) —
              // an EMPTY upload would send COUNT=0/type=1, which CLEARS any fence already
              // stored on the vehicle. Skip the upload entirely rather than risk that.
              res.fence = { ok: false, error: "контур поля вироджений — замало вершин для геозони" };
            } else {
              const fres = await _mavLink.uploadMission(fenceItems, undefined, undefined, 1);
              res.fence = fres.ok
                ? { ok: true, count: fenceItems.length, exclusions: exclusions.length,
                    // HOME outside the boundary: an ENABLED fence would then refuse to arm
                    // right here — the caller folds this into its message.
                    homeOutside: !window.GEO_COVER.pointInRing(home[0], home[1], boundary),
                    // Lost-ACK "ok" (link.js:610): every item was SENT but the final ACK never
                    // arrived — on the vehicle the transfer can time out with the last vertex
                    // missing and get discarded, leaving whatever fence was stored BEFORE this
                    // upload. Carry the warning through so the caller paints uncertainty, not
                    // success (verified finding — do not drop this like the old code did).
                    warning: fres.warning || null }
                : { ok: false, error: fres.error };
            }
          }
        } catch (e) {
          res.fence = { ok: false, error: (e && e.message) || String(e) };
        }
      }
      return res;
    },
    async mav_command(p) {
      if (!_mavLink) return { ok: false, error: "Немає звʼязку." };
      const action = p && p.action;
      if (action === "arm" || action === "disarm") {
        const want = action === "arm";
        const r = await _mavLink.arm(want, !!(p && p.force));
        if (!r.ok) return r;
        for (let i = 0; i < 12; i++) {
          await new Promise((z) => setTimeout(z, 200));
          if (_mavLink.status().armed === want) return { ok: true };
        }
        const why = _mavLink.status().last_text || "стан моторів не змінився";
        return { ok: false, error: (want ? "Увімкнення" : "Вимкнення") + " моторів не підтверджено: " + MAV_LINK.humanize(why) };
      }
      if (action === "mode") return _mavLink.setMode(p.mode);
      if (action === "start") return _mavLink.missionStart();
      if (action === "pause") return _mavLink.missionPause();
      if (action === "continue") return _mavLink.missionContinue();
      return { ok: false, error: "Невідома дія: " + action };
    },
    // Param read — the automatic BT-UART activation checks what currently owns
    // the UART before daring to overwrite it.
    async mav_get_param(p) {
      if (!_mavLink) return { ok: false, error: "Немає звʼязку." };
      return _mavLink.getParam(p.name);
    },
    // Generic param write (PARAM_SET + read-back confirm) — used by the one-tap
    // BT-UART activation (set SERIALx_PROTOCOL/BAUD over USB-OTG/WiFi, no PC).
    async mav_set_param(p) {
      if (!_mavLink) return { ok: false, error: "Немає звʼязку." };
      return _mavLink.setParam(p.name, p.value);
    },
    // MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN (246, param1=1) — reboot the autopilot
    // so a SERIALx_PROTOCOL change takes effect. Refused by ArduPilot when armed.
    async mav_reboot() {
      if (!_mavLink) return { ok: false, error: "Немає звʼязку." };
      return _mavLink.command(246, [1]);
    },
  };
  function mavApi() {
    return (!IS_QT && window.MAV_LINK && window.MAVLINK) ? jsMav : api();
  }

  // Show the cable fields or the network address field per connection type.
  // UDP default = listen on ALL interfaces on the standard MAVLink port, so the
  // app auto-receives from the drone/backpack/SITL whatever its IP is — the user
  // doesn't have to know or type the source address.
  const MAV_DEFAULT_ADDR = { tcp: "127.0.0.1:5760", udp: "0.0.0.0:14550" };
  function mavSyncRows() {
    const t = $("mav-conn-type").value;
    const isSerial = t === "cable" || t === "handset";
    $("mav-cable-row").style.display = isSerial ? "" : "none";
    $("mav-net-row").style.display = (isSerial || t === "ble") ? "none" : "";
    if (t === "handset" && $("mav-baud")) $("mav-baud").value = "115200";   // EdgeTX USB-VCP nominal baud (#7)
    const bleRow = $("mav-ble-row");
    if (bleRow) bleRow.style.display = t === "ble" ? "" : "none";
    // Seed the default address only if the field is empty or still holds the
    // OTHER type's default — never clobber an address the user typed.
    if (t !== "cable" && t !== "ble") {
      const cur = ($("mav-address").value || "").trim();
      if (!cur || cur === MAV_DEFAULT_ADDR.tcp || cur === MAV_DEFAULT_ADDR.udp) {
        $("mav-address").value = MAV_DEFAULT_ADDR[t];
      }
    }
  }
  $("mav-conn-type").addEventListener("change", mavSyncRows);
  mavSyncRows();

  async function mavRefreshPorts() {
    const a = mavApi();
    if (!a || !a.mav_ports) return;
    const sel = $("mav-port");
    sel.innerHTML = '<option value="">— шукаю порти… —</option>';
    try {
      const r = await a.mav_ports();
      sel.innerHTML = "";
      const ports = (r && r.ports) || [];
      if (!ports.length) {
        sel.innerHTML = '<option value="">— портів не знайдено —</option>';
        return;
      }
      ports.forEach((p) => {
        const o = document.createElement("option");
        o.value = p.device;
        o.textContent = p.desc ? `${p.device} — ${p.desc}` : p.device;
        sel.appendChild(o);
      });
    } catch (e) {
      sel.innerHTML = '<option value="">— помилка переліку —</option>';
    }
  }
  $("mav-refresh-ports").addEventListener("click", mavRefreshPorts);
  // Web Serial (desktop browser only): a dedicated "pick device" button that runs
  // navigator.serial.requestPort() in its own click gesture — same model as
  // Betaflight/ESC Configurator, and the reliable way to actually SEE the FC.
  const _pickBtn = $("mav-pick-device");
  if (_pickBtn && window.MAV_TRANSPORT && MAV_TRANSPORT.serialSupported() && !IS_QT && !IS_ANDROID) {
    _pickBtn.style.display = "";
    _pickBtn.addEventListener("click", async () => {
      try {
        await MAV_TRANSPORT.serialRequestPort();   // Chrome's device chooser
        await mavRefreshPorts();
        const sel = $("mav-port");
        if (sel.options.length) sel.selectedIndex = sel.options.length - 1;
        setMsg("Пристрій додано.", null);
      } catch (e) {
        setMsg("Вибір скасовано (або Web Serial недоступний).", "error");
      }
    });
  }
  mavRefreshPorts();   // populate on load

  // ---- Bluetooth LE (SpeedyBee-style FC / BLE-UART module; APK only) ----
  // The native shell exposes window.AndroidBle; without it (browser / Qt / PWA)
  // the option is removed so the UI never dangles a dead transport.
  (function bleUi() {
    const typeSel = $("mav-conn-type");
    const bleOpt = typeSel && typeSel.querySelector('option[value="ble"]');
    if (!window.AndroidBle) { if (bleOpt) bleOpt.remove(); return; }
    const list = $("mav-ble-list"), scanBtn = $("mav-ble-scan");
    if (!list || !scanBtn) return;
    const found = {};                       // addr -> {name, rssi}
    let scanning = false;
    const LAST_KEY = "fmp_ble_last";
    function label(d, addr) {
      const rssi = d.rssi != null ? " " + d.rssi + " дБм" : "";
      return (d.name || "(без імені)") + rssi + " — " + addr;
    }
    function render() {
      const cur = list.value;
      list.innerHTML = "";
      const addrs = Object.keys(found);
      if (!addrs.length) {
        list.innerHTML = scanning
          ? '<option value="">— шукаю пристрої… —</option>'
          : '<option value="">— натисни «Сканувати» —</option>';
        return;
      }
      // Strongest signal first — the drone on the bench is usually the top row.
      addrs.sort((a, b) => (found[b].rssi || -999) - (found[a].rssi || -999));
      let last = null;
      try { last = localStorage.getItem(LAST_KEY); } catch (e) {}
      for (const a of addrs) {
        const o = document.createElement("option");
        o.value = a; o.textContent = label(found[a], a);
        list.appendChild(o);
      }
      if (cur && found[cur]) list.value = cur;
      else if (last && found[last]) list.value = last;
    }
    window.__androidBleScan = (json) => {
      try {
        const d = JSON.parse(json);
        if (!d.addr) return;
        found[d.addr] = { name: d.name || (found[d.addr] && found[d.addr].name) || "", rssi: d.rssi };
        render();
      } catch (e) {}
    };
    function setScanning(on) {
      scanning = on;
      scanBtn.textContent = on ? "Стоп" : "Сканувати";
      if (!on) render();
    }
    // Native fires window.__androidBleEvent for BOTH scan and open events, and
    // transport.js claims/releases that same handler around each connect. Make the
    // visible property a stable dispatcher: scan events are handled here, everything
    // is also forwarded to whatever handler a consumer (transport.js) has set.
    (function hookScanEvents() {
      let inner = null;
      const dispatch = (type, ok, detail) => {
        if (type === "scan") {
          setScanning(false);
          if (detail && detail !== "stopped") setMsg(detail, "error");
        }
        if (inner) { try { inner(type, ok, detail); } catch (e) {} }
      };
      Object.defineProperty(window, "__androidBleEvent", {
        configurable: true,
        get() { return dispatch; },
        set(fn) { inner = fn; },
      });
    })();
    scanBtn.addEventListener("click", () => {
      if (scanning) { try { window.AndroidBle.stopScan(); } catch (e) {} setScanning(false); return; }
      for (const k of Object.keys(found)) delete found[k];
      render();
      let r = null;
      try { r = window.AndroidBle.startScan(); } catch (e) { setMsg("BLE-скан недоступний: " + e, "error"); return; }
      try {
        const j = JSON.parse(r);
        if (j && j.ok === false) { setMsg(j.error || "Скан не запустився.", "error"); return; }
      } catch (e) {}
      setScanning(true);
      appLog("ble scan start");
    });
    // Remember the chosen device for next time (field routine: same drone daily).
    list.addEventListener("change", () => {
      try { if (list.value) localStorage.setItem(LAST_KEY, list.value); } catch (e) {}
    });
    // ---- FULLY AUTOMATIC BT-UART setup (no buttons) ----
    // A silent BLE attempt records a pending setup (24 h TTL). The next
    // successful USB-OTG/WiFi connection reads the UART's current protocol,
    // rewrites it ONLY if the UART is unclaimed (None/MSP — never GPS/RC),
    // reboots the FC and re-connects over BLE by itself. Every step -> appLog.
    const PEND_KEY = "fmp_ble_pending_setup";
    window.__fmpBleMarkPending = (mac) => {
      try {
        localStorage.setItem(PEND_KEY, JSON.stringify({
          mac: mac || (list && list.value) || "", ts: Date.now() }));
        appLog("[auto-ble] відкладене налаштування записано");
      } catch (e) {}
    };
    function blePendingGet() {
      try {
        const p = JSON.parse(localStorage.getItem(PEND_KEY) || "null");
        if (p && p.uart && Date.now() - p.ts < 24 * 3600 * 1000) return p;
      } catch (e) {}
      return null;
    }
    function blePendingClear() { try { localStorage.removeItem(PEND_KEY); } catch (e) {} }

    // Switch to BLE, scan until the remembered MAC re-appears after the FC
    // reboot, connect. Falls back to a manual hint if the drone never shows.
    window.__fmpBleAutoReconnect = (mac, waitMs) => {
      if (!mac) return;
      setTimeout(() => {
        try { $("mav-conn-type").value = "ble"; mavSyncRows(); } catch (e) {}
        appLog("[auto-ble] чекаю плату після ребуту, сканую " + mac + "…");
        setMsg("Автоматично перепідключаюсь по Bluetooth…", null);
        for (const k of Object.keys(found)) delete found[k];
        let done = false;
        const prevCb = window.__androidBleScan;
        window.__androidBleScan = (json) => {
          try { prevCb(json); } catch (e) {}
          if (done) return;
          try {
            const d = JSON.parse(json);
            if (d.addr === mac) {
              done = true;
              try { window.AndroidBle.stopScan(); } catch (e) {}
              setScanning(false);
              window.__androidBleScan = prevCb;
              list.value = mac;
              appLog("[auto-ble] плата в ефірі — підключаюсь по BLE");
              mavConnect();
            }
          } catch (e) {}
        };
        try { window.AndroidBle.startScan(); setScanning(true); } catch (e) {}
        setTimeout(() => {
          if (done) return;
          window.__androidBleScan = prevCb;
          appLog("[auto-ble] " + mac + " не зʼявився за 25 с");
          setMsg("Плата не зʼявилась по Bluetooth за 25 с — натисни «Сканувати» і підключись вручну.", "error");
        }, 25000);
      }, waitMs || 13000);
    };

    // The pending setup itself, fully hands-free: PROBE the UARTs SpeedyBee
    // boards route their BT bridge to (SERIAL4 V3/V4, SERIAL6 WING, SERIAL1 AIO,
    // SERIAL3 misc), pick the one that looks like the bridge, rewrite, reboot,
    // reconnect. Selection is deliberately conservative:
    //   • protocol 32 (MSP) — the factory state of a SpeedyBee BT UART → best match;
    //   • else protocol -1 (None) — unclaimed;
    //   • anything else (GPS/RC/OSD/DisplayPort/…) is NEVER touched.
    window.__fmpAutoBleSetup = async () => {
      // PROACTIVE (2.5.46): no precondition. Every working non-BLE connection
      // probes the SpeedyBee BT UARTs; an MSP(32) UART = factory-state BT bridge
      // → configure immediately. A prior silent-BLE attempt is NOT required (the
      // old gate meant the automation never ran in the field); its only role now
      // is remembering the MAC so we can auto-reconnect after the reboot.
      const p = blePendingGet() || {};
      const a = mavApi();
      if (!mavConnected || !a.mav_get_param) return;
      const st = await a.mav_status();
      if (st && st.armed) { appLog("[auto-ble] мотори увімкнені — відкладаю налаштування"); return; }
      // INAV has no ArduPilot SERIALx_PROTOCOL params and ignores MAVLink param reads,
      // so the probe can do nothing AND each read times out — holding the transfer lock
      // for seconds and blocking the user's upload right after connect. Skip it entirely.
      if (st && st.autopilot != null && st.autopilot !== 3) { appLog("[auto-ble] INAV — BT-UART так не налаштовується, пропускаю пробу"); return; }
      appLog("[auto-ble] проба BT-UART (проактивно)…");
      const ORDER = ["SERIAL4", "SERIAL6", "SERIAL1", "SERIAL3"];
      const states = {};
      for (const u of ORDER) {
        const r = await a.mav_get_param({ name: u + "_PROTOCOL" });
        if (r.ok) states[u] = Math.round(r.value);
      }
      appLog("[auto-ble] протоколи UART: " + JSON.stringify(states));
      const target = ORDER.find((u) => states[u] === 32)
                  || ORDER.find((u) => states[u] === -1);
      if (!target) {
        const already = ORDER.filter((u) => states[u] === 2);
        if (already.length) {
          // Bluetooth вже налаштований — це НОРМА після першої активації.
          appLog("[auto-ble] BT-UART вже MAVLink (" + already.join(",") + ") — нічого робити");
          if (p.mac) {
            blePendingClear();
            setMsg("Bluetooth уже налаштований (" + already.join(", ") + "), але минула BLE-спроба мовчала — надішли лог кнопкою «Лог».", "error");
          }
        } else {
          appLog("[auto-ble] вільного/MSP UART не знайдено — нічого не чіпаю");
          if (p.mac) { blePendingClear(); setMsg("Не знайшов UART для Bluetooth (усі зайняті) — надішли лог кнопкою «Лог».", "error"); }
        }
        return;
      }
      appLog("[auto-ble] ціль: " + target + " (протокол був " + states[target] + ")");
      const w = await a.mav_set_param({ name: target + "_PROTOCOL", value: 2 });
      if (!w.ok) { appLog("[auto-ble] запис PROTOCOL не вдався: " + (w.error || "")); return; }
      const rb2 = await a.mav_get_param({ name: target + "_BAUD" });
      if (!rb2.ok || Math.round(rb2.value) !== 115)
        await a.mav_set_param({ name: target + "_BAUD", value: 115 });
      blePendingClear();
      appLog("[auto-ble] " + target + " → MAVLink@115200, перезавантажую плату");
      setMsg("Bluetooth налаштовано (" + target + "). Перезавантажую плату і перепідключусь сам…", "ok");
      const rr = await a.mav_reboot();
      if (!rr.ok) appLog("[auto-ble] reboot без ACK (" + (rr.error || "таймаут") + ") — чекаю довше");
      try { mavDisconnect(); } catch (e) {}
      let mac = p.mac;
      try { mac = mac || localStorage.getItem(LAST_KEY) || ""; } catch (e) {}
      if (mac) window.__fmpBleAutoReconnect(mac, rr.ok ? 13000 : 17000);
      else setMsg("Bluetooth активовано — плата перезавантажується (~10 с). Далі: тип «Bluetooth (BLE)» → Сканувати → Підключити.", "ok");
    };
  })();

  // Follow-drone toggle (centers the map on the drone in flight).
  const _ff = $("mav-follow");
  if (_ff) { mavFollow = _ff.checked; syncFollowBtn(); _ff.addEventListener("change", () => { mavFollow = _ff.checked; syncFollowBtn(); }); }
  updateMissionStatus();   // show initial mission status

  function mavConnString() {
    const t = $("mav-conn-type").value;
    if (t === "cable" || t === "handset") return $("mav-port").value;   // handset = EdgeTX/ELRS over USB serial (#7)
    if (t === "ble") return "ble:" + ($("mav-ble-list") ? $("mav-ble-list").value : "");
    const addr = ($("mav-address").value || "").trim();
    // Empty address → sensible auto-default (UDP listens on all interfaces).
    if (t === "tcp") return "tcp:" + (addr || MAV_DEFAULT_ADDR.tcp);
    return "udp:" + (addr || MAV_DEFAULT_ADDR.udp);
  }

  async function mavConnect() {
    if (mavConnected || mavConnecting) return;   // re-entrancy: block the boot-timer↔manual double-connect race
    const a = mavApi();
    if (!a || !a.mav_connect) { setMsg("API недоступний.", "error"); return; }
    const conn = mavConnString();
    if (!conn) { setMsg("Обери COM-порт або введи адресу.", "error"); return; }
    mavConnecting = true;
    if (_autoReconnectTimer) { clearTimeout(_autoReconnectTimer); _autoReconnectTimer = null; }
    setMsg("Підключаюсь до дрона…", null);
    appLog("connect → " + conn + " baud=" + $("mav-baud").value);
    $("mav-connect").disabled = true;
    try {
      const bv = $("mav-baud").value;
      const r = await a.mav_connect({ conn, baud: bv === "auto" ? "auto" : parseInt(bv, 10) });
      appLog("connect result: " + JSON.stringify(r));
      if (r && r.ok) {
        mavConnected = true;
        // #3: pinned live-telemetry notification — the native foreground service keeps the
        // link + notification alive while the WebView is frozen in the background.
        try {
          if (window.AndroidNotify && window.AndroidNotify.start) {
            window.AndroidNotify.start();
            if (flownWpTotal > 0) window.AndroidNotify.setMission(flownWpTotal);
          }
        } catch (e) { appLog("AndroidNotify.start failed: " + e); }
        $("mav-connect").disabled = true;
        $("mav-disconnect").disabled = false;
        $("mav-upload").disabled = false;
        mavSetControls(true);
        $("mav-hud").classList.remove("hidden");
        const bnote = r.baud ? ` (baud ${r.baud})` : "";
        let wmsg = r.warning || "Підключено до дрона.";
        // A silent BLE link = the FC's BT-UART is not on MAVLink yet. Remember it:
        // the NEXT connection over a working link (USB-OTG/WiFi) configures the
        // UART automatically and re-connects over BLE — zero buttons.
        if (r.warning && conn.startsWith("ble:")) {
          if (window.__fmpBleMarkPending) window.__fmpBleMarkPending(conn.slice(4));
          wmsg += " Політник мовчить — запамʼятав: підключись по USB-OTG або WiFi, і я налаштую Bluetooth сам і перепідключусь автоматично.";
        }
        setMsg(wmsg + bnote, r.warning ? null : "ok");
        mavStartPolling();
        sessionPatch({ wasConnected: true, connType: $("mav-conn-type").value });
        // Working non-BLE link + a pending BLE setup -> run it, hands-free.
        if (!conn.startsWith("ble:") && window.__fmpAutoBleSetup)
          setTimeout(() => { try { window.__fmpAutoBleSetup(); } catch (e) {} }, 1500);
      } else {
        $("mav-connect").disabled = false;
        setMsg((r && r.error) || "Не вдалося підключитись.", "error");
      }
    } catch (e) {
      $("mav-connect").disabled = false;
      setMsg("Помилка підключення: " + e, "error");
    } finally {
      mavConnecting = false;
    }
  }
  // Boot auto-reconnect dispatcher (#2): re-open the last session's link with no user action.
  // BLE branch is byte-for-byte the previous behaviour; UDP/TCP/cable added. Desktop WebSerial is
  // skipped (port indices don't survive a reload). Guarded by mavConnecting so it can't race a manual tap.
  function bootAutoReconnect(ss) {
    if (!ss || !ss.wasConnected) return;
    const conn = ss.connType;
    if (conn === "ble") {
      if (!(window.AndroidBle && window.__fmpBleAutoReconnect)) return;
      let mac = "";
      try { mac = localStorage.getItem("fmp_ble_last") || ""; } catch (e) {}
      if (mac) { appLog("[restore] авто-реконект BLE до " + mac); window.__fmpBleAutoReconnect(mac, 2500); }
      return;
    }
    if ((conn === "cable" || conn === "handset") && !IS_ANDROID) return;   // desktop WebSerial: no auto-open (needs a gesture)
    if (conn !== "cable" && conn !== "handset" && conn !== "udp" && conn !== "tcp") return;
    try {
      const tsel = $("mav-conn-type");
      if (tsel && tsel.querySelector('option[value="' + conn + '"]')) { tsel.value = conn; mavSyncRows(); }
    } catch (e) {}
    if (ss.addr && $("mav-address")) { try { $("mav-address").value = ss.addr; } catch (e) {} }
    appLog("[restore] авто-реконект " + conn + (ss.addr ? " → " + ss.addr : ""));
    _autoReconnectTimer = setTimeout(() => {
      _autoReconnectTimer = null;
      if (!mavConnected && !mavConnecting) mavConnect();
    }, 1200);
  }

  async function mavDisconnect() {
    if (_autoReconnectTimer) { clearTimeout(_autoReconnectTimer); _autoReconnectTimer = null; }
    const a = mavApi();
    mavStopPolling();
    try { if (a && a.mav_disconnect) await a.mav_disconnect(); } catch (e) { /* ignore */ }
    mavConnected = false;
    try { if (window.AndroidNotify && window.AndroidNotify.stop) window.AndroidNotify.stop(); } catch (e) {}
    $("mav-connect").disabled = false;
    $("mav-disconnect").disabled = true;
    $("mav-upload").disabled = true;
    mavSetControls(false);
    $("mav-hud").classList.add("hidden");
    if (droneMarker) { map.removeLayer(droneMarker); droneMarker = null; }
    if (droneTrack) { map.removeLayer(droneTrack); droneTrack = null; }
    mavClearTarget();
    if (_overlay) _overlay.card.classList.add("hidden");   // #11: don't freeze the overlay on the last frame
    if (liveHomeMarker) { map.removeLayer(liveHomeMarker); liveHomeMarker = null; }
    if (droneMissionLayer) { map.removeLayer(droneMissionLayer); droneMissionLayer = null; }
    flightRecAbort();               // link dropped mid-flight -> save what we have (partial)
    mavResetPhase();
    gpsGuardReset();                // clear the GPS-guard state + silence any alarm
    lastStatus = null;
    // Keep flownRoute (what we uploaded) so the mission-status survives a
    // reconnect — the drone still holds that mission.
    updateMissionStatus();
    setMsg("Відключено від дрона.", null);
  }

  $("mav-connect").addEventListener("click", mavConnect);
  $("mav-disconnect").addEventListener("click", mavDisconnect);

  function mavStartPolling() {
    mavStopPolling();
    if (document.hidden) return;        // don't poll a hidden screen (battery)
    mavPollTimer = setInterval(mavPoll, 500);
    mavCountdownTimer = setInterval(mavCountdownTick, 250);   // smooth countdown between polls
    mavPoll();
  }
  function mavStopPolling() {
    if (mavPollTimer) { clearInterval(mavPollTimer); mavPollTimer = null; }
    if (mavCountdownTimer) { clearInterval(mavCountdownTimer); mavCountdownTimer = null; }
  }
  // Pause telemetry polling while the screen/app is hidden, resume on return —
  // saves battery + CPU in the field (the mission keeps running on the FC anyway).
  // #3 field report: while the WebView is frozen (screen off) JS collects no track points —
  // the map showed a hole between "before" and "after". The native TelemetryService buffers
  // armed positions (1 Hz) the whole time; on resume we drain them and backfill the map track
  // and the flight record, so the flown path and the Га/хв stats stay continuous.
  function drainNativeTrack() {
    if (!window.AndroidNotify || !window.AndroidNotify.drainTrack) return;
    try {
      const rows = JSON.parse(window.AndroidNotify.drainTrack() || "[]");
      if (!rows.length) return;
      for (const r of rows) {
        const t = r[0], la = r[1], ln = r[2], al = r[3];
        if (droneTrack) {
          const pts = droneTrack.getLatLngs();
          const last = pts.length ? pts[pts.length - 1] : null;
          if (!last || haversineM(last.lat, last.lng, la, ln) > 2) {
            if (pts.length > 5200) droneTrack.setLatLngs(pts.slice(-5000));
            droneTrack.addLatLng([la, ln]);
          }
        }
        if (flightRec && t > (flightRec._last || 0)) {
          flightRec.samples.push({ t: t, lat: la, lon: ln, alt: al, gs: null, bv: null, bp: null, wp: null });
          flightRec._last = t;
        }
      }
      appLog("track: домальовано " + rows.length + " фонових точок (екран був вимкнений)");
    } catch (e) { appLog("track drain failed: " + e); }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { flushLog(); flightRecPersist(true); mavStopPolling(); }
    else if (mavConnected) { drainNativeTrack(); mavStartPolling(); }
  });

  function fixName(f) {
    return ({ 0: "немає", 1: "немає", 2: "2D", 3: "3D", 4: "DGPS", 5: "RTK-float", 6: "RTK-fix" })[f] || "?";
  }

  async function mavPoll() {
    const a = mavApi();
    if (!a || !a.mav_status) return;
    let s;
    try { s = await a.mav_status(); } catch (e) { return; }
    // The await can resolve AFTER disconnect cleared the map layers — bail so a
    // stale poll can't resurrect the drone marker / track / target.
    if (!mavConnected) return;
    if (!s || !s.ok) return;
    lastStatus = s;
    if (s && s.vehicle_type === 1) { try { localStorage.setItem("fmp_is_plane", "1"); } catch (e) {} }
    missionProgressTick(s);      // резюме після заміни батареї: памʼятаємо точку
    flightRecTick(s);
    mavDetectPhase(s);
    mavUpdateHome(s);
    gpsGuardTick(s);             // anti-jamming / anti-spoofing watchdog
    // Periodic telemetry snapshot into the log (~every 10 s) — the trail of what
    // actually arrived over the link, for after-the-fact error analysis.
    if (!mavPoll._lastSnap || Date.now() - mavPoll._lastSnap > 10000) {
      mavPoll._lastSnap = Date.now();
      // OPSEC: log the DIAGNOSTIC state only — never lat/lon/home. `hasfix` shows a
      // position arrived without leaking WHERE. (security audit S3)
      appLog(`tlm mode=${s.mode} armed=${s.armed} alt=${s.alt_rel} fix=${s.fix_type} sats=${s.sats} `
        + `hasfix=${s.lat != null} batt=${s.battery_v} gs=${s.groundspeed} wp=${s.wp_current}/${s.wp_total}`);
    }
    const _p = mavProgressData(s);   // compute ONCE (side-effects: target marker + countdown) → fan out
    mavRenderHud(s, _p);
    mavOverlayRender(s, _p);
    mavUpdateMarker(s);
  }

  // ==== GPS protection: anti-JAMMING + anti-SPOOFING (warn-only, fully offline) ====
  // Watches the drone's own GPS telemetry (fix/sats/HDOP + position-vs-velocity) and
  // raises a LOUD alarm (red banner + beep + phone vibration) when the satellite signal
  // is lost/degraded (jamming) or the reported position jumps impossibly (spoofing).
  // It NEVER touches the drone — the operator decides what to do (Ivan's choice).
  const gpsGuard = {
    enabled: true, hadFix: false,
    lastLat: null, lastLon: null, lastT: 0, threatSince: 0,
    level: "init", reason: "", acked: false, alarmOn: false,
  };
  function gpsGuardReset() {
    gpsGuard.hadFix = false; gpsGuard.lastLat = null; gpsGuard.lastLon = null;
    gpsGuard.lastT = 0; gpsGuard.threatSince = 0;
    gpsGuard.level = "init"; gpsGuard.reason = ""; gpsGuard.acked = false;
    gpsGuardAlarmOff(); gpsGuardRender();
  }
  function gpsGuardTick(s) {
    if (!gpsGuard.enabled || !s) { gpsGuardRender(); return; }
    const fix = s.fix_type, sats = s.sats;
    // Ignore an invalid/placeholder HDOP (e.g. 99.99 = the "no data" sentinel) — it is
    // NOT jamming; a real degraded HDOP under jamming is in the single–low-tens range.
    const hdop = (s.hdop != null && s.hdop > 0 && s.hdop < 50) ? s.hdop : null;
    if (fix != null && fix >= 3) gpsGuard.hadFix = true;
    // A valid position: present, finite, inside Earth bounds, and NOT the ~(0,0) garbage
    // a link drop emits — comparing a real fix to that garbage was the 5976 km false spoof.
    const validPos = (s.lat != null && s.lon != null && isFinite(s.lat) && isFinite(s.lon)
      && Math.abs(s.lat) <= 85 && Math.abs(s.lon) <= 180
      && !(Math.abs(s.lat) < 0.01 && Math.abs(s.lon) < 0.01));

    let raw = "ok", reason = "Сигнал у нормі";
    // ---- JAMMING (signal lost / starved) — only meaningful once we HAD a fix ----
    if (gpsGuard.hadFix && (fix == null || fix < 3)) {
      raw = "jam"; reason = "GPS втрачено (немає 3D-фіксу) — ймовірне глушіння";
    } else if (gpsGuard.hadFix && fix != null && fix >= 3 && sats != null && sats <= 4) {
      raw = "jam"; reason = "Критично мало супутників (" + sats + ") — ймовірне глушіння";
    } else if (hdop != null && hdop > 5) {
      raw = "jam"; reason = "Дуже погана точність GPS (HDOP " + hdop + ") — глушіння/перешкоди";
    } else if ((fix != null && fix >= 3 && sats != null && sats < 7) || (hdop != null && hdop > 2.5)) {
      raw = "warn"; reason = "Слабкий сигнал (супутників " + (sats == null ? "?" : sats)
        + ", HDOP " + (hdop == null ? "?" : hdop) + ")";
    }
    // ---- SPOOFING (position jumps faster than the drone can possibly move) ----
    if (validPos) {
      const now = Date.now();
      if (gpsGuard.lastLat != null && gpsGuard.lastT) {
        const dt = (now - gpsGuard.lastT) / 1000;
        if (dt >= 0.25) {
          const dist = haversineM(gpsGuard.lastLat, gpsGuard.lastLon, s.lat, s.lon);
          const implied = dist / dt;                       // m/s the GPS claims we moved
          const repV = Math.max(s.groundspeed || 0, s.gps_vel || 0,
            (s.vx != null && s.vy != null) ? Math.hypot(s.vx, s.vy) : 0);
          // A genuine fix can't outrun the reported speed by much (allow noise + lag).
          if (dist > 25 && implied > repV * 3 + 8) {
            raw = "spoof";
            reason = "Стрибок позиції " + Math.round(dist) + " м за " + dt.toFixed(1)
              + "с (≈" + Math.round(implied) + " м/с) при швидкості " + repV.toFixed(0)
              + " м/с — підозра на СПУФІНГ";
          }
          gpsGuard.lastLat = s.lat; gpsGuard.lastLon = s.lon; gpsGuard.lastT = now;
        }
      } else { gpsGuard.lastLat = s.lat; gpsGuard.lastLon = s.lon; gpsGuard.lastT = now; }
    } else {
      // garbage position (link drop) → drop the baseline so the next REAL fix isn't
      // measured against it (otherwise a 0,0 emits a false multi-thousand-km teleport).
      gpsGuard.lastLat = null; gpsGuard.lastT = 0;
    }

    // DEBOUNCE: a threat must PERSIST ≥3s before it raises the alarm, so the transient
    // garbage telemetry during a link reconnect (fix=null, sats=4, HDOP=99.99, 0,0 pos)
    // can never trigger a false alarm — those clear within a second or two.
    const rawThreat = (raw === "jam" || raw === "spoof");
    if (rawThreat) { if (!gpsGuard.threatSince) gpsGuard.threatSince = Date.now(); }
    else gpsGuard.threatSince = 0;
    let level = raw;
    if (rawThreat && (Date.now() - gpsGuard.threatSince) < 3000) {
      level = "warn"; reason = "Перевіряю сигнал GPS…";   // suspected, not yet confirmed
    }

    const threat = (level === "jam" || level === "spoof");
    if (threat && gpsGuard.level !== level) {              // a NEW confirmed threat re-arms the alarm
      gpsGuard.acked = false;
      appLog("GPS-GUARD " + level.toUpperCase() + ": " + reason);
    }
    if (!threat) gpsGuard.acked = false;                    // signal recovered → ready again
    gpsGuard.level = level; gpsGuard.reason = reason;
    if (threat && !gpsGuard.acked) gpsGuardAlarmOn(); else gpsGuardAlarmOff();
    gpsGuardRender();
  }

  // ---- alarm: looping beep + phone vibration while an unacknowledged threat is live --
  let _ggAudio = null, _ggBeepTimer = null;
  function gpsBeep() {
    try {
      if (!_ggAudio) _ggAudio = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = _ggAudio;
      if (ctx.state === "suspended") ctx.resume();
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "square"; o.frequency.value = 920;
      o.connect(g); g.connect(ctx.destination);
      const t = ctx.currentTime;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
      o.start(t); o.stop(t + 0.34);
    } catch (e) {}
  }
  function gpsGuardAlarmOn() {
    if (gpsGuard.alarmOn) return;
    gpsGuard.alarmOn = true;
    gpsBeep();
    _ggBeepTimer = setInterval(gpsBeep, 850);
    try { if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 400]); } catch (e) {}
  }
  function gpsGuardAlarmOff() {
    if (!gpsGuard.alarmOn) return;
    gpsGuard.alarmOn = false;
    if (_ggBeepTimer) { clearInterval(_ggBeepTimer); _ggBeepTimer = null; }
    try { if (navigator.vibrate) navigator.vibrate(0); } catch (e) {}
  }

  const GPS_GUARD_LABELS = {
    off:    ["#6b7280", "Захист вимкнено"],
    nolink: ["#6b7280", "Немає звʼязку з дроном"],
    init:   ["#6b7280", "Очікую фікс GPS…"],
    ok:     ["#3fb27f", "GPS у нормі"],
    warn:   ["#ffd166", "Слабкий сигнал GPS"],
    jam:    ["#ff3b30", "ГЛУШІННЯ GPS"],
    spoof:  ["#ff3b30", "СПУФІНГ GPS"],
  };
  let _gpsGuardSig = null;
  function gpsGuardRender() {
    const lvl = !gpsGuard.enabled ? "off" : (!mavConnected ? "nolink" : gpsGuard.level);
    const base = GPS_GUARD_LABELS[lvl] || GPS_GUARD_LABELS.init;
    const color = base[0], label = base[1];
    const detail = (lvl === "warn" || lvl === "jam" || lvl === "spoof") ? gpsGuard.reason : "";
    const detText = (lvl === "ok" && mavConnected)
      ? ("фікс " + (gpsGuard.level === "ok" ? "3D" : "?") + ", супутників " + (lastStatus && lastStatus.sats != null ? lastStatus.sats : "?")
         + (lastStatus && lastStatus.hdop != null ? ", HDOP " + lastStatus.hdop : ""))
      : detail;
    const showBanner = gpsGuard.enabled && (lvl === "jam" || lvl === "spoof") && !gpsGuard.acked;
    // Skip all DOM writes when nothing visible changed (steady state at 2 Hz). The
    // signature includes the live detail (sats/HDOP), so it still repaints on change.
    const sig = lvl + "|" + color + "|" + label + "|" + detText + "|" + showBanner + "|" + (showBanner ? gpsGuard.reason : "");
    if (sig === _gpsGuardSig) return;
    _gpsGuardSig = sig;
    const dot = $("gps-guard-dot"), txt = $("gps-guard-text"), det = $("gps-guard-detail");
    const banner = $("gps-alarm"), breason = $("gps-alarm-reason"), btitle = $("gps-alarm-title");
    if (dot) dot.style.background = color;
    if (txt) { txt.textContent = label; txt.style.color = color; }
    if (det) det.textContent = detText;
    if (banner) banner.style.display = showBanner ? "" : "none";
    if (showBanner && btitle) btitle.textContent = (lvl === "spoof") ? "СПУФІНГ GPS" : "ГЛУШІННЯ GPS";
    if (showBanner && breason) breason.textContent = gpsGuard.reason;
  }
  if ($("gps-guard-on")) $("gps-guard-on").addEventListener("change", (e) => {
    gpsGuard.enabled = !!e.target.checked;
    if (!gpsGuard.enabled) gpsGuardAlarmOff();
    gpsGuardRender();
  });
  if ($("gps-alarm-ack")) $("gps-alarm-ack").addEventListener("click", () => {
    gpsGuard.acked = true; gpsGuardAlarmOff(); gpsGuardRender();
  });
  gpsGuardRender();   // initial paint of the status pill

  // ---- Flight log (offline): record each real AUTO mission to IndexedDB, and
  // feed planned-vs-actual back into the time/battery estimate (flight_calib).
  // No server, no ML — works fully offline; the data only sharpens the planner.
  let flightRec = null;            // active recording, or null
  let flightSummaries = [];        // compact {planned,actual,partial} fed to build_route
  let lastCalibration = null;      // calibration the engine last applied (for the live ETA)
  let lastBuildStats = null;       // {duration_s,length_m,sprayed_ha} of the last plan
  const FLOG_DB = "fmp_flightlog", FLOG_STORE = "flights";

  function flogOpen() {
    return new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(FLOG_DB, 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => { req.result.createObjectStore(FLOG_STORE, { keyPath: "started_at" }); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function flogPut(rec) {
    try {
      const db = await flogOpen();
      await new Promise((res, rej) => {
        const tx = db.transaction(FLOG_STORE, "readwrite");
        tx.objectStore(FLOG_STORE).put(rec);
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
      return true;
    } catch (e) { return false; }   // private mode / no IndexedDB — keep the in-memory summary only
  }
  async function flogAll() {
    try {
      const db = await flogOpen();
      return await new Promise((res, rej) => {
        const rq = db.transaction(FLOG_STORE, "readonly").objectStore(FLOG_STORE).getAll();
        rq.onsuccess = () => res(rq.result || []);
        rq.onerror = () => rej(rq.error);
      });
    } catch (e) { return []; }
  }
  // Wipe the whole flight log. Used ONLY by a backup-sync restore (#10 review I2) —
  // an honest overwrite must not let a flight deleted on another device resurrect.
  async function flogClearAll() {
    try {
      const db = await flogOpen();
      await new Promise((res, rej) => {
        const tx = db.transaction(FLOG_STORE, "readwrite");
        tx.objectStore(FLOG_STORE).clear();
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
      return true;
    } catch (e) { return false; }
  }
  const flogSummary = (r) => ({ started_at: r.started_at, planned: r.planned || null,
    actual: r.actual || null, partial: !!r.partial });
  const FLOG_MAX_FLIGHTS = 300;
  async function flogTrim(cap) {
    try {
      const all = await flogAll();                 // getAll() → ascending by started_at key
      if (all.length <= cap) return;
      const excess = all.slice(0, all.length - cap);   // the oldest
      const db = await flogOpen();
      await new Promise((res, rej) => {
        const tx = db.transaction(FLOG_STORE, "readwrite");
        const st = tx.objectStore(FLOG_STORE);
        excess.forEach((r) => st.delete(r.started_at));
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
    } catch (e) { /* private mode / quota — best-effort */ }
  }
  async function loadFlightSummaries() {
    const all = await flogAll();
    flightSummaries = all.map(flogSummary);
  }

  // ---- flight statistics tab ----
  let statsRange = "all";
  function _statsRangeFloor(r) {                 // epoch-ms floor of the selected period (LOCAL time)
    const d = new Date();
    if (r === "hour") { d.setMinutes(0, 0, 0); return d.getTime(); }
    if (r === "day") { d.setHours(0, 0, 0, 0); return d.getTime(); }
    return 0;                                     // "all"
  }
  function _haPerMin(rec) {                       // Га/хв = covered_ha / duration_min
    const ac = rec.actual || {}, cov = ac.covered_ha, sec = ac.duration_s;
    if (cov == null || !sec || sec <= 0) return null;
    return cov / (sec / 60);
  }
  function _bindStatsChips() {
    const pane = $("tab-stats"); if (!pane || pane._statsBound) return;
    pane._statsBound = true;                       // bind ONCE on the stable pane (host innerHTML is replaced)
    pane.addEventListener("click", (e) => {
      const b = e.target.closest("[data-range]"); if (!b) return;
      statsRange = b.getAttribute("data-range"); renderFlightStats();
    });
  }
  async function renderFlightStats() {
    const host = $("flight-stats"); if (!host) return;
    const rows = (await flogAll())
      .filter((r) => r.started_at >= _statsRangeFloor(statsRange))
      .sort((a, b) => b.started_at - a.started_at);
    const chip = (r, lbl) => `<button class="chip${statsRange === r ? " active" : ""}" data-range="${r}" aria-pressed="${statsRange === r}">${t(lbl)}</button>`;
    let html = `<div class="stats-chips">${chip("hour", "з початку години")}${chip("day", "з початку дня")}${chip("all", "усе")}</div>`;
    if (!rows.length) {
      host.innerHTML = html + `<div class="msg">${t("Немає польотів за обраний період.")}</div>`;
      _bindStatsChips(); return;
    }
    let secTot = 0, distTot = 0, covTot = 0, covDurMin = 0;
    rows.forEach((r) => {
      const ac = r.actual || {};
      secTot += ac.duration_s || 0; distTot += ac.distance_m || 0;
      if (ac.covered_ha != null) { covTot += ac.covered_ha; covDurMin += (ac.duration_s || 0) / 60; }
    });
    const avgHaMin = covDurMin > 0 ? covTot / covDurMin : null;
    const num = (n, d) => (n == null ? "—" : (LANG === "en" ? n.toFixed(d) : String(Math.round(n * 10 ** d) / 10 ** d)));
    const tile = (label, val, cls) => `<div class="stat-tile${cls ? " " + cls : ""}"><div class="sv">${val}</div><div class="sl">${t(label)}</div></div>`;
    html += `<div class="stats-totals">
      ${tile("Польотів", rows.length)}
      ${tile("Годин", num(secTot / 3600, 1))}
      ${tile("Кілометрів", num(distTot / 1000, 1))}
      ${tile("Покрито", num(covTot, 1), "headline")}
      ${tile("Сер. Га/хв", num(avgHaMin, 2))}
    </div>`;
    const cell = (r) => {
      const ac = r.actual || {};
      const spd = ac.avg_speed_ms != null ? num(ac.avg_speed_ms * 3.6, 1) : "—";  // km/h
      return `<tr>
        <td>${esc(r.date || "")}</td>
        <td>${esc(r.field || "поле")}</td>
        <td>${ac.covered_ha != null ? num(ac.covered_ha, 2) : "—"}</td>
        <td>${ac.distance_m != null ? num(ac.distance_m / 1000, 2) : "—"}</td>
        <td>${ac.duration_s != null ? Math.round(ac.duration_s / 60) : "—"}</td>
        <td>${ac.battery_used_pct != null ? ac.battery_used_pct : "—"}</td>
        <td>${spd}</td>
        <td>${_haPerMin(r) != null ? num(_haPerMin(r), 2) : "—"}</td>
      </tr>`;
    };
    const H = (s) => t(s);
    html += `<div class="stats-table-wrap"><table class="stats-table"><thead><tr>
      <th>${H("Дата")}</th><th>${H("Поле")}</th><th>${H("Покрито")}</th><th>${H("Відстань")}</th>
      <th>${H("Час")}</th><th>${H("Батарея")}</th><th>${H("Сер. швидкість")}</th><th>${H("Га/хв")}</th>
      </tr></thead><tbody>${rows.map(cell).join("")}</tbody></table></div>`;
    host.innerHTML = html;
    _bindStatsChips();
  }

  // --- in-flight record persistence: survive an app kill mid-flight (#2, stats/calibration only) ---
  const FLIGHTREC_KEY = "fmp_flightrec_active";
  let _flightRecPersistTs = 0;
  function flightRecPersist(force) {
    if (!flightRec) return;
    const now = Date.now();
    if (!force && now - _flightRecPersistTs < 10000) return;   // ~10 s throttle
    _flightRecPersistTs = now;
    try {
      localStorage.setItem(FLIGHTREC_KEY, JSON.stringify({
        started_at: flightRec.started_at, planned: flightRec.planned, work: flightRec.work,
        // Keep the WHOLE track for realistic flights (1 h @ ~1 Hz) — a tail-cap would truncate the
        // early track while actual_duration still uses started_at → understated distance/covered/speed.
        bp_start: flightRec.bp_start, samples: flightRec.samples.slice(-3600),
        sawComplete: flightRec.sawComplete, wp_reached: flightRec.wp_reached, wp_total: flightRec.wp_total,
      }));
    } catch (e) {}
  }
  function flightRecClearPersist() { _flightRecPersistTs = 0; try { localStorage.removeItem(FLIGHTREC_KEY); } catch (e) {} }
  async function flogHas(startedAt) {
    try {
      const db = await flogOpen();
      return await new Promise((res, rej) => {
        const rq = db.transaction(FLOG_STORE, "readonly").objectStore(FLOG_STORE).get(startedAt);
        rq.onsuccess = () => res(rq.result != null);
        rq.onerror = () => rej(rq.error);
      });
    } catch (e) { return false; }
  }
  // On boot: an active record left by a kill mid-flight is finalized ONCE as partial (flight-control
  // continuity has no value — this is only stats/calibration). flogHas dedup prevents re-finalizing
  // (same started_at key) a flight that already reached the log with a good complete record.
  async function flightRecRestore() {
    if (flightRec) return;        // a live recording already started (defensive vs a fast reconnect race)
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(FLIGHTREC_KEY) || "null"); } catch (e) {}
    if (!saved || !saved.started_at || !saved.samples || !saved.samples.length) { flightRecClearPersist(); return; }
    if (await flogHas(saved.started_at)) { flightRecClearPersist(); return; }   // already finalized → dedup
    flightRec = Object.assign({ _last: 0 }, saved);          // rehydrate as the active record
    await flightRecFinalize(null, true);                     // ALWAYS partial (finalize clears the mirror)
  }
  // Start recording when the drone arms in AUTO; sample ~1 Hz; finalize on disarm.
  function flightRecTick(s) {
    const armed = !!s.armed, auto = (s.mode || "").toUpperCase() === "AUTO";
    if (!flightRec) {
      if (armed && auto) {
        flightRec = { started_at: Date.now(),
          planned: lastBuildStats ? Object.assign({}, lastBuildStats) : null,
          work: lastWorkContext ? Object.assign({}, lastWorkContext) : null,
          bp_start: (s.battery_pct != null ? s.battery_pct : null),
          samples: [], sawComplete: false, wp_reached: 0, wp_total: s.wp_total || 0, _last: 0 };
        appLog("flightlog: recording started (AUTO armed)");
      }
      return;
    }
    const now = Date.now();
    if (now - flightRec._last > 900) {                 // ~1 Hz
      flightRec._last = now;
      flightRec.samples.push({ t: now, lat: s.lat, lon: s.lon, alt: s.alt_rel,
        gs: s.groundspeed, bv: s.battery_v, bp: s.battery_pct, wp: s.wp_current });
    }
    flightRecPersist();                                // throttled disk mirror (survives an app kill)
    if (s.wp_total && s.wp_current != null && s.wp_current >= s.wp_total - 1) flightRec.sawComplete = true;
    if (s.wp_current != null) flightRec.wp_reached = Math.max(flightRec.wp_reached, s.wp_current);
    if (!armed) flightRecFinalize(s, false);           // disarmed -> flight over
  }
  function _sampleDist(samples) {
    let d = 0;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1], b = samples[i];
      if (a.lat != null && b.lat != null) d += haversineM(a.lat, a.lon, b.lat, b.lon);
    }
    return d;
  }
  async function flightRecFinalize(s, partial) {
    const fr = flightRec; flightRec = null;
    flightRecClearPersist();                           // finalized → the active mirror is stale
    if (!fr || !fr.samples.length) return;
    const last = fr.samples[fr.samples.length - 1];
    const actual_duration = (last.t - fr.started_at) / 1000;
    if (actual_duration < 5) return;                   // too short to be a real flight
    const bp_end = (s && s.battery_pct != null) ? s.battery_pct : last.bp;
    const battery_used = (fr.bp_start != null && bp_end != null) ? (fr.bp_start - bp_end) : null;
    // Covered area (spec §8): complete (>=90% / sawComplete) → the planned field area; partial →
    // in-field track distance × swath, capped at the field area. Geometry lives in GEO_COVER.
    const comp = window.GEO_COVER.coverageCompletion({
      sawComplete: fr.sawComplete, wpReached: fr.wp_reached || 0, wpTotal: fr.wp_total || 0, hasRtl: flownHasRtl });
    const ring = (fr.work && fr.work.boundary) || null;
    const trackDist = _sampleDist(fr.samples);
    let distM = window.GEO_COVER.distInField(fr.samples, ring);
    if (distM == null) distM = trackDist;                 // no ring → whole track (still capped)
    const swath_m = (fr.work && fr.work.swath_m) || 0;
    const covArgs = { covComplete: comp.covComplete, areaHa: (fr.work && fr.work.area_ha) || 0, swathM: swath_m, distM: distM };
    const covered_ha = window.GEO_COVER.coveredHa(covArgs);
    // A "complete" that the flown distance can't plausibly back (short test hop / battery-swap
    // remainder reaching ITS last WP) must not count as a full-field pass — no cycle credit,
    // and the row stays «частковий». (field report: 51 га за 3 хв)
    const fullOk = window.GEO_COVER.fullCreditOk(covArgs);
    const avg_speed_ms = actual_duration > 0 ? (trackDist / actual_duration) : null;
    const rec = {
      started_at: fr.started_at, ended_at: last.t, planned: fr.planned,
      actual: { duration_s: Math.round(actual_duration),
        battery_used_pct: (battery_used != null ? Math.round(battery_used) : null),
        distance_m: Math.round(trackDist),
        covered_ha: (covered_ha != null ? Math.round(covered_ha * 100) / 100 : null),
        completion_pct: comp.completionPct,
        avg_speed_ms: (avg_speed_ms != null ? Math.round(avg_speed_ms * 10) / 10 : null),
        swath_m: swath_m || null },
      partial: !!partial || !fullOk,
      field: (fr.work && fr.work.field) || "поле",
      date: new Date(fr.started_at).toISOString().slice(0, 10),
      work: fr.work || null,
      params: { wp_total: fr.wp_total }, samples: fr.samples,
    };
    await flogPut(rec);
    await flogTrim(FLOG_MAX_FLIGHTS);
    await fieldProgressCredit(fr, covered_ha, fullOk);   // #8: credit this flight to its contour
    flightSummaries.push(flogSummary(rec));
    scheduleAutoSync("flight");      // #10: opt-in backup-sync — a finished flight is worth protecting
    const mins = Math.round(actual_duration / 60);
    setMsg(`Політ записано (${mins} хв${rec.partial ? ", частковий" : ""}). Оцінки часу відкалібруються.`, "ok");
  }
  // #8: credit a finished flight to its field's cycle counters. Field is the one snapshotted
  // at ARM time (fr.work.field), not currentFieldName (which may change between upload and disarm).
  // complete → completed_count++ and reset done_ha; partial → accumulate done_ha (spec §B.8, §8).
  async function fieldProgressCredit(fr, coveredHa, covComplete) {
    const name = (fr.work && fr.work.field) || "";
    if (!name || name === "поле" || coveredHa == null) return;   // raw/no-plan flight or unnamed → skip
    const recs = await fldAll();                                 // null → IDB unavailable, use localStorage
    const useLp = recs === null;
    const rec = useLp ? lpAll()[name] : (recs || []).find((r) => r.name === name);
    if (!rec) return;                                            // never-saved contour → nothing to credit
    const upd = window.GEO_COVER.applyFieldCredit(rec, coveredHa, covComplete);
    upd.last_flight_at = Date.now();
    upd.updated = Date.now();                                    // #10 LWW: keep this progress on a later sync
    const ok = useLp ? false : await fldPut(upd);
    if (!ok) { try { lpSave(name, upd); } catch (e) {} }          // mirror the localStorage fallback used elsewhere
  }
  function flightRecAbort() { if (flightRec) flightRecFinalize(lastStatus, true); }
  loadFlightSummaries();          // warm the in-memory cache on startup

  // Share a file if the platform supports it, else trigger a download. Reused by
  // the flight-log JSON, the work-records CSV, and the KML contour export.
  async function downloadBlob(filename, mime, text) {
    const blob = new Blob([text], { type: mime });
    try {
      const file = new File([blob], filename, { type: mime });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        return;
      }
    } catch (e) { /* fall through to a normal download */ }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  $("export-flights").addEventListener("click", async () => {
    const all = await flogAll();
    if (!all.length) { setMsg("Журнал польотів порожній — ще не було записаних вильотів.", null); return; }
    await downloadBlob(`flightlog_${all.length}.json`, "application/json", JSON.stringify(all, null, 2));
    setMsg(`Журнал експортовано (${all.length} вильотів).`, "ok");
  });
  // Work records -> CSV (date/field/area/time/battery…), one row per logged flight.
  function csvCell(v) {
    const s = v == null ? "" : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;   // RFC-4180 escape
  }
  function flightsToCsv(all) {
    const head = ["date", "field", "area_ha", "sprayed_ha", "duration_planned_s",
      "duration_actual_s", "battery_used_pct", "distance_m", "sections", "partial"];
    const rows = all.map((r) => {
      const w = r.work || {}, pl = r.planned || {}, ac = r.actual || {};
      return [r.date, r.field, w.area_ha, w.sprayed_ha, pl.duration_s, ac.duration_s,
        ac.battery_used_pct, ac.distance_m, w.sections, r.partial ? 1 : 0].map(csvCell).join(",");
    });
    return "﻿" + [head.join(","), ...rows].join("\r\n") + "\r\n";   // BOM = Excel/Cyrillic
  }
  $("export-flights-csv").addEventListener("click", async () => {
    const all = await flogAll();
    if (!all.length) { setMsg("Журнал польотів порожній.", null); return; }
    await downloadBlob(`worklog_${all.length}.csv`, "text/csv;charset=utf-8", flightsToCsv(all));
    setMsg(`Записи робіт експортовано (${all.length}) у CSV.`, "ok");
  });

  // HUD rows are built ONCE and then updated value-by-value (textContent), instead
  // of re-concatenating + reparsing innerHTML twice a second. That kills the
  // steady DOM churn / layout cost during flight on phones. The untrusted fields
  // (mode, last_text) go through textContent, so escaping is intrinsic.
  const HUD_ROWS = [
    ["link", "Лінк"], ["mode", "Режим"], ["armed", "Стан"], ["gps", "GPS"],
    ["diag", "Телеметрія"],
    ["battery", "Батарея"], ["alt", "Висота"], ["speed", "Швидкість"], ["wp", "Точка"],
    ["progress", "Прогрес"], ["tonext", "До точки"], ["remaining", "Лишилось"],
    ["eta", "ETA"], ["finish", "До завершення"], ["land", "До посадки"], ["message", "Повідомл."],
  ];
  let _hud = null;
  // ---- on-map telemetry overlay (#11): same data as the pinned notification, single source
  // (lastStatus + the passed mavProgressData p). Child of the map container (like elev-badge);
  // pointer-events:none so the map stays fully pannable in gloves. ----
  let _overlay = null;
  function mavOverlayEnsure() {
    if (_overlay) return _overlay;
    const card = L.DomUtil.create("div", "map-card mav-overlay hidden", map.getContainer());
    card.innerHTML =
      '<div class="mo-head"><span class="mo-link"></span><span class="mo-mode"></span><span class="mo-armed"></span></div>'
      + '<div class="mo-prog"><div class="mo-bar"><i></i></div><span class="mo-pct"></span><span class="mo-wp"></span></div>'
      + '<div class="mo-chips"><span class="mo-batt"></span><span class="mo-alt"></span><span class="mo-gs"></span></div>';
    _overlay = { card,
      link: card.querySelector(".mo-link"), mode: card.querySelector(".mo-mode"), armed: card.querySelector(".mo-armed"),
      bar: card.querySelector(".mo-bar > i"), pct: card.querySelector(".mo-pct"), wp: card.querySelector(".mo-wp"),
      batt: card.querySelector(".mo-batt"), alt: card.querySelector(".mo-alt"), gs: card.querySelector(".mo-gs"),
      last: {} };
    return _overlay;
  }
  function _moSet(o, key, el, text, color) {              // diff-guarded write (textContent = escaping)
    const prev = o.last[key];
    if (prev && prev.t === text && prev.c === color) return;
    o.last[key] = { t: text, c: color };
    el.textContent = text;
    if (color !== undefined) el.style.color = color || "";
  }
  function mavOverlayRender(s, p) {
    const o = mavOverlayEnsure();
    if (!mavOverlayOn || !mavConnected) { o.card.classList.add("hidden"); return; }
    o.card.classList.remove("hidden");
    _moSet(o, "link", o.link, s.connected ? "●" : "○", s.connected ? "var(--ok)" : "var(--danger)");
    _moSet(o, "mode", o.mode, s.mode || "—", null);
    _moSet(o, "armed", o.armed, s.armed == null ? "?" : (s.armed ? "ARMED" : "disarmed"),
      s.armed == null ? null : (s.armed ? "var(--danger)" : "var(--ok)"));
    const battTxt = s.battery_v != null ? `${s.battery_v} В` + (s.battery_pct != null ? ` · ${s.battery_pct}%` : "") : "—";
    const battCol = s.battery_pct == null ? null : (s.battery_pct > 50 ? "var(--ok)" : (s.battery_pct >= 20 ? "var(--warn)" : "var(--danger)"));
    _moSet(o, "batt", o.batt, battTxt, battCol);
    _moSet(o, "alt", o.alt, s.alt_rel != null ? `${s.alt_rel} м` : "—", null);
    _moSet(o, "gs", o.gs, s.groundspeed != null ? `${s.groundspeed} м/с` : "—", null);
    const pct = p ? Math.max(0, Math.min(100, Math.round(p.pct))) : null;   // distance-based (same as notification)
    _moSet(o, "pct", o.pct, pct != null ? pct + "%" : "—", null);
    _moSet(o, "wp", o.wp, "WP " + (s.wp_current != null ? `${s.wp_current} / ${s.wp_total || flownWpTotal || "—"}` : "—"), null);
    const w = pct != null ? pct : 0;
    if (o.last.barw !== w) { o.last.barw = w; o.bar.style.width = w + "%"; }
  }
  function mavHudEnsure() {
    const container = $("mav-hud");
    if (_hud && _hud.container === container) return _hud;
    container.innerHTML = "";
    const rows = {};
    for (const [key, label] of HUD_ROWS) {
      const el = document.createElement("div");
      el.className = "row";
      const l = document.createElement("span");
      l.textContent = label;
      const v = document.createElement("span");
      el.appendChild(l);
      el.appendChild(v);
      container.appendChild(el);
      rows[key] = { el, val: v };
    }
    _hud = { container, rows };
    return _hud;
  }
  function hudSet(rows, key, value, color, show) {
    const r = rows[key];
    if (!r) return;
    if (r.lastShow !== show) { r.el.style.display = show ? "" : "none"; r.lastShow = show; }   // diff (#6)
    if (!show) return;
    if (r.val.textContent !== value) r.val.textContent = value;   // textContent = intrinsic escaping
    const c = color || "";
    if (r.lastColor !== c) { r.val.style.color = c; r.lastColor = c; }   // diff colour writes (#6)
  }
  function mavRenderHud(s, p) {
    const { rows } = mavHudEnsure();
    hudSet(rows, "link", s.connected ? "● онлайн" : "○ немає heartbeat",
      s.connected ? "#5fd3a3" : "#ff7b72", true);
    hudSet(rows, "mode", s.mode || "—", null, true);
    hudSet(rows, "armed", s.armed === null ? "?" : (s.armed ? "ARMED" : "disarmed"),
      s.armed === null ? null : (s.armed ? "#ff7b72" : "#5fd3a3"), true);
    hudSet(rows, "gps", `${fixName(s.fix_type)} · ${s.sats != null ? s.sats : "?"} сат`, null, true);
    // Telemetry-health diagnostic: tells WHY GPS shows "?" — streams not flowing
    // (only heartbeat reaches us, e.g. a too-narrow ELRS link / wrong target) vs a
    // real GPS with no fix yet (needs open sky). Removes the guesswork in the field.
    let diag = "", diagColor = null;
    if (s.connected) {
      const noStreams = s.lat == null && s.fix_type == null && s.battery_v == null && s.groundspeed == null;
      if (noStreams) { diag = "лише heartbeat — потоки не йдуть (канал/ціль?)"; diagColor = "#ff7b72"; }
      else if (s.fix_type === 0 || s.fix_type === 1) { diag = "потоки йдуть, але GPS без фіксу — під небо"; diagColor = "#e3b341"; }
      else if (s.fix_type >= 2) { diag = "телеметрія + GPS"; diagColor = "#5fd3a3"; }
    }
    hudSet(rows, "diag", diag, diagColor, !!diag);
    hudSet(rows, "battery", s.battery_v != null
      ? `${s.battery_v} В` + (s.battery_pct != null ? ` · ${s.battery_pct}%` : "") : "", null, s.battery_v != null);
    hudSet(rows, "alt", s.alt_rel != null ? `${s.alt_rel} м` : "", null, s.alt_rel != null);
    hudSet(rows, "speed", s.groundspeed != null ? `${s.groundspeed} м/с` : "", null, s.groundspeed != null);
    hudSet(rows, "wp", s.wp_current != null
      ? `${s.wp_current}${s.wp_total ? " / " + s.wp_total : ""}` : "", null, s.wp_current != null);
    hudSet(rows, "progress", p ? `${p.pct}%` + (p.phase ? ` · ${p.phase}` : "") : "", null, !!p);
    hudSet(rows, "tonext", p ? `${Math.round(p.dNext)} м` : "", null, !!p);
    hudSet(rows, "remaining", p ? `${(p.rem / 1000).toFixed(2)} км` : "", null, !!p);
    hudSet(rows, "eta", p ? p.eta : "", null, !!p);
    hudSet(rows, "finish", p ? (p.finishS != null ? fmtDuration(p.finishS) : "—") : "", null, !!p);
    hudSet(rows, "land", p ? (p.landS != null ? fmtDuration(p.landS) : "—") : "", null, !!p);
    hudSet(rows, "message", s.last_text || "", null, !!s.last_text);
  }

  // Live mission countdowns ("до завершення" / "до посадки") tick smoothly between
  // the 2 Hz polls. DESCENT_RATE mirrors coverage.LAND_DESCENT_RATE.
  const DESCENT_RATE = 1.5;
  let mavCountdown = { finishS: null, landS: null, at: 0 };
  let mavCountdownTimer = null;
  function mavCountdownTick() {
    if (!mavConnected || mavCountdown.finishS == null) return;
    const { rows } = mavHudEnsure();
    const el = (Date.now() - mavCountdown.at) / 1000;
    hudSet(rows, "finish", fmtDuration(Math.max(0, mavCountdown.finishS - el)), null, true);
    hudSet(rows, "land", fmtDuration(Math.max(0, mavCountdown.landS - el)), null, true);
  }
  // Explicit mission-complete / landing detection — a clear field message when the
  // last waypoint is reached and when the aircraft is down (the flight-log finalize
  // also fires on disarm).
  let _wasArmed = false, _missionDoneShown = false, _landedShown = false;
  let _lastLoggedMode = null, _lastLoggedArmed = null;
  function mavLogTransitions(s) {
    if (!s) return;
    if (s.mode !== _lastLoggedMode || s.armed !== _lastLoggedArmed) {
      appLog(`>> режим=${s.mode} armed=${s.armed} alt=${s.alt_rel}m wp=${s.wp_current}/${s.wp_total} gs=${s.groundspeed}`);
      _lastLoggedMode = s.mode; _lastLoggedArmed = s.armed;
    }
  }
  // Dual-stack UI gate: INAV does NOT accept arm/mode/start/RTL over MAVLink (those
  // are RC-aux only). When an INAV heartbeat is seen, disable those buttons + say so
  // once; mission upload/read + telemetry stay fully available.
  let _inavGated = null;
  function mavStackGate(s) {
    if (!s || s.autopilot == null) return;
    const inav = s.autopilot !== 3;
    if (inav === _inavGated) return;
    _inavGated = inav;
    ["mav-arm", "mav-disarm", "mav-mode", "mav-set-mode", "mav-start", "mav-rtl", "mav-pause"]
      .forEach((id) => { if ($(id)) $(id).disabled = inav; });
    if (inav) setMsg("INAV: телеметрія й заливка/читання місій працюють; arm/режим/старт/RTL — лише з пульта (INAV не приймає їх по MAVLink).", null);
  }
  function mavDetectPhase(s) {
    mavStackGate(s);
    mavLogTransitions(s);
    if (s.armed) {
      _wasArmed = true; _landedShown = false;
      if ((s.wp_current || 0) <= 1) _missionDoneShown = false;       // a fresh mission
    }
    if (!_missionDoneShown && s.armed && s.wp_total && s.wp_current != null
        && s.wp_current >= s.wp_total - 1) {
      _missionDoneShown = true;
      setMsg("Місію завершено — остання точка досягнута.", "ok");
    }
    if (!_landedShown && _wasArmed && s.armed === false
        && (s.alt_rel == null || s.alt_rel < 0.8)) {
      _landedShown = true; _wasArmed = false;
      setMsg("Посадка — апарат на землі (DISARM).", "ok");
    }
  }
  function mavResetPhase() {
    _wasArmed = false; _missionDoneShown = false; _landedShown = false;
    mavCountdown = { finishS: null, landS: null, at: 0 };
  }

  // Live mission progress, driven off the UPLOADED mission (flownRoute), not the
  // editing buffer. The aircraft traverses: home → coverage wps → (home if RTL).
  // Mission seq layout is [home(0), takeoff(1), wp0(2), …, rtl(last)].
  // Mission geometry (visited points + cumulative distance) is CONSTANT for an
  // uploaded mission — cache it keyed on the flown* refs (reassigned only on upload/
  // disconnect) so the 2 Hz progress poll is O(1) instead of rebuilding the array and
  // re-summing every leg with haversine each time.
  let _progCache = null;
  function _progGeom() {
    if (_progCache && _progCache.route === flownRoute && _progCache.home === flownHome
        && _progCache.rtl === flownHasRtl) return _progCache;
    const visited = [];
    if (flownHome) visited.push([flownHome.lat, flownHome.lng]);
    for (const p of flownRoute) visited.push(p);
    if (flownHasRtl && flownHome) visited.push([flownHome.lat, flownHome.lng]);
    const cum = [0];
    for (let k = 0; k < visited.length - 1; k++)
      cum.push(cum[k] + haversineM(visited[k][0], visited[k][1], visited[k + 1][0], visited[k + 1][1]));
    _progCache = { route: flownRoute, home: flownHome, rtl: flownHasRtl, visited, cum };
    return _progCache;
  }
  function mavProgressData(s) {
    if (!flownRoute || !flownRoute.length || s.wp_current == null || s.lat == null) {
      mavClearTarget();
      mavCountdown = { finishS: null, landS: null, at: 0 };
      return null;
    }
    const n = flownRoute.length;
    const _g = _progGeom();
    const visited = _g.visited, cum = _g.cum;
    const homeOffset = flownHome ? 1 : 0;

    const c = s.wp_current;
    // Leading non-coverage items = home + takeoff (+ optional DO_CHANGE_SPEED) + the
    // safe-transit INGRESS splice (#12). Derive from the vehicle's total, but subtract the
    // EGRESS splice too (flownSplicePost) — those items sit AFTER coverage, so counting them
    // into `lead` made the HUD target/ETA lag by `post` waypoints (audit residual, display-only).
    const total = s.wp_total || (n + 2 + (flownHasRtl ? 1 : 0));
    const lead = Math.max(2, total - n - (flownHasRtl ? 1 : 0) - (flownSplicePost || 0));
    let phase = "", targetIdx;
    if (c < lead) {                              // pre-AUTO / takeoff
      targetIdx = homeOffset; phase = "зліт";
    } else if (flownHasRtl && flownHome && c >= lead + n) {
      targetIdx = visited.length - 1; phase = "повертається додому";
    } else {
      targetIdx = homeOffset + (c - lead);       // coverage waypoint
    }
    targetIdx = Math.max(homeOffset, Math.min(targetIdx, visited.length - 1));

    const totalLen = cum[cum.length - 1];
    const target = visited[targetIdx];
    const dNext = haversineM(s.lat, s.lon, target[0], target[1]);
    const remLegs = cum[cum.length - 1] - cum[targetIdx];
    const rem = dNext + remLegs;
    const pct = totalLen > 0
      ? Math.max(0, Math.min(100, Math.round((totalLen - rem) / totalLen * 100))) : 0;

    mavUpdateTarget([s.lat, s.lon], target);
    // Below a speed gate show "—" rather than dropping the row (stable HUD).
    const spd = (s.groundspeed && s.groundspeed > 0.5) ? s.groundspeed : null;
    // "До завершення" = distance to the last COVERAGE waypoint (exclude the RTL
    // leg). "До посадки" = remaining-to-end (incl. RTL) + the landing descent.
    const lastCovIdx = visited.length - 1 - ((flownHasRtl && flownHome) ? 1 : 0);
    let finishDist = 0;
    if (targetIdx < lastCovIdx) {
      finishDist = haversineM(s.lat, s.lon, visited[targetIdx][0], visited[targetIdx][1])
        + (cum[lastCovIdx] - cum[targetIdx]);
    }
    const descentS = (s.alt_rel != null ? s.alt_rel : 0) / DESCENT_RATE;
    const finishS = spd ? finishDist / spd : null;
    const landS = spd ? (rem / spd + descentS) : null;
    mavCountdown = { finishS, landS, at: Date.now() };
    const eta = spd ? fmtDuration(rem / spd) : "—";
    return { pct, phase, dNext, rem, eta, finishS, landS };
  }

  function mavUpdateTarget(from, to) {
    if (!targetMarker) {
      targetMarker = L.circleMarker(to, {
        radius: 9, color: "#ffd24a", weight: 3, fill: false, opacity: 0.95,
      }).addTo(map).bindTooltip("Наступна точка");
      targetLine = L.polyline([from, to], {
        color: "#ffd24a", weight: 1.5, dashArray: "5 6", opacity: 0.7,
      }).addTo(map);
    } else {
      targetMarker.setLatLng(to);
      targetLine.setLatLngs([from, to]);
    }
  }
  function mavClearTarget() {
    if (targetMarker) { map.removeLayer(targetMarker); targetMarker = null; }
    if (targetLine) { map.removeLayer(targetLine); targetLine = null; }
  }

  // Show ArduPilot's actual HOME (where the drone armed) on the map.
  function mavUpdateHome(s) {
    if (s.home_lat == null || s.home_lon == null) return;
    const pos = [s.home_lat, s.home_lon];
    if (!liveHomeMarker) {
      const icon = L.divIcon({ className: "home-marker",
        html: '<div class="home-marker"><svg class="ic" viewBox="0 0 24 24"><path d="M4 12l8-7 8 7"/><path d="M6 10.5V20h12v-9.5"/></svg></div>',
        iconSize: [20, 20], iconAnchor: [10, 18] });
      liveHomeMarker = L.marker(pos, { icon }).addTo(map).bindTooltip("HOME дрона (точка arm)");
    } else {
      liveHomeMarker.setLatLng(pos);
    }
  }

  let _lastDroneHdg = null;
  function mavUpdateMarker(s) {
    if (s.lat == null || s.lon == null) return;
    const pos = [s.lat, s.lon];
    const rh = Math.round(s.heading || 0);           // ▲ CW from north
    const makeIcon = () => L.divIcon({ className: "drone-marker",
      html: `<div style="transform:rotate(${rh}deg);font-size:20px;line-height:20px;color:#ff3b30">▲</div>`,
      iconSize: [22, 22], iconAnchor: [11, 11] });
    if (!droneMarker) {
      droneMarker = L.marker(pos, { icon: makeIcon(), zIndexOffset: 1000 }).addTo(map).bindTooltip("Дрон");
      droneTrack = L.polyline([pos], { color: "#ffd24a", weight: 2, opacity: 0.8 }).addTo(map);
      _lastDroneHdg = rh;
      // Center on the drone the first time we see it, so it's never lost.
      map.setView(pos, Math.max(map.getZoom(), 16));
    } else {
      droneMarker.setLatLng(pos);
      // Rebuild the rotating icon only when heading changed (whole degrees) —
      // setIcon tears down/rebuilds the marker DOM, so skipping it when flying
      // straight removes steady 2 Hz DOM churn (marker micro-stutter on phones).
      if (rh !== _lastDroneHdg) { droneMarker.setIcon(makeIcon()); _lastDroneHdg = rh; }
      // Grow the flown track only when the drone moved (>~2 m); trim in batches so
      // the cap doesn't force an O(n) copy + full re-stroke on every packet.
      const pts = droneTrack.getLatLngs();
      const last = pts.length ? pts[pts.length - 1] : null;
      if (!last || haversineM(last.lat, last.lng, pos[0], pos[1]) > 2) {
        if (pts.length > 5200) droneTrack.setLatLngs(pts.slice(-5000));
        droneTrack.addLatLng(pos);
      }
      // Follow: camera FLOWS with the drone — center on it every packet with a
      // smooth animated pan, so the world glides around the (centered) drone.
      if (mavFollow) {
        map.panTo(pos, { animate: true, duration: 0.7, easeLinearity: 0.25 });
      }
    }
  }

  async function mavUpload() {
    const a = mavApi();
    if (!a || !a.mav_upload_mission) { setMsg("API недоступний.", "error"); return; }
    // Fixed-wing: the arc geometry is baked at BUILD time, but we only know for sure this
    // is a plane once connected (here). Rebuild now — with the vehicle known — so the
    // uploaded route carries the arcs even if the plan was made before connecting.
    if (isPlaneVehicle() && $("round-turn") && $("round-turn").checked && lastRoute && lastRoute.length) {
      appLog("plane-turn: перебудовую маршрут із дугами перед заливкою");
      await buildRoute();
    }
    setMsg("Заливаю місію в дрон…", null);
    appLog("upload start: " + (lastRoute ? lastRoute.length : 0) + " route pts");
    $("mav-upload").disabled = true;
    let _prevFlownRaw = null;                 // restore the previous flown snapshot if the upload fails
    try {
      // Live progress so a slow link (ELRS/RF) doesn't look frozen — the user sees
      // points climbing instead of guessing whether it timed out. Only the in-browser
      // jsMav link reports progress; the desktop /api path ignores the callback.
      // Round-turn: diameter = pass spacing, so radius = spacing/2 (clamped to the
      // autopilot's WP_RADIUS_M range). 0 = off → don't touch the drone's radius param.
      const _rt = $("round-turn") && $("round-turn").checked;
      const _sp = parseFloat($("spacing").value) || 20;
      // Fixed-wing: the mission already carries the arcs; push the autopilot params
      // that make the plane FLY them (analog of the copter's WP_RADIUS_M). Copter
      // path unchanged. INAV planes get the arc geometry but no MAVLink param push.
      const _plane = isPlaneVehicle();
      const planeParams = (_rt && _plane) ? planeTurnParams(_sp, parseFloat($("speed").value) || 12) : null;
      // planeTurnParams returns null when the spacing-derived turn radius is too tight to
      // fly at ANY airspeed the airframe can sustain (below PLANE_MIN_AIRSPEED) — round-turn
      // params are then simply not pushed (see mav_upload_mission's `pp &&` guard); log why,
      // since the toggle being ON with nothing sent otherwise looks like a silent no-op.
      if (_rt && _plane && !planeParams) {
        appLog("plane-turn: вимкнено — при кроці " + _sp + " м потрібна крейсерська швидкість нижча за безпечний мінімум (" +
          PLANE_MIN_AIRSPEED + " м/с); дуги НЕ тюняться (параметри не залито).");
      }
      const turnRadiusM = (_rt && !_plane) ? Math.max(1, Math.min(10, _sp / 2)) : 0;
      // Intent-marker for the ACK→flownSave window: if the app is killed after the FC stored the
      // mission but before we snapshot it, boot still sees "probably uploaded — verify" (§4.2). Keep
      // the previous snapshot so a KNOWN failure below undoes the marker (never lose last-good state).
      try { _prevFlownRaw = localStorage.getItem(FLOWN_KEY); } catch (e) {}
      try { localStorage.setItem(FLOWN_KEY, JSON.stringify({ route: lastRoute, status: "uploading", ts: Date.now() })); } catch (e) {}
      const r = await a.mav_upload_mission({
        onProgress: (s, tot) => setMsg(tf("Заливаю місію в дрон… {0}/{1} точок", s, tot), null),
        turn_radius_m: turnRadiusM,
        plane_params: planeParams,
        // Default FULL geometry read-back; the opt-out checkbox falls back to count-only for
        // a knowingly-marginal ELRS link.
        verify: ($("mav-verify-fast") && $("mav-verify-fast").checked) ? "count" : "full",
      });
      // Log the FULL verify verdict — a red "не збігається" without the actual
      // mismatch list in the log is undebuggable from the field.
      appLog("upload result: " + JSON.stringify(r && { ok: r.ok, count: r.count, error: r.error, warning: r.warning,
        verify_threw: r.verify_incomplete,   // verify raised (vs a clean ok:false return) — field-diagnostic
        verify: r.verify && { ok: r.verify.ok, verified: r.verify.verified, err: r.verify.error,
                              n_exp: r.verify.count_expected, n_act: r.verify.count_actual,
                              diff: r.verify.mismatches },
        // #12p3: opt-in geofence outcome (undefined when the checkbox was off/not applicable)
        fence: r.fence && { ok: r.fence.ok, count: r.fence.count, exclusions: r.fence.exclusions,
                            error: r.fence.error, homeOutside: r.fence.homeOutside, warning: r.fence.warning } }));
      if (r && r.ok) {
        scheduleSaveField();    // uploading a mission → make sure the contour is saved
        promoteFieldOnUpload(); // + промоут контуру в постійний named-record (UPSERT)
        // Snapshot exactly what we uploaded — progress is computed off this, so
        // editing/rebuilding the route afterwards can't corrupt the live HUD.
        flownRoute = lastRoute ? lastRoute.slice() : null;
        // HOME = the drone's actual home (arm point), matching ArduPilot — so the
        // RTL leg in progress/ETA returns to where the drone really is. Set BEFORE flownSave.
        if (lastStatus && lastStatus.home_lat != null) {
          flownHome = { lat: lastStatus.home_lat, lng: lastStatus.home_lon };
        } else if (lastStatus && lastStatus.lat != null) {
          flownHome = { lat: lastStatus.lat, lng: lastStatus.lon };
        } else {
          flownHome = lastHome;
        }
        flownHasRtl = lastRtl;
        flownWpTotal = r.count || 0;
        // #3: keep the notification's "WP x/y" denominator in sync with the real upload
        try { if (window.AndroidNotify && window.AndroidNotify.setMission) window.AndroidNotify.setMission(flownWpTotal); } catch (e) {}
        flownRestored = false;                   // fresh read-back-verified upload → trusted
        flownSplicePost = r.splice_post || 0;
        if (flownRoute) flownSave(flownRoute, flownHome, flownHasRtl, "confirmed", r.splice_pre || 0, flownSplicePost);
        resumeClear();          // AFTER flownSave: FLOWN_KEY must describe the new mission before RESUME is cleared
        updateMissionStatus();        // now "uploaded, matches plan"
        let m = tf("Місію залито в дрон ({0} пунктів).", r.count);
        let kind = "ok";
        const v = r.verify;
        if (v && v.ok && v.verified) {
          m += " " + t("Перевірено зчитуванням — збігається.");
        } else if (v && v.ok && !v.verified) {
          m += " " + tf("Зчитана місія НЕ збігається ({0}).", (v.mismatches || []).join("; ") || t("розбіжності"));
          kind = "error";
        } else if (v && !v.ok) {
          // AMBER: mission stored (ACK'd) but read-back could not complete on this link.
          m += " " + tf("Місію залито, але ПЕРЕВІРКА ЧИТАННЯМ НЕ ВДАЛАСЯ ({0}) — link заслабкий. Підійди ближче / під'єднай USB.",
            (v.error || t("таймаут")));
          kind = "warn";
        } else {
          if (r.warning) m += " " + r.warning;
        }
        // #12p3: fold the OPT-IN geofence outcome into THIS SAME painted message — a
        // setMsg called from inside mav_upload_mission would be overwritten by this one
        // with zero paint frames in between, silently hiding a fence failure from the
        // pilot (review finding). Never downgrade an already-worse verdict (error > warn > ok).
        if (r.fence) {
          if (r.fence.ok && r.fence.warning) {
            // Lost-ACK "ok" (link.js:610): every fence item was SENT but the final ACK never
            // arrived. On the vehicle this can time out and discard the incomplete transfer,
            // silently keeping whatever fence (possibly a stale one from an earlier field) was
            // stored before — must NOT read as "stored", even though res.fence.ok is true
            // (verified finding).
            m += " " + t("Геозона: підтвердження не прийшло — перевір перед увімкненням FENCE_ENABLE.");
            if (kind === "ok") kind = "warn";
          } else if (r.fence.ok) {
            const nExcl = r.fence.exclusions || 0;
            m += " " + (nExcl
              ? tf("Геозона залита: межа поля + {0} вирізів. Увімкни FENCE_ENABLE=1, коли будеш готовий.", nExcl)
              : t("Геозона залита: межа поля. Увімкни FENCE_ENABLE=1, коли будеш готовий."));
            if (r.fence.homeOutside) m += " " + t("Дім поза межею поля — з увімкненим fence дрон не озброїться на цьому місці.");
          } else {
            m += " " + tf("Геозону НЕ залито: {0}. Місія залита нормально.", r.fence.error || t("невідома помилка"));
            if (kind === "ok") kind = "warn";   // fence failure alone must not read as a clean success
          }
        }
        setMsg(m, kind);
      } else {
        setMsg((r && r.error) || t("Не вдалося залити місію."), "error");
        // upload rejected → drone still holds its previous mission; undo the intent-marker
        try { _prevFlownRaw != null ? localStorage.setItem(FLOWN_KEY, _prevFlownRaw) : localStorage.removeItem(FLOWN_KEY); } catch (e) {}
      }
    } catch (e) {
      setMsg("Помилка заливки: " + e, "error");
      try { _prevFlownRaw != null ? localStorage.setItem(FLOWN_KEY, _prevFlownRaw) : localStorage.removeItem(FLOWN_KEY); } catch (e2) {}
    } finally {
      $("mav-upload").disabled = !mavConnected;
    }
  }

  // Заливка ЗАЛИШКУ місії (продовження після заміни батареї). Це звичайна
  // заливка — з вертикальним зльотом на задану висоту на початку; далі оператор
  // стартує як завжди (мотори → «Старт місії»).
  async function resumeUploadRemainder(rem) {
    const a = mavApi();
    if (!a || !a.mav_upload_mission) { setMsg("Немає звʼязку з дроном.", "error"); return; }
    appLog("[resume] заливаю залишок: " + rem.rest.length + " точок (пройдено " + rem.idx + "/" + rem.total + ")");
    setMsg("Заливаю залишок місії…", null);
    $("mav-start").disabled = true;
    try {
      const _rt = $("round-turn") && $("round-turn").checked;
      const _sp = parseFloat($("spacing").value) || 20;
      const r = await a.mav_upload_mission({
        route: rem.rest,
        onProgress: (s, tot) => setMsg(tf("Заливаю місію в дрон… {0}/{1} точок", s, tot), null),
        turn_radius_m: _rt ? Math.max(1, Math.min(10, _sp / 2)) : 0,
        verify: ($("mav-verify-fast") && $("mav-verify-fast").checked) ? "count" : "full",
      });
      appLog("[resume] результат заливки: " + JSON.stringify(r && { ok: r.ok, count: r.count, error: r.error }));
      if (!r || !r.ok) { setMsg((r && r.error) || "Не вдалося залити залишок.", "error"); return; }
      // Тепер у дроні саме залишок: план на карті і «залито» — це він.
      lastRoute = rem.rest.slice();
      flownRoute = rem.rest.slice();
      // Derive home from the drone's live position — resume can be the first upload after a reopen,
      // where without this flownHome=null and _progGeom builds no RTL-leg/countdown (§4.2).
      if (lastStatus && lastStatus.home_lat != null) flownHome = { lat: lastStatus.home_lat, lng: lastStatus.home_lon };
      else if (lastStatus && lastStatus.lat != null) flownHome = { lat: lastStatus.lat, lng: lastStatus.lon };
      flownHasRtl = $("rtl").checked;
      flownWpTotal = r.count || 0;
      flownRestored = false;
      // Resume uploads never splice (mav_upload_mission gates the splice off when p.route is
      // set — see its comment), so r.splice_pre is always 0 here; pass it through anyway for
      // consistency with the full-upload call site above.
      flownSplicePost = r.splice_post || 0;      // always 0 (no splice on resume) — reset a stale value
      flownSave(rem.rest, flownHome, flownHasRtl, "confirmed", r.splice_pre || 0, flownSplicePost);
      promoteFieldOnUpload();        // + промоут контуру (UPSERT) і для залишку
      resumeClear();                 // прогрес нової (коротшої) місії почнеться з нуля
      redrawRouteLayer(rem.rest);
      updateMissionStatus();
      const air = lastStatus && lastStatus.alt_rel != null && lastStatus.alt_rel > 1.5;
      const tail = air
        ? "Натисни «Старт місії» — дрон підніметься вертикально на задану висоту і продовжить."
        : "Увімкни мотори і натисни «Старт місії» — дрон злетить на задану висоту і продовжить.";
      const rv = r.verify;
      // tf()'s {0}/{1} template pattern (matching the full-upload verdicts above) instead of
      // building the string by concatenation — setMsg's whole-string t() lookup can never
      // match a concatenated string, so these mismatch/unverified warnings could never be
      // translated even with i18n.js keys added (verified finding).
      if (rv && rv.ok && !rv.verified) {
        setMsg(tf("Залишок залито ({0} пунктів), але ЗЧИТАНА НЕ ЗБІГАЄТЬСЯ ({1}) — перевір перед стартом.",
          r.count, (rv.mismatches || []).join("; ") || t("розбіжності")), "error");
      } else if (rv && !rv.ok) {
        setMsg(tf("Залишок залито ({0} пунктів), але ПЕРЕВІРКА ЧИТАННЯМ НЕ ВДАЛАСЯ ({1}) — link заслабкий.",
          r.count, rv.error || t("таймаут")) + " " + tail, "warn");
      } else {
        setMsg("Залишок залито (" + r.count + " пунктів). " + tail, "ok");
      }
    } finally {
      $("mav-start").disabled = !mavConnected;
    }
  }
  // Перемалювати лінію маршруту (після заливки залишку показуємо саме те, що полетить).
  function redrawRouteLayer(pts) {
    try {
      if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
      if (routeMarkers) { map.removeLayer(routeMarkers); routeMarkers = null; }
      // #12: the drawn safe-path legs referred to the PREVIOUS full mission's start/end —
      // after a resume-from-battery swap the flown remainder starts elsewhere, so the old
      // detour lines would be misleading. Drop them; they are not recomputed here.
      if (transitLayer) { map.removeLayer(transitLayer); transitLayer = null; }
      routeLayer = L.polyline(pts, { color: "#ff8c2d", weight: 2.5, opacity: 0.95 }).addTo(map);
      routeMarkers = L.featureGroup([
        L.circleMarker(pts[0], { radius: 5, color: "#5fd3a3", fillOpacity: 1 }).bindTooltip("Старт"),
        L.circleMarker(pts[pts.length - 1], { radius: 5, color: "#ff7b72", fillOpacity: 1 }).bindTooltip("Фініш"),
      ]).addTo(map);
    } catch (e) {}
  }


  // ---- Пауза місії (без виходу з AUTO) --------------------------------------
  // MAV_CMD_DO_PAUSE_CONTINUE: дрон зупиняється НА ТРЕКУ, тримає висоту місії й
  // швидкість; «Продовжити» веде його далі рівно з того місця. Це безпечний
  // спосіб перервати обробіток — на відміну від виходу в LOITER/RTL і повернення
  // в AUTO, після якого ArduPilot летить до точки навскіс з поточної висоти.
  let missionPaused = false;
  function syncPauseBtn() {
    const b = $("mav-pause");
    if (!b) return;
    b.textContent = missionPaused ? t("Продовжити місію") : t("Пауза місії");
  }
  const _pauseBtn = $("mav-pause");
  if (_pauseBtn) _pauseBtn.addEventListener("click", async () => {
    const want = !missionPaused;
    const r = await mavCommand({ action: want ? "pause" : "continue" },
                               want ? "Пауза місії" : "Продовження місії");
    if (r && r.ok) { missionPaused = want; syncPauseBtn(); }
  });

  $("mav-upload").addEventListener("click", mavUpload);

  // ---- flight control (arm / mode / start / RTL) --------------------------
  const MAV_CTRL_IDS = ["mav-arm", "mav-disarm", "mav-mode", "mav-set-mode",
                        "mav-start", "mav-rtl", "mav-check", "mav-pause"];
  function mavSetControls(on) {
    MAV_CTRL_IDS.forEach((id) => { if ($(id)) $(id).disabled = !on; });
  }

  async function mavCommand(payload, label) {
    const a = mavApi();
    if (!a || !a.mav_command) { setMsg("API недоступний.", "error"); return null; }
    setMsg(`${label}…`, null);
    appLog("command " + JSON.stringify(payload));
    try {
      const r = await a.mav_command(payload);
      appLog("command result: " + JSON.stringify(r && { ok: r.ok, error: r.error }));
      if (r && r.ok) { setMsg(`${label}: виконано.`, "ok"); return r; }
      // The backend already returns a plain-language reason (incl. ArduPilot's
      // STATUSTEXT), so just show it.
      setMsg(`${label}: ${(r && r.error) || "не вдалося"}`, "error");
      return r;
    } catch (e) {
      setMsg(`${label}: помилка ${e}`, "error");
      return null;
    }
  }

  // Modes that don't allow arming on ArduCopter — switch to GUIDED first.
  const NON_ARMABLE = ["AUTO", "RTL", "LAND", "SMART_RTL", "AUTO_RTL", "BRAKE", "CIRCLE"];
  $("mav-arm").addEventListener("click", async () => {
    if (!confirm("Увімкнути мотори (ARM)? Тримай апарат під контролем.")) return;
    const m = (lastStatus && lastStatus.mode) || "";
    if (NON_ARMABLE.includes(m)) {
      setMsg(tf("Режим {0} не дозволяє ARM — перемикаю на GUIDED…", m), null);
      await mavCommand({ action: "mode", mode: "GUIDED" }, "Режим GUIDED");
    }
    mavCommand({ action: "arm" }, "ARM");
  });
  $("mav-disarm").addEventListener("click", () => mavCommand({ action: "disarm" }, "DISARM"));
  $("mav-set-mode").addEventListener("click", () =>
    mavCommand({ action: "mode", mode: $("mav-mode").value }, `Режим ${$("mav-mode").value}`));
  $("mav-rtl").addEventListener("click", () => mavCommand({ action: "mode", mode: "RTL" }, "RTL"));

  // ---- export the diagnostic log -------------------------------------------
  function buildLogReport() {
    const out = ["=== Field Mission Planner — діагностичний лог ==="];
    out.push("версія: " + APP_VERSION + (IS_ANDROID ? " APK" : IS_QT ? " Qt-ПК" : IS_IOS ? " iOS" : " web"));
    try { out.push("час: " + new Date().toString()); } catch (e) {}
    out.push("UA: " + (navigator.userAgent || ""));
    try {
      out.push("середовище: екран " + window.innerWidth + "×" + window.innerHeight
        + " dpr=" + (window.devicePixelRatio || 1)
        + " | мережа=" + (navigator.onLine ? "online" : "OFFLINE")
        + " | мова=" + (navigator.language || "?"));
    } catch (e) {}
    try {
      const eng = window.FMP_ENGINE;
      out.push("рушій планування: " + (eng ? ("є, готовий=" + (eng.isReady ? eng.isReady() : "?")
        + " доступний=" + (eng.available ? eng.available() : "?")) : "НЕМА (не завантажився)"));
    } catch (e) {}
    try {
      out.push("стан плану: поле=" + (fieldPolygon ? "так" : "ні")
        + " | маршрут=" + (lastRoute ? "так" : "ні")
        + " | вирізи=" + (typeof collectExclusions === "function" ? collectExclusions().length : "?"));
    } catch (e) {}
    try { out.push("зʼєднання: " + mavConnString() + " | підключено=" + mavConnected); } catch (e) {}
    try {
      if (typeof gpsGuard !== "undefined" && gpsGuard)
        out.push("GPS-захист: увімк=" + gpsGuard.enabled + " рівень=" + gpsGuard.level
          + " причина=" + (gpsGuard.reason || "—") + " тривога=" + gpsGuard.alarmOn);
    } catch (e) {}
    if (lastStatus) {
      // OPSEC: whitelist a COORDINATE-FREE telemetry summary — never lat/lon/home_lat/
      // home_lon/vx/vy/vz. Operator launch site + drone track must not leave the device
      // in an uploaded log (Ukraine field use). (security audit S3)
      const s = lastStatus;
      out.push("остання телеметрія: " + JSON.stringify({
        connected: s.connected, mode: s.mode, armed: s.armed,
        fix_type: s.fix_type, sats: s.sats, hdop: s.hdop, has_pos: s.lat != null,
        has_home: s.home_lat != null, alt_rel: s.alt_rel, groundspeed: s.groundspeed,
        battery_v: s.battery_v, battery_pct: s.battery_pct,
        wp_current: s.wp_current, wp_total: s.wp_total, heartbeat_age: s.heartbeat_age,
      }));
    }
    try { if (_mavLink && _mavLink.getStats) out.push("MAVLink: " + JSON.stringify(_mavLink.getStats())); } catch (e) {}
    // Count what kinds of problems the log already holds — a quick triage line.
    try {
      const errN = LOG.filter((l) => /JS ERROR|PROMISE REJECT|CONSOLE\.ERROR/.test(l)).length;
      const warnN = LOG.filter((l) => /CONSOLE\.WARN/.test(l)).length;
      out.push("зведення: помилок=" + errN + " попереджень=" + warnN + " рядків=" + LOG.length);
    } catch (e) {}
    out.push("", "--- події (" + LOG.length + ") ---");
    return out.concat(LOG).join("\n");
  }
  // A stable-ish per-device id so server-side logs from the same phone group.
  let _sessionDeviceId = null;   // memoized fallback for this page load only (see catch below)
  function deviceId() {
    try {
      let d = localStorage.getItem("fmp_device");
      if (!d) { d = "d" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4); localStorage.setItem("fmp_device", d); }
      return d;
    } catch (e) {
      // localStorage unavailable (private browsing): the fixed literal "anon" would
      // collide across EVERY such device on the server (log files overwrite each
      // other; sync snapshots would too). Mint one random id per page load instead —
      // still collision-free, just not persisted across reloads (review M1).
      if (!_sessionDeviceId) _sessionDeviceId = "s" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
      return _sessionDeviceId;
    }
  }
  // Upload the log to the VPS so it can be read+analysed remotely. The PWA/desktop
  // POST same-origin (/api/log, the browser carries the basic-auth). The APK has no
  // local server and is a different origin, so it uses a NATIVE upload bridge
  // (window.AndroidLog) — that avoids the WebView CORS preflight that basic-auth
  // would 401. Returns true on success.
  async function uploadLogToServer(text) {
    const payload = { device: deviceId(), version: APP_VERSION,
      platform: IS_ANDROID ? "apk" : IS_IOS ? "ios" : IS_QT ? "qt" : "web",
      ua: (navigator.userAgent || "").slice(0, 140), log: text };
    if (IS_ANDROID && window.AndroidLog && window.AndroidLog.upload) {
      // Native upload runs on a background thread and reports back via a callback.
      return await new Promise((resolve) => {
        let done = false;
        const to = setTimeout(() => { if (!done) { done = true; resolve(false); } }, 13000);
        window.__logUploadResult = (ok) => { if (!done) { done = true; clearTimeout(to); resolve(!!ok); } };
        try { window.AndroidLog.upload(JSON.stringify(payload)); }
        catch (e) { if (!done) { done = true; clearTimeout(to); resolve(false); } }
      });
    }
    if (IS_IOS && window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.fmpLog) {
      // Same pattern as Android: the native shell (ViewController fmpLog) POSTs the
      // log to the VPS and reports back via window.__logUploadResult. The iOS local
      // server is loopback-only and has no /api/log, so a same-origin fetch can't work.
      return await new Promise((resolve) => {
        let done = false;
        const to = setTimeout(() => { if (!done) { done = true; resolve(false); } }, 13000);
        window.__logUploadResult = (ok) => { if (!done) { done = true; clearTimeout(to); resolve(!!ok); } };
        try { window.webkit.messageHandlers.fmpLog.postMessage(JSON.stringify(payload)); }
        catch (e) { if (!done) { done = true; clearTimeout(to); resolve(false); } }
      });
    }
    try {
      const r = await fetch(API_BASE + "/api/log", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload), credentials: "include",
      });
      return r.ok;
    } catch (e) { return false; }
  }
  async function exportLog() {
    appLog("export log requested");
    const text = buildLogReport();
    const sent = await uploadLogToServer(text);     // primary: land it on the server for analysis
    try { await navigator.clipboard.writeText(text); } catch (e) {}
    // Also offer share/download so the operator keeps a copy.
    if (navigator.share) {
      try { await navigator.share({ title: "FMP лог", text }); } catch (e) {}
    } else {
      try {
        const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        let stamp = ""; try { stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-"); } catch (e) {}
        link.href = url; link.download = "fmp-log-" + stamp + ".txt";
        document.body.appendChild(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      } catch (e) {}
    }
    const _aq = IS_ANDROID && !sent;   // Android queues offline logs and auto-resends
    setMsg("Лог (" + LOG.length + " рядків) " + (sent ? "надіслано на сервер для аналізу" : _aq ? "збережено — надішлеться автоматично, коли зʼявиться інтернет (скопійовано в буфер)" : "на сервер не пішло — скопійовано в буфер") + ".", sent ? "ok" : _aq ? "ok" : "error");
  }
  $("mav-log").addEventListener("click", exportLog);

  // ---- automatic remote log upload (native shells) --------------------------
  // On the native apps (iOS/Android), when a real problem happens during a field
  // session AND there's internet, push the log to the VPS on its own — the operator
  // shouldn't have to remember the «Лог» button after something breaks. Gated to
  // native only (the PWA/desktop keep the manual button, so we don't spam the VPS
  // from every browser tab). Throttled, and flushed when the app goes to background.
  const AUTO_LOG_NATIVE = IS_IOS || IS_ANDROID;
  let _lastAutoUpload = 0, _autoUploading = false;
  async function maybeAutoUploadLog(force) {
    if (!AUTO_LOG_NATIVE) return;
    if (!(navigator.onLine !== false)) return;         // skip when known-offline
    if (_autoUploading) return;
    let now = 0; try { now = Date.now(); } catch (e) {}
    if (!force && (_errSinceUpload === 0 || now - _lastAutoUpload < 60000)) return;
    if (force && _errSinceUpload === 0 && _lastAutoUpload !== 0) return;  // nothing new to flush
    _autoUploading = true;
    const hadErrors = _errSinceUpload;
    try {
      const ok = await uploadLogToServer(buildLogReport());
      if (ok) { _lastAutoUpload = now; _errSinceUpload = Math.max(0, _errSinceUpload - hadErrors); appLog("auto-log uploaded (" + hadErrors + " new problems)"); }
    } catch (e) {} finally { _autoUploading = false; }
  }
  if (AUTO_LOG_NATIVE) {
    setInterval(() => { maybeAutoUploadLog(false); }, 20000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") maybeAutoUploadLog(true);
    });
    window.addEventListener("pagehide", () => { maybeAutoUploadLog(true); });
  }

  // ---- in-app update --------------------------------------------------------
  // The app already talks to the server (logs), so it can check the server's
  // `version.json` and update itself: the PWA force-refreshes its service worker;
  // the APK downloads + installs the new APK natively; the desktop points at the
  // download. Saves the "did I reinstall the latest?" guesswork (esp. the APK,
  // which doesn't auto-update).
  function _verNums(v) { return String(v || "0").split(".").map((n) => parseInt(n, 10) || 0); }
  function _isNewer(a, b) {              // is version a strictly newer than b?
    const x = _verNums(a), y = _verNums(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0; }
    return false;
  }
  async function checkUpdate() {
    setMsg("Перевіряю оновлення на сервері…", null);
    // 1) Get the server's latest version.
    let latest = "";
    if (IS_ANDROID && window.AndroidUpdate && window.AndroidUpdate.check) {
      latest = await new Promise((resolve) => {
        let done = false;
        const to = setTimeout(() => { if (!done) { done = true; resolve(""); } }, 11000);
        window.__updateCheckResult = (v) => { if (!done) { done = true; clearTimeout(to); resolve(v || ""); } };
        try { window.AndroidUpdate.check(); } catch (e) { if (!done) { done = true; clearTimeout(to); resolve(""); } }
      });
    } else {
      try {
        const r = await fetch(API_BASE + "/version.json?t=" + Date.now(), { cache: "no-store", credentials: "include" });
        latest = (await r.json()).version || "";
      } catch (e) { latest = ""; }
    }
    if (!latest) { setMsg("Не вдалося перевірити оновлення (немає інтернету / сервер недоступний).", "error"); return; }
    appLog("update check: server=" + latest + " app=" + APP_VERSION);
    // 2) Up to date?
    if (!_isNewer(latest, APP_VERSION)) { setMsg(tf("У вас остання версія (v{0}).", APP_VERSION), "ok"); return; }
    // 3) Update, per platform.
    if (IS_ANDROID && window.AndroidUpdate && window.AndroidUpdate.download) {
      setMsg(`Доступна v${latest}. Завантажую APK — встановлення почнеться автоматично, лише підтверди.`, "ok");
      try { window.AndroidUpdate.download(); }   // native builds the official URL itself
      catch (e) { setMsg("Не вдалося завантажити APK. Скачай вручну з вкладки «Додаток».", "error"); }
      return;
    }
    if (IS_QT) { setMsg(`Доступна v${latest}. На ПК відкрий додаток у Chrome/Edge — там завжди свіжа версія (і дрон по кабелю працює).`, "ok"); return; }
    // PWA / browser: refresh the service worker, then reload onto the new shell.
    setMsg(`Доступна v${latest}. Оновлюю…`, "ok");
    try {
      const reg = navigator.serviceWorker && (await navigator.serviceWorker.getRegistration());
      if (reg) {
        await reg.update();
        const w = reg.waiting || reg.installing;
        if (w) {
          navigator.serviceWorker.addEventListener("controllerchange", () => location.reload(), { once: true });
          w.postMessage({ type: "skipWaiting" });
          setTimeout(() => location.reload(), 2500);   // fallback if no controllerchange
        } else { location.reload(); }
      } else { location.reload(); }
    } catch (e) { location.reload(); }
  }
  if ($("check-update")) $("check-update").addEventListener("click", checkUpdate);

  // ---- Backup-sync (opt-in, OFF by default): push/pull key app state to Ivan's own
  // server (#10) — protects fields / flight stats / settings against a lost or
  // replaced phone (everything else lives ONLY in this device's storage). Transport
  // mirrors uploadLogToServer above: a plain same-origin fetch, no native bridge for
  // v1. VPS_BASE (empty in this repo) lets a self-hoster's APK point sync at an
  // absolute server URL when there's no local same-origin server to fetch against.
  const SYNC_BASE = VPS_BASE || API_BASE;
  // Plain localStorage keys synced as-is. Fields (fmp_fields IndexedDB) and the
  // flight log (fmp_flightlog IndexedDB) are dumped separately below — see fldAll/
  // flogAll above — into synthetic keys so the server stays a dumb {key: string} blob.
  // Excluded on purpose: fmp_log (diagnostic, big), fmp_ble_* (device-specific
  // pairing), fmp_device (identifies THIS device, not data to restore).
  const SYNC_KEYS = ["fmp_projects", "fmp_current_field", "fmp_last_field",
    "fmp_last_settings", "fmp_last_route", "fmp_is_plane", "fmp_lang"];
  function syncEnabled() { try { return localStorage.getItem("fmp_sync_on") === "1"; } catch (e) { return false; } }
  // APK/iOS have no same-origin server and a plain cross-origin fetch dies on the basic-auth CORS
  // preflight — so on Android the transport of choice is the NATIVE bridge (window.AndroidSync,
  // LogBridge-style: no CORS, auth baked into the build). Browser/PWA keeps same-origin fetch.
  function syncNative() {
    try { return (window.AndroidSync && window.AndroidSync.available()) ? window.AndroidSync : null; }
    catch (e) { return null; }
  }
  function syncConfigured() { return !!syncNative() || !((IS_ANDROID || IS_IOS) && !VPS_BASE); }
  // One transport for both endpoints: native bridge when available, else same-origin fetch.
  // Returns the parsed response JSON or null (never throws).
  async function syncCall(path, payload) {
    const nb = syncNative();
    if (nb) {
      return await new Promise((resolve) => {
        let done = false;
        const to = setTimeout(() => { if (!done) { done = true; resolve(null); } }, 20000);
        window.__syncResult = (body) => {
          if (done) return; done = true; clearTimeout(to);
          try { resolve(body == null ? null : JSON.parse(body)); } catch (e) { resolve(null); }
        };
        try { nb.call(path, JSON.stringify(payload)); }
        catch (e) { done = true; clearTimeout(to); resolve(null); }
      });
    }
    try {
      const r = await fetch(SYNC_BASE + path, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload), credentials: "include",
      });
      return await r.json().catch(() => null);
    } catch (e) { return null; }
  }
  async function buildSyncPayload() {
    const data = {};
    SYNC_KEYS.forEach((k) => { try { const v = localStorage.getItem(k); if (v != null) data[k] = v; } catch (e) {} });
    try { const f = await fldAll(); if (f) data.fmp_fields_idb = JSON.stringify(f); } catch (e) {}
    // Sync flight SUMMARIES only. Every flogPut() record (app.js ~flightRecFinalize) also
    // carries the full 1 Hz `samples` track — it's only ever read at finalize time to derive
    // `actual` above; nothing re-reads it back from storage afterwards (no replay feature),
    // and renderFlightStats/flogSummary only touch actual/planned/partial/field/date. Shipping
    // the raw track here is pure bloat: FLOG_MAX_FLIGHTS=300 records can reach 20-30 MB,
    // blowing past serve.py's 4 MB /api/sync cap and forcing an expensive main-thread
    // double-stringify (boot/disarm/online — disarm runs while telemetry is still polling)
    // for a payload that then gets rejected anyway (verified finding).
    try {
      const all = await flogAll();                // ascending by started_at (oldest first)
      if (all && all.length) {
        // Strip `samples`, and pre-size each stripped record ONCE (not the whole array
        // repeatedly) so the payload-cap guard below is a cheap subtraction loop, not a
        // repeated multi-MB re-stringify — that would recreate the very main-thread-freeze
        // problem this fix is for.
        let total = 0;
        const sizes = new Array(all.length);
        const stripped = all.map((r, i) => {
          const c = Object.assign({}, r); delete c.samples;
          const s = JSON.stringify(c); sizes[i] = s.length; total += s.length;
          return c;
        });
        // Total-payload guard: even sample-free, a long flight history can still approach
        // the server cap — drop the OLDEST records until it fits, rather than fail the sync
        // outright. Recent flights are what matters most after losing/replacing a phone.
        const MAX_BYTES = 3.5 * 1024 * 1024;
        let start = 0;
        while (start < stripped.length - 1 && total > MAX_BYTES) { total -= sizes[start]; start++; }
        if (start > 0) appLog("sync: dropped " + start + " oldest flight summar" + (start === 1 ? "y" : "ies") +
          " to stay under the " + (MAX_BYTES / 1e6).toFixed(1) + " MB sync payload cap");
        data.fmp_flightlog_idb = JSON.stringify(stripped.slice(start));
      }
    } catch (e) {}
    return { device: deviceId(), ts: Date.now(), app_version: APP_VERSION, data };
  }
  // Applies a server snapshot as an HONEST OVERWRITE (matches the confirm() text the
  // operator just accepted): the fields + flight-log IndexedDB stores are CLEARED
  // before repopulating, so a field/flight deleted on another device before its last
  // push doesn't resurrect here (review I2). Every write is individually accounted
  // for (not swallowed) so the caller can tell a full restore from a partial one.
  async function applySyncSnapshot(snapshot) {
    const data = (snapshot && snapshot.data) || {};
    let total = 0, failures = 0;
    const note = (okFlag, what) => { total++; if (!okFlag) { failures++; appLog("sync: restore failed — " + what); } };
    SYNC_KEYS.forEach((k) => {
      if (!Object.prototype.hasOwnProperty.call(data, k)) return;
      try { localStorage.setItem(k, data[k]); note(true, k); }
      catch (e) { note(false, k + ": " + e); }
    });
    note(await fldClearAll(), "clear fields store");
    note(await flogClearAll(), "clear flight log store");
    if (data.fmp_fields_idb) {
      try {
        const recs = JSON.parse(data.fmp_fields_idb);
        for (const r of recs) note(await fldPut(r), "field " + ((r && r.name) || "?"));
      } catch (e) { note(false, "parse fmp_fields_idb: " + e); }
    }
    if (data.fmp_flightlog_idb) {
      try {
        const recs = JSON.parse(data.fmp_flightlog_idb);
        for (const r of recs) note(await flogPut(r), "flight " + ((r && r.started_at) || "?"));
      } catch (e) { note(false, "parse fmp_flightlog_idb: " + e); }
    }
    return { ok: failures === 0, total, failures };
  }
  function syncStatusText() {
    if (!syncEnabled()) return "вимкнено";
    let ts = 0; try { ts = +localStorage.getItem("fmp_sync_last") || 0; } catch (e) {}
    return ts ? tf("остання синхронізація: {0}", new Date(ts).toLocaleString()) : "синхронізацій ще не було";
  }
  function renderSyncStatus() { const el = $("sync-status"); if (el) el.textContent = t(syncStatusText()); }
  let _syncPushing = false, _syncAutoLastAttempt = 0;
  async function syncPush(manual) {
    if (!syncConfigured()) { if (manual) setMsg("Сервер не налаштовано.", "error"); return false; }
    if (_syncPushing) return false;                 // one push in flight at a time
    _syncPushing = true;
    try {
      const payload = await buildSyncPayload();
      const j = await syncCall("/api/sync", payload);
      if (!j || !j.ok) {
        appLog("sync: push failed " + (j ? JSON.stringify(j).slice(0, 120) : "(no response)"));
        if (manual) setMsg("Не вдалося синхронізувати із сервером.", "error");
        return false;
      }
      try { localStorage.setItem("fmp_sync_last", String(j.ts || Date.now())); } catch (e) {}
      renderSyncStatus();
      if (manual) setMsg("Синхронізовано із сервером.", "ok");
      return true;
    } catch (e) {
      appLog("sync: push error " + e);
      if (manual) setMsg("Не вдалося синхронізувати: " + e, "error");
      return false;
    } finally { _syncPushing = false; }
  }
  // Auto-sync triggers (only when the toggle is ON): boot, back-online, after a flight
  // is saved (see call sites above). Debounced to >=60s between AUTOMATIC attempts;
  // fire-and-forget — failures are silent in the UI (no red banner mid-fieldwork) but
  // land in appLog for later diagnosis.
  function scheduleAutoSync(reason) {
    if (!syncEnabled() || !syncConfigured()) return;
    const now = Date.now();
    if (now - _syncAutoLastAttempt < 60000) return;
    _syncAutoLastAttempt = now;
    appLog("sync: auto trigger (" + reason + ")");
    syncPush(false);
  }
  window.addEventListener("online", () => scheduleAutoSync("online"));
  async function syncRestore() {
    if (!syncConfigured()) { setMsg("Сервер не налаштовано.", "error"); return; }
    setMsg("Отримую копію з сервера…", null);
    try {
      const j = await syncCall("/api/sync_get", { device: deviceId() });
      if (!j || !j.ok) { setMsg((j && j.error) || "Немає копії на сервері.", "error"); return; }
      const snap = j.snapshot || {};
      let localFields = 0;
      try { const recs = await fldAll(); localFields = recs ? recs.length : Object.keys(lpAll()).length; } catch (e) {}
      let serverFields = 0;
      try {
        const sd = snap.data || {};
        if (sd.fmp_fields_idb) serverFields = JSON.parse(sd.fmp_fields_idb).length;
        else if (sd.fmp_projects) serverFields = Object.keys(JSON.parse(sd.fmp_projects)).length;
      } catch (e) {}
      const when = snap.ts ? new Date(snap.ts).toLocaleString() : "?";
      const ok = confirm(
        tf("Копія на сервері від {0}, полів: {1}.", when, serverFields) + "\n" +
        tf("Локально зараз полів: {0}.", localFields) + "\n\n" +
        "Перезаписати локальні дані копією з сервера? Застосунок перезавантажиться."
      );
      if (!ok) return;
      const result = await applySyncSnapshot(snap);
      if (result.ok) {
        setMsg("Відновлено з сервера. Перезавантаження…", "ok");
      } else {
        appLog("sync: restore partial — " + result.failures + " of " + result.total + " writes failed");
        setMsg("Відновлено частково — перевір поля/статистику.", "warn");
      }
      setTimeout(() => location.reload(), 300);
    } catch (e) { setMsg("Помилка відновлення: " + e, "error"); }
  }
  if ($("sync-on")) {
    $("sync-on").checked = syncEnabled();
    $("sync-on").addEventListener("change", (e) => {
      try { localStorage.setItem("fmp_sync_on", e.target.checked ? "1" : "0"); } catch (e2) {}
      renderSyncStatus();
      if (e.target.checked) scheduleAutoSync("toggle-on");
    });
  }
  if ($("sync-now")) $("sync-now").addEventListener("click", () => syncPush(true));
  if ($("sync-restore")) $("sync-restore").addEventListener("click", syncRestore);
  renderSyncStatus();

  // Download the mission ACTUALLY stored on the drone and DRAW it on the map
  // (cyan), so the operator sees exactly what the drone will fly.
  $("mav-check").addEventListener("click", async () => {
    const a = mavApi();
    if (!a || !a.mav_download_mission) { setMsg("API недоступний.", "error"); return; }
    setMsg("Зчитую місію з дрона…", null);
    try {
      const r = await a.mav_download_mission();
      if (!r || !r.ok) { setMsg("Не вдалося зчитати: " + ((r && r.error) || "немає звʼязку"), "error"); return; }
      const items = r.items || [];
      // Flight waypoints = NAV_WAYPOINT(16)/TAKEOFF(22) with real coords (skip
      // home seq0 and RTL which carry 0/0).
      const pts = items
        .filter((it) => (it.command === 16 || it.command === 22) && it.seq !== 0 && (it.x || it.y))
        .map((it) => [it.x / 1e7, it.y / 1e7]);
      if (droneMissionLayer) { map.removeLayer(droneMissionLayer); droneMissionLayer = null; }
      if (pts.length) {
        droneMissionLayer = L.layerGroup([
          L.polyline(pts, { color: "#22d3ee", weight: 2.5, opacity: 0.9, dashArray: "2 6" }),
          L.circleMarker(pts[0], { radius: 5, color: "#22d3ee", fillOpacity: 1 }).bindTooltip("Місія на дроні: старт"),
        ]).addTo(map);
        map.fitBounds(L.polyline(pts).getBounds(), { padding: [40, 40] });
      }
      // Does it match the current plan?
      const flown = routeSig(flownRoute), plan = routeSig(lastRoute);
      let m = `На дроні: ${r.count} пунктів (${pts.length} точок маршруту) — показано блакитним.`;
      if (plan && plan === flown) m = "" + m + " Збігається з планом.";
      setMsg(m, "ok");
    } catch (e) { setMsg("Помилка зчитування: " + e, "error"); }
  });

  $("mav-start").addEventListener("click", () => {
    if (!lastStatus || !lastStatus.armed) {
      setMsg("Спершу увімкни мотори: ARM (за потреби постав режим GUIDED).", "error");
      return;
    }
    // Don't fly a stale mission: warn hard if the plan differs from what we uploaded.
    if (routeSig(lastRoute) !== routeSig(flownRoute)) {
      if (!confirm("У дроні НЕ поточний план (або місію не залито). Спершу натисни " +
                   "«Залити місію». Все одно запустити те, що ЗАРАЗ у дроні?")) return;
    }
    // For a clean "climb straight up, then fly", the drone must start from the
    // ground — otherwise ArduCopter skips the vertical takeoff.
    const airborne = lastStatus && lastStatus.alt_rel != null && lastStatus.alt_rel > 1.5;
    // Продовження після заміни батареї: заливаємо ЗАЛИШОК як нову місію — вона
    // почнеться зі зльоту на задану висоту, і лише тоді дрон піде по точках.
    const rem = resumeRemaining();
    if (rem) {
      // Працює і НА ЗЕМЛІ, і В ПОВІТРІ: залишок заливається як повноцінна місія,
      // а її NAV_TAKEOFF (пункт місії, не команда!) у повітрі піднімає дрон
      // ВЕРТИКАЛЬНО на задану висоту над поточною точкою — і лише тоді він іде
      // горизонтально. Саме цього бракувало, коли AUTO вмикали з пульта: тоді
      // ArduCopter летить прямою 3D-лінією до точки з тієї висоти, де він є.
      const where = airborne
        ? "Дрон у повітрі: він підніметься ВЕРТИКАЛЬНО на задану висоту, а тоді полетить далі."
        : "Дрон злетить на задану висоту і продовжить обробіток.";
      if (confirm("Продовжити з місця зупинки?\n\nПройдено " + rem.idx + " з " + rem.total +
                  " точок. Заллю залишок (" + rem.rest.length + " точок).\n" + where +
                  "\n\n«Скасувати» = почати поле спочатку.")) {
        resumeUploadRemainder(rem);
        return;
      }
      resumeClear();   // оператор обрав почати спочатку
    }
    let warn = "Запустити місію в AUTO? Апарат полетить за маршрутом.";
    if (airborne) {
      warn = "Дрон уже в повітрі. Місія почнеться з вертикального набору на задану " +
             "висоту над поточною точкою, і лише тоді він піде по маршруту. Запустити?";
    }
    if (confirm(warn)) {
      // Switch to AUTO, then start (the backend resets to the takeoff first).
      mavCommand({ action: "mode", mode: "AUTO" }, "Режим AUTO").then(() =>
        mavCommand({ action: "start" }, "Старт місії"));
    }
  });
})();
