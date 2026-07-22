# Phase 1 — Верифікація місії читанням (#1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** «Залити місію» доводить, що дрон тримає САМЕ намальовану геометрію (не лише правильну кількість точок), з трьома чесними станами вердикту — VERIFIED / MISMATCH / VERIFY-INCOMPLETE — і жоден слабкий лінк не показує успішну заливку зеленим хибно.

**Architecture:** Уся логіка verify живе у `web-stable/mav/link.js` (порівняння `downloadMission`→`verifyMission`); `web-stable/app.js` лише обирає політику (FULL за замовчуванням) і рендерить три-станний вердикт. Польовий пристрій = in-browser jsMav шлях; desktop `/api` — окрема реалізація, ПОЗА скоупом.

**Tech Stack:** Vanilla JS (ES2019 IIFE), MAVLink v1/v2 codec (`web-stable/mav/mavlink.js` + `specs.json`), Node 18+ headless loopback тест (`test_jsmav.mjs`), Python id-крос-чек (`test_ui.py`).

## Global Constraints

- **Скоуп — лише in-browser jsMav** (`web-stable/mav/link.js` + `web-stable/app.js`). Desktop `/api/mav_upload_mission` (`app.js:1009`) — ПОЗА скоупом (bench/SITL only).
- **Не ламати ні ArduPilot, ні INAV.** INAV відповідає лише legacy `MISSION_REQUEST` (немає `_INT`-хендлера); ArduPilot — обидва. INAV seq 0 = перший waypoint (координати ВЕРИФІКУЮТЬСЯ); ArduPilot seq 0 = home (координати пропускаються).
- **Тримати наявні гейти толерантності** без змін: координати `> 100` одиниць (1e-7°, ≈1.1 м), висота `> 1.0` м, frame-еквіваленти `{3,6}` і `{0,5}`. Це поглинає float32-округлення v1-діалекту (~0.5 м).
- **Три стани вердикту:** VERIFIED (green, `v.ok && v.verified`) / MISMATCH (red, `v.ok && !v.verified`) / VERIFY-INCOMPLETE (amber, `v && !v.ok`). Успішна заливка (`MISSION_ACK` отримано) → `res.ok` ЗАВЖДИ лишається `true`; flaky verify → amber, **ніколи red і ніколи хибно-green**.
- **ELRS-tolerant:** default-full ~подвоює pre-flight трансфер — це навмисне (безпечніше), з informed opt-out `#mav-verify-fast` (count-only).
- **Тести:** `node test_jsmav.mjs` (link.js), `python3 test_ui.py` (id-крос-чек). Кожен таск закінчується зеленим тестом. Часті коміти.

---

### Task 0: Полагодити шлях JS-тест-харнеса (`web` → `web-stable`)

**Files:**
- Modify: `test_jsmav.mjs:47` (`MAVDIR`)

**Interfaces:**
- Produces: робочий `node test_jsmav.mjs`, що вантажить КАНОНІЧНИЙ `web-stable/mav/*.js` (усі наступні таски його розширюють).

`web/mav/` не існує (репо перейшло на `web-stable/`), тож харнес зараз падає з ENOENT. Це блокер для будь-якого link.js-тесту.

- [ ] **Step 1: Побачити, що харнес зараз не запускається**

Run: `cd ~/projects/ardu-field-planner && node test_jsmav.mjs`
Expected: FAIL — `Error: ENOENT ... web/mav/mavlink.js`

- [ ] **Step 2: Виправити шлях завантаження**

У `test_jsmav.mjs` рядок 47:
```js
const MAVDIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "web", "mav");
```
замінити на:
```js
const MAVDIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "web-stable", "mav");
```

- [ ] **Step 3: Запустити — наявні перевірки мають пройти**

Run: `node test_jsmav.mjs`
Expected: `RESULT: ALL CHECKS PASSED` (upload happy/slow/retransmit/high-latency + streams self-heal)

- [ ] **Step 4: Commit**

```bash
git add test_jsmav.mjs
git commit -m "test(jsmav): load canonical web-stable/mav (web/mav no longer exists)"
```

---

### Task 1: `downloadMission` — legacy-діалект для невідомого autopilot

**Files:**
- Modify: `web-stable/mav/link.js:579`
- Test: `test_jsmav.mjs` (додати `makeMissionVehicle` + тест readback-діалекту)

