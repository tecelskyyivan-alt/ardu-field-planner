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
  // Visible build tag so you can confirm an update actually landed (the APK does
  // NOT auto-update — you must reinstall it; the PWA updates on reopen).
  const APP_VERSION = "2.6.6-beta";
  // The deployed app on the VPS — used by the APK (different origin, native fetch)
  // to check for / download updates. The PWA/desktop use same-origin paths.
  const VPS_BASE = "";  // self-host: optional external server for logs/updates; empty = same-origin only

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
    window.addEventListener("error", (e) => appLog("JS ERROR: " + ((e && e.message) || e) + " @ " + ((e && e.filename) || "") + ":" + ((e && e.lineno) || "")));
    window.addEventListener("unhandledrejection", (e) => appLog("PROMISE REJECT: " + ((e && e.reason && e.reason.message) || (e && e.reason) || "")));
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
    // fadeAnimation off: the per-tile fade-in (×2 stacked layers: satellite + the
    // labels overlay) reads as "map blinking" on weak/hybrid-GPU compositing (the
    // Optimus laptop). Tiles just appear — snappier and no flicker.
    fadeAnimation: false,
    // Soft bounds (viscosity 0) instead of hard (1.0): the hard bounds fought the
    // user on zoom-out and felt like stutter.
    maxBounds: [[-85, -180], [85, 180]], maxBoundsViscosity: 0.0,
  }).setView([48.4, 31.2], 6);
  // Open on the WHOLE of Ukraine (fitBounds adapts the zoom to any screen size);
  // loading/drawing a field zooms in to it afterwards.
  map.fitBounds([[44.2, 22.0], [52.5, 40.3]]);
  { const _av = document.getElementById("app-ver");
    if (_av) {
      _av.textContent = "v" + APP_VERSION + (IS_ANDROID ? " APK" : IS_QT ? " ПК" : " web");
      // Tap the version (visible on every platform, incl. the APK where the «Додаток»
      // tab is hidden) to check the server for an update.
      _av.title = "Перевірити оновлення";
      _av.style.cursor = "pointer";
      _av.addEventListener("click", () => checkUpdate());
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
  } : {
    esri: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    esrilabels: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
    google: "https://{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}",
    carto: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
  };
  const esriSat = L.tileLayer(TILE_URLS.esri,
    { maxZoom: 21, maxNativeZoom: 19, noWrap: true, attribution: "Esri World Imagery" }
  );
  // Transparent reference overlay: city/country names, admin borders, roads.
  const esriLabels = L.tileLayer(TILE_URLS.esrilabels,
    { maxZoom: 21, maxNativeZoom: 19, noWrap: true }
  );
  // Google satellite — a different capture; helps where Esri is cloudy.
  const googleSat = L.tileLayer(TILE_URLS.google,
    { subdomains: ["mt0", "mt1", "mt2", "mt3"], maxZoom: 21, maxNativeZoom: 20, noWrap: true, attribution: "© Google" }
  );
  // Google-like labelled street map.
  const streets = L.tileLayer(TILE_URLS.carto,
    { maxZoom: 21, maxNativeZoom: 19, noWrap: true, attribution: "© OpenStreetMap, © CARTO" }
  );
  // Default = Google satellite + names: deeper high-zoom coverage of Ukraine
  // (Esri shows "Map data not yet available" past z17-18 in rural areas).
  const hybrid = L.layerGroup([googleSat, esriLabels]).addTo(map);
  const esriHybrid = L.layerGroup([esriSat, esriLabels]);

  L.control.layers(
    {
      "Супутник + назви (Google)": hybrid,
      "Esri супутник + назви": esriHybrid,
      "Схема (назви)": streets,
    },
    {},
    // Collapsed (a small icon) on phones so it doesn't cover half the map;
    // expanded on desktop where there's room.
    { position: "topright", collapsed: window.innerWidth <= 760 }
  ).addTo(map);

  // Drawn field polygon lives here; route preview separately.
  const drawnItems = new L.FeatureGroup().addTo(map);
  // Exclusion (obstacle) polygons live in their own group, cut out of coverage.
  const exclusionItems = new L.FeatureGroup().addTo(map);
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
  let splitLine = null;           // [{lat,lng}] manual sector-split line, or null
  let splitLineLayer = null;
  let sectorsLayer = null;        // rendered sector sub-polygons

  const drawControl = new L.Control.Draw({
    draw: {
      polygon: { allowIntersection: false, showArea: true,
                 shapeOptions: { color: "#2d7ff9", weight: 2 } },
      polyline: { shapeOptions: { color: "#ffd166", weight: 3, dashArray: "6 6" } },
      rectangle: false, circle: false,
      marker: false, circlemarker: false,
    },
    edit: { featureGroup: drawnItems, remove: true },
  });
  map.addControl(drawControl);

  // ON-MAP drawing toolbar — replaces the old Leaflet.draw buttons (now hidden via
  // CSS, but the Control stays for the split-line polyline handler). Lets you start
  // or edit the contour, add an exclusion, or split — all WITHOUT opening the side
  // panel, so on the PHONE you build a field straight on the map.
  const MapDrawTools = L.Control.extend({
    options: { position: "topleft" },
    onAdd() {
      const d = L.DomUtil.create("div", "leaflet-bar map-draw-tools");
      d.innerHTML =
        '<a href="#" data-a="field" title="Намалювати контур (ще раз — завершити)">✏️</a>'
        + '<a href="#" data-a="excl" title="Додати виріз (ще раз — завершити)">⛔</a>'
        + '<a href="#" data-a="save" title="Зберегти поле локально">💾</a>'
        + '<a href="#" data-a="saved" title="Показати збережені поля">📁</a>'
        + '<a href="#" data-a="split" title="Поділити поле лінією на сектори">✂️</a>'
        + '<a href="#" data-a="erase" title="Стерти намальоване (контур + вирізи)">🗑️</a>'
        + '<a href="#" data-a="me" class="gps" title="Показати мою GPS (старт/фініш звідси)">📍</a>'
        + '<a href="#" data-a="drone" class="gps" title="Показати GPS дрона (старт/фініш звідси)">🛩️</a>';
      L.DomEvent.disableClickPropagation(d);
      L.DomEvent.on(d, "click", (e) => {
        const a = e.target.closest("[data-a]"); if (!a) return;
        L.DomEvent.preventDefault(e); L.DomEvent.stopPropagation(e);
        const act = a.dataset.a;
        if (act === "field") startFieldDraw();
        else if (act === "excl") startExclusionDraw();
        else if (act === "save") { if (builder.isActive()) builder.finish(); $("save-project").click(); }
        else if (act === "saved") showSavedFields();
        else if (act === "split") startSplitDraw();
        else if (act === "erase") eraseDrawn();
        else if (act === "me") showMyGps();
        else if (act === "drone") showDroneGps();
      });
      return d;
    },
  });
  map.addControl(new MapDrawTools());

  // All drawing goes through the SAME Leaflet.draw toolbar handlers as the field
  // contour (proven reliable), disambiguated by shape: a POLYLINE is always a
  // sector-split line; a POLYGON is an exclusion when in that mode, else the field.
  map.on(L.Draw.Event.CREATED, (e) => {
    if (e.layerType === "polyline") { handleSplitLine(e.layer); return; }
    if (drawingExclusion) {
      drawingExclusion = false;
      addExclusionLayer(e.layer);
      clearRoute();
      setMsg("Виріз додано. Додай ще або «Побудувати маршрут».", "ok");
      return;
    }
    adoptField(e.layer);
    setMsg("Поле задано. Натисни «Побудувати маршрут».", "ok");
  });
  // Reset the "next polygon is an exclusion" flag whenever a draw ends (finish or
  // cancel), so a cancelled "Додати виріз" can't turn the next field into a cutout.
  map.on(L.Draw.Event.DRAWSTOP, () => { drawingExclusion = false; });

  // Add a polygon as an obstacle exclusion (red, click-to-delete).
  function addExclusionLayer(layer) {
    if (layer.setStyle) {
      layer.setStyle({ color: "#ff4d4d", weight: 2, fillOpacity: 0.2, dashArray: "4 4" });
    }
    layer.bindTooltip("Виріз — клік видаляє (а в режимі «Редагувати вирізи» клік відкриває вершини)");
    layer.on("click", () => {
      if (exclusionEditMode) { editExclusion(layer); return; }   // edit-mode click → builder
      exclusionItems.removeLayer(layer);
      clearRoute();
      setMsg("Виріз видалено.", null);
    });
    exclusionItems.addLayer(layer);
  }

  // Edit ONE exclusion with the same builder mechanic (drag vertices, +, right-click).
  function editExclusion(layer) {
    if (builder.isActive()) return;
    let ring; try { ring = layer.getLatLngs()[0].map((p) => ({ lat: p.lat, lng: p.lng })); } catch (e) { return; }
    if (ring.length < 3) return;
    exclusionItems.removeLayer(layer); clearRoute();
    builder.start("exclusion", ring, () => addExclusionLayer(
      L.polygon(ring.map((p) => [p.lat, p.lng]), { color: "#ff4d4d", weight: 2 })));
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

  // Draw an obstacle exclusion via the toolbar polygon tool (same as the contour).
  function startExclusionDraw() {
    if (builder.isActive()) { builder.finish(); return; }   // re-tap ⛔ = finish/save
    if (exclusionEditMode) setExclusionEdit(false);
    builder.start("exclusion");
  }

  // Draw a sector-split LINE via the toolbar polyline tool. A drawn polyline always
  // becomes a split line (handleSplitLine); the field must exist first.
  function startSplitDraw() {
    if (!fieldPolygon) { setMsg("Спочатку намалюй контур поля, потім ділити лінією.", "error"); return; }
    enableToolbarDraw("polyline");
    setMsg("Намалюй лінію через поле — вона поділить його на сектори.", null);
  }
  function handleSplitLine(layer) {
    if (!fieldPolygon) { setMsg("Спочатку намалюй контур поля, потім ділити лінією.", "error"); return; }
    let ll = layer.getLatLngs();
    while (Array.isArray(ll) && ll.length && Array.isArray(ll[0])) ll = ll[0];     // flatten
    const line = (ll || []).filter((p) => p && isFinite(p.lat) && isFinite(p.lng))
                           .map((p) => ({ lat: p.lat, lng: p.lng }));
    if (line.length < 2) { setMsg("Лінія поділу замала — проведи її через усе поле.", "error"); return; }
    splitLine = line;
    if (splitLineLayer) map.removeLayer(splitLineLayer);
    splitLineLayer = L.polyline(line.map((p) => [p.lat, p.lng]),
      { color: "#ffd166", weight: 3, dashArray: "6 6" }).addTo(map).bindTooltip("Лінія поділу на сектори");
    clearRoute();
    setMsg("Лінію поділу задано. «Побудувати маршрут» — поле ділиться на сектори.", "ok");
  }
  function clearSplit() {
    cancelToolbarDraw();
    splitLine = null;
    if (splitLineLayer) { map.removeLayer(splitLineLayer); splitLineLayer = null; }
    if (sectorsLayer) { map.removeLayer(sectorsLayer); sectorsLayer = null; }
    clearRoute();
    setMsg("Лінію поділу прибрано.", null);
  }

  // Exclusion edit MODE: while on, clicking a виріз opens it in the builder (drag
  // vertices / + / right-click), instead of deleting it. Same mechanic as the contour.
  function setExclusionEdit(on) {
    exclusionEditMode = on;
    const btn = $("edit-exclusions");
    if (btn) {
      btn.classList.toggle("active", on);
      btn.textContent = on ? "✓ Готово (редагування вирізів)" : "✏️ Редагувати вирізи";
    }
    const n = exclusionItems.getLayers().length;
    if (on) setMsg(n ? "Клікни по вирізу, щоб редагувати його вершини." : "Спершу додай виріз (⛔).", null);
    else setMsg("", null);
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
    drawnItems.clearLayers();
    clearRoute();
    fieldPolygon = layer;
    drawnItems.addLayer(fieldPolygon);
    map.fitBounds(fieldPolygon.getBounds(), { padding: [40, 40] });
    setFieldArea();                                  // always-on area label inside the field
    const _eb = $("edit-contour"); if (_eb) _eb.disabled = false;
    if (typeof uiOnField === "function") uiOnField();   // phase UI: field exists → Маршрут
  }

  // Permanent "X.XX га" label centred INSIDE the field contour — shown always and
  // refreshed whenever the contour changes (the JIYI behaviour Ivan asked for).
  let fieldAreaMarker = null;
  function setFieldArea() {
    if (!fieldPolygon) { if (fieldAreaMarker) { map.removeLayer(fieldAreaMarker); fieldAreaMarker = null; } return; }
    let ring; try { ring = fieldPolygon.getLatLngs()[0]; } catch (e) { return; }
    if (!ring || ring.length < 3) return;
    const ha = (L.GeometryUtil.geodesicArea(ring) / 1e4) || 0;
    const ic = L.divIcon({ className: "area-label field", html: "<span>" + ha.toFixed(2) + " га</span>", iconSize: [110, 24], iconAnchor: [55, 12] });
    const c = fieldPolygon.getBounds().getCenter();
    if (!fieldAreaMarker) fieldAreaMarker = L.marker(c, { interactive: false, keyboard: false, zIndexOffset: 500, icon: ic }).addTo(map);
    else { fieldAreaMarker.setLatLng(c); fieldAreaMarker.setIcon(ic); }
  }

  // Draw OR edit the field contour with the builder — called by BOTH the on-map
  // toolbar and the side-panel button, so on the phone you never need the panel open.
  function startFieldDraw() {
    if (builder.isActive()) { builder.finish(); return; }   // re-tap ✏️ = finish/save
    if (editingContour) setContourEdit(false);
    const orig = fieldPolygon ? fieldPolygon.getLatLngs()[0].map((p) => ({ lat: p.lat, lng: p.lng })) : null;
    if (orig && orig.length >= 3) {                  // a contour exists → EDIT it
      drawnItems.clearLayers(); fieldPolygon = null; setFieldArea();
      builder.start("field", orig, () => {           // cancel → restore the original
        adoptField(L.polygon(orig.map((p) => [p.lat, p.lng]), { color: "#2d7ff9", weight: 2 }));
      });
    } else {
      builder.start("field");                        // none yet → fresh draw
    }
  }

  // Erase what's drawn: a drawing-in-progress is cancelled; otherwise the finished
  // contour + all exclusions are cleared (after a confirm). Used by the 🗑️ map button.
  function eraseDrawn() {
    if (builder.isActive()) { builder.cancel(false); return; }
    clearSavedOverview();
    if (!fieldPolygon && !exclusionItems.getLayers().length) { setMsg("Нічого стирати.", null); return; }
    if (!confirm("Стерти намальований контур і всі вирізи?")) return;
    $("clear").click();
    setMsg("Намальоване стерто.", "ok");
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
      editingContour = true;
      if (btn) { btn.textContent = "✓ Готово (редагування)"; btn.classList.add("active"); }
      setMsg("Тягни вершини контуру — маршрут оновлюється наживо.", null);
    } else {
      if (fieldPolygon) {
        fieldPolygon.off("edit", scheduleLiveBuild);
        try { fieldPolygon.editing.disable(); } catch (e) {}
      }
      editingContour = false;
      if (btn) { btn.textContent = "✏️ Редагувати вершини контуру"; btn.classList.remove("active"); }
    }
  }

  // A vertex edit changes the geometry — the built route is now stale.
  map.on(L.Draw.Event.EDITED, () => {
    clearRoute();
  });
  map.on(L.Draw.Event.DELETED, () => {
    setContourEdit(false);
    const _eb = $("edit-contour"); if (_eb) _eb.disabled = true;
    fieldPolygon = null; clearRoute(); setFieldArea();
  });

  // ---- Agri-style point-by-point polygon builder (contour + exclusions) ----
  // Mirrors the JIYI "Agri Assistant" mechanic: a fixed CENTRE CROSSHAIR + an
  // "add point" button drop vertices precisely (no finger occlusion); you can also
  // TAP the map, or add a vertex at YOUR phone GPS / the DRONE's GPS; vertices are
  // draggable, an edge-midpoint "+" inserts a point, right-click deletes one; live
  // area (ha) + a self-intersection guard; finish / undo / cancel.
  const builder = (() => {
    let active = null, pts = [], ring = null, areaTip = null, onCancel = null;
    const handles = L.layerGroup();    // vertex + midpoint markers
    let cross = null, bar = null, infoEl = null;   // reticle + toolbar DOM

    function _seg(p1, p2, p3, p4) {    // do segments p1p2 and p3p4 properly cross?
      const s = (a, b, c) => (b.lng - a.lng) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lng - a.lng);
      const d1 = s(p3, p4, p1), d2 = s(p3, p4, p2), d3 = s(p1, p2, p3), d4 = s(p1, p2, p4);
      return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
    }
    function selfCross(p) {
      const n = p.length;
      if (n < 4) return false;
      for (let i = 0; i < n; i++)
        for (let j = i + 1; j < n; j++) {
          if (i === j || (i + 1) % n === j || (j + 1) % n === i) continue;  // adjacent/shared
          if (_seg(p[i], p[(i + 1) % n], p[j], p[(j + 1) % n])) return true;
        }
      return false;
    }
    function areaHa(p) {
      try { return L.GeometryUtil.geodesicArea(p.map((q) => L.latLng(q.lat, q.lng))) / 1e4; }
      catch (e) { return 0; }
    }
    function centroid(p) { let x = 0, y = 0; for (const q of p) { x += q.lat; y += q.lng; } return [x / p.length, y / p.length]; }

    function buildDom() {
      if (cross) return;
      const c = map.getContainer();
      cross = L.DomUtil.create("div", "draw-crosshair", c);
      bar = L.DomUtil.create("div", "draw-toolbar", c);
      bar.innerHTML =
        '<button class="draw-btn" data-a="center" title="Додати точку під хрестиком">➕<small>точка</small></button>'
        + '<button class="draw-btn" data-a="me" title="Точка з GPS телефону">📍<small>я</small></button>'
        + '<button class="draw-btn" data-a="drone" title="Точка з GPS дрона">🛩️<small>дрон</small></button>'
        + '<button class="draw-btn" data-a="undo" title="Прибрати останню точку">↶<small>назад</small></button>'
        + '<span class="draw-info">0 точок</span>'
        + '<button class="draw-btn ok" data-a="done" title="Завершити">✓<small>готово</small></button>'
        + '<button class="draw-btn cancel" data-a="cancel" title="Скасувати">✕</button>';
      infoEl = bar.querySelector(".draw-info");
      L.DomEvent.disableClickPropagation(bar);
      L.DomEvent.disableScrollPropagation(bar);
      const acts = { center: addCenter, me: addMe, drone: addDrone, undo: undo, done: finish, cancel: () => cancel(false) };
      L.DomEvent.on(bar, "click", (e) => {
        const b = e.target.closest("[data-a]"); if (!b) return;
        L.DomEvent.stop(e); (acts[b.dataset.a] || (() => {}))();
      });
    }

    function add(ll) { if (ll) { pts.push({ lat: ll.lat, lng: ll.lng }); render(); } }
    function addCenter() { add(map.getCenter()); }
    function addMe() {
      if (!navigator.geolocation) { setMsg("Геолокація недоступна на цьому пристрої.", "error"); return; }
      setMsg("Беру GPS телефону…", null);
      navigator.geolocation.getCurrentPosition(
        (p) => add({ lat: p.coords.latitude, lng: p.coords.longitude }),
        () => setMsg("Не вдалося отримати GPS телефону.", "error"),
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 2000 });
    }
    function addDrone() {
      if (mavConnected && lastStatus && lastStatus.lat != null)
        add({ lat: lastStatus.lat, lng: lastStatus.lon });
      else setMsg("Немає позиції дрона — підключись у вкладці «Політ».", "error");
    }
    function undo() { pts.pop(); render(); }

    function render() {
      const latlngs = pts.map((p) => [p.lat, p.lng]);
      const excl = active === "exclusion";
      const col = excl ? "#ff4d4d" : "#2d7ff9";
      // interactive:false → clicking over the preview still adds a point (the fill
      // would otherwise swallow the map click); vertex/midpoint markers stay live.
      if (!ring) ring = L.polygon(latlngs, { color: col, weight: 2, fillOpacity: 0.12, interactive: false }).addTo(map);
      else ring.setLatLngs(latlngs);
      ring.setStyle({ color: col, dashArray: excl ? "5 4" : null });
      handles.clearLayers();
      pts.forEach((p, i) => {
        const m = L.marker([p.lat, p.lng], {
          draggable: true, keyboard: false, zIndexOffset: 1000,
          icon: L.divIcon({ className: "draw-vertex" + (excl ? " excl" : ""), html: "<b>" + (i + 1) + "</b>", iconSize: [22, 22], iconAnchor: [11, 11] }),
        });
        m.on("drag", (e) => { pts[i] = { lat: e.target.getLatLng().lat, lng: e.target.getLatLng().lng }; ring.setLatLngs(pts.map((q) => [q.lat, q.lng])); });
        m.on("dragend", render);
        m.on("contextmenu", (e) => { L.DomEvent.stop(e); pts.splice(i, 1); render(); });
        handles.addLayer(m);
      });
      if (pts.length >= 3) {                       // midpoint "+" insert handles
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i], b = pts[(i + 1) % pts.length];
          const mid = [(a.lat + b.lat) / 2, (a.lng + b.lng) / 2];
          const mm = L.marker(mid, { keyboard: false, icon: L.divIcon({ className: "draw-mid", html: "+", iconSize: [16, 16], iconAnchor: [8, 8] }) });
          mm.on("click", (e) => { L.DomEvent.stop(e); pts.splice(i + 1, 0, { lat: mid[0], lng: mid[1] }); render(); });
          handles.addLayer(mm);
        }
      }
      if (pts.length >= 3) {                       // LIVE area written inside the contour
        const ic = L.divIcon({ className: "area-label", html: "<span>" + areaHa(pts).toFixed(2) + " га</span>", iconSize: [96, 22], iconAnchor: [48, 11] });
        if (!areaTip) areaTip = L.marker(centroid(pts), { interactive: false, keyboard: false, zIndexOffset: 600, icon: ic }).addTo(map);
        else { areaTip.setLatLng(centroid(pts)); areaTip.setIcon(ic); }
      } else if (areaTip) { map.removeLayer(areaTip); areaTip = null; }
      if (infoEl) {
        const bad = pts.length >= 4 && selfCross(pts);
        const ha = pts.length >= 3 ? areaHa(pts) : 0;
        infoEl.textContent = pts.length + " точ." + (ha ? " · " + ha.toFixed(2) + " га" : "") + (bad ? " · ⚠ перетин" : "");
        infoEl.classList.toggle("bad", bad);
      }
    }

    function start(kind, initialPts, _onCancel) {
      teardown();
      clearSavedOverview();              // leaving the saved-fields browse view
      active = kind;
      pts = (initialPts || []).map((p) => ({ lat: p.lat, lng: p.lng }));
      onCancel = _onCancel || null;
      buildDom();
      cross.style.display = "block";
      bar.style.display = "flex";
      document.body.classList.add("drawing");   // hide the bottom action bar while drawing
      handles.addTo(map);
      map.on("click", onMapClick);
      map.doubleClickZoom.disable();     // a double-tap places points, never zooms
      render();
      const ed = !!(initialPts && initialPts.length);
      setMsg(kind === "field"
        ? (ed ? "Редагування контуру: тягни вершини, «+» на ребрі додає точку, права кнопка видаляє, ➕ — під прицілом. «✓ Готово»."
              : "Контур: наведи приціл і тисни ➕ (чи тап по карті / 📍 моя GPS / 🛩️ дрон). Тягни вершини, «+» вставляє, права кнопка видаляє. «✓ Готово».")
        : (ed ? "Редагування вирізу: тягни вершини / «+» / права кнопка. «✓ Готово»."
              : "Виріз-перешкода: познач його тими ж кнопками, потім «✓ Готово»."), null);
    }
    function onMapClick(e) { add(e.latlng); }
    function finish() {
      if (pts.length < 3) { setMsg("Треба щонайменше 3 точки.", "error"); return; }
      if (selfCross(pts)) { setMsg("Сторони перетинаються — виправ вершини, потім «Готово».", "error"); return; }
      const latlngs = pts.map((p) => [p.lat, p.lng]);
      const kind = active;
      teardown();
      if (kind === "field") {
        adoptField(L.polygon(latlngs, { color: "#2d7ff9", weight: 2 }));
        setMsg("Контур задано. Натисни «Побудувати маршрут».", "ok");
      } else {
        addExclusionLayer(L.polygon(latlngs, { color: "#ff4d4d", weight: 2 }));
        clearRoute();
        setMsg("Виріз додано. Додай ще або «Побудувати маршрут».", "ok");
      }
    }
    function cancel(silent) {
      const was = active, cb = onCancel;
      teardown();
      if (cb) cb();                        // editing → restore the original polygon
      else if (!silent && was) setMsg("Малювання скасовано.", null);
    }
    function teardown() {
      active = null; pts = []; onCancel = null;
      map.off("click", onMapClick);
      try { map.doubleClickZoom.enable(); } catch (e) {}
      if (ring) { map.removeLayer(ring); ring = null; }
      if (areaTip) { map.removeLayer(areaTip); areaTip = null; }
      handles.clearLayers();
      if (map.hasLayer(handles)) map.removeLayer(handles);
      if (cross) cross.style.display = "none";
      if (bar) bar.style.display = "none";
      document.body.classList.remove("drawing");
    }
    return { start, cancel, finish, isActive: () => !!active };
  })();

  // ---- helpers ------------------------------------------------------------
  const $ = (id) => document.getElementById(id);

  function setMsg(text, kind) {
    const el = $("msg");
    el.textContent = text || "";
    el.className = "msg" + (kind ? " " + kind : "");
    mapToast(text, kind);                 // also surface it ON THE MAP (panel may be closed)
  }
  // A transient toast over the map, so feedback is visible while the side panel is
  // closed — e.g. drawing a contour straight on the map on the phone.
  let _toastEl = null, _toastTimer = null;
  function mapToast(text, kind) {
    if (!text) { if (_toastEl) _toastEl.style.display = "none"; return; }
    if (!_toastEl) _toastEl = L.DomUtil.create("div", "map-toast", map.getContainer());
    _toastEl.textContent = text;
    _toastEl.className = "map-toast" + (kind ? " " + kind : "");
    _toastEl.style.display = "block";
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { if (_toastEl) _toastEl.style.display = "none"; }, 4500);
  }

  function clearRoute() {
    lastRoute = null;               // editing buffer; flownRoute keeps the uploaded one
    if (typeof updateMissionStatus === "function") updateMissionStatus();
    if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
    if (routeMarkers) { map.removeLayer(routeMarkers); routeMarkers = null; }
    if (homeMarker) { map.removeLayer(homeMarker); homeMarker = null; }
    if (insetLayer) { map.removeLayer(insetLayer); insetLayer = null; }
    if (parcelsLayer) { map.removeLayer(parcelsLayer); parcelsLayer = null; }
    if (sectorsLayer) { map.removeLayer(sectorsLayer); sectorsLayer = null; }
    $("stats").classList.add("hidden");
    ["exp-wp", "exp-plan", "exp-fence", "exp-fencemp", "exp-geojson"]
      .forEach((id) => { $(id).disabled = true; });
  }

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
    const boundary = boundaryFromPolygon();
    if (!boundary || boundary.length < 3) {
      if (!live) setMsg("Спочатку намалюй контур поля на карті.", "error");
      return;
    }
    const params = {
      boundary,
      spacing: parseFloat($("spacing").value),
      angle: parseFloat($("angle").value),
      auto_angle: $("auto_angle").checked,
      // Optimise heading for LEAST spray overlap on an explicit build; use the
      // cheaper min-path heading for live drags (the overlap sweep is ~1-2 s).
      optimize: live ? "length" : "overlap",
      margin: parseFloat($("margin").value) || 0,
      alt: parseFloat($("alt").value),
      speed: parseFloat($("speed").value),
      rtl: $("rtl").checked,
      exclusions: collectExclusions(),
      anchor: resolveAnchor(),           // start/finish near takeoff/GPS/pin (or null)
      start_finish_anchor: $("start-finish") ? $("start-finish").checked : false,
      split: sectionsSplit(),            // N equal-area sections (or undefined)
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
        res = await eng.buildRoute(params);   // runs in a Web Worker (off the UI thread)
      } catch (err) {
        console.error("offline engine failed, falling back to server:", err);
      }
    }
    if (res === null) {
      const a = api();
      if (!a) { if (!live) setMsg("Рушій недоступний (немає ні офлайн-рушія, ні сервера).", "error"); return; }
      if (!live) setMsg("Будую…", null);
      try {
        res = await a.build_route(params);
      } catch (err) {
        if (myToken === buildSeq && !live) setMsg("Помилка виклику: " + err, "error");
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

    clearRoute();

    // Coverage boundary = field inset by half the spray swath (+ extra margin):
    // the passes live here so the spray reaches the field edge.
    if (res.cover && res.cover.length) {
      const ins = res.cover.map((p) => [p.lat, p.lng]);
      insetLayer = L.polygon(ins, {
        color: "#5fd3a3", weight: 1.5, dashArray: "6 5", fill: false,
      }).addTo(map).bindTooltip("Межа проходів (півширини внесення від краю)");
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

    // Reflect the angle actually used back into the controls (esp. auto-angle).
    syncAngleDisplay(res.angle_used);
    setMsg(live
      ? `Кут ${res.angle_used}° — маршрут оновлено наживо.`
      : "Маршрут готовий. Можна експортувати маршрут або контур.", "ok");
    if (typeof uiOnRouteBuilt === "function") uiOnRouteBuilt(res, live);   // phase UI → Дрон
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
  if (IS_ANDROID || IS_QT) {
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
  ["spacing", "alt", "speed", "margin", "sections", "angle", "angle-range"].forEach((id) => {
    if ($(id)) $(id).addEventListener("input", scheduleSaveSettings);
  });
  ["rtl", "auto_angle", "anchor-source"].forEach((id) => {
    if ($(id)) $(id).addEventListener("change", scheduleSaveSettings);
  });
  window.addEventListener("beforeunload", saveLastSettings);
  restoreLastSettings();          // pre-fill last session's settings before first render
  syncAngleEnabled();
  $("build").addEventListener("click", () => buildRoute());
  if ($("edit-contour")) $("edit-contour").addEventListener("click", startFieldDraw);

  // Warm the offline planning engine (Pyodide) when the app is idle, so the
  // FIRST "Build" isn't a 2-5 s cold boot. Deferred until AFTER the map settles
  // and scheduled in an idle slot, so it can't contend with tile loading (that
  // contention is what made an earlier eager warm stutter). init() runs entirely
  // in the worker, so the main thread only pays a postMessage. Skipped on the Qt
  // desktop (it uses the Python /api engine, not Pyodide).
  if (!IS_QT && window.FMP_ENGINE) {
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
    document.body.classList.toggle("panel-open", open);
    // Leaflet must re-measure after the panel slides over / off the map.
    setTimeout(() => { try { map.invalidateSize(); } catch (e) {} }, 260);
  }
  if ($("panel-toggle")) $("panel-toggle").addEventListener("click",
    () => setPanel(!document.body.classList.contains("panel-open")));
  if ($("panel-scrim")) $("panel-scrim").addEventListener("click", () => setPanel(false));
  if ($("panel-close")) $("panel-close").addEventListener("click", () => setPanel(false));

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
    builder.cancel(true);
    if (exclusionEditMode) setExclusionEdit(false);
    const _eb = $("edit-contour"); if (_eb) _eb.disabled = true;
    drawnItems.clearLayers();
    exclusionItems.clearLayers();
    fieldPolygon = null; setFieldArea();
    if (startMarker) { map.removeLayer(startMarker); startMarker = null; }
    startPoint = null;
    clearRoute();
    setMsg("", null);
  });
  if ($("draw-contour")) $("draw-contour").addEventListener("click", startFieldDraw);
  $("add-exclusion").addEventListener("click", startExclusionDraw);
  $("edit-exclusions").addEventListener("click", () => setExclusionEdit(!exclusionEditMode));
  if ($("show-saved")) $("show-saved").addEventListener("click", showSavedFields);
  $("clear-exclusions").addEventListener("click", () => {
    if (exclusionEditMode) setExclusionEdit(false);
    exclusionItems.clearLayers();
    clearRoute();
    setMsg("Вирізи очищено.", null);
  });
  // Explicit "save cutouts" — mirrors the field contour's "✓ Готово": commit any
  // in-progress draw or vertex-edit so the cutout is finalized and applied to the
  // route. Cutouts persist with the project (collectExclusions -> «💾 Зберегти»).
  $("save-exclusions").addEventListener("click", () => {
    cancelToolbarDraw(); drawingExclusion = false;
    if (exclusionEditMode) setExclusionEdit(false);   // commits nodes + clearRoute
    const n = collectExclusions().length;
    clearRoute();                                      // next build uses the saved cutouts
    setMsg(n ? `Вирізи збережено (${n}). Зберігаються з проєктом («💾 Зберегти»). Перебудуй маршрут.`
             : "Немає вирізів. Намалюй виріз (⛔ Додати виріз).", n ? "ok" : null);
  });
  $("split-field").addEventListener("click", startSplitDraw);
  $("clear-split").addEventListener("click", clearSplit);
  // ---- start/finish anchor: bring the route ends near takeoff / GPS / a pin ---
  let myPosition = null;          // operator GPS (geolocation), {lat,lng}
  let myPosMarker = null, droneGpsMarker = null;
  function anchorSourceVal() { return ($("anchor-source") && $("anchor-source").value) || "pin"; }
  // The lat/lng the route should start (and so finish) nearest, by chosen source.
  function resolveAnchor() {
    const src = anchorSourceVal();
    if (src === "pin") return startPoint;
    if (src === "me") return myPosition;
    if (src === "drone") {
      if (mavConnected && lastStatus) {
        if (lastStatus.home_lat != null) return { lat: lastStatus.home_lat, lng: lastStatus.home_lon };
        if (lastStatus.lat != null) return { lat: lastStatus.lat, lng: lastStatus.lon };
      }
      return null;                // not connected / no fix -> field geometry decides
    }
    return null;                  // "none"
  }
  // N equal-area sections (each flown as its own flight), or undefined for one.
  function sectionsSplit() {
    // A valid drawn split line takes priority over the N-equal-area split.
    if (splitLine && splitLine.length >= 2 &&
        splitLine.every((p) => p && isFinite(p.lat) && isFinite(p.lng)))
      return { mode: "manual_line", line: splitLine };
    const n = Math.max(1, parseInt(($("sections") || {}).value, 10) || 1);
    return n > 1 ? { mode: "n_area", n } : undefined;
  }
  function setStartMode(on) {
    startMode = on;
    const btn = $("set-start");
    btn.classList.toggle("active", startMode);
    btn.textContent = startMode ? "📍 Клікни точку на карті" : "📍 Вказати точку";
    document.getElementById("map").style.cursor = startMode ? "crosshair" : "";
  }
  $("set-start").addEventListener("click", () => setStartMode(!startMode));

  map.on("click", (e) => {
    if (!startMode) return;
    startPoint = { lat: e.latlng.lat, lng: e.latlng.lng };
    const icon = L.divIcon({ className: "start-marker",
      html: '<div style="font-size:22px;line-height:22px">🟢</div>',
      iconSize: [22, 22], iconAnchor: [11, 11] });
    if (startMarker) startMarker.setLatLng(e.latlng).setIcon(icon);
    else startMarker = L.marker(e.latlng, { icon }).addTo(map);
    startMarker.bindTooltip("Якір: старт/фініш ближче сюди");
    if ($("anchor-source")) $("anchor-source").value = "pin";
    setStartMode(false);
    setMsg("Точку-якір задано. Натисни «Побудувати маршрут».", "ok");
  });

  // Show MY phone GPS on the map (📍) and make the route start/finish from there.
  function showMyGps() {
    if (!navigator.geolocation) { setMsg("Геолокація недоступна на цьому пристрої.", "error"); return; }
    setMsg("Беру GPS телефону…", null);
    navigator.geolocation.getCurrentPosition((pos) => {
      myPosition = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      const icon = L.divIcon({ className: "gps-marker me", html: "📍", iconSize: [30, 30], iconAnchor: [15, 28] });
      if (myPosMarker) myPosMarker.setLatLng([myPosition.lat, myPosition.lng]).setIcon(icon);
      else myPosMarker = L.marker([myPosition.lat, myPosition.lng], { icon, zIndexOffset: 1100 }).addTo(map);
      myPosMarker.bindTooltip("Моя GPS — маршрут стартує/фінішує звідси");
      if ($("anchor-source")) $("anchor-source").value = "me";
      map.setView([myPosition.lat, myPosition.lng], Math.max(map.getZoom(), 15));
      setMsg("Моя GPS позначена 📍 — маршрут відштовхуватиметься звідси.", "ok");
    }, (err) => setMsg("Не вдалося визначити GPS телефону: " + ((err && err.message) || err), "error"),
       { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
  }
  function dronePos() {
    if (!(mavConnected && lastStatus)) return null;
    if (lastStatus.lat != null && isFinite(lastStatus.lat)) return { lat: lastStatus.lat, lng: lastStatus.lon };
    if (lastStatus.home_lat != null) return { lat: lastStatus.home_lat, lng: lastStatus.home_lon };
    return null;
  }
  // Show the DRONE's GPS on the map (🛩️) and make the route start/finish from there.
  function showDroneGps() {
    const p = dronePos();
    if (!p) {
      setMsg(!mavConnected
        ? "Дрон не підключений — відкрий вкладку «Політ» і підключись, тоді натисни ще раз."
        : "GPS дрона ще нема: зачекай на фікс супутників, або телеметрія не йде — перевір зв'язок (USB надійніший за бекпак).", "error");
      return;
    }
    const icon = L.divIcon({ className: "gps-marker drone", html: "🛩️", iconSize: [30, 30], iconAnchor: [15, 15] });
    if (droneGpsMarker) droneGpsMarker.setLatLng([p.lat, p.lng]).setIcon(icon);
    else droneGpsMarker = L.marker([p.lat, p.lng], { icon, zIndexOffset: 1100 }).addTo(map);
    droneGpsMarker.bindTooltip("GPS дрона — маршрут стартує/фінішує звідси");
    if ($("anchor-source")) $("anchor-source").value = "drone";
    map.setView([p.lat, p.lng], Math.max(map.getZoom(), 15));
    setMsg("GPS дрона позначено 🛩️ — маршрут відштовхуватиметься звідси (" + p.lat.toFixed(5) + ", " + p.lng.toFixed(5) + ").", "ok");
  }
  $("my-position").addEventListener("click", showMyGps);

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
      sections: parseInt($("sections").value, 10) || 1,
      start_finish_anchor: $("start-finish") ? $("start-finish").checked : true,
    };
  }
  function applyParams(p) {
    if (!p) return;
    const set = (id, v) => { if (v !== undefined && v !== null && $(id)) $(id).value = v; };
    set("spacing", p.spacing); set("angle", p.angle); set("margin", p.margin);
    set("alt", p.alt); set("speed", p.speed); set("sections", p.sections);
    if ($("auto_angle")) $("auto_angle").checked = !!p.auto_angle;
    if ($("rtl")) $("rtl").checked = p.rtl !== false;
    if ($("start-finish")) $("start-finish").checked = p.start_finish_anchor !== false;
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
    if (s.anchor_source && $("anchor-source")) $("anchor-source").value = s.anchor_source;
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

  // ---- SAVED-FIELDS OVERVIEW: show ALL saved fields at once on the map (contour +
  // area inside + their exclusions), tap one to pick it for work. (Works wherever the
  // field store works — phone, PWA, desktop.) -------------------------------------
  let overviewLayer = null;
  function clearSavedOverview() { if (overviewLayer) { map.removeLayer(overviewLayer); overviewLayer = null; } }
  async function showSavedFields() {
    let recs = await fldAll();
    if (recs === null) { const o = lpAll(); recs = Object.keys(o).map((n) => Object.assign({ name: n }, o[n])); }
    recs = (recs || []).filter((r) => r.field && r.field.length >= 3);
    if (!recs.length) { setMsg("Немає збережених полів. Намалюй контур (✏️) і збережи (💾).", null); return; }
    builder.cancel(true);
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
        icon: L.divIcon({ className: "area-label field", html: "<span><b>" + esc(r.name) + "</b><br>" + ha.toFixed(2) + " га</span>", iconSize: [140, 38], iconAnchor: [70, 19] }) }).addTo(overviewLayer);
      poly.bindTooltip("Натисни, щоб працювати з «" + esc(r.name) + "»");
      poly.on("click", (e) => {
        L.DomEvent.stop(e); clearSavedOverview();
        applyProject(r); currentFieldName = r.name;
        setMsg("Поле «" + r.name + "» обрано для роботи.", "ok");
      });
    });
    if (bounds) map.fitBounds(bounds, { padding: [50, 50] });
    setMsg(recs.length + " збережених полів на карті — натисни на поле, щоб обрати для роботи.", "ok");
  }

  $("save-project").addEventListener("click", async () => {
    const field = boundaryFromPolygon();
    if (!field || field.length < 3) { setMsg("Спочатку задай поле.", "error"); return; }
    const name = (prompt("Назва поля:", currentFieldName || "Поле") || "").trim();
    if (!name) return;
    const now = Date.now();
    const rec = { name, field, params: collectParams(), exclusions: collectExclusions(),
      created: now, updated: now, area_ha: lastFieldAreaHa || 0 };
    const ok = await fldPut(rec);
    if (!ok) { try { lpSave(name, rec); } catch (e) { setMsg("Не вдалося зберегти: " + e, "error"); return; } }
    currentFieldName = name;
    setMsg(`Поле «${name}» збережено локально (на цьому пристрої).`, "ok");
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
      el.textContent = "⚠️ Маршрут НЕ залито в дрон. Натисни «⬆️ Залити місію».";
      el.className = "mission-status warn";
    } else if (plan === flown) {
      el.textContent = `✅ У дроні поточна місія: ${lastRoute.length} точок.`;
      el.className = "mission-status ok";
    } else {
      el.textContent = "⚠️ План ЗМІНЕНО після заливки — у дроні СТАРА місія. Залий заново!";
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
      // devices are added with the «🔌 Вибрати пристрій» button (requestPort).
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
        return { ok: true, ports: [], note: "Натисни «🔌 Вибрати пристрій» і обери свій політник у вікні браузера." };
      }
      // Android browser (no Web Serial) / other: can't do direct USB here.
      return { ok: true, ports: [], note: "Прямий USB недоступний у цьому браузері. На Android встанови APK (кнопка «📱 Android» нижче) або під'єднайся через мережу (UDP/TCP)." };
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
            catch (e) { return { ok: false, error: "Пристрій не вибрано. Натисни «🔌 Вибрати пристрій», обери політник у списку, тоді «Підключити»." }; }
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
        setMsg("Пристрій додано. Тисни «Підключити».", null);
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
        if (typeof uiOnConnected === "function") uiOnConnected();   // phase UI → Дрон/Політ
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
    if (typeof uiOnDisconnected === "function") uiOnDisconnected();   // phase UI: back to plan strip
    $("mav-hud").classList.add("hidden");
    if (droneMarker) { map.removeLayer(droneMarker); droneMarker = null; }
    if (droneTrack) { map.removeLayer(droneTrack); droneTrack = null; }
    mavClearTarget();
    if (liveHomeMarker) { map.removeLayer(liveHomeMarker); liveHomeMarker = null; }
    if (droneMissionLayer) { map.removeLayer(droneMissionLayer); droneMissionLayer = null; }
    flightRecAbort();               // link dropped mid-flight -> save what we have (partial)
    mavResetPhase();
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
    // Periodic telemetry snapshot into the log (~every 10 s) — the trail of what
    // actually arrived over the link, for after-the-fact error analysis.
    if (!mavPoll._lastSnap || Date.now() - mavPoll._lastSnap > 10000) {
      mavPoll._lastSnap = Date.now();
      appLog(`tlm mode=${s.mode} armed=${s.armed} fix=${s.fix_type} sats=${s.sats} `
        + `lat=${s.lat} batt=${s.battery_v} gs=${s.groundspeed} wp=${s.wp_current}/${s.wp_total}`);
    }
    mavRenderHud(s);
    mavUpdateMarker(s);
    if (typeof renderStrip === "function") { renderStrip(s); maybeRefreshBar(); updateFollowPill(); }
  }

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
      else if (s.fix_type >= 2) { diag = "✓ телеметрія + GPS"; diagColor = "#5fd3a3"; }
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
      setMsg("✅ Місію завершено — остання точка досягнута.", "ok");
    }
    if (!_landedShown && _wasArmed && s.armed === false
        && (s.alt_rel == null || s.alt_rel < 0.8)) {
      _landedShown = true; _wasArmed = false;
      setMsg("🛬 Посадка — апарат на землі (DISARM).", "ok");
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
      html: '<div style="font-size:20px;line-height:20px">🏠</div>',
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
        if (typeof uiOnUploaded === "function") uiOnUploaded();   // phase UI → Політ
        let m = `Місію залито в дрон (${r.count} пунктів).`;
        const v = r.verify;
        if (v && v.ok && v.verified) {
          m += " ✅ Перевірено зчитуванням — збігається.";
          setMsg(m, "ok");
        } else if (v && v.ok && !v.verified) {
          m += ` ⚠️ Зчитана місія НЕ збігається (${(v.mismatches || []).join("; ") || "розбіжності"}).`;
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
    out.push("версія: " + APP_VERSION + (IS_ANDROID ? " APK" : IS_QT ? " Qt-ПК" : " web"));
    try { out.push("час: " + new Date().toString()); } catch (e) {}
    out.push("UA: " + (navigator.userAgent || ""));
    try { out.push("зʼєднання: " + mavConnString() + " | підключено=" + mavConnected); } catch (e) {}
    if (lastStatus) out.push("остання телеметрія: " + JSON.stringify(lastStatus));
    try { if (_mavLink && _mavLink.getStats) out.push("MAVLink: " + JSON.stringify(_mavLink.getStats())); } catch (e) {}
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
    setMsg("Лог (" + LOG.length + " рядків) " + (sent ? "✅ надіслано на сервер для аналізу" : "⚠️ на сервер не пішло — скопійовано в буфер") + ".", sent ? "ok" : "error");
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
    if (!_isNewer(latest, APP_VERSION)) { setMsg(`✅ У вас остання версія (v${APP_VERSION}).`, "ok"); return; }
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
      if (plan && plan === flown) m = "✅ " + m + " Збігається з планом.";
      setMsg(m, "ok");
    } catch (e) { setMsg("Помилка зчитування: " + e, "error"); }
  });

  $("mav-start").addEventListener("click", () => {
    if (!lastStatus || !lastStatus.armed) {
      setMsg("Спершу увімкни мотори: 🔓 ARM (за потреби постав режим GUIDED).", "error");
      return;
    }
    // Don't fly a stale mission: warn hard if the plan differs from what we uploaded.
    if (routeSig(lastRoute) !== routeSig(flownRoute)) {
      if (!confirm("⚠️ У дроні НЕ поточний план (або місію не залито). Спершу натисни " +
                   "«⬆️ Залити місію». Все одно запустити те, що ЗАРАЗ у дроні?")) return;
    }
    // For a clean "climb straight up, then fly", the drone must start from the
    // ground — otherwise ArduCopter skips the vertical takeoff.
    const airborne = lastStatus && lastStatus.alt_rel != null && lastStatus.alt_rel > 1.5;
    let warn = "Запустити місію в AUTO? Апарат полетить за маршрутом.";
    if (airborne) {
      warn = "⚠️ Дрон уже в повітрі — вертикальний зліт буде пропущено, він піде " +
             "одразу до точки. Для чистого зльоту спершу посади (RTL/LAND) і роззброй. " +
             "Все одно запустити?";
    }
    if (confirm(warn)) {
      // Switch to AUTO, then start (the backend resets to the takeoff first).
      mavCommand({ action: "mode", mode: "AUTO" }, "Режим AUTO").then(() =>
        mavCommand({ action: "start" }, "Старт місії"));
    }
  });

  // =========================================================================
  // FIELD-OPS PHASE UI (phone): full-screen map + status strip + phase rail +
  // a bottom action bar with ONE big primary per phase. Every button is a PROXY
  // that drives the existing controls (which stay in #panel as the full "all
  // settings" sheet) — so no existing handler is touched and nothing can break.
  // Mobile-only via CSS; on desktop the overlays are hidden and this just mutates
  // hidden DOM harmlessly while the classic side panel keeps working.
  // =========================================================================
  let uiPhase = 1;            // 1 Поле · 2 Маршрут · 3 Дрон · 4 Політ
  let uiRibbon = null;        // {ha,min,l} of the last built route (stats ribbon)

  function uiIsMobile() { return window.matchMedia("(max-width: 760px)").matches; }
  function fieldAreaHa() {
    try { return (L.GeometryUtil.geodesicArea(fieldPolygon.getLatLngs()[0]) / 1e4) || 0; }
    catch (e) { return null; }
  }
  function uiState() {
    const hasField = !!fieldPolygon;
    const hasRoute = !!lastRoute;
    const connected = !!mavConnected;
    const uploaded = !!(flownRoute && lastRoute && routeSig(lastRoute) === routeSig(flownRoute));
    const s = lastStatus;
    return {
      hasField, hasRoute, connected, uploaded, s,
      armed: !!(s && s.armed),
      mode: s ? s.mode : null,
      airborne: !!(s && s.alt_rel != null && s.alt_rel > 1.5),
    };
  }

  // ---- proxy + panel-sheet helpers ----
  function proxyClick(id) {
    const b = $(id);
    if (!b) return;
    if (b.disabled) { setMsg("Ця дія зараз недоступна.", null); return; }
    b.click();
  }
  function openPanel(tab) {
    const t = document.querySelector('.tab[data-tab="' + tab + '"]');
    if (t) t.click();
    if (typeof setPanel === "function") setPanel(true);
  }
  const UI_ACTS = {
    draw: () => startFieldDraw(),
    edit: () => startFieldDraw(),
    excl: () => startExclusionDraw(),
    fields: () => showSavedFields(),
    "gear-plan": () => openPanel("plan"),
    "gear-fly": () => openPanel("fly"),
    toRoute: () => goPhase(2),
    toDrone: () => goPhase(3),
    toFly: () => goPhase(4),
    build: () => proxyClick("build"),
    connect: () => mavConnect(),
    upload: () => proxyClick("mav-upload"),
    check: () => proxyClick("mav-check"),
    // Flight actions (arm/disarm/start/pause/resume/rtl) are intentionally NOT
    // here — they are SLIDE-ONLY (see SLIDE_ACTS below) so an accidental tap with
    // the phone in your hands in the field can never fire a flight command.
  };

  // ---- HTML builders ----
  function abPrimary(act, ic, label, cls, disabled) {
    return `<button class="act-primary${cls ? " " + cls : ""}" data-act="${act}"${disabled ? " disabled" : ""}>`
      + `<span class="pic">${ic}</span>${esc(label)}</button>`;
  }
  function abChip(act, ic, label) {
    return `<button class="act-chip" data-act="${act}">${ic}${label ? " " + esc(label) : ""}</button>`;
  }
  function abGear(act) { return `<button class="act-chip act-gear" data-act="${act}">⚙</button>`; }
  function abBig(act, ic, label, cls, disabled) {
    return `<button class="act-big${cls ? " " + cls : ""}" data-act="${act}"${disabled ? " disabled" : ""}>`
      + `<span class="pic">${ic}</span>${esc(label)}</button>`;
  }

  // ---- slide-to-confirm flight controls (NO accidental taps in the field) ----
  // The flight triad (ARM/DISARM · СТАРТ/ПАУЗА/ПРОДОВЖ · RTL) fires ONLY on a
  // deliberate horizontal SLIDE across the button — a brush or accidental tap with
  // the phone in your hands does nothing. The gesture records window.__fmpLastAction
  // the instant it is confirmed (before talking to the drone) — the controls-safety
  // test uses that to prove tap≠fire / slide=fire.
  function abSlide(act, ic, label, cls) {
    return `<button class="act-big swipe${cls ? " " + cls : ""}" data-act="${act}" `
      + `aria-label="${esc(label)} — протягни щоб підтвердити">`
      + `<span class="swipe-fill"></span><span class="pic">${ic}</span>${esc(label)}`
      + `<span class="swipe-hint">↦ протягни</span></button>`;
  }
  function setLastAction(name) { try { window.__fmpLastAction = { name: name, t: Date.now() }; } catch (e) {} }
  function needLink() {
    if (!mavConnected) { setMsg("Немає звʼязку — підключи дрон у «Дрон».", "error"); return true; }
    return false;
  }
  function flyArm() {
    setLastAction("arm");
    if (needLink()) return;
    const m = (lastStatus && lastStatus.mode) || "";
    if (typeof NON_ARMABLE !== "undefined" && NON_ARMABLE.includes(m)) {
      setMsg(`Режим ${m} не дозволяє ARM — перемикаю на GUIDED…`, null);
      mavCommand({ action: "mode", mode: "GUIDED" }, "Режим GUIDED")
        .then(() => mavCommand({ action: "arm" }, "ARM"));
    } else { mavCommand({ action: "arm" }, "ARM"); }
  }
  function flyDisarm() { setLastAction("disarm"); if (needLink()) return; mavCommand({ action: "disarm" }, "DISARM"); }
  function flyStart() {
    setLastAction("start");
    if (needLink()) return;
    const airborne = lastStatus && lastStatus.alt_rel != null && lastStatus.alt_rel > 1.5;
    if (airborne) setMsg("⚠️ Дрон у повітрі — вертикальний зліт пропущено, йде одразу до точки.", null);
    mavCommand({ action: "mode", mode: "AUTO" }, "Режим AUTO")
      .then(() => mavCommand({ action: "start" }, "Старт місії"));
  }
  function flyPause() { setLastAction("pause"); if (needLink()) return; mavCommand({ action: "mode", mode: "LOITER" }, "Пауза (LOITER)"); }
  function flyResume() { setLastAction("resume"); if (needLink()) return; mavCommand({ action: "mode", mode: "AUTO" }, "Продовжити (AUTO)"); }
  function flyRtl() { setLastAction("rtl"); if (needLink()) return; mavCommand({ action: "mode", mode: "RTL" }, "RTL"); }
  const SLIDE_ACTS = { arm: flyArm, disarm: flyDisarm, start: flyStart, pause: flyPause, resume: flyResume, rtl: flyRtl };
  function attachSlide(el) {
    let downX = null, w = 0;
    const fill = el.querySelector(".swipe-fill");
    const reset = () => { if (fill) fill.style.width = "0"; el.classList.remove("armed-go"); downX = null; };
    el.addEventListener("pointerdown", (e) => {
      if (el.disabled) return;
      downX = e.clientX; w = el.getBoundingClientRect().width || 1;
      try { el.setPointerCapture(e.pointerId); } catch (z) {}
    });
    el.addEventListener("pointermove", (e) => {
      if (downX == null) return;
      const dx = Math.max(0, e.clientX - downX);
      const p = Math.min(1, dx / (w * 0.66));        // must cross ~2/3 of the width
      if (fill) fill.style.width = (p * 100) + "%";
      el.classList.toggle("armed-go", p >= 1);
    });
    el.addEventListener("pointerup", () => {
      if (downX == null) return;
      const go = el.classList.contains("armed-go");
      reset();
      if (go) { const fn = SLIDE_ACTS[el.dataset.act]; if (fn) fn(); }
    });
    el.addEventListener("pointercancel", reset);
    el.addEventListener("lostpointercapture", reset);
  }
  function attachSlides() {
    const bar = $("action-bar");
    if (bar) bar.querySelectorAll(".act-big.swipe").forEach(attachSlide);
  }
  function stTile(ic, val, col) {
    return `<span class="strip-tile"${col ? ' style="color:' + col + '"' : ""}>`
      + `${ic ? '<span class="ti">' + ic + "</span>" : ""}${esc(String(val))}</span>`;
  }
  function ribbonHtml() {
    if (!uiRibbon) return "";
    const r = uiRibbon;
    return `<div class="stats-ribbon" style="display:flex">▸ <b>${esc(r.ha)}</b> га · `
      + `<b>${esc(r.min)}</b> хв${r.l ? ` · <b>${esc(r.l)}</b> л` : ""}</div>`;
  }

  // ---- phase rail ----
  const RAIL = [
    { n: 1, ic: "①", label: "Поле" },
    { n: 2, ic: "②", label: "Маршрут" },
    { div: true },
    { n: 3, ic: "③", label: "Дрон" },
    { n: 4, ic: "④", label: "Політ" },
  ];
  function buildRail() {
    const rail = $("phase-rail");
    if (!rail) return;
    rail.innerHTML = RAIL.map((seg) => seg.div
      ? '<div class="phase-div"></div>'
      : `<button class="phase-seg" data-phase="${seg.n}"><span class="pi">${seg.ic}</span>${seg.label}</button>`
    ).join("");
    rail.addEventListener("click", (e) => {
      const b = e.target.closest("[data-phase]");
      if (b) goPhase(parseInt(b.dataset.phase, 10));
    });
  }
  function refreshRail() {
    const rail = $("phase-rail");
    if (!rail) return;
    const st = uiState();
    const done = { 1: st.hasField, 2: st.hasRoute, 3: st.uploaded, 4: false };
    rail.querySelectorAll(".phase-seg").forEach((seg) => {
      const n = parseInt(seg.dataset.phase, 10);
      seg.classList.toggle("active", n === uiPhase);
      seg.classList.toggle("done", !!done[n] && n !== uiPhase);
    });
  }

  // ---- action bar (one primary per phase) ----
  function renderBar() {
    const bar = $("action-bar");
    if (!bar) return;
    const st = uiState();
    let html = "";
    if (uiPhase === 1) {
      if (!st.hasField) {
        html = `<div class="act-row">${abChip("fields", "📁", "Поля")}${abGear("gear-plan")}</div>`
          + abPrimary("draw", "✏️", "НАМАЛЮВАТИ ПОЛЕ");
      } else {
        html = `<div class="act-row">${abChip("edit", "✎", "Контур")}${abChip("excl", "⛔", "Виріз")}${abGear("gear-plan")}</div>`
          + abPrimary("toRoute", "➡️", "ДО МАРШРУТУ", "is-go");
      }
    } else if (uiPhase === 2) {
      if (!st.hasField) {
        html = `<div class="act-row">${abGear("gear-plan")}</div>` + abPrimary("draw", "✏️", "НАМАЛЮВАТИ ПОЛЕ");
      } else if (!st.hasRoute) {
        html = `<div class="act-row">${abGear("gear-plan")}</div>` + abPrimary("build", "🛠", "ПОБУДУВАТИ МАРШРУТ");
      } else {
        html = ribbonHtml()
          + `<div class="act-row">${abChip("build", "🛠", "Перебудувати")}${abGear("gear-plan")}</div>`
          + abPrimary("toDrone", "➡️", "ДО ДРОНА", "is-go");
      }
    } else if (uiPhase === 3) {
      if (!st.connected) {
        html = `<div class="act-row">${abGear("gear-fly")}</div>` + abPrimary("connect", "🔗", "ПІДКЛЮЧИТИ ДРОН");
      } else if (!st.hasRoute) {
        html = `<div class="act-row">${abGear("gear-fly")}</div>` + abPrimary("toRoute", "🛠", "СПЕРШУ МАРШРУТ");
      } else if (!st.uploaded) {
        html = `<div class="act-row">${abChip("check", "🔍", "У дроні?")}${abGear("gear-fly")}</div>`
          + abPrimary("upload", "⬆️", "ЗАЛИТИ МІСІЮ");
      } else {
        html = `<div class="act-row">${abChip("check", "🔍", "У дроні?")}${abGear("gear-fly")}</div>`
          + abPrimary("toFly", "➡️", "ДО ПОЛЬОТУ", "is-go");
      }
    } else { // phase 4 — flight triad (SLIDE-to-confirm, no accidental taps)
      const armBtn = st.armed ? abSlide("disarm", "🔒", "DISARM", "is-danger")
        : abSlide("arm", "🔓", "ARM", "is-arm");
      let midBtn;
      if (st.armed && st.mode === "LOITER") midBtn = abSlide("resume", "▶️", "ПРОДОВЖ", "is-go");
      else if (st.armed && st.mode === "AUTO" && st.airborne) midBtn = abSlide("pause", "⏸", "ПАУЗА", "");
      else midBtn = abSlide("start", "▶️", "СТАРТ", "is-go");
      const rtlBtn = abSlide("rtl", "🏠", "RTL", "is-danger");
      html = `<div class="act-row">${abGear("gear-fly")}</div>`
        + `<div class="act-triad">${armBtn}${midBtn}${rtlBtn}</div>`;
    }
    bar.innerHTML = html;
    attachSlides();          // wire slide-to-confirm on any flight buttons just rendered
  }

  // ---- top status strip ----
  let _stripLast = "";
  function renderStrip(s) {
    const strip = $("status-strip");
    if (!strip) return;
    let html = "", fly = false;
    if (mavConnected && s) {
      fly = true;
      const batt = s.battery_pct != null ? s.battery_pct + "%" : (s.battery_v != null ? s.battery_v + "В" : "—");
      const battCol = s.battery_pct != null
        ? (s.battery_pct < 20 ? "#ff7b72" : s.battery_pct < 35 ? "#ffcf66" : "#5fd3a3") : "";
      const sats = s.sats != null ? s.sats : "?";
      const fixCol = s.fix_type >= 5 ? "#5fd3a3" : s.fix_type >= 3 ? "#cfe3ff" : s.fix_type >= 2 ? "#ffcf66" : "#ff7b72";
      html = stTile("🔋", batt, battCol)
        + stTile("🛰️", (s.fix_type >= 5 ? "RTK" : "") + sats, fixCol)
        + stTile("📶", s.connected ? "●" : "○", s.connected ? "#5fd3a3" : "#ff7b72")
        + stTile("", s.mode || "—", "#cfe3ff")
        + stTile("▲", s.alt_rel != null ? Math.round(s.alt_rel) : "—", "")
        + stTile("►", s.groundspeed != null ? Math.round(s.groundspeed * 10) / 10 : "—", "");
    } else {
      const ha = fieldPolygon ? fieldAreaHa() : null;
      const ctx = ha != null ? "Поле " + ha.toFixed(2) + " га" : "Нове поле";
      const dot = !lastRoute ? '<span class="strip-dot" style="color:#6d7e8e">▫</span>'
        : (flownRoute && routeSig(lastRoute) === routeSig(flownRoute)
          ? '<span class="strip-dot" style="color:#5fd3a3">✓</span>'
          : '<span class="strip-dot" style="color:#ffcf66">⚠</span>');
      html = `<span class="strip-ctx">${esc(ctx)}</span><span class="strip-spacer"></span>${dot}`;
    }
    strip.classList.toggle("fly", fly);
    if (html !== _stripLast) { strip.innerHTML = html; _stripLast = html; }
  }

  // ---- follow-drone pill (FLY) ----
  let followPill = null;
  function updateFollowPill() {
    if (!followPill) return;
    followPill.style.display = (uiIsMobile() && mavConnected && uiPhase === 4) ? "inline-flex" : "none";
    followPill.classList.toggle("on", !!mavFollow);
  }

  // ---- phase transitions ----
  function goPhase(n) {
    uiPhase = n;
    refreshRail();
    renderBar();
    renderStrip(lastStatus);
    updateFollowPill();
    _barSig = barSig();
  }
  let _barSig = "";
  function barSig() {
    const st = uiState();
    return [uiPhase, st.hasField, st.hasRoute, st.connected, st.uploaded, st.armed, st.mode, st.airborne].join("|");
  }
  function maybeRefreshBar() {
    const sig = barSig();
    if (sig !== _barSig) { _barSig = sig; renderBar(); refreshRail(); }
  }

  // ---- hooks called from the existing flow (declarations → hoisted) ----
  function uiOnField() { if (uiPhase === 1) goPhase(2); else maybeRefreshBar(); }
  function uiOnRouteBuilt(res, live) {
    try { uiRibbon = { ha: res.area_ha, min: Math.round(res.duration_s / 60), l: res.liquid_l || 0 }; } catch (e) {}
    if (!live && uiPhase <= 2) goPhase(3); else maybeRefreshBar();
  }
  function uiOnConnected() { if (uiPhase < 3) goPhase(3); else maybeRefreshBar(); renderStrip(lastStatus); }
  function uiOnUploaded() { if (uiPhase === 3) goPhase(4); else maybeRefreshBar(); }
  function uiOnDisconnected() { maybeRefreshBar(); renderStrip(null); updateFollowPill(); }

  // ---- init ----
  (function initPhaseUI() {
    buildRail();
    const bar = $("action-bar");
    if (bar) bar.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      // Slide-to-confirm buttons (the flight triad) never act on a plain click —
      // they fire only via the deliberate slide gesture (attachSlide).
      if (b && !b.classList.contains("swipe")) { const fn = UI_ACTS[b.dataset.act]; if (fn) fn(); }
    });
    const strip = $("status-strip");
    if (strip) strip.addEventListener("click", () => { if (mavConnected) openPanel("fly"); });
    followPill = document.createElement("button");
    followPill.id = "follow-pill";
    followPill.type = "button";
    followPill.innerHTML = "🎯 стежити";
    followPill.addEventListener("click", () => {
      mavFollow = !mavFollow;
      const cb = $("mav-follow"); if (cb) cb.checked = mavFollow;
      updateFollowPill();
    });
    document.body.appendChild(followPill);
    goPhase(1);
  })();
})();
