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
  const APP_VERSION = "2.5.36";
  // The deployed app on the VPS — used by the APK (different origin, native fetch)
  // to check for / download updates. The PWA/desktop use same-origin paths.
  const VPS_BASE = "https://178.105.166.29.sslip.io/ai";

  // ---- diagnostic log -------------------------------------------------------
  // A rolling in-memory log of connection / telemetry / mission / error events,
  // persisted to localStorage so a crash or a bad field session can still be
  // exported and analysed afterwards. The «Лог для аналізу» button packages it.
  const LOG = [];
  let _logDirty = false;
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
  setInterval(() => { if (_logDirty) { try { localStorage.setItem("fmp_log", LOG.slice(-1000).join("\n")); } catch (e) {} _logDirty = false; } }, 4000);
  if (typeof window !== "undefined") {
    // Full stack traces (not just message@file:line) so an uploaded log pinpoints
    // the exact failing call — the single most useful thing for remote diagnosis.
    const _stackOf = (o) => (o && o.stack) ? " | " + String(o.stack).replace(/\s+/g, " ").slice(0, 500) : "";
    window.addEventListener("error", (e) => {
      appLog("JS ERROR: " + ((e && e.message) || e) + " @ " + ((e && e.filename) || "")
        + ":" + ((e && e.lineno) || "") + ":" + ((e && e.colno) || "") + _stackOf(e && e.error));
    });
    window.addEventListener("unhandledrejection", (e) => {
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
  appLog("start " + APP_VERSION + (IS_ANDROID ? " APK" : IS_QT ? " Qt" : " web") + " ua=" + (navigator.userAgent || "").slice(0, 70));

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
      _av.textContent = "v" + APP_VERSION + (IS_ANDROID ? " APK" : IS_QT ? " ПК" : " web");
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
    setMsg("Контур поля задано.", "ok");
  });
  // Reset the "next polygon is an exclusion" flag whenever a draw ends (finish or
  // cancel), so a cancelled "Додати виріз" can't turn the next field into a cutout.
  map.on(L.Draw.Event.DRAWSTOP, () => { drawingExclusion = false; });

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
      btn.textContent = on ? "ГОТОВО — зберегти вузли" : "Редагувати вирізи";
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
      const exclusions = exclusionItems.getLayers().map(ringOf).filter((r) => r.length >= 3);
      localStorage.setItem("fmp_last_field", JSON.stringify({ contour, exclusions }));
    } catch (e) { /* quota / private mode — ignore */ }
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
      (s.exclusions || []).forEach((r) => {
        if (r && r.length >= 3)
          addExclusionLayer(L.polygon(r.map((p) => [p.lat, p.lng]), { color: "#ff4d4d", weight: 2 }));
      });
      setMsg("Відновлено останнє поле.", null);
    } catch (e) { /* malformed save — ignore */ }
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

  function setMsg(text, kind) {
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
    if (!/…\s*$/.test(text)) _toastTimer = setTimeout(hideToast, kind === "error" ? 8000 : 4000);
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
      angle: parseFloat($("angle").value),
      auto_angle: $("auto_angle").checked,
      // Auto-angle = FULL COVERAGE first, then minimum TIME (passes along the
      // longest edge, fewest turns) — for a continuous takeoff→landing sprayer (Ivan).
      optimize: live ? "length" : "overlap",
      margin: parseFloat($("margin").value) || 0,
      alt: parseFloat($("alt").value),
      speed: parseFloat($("speed").value),
      rtl: $("rtl").checked,
      exclusions: collectExclusions(),
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
      sprayed_ha: res.sprayed_ha || 0, liquid_l: res.liquid_l || 0, sections: res.flights || 1 };
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

    const pts = res.waypoints.map((p) => [p.lat, p.lng]);
    lastRoute = pts;                 // editing buffer; snapshotted on upload
    lastHome = res.home ? { lat: res.home.lat, lng: res.home.lng } : null;
    lastRtl = $("rtl").checked;
    updateMissionStatus();           // plan changed -> "not uploaded / re-upload"
    routeLayer = L.polyline(pts, { color: "#ff8c2d", weight: 2.5, opacity: 0.95 }).addTo(map);

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
  }

  function row(label, value) {
    return `<div class="row"><span>${esc(label)}</span><span>${esc(value)}</span></div>`;
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
  ["rtl", "auto_angle"].forEach((id) => {
    if ($(id)) $(id).addEventListener("change", scheduleSaveSettings);
  });
  window.addEventListener("beforeunload", () => { saveLastSettings(); saveLastField(); });
  restoreLastSettings();          // pre-fill last session's settings before first render
  // Deferred so ALL module-level `let`s (lastRoute, …) are initialized first —
  // adoptField()→clearRoute() touches them, which would hit a TDZ error if run inline.
  setTimeout(restoreLastField, 0);   // auto-restore the last drawn contour (+ exclusions)
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
      angle: parseFloat($("angle").value),
      auto_angle: $("auto_angle").checked,
      margin: parseFloat($("margin").value) || 0,
      alt: parseFloat($("alt").value),
      speed: parseFloat($("speed").value),
      rtl: $("rtl").checked,
    };
  }
  function applyParams(p) {
    if (!p) return;
    const set = (id, v) => { if (v !== undefined && v !== null && $(id)) $(id).value = v; };
    set("spacing", p.spacing); set("angle", p.angle); set("margin", p.margin);
    set("alt", p.alt); set("speed", p.speed);
    if ($("auto_angle")) $("auto_angle").checked = !!p.auto_angle;
    if ($("rtl")) $("rtl").checked = p.rtl !== false;
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
        params: collectParams(), anchor_source: anchorSourceVal(),
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
      L.marker(poly.getBounds().getCenter(), { interactive: false, keyboard: false, zIndexOffset: 500,
        icon: L.divIcon({ className: "area-label field",
          html: "<span><b>" + esc(r.name || "Поле") + "</b><br>" + ha.toFixed(2) + " га</span>",
          iconSize: [140, 38], iconAnchor: [70, 19] }) }).addTo(overviewLayer);
      poly.bindTooltip("Натисни, щоб працювати з «" + esc(r.name || "Поле") + "»");
      poly.on("click", (e) => {
        L.DomEvent.stop(e); clearSavedOverview();
        applyProject(r); currentFieldName = r.name || "";
        setMsg("Поле «" + (r.name || "Поле") + "» обрано для роботи. Натисни «Побудувати маршрут».", "ok");
      });
    });
    if (bounds) map.fitBounds(bounds, { padding: [50, 50] });
    setMsg(recs.length + " збережених полів на карті — натисни на поле, щоб обрати для роботи.", "ok");
  }
  if ($("show-saved")) $("show-saved").addEventListener("click", showSavedFields);

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
    const rec = { name, field, params: collectParams(), exclusions: collectExclusions(),
      created: now, updated: now, area_ha: lastFieldAreaHa || 0 };
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
      return `${i + 1}. ${r.name}${ha}${d}`;
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
  function parseKmlCoords(text) {       // "lon,lat[,alt] ..." -> [{lat,lng}]
    return (text || "").trim().split(/\s+/).map((tok) => {
      const a = tok.split(",");
      return { lng: parseFloat(a[0]), lat: parseFloat(a[1]) };
    }).filter((p) => isFinite(p.lat) && isFinite(p.lng));
  }
  function importKml(text) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    const polys = doc.getElementsByTagName("Polygon");
    if (!polys.length) { setMsg("У KML немає полігонів (Polygon).", "error"); return; }
    const outer = polys[0].getElementsByTagName("outerBoundaryIs")[0];
    const oc = outer && outer.getElementsByTagName("coordinates")[0];
    const fieldPts = oc ? parseKmlCoords(oc.textContent) : [];
    if (fieldPts.length < 3) { setMsg("KML без коректного контуру поля.", "error"); return; }
    exclusionItems.clearLayers();
    removeByKind("split");          // drop the previous field's split lines (bug-hunt #1)
    if (sectorsLayer) { map.removeLayer(sectorsLayer); sectorsLayer = null; }
    adoptField(L.polygon(fieldPts.map((p) => [p.lat, p.lng]), { color: "#2d7ff9", weight: 2 }));
    let holes = 0;
    const addRingsFrom = (el) => {
      const cs = el.getElementsByTagName("coordinates");
      for (let i = 0; i < cs.length; i++) {
        const pts = parseKmlCoords(cs[i].textContent);
        if (pts.length >= 3) { addExclusionLayer(L.polygon(pts.map((p) => [p.lat, p.lng]))); holes++; }
      }
    };
    // inner rings of the field polygon = holes; any further <Polygon> = exclusions.
    const inners = polys[0].getElementsByTagName("innerBoundaryIs");
    for (let i = 0; i < inners.length; i++) addRingsFrom(inners[i]);
    for (let k = 1; k < polys.length; k++) addRingsFrom(polys[k]);
    clearRoute();
    setMsg(`Імпортовано контур із .kml${holes ? ` (+${holes} вирізів)` : ""}.`, "ok");
  }
  $("exp-kml").addEventListener("click", exportKml);
  $("import-kml").addEventListener("click", () => $("kml-file").click());
  $("kml-file").addEventListener("change", (ev) => {
    const f = ev.target.files && ev.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => { try { importKml(String(r.result)); } catch (e) { setMsg("Помилка читання KML: " + e, "error"); } };
    r.readAsText(f);
    ev.target.value = "";
  });

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
  let targetMarker = null;        // ring on the active (next) waypoint
  let targetLine = null;          // dashed line drone -> next waypoint
  let liveHomeMarker = null;      // ArduPilot's actual HOME (arm point)
  let droneMissionLayer = null;   // mission downloaded FROM the drone (visual)
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
      el.textContent = "Маршрут не побудовано."; el.className = "mission-status";
    } else if (!flown) {
      el.textContent = "Маршрут НЕ залито в дрон. Натисни «Залити місію».";
      el.className = "mission-status warn";
    } else if (plan === flown) {
      el.textContent = `У дроні поточна місія: ${lastRoute.length} точок.`;
      el.className = "mission-status ok";
    } else {
      el.textContent = "План ЗМІНЕНО після заливки — у дроні СТАРА місія. Залий заново!";
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
        if (conn.startsWith("udp:") && IS_ANDROID && window.AndroidUdp) {
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
      if (!lastRoute || !lastRoute.length) return { ok: false, error: "Спочатку побудуй маршрут." };
      const alt = parseFloat($("alt").value);
      const speed = Math.max(parseFloat($("speed").value) || 0, 0);
      const rtl = $("rtl").checked;
      const st = _mavLink.status();
      let home;
      if (st.home_lat != null) home = [st.home_lat, st.home_lon, 0];
      else if (st.lat != null && (st.fix_type || 0) >= 3) home = [st.lat, st.lon, 0];
      else if (lastHome) home = [lastHome.lat, lastHome.lng, 0];
      else home = [lastRoute[0][0], lastRoute[0][1], 0];
      const items = MAV_LINK.buildMissionItems(home, Math.max(alt, 2),
        lastRoute.map((pt) => [pt[0], pt[1]]), alt, rtl, speed);
      const res = await _mavLink.uploadMission(items, undefined, p && p.onProgress);
      if (!res.ok) return res;
      if (speed > 0) {
        let ps = await _mavLink.setParam("WP_SPD", speed);
        if (!ps.ok) ps = await _mavLink.setParam("WPNAV_SPEED", speed * 100);
        res.cruise_speed_set = ps.ok;
      }
      if (!p || p.verify !== false) {
        const v = await _mavLink.verifyMission(items);
        res.verify = v;
        if (v.ok && !v.verified) res.verify_warning = "Зчитана місія не збігається — перевір.";
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
      return { ok: false, error: "Невідома дія: " + action };
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
    $("mav-cable-row").style.display = t === "cable" ? "" : "none";
    $("mav-net-row").style.display = t === "cable" ? "none" : "";
    // Seed the default address only if the field is empty or still holds the
    // OTHER type's default — never clobber an address the user typed.
    if (t !== "cable") {
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

  // Follow-drone toggle (centers the map on the drone in flight).
  const _ff = $("mav-follow");
  if (_ff) { mavFollow = _ff.checked; _ff.addEventListener("change", () => { mavFollow = _ff.checked; }); }
  updateMissionStatus();   // show initial mission status

  function mavConnString() {
    const t = $("mav-conn-type").value;
    if (t === "cable") return $("mav-port").value;
    const addr = ($("mav-address").value || "").trim();
    // Empty address → sensible auto-default (UDP listens on all interfaces).
    if (t === "tcp") return "tcp:" + (addr || MAV_DEFAULT_ADDR.tcp);
    return "udp:" + (addr || MAV_DEFAULT_ADDR.udp);
  }

  async function mavConnect() {
    const a = mavApi();
    if (!a || !a.mav_connect) { setMsg("API недоступний.", "error"); return; }
    const conn = mavConnString();
    if (!conn) { setMsg("Обери COM-порт або введи адресу.", "error"); return; }
    setMsg("Підключаюсь до дрона…", null);
    appLog("connect → " + conn + " baud=" + $("mav-baud").value);
    $("mav-connect").disabled = true;
    try {
      const bv = $("mav-baud").value;
      const r = await a.mav_connect({ conn, baud: bv === "auto" ? "auto" : parseInt(bv, 10) });
      appLog("connect result: " + JSON.stringify(r));
      if (r && r.ok) {
        mavConnected = true;
        $("mav-connect").disabled = true;
        $("mav-disconnect").disabled = false;
        $("mav-upload").disabled = false;
        mavSetControls(true);
        $("mav-hud").classList.remove("hidden");
        const bnote = r.baud ? ` (baud ${r.baud})` : "";
        setMsg((r.warning || "Підключено до дрона.") + bnote, r.warning ? null : "ok");
        mavStartPolling();
      } else {
        $("mav-connect").disabled = false;
        setMsg((r && r.error) || "Не вдалося підключитись.", "error");
      }
    } catch (e) {
      $("mav-connect").disabled = false;
      setMsg("Помилка підключення: " + e, "error");
    }
  }

  async function mavDisconnect() {
    const a = mavApi();
    mavStopPolling();
    try { if (a && a.mav_disconnect) await a.mav_disconnect(); } catch (e) { /* ignore */ }
    mavConnected = false;
    $("mav-connect").disabled = false;
    $("mav-disconnect").disabled = true;
    $("mav-upload").disabled = true;
    mavSetControls(false);
    $("mav-hud").classList.add("hidden");
    if (droneMarker) { map.removeLayer(droneMarker); droneMarker = null; }
    if (droneTrack) { map.removeLayer(droneTrack); droneTrack = null; }
    mavClearTarget();
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
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) mavStopPolling();
    else if (mavConnected) mavStartPolling();
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
      appLog(`tlm mode=${s.mode} armed=${s.armed} fix=${s.fix_type} sats=${s.sats} `
        + `hasfix=${s.lat != null} batt=${s.battery_v} gs=${s.groundspeed} wp=${s.wp_current}/${s.wp_total}`);
    }
    mavRenderHud(s);
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

  function gpsGuardRender() {
    const dot = $("gps-guard-dot"), txt = $("gps-guard-text"), det = $("gps-guard-detail");
    const banner = $("gps-alarm"), breason = $("gps-alarm-reason"), btitle = $("gps-alarm-title");
    const lvl = !gpsGuard.enabled ? "off" : (!mavConnected ? "nolink" : gpsGuard.level);
    const M = {
      off:    ["#6b7280", "Захист вимкнено", ""],
      nolink: ["#6b7280", "Немає звʼязку з дроном", ""],
      init:   ["#6b7280", "Очікую фікс GPS…", ""],
      ok:     ["#3fb27f", "GPS у нормі", ""],
      warn:   ["#ffd166", "Слабкий сигнал GPS", gpsGuard.reason],
      jam:    ["#ff3b30", "ГЛУШІННЯ GPS", gpsGuard.reason],
      spoof:  ["#ff3b30", "СПУФІНГ GPS", gpsGuard.reason],
    };
    const [color, label, detail] = M[lvl] || M.init;
    if (dot) dot.style.background = color;
    if (txt) { txt.textContent = label; txt.style.color = color; }
    if (det) det.textContent = (lvl === "ok" && mavConnected)
      ? ("фікс " + (gpsGuard.level === "ok" ? "3D" : "?") + ", супутників " + (lastStatus && lastStatus.sats != null ? lastStatus.sats : "?")
         + (lastStatus && lastStatus.hdop != null ? ", HDOP " + lastStatus.hdop : ""))
      : detail;
    const showBanner = gpsGuard.enabled && (lvl === "jam" || lvl === "spoof") && !gpsGuard.acked;
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
    } catch (e) { /* private mode / no IndexedDB — keep the in-memory summary only */ }
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
  const flogSummary = (r) => ({ started_at: r.started_at, planned: r.planned || null,
    actual: r.actual || null, partial: !!r.partial });
  async function loadFlightSummaries() {
    const all = await flogAll();
    flightSummaries = all.map(flogSummary);
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
          samples: [], sawComplete: false, wp_total: s.wp_total || 0, _last: 0 };
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
    if (s.wp_total && s.wp_current != null && s.wp_current >= s.wp_total - 1) flightRec.sawComplete = true;
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
    if (!fr || !fr.samples.length) return;
    const last = fr.samples[fr.samples.length - 1];
    const actual_duration = (last.t - fr.started_at) / 1000;
    if (actual_duration < 5) return;                   // too short to be a real flight
    const bp_end = (s && s.battery_pct != null) ? s.battery_pct : last.bp;
    const battery_used = (fr.bp_start != null && bp_end != null) ? (fr.bp_start - bp_end) : null;
    const rec = {
      started_at: fr.started_at, ended_at: last.t, planned: fr.planned,
      actual: { duration_s: Math.round(actual_duration),
        battery_used_pct: (battery_used != null ? Math.round(battery_used) : null),
        distance_m: Math.round(_sampleDist(fr.samples)) },
      partial: !!partial || !fr.sawComplete,
      field: (fr.work && fr.work.field) || "поле",
      date: new Date(fr.started_at).toISOString().slice(0, 10),
      work: fr.work || null,
      params: { wp_total: fr.wp_total }, samples: fr.samples,
    };
    await flogPut(rec);
    flightSummaries.push(flogSummary(rec));
    const mins = Math.round(actual_duration / 60);
    setMsg(`Політ записано (${mins} хв${rec.partial ? ", частковий" : ""}). Оцінки часу відкалібруються.`, "ok");
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
    r.el.style.display = show ? "" : "none";
    if (!show) return;
    if (r.val.textContent !== value) r.val.textContent = value;   // textContent = intrinsic escaping
    r.val.style.color = color || "";
  }
  function mavRenderHud(s) {
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
    const p = mavProgressData(s);
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
  function mavDetectPhase(s) {
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
  function mavProgressData(s) {
    if (!flownRoute || !flownRoute.length || s.wp_current == null || s.lat == null) {
      mavClearTarget();
      mavCountdown = { finishS: null, landS: null, at: 0 };
      return null;
    }
    const n = flownRoute.length;
    // Ground points actually traversed, with home leading and (if RTL) trailing.
    const visited = [];
    if (flownHome) visited.push([flownHome.lat, flownHome.lng]);
    for (const p of flownRoute) visited.push(p);
    if (flownHasRtl && flownHome) visited.push([flownHome.lat, flownHome.lng]);
    const homeOffset = flownHome ? 1 : 0;

    const c = s.wp_current;
    // Leading non-coverage items = home + takeoff (+ optional DO_CHANGE_SPEED).
    // Derive from the vehicle's total so the map stays correct whatever we added.
    const total = s.wp_total || (n + 2 + (flownHasRtl ? 1 : 0));
    const lead = Math.max(2, total - n - (flownHasRtl ? 1 : 0));
    let phase = "", targetIdx;
    if (c < lead) {                              // pre-AUTO / takeoff
      targetIdx = homeOffset; phase = "зліт";
    } else if (flownHasRtl && flownHome && c >= lead + n) {
      targetIdx = visited.length - 1; phase = "повертається додому";
    } else {
      targetIdx = homeOffset + (c - lead);       // coverage waypoint
    }
    targetIdx = Math.max(homeOffset, Math.min(targetIdx, visited.length - 1));

    let totalLen = 0;
    for (let k = 0; k < visited.length - 1; k++) {
      totalLen += haversineM(visited[k][0], visited[k][1], visited[k + 1][0], visited[k + 1][1]);
    }
    const target = visited[targetIdx];
    const dNext = haversineM(s.lat, s.lon, target[0], target[1]);
    let remLegs = 0;
    for (let k = targetIdx; k < visited.length - 1; k++) {
      remLegs += haversineM(visited[k][0], visited[k][1], visited[k + 1][0], visited[k + 1][1]);
    }
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
      finishDist = haversineM(s.lat, s.lon, visited[targetIdx][0], visited[targetIdx][1]);
      for (let k = targetIdx; k < lastCovIdx; k++)
        finishDist += haversineM(visited[k][0], visited[k][1], visited[k + 1][0], visited[k + 1][1]);
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
    const icon = L.divIcon({ className: "home-marker",
      html: '<div class="home-marker"><svg class="ic" viewBox="0 0 24 24"><path d="M4 12l8-7 8 7"/><path d="M6 10.5V20h12v-9.5"/></svg></div>',
      iconSize: [20, 20], iconAnchor: [10, 18] });
    if (!liveHomeMarker) {
      liveHomeMarker = L.marker(pos, { icon }).addTo(map).bindTooltip("HOME дрона (точка arm)");
    } else {
      liveHomeMarker.setLatLng(pos);
    }
  }

  function mavUpdateMarker(s) {
    if (s.lat == null || s.lon == null) return;
    const pos = [s.lat, s.lon];
    const hdg = s.heading || 0;
    // ▲ points north (up) at rotate(0); MAVLink heading is CW from north, so a
    // straight rotate(hdg) aligns it correctly.
    const html = `<div style="transform:rotate(${hdg}deg);font-size:20px;line-height:20px;color:#ff3b30">▲</div>`;
    const icon = L.divIcon({ className: "drone-marker", html, iconSize: [22, 22], iconAnchor: [11, 11] });
    if (!droneMarker) {
      droneMarker = L.marker(pos, { icon, zIndexOffset: 1000 }).addTo(map).bindTooltip("Дрон");
      droneTrack = L.polyline([pos], { color: "#ffd24a", weight: 2, opacity: 0.8 }).addTo(map);
      // Center on the drone the first time we see it, so it's never lost.
      map.setView(pos, Math.max(map.getZoom(), 16));
    } else {
      droneMarker.setLatLng(pos);
      droneMarker.setIcon(icon);
      // Grow the flown track only when the drone actually moved (>~2 m) and keep
      // it bounded (≤5000 pts) — at 2 Hz an unbounded polyline would balloon
      // memory + per-pan redraw cost over a multi-hour spray session.
      const pts = droneTrack.getLatLngs();
      const last = pts.length ? pts[pts.length - 1] : null;
      if (!last || haversineM(last.lat, last.lng, pos[0], pos[1]) > 2) {
        if (pts.length >= 5000) droneTrack.setLatLngs(pts.slice(-4999));
        droneTrack.addLatLng(pos);
      }
      // Follow: keep the drone on screen (pan only when it nears the edge, so the
      // user can still look around without a fight).
      if (mavFollow && !map.getBounds().pad(-0.2).contains(pos)) {
        map.panTo(pos, { animate: true });
      }
    }
  }

  async function mavUpload() {
    const a = mavApi();
    if (!a || !a.mav_upload_mission) { setMsg("API недоступний.", "error"); return; }
    setMsg("Заливаю місію в дрон…", null);
    appLog("upload start: " + (lastRoute ? lastRoute.length : 0) + " route pts");
    $("mav-upload").disabled = true;
    try {
      // Live progress so a slow link (ELRS/RF) doesn't look frozen — the user sees
      // points climbing instead of guessing whether it timed out. Only the in-browser
      // jsMav link reports progress; the desktop /api path ignores the callback.
      const r = await a.mav_upload_mission({
        onProgress: (s, t) => setMsg(`Заливаю місію в дрон… ${s}/${t} точок`, null),
      });
      appLog("upload result: " + JSON.stringify(r && { ok: r.ok, count: r.count, error: r.error, warning: r.warning, verify: r.verify && r.verify.verified }));
      if (r && r.ok) {
        scheduleSaveField();    // uploading a mission → make sure the contour is saved
        // Snapshot exactly what we uploaded — progress is computed off this, so
        // editing/rebuilding the route afterwards can't corrupt the live HUD.
        flownRoute = lastRoute ? lastRoute.slice() : null;
        // HOME = the drone's actual home (arm point), matching ArduPilot — so the
        // RTL leg in progress/ETA returns to where the drone really is.
        if (lastStatus && lastStatus.home_lat != null) {
          flownHome = { lat: lastStatus.home_lat, lng: lastStatus.home_lon };
        } else if (lastStatus && lastStatus.lat != null) {
          flownHome = { lat: lastStatus.lat, lng: lastStatus.lon };
        } else {
          flownHome = lastHome;
        }
        flownHasRtl = lastRtl;
        updateMissionStatus();        // now "uploaded, matches plan"
        let m = `Місію залито в дрон (${r.count} пунктів).`;
        const v = r.verify;
        if (v && v.ok && v.verified) {
          m += " Перевірено зчитуванням — збігається.";
          setMsg(m, "ok");
        } else if (v && v.ok && !v.verified) {
          m += ` Зчитана місія НЕ збігається (${(v.mismatches || []).join("; ") || "розбіжності"}).`;
          setMsg(m, "error");
        } else {
          if (r.warning) m += " " + r.warning;
          setMsg(m, "ok");
        }
      } else {
        setMsg((r && r.error) || "Не вдалося залити місію.", "error");
      }
    } catch (e) {
      setMsg("Помилка заливки: " + e, "error");
    } finally {
      $("mav-upload").disabled = !mavConnected;
    }
  }
  $("mav-upload").addEventListener("click", mavUpload);

  // ---- flight control (arm / mode / start / RTL) --------------------------
  const MAV_CTRL_IDS = ["mav-arm", "mav-disarm", "mav-mode", "mav-set-mode",
                        "mav-start", "mav-rtl", "mav-check"];
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
      setMsg(`Режим ${m} не дозволяє ARM — перемикаю на GUIDED…`, null);
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
  function deviceId() {
    try {
      let d = localStorage.getItem("fmp_device");
      if (!d) { d = "d" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4); localStorage.setItem("fmp_device", d); }
      return d;
    } catch (e) { return "anon"; }
  }
  // Upload the log to the VPS so it can be read+analysed remotely. The PWA/desktop
  // POST same-origin (/api/log, the browser carries the basic-auth). The APK has no
  // local server and is a different origin, so it uses a NATIVE upload bridge
  // (window.AndroidLog) — that avoids the WebView CORS preflight that basic-auth
  // would 401. Returns true on success.
  async function uploadLogToServer(text) {
    const payload = { device: deviceId(), version: APP_VERSION,
      platform: IS_ANDROID ? "apk" : IS_QT ? "qt" : "web",
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
    setMsg("Лог (" + LOG.length + " рядків) " + (sent ? "надіслано на сервер для аналізу" : "на сервер не пішло — скопійовано в буфер") + ".", sent ? "ok" : "error");
  }
  $("mav-log").addEventListener("click", exportLog);

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
    if (!_isNewer(latest, APP_VERSION)) { setMsg(`У вас остання версія (v${APP_VERSION}).`, "ok"); return; }
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
    let warn = "Запустити місію в AUTO? Апарат полетить за маршрутом.";
    if (airborne) {
      warn = "Дрон уже в повітрі — вертикальний зліт буде пропущено, він піде " +
             "одразу до точки. Для чистого зльоту спершу посади (RTL/LAND) і роззброй. " +
             "Все одно запустити?";
    }
    if (confirm(warn)) {
      // Switch to AUTO, then start (the backend resets to the takeoff first).
      mavCommand({ action: "mode", mode: "AUTO" }, "Режим AUTO").then(() =>
        mavCommand({ action: "start" }, "Старт місії"));
    }
  });
})();
