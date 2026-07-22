# Phase 2A — Контур-автозбереження + Covered-area + Статистика Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Залитий у дрон контур завжди зберігається як іменований запис (UPSERT, без дублів); кожен AUTO-політ дає рядок у новій вкладці «Статистика» з покритою площею (правило ≥90%→контур, інакше відстань×ширина), Га/хв, фільтром період і сумарною площею.

**Architecture:** Чиста covered-area геометрія (`pointInRing`/`distInField`/`coveredHa`/`coverageCompletion`) виноситься у новий loadable-модуль `web-stable/geo-cover.js` (той самий патерн, що `mav/*.js`) → Node-юніт-тести без DOM. `app.js` споживає `window.GEO_COVER`. Решта — UPSERT на upload-шляху, розширення `flightRecFinalize`, нова вкладка.

**Tech Stack:** Vanilla JS (ES2019 IIFE), IndexedDB (`fmp_fields`, `fmp_flightlog`), Leaflet, Node 18+ headless тест (`test_geocover.mjs`), Python id-крос-чек (`test_ui.py`).

## Global Constraints

- **Джерело правди для covered-area — модуль `geo-cover.js`** (чистий, без DOM); `app.js` лише передає дані.
- **{lat,lon} vs {lat,lng} контракт (critical, spec §8):** семпли зберігаються `{lat, lon}` (`app.js:3249`); поле-ring — `{lat, lng}`. `pointInRing(lat, lon, ring)` бере `lon` як x і читає `ring[i].lng`; `distInField(samples, ring)` читає `sample.lon`. Порушення → кожен `lng` `undefined` → NaN → `covered_ha===0` на ВСІХ partial-польотах.
- **Правило покриття (spec §8):** `covComplete = sawComplete || (wr>=lastCoverageSeq) || (compFrac>=0.90)`, `lastCoverageSeq = wp_total-1-(hasRtl?1:0)`, `compFrac = lastCoverageSeq>0 ? min(1, wr/lastCoverageSeq) : 0`. `if covComplete: covered=area_ha; else: covered=min(dist*swath_m/1e4, area_ha)`. `covComplete`/partial **взаємовиключні**. Cap `min(..,area_ha)` — covered ніколи > поле. `swath_m` falsy → `covered=null` («—»).
- **UPSERT по стабільному ключу:** re-upload того самого поля ОНОВЛЮЄ запис, не дублює. Freshly-drawn (`currentFieldName===""`) → мінт `"Поле N"` **once** + присвоїти `currentFieldName`. Зберігати `created` при UPSERT.
- **Стор-функції — це `fldPut`/`fldAll`/`fldDelete` і `flogPut`/`flogAll`** (НЕ fldGet/fldDel/flogAdd; `getAllKeys` не використовується).
- **`geo-cover.js` мусить потрапити в offline-кеш** (`sw.js` SHELL) і в APK-асети — інакше офлайн зламається.
- **i18n:** усі нові UA-рядки → ключі в `i18n.js` (`window.FMP_TR`); значення з одиницями лишати голими числами (бо `enUnits()` перекладає ` га`/` км` тощо).
- **Тести:** `node test_geocover.mjs` (covered-area математика), `node test_jsmav.mjs` (не має регресувати), `python3 test_ui.py` (id-крос-чек). Кожен таск — зелений тест. Часті коміти.

---

### Task 1: `geo-cover.js` — чистий covered-area модуль + Node-юніт-тести

**Files:**
- Create: `web-stable/geo-cover.js`
- Create: `test_geocover.mjs`

**Interfaces:**
- Produces: `window.GEO_COVER = { haversineM, pointInRing, distInField, coveredHa, coverageCompletion }`.
  - `pointInRing(lat, lon, ring[{lat,lng}]) -> bool`
  - `distInField(samples[{lat,lon}], ring[{lat,lng}]|null) -> number|null` (null коли ring < 3 точок)
  - `coverageCompletion({sawComplete, wpReached, wpTotal, hasRtl}) -> {covComplete, compFrac, completionPct}`
  - `coveredHa({covComplete, areaHa, swathM, distM}) -> number|null`

- [ ] **Step 1: Написати падаючі тести `test_geocover.mjs`**