**Interfaces:**
- Consumes: `MAV_LINK.MavLink`, `MAV_LINK.buildMissionItems`, `MAVLINK.encode/createParser` (наявні).
- Produces: `makeMissionVehicle(stored, opts)` — фейковий дрон, що зберігає місію й віддає її на download; `opts.legacyOnly` ігнорує `MISSION_REQUEST_INT`.

**Корінь:** `link.js:579` шле `MISSION_REQUEST_INT` коли `autopilot == null` (bridge/backpack ще не розкрив автопілот) — але lossy legacy-only приймач (INAV, деякі мости) його не розуміє → readback таймаутить → хибний AMBER/mismatch. Дефолт має бути **legacy** (його розуміють ВСІ).

- [ ] **Step 1: Додати фейковий дрон із збереженою місією (у `test_jsmav.mjs`, після `makeVehicle` ~рядок 76)**

```js
// Fake vehicle that STORES a mission and serves it for download/verify.
//   stored: [{seq,command,frame,x,y,z}] — x,y are int32 1e-7°, z is metres.
//   opts.legacyOnly: answer ONLY MISSION_REQUEST (ignore MISSION_REQUEST_INT) — INAV / bridge dialect
//   opts.itemDelay:  ms before answering each item request (slow RF link)
function makeMissionVehicle(stored, opts = {}) {
  const veh = MAVLINK.createParser();
  const t = { ondata: null, close() {} };
  const send = (name, fields) => { const b = MAVLINK.encode(name, fields, { sys: 1, comp: 1, seq: 0 }); if (t.ondata) t.ondata(b); };
  const sendItem = (seq) => {
    const it = stored[seq]; if (!it) return;
    send("MISSION_ITEM_INT", { target_system: 255, target_component: 0, seq, frame: it.frame, command: it.command,
      current: 0, autocontinue: 1, param1: 0, param2: 0, param3: 0, param4: 0, x: it.x, y: it.y, z: it.z, mission_type: 0 });
  };
  t.write = (bytes) => {
    for (const m of veh.push(bytes)) {
      if (m.name === "MISSION_REQUEST_LIST") {
        send("MISSION_COUNT", { target_system: 255, target_component: 0, count: stored.length, mission_type: 0 });
      } else if (m.name === "MISSION_REQUEST_INT") {
        if (opts.legacyOnly) continue;            // legacy-only приймач не має _INT-хендлера
        const seq = m.fields.seq; opts.itemDelay ? setTimeout(() => sendItem(seq), opts.itemDelay) : sendItem(seq);
      } else if (m.name === "MISSION_REQUEST") {
        const seq = m.fields.seq; opts.itemDelay ? setTimeout(() => sendItem(seq), opts.itemDelay) : sendItem(seq);
      }
    }
  };
  const hb = setInterval(() => send("HEARTBEAT", { type: 2, autopilot: 3, base_mode: 0, custom_mode: 4, system_status: 3, mavlink_version: 3 }), 200);
  t._stopHb = () => clearInterval(hb);
  return t;
}
// Convert built (lat/lon/alt) items → stored MISSION_ITEM_INT field objects.
const toStored = (exp) => exp.map((e) => ({ seq: e.seq, command: e.command, frame: e.frame, x: Math.round(e.lat * 1e7), y: Math.round(e.lon * 1e7), z: e.alt }));
```

- [ ] **Step 2: Написати падаючий тест (додати наприкінці `test_jsmav.mjs`, ПЕРЕД `RESULT`-рядком)**

```js
console.log("\n== readback dialect: unknown autopilot must use legacy MISSION_REQUEST ==");
{
  const exp = MAV_LINK.buildMissionItems([49.49, 24.0, 0], 30, wps, 30, true, 7);
  const t = makeMissionVehicle(toStored(exp), { legacyOnly: true });   // vehicle only answers legacy REQUEST
  const link = new MAV_LINK.MavLink();
  await link.connect(t);
  t._stopHb();                        // stop heartbeats so the override below survives
  link._tlm.autopilot = null;         // simulate a bridge that forwards but never revealed the autopilot
  const dl = await link.downloadMission(3000);
  check("[dialect] download completed over legacy-only link", dl.ok === true);
  check("[dialect] read back all items", dl.ok && dl.count === exp.length);
  link.disconnect();
}
```