```js
/* Headless unit tests for web-stable/geo-cover.js (pure covered-area geometry).
 * Run: node test_geocover.mjs   (Node 18+, no DOM). */
import fs from "fs";
import vm from "vm";
import { fileURLToPath } from "url";
import path from "path";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(HERE, "web-stable", "geo-cover.js"), "utf8"), ctx);
const G = ctx.window.GEO_COVER;
let failed = 0;
const check = (n, c) => { console.log((c ? "  OK  " : " FAIL ") + n); if (!c) failed++; };
const near = (a, b, eps) => Math.abs(a - b) <= eps;

// A ~100 m square ring near 49.49N (ring uses .lng).
const ring = [
  { lat: 49.4900, lng: 24.0000 }, { lat: 49.4900, lng: 24.0014 },
  { lat: 49.4909, lng: 24.0014 }, { lat: 49.4909, lng: 24.0000 },
];
check("pointInRing: centre is inside", G.pointInRing(49.49045, 24.0007, ring) === true);
check("pointInRing: far point is outside", G.pointInRing(49.60, 24.10, ring) === false);

// distInField: a track that stays inside the ring returns > 0 (the {lat,lon} contract).
const inside = [
  { lat: 49.4902, lon: 24.0003 }, { lat: 49.4902, lon: 24.0011 }, { lat: 49.4907, lon: 24.0011 },
];
check("distInField: in-field track > 0 (lon/lng contract)", G.distInField(inside, ring) > 0);
check("distInField: null ring → null (caller falls back)", G.distInField(inside, null) === null);
// A track entirely outside contributes 0.
const outside = [{ lat: 49.60, lon: 24.10 }, { lat: 49.61, lon: 24.11 }];
check("distInField: out-of-field track = 0", G.distInField(outside, ring) === 0);

// coverageCompletion: sawComplete / threshold / fraction.
check("completion: sawComplete → covComplete", G.coverageCompletion({ sawComplete: true, wpReached: 0, wpTotal: 10, hasRtl: true }).covComplete === true);
check("completion: >=90% → covComplete", G.coverageCompletion({ sawComplete: false, wpReached: 9, wpTotal: 11, hasRtl: true }).covComplete === true); // lastCoverageSeq=9, wr/9=1.0
check("completion: 50% → not complete", G.coverageCompletion({ sawComplete: false, wpReached: 5, wpTotal: 21, hasRtl: true }).covComplete === false); // last=19, 5/19≈0.26
check("completion: pct rounds", G.coverageCompletion({ sawComplete: false, wpReached: 10, wpTotal: 21, hasRtl: true }).completionPct === 53); // 10/19=0.526→53

// coveredHa: complete → area_ha; partial → dist*swath/1e4 capped; no swath → null.
check("coveredHa: complete → area_ha", G.coveredHa({ covComplete: true, areaHa: 12.5, swathM: 20, distM: 999 }) === 12.5);
check("coveredHa: partial = dist*swath/1e4", near(G.coveredHa({ covComplete: false, areaHa: 100, swathM: 20, distM: 5000 }), 10, 1e-6)); // 5000*20/1e4=10
check("coveredHa: partial capped at area_ha", G.coveredHa({ covComplete: false, areaHa: 3, swathM: 20, distM: 5000 }) === 3);
check("coveredHa: no swath → null", G.coveredHa({ covComplete: false, areaHa: 100, swathM: 0, distM: 5000 }) === null);

console.log("\nRESULT: " + (failed ? `${failed} FAILURE(S)` : "ALL CHECKS PASSED"));
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Запустити — має ПАДАТИ (модуля ще нема)**

Run: `cd ~/projects/ardu-field-planner && node test_geocover.mjs`
Expected: FAIL — `Error: ENOENT ... web-stable/geo-cover.js`

- [ ] **Step 3: Створити `web-stable/geo-cover.js`**

```js
/* Pure covered-area geometry, shared by app.js (window.GEO_COVER) and test_geocover.mjs.
 * NO DOM. Ring vertices are {lat,lng} (Leaflet field ring); telemetry samples are {lat,lon}. */