- [ ] **Step 3: Запустити — має ПАДАТИ (поточний код шле `_INT`)**

Run: `node test_jsmav.mjs`
Expected: FAIL — `[dialect] download completed over legacy-only link` (поточний `autopilot == null` → `_INT` → legacy-only дрон мовчить → таймаут).

- [ ] **Step 4: Виправити діалект (`link.js:579`)**

```js
const reqT = (this._tlm.autopilot == null || this._tlm.autopilot === 3) ? "MISSION_REQUEST_INT" : "MISSION_REQUEST";
```
замінити на:
```js
// Unknown/bridge-only (autopilot == null) → LEGACY MISSION_REQUEST: it's the one
// dialect BOTH ArduPilot and INAV answer. INT is asked only when we KNOW it's ArduPilot.
const reqT = (this._tlm.autopilot === 3) ? "MISSION_REQUEST_INT" : "MISSION_REQUEST";
```

- [ ] **Step 5: Запустити — має пройти**

Run: `node test_jsmav.mjs`
Expected: `ALL CHECKS PASSED` (у т.ч. новий блок `[dialect]`).

- [ ] **Step 6: Commit**

```bash
git add test_jsmav.mjs web-stable/mav/link.js
git commit -m "fix(mav): readback uses legacy MISSION_REQUEST for unknown autopilot (INAV/bridge)"
```

---

### Task 2: `verifyMission` — метрова дельта з cos(lat) у повідомленні розбіжності

**Files:**
- Modify: `web-stable/mav/link.js:624`
- Test: `test_jsmav.mjs` (тест mismatch-повідомлення)

**Interfaces:**
- Consumes: `makeMissionVehicle`, `toStored` (Task 1).
- Produces: mismatch-рядок формату `#<seq>: координати розійшлись (~<N.N> м)`.

Пер-осьовий pass/fail-гейт (`> 100`) лишається БЕЗ ЗМІН (raw-одиниці). Змінюється лише текст повідомлення — оператор має бачити НАСКІЛЬКИ розійшлось; довготу масштабувати на `cos(lat)` (~0.66 на 49° N), інакше east-west дельту завищено ~1.5×.

- [ ] **Step 1: Написати падаючий тест (додати наприкінці `test_jsmav.mjs`)**

```js
console.log("\n== mismatch message carries a metre delta (cos-lat scaled) ==");
{
  const exp = MAV_LINK.buildMissionItems([49.49, 24.0, 0], 30, wps, 30, true, 7);
  const stored = toStored(exp);
  // shift ONE real waypoint east by ~5.5 m (500 units of 1e-7° lon) — well past the 1.1 m gate
  const wpIdx = stored.findIndex((s) => s.command === 16 && s.seq !== 0);
  stored[wpIdx].y += 500;
  const t = makeMissionVehicle(stored, {});
  const link = new MAV_LINK.MavLink();
  await link.connect(t);
  const v = await link.verifyMission(exp, 4000);
  check("[metres] verdict is a real mismatch", v.ok === true && v.verified === false);
  const line = (v.mismatches || []).find((s) => s.includes("координати"));
  check("[metres] coord mismatch names a metre delta", !!line && /~\d+(\.\d+)?\s*м/.test(line));
  link.disconnect(); t._stopHb();
}
```

- [ ] **Step 2: Запустити — має ПАДАТИ (поточне повідомлення без метрів)**

Run: `node test_jsmav.mjs`
Expected: FAIL — `[metres] coord mismatch names a metre delta` (поточний рядок = `координати розійшлись`, без `~N м`).

- [ ] **Step 3: Додати метрову дельту (`link.js:624`)**