(function (global) {
  "use strict";
  const R = 6371000;                       // mean Earth radius, metres
  function haversineM(aLat, aLon, bLat, bLon) {
    const rad = Math.PI / 180;
    const dLat = (bLat - aLat) * rad, dLon = (bLon - aLon) * rad;
    const la1 = aLat * rad, la2 = bLat * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  // Ray-cast point-in-polygon. lon is the sample's X; ring vertices read .lng as X, .lat as Y.
  function pointInRing(lat, lon, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const yi = ring[i].lat, xi = ring[i].lng, yj = ring[j].lat, xj = ring[j].lng;
      const hit = ((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi);
      if (hit) inside = !inside;
    }
    return inside;
  }
  // Sum of track-segment lengths whose BOTH endpoints lie inside the ring. null ring (<3) → null.
  function distInField(samples, ring) {
    if (!ring || ring.length < 3) return null;
    let d = 0;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1], b = samples[i];
      if (a.lat == null || b.lat == null) continue;
      if (pointInRing(a.lat, a.lon, ring) && pointInRing(b.lat, b.lon, ring)) {
        d += haversineM(a.lat, a.lon, b.lat, b.lon);
      }
    }
    return d;
  }
  // Mission-completion decision (spec §8). lastCoverageSeq excludes lead + trailing RTL.
  function coverageCompletion(o) {
    const wt = o.wpTotal || 0, wr = o.wpReached || 0;
    const lastCoverageSeq = wt - 1 - (o.hasRtl ? 1 : 0);
    const compFrac = lastCoverageSeq > 0 ? Math.min(1, wr / lastCoverageSeq) : 0;
    const covComplete = !!o.sawComplete || (lastCoverageSeq > 0 && wr >= lastCoverageSeq) || compFrac >= 0.90;
    return { covComplete: covComplete, compFrac: compFrac, completionPct: Math.round(compFrac * 100) };
  }
  // covered_ha: complete → the planned field area; partial → distance × swath, capped at area.
  function coveredHa(o) {
    if (o.covComplete) return o.areaHa || 0;
    if (!o.swathM || o.swathM <= 0) return null;         // unknown swath → «—», never divide/zero
    const d = o.distM == null ? 0 : o.distM;
    const raw = d * o.swathM / 1e4;
    return o.areaHa > 0 ? Math.min(raw, o.areaHa) : raw;  // cap at field area when known
  }
  global.GEO_COVER = { haversineM, pointInRing, distInField, coveredHa, coverageCompletion };
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 4: Запустити — має пройти**

Run: `node test_geocover.mjs`
Expected: `RESULT: ALL CHECKS PASSED`

- [ ] **Step 5: Commit**

```bash
git add web-stable/geo-cover.js test_geocover.mjs
git commit -m "feat(geo-cover): pure covered-area module (pointInRing/distInField/coveredHa) + unit tests"
```

---

### Task 2: Підключити `geo-cover.js` (сторінка + offline-кеш + APK-асети)

**Files:**
- Modify: `web-stable/index.html` (script tag before app.js)
- Modify: `web-stable/sw.js` (SHELL cache list)
- Copy: `android/app/src/main/assets/geo-cover.js` (APK offline)

**Interfaces:**
- Consumes: `web-stable/geo-cover.js` (Task 1).
- Produces: `window.GEO_COVER` available before `app.js` runs, online AND offline, in PWA AND APK.

- [ ] **Step 1: Знайти, як `app.js` підключається в `index.html`**

Run: `grep -n 'script.*src=.*app.js\|script.*src=.*mav/' web-stable/index.html`
Expected: показує `<script src="mav/...">` та `<script src="app.js">` (порядок завантаження).

- [ ] **Step 2: Додати script-тег ПЕРЕД app.js**

У `web-stable/index.html`, безпосередньо перед рядком `<script src="app.js"></script>` (і після mav-скриптів), додати:
```html
    <script src="geo-cover.js"></script>
```

- [ ] **Step 3: Додати у SHELL-кеш `sw.js`**

У `web-stable/sw.js` у масиві `const SHELL = [ ... ]` додати `"geo-cover.js"` поряд з `"app.js"`:
```js
  "./", "index.html", "app.js", "geo-cover.js", "vendor/clipper.min.js", "sw-register.js", "style.css", "manifest.json",
```
І підняти версію кешу: `const SHELL_CACHE = "fmp-shell-v106";` (було v105).

- [ ] **Step 4: Скопіювати в APK-асети**

Run: `cp web-stable/geo-cover.js android/app/src/main/assets/geo-cover.js && ls -l android/app/src/main/assets/geo-cover.js`
Expected: файл існує (WebViewAssetLoader віддасть його офлайн з APK).

- [ ] **Step 5: Перевірити, що сторінка парситься і GEO_COVER підхоплюється**

Run: `node --check web-stable/geo-cover.js && node -e "const fs=require('fs'),vm=require('vm');const c={window:{}};vm.createContext(c);vm.runInContext(fs.readFileSync('web-stable/geo-cover.js','utf8'),c);console.log('GEO_COVER keys:',Object.keys(c.window.GEO_COVER).join(','))"`
Expected: `GEO_COVER keys: haversineM,pointInRing,distInField,coveredHa,coverageCompletion`

- [ ] **Step 6: Commit**

```bash
git add web-stable/index.html web-stable/sw.js android/app/src/main/assets/geo-cover.js
git commit -m "build: load geo-cover.js in page + offline shell cache (v106) + APK assets"
```

---

### Task 3: Персистити covered-area входи — `lastWorkContext` + `swath_m` + `boundary`

**Files:**
- Modify: `web-stable/app.js:824-827` and `web-stable/app.js:1097-1100`

**Interfaces:**
- Consumes: `$("spacing")`, the in-scope `boundary` at each site.
- Produces: `lastWorkContext.swath_m` (число) + `lastWorkContext.boundary` (ring `[{lat,lng}]` або null) — читаються у `flightRecFinalize` (Task 5).

- [ ] **Step 1: Підтвердити, що `boundary` в області видимості обох сайтів**

Run: `sed -n '815,830p;1090,1101p' web-stable/app.js | grep -n boundary`
Expected: `boundary` присутній у кожному блоці (spec: in-scope з `:1026`). Якщо в якомусь блоці змінна зветься інакше — використати наявну назву ring-полігону там.

- [ ] **Step 2: Додати два поля в ОБИДВА блоки `lastWorkContext`**

Блок 1 (`app.js:826-827`) — замінити:
```js
      lastWorkContext = { field: currentFieldName || "поле", area_ha: res.area_ha || 0,
        sprayed_ha: res.sprayed_ha || 0, liquid_l: res.liquid_l || 0, sections: res.flights || 1 };
```
на:
```js
      lastWorkContext = { field: currentFieldName || "поле", area_ha: res.area_ha || 0,
        sprayed_ha: res.sprayed_ha || 0, liquid_l: res.liquid_l || 0, sections: res.flights || 1,
        swath_m: parseFloat($("spacing").value) || 0, boundary: (typeof boundary !== "undefined" ? boundary : null) };
```
Блок 2 (`app.js:1099-1100`) — те саме перетворення для другого ідентичного літерала.

- [ ] **Step 3: Перевірка**

Run: `node --check web-stable/app.js && python3 test_ui.py >/dev/null 2>&1 && echo OK`
Expected: `OK` (парситься, id-крос-чек зелений).

- [ ] **Step 4: Commit**

```bash
git add web-stable/app.js
git commit -m "feat(work-context): persist swath_m + field boundary for covered-area"
```

---

### Task 4: `flightRecTick` — трекати `wp_reached`

**Files:**
- Modify: `web-stable/app.js` (`flightRec` init + tick, ~3220-3252)

**Interfaces:**
- Produces: `flightRec.wp_reached` (макс досягнутий waypoint) — вхід у completion (Task 5).

- [ ] **Step 1: Додати `wp_reached:0` в init**

У `flightRecTick`, в об'єкт `flightRec = { ... }`, додати `wp_reached: 0,` (поряд з `sawComplete: false`):
```js
          samples: [], sawComplete: false, wp_reached: 0, wp_total: s.wp_total || 0, _last: 0 };
```

- [ ] **Step 2: Оновлювати `wp_reached` на кожному тіку**

Одразу ПІСЛЯ рядка `if (s.wp_total && s.wp_current != null && s.wp_current >= s.wp_total - 1) flightRec.sawComplete = true;` додати:
```js
    if (s.wp_current != null) flightRec.wp_reached = Math.max(flightRec.wp_reached, s.wp_current);
```

- [ ] **Step 3: Перевірка**

Run: `node --check web-stable/app.js && echo OK`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add web-stable/app.js
git commit -m "feat(flightlog): track wp_reached (max waypoint) for completion %"
```

---

### Task 5: `flightRecFinalize` — covered_ha / completion_pct / avg_speed + `flogTrim`

**Files:**
- Modify: `web-stable/app.js` (`flightRecFinalize` ~3264-3285; add `flogTrim` + `FLOG_MAX_FLIGHTS` ~3225)

**Interfaces:**
- Consumes: `window.GEO_COVER`, `flightRec.{wp_reached, sawComplete, wp_total, work, samples}`, module `flownHasRtl` (from Phase 1), `_sampleDist`, `flogAll`/`flogOpen`.
- Produces: `rec.actual.{covered_ha, completion_pct, avg_speed_ms, swath_m}`; capped flight log via `flogTrim`.

- [ ] **Step 1: Додати `FLOG_MAX_FLIGHTS` + `flogTrim` (біля `flogSummary`, ~app.js:3222)**

```js
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
```

- [ ] **Step 2: Обчислити covered-area у `flightRecFinalize` (перед `const rec = {`)**

Одразу перед `const rec = {` у `flightRecFinalize` додати:
```js
    const wp_total = fr.wp_total || 0;
    const comp = window.GEO_COVER.coverageCompletion({
      sawComplete: fr.sawComplete, wpReached: fr.wp_reached || 0, wpTotal: wp_total, hasRtl: flownHasRtl });
    const ring = (fr.work && fr.work.boundary) || null;
    let distM = window.GEO_COVER.distInField(fr.samples, ring);
    if (distM == null) distM = _sampleDist(fr.samples);   // no ring → whole track (still capped)
    const swath_m = (fr.work && fr.work.swath_m) || 0;
    const covered_ha = window.GEO_COVER.coveredHa({
      covComplete: comp.covComplete, areaHa: (fr.work && fr.work.area_ha) || 0, swathM: swath_m, distM: distM });
    const avg_speed_ms = actual_duration > 0 ? (_sampleDist(fr.samples) / actual_duration) : null;
```

- [ ] **Step 3: Розширити `rec.actual` цими полями**

У об'єкті `rec`, у під-об'єкті `actual`, додати три поля після `distance_m`:
```js
      actual: { duration_s: Math.round(actual_duration),
        battery_used_pct: (battery_used != null ? Math.round(battery_used) : null),
        distance_m: Math.round(_sampleDist(fr.samples)),
        covered_ha: (covered_ha != null ? Math.round(covered_ha * 100) / 100 : null),
        completion_pct: comp.completionPct,
        avg_speed_ms: (avg_speed_ms != null ? Math.round(avg_speed_ms * 10) / 10 : null),
        swath_m: swath_m || null },
```

- [ ] **Step 4: Тримати журнал в межах — виклик `flogTrim` після `flogPut`**

Одразу після `await flogPut(rec);` додати:
```js
    await flogTrim(FLOG_MAX_FLIGHTS);
```

*(Дроп `rec.samples` за `KEEP_SAMPLES`-гейтом — свідомо ВІДКЛАДЕНО в Phase 2B/§5, бо #8 ще читатиме поля, а трек-даунсемпл потребує окремого рішення. У 2A семпли лишаються — covered_ha уже пораховано над ними до збереження.)*

- [ ] **Step 5: Перевірка**

Run: `node --check web-stable/app.js && node test_geocover.mjs >/dev/null 2>&1 && echo OK`
Expected: `OK` (covered-area математика — під Node-тестом Task 1; тут перевіряємо синтаксис + що модуль цілий).

- [ ] **Step 6: Commit**

```bash
git add web-stable/app.js
git commit -m "feat(flightlog): compute covered_ha/completion_pct/avg_speed on finalize + cap log (300)"
```

---

### Task 6: `fldPut`-on-upload (UPSERT) + мінт «Поле N» once

**Files:**
- Modify: `web-stable/app.js` (new `promoteFieldOnUpload`; call it in `mavUpload` success ~3642 and `resumeUploadRemainder` ~3701)

**Interfaces:**
- Consumes: `boundaryFromPolygon`, `collectParams`, `collectExclusions`, `fldAll`, `fldPut`, `lpAll`, `lpSave`, `lastFieldAreaHa`, `currentFieldName`.
- Produces: залитий контур → named-record у `fmp_fields`; `currentFieldName` присвоєно (для наступних UPSERT).

- [ ] **Step 1: Додати `promoteFieldOnUpload` (біля `#save-project` handler, ~app.js:1888)**

```js
  // On upload: promote the current contour to a persistent named record (the promise at
  // app.js: "Автозбереження — при заливці в дрон"). UPSERT by name so a re-upload of the same
  // field updates rather than duplicates; a freshly-drawn (unnamed) field mints "Поле N" ONCE
  // and adopts that name so subsequent uploads hit the same record.
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
    const prev = (recs || []).find((r) => r.name === name);
    const now = Date.now();
    const rec = { name, field, params: collectParams(), exclusions: collectExclusions(),
      created: (prev && prev.created) || now, updated: now, area_ha: lastFieldAreaHa || 0, uploaded_at: now };
    const ok = useLp ? false : await fldPut(rec);
    if (!ok) { try { lpSave(name, rec); } catch (e) {} }
    try { localStorage.setItem("fmp_current_field", name); } catch (e) {}   // for boot restore (Task 7)
    appLog("field promoted on upload: «" + name + "» (upsert)");
  }
```

- [ ] **Step 2: Викликати в `mavUpload` success-гілці**

У `mavUpload`, одразу після `scheduleSaveField();` (в `if (r && r.ok) {`), додати:
```js
        promoteFieldOnUpload();     // залитий контур → постійний named-record (UPSERT)
```

- [ ] **Step 3: Викликати в `resumeUploadRemainder` success**

У `resumeUploadRemainder`, після успіху заливки залишку (де вже є `flownSave(rem.rest);`), додати:
```js
      promoteFieldOnUpload();
```

- [ ] **Step 4: Перевірка**

Run: `node --check web-stable/app.js && python3 test_ui.py >/dev/null 2>&1 && echo OK`
Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add web-stable/app.js
git commit -m "feat(field): auto-save contour to named store on upload (UPSERT, mint 'Поле N' once)"
```

---

### Task 7: Відновлювати `currentFieldName` на буті

**Files:**
- Modify: `web-stable/app.js` (boot restore block, after `restoreLastField()` ~1354; and the `beforeunload` handler ~1345)

**Interfaces:**
- Consumes: `localStorage fmp_current_field` (written by Task 6 + here on unload).
- Produces: `currentFieldName` survives reopen → `#5 rec.field` and later `#3 setMission` no longer fall back to generic «поле».

- [ ] **Step 1: Персистити `currentFieldName` на unload**

У `beforeunload`-хендлері (`app.js:1345`), розширити:
```js
  window.addEventListener("beforeunload", () => { saveLastSettings(); saveLastField(); });
```
на:
```js
  window.addEventListener("beforeunload", () => {
    saveLastSettings(); saveLastField();
    try { localStorage.setItem("fmp_current_field", currentFieldName || ""); } catch (e) {}
  });
```

- [ ] **Step 2: Відновити на буті (одразу після `restoreLastRoute(_routeSnap);`)**

У deferred boot-блоці, всередині `try { restoreLastField(); restoreLastRoute(_routeSnap); }`, додати третім рядком перед `}`:
```js
      restoreLastField();          // контур + вирізи
      restoreLastRoute(_routeSnap); // маршрут — зі знімка
      try { const _cf = localStorage.getItem("fmp_current_field"); if (_cf) currentFieldName = _cf; } catch (e) {}
```

- [ ] **Step 3: Перевірка**

Run: `node --check web-stable/app.js && echo OK`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add web-stable/app.js
git commit -m "feat(persist): restore currentFieldName on boot (field identity survives reopen)"
```

---

### Task 8: Вкладка «Статистика» — HTML + перемикач

**Files:**
- Modify: `web-stable/index.html` (4-та `.tab` + `#tab-stats` pane)
- Modify: `web-stable/app.js` (tab-handler викликає `renderFlightStats`)

**Interfaces:**
- Produces: `#tab-stats` pane containing `#flight-stats`; `renderFlightStats()` called on tab open.
- Consumes (Task 9): `renderFlightStats` (defined next task — this task references it; keep tasks ordered, but the function is added in Task 9).

- [ ] **Step 1: Додати 4-ту кнопку в `.tabs` (`index.html:40-44`)**

```html
      <div class="tabs">
        <button class="tab active" data-tab="plan">План</button>
        <button class="tab" data-tab="fly">Політ</button>
        <button class="tab" data-tab="stats">Статистика</button>
        <button class="tab" data-tab="app" id="tab-btn-app">Додаток</button>
      </div>
```

- [ ] **Step 2: Додати пейн `#tab-stats` (після закриття `#tab-fly`, `index.html:242`)**

Одразу після рядка `</div><!-- /tab-fly -->` додати:
```html
      <div id="tab-stats" class="tab-pane">
        <div class="step">Статистика польотів</div>
        <div id="flight-stats"></div>
      </div><!-- /tab-stats -->
```

- [ ] **Step 3: Викликати `renderFlightStats` у tab-handler (`app.js:1251-1256`)**

Всередині `.tab` click-listener, після рядка з `p.classList.toggle("active", p.id === "tab-" + name);`, додати:
```js
      if (name === "stats" && typeof renderFlightStats === "function") renderFlightStats();
```

- [ ] **Step 4: Перевірка (id-крос-чек має лишитись зеленим; `flight-stats` тепер оголошено)**

Run: `python3 test_ui.py 2>&1 | tail -2`
Expected: `RESULT: ALL CHECKS PASSED`

- [ ] **Step 5: Commit**

```bash
git add web-stable/index.html web-stable/app.js
git commit -m "feat(stats): add Статистика tab + pane, render on open"
```

---

### Task 9: `renderFlightStats` — таблиця + підсумки + Га/хв + фільтр + сумарна площа

**Files:**
- Modify: `web-stable/app.js` (new `renderFlightStats` + helpers `_statsRangeFloor`, `_haPerMin`, `statsRange`, near `flogAll` ~3222)

**Interfaces:**
- Consumes: `flogAll`, `esc`, `t`, `tf`, `LANG`.
- Produces: renders into `#flight-stats`; delegated period-filter handler on the stable `#tab-stats`.

- [ ] **Step 1: Додати стан + чисті хелпери (біля `flogAll`, ~app.js:3222)**

```js
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
```

- [ ] **Step 2: Додати `renderFlightStats`**

```js
  async function renderFlightStats() {
    const host = $("flight-stats"); if (!host) return;
    const rows = (await flogAll())
      .filter((r) => r.started_at >= _statsRangeFloor(statsRange))
      .sort((a, b) => b.started_at - a.started_at);
    // period chips (always visible, even on an empty period)
    const chip = (r, lbl) => `<button class="chip${statsRange === r ? " active" : ""}" data-range="${r}" aria-pressed="${statsRange === r}">${t(lbl)}</button>`;
    let html = `<div class="stats-chips">${chip("hour", "з початку години")}${chip("day", "з початку дня")}${chip("all", "усе")}</div>`;
    if (!rows.length) {
      host.innerHTML = html + `<div class="msg">${t("Немає польотів за обраний період.")}</div>`;
      _bindStatsChips(); return;
    }
    // aggregates
    let secTot = 0, distTot = 0, covTot = 0, covDurMin = 0;
    rows.forEach((r) => {
      const ac = r.actual || {};
      secTot += ac.duration_s || 0; distTot += ac.distance_m || 0;
      if (ac.covered_ha != null) { covTot += ac.covered_ha; covDurMin += (ac.duration_s || 0) / 60; }
    });
    const avgHaMin = covDurMin > 0 ? covTot / covDurMin : null;
    const tile = (label, val, cls) => `<div class="stat-tile${cls ? " " + cls : ""}"><div class="sv">${val}</div><div class="sl">${t(label)}</div></div>`;
    const num = (n, d) => (n == null ? "—" : (LANG === "en" ? n.toFixed(d) : String(Math.round(n * 10 ** d) / 10 ** d)));
    html += `<div class="stats-totals">
      ${tile("Польотів", rows.length)}
      ${tile("Годин", num(secTot / 3600, 1))}
      ${tile("Кілометрів", num(distTot / 1000, 1))}
      ${tile("Покрито", num(covTot, 1), "headline")}
      ${tile("Сер. Га/хв", num(avgHaMin, 2))}
    </div>`;
    // per-flight table
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
  function _bindStatsChips() {
    const pane = $("tab-stats"); if (!pane || pane._statsBound) return;
    pane._statsBound = true;                       // bind ONCE on the stable pane (host innerHTML is replaced)
    pane.addEventListener("click", (e) => {
      const b = e.target.closest("[data-range]"); if (!b) return;
      statsRange = b.getAttribute("data-range"); renderFlightStats();
    });
  }
```

- [ ] **Step 3: Мінімальний CSS для плиток/чипів/таблиці (у `style.css`, у кінець)**

```css
.stats-chips { display: flex; gap: 6px; margin: 6px 0 10px; }
.chip { padding: 4px 10px; border: 1px solid #2a3340; border-radius: 14px; background: #121820; color: var(--text-dim); font-size: 12px; cursor: pointer; }
.chip.active { color: var(--ok); border-color: #285644; background: #10201a; }
.stats-totals { display: grid; grid-template-columns: repeat(auto-fit, minmax(88px, 1fr)); gap: 8px; margin-bottom: 12px; }
.stat-tile { background: #121820; border: 1px solid #202a36; border-radius: 8px; padding: 8px; text-align: center; }
.stat-tile .sv { font-size: 18px; font-weight: 600; color: var(--text); }
.stat-tile.headline .sv { font-size: 22px; color: var(--ok); }
.stat-tile .sl { font-size: 10.5px; color: var(--text-dim); margin-top: 2px; }
.stats-table-wrap { overflow-x: auto; }
.stats-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.stats-table th, .stats-table td { padding: 5px 7px; border-bottom: 1px solid #1b2430; text-align: right; white-space: nowrap; }
.stats-table th:first-child, .stats-table td:first-child, .stats-table th:nth-child(2), .stats-table td:nth-child(2) { text-align: left; }
```

- [ ] **Step 4: Перевірка (парс + id-крос-чек)**

Run: `node --check web-stable/app.js && python3 test_ui.py 2>&1 | tail -2`
Expected: парситься; `RESULT: ALL CHECKS PASSED`.

- [ ] **Step 5: Commit**

```bash
git add web-stable/app.js web-stable/style.css
git commit -m "feat(stats): per-flight table + totals + Га/хв + period filter (hour/day/all) + summed area"
```

---

### Task 10: i18n — англійські ключі для всіх нових рядків

**Files:**
- Modify: `web-stable/i18n.js` (append an `Object.assign(window.FMP_TR, {…})` block)

**Interfaces:**
- Consumes: `window.FMP_TR` (existing).
- Produces: EN translations for the stats UI so `t()` resolves them in EN mode.

- [ ] **Step 1: Додати блок у кінець `i18n.js`**

```js
Object.assign(window.FMP_TR, {
  "Статистика": "Statistics",
  "Статистика польотів": "Flight statistics",
  "Польотів": "Flights",
  "Годин": "Hours",
  "Кілометрів": "Kilometres",
  "Покрито": "Covered",
  "Сер. Га/хв": "Avg ha/min",
  "Га/хв": "ha/min",
  "Дата": "Date",
  "Поле": "Field",
  "Відстань": "Distance",
  "Час": "Time",
  "Батарея": "Battery",
  "Сер. швидкість": "Avg speed",
  "з початку години": "This hour",
  "з початку дня": "Today",
  "усе": "All",
  "Немає польотів за обраний період.": "No flights in the selected period.",
});
```

- [ ] **Step 2: Перевірка — ключі валідні JS і покривають рядки з Task 9**

Run: `node --check web-stable/i18n.js && node -e "global.window={};require('./web-stable/i18n.js');const need=['Статистика','Покрито','Га/хв','з початку години','Немає польотів за обраний період.'];const miss=need.filter(k=>!(k in window.FMP_TR));console.log(miss.length?('MISSING: '+miss.join(', ')):'all stats keys present')"`
Expected: `all stats keys present`

- [ ] **Step 3: Commit**

```bash
git add web-stable/i18n.js
git commit -m "i18n: EN keys for the Статистика tab (totals, columns, period filter)"
```

---

## Self-Review

**Spec coverage:**
- §4.4 (#4 контур): UPSERT-on-upload + мінт-once + `currentFieldName` restore ✓(T6,T7). `fieldId`-ідентичність спрощено до `name` (немає rename-UI — назва стабільна; contour-hash відкладено, зафіксовано в Global Constraints).
- §4.5 (#5 статистика): tab+pane ✓(T8), `renderFlightStats`+totals ✓(T9), `flogTrim`/`FLOG_MAX_FLIGHTS` ✓(T5), i18n ✓(T10). `wp_reached` ✓(T4), `swath_m`/`boundary` ✓(T3). Дроп семплів (`KEEP_SAMPLES`) — свідомо відкладено (нотатка в T5), бо #8 читатиме поля. Native-реконсиляція (background-hole) — форвард-хук у Phase 4/6 (native ще нема в 2A).
- §8 (covered-area): `coverageCompletion`+`coveredHa`+`distInField`+{lat,lon}-контракт ✓(T1, Node-юніт-тести), guards (swath falsy→null, cap area_ha, if/else взаємовиключність) ✓.
- §B.5 (#5-additions): Га/хв ✓, фільтр год/день/усе ✓, сумарна площа (headline tile) ✓ (T9).

**Placeholder scan:** без TODO/TBD; кожен крок — реальний код/команда/очікуваний вихід. Відкладені пункти (KEEP_SAMPLES drop, native-реконсиляція, fieldId-hash) явно позначені як out-of-2A з причиною, не заглушки.

**Type consistency:** `GEO_COVER.{pointInRing(lat,lon,ring),distInField(samples,ring),coverageCompletion({sawComplete,wpReached,wpTotal,hasRtl}),coveredHa({covComplete,areaHa,swathM,distM})}` — визначено T1, спожито T5. `lastWorkContext.{swath_m,boundary}` — записано T3, прочитано T5. `flightRec.wp_reached` — T4→T5. `rec.actual.{covered_ha,completion_pct,avg_speed_ms,swath_m}` — записано T5, прочитано T9. `statsRange`/`_statsRangeFloor`/`_haPerMin` — T9. `promoteFieldOnUpload` — T6, використовує наявні `fldAll`/`fldPut`/`lpAll`/`lpSave` (перевірені імена).

**Out of 2A → Plan 2B:** #8 прогрес по контуру (`done_ha`/`remaining`/`completed_count` на field-record — спирається на `fieldId` з T6 + covered-area з T5); опційний drop/downsample семплів.