```js
if (Math.abs(ex - a.x) > 100 || Math.abs(ey - a.y) > 100) mismatches.push(`#${e.seq}: координати розійшлись`);
```
замінити на:
```js
if (Math.abs(ex - a.x) > 100 || Math.abs(ey - a.y) > 100) {
  // metre magnitude for the operator: 1e-7° ≈ 1.113e-2 m; scale longitude by cos(lat)
  // (~0.66 at 49° N) or the east-west delta is overstated ~1.5×. Pass/fail gate above is unchanged.
  const dm = Math.hypot((ex - a.x) * 1.113e-2, (ey - a.y) * 1.113e-2 * Math.cos(e.lat * Math.PI / 180));
  mismatches.push(`#${e.seq}: координати розійшлись (~${dm.toFixed(1)} м)`);
}
```

- [ ] **Step 4: Запустити — має пройти**

Run: `node test_jsmav.mjs`
Expected: `ALL CHECKS PASSED`.

- [ ] **Step 5: Commit**

```bash
git add test_jsmav.mjs web-stable/mav/link.js
git commit -m "feat(mav): coord-mismatch message shows metre delta (cos-lat scaled)"
```

---

### Task 3: Окремий cap читання-назад (~60 с) → VERIFY-INCOMPLETE

**Files:**
- Modify: `web-stable/mav/link.js:552` (сигнатура `downloadMission`), `:573` (deadline), `:601` (виклик у `verifyMission`)
- Test: `test_jsmav.mjs` (повільний дрон + короткий cap)

**Interfaces:**
- Consumes: `makeMissionVehicle` (`opts.itemDelay`).
- Produces: `downloadMission(timeout, hardCapMs)` — необовʼязковий загальний дедлайн; `verifyMission` передає `timeout || 60000` як cap. Standalone-download (кнопка «Що залито в дрон») без args → незмінна 10-хв поведінка.

Verify не має успадковувати 10-хв дедлайн `downloadMission` із паузою потоків (HUD замерзне). Понад cap → `{ok:false}` → AMBER.

- [ ] **Step 1: Написати падаючий тест (додати наприкінці `test_jsmav.mjs`)**

```js
console.log("\n== verify has its own short cap → VERIFY-INCOMPLETE, not a 10-min hang ==");
{
  const exp = MAV_LINK.buildMissionItems([49.49, 24.0, 0], 30, wps, 30, true, 7);
  const t = makeMissionVehicle(toStored(exp), { itemDelay: 5000 });   // each item 5 s → can't finish in a short cap
  const link = new MAV_LINK.MavLink();
  await link.connect(t);
  const t0 = Date.now();
  const v = await link.verifyMission(exp, 800);                       // 800 ms cap for the test
  const dtMs = Date.now() - t0;
  check("[cap] verify returned incomplete (ok:false)", v.ok === false && v.verified === false);
  check("[cap] verify honoured the cap (< 3 s, not 10 min)", dtMs < 3000);
  link.disconnect(); t._stopHb();
}
```

- [ ] **Step 2: Запустити — має ПАДАТИ (немає загального cap → впирається у stall/10-хв)**

Run: `node test_jsmav.mjs`
Expected: FAIL — `[cap] verify honoured the cap` (поточний `deadline = +600000`, `stallMs` — 15 с; тест висить довше 3 с).

- [ ] **Step 3: Додати cap у `downloadMission`**

`link.js:552` — сигнатура:
```js
async downloadMission(timeout) {
```
→
```js
async downloadMission(timeout, hardCapMs) {
```
`link.js:573` — жорсткий дедлайн:
```js
const deadline = Date.now() + 600000;
```
→
```js
// Standalone "Що залито в дрон" keeps the generous 10-min ceiling; verify passes a
// short hardCapMs so a weak link yields VERIFY-INCOMPLETE instead of freezing the HUD.
const deadline = Date.now() + (hardCapMs || 600000);
```

- [ ] **Step 4: Прокинути cap із `verifyMission` (`link.js:601`)**

```js
const dl = await this.downloadMission(timeout);
```
→
```js
const dl = await this.downloadMission(timeout, timeout || 60000);
```

- [ ] **Step 5: Запустити — має пройти**

Run: `node test_jsmav.mjs`
Expected: `ALL CHECKS PASSED`.

- [ ] **Step 6: Commit**

```bash
git add test_jsmav.mjs web-stable/mav/link.js
git commit -m "fix(mav): verify read-back has its own ~60s cap → VERIFY-INCOMPLETE (no 10-min HUD freeze)"
```

---

### Task 4: `mav_upload_mission` — FULL за замовчуванням + try/catch

**Files:**
- Modify: `web-stable/app.js:2543-2553`
- Test: `node test_jsmav.mjs` (регресія link.js) + `python3 test_ui.py` (структура)

**Interfaces:**
- Consumes: `_mavLink.verifyMission(items, 60000)` / `verifyMissionCount(items.length)` (Tasks 1–3).
- Produces: `res.verify` (як раніше) + `res.verify_incomplete` (bool) на throw; `res.ok` НЕ змінюється політикою verify.

Одне джерело істини політики для `mavUpload` і `resumeUploadRemainder`: FULL за замовчуванням; `verify:'count'` — informed opt-out; `verify:false` — явний skip. Verify обгорнуто у try/catch → flaky verify ніколи не робить успішну заливку червоною.

- [ ] **Step 1: Замінити блок verify (`app.js:2543-2553`)**

Наявне:
```js
      if (!p || p.verify !== false) {
        // Default: fast count-only verify (one round-trip) ...
        const v = (p && p.verify === "full")
          ? await _mavLink.verifyMission(items)
          : await _mavLink.verifyMissionCount(items.length);
        res.verify = v;
        if (v.ok && !v.verified) res.verify_warning = "Зчитана місія не збігається — перевір.";
      }
      return res;
```
замінити на:
```js
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
      return res;
```

- [ ] **Step 2: Регресія link.js незмінна**

Run: `node test_jsmav.mjs`
Expected: `ALL CHECKS PASSED` (app.js-зміна не чіпає link.js-контракт).

- [ ] **Step 3: Структурна перевірка id-ів (app.js ↔ index.html)**

Run: `python3 test_ui.py`
Expected: `== app.js element ids exist in index.html ==` без нових missing (цей таск не додає id).

- [ ] **Step 4: Commit**

```bash
git add web-stable/app.js
git commit -m "feat(upload): verify FULL by default + try/catch (never paints a stored mission red)"
```

---

### Task 5: `#mav-verify-fast` opt-out + три-станний рендер вердикту в `mavUpload`

**Files:**
- Modify: `web-stable/index.html` (додати чекбокс біля `#mav-upload`), `web-stable/app.js:3631-3671`
- Test: `python3 test_ui.py`; ручний SITL/польовий smoke (Task 7)

**Interfaces:**
- Consumes: `res.verify` (`{ok, verified, mismatches, error}`) з Task 4.
- Produces: вердикт у трьох станах + опційний `#mav-verify-fast` (default OFF).

- [ ] **Step 1: Додати чекбокс у `index.html` (поряд із кнопкою `#mav-upload`)**

Знайти рядок із `id="mav-upload"` та одразу після його контейнера додати:
```html
<label class="opt" title="Лише кількість точок — швидше на слабкому ELRS, але НЕ звіряє координати">
  <input type="checkbox" id="mav-verify-fast"> Швидка перевірка (лише кількість)
</label>
```

- [ ] **Step 2: Прокинути політику verify у виклик заливки (`app.js:3631-3635`)**

Наявний обʼєкт-аргумент:
```js
      const r = await a.mav_upload_mission({
        onProgress: (s, tot) => setMsg(tf("Заливаю місію в дрон… {0}/{1} точок", s, tot), null),
        turn_radius_m: turnRadiusM,
        plane_params: planeParams,
      });
```
замінити на:
```js
      const r = await a.mav_upload_mission({
        onProgress: (s, tot) => setMsg(tf("Заливаю місію в дрон… {0}/{1} точок", s, tot), null),
        turn_radius_m: turnRadiusM,
        plane_params: planeParams,
        // Default FULL geometry read-back; the opt-out checkbox falls back to count-only for
        // a knowingly-marginal ELRS link.
        verify: ($("mav-verify-fast") && $("mav-verify-fast").checked) ? "count" : "full",
      });
```

- [ ] **Step 3: Три-станний рендер вердикту (`app.js:3661-3671`)**

Наявне:
```js
        const v = r.verify;
        if (v && v.ok && v.verified) {
          m += " " + t("Перевірено зчитуванням — збігається.");
          setMsg(m, "ok");
        } else if (v && v.ok && !v.verified) {
          m += " " + tf("Зчитана місія НЕ збігається ({0}).", (v.mismatches || []).join("; ") || t("розбіжності"));
          setMsg(m, "error");
        } else {
          if (r.warning) m += " " + r.warning;
          setMsg(m, "ok");
        }
```
замінити на:
```js
        const v = r.verify;
        if (v && v.ok && v.verified) {
          m += " " + t("Перевірено зчитуванням — збігається.");
          setMsg(m, "ok");
        } else if (v && v.ok && !v.verified) {
          m += " " + tf("Зчитана місія НЕ збігається ({0}).", (v.mismatches || []).join("; ") || t("розбіжності"));
          setMsg(m, "error");
        } else if (v && !v.ok) {
          // AMBER: mission stored (ACK'd) but read-back could not complete on this link.
          setMsg(m + " " + tf("Місію залито, але ПЕРЕВІРКА ЧИТАННЯМ НЕ ВДАЛАСЯ ({0}) — link заслабкий. Підійди ближче / під'єднай USB.",
            (v.error || t("таймаут"))), "warn");
        } else {
          if (r.warning) m += " " + r.warning;
          setMsg(m, "ok");
        }
```

- [ ] **Step 4: Перевірити, що `setMsg(..., "warn")` дає жовтий стан**

Run: `grep -n "\"warn\"\|'warn'\|\.warn" web-stable/app.js web-stable/style.css | head`
Expected: `setMsg` вже мапить рівень на CSS-клас; якщо жовтого класу немає — додати у `style.css` правило для `.msg.warn { background:#3a2f00; color:#ffd166; }` (амбер, читабельно на сонці). Якщо клас є — нічого не робити.

- [ ] **Step 5: Структурна перевірка id-ів**

Run: `python3 test_ui.py`
Expected: PASS — `mav-verify-fast` тепер оголошено в `index.html` (жодних missing).

- [ ] **Step 6: Commit**

```bash
git add web-stable/index.html web-stable/app.js web-stable/style.css
git commit -m "feat(upload): three-state verdict (verified/mismatch/incomplete) + #mav-verify-fast opt-out"
```

---

### Task 6: `resumeUploadRemainder` — та сама політика verify + три-станний рендер

**Files:**
- Modify: `web-stable/app.js:3694-3712`
- Test: `python3 test_ui.py`; ручний SITL/польовий smoke (Task 7)

**Interfaces:**
- Consumes: `mav_upload_mission` FULL-політика (Task 4), `res.verify` (Tasks 1–3).
- Produces: залишок місії верифікується так само (дрон на землі чекає — remainder так само safety-critical).

- [ ] **Step 1: Прокинути verify-політику у виклик заливки залишку (`app.js:3694-3698`)**

Наявне:
```js
      const r = await a.mav_upload_mission({
        route: rem.rest,
        onProgress: (s, tot) => setMsg(tf("Заливаю місію в дрон… {0}/{1} точок", s, tot), null),
        turn_radius_m: _rt ? Math.max(1, Math.min(10, _sp / 2)) : 0,
      });
```
замінити на:
```js
      const r = await a.mav_upload_mission({
        route: rem.rest,
        onProgress: (s, tot) => setMsg(tf("Заливаю місію в дрон… {0}/{1} точок", s, tot), null),
        turn_radius_m: _rt ? Math.max(1, Math.min(10, _sp / 2)) : 0,
        verify: ($("mav-verify-fast") && $("mav-verify-fast").checked) ? "count" : "full",
      });
```

- [ ] **Step 2: Три-станний вердикт у фінальному повідомленні залишку (`app.js:3708-3712`)**

Наявне:
```js
      updateMissionStatus();
      const air = lastStatus && lastStatus.alt_rel != null && lastStatus.alt_rel > 1.5;
      setMsg("Залишок залито (" + r.count + " пунктів). " + (air
        ? "Натисни «Старт місії» — дрон підніметься вертикально на задану висоту і продовжить."
        : "Увімкни мотори і натисни «Старт місії» — дрон злетить на задану висоту і продовжить."), "ok");
```
замінити на:
```js
      updateMissionStatus();
      const air = lastStatus && lastStatus.alt_rel != null && lastStatus.alt_rel > 1.5;
      const tail = air
        ? "Натисни «Старт місії» — дрон підніметься вертикально на задану висоту і продовжить."
        : "Увімкни мотори і натисни «Старт місії» — дрон злетить на задану висоту і продовжить.";
      const rv = r.verify;
      if (rv && rv.ok && !rv.verified) {
        setMsg("Залишок залито (" + r.count + " пунктів), але ЗЧИТАНА НЕ ЗБІГАЄТЬСЯ ("
          + ((rv.mismatches || []).join("; ") || "розбіжності") + ") — перевір перед стартом.", "error");
      } else if (rv && !rv.ok) {
        setMsg("Залишок залито (" + r.count + " пунктів), але ПЕРЕВІРКА ЧИТАННЯМ НЕ ВДАЛАСЯ ("
          + (rv.error || "таймаут") + ") — link заслабкий. " + tail, "warn");
      } else {
        setMsg("Залишок залито (" + r.count + " пунктів). " + tail, "ok");
      }
```

- [ ] **Step 3: Структурна перевірка + регресія**

Run: `python3 test_ui.py && node test_jsmav.mjs`
Expected: обидва PASS.

- [ ] **Step 4: Commit**

```bash
git add web-stable/app.js
git commit -m "feat(resume): remainder upload uses the same FULL verify + three-state verdict"
```

---

### Task 7: Приймальний smoke — SITL / польова перевірка трьох станів

**Files:**
- Немає змін коду. Ручна/напівавтоматична перевірка (JS-шлях + реальний дрон/SITL не звʼязані автотестом — це open question Part-2 §I.18, поза Phase 1).

**Interfaces:**
- Consumes: усі попередні таски.
- Produces: підтверджений приймальний критерій фази.

- [ ] **Step 1: VERIFIED (зелений).** Підключити APK/браузер до дрона/ArduCopter SITL (`~/sitl`, `--home 49.5275,24.004,...`), побудувати маршрут, «Залити місію».
Expected: «Місію залито… Перевірено зчитуванням — збігається.» — **зелений**.

- [ ] **Step 2: MISMATCH (червоний).** Залити місію; на дроні/SITL підмінити координату одного WP (напр. через MAVProxy `wp` або залити іншу місію повз FMP), тоді натиснути повторну перевірку/залити ще раз проти старих `items`.
Expected: «…НЕ збігається (#N: координати розійшлись (~X.X м))» — **червоний**, з метрами.

- [ ] **Step 3: VERIFY-INCOMPLETE (амбер).** Увімкнути `#mav-verify-fast` = OFF; заливати через свідомо слабкий/обірваний лінк (ELRS на межі / висмикнути телеметрію під час read-back).
Expected: «Місію залито, але ПЕРЕВІРКА ЧИТАННЯМ НЕ ВДАЛАСЯ (таймаут) — link заслабкий…» — **жовтий**, і `res.ok` true (банер «залито» лишається, `flownRoute` встановлено).

- [ ] **Step 4: opt-out.** Увімкнути `#mav-verify-fast` = ON, залити.
Expected: одна швидка перевірка кількості; при правильному N — зелено; при неправильному — червоно «кількість…».

- [ ] **Step 5: Зафіксувати результати smoke у CHANGELOG/README при релізі фази.**

```bash
git add CHANGELOG.md
git commit -m "docs: Phase 1 mission-verify acceptance smoke (verified/mismatch/incomplete)"
```

---

## Self-Review

**Spec coverage (§4.1):** default-full ✓(T4) · try/catch ✓(T4) · три-станний render ✓(T5,T6) · `#mav-verify-fast` ✓(T5) · статичний legacy-dialect ✓(T1) · cos(lat) метрова дельта ✓(T2) · окремий cap read-back ✓(T3) · `resumeUploadRemainder` парність ✓(T6) · крайові (seq0 AP/INAV, frame-equiv, float32-гейти) — покрито наявною логікою, не регресовано (T1–T3 тести). ПОЗА скоупом (structured diffs/map-highlight, desktop /api) — не включено, відповідно до §4.1.

**Placeholder scan:** без TODO/TBD — кожен крок має реальний код/команду/очікуваний вихід. Task 7 — свідомо ручний (JS+SITL E2E не звʼязані; це Part-2 §I.18), кроки конкретні з очікуваними станами.

**Type consistency:** `downloadMission(timeout, hardCapMs)` (T3) ↔ `verifyMission` виклик (T3) ↔ споживачі `res.verify.{ok,verified,mismatches,error}` (T4,T5,T6) узгоджені. `makeMissionVehicle`/`toStored` визначені в T1, спожиті в T2,T3. `verify:'full'|'count'|false` — один контракт (T4 API ↔ T5,T6 виклики).
