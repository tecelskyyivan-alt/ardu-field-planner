# FMP — майстер-специфікація: фон, персистентність, безпека польоту, статистика

**Дата:** 2026-07-22 · **Статус:** на рев'ю Івана · **Проєкт:** `~/projects/ardu-field-planner` (FMP, GPLv3, публічний)

Єдиний узгоджений дизайн 13 фіч + наскрізних вимог для агродронового GCS (ArduPilot/INAV, ELRS, PWA + Android APK). Документ = **Front-matter (цей розділ) + Частина 1 (features #1–#6) + Частина 2 (features #5-additions, #7–#13)**. Обидві частини пройшли верифікацію проти реального коду й adversarial-критику (5 незалежних лінз кожна); усі critical/major-зауваження усунено всередині дизайну. Мова коду/шляхів/MAVLink/Android API — англійська; решта — українська.

---

## Скоуп (13 фіч + наскрізне)

| # | Фіча | Де | Фаза |
|---|------|-----|------|
| 1 | Верифікація залитої місії читанням (геометрія, не лише кількість; 3 стани) | JS `app.js`/`mav` | 1 |
| 2 | Персистентність + авто-відновлення (з'єднання, стан місії, запис польоту) | JS | 3 |
| 3 | Нативний фоновий `TelemetryService` + закріплена нотифікація (Approach A) | Android | 4 |
| 4 | Автозбереження контуру в іменований store (UPSERT, без дублів) | JS | 2 |
| 5 | Вкладка «Статистика» + **Га/хв**, фільтр год/день, **сумарна площа** | JS | 2 |
| 6 | Оптимізація poll/HUD/лог (bounded, не рерайт) | JS | 5 |
| 7 | MAVLink по кабелю до пульта EdgeTX/ELRS (пресет + інструкція) | serial/JS | 4 |
| 8 | Прогрес по контуру в «Імпорті» (зроблено/лишилось га, к-сть повних) | JS | 2 |
| 9 | Візуалізація смуг обробки (swath / прогалини / накладання) на мапі | JS engine | 5 |
| 10 | Opt-in offline-first бекап полів+журналу на VPS (v1 push-only) | JS/serve | 3 |
| 11 | Телеметрія на мапі (overlay-картка як DJI/XAG) | JS | 5 |
| 12 | Безпечні транзитні шляхи (вхід/повернення в межах поля, оминаючи вирізи) + geofence у FC (backstop) | JS engine + MAVLink | 6 |
| 13 | Маркери небезпек (стовпи/ЛЕП) + експериментальний імпорт ЛЕП з OSM «для тесту» | JS | 5 |
| — | 🎨 Дизайн-система «красиво і стильно» + польова читабельність | усі | Ч2 §F |
| — | 🧪 SITL-тест resume після ручного RTL (валідує #2) | тест | 6 |

## Порядок реалізації (зведений роадмап)

- **Phase 0 — Reconcile Android tree.** Відновити `BleBridge.kt` + `PhotoBridge.kt` з живого дерева (на диску бракує — блокує будь-яку компіляцію/нативну роботу). ⚠️ «живий код розходиться з диском».
- **Phase 1 — #1 verify** (JS, найвища safety-цінність, тест у SITL негайно). Швидкий проміжний реліз.
- **Phase 2 — #4 + #5 + #5-additions + #8 + covered-area** (JS) — усі спираються на спільний field-record (`{fieldId,name}`) і правило покриття.
- **Phase 3 — #2 persistence/reconnect + #10 VPS-бекап** (JS/serve).
- **Phase 4 — #3 native TelemetryService + нотифікація + #7 handset-пресет** (Android; залежить від Phase 0).
- **Phase 5 — #6 opt + #11 map-overlay + #9 swath + #13 hazards/OSM** (JS).
- **Phase 6 — cross-cutting glue + #12** (спершу fence-backstop, тоді safe-transit routing; #12-primary лендиться лише після зеленого SITL-resume).

## Відкриті питання

Сумарно **25** (Частина 1 §11 — 7; Частина 2 §I — 18). **Для більшості вже обрано безпечний дефолт** (позначено «обрано»/«рекомендовано»). Курований шортліст того, що реально потребує рішення Івана, — в супровідному повідомленні до рев'ю.

---
---

# ═══════════════════════════════════════
# ЧАСТИНА 1 — features #1–#6
# ═══════════════════════════════════════

# FMP — фінальна проєктна специфікація (v1)

Єдиний узгоджений дизайн шести підсистем із вбудованим усуненням усіх critical/major зауважень адверсарної рецензії. Реалізація — фазами (розділ 10). Мова коду/шляхів/MAVLink/Android API — англійська; решта — українська.

---

## 1. Огляд і цілі

1. **#1 Верифікація місії читанням.** «Залити місію» має доводити, що дрон тримає САМЕ намальоване поле (геометрію), а не лише правильну кількість точок; три чіткі стани вердикту: VERIFIED / MISMATCH / VERIFY-INCOMPLETE.
2. **#2 Персистентність і авто-відновлення.** Пережити close/OOM-kill/reboot: відновити з'єднання (BLE+UDP+USB), стан залитої місії (flown*), незавершений запис польоту; warm re-attach до живого нативного лінка.
3. **#3 Нативний фоновий TelemetryService (Approach A).** Foreground-service володіє сокетом і мінімальним MAVLink-парсером, тримає лінк живим із вимкненим екраном, показує закріплену нотифікацію.
4. **#4 Персистентність контуру.** Залитий контур має потрапляти в іменований durable-store (не лише в транзиторний `fmp_last_field`) і при повторній заливці **оновлюватись, а не дублюватись**.
5. **#5 Вкладка «Статистика».** Read-only над `fmp_flightlog`: рядок на політ + агрегати. Без треку-на-карті, без CSV/GPX.
6. **#6 Оптимізація poll/HUD/лог (bounded).** Завершити render-diffing HUD і додати flush логу на background/kill. Без переписування IIFE.

---

## 2. Архітектурне рішення

### 2.1 Approach A (обрано) vs Approach B (відхилено)

- **Approach B (тримати JS живим у фоні)** — відхилено. Chromium дроселює background-таймери до ~1/хв, а WebView `pauseTimers()` заморожує їх повністю; крім того під deep Doze процес заморожується попри будь-які JS-хитрощі. JS-heartbeat (`_hbTimer` 1 Гц, `link.js:209`) і re-request потоків (`_ageTimer` 500 мс, `link.js:176`) у фоні тихо зупиняються → ELRS-backpack перестає ретранслювати. B недосяжний архітектурно.
- **Approach A (обрано).** Нативний foreground **TelemetryService** володіє сокетами (лінк переживає знищення WebView), тримає wake/wifi/multicast-локи, **сам ретранслює keep-alive-кадри** поки WebView від'єднано, запускає крихітний нативний MAVLink-парсер для полів нотифікації і форвардить сирі кадри у WebView лише поки той приєднаний — тобто у foreground поведінка байт-у-байт як сьогодні.

**Причина A:** єдиний OS-санкціонований механізм тримати процес у running-класі + не залежати від замороженого JS для keep-alive. B не дає жодної з цих гарантій.

### 2.2 Межі компонентів

| Шар | Володіє | Відповідальність |
|---|---|---|
| **JS (`app.js` IIFE + `mav/*.js`)** | UI, планувальник, повний MAVLink-кодек/парсер, verify/upload, персистентність (localStorage/IndexedDB), HUD | Джерело істини для: імені поля, `wp_total`, фази місії, decoded keep-alive-кадрів. У foreground — весь телеметричний парс як зараз. |
| **TelemetryService.kt** (новий) | UDP/Serial/BLE-транспорти (перенесені з bridge-об'єктів), wake/wifi/multicast-локи, нотифікація, `MavNotifyParser` | Живучість лінка, keep-alive-replay (лише detached), нативні поля нотифікації, warm re-attach. |
| **Bridges (Udp/Serial/BleBridge.kt)** | Сокет/порт/GATT | Приймання байтів → `TelemetryService.Sink` (замість прямого `evaluateJavascript`). Ідемпотентний `open()`/`isOpen()`. |
| **NotifyBridge.kt** (новий, `@JavascriptInterface`) | — | JS→native канал: ім'я поля, `wpTotal`, фаза, distance-based `%`, decoded-mode (fallback), keep-alive-frames; native→JS `getSnapshot()` для warm-seed HUD. **Інваріант: NotifyBridge НІКОЛИ не емітить MAVLink-кадр.** |

Контракт `base64 data/event` між bridge та JS зберігається **байт-ідентично** (Sink лише додає feed у парсер перед форвардом), тому `transport.js`/`link.js` майже не змінюються — мінімізуємо регрес робочих лінків.

---

## 3. Потік даних

### 3.1 Foreground (WebView приєднано)
Транспорт (у Service) отримує байти → `Sink.data(b64)` → (a) `MavNotifyParser.push()`, (b) `window.__androidUdpData/__androidSerialData/__androidBleData` (як сьогодні). JS `link.js` робить повний парс, `mavPoll` (2 Гц, `app.js:2987`) читає in-memory snapshot і оновлює HUD. JS-keep-alive активний; **нативний replay ВИМКНЕНО** (щоб не дублювати uplink на вузькому ELRS).

### 3.2 Background (WebView від'єднано / екран вимкнено)
`MainActivity.onStop` → `service.detachWebView()`; native **синхронно** викликає `evaluateJavascript("__fmpSuspendFlush()")` (дренаж логу + flightRec) **до** `webView.pauseTimers()`. Далі Sink більше не форвардить у JS; `MavNotifyParser` продовжує рахувати; Service **сам ретранслює** keep-alive (HEARTBEAT @1 Гц, SET_MESSAGE_INTERVAL @~12 с) — бо JS-таймери заморожені. Нотифікація оновлюється 1 Гц.

> **Deep-Doze реальність (усунення critical Android-критики).** FGS + `PARTIAL_WAKE_LOCK` **НЕ** переживають deep Doze на стаціонарному телефоні з вимкненим екраном — Doze ігнорує wake-локи й глушить Wi-Fi поза maintenance-вікнами. Це і є флагманський сценарій (телефон поклали на борт, дрон летить AUTO). Тому **battery-optimization exemption стає load-bearing кроком Connect-флоу**, а не «belt-and-suspenders»: `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` (self-distributed build; для Play-build — документований ручний шлях у Settings). Обіцянка «надійний фон» **явно ґейтиться на цьому exemption**. Без нього гарантії немає — це документуємо чесно.

### 3.3 Warm reopen (Service живий, WebView перестворено) — спільний контракт #2↔#3
Оскільки `onDestroy` більше **не** закриває транспорти, warm-relaunch — **типовий** випадок. `bootAutoReconnect` **спершу пробує** `AndroidUdp/Serial/Ble.isOpen()`:
- **open==true** → пропустити `open()`, перепідключити `ondata`-колбек, `mavConnected=true`, seed HUD із `NotifyBridge.getSnapshot()`, `mavStartPolling()`. Жодного rebind → **немає EADDRINUSE/GATT-busy**.
- **open==false** → холодний шлях: `mavConnect()` відкриває сокет, Service auto-стартує на першому `open()`.

`open()/connect()` **ідемпотентні**: якщо вже прив'язані до того ж endpoint → `{ok:true, reattached:true}` + перереєстрація `__android*Data`. **#2 і #3 постачаються разом** — інакше warm-relaunch падає (усунення critical cross-subsystem).

### 3.4 Cold boot (процес мертвий, сокет закрито)
Deferred restore-блок (`setTimeout`, `app.js:1349-1413`) у фіксованому порядку (розділ 7): field→route→flown(**restored-unverified pill**)→flightRec(partial)→session→`bootAutoReconnect` (single-shot, guarded). На першому успішному реконекті — **re-verify flown перед тим, як пілюля стане зеленою**.

---

## 4. Дизайн по підсистемах

### 4.1 #1 — Верифікація місії читанням

**Корінь/поведінка.** `mavUpload()` (`app.js:3604`) не передає `verify`, тож тернар `p.verify==='full'` (`app.js:2548`) хибний → завжди `verifyMissionCount` (count-only, `link.js:638`). Місія з правильним N, але зсунутими координатами верифікується **зеленим**. Другий, зчеплений дефект: render-вердикт (`app.js:3661-3671`) має лише дві позитивні гілки; коли full read-back не завершується на слабкому лінку (`downloadMission ok:false` → `verifyMission ok:false`), код падає в `else` (`app.js:3668`) і показує **зелене «Місію залито»** без попередження. Обидва фікси йдуть **разом**.

**Конкретні зміни.**
- `mav_upload_mission` (`app.js:2543-2552`): **FULL за замовчуванням** на рівні API (одне джерело істини для `mavUpload` і `resumeUploadRemainder`). `const mode=(!p||p.verify===undefined)?'full':p.verify;` `verify:false` — явний skip, `'count'` — явний opt-out. Передати `verifyMission(items, 60000)` замість дефолтних 15 с.
- **Обгорнути verify у try/catch** (усунення major safety): блок verify зараз не захищено. На throw → `res.verify={ok:false,error:e.message}; res.verify_incomplete=true;` і **`res.ok` лишається true** (місію ACK'нуто) → рендер AMBER, **ніколи RED і ніколи green**. Без цього flaky-verify фарбує успішну заливку червоним і не встановлює `flownRoute`.
- `mavUpload()` (`app.js:3631-3635`): `verify: ($('mav-verify-fast')&&$('mav-verify-fast').checked)?'count':'full'`. Опційний чекбокс `#mav-verify-fast` («швидка перевірка — лише кількість точок», default OFF) — informed opt-out для завідомо маргінальних ELRS-лінків.
- **Три-станний render** (`app.js:3661-3671`): після green (`v.ok&&v.verified`) і red (`v.ok&&!v.verified`, список із метрами) додати AMBER: `else if (v && !v.ok){ setMsg('Місію залито, але ПЕРЕВІРКА ЧИТАННЯМ НЕ ВДАЛАСЯ ('+(v.error||'таймаут')+') — link заслабкий. Підійди ближче / USB і натисни «Перевірити ще раз».','warn'); }`. Кнопка «Перевірити ще раз» → новий re-verify шлях (`verifyMission` проти щойно залитих `items`).
- **Dialect — статичний legacy-default (усунення major, розв'язання суперечності).** У `downloadMission` (`link.js:579`) замість `autopilot==null|3 → INT`: **`reqT = (this._tlm.autopilot === 3) ? 'MISSION_REQUEST_INT' : 'MISSION_REQUEST';`**. Unknown/bridge-only (`autopilot` null) → legacy, який відповідають **і ArduPilot (обидва), і INAV (лише legacy)**. **Суперечність:** MAVLink-критика пропонує one-time flip, гейтований на `seq===0`; safety-критика — статичний one-liner. **Обрано статичний** — безпечніше: усуває весь flip-state-machine, його осциляцію INT↔legacy на INAV і ризик хибного AMBER; ~0.5 м float32-округлення на unknown-but-AP лінку поглинається наявним 1.1 м гейтом (`link.js:624`).
- **Метри з cos(lat) (усунення minor).** У `verifyMission` (`link.js:624`) magnitude: `dm = hypot((ex-a.x)*1.113e-2, (ey-a.y)*1.113e-2*cos(latRad))` — довготу масштабувати на `cos(lat)` (~0.66 на 49° N), інакше east-west дельту завищено ~1.5×. Наявний пер-осьовий pass/fail-гейт лишається як є (в raw-одиницях).
- **Cap read-back окремо (усунення missing).** verify не має успадковувати 10-хв дедлайн `downloadMission` із паузою потоків (HUD замерзне на весь час). Cap ~60 с → VERIFY-INCOMPLETE.
- `resumeUploadRemainder` (`app.js:3694-3712`): та сама verify-політика і три-станний render (дрон на землі чекає — remainder так само safety-critical).

**Нові/змінені компоненти.** Three-state verdict renderer; `#mav-verify-fast` opt-out. **ПОЗА скоупом (усунення major):** структурований `diffs[]`, `seqToRouteIndex`, flash-highlight точки на карті — прибрано (спекулятивний UX + крихка прив'язка до `buildMissionItems`). Лишається лише метрова дельта в рядку.

**Крайові випадки.** seq 0 (home) ArduPilot перезаписує — coord-check вже пропущено (`link.js:615`), лишити як regression-guard при default-full. INAV: seq 0 — перший waypoint, координати ВЕРИФІКУЮТЬСЯ (`link.js:604`), dialect лишається legacy. Frame-еквіваленти {3,6}/{0,5} (`link.js:609,616`). float32 v1-діалект — поглинає 1.1 м/1.0 м гейти. Обірваний середній `MISSION_ITEM` → `ok:false` → AMBER (не green, не mismatch).

**Ризики.** Default-full ~подвоює pre-flight трансфер на ELRS 1:2 (~6.5 msg/s) — це безпечніше, копірайт-фрейминг + opt-out. Desktop `/api/mav_upload_mission` (`app.js:1009`) — **окрема реалізація, ПОЗА скоупом** (bench/SITL only); фікс явно скоуповано на in-browser jsMav-шлях (польовий пристрій).

---

### 4.2 #2 — Персистентність і авто-відновлення

**Корінь/поведінка.** Три незалежні прогалини: (1) boot auto-reconnect реалізовано лише для BLE (`app.js:1375-1378`), хоча `fmp_session` зберігає `wasConnected/connType/addr/baud` (`app.js:2923`); UDP/Serial ніколи не реконектяться. (2) flown-snapshot (`flownRoute/flownHome/flownHasRtl`, `app.js:2236-2238`) пишеться на upload, але **boot ніколи не відновлює** → після reopen `updateMissionStatus` показує «НЕ залито», `mavProgressData` повертає null; до того ж `fmp_flown` неповний (`flownSave` пише route+rtl+lead, **без home**, `app.js:2267-2273`). (3) `flightRec` живе лише в RAM, фіналізується в IndexedDB тільки на disarm → process-kill втрачає весь запис.

> **Правильна назва boot-хука — `window.__fmpBleAutoReconnect`** (`app.js:2777`, викл. `app.js:1375-1378`), НЕ `__androidBleAutoReconnect` (усунення correction).

**Конкретні зміни.**
- **`flownSave(route, home, hasRtl)`** (`app.js:2267-2273`): писати `{route, home:home||null, rtl:(hasRtl??$('rtl').checked), lead:missionLead(), fieldId, name, wpTotal:flownWpTotal, status, ts}`. Call-sites: primary — **перенести ПІСЛЯ** встановлення `flownHome/flownHasRtl` (`app.js:3658`); resume — **вивести `flownHome` з `lastStatus` (home_lat/home_lon)** перед викликом (усунення major: інакше resume як перший upload після reopen пише `home=null` → `_progGeom` не будує RTL-leg/countdown).
- **Intent-marker для вікна ACK→flownSave (усунення major).** Перед видачею upload писати `fmp_flown={route:lastRoute, ts, status:'uploading'}`. На ACK — переписати `status:'confirmed'` + home/rtl/wpTotal. **`flownSave` ПЕРЕД `resumeClear`** (зараз `resumeClear` `app.js:3644` йде раніше `flownSave` `app.js:3648`) — щоб RESUME_KEY не стирався поки FLOWN_KEY описує стару місію. На boot marker `'uploading'` з route==plan → пілюля «ймовірно залито — перевір», а не «НЕ залито».
- **`flownRestore()`** (біля `flownLoad`, ~`app.js:2259`): читає `fmp_flown`, присвоює три let'и + `flownWpTotal`, скидає `_progCache`. Викликається в boot після `restoreLastRoute` (`app.js:1355`), далі `updateMissionStatus()`.
- **Restored-unverified pill (усунення critical safety #1↔#2).** Диск-відновлений flown **НЕ** маршрутизувати в ту саму зелену пілюлю `mission-status ok` (`app.js:2338`), що й read-back-verified upload — після kill/reboot дрон міг бути power-cycled/reflashed/іншим бортом. Окремий стан **«Остання відома місія — підключись і перевір»** (warn/neutral-клас). На наступному успішному реконекті — **`verifyMission(flownRoute)` перш ніж пілюля отримає право стати зеленою**. (Restore не має читатись ідентично до верифікованого upload.)
- **`bootAutoReconnect(ss)`** замість BLE-only гілки (`app.js:1374-1379`): dispatcher по `ss.connType`. BLE — тіло 1375-1378 **байт-у-байт**. UDP — `mavSyncRows`, заповнити addr, `setTimeout(()=>{ if(!mavConnected&&!mavConnecting) mavConnect(); },1200)`. cable(Android) — `mav_list_ports` + `mavConnect` один раз. Desktop WebSerial — **пропустити** (індекси портів не переживають reload). Warm-probe `isOpen()` перед усім (розділ 3.3).
- **Re-entrancy guard (усунення critical race).** `mavConnect` встановлює `mavConnected=true` лише ПІСЛЯ `await a.mav_connect` (`app.js:2906`) — між тапом Connect і `+1200/+1500 мс` таймером обидва бачать `mavConnected===false` → **другий `new MavLink()` + EADDRINUSE / orphan-лінк**. Фікс: синхронний `let mavConnecting=false;` (true на самому вершку `mavConnect`, clear у `finally`); гейт `if(mavConnected||mavConnecting) return;` у manual-handler, `bootAutoReconnect` і `__fmpBleAutoReconnect`. Зберігати id auto-reconnect-таймера і **чистити його при ручному Connect/Disconnect**.
- **`flightRecPersist()` / `fmp_flightrec_active`.** Throttled write (~10 с) у `flightRecTick` після push-семпла (`app.js:3244`), payload `{started_at,planned,work,bp_start,samples:slice(-600),sawComplete,wp_total}`; синхронний flush із єдиного suspend-dispatcher (нижче). Clear у `flightRecFinalize` (`app.js:3275`).
- **`flightRecRestore()` — ЗАВЖДИ як partial (усунення major YAGNI + major double-write).** На boot: якщо `fmp_flightrec_active` є → **спершу `flogHas(a.started_at)`** (dedup, бо `keyPath===started_at`; re-фіналізація тим самим ключем перезаписала б хороший complete-запис гіршим partial); якщо запис уже в `fmp_flightlog` → clear mirror і return. Інакше — `flightRecFinalize(null, /*partial*/true)`. **Live-resume гілку і 120 с поріг прибрано** — flightlog це лише stats/калібрація (не flight-control), тож безперервність через kill має ~нульову цінність проти складності й ризику corruption. **Суперечність (resume-vs-partial):** обрано always-partial — безпечніше.

**Крайові випадки.** `fmp_flown` newer than reality → restored-unverified pill + re-verify закриває ризик (замість TTL). Non-APK BLE guard: `__fmpBleAutoReconnect` існує лише при `window.AndroidBle`. USB-permission dialog — single attempt, ніколи retry-loop. `flightRecFinalize(null,...)` безпечний (`s &&`-guard, `app.js:3262`).

**Ризики.** Рефактор BLE-гілки в dispatcher — тримати BLE-тіло байт-у-байт, лише додавати sibling-гілки. Auto-open сокета без user-gesture — ОК на APK (нативні bridges), заборонено на desktop WebSerial (gated `IS_ANDROID`). Warm-half цілком залежить від контракту #3 (`isOpen`+idempotent-open) — постачати разом.

---

### 4.3 #3 — Нативний фоновий TelemetryService (Approach A)

**Корінь/поведінка.** Сокети живуть у bridge-об'єктах (`MainActivity` лише тримає посилання й закриває в `onDestroy` `MainActivity.kt:271-276`); recv — на daemon-потоках. Вони гинуть на process-kill і **заморожуються під Doze**; а WebView-sleep ламає JS-keep-alive → backpack перестає стрімити. Фікс — FGS, що володіє всім.

> **Стан дерева (усунення correction).** `BleBridge.kt` і `PhotoBridge.kt` **відсутні на диску**, але `MainActivity.kt` їх референсить → дерево **не компілюється**. **Phase 0: відновити ці файли з живого дерева** перед будь-якою роботою #3.

**Конкретні зміни (Android).**
- **AndroidManifest.xml** (`after :18`): `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_CONNECTED_DEVICE`, `POST_NOTIFICATIONS`, `WAKE_LOCK`, `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, **`BLUETOOTH_SCAN` (`usesPermissionFlags="neverForLocation"`) + `BLUETOOTH_CONNECT`** (усунення major: зараз Bluetooth-permission взагалі не оголошено → runtime-запит авто-denied → BLE + легальність FGS зламані на API 31+), `CHANGE_NETWORK_STATE` (belt-and-suspenders для UDP-кваліфікатора). `CHANGE_WIFI_MULTICAST_STATE` + `ACCESS_WIFI_STATE` вже є.
- **`<service android:name=".TelemetryService" android:exported="false" android:foregroundServiceType="connectedDevice"/>`** (усунення major: `dataSync` має ~6 год/добу cap на Android 15 → force-stop серед spraying-дня; `location` хибний; `connectedDevice` без cap — покриває USB/BLE/companion-Wi-Fi).
- **`connectedDevice`-prerequisite (усунення major).** `startForeground(type=connectedDevice)` кидає `SecurityException`, якщо не held кваліфікуючий permission. Для UDP — `CHANGE_WIFI_MULTICAST_STATE` (present, always-granted). Для BLE — **`startForeground` лише ПІСЛЯ підтвердженого `BLUETOOTH_CONNECT`**.
- **Старт FGS (усунення major, JS-binder-thread + 5 с + background-start).** `@JavascriptInterface open()` виконується на binder-потоці. (1) `startForeground(id, connectingNotification, TYPE_CONNECTED_DEVICE)` — **синхронно, ПЕРШОЮ дією `onStartCommand`** (показати «Підключення…»), ніколи за async-транспортом (bind/USB-dialog/GATT перевищать 5 с → `ForegroundServiceDidNotStartInTimeException`). (2) Bind у `onCreate` лише для LocalBinder-API; `startForegroundService` — лише коли `open()` починається **І Activity foreground** (`connectedDevice` НЕ виняток із Android-12 background-start-restriction → `ForegroundServiceStartNotAllowedException`). **`bootAutoReconnect` (setTimeout після load) мусить гейтитись на Activity-resumed**, інакше background-старт FGS кидає.
- **MainActivity.kt:** `onCreate` — `startForegroundService`+`bindService`, у `onServiceConnected` зареєструвати service-owned bridges як `AndroidSerial/Udp/Ble` + `NotifyBridge`, **потім** `loadUrl` (JS-інтерфейси мусять існувати на page-load; timeout-fallback проти blank-screen). **`onStart`** → `attachWebView`+`resumeTimers()`. **`onStop`** → синхронний `evaluateJavascript("__fmpSuspendFlush()")` → `detachWebView()` → **`pauseTimers()`** (native стає ЄДИНИМ uplink; усунення major). **`onDestroy`** → `unbindService`, **НЕ закривати транспорти, НЕ `stopService`** (лінк переживає teardown). POST_NOTIFICATIONS-запит (API≥33) — лениво на першому Connect; denial не блокує лінк.
- **Bridges → `Sink`:** `UdpBridge`/`SerialBridge`/`BleBridge` — замінити `web:WebView` на `sink:TelemetryService.Sink`; recv → `sink.data(b64)`; `dlog`/`event` через sink. **MulticastLock перенести з `UdpBridge` у Service** (усунення minor: зараз `onDestroy→udp.close()→releaseMcast` вбиває Wi-Fi-телеметрію на будь-якому teardown), ref-count acquire-on-first-open/release-on-last-close. Serial — `applicationContext` для USB-receiver (не leak-нути мертву Activity); `ACTION_USB_DEVICE_DETACHED` → нотифікація «лінк втрачено» + auto-stop FGS якщо останній транспорт.
- **Локи (усунення major WifiLock).** `PARTIAL_WAKE_LOCK` + `MulticastLock` + **`WifiManager.WifiLock(WIFI_MODE_FULL_HIGH_PERF)`** для UDP. **НЕ `LOW_LATENCY`** — він активний лише foreground+screen-on, тобто інертний саме в цільовому screen-off-фоні; `HIGH_PERF` тримає радіо поза power-save з вимкненим екраном. Навіть `HIGH_PERF` під Doze глушиться → **комбінувати з battery-opt exemption** (розділ 3.2).
- **link.js `connect()` (`202-215`):** **eagerly/синхронно на connect-success** (до будь-якого backgrounding; усунення major ordering) побудувати GCS HEARTBEAT + 5×`SET_MESSAGE_INTERVAL` через `MAVLINK.encode`, base64, `NotifyBridge.setKeepAlive(...)`; **перереєструвати на lock sysid/comp** (`link.js:296`). Native лишається dumb-replayer (без нативного енкодера).
- **START_NOT_STICKY** + без `BOOT_COMPLETED` (усунення minor): OOM-kill завершує сесію (auto-restart лінка без живого сокета безглуздий) — **документуємо**; зникла нотифікація = лінк зник, не «схований».

**Крайові випадки.** POST_NOTIFICATIONS denied → лінк живий, нотифікація невидима. Bridge vs autopilot heartbeat: adopt mode/armed лише при `autopilot!=8 && type!=6` (`link.js:289`). `onTaskRemoved` (swipe) → лінк+нотифікація живі; relaunch re-adopt (не rebind). Duplicate uplink: replay строго gated на detached + коротка grace-затримка (усунення minor: JS `_hbTimer`/`_ageTimer` крутяться поки WebView реально не заморожено).

**Ризики.** Hostile-OEM (Xiaomi/Huawei/Samsung) можуть убити навіть FGS — жодне API це повністю не закриває; FGS+wakelock+WifiLock+battery-opt — найсильніша стандартна комбінація, залишковий OEM-ризик визнаємо. `connectedDevice` для Wi-Fi-backpack — трохи loose для Play-review, але best-of-bad. Offset/crc_extra захардкоджено — JVM golden-test проти `mavlink.js` (розділ 9).

---

### 4.4 #4 — Персистентність контуру (named-record on upload)

**Корінь/поведінка.** На upload `mavUpload` (`app.js:3642-3648`) кличе лише `scheduleSaveField()` (→ транзиторний `fmp_last_field={contour,exclusions}`, `app.js:754`) і `flownSave()`. **`fldPut()` в persistent named-store `fmp_fields` (keyPath `name`, `app.js:1788`) НЕ викликається** на upload-шляху. UI обіцяє «Автозбереження — при заливці в дрон» (`app.js:2140`), але залитий контур ніколи не потрапляє в load/overview і губиться на наступному adopt. **`proposed_changes` оригінального дизайну порожні — це critical/major прогалина, яку тут закриваємо (усунення major safety).**

**Конкретні зміни.**
- **Upload-time promotion з UPSERT по стабільному ключу.** У upload-success додати `fldPut()`, який **оновлює, а не дублює**: reuse `currentFieldName` якщо set; інакше **один раз** намінтити `'Поле N'` (найменше вільне N через наявну логіку `#save-project` `app.js:1889-1906`), **присвоїти `currentFieldName`** і персистити — щоб наступні re-uploads того ж поля оновлювали той самий запис. Наївне ключування по `currentFieldName===''` (default `app.js:1774`) склеїло б усі unsaved uploads на порожній ключ — тому мінт-once обов'язковий. Опційно ключ по contour-hash (та сама геометрія → один запис незалежно від імені).
- **Єдина ідентичність поля/місії (усунення major cross-subsystem).** Один `{fieldId, name, uploadTs}` штампувати в `fmp_last_field`, `fmp_flown` **і** named-record. На boot **відновлювати `currentFieldName`** з цієї ідентичності (зараз він set лише load/save/import і ніколи не restore-иться → після reopen `#5 rec.field` і `#3 setMission` падають у generic «поле»). Пілюлю mission-status і flown-restore гейтити на збіг **id** (не лише `routeSig`) — інакше restore може підняти контур поля B при flown-route поля A.
- **Bound `fmp_fields` (усунення minor).** `fldPut` при quota тихо повертає false (`app.js:1796`). Always-new `'Поле N'` росте безмежно; UPSERT вище + опційний `fldTrim`/warn біля quota.

**Нові/змінені компоненти.** `fldPut`-on-upload (UPSERT); `fieldId`-ідентичність у трьох сторах; restore `currentFieldName`.

**Крайові випадки.** Freshly-drawn поле (`currentFieldName===''`) → мінт `'Поле N'` once. Re-upload того ж поля → update, не duplicate. Quota-fail → localStorage-fallback + warn.

**Ризики.** Дотик до shared save-path — зміна additive. Contour-hash опційний (уникнути колізій імен).

---

### 4.5 #5 — Вкладка «Статистика»

**Корінь/поведінка.** Кожна AUTO-місія вже пишеться в `fmp_flightlog` (`app.js:3187`); `flightRecFinalize` (`app.js:3256-3279`) зберігає `planned/actual/work/params/samples`. З семи колонок п'ять уже є (`date, field, distance_m, duration_s, battery_used_pct`), avg-speed derivable. Бракує: (1) tab+render; (2) входів covered-area rule — **swath (spacing) і boundary ніколи не персистяться**, `completion%`/`covered_ha` не рахуються.

**Конкретні зміни.**
- **index.html:** 4-та кнопка `<button class="tab" data-tab="stats">Статистика</button>` (`:42-43`; `.tabs flex:1` — 4 auto-shrink, CSS не чіпати). Пейн `<div id="tab-stats" class="tab-pane">…<div id="flight-stats"></div></div>` (`after :289`).
- **`lastWorkContext` (`app.js:1099-1100`, mirror `826`):** додати `swath_m:parseFloat($("spacing").value)||0` і `boundary:boundary` (in-scope з `:1026`). На restore-path `boundary:null`. `flightRecTick` уже snapshot-ить `work:lastWorkContext` → їде в запис без дотику hot-path.
- **`flightRecTick`:** `wp_reached:0` в init (`:3234`); на `:3245` `flightRec.wp_reached=Math.max(flightRec.wp_reached, s.wp_current||0)`.
- **`flightRecFinalize` (`:3264-3275`):** обчислити (див. розділ 8) `covered_ha`, `completion_pct`, `avg_speed_ms`, `swath_m`; потім `flogTrim(FLOG_MAX_FLIGHTS)`.
- **Семпли: `const KEEP_SAMPLES=false` (усунення minor).** Після обчислення covered_ha — **дроп `rec.samples`** (v1 без треку/GPX; калібрація читає лише `planned/actual/partial` через `flogSummary` `:3218`), АЛЕ за реверсивним const-гейтом (при потребі — downsample ≤120 pts замість hard-delete). Дроп **до** дропу нічого не читає, і **після** finalize covered-area вже пораховано.
- **`renderFlightStats()`** (біля `flogAll`, ~`:3223`): `flogAll().sort(desc)`; empty-state або totals-strip (4 tiles: flights/hours/km/ha) + `<table>` [Дата, Поле, Покрито, Відстань, Час, Батарея, Сер. швидкість] в `overflow-x:auto`-wrapper. `esc()` імен полів (untrusted); `t()`/`enUnits()` для i18n; km/h для швидкості. Виклик у tab-handler (`:1249`): `if(name==="stats") renderFlightStats();`.
- **`flogTrim(cap)`** (~`:3207`): `getAllKeys()` (started_at ascending), видалити найстаріші понад cap; `const FLOG_MAX_FLIGHTS=300`.
- **i18n.js:** новий `Object.assign(window.FMP_TR,{…})` блок з UA→EN ключами (Статистика/Дата/Поле/Покрито/…/км/год/empty-state).

**Крайовий, з cross-subsystem critical #2:** `flightRecTick` крутиться лише в `mavPoll`, який **зупиняється на `document.hidden`** — а backgrounded AUTO-політ (весь сенс #3) лишає `samples[]` з діркою → distance/covered/avg-speed хибні, `wp_reached` заморожено. **Реконсиляція з нативною істиною:** на foreground-return і в finalize тягнути `NotifyBridge.getSnapshot()`; при виявленому семпл-gap підставляти нативні `distM` (distance/covered), `flightSec` (duration), `wpSeq` (completion), **флагати запис approximate**. #5/#2 більше не припускають, що JS 1 Гц-семплер працює під час польоту.

**Нові компоненти.** `renderFlightStats`, `_distInField`, `_pointInRing`, `flogTrim`, `FLOG_MAX_FLIGHTS`.

**Крайові випадки.** Немає записів/приватний режим → `flogAll()===[]` → empty-state. `work===null` (raw-місія без плану) → covered `«—»`. `battery===null` → `«—»`, totals skip null. Старі записи (без covered/swath) → `«—»`, read-only over history. Duration<5 с відкидається (`:3261`).

**Ризики.** Дроп семплів змінює `export-flights` JSON — const-гейт робить це явним/реверсивним. `flogTrim` per-finalize — окремі awaited-txn проти blocked-tx-race.

---

### 4.6 #6 — Poll / HUD / лог (bounded optimization)

**Корінь/поведінка.** Код уже агресивно оптимізовано (canvas-renderer, cached `_progGeom`, diffed gpsGuard, background poll-stop, lazy Pyodide). `mavStartPolling` (`:2965`) запускає 2 Гц poll + 4 Гц countdown, обидва hard-stop на `document.hidden` (`:2967,2978-2981`). Реальний headroom вузький.

**Конкретні зміни (лише два, усунення major YAGNI + суперечність).**
- **Завершити HUD render-diffing (`hudSet` `:3359-3366`).** У `mavHudEnsure` розширити row-record `{el,val,lastShow,lastVal,lastColor}`; у `hudSet` писати `display`/`textContent`/`color` **лише при зміні** (той самий патерн, що вже в `gpsGuardRender` `:3158`). Прибирає ~30 redundant style-writes/poll у steady-state. Низький ризик, чіткий виграш.
- **Log-flush на background/kill (`:110` + `appLog`).** Винести тіло інтервалу в `flushLog()`; підняти cadence 4000→~10000 мс (збігається з ~10 с snapshot-cadence `:3005`); **додати `flushLog()` у suspend-dispatcher** (нижче). Обов'язково разом: підйом інтервалу без hide-flush **розширив** би вікно втрати log-tail (найцінніше після інциденту), тим паче що під #3 периодичний таймер у фоні не спрацьовує.

**ПОЗА скоупом (усунення major).**
- **Adaptive poll cadence (change #2) — прибрано.** Тримати **flat 2 Гц** поки connected (hidden-stop лишається). **Суперечність:** дизайн пропонує 500/1000 мс gate на `armed||AUTO`; safety-критика — cut. **Обрано cut** — `armed||AUTO`-gate є safety-load-bearing для anti-spoof/anti-jam `gpsGuardTick` (`:3002`, треба свіжі position-дельти `dt>=0.25`) заради маргінальної економії в parked-фазі (телефон тоді зазвичай стаціонарний/заряджається). Flat 2 Гц знімає ризик і **робить moot** cross-subsystem major (warm-reattach до armed-дрона під 1 Гц-under-sampling).
- **change #5** (skip HUD-writes при hidden fly-tab) — прибрано (self-labeled optional/very-small).

**Ризики.** Обидві зміни additive/guarded, не чіпають wire-протокол/upload/Leaflet-трек. `#1 verify vs #6` — **CLEAN**: `downloadMission`/`verifyMission` на власних `setInterval`, незалежних від `mavPoll`, тож cadence не впливає на read-back (тест у розділі 9 підтверджує).

---

## 5. Специфікація нотифікації

**Контент (фіксовано брифом; %/бар — distance-based, усунення critical cross-subsystem).**
- **Заголовок:** `<Ім'я поля> · <MODE> · <ARMED/DISARMED>`.
- **Рядок прогресу:** `wp N/total` (текстова деталь, wp-based) + **`%` і progress-bar — distance-based**, `setProgress(100, pctDistance, false)`, де `pctDistance` штовхає JS через `NotifyBridge.setProgressPct()` (JS уже рахує `(totalLen-rem)/totalLen*100` `app.js:3513-3515`). Причина єдиної метрики: на агро-місії transit/RTL довгі, а spray-проходи щільні → `seq/total` і distance/total різко розходяться; оператор не має бачити два різні «%» на одному екрані.
- **Рядок телеметрії:** `Alt <m> · GS <m/s> · <flight-time> · <distance-flown>`.
- **Батарея:** `<V> В · <%>` (dash/last-known якщо unknown; ніколи 0%/-1% — розділ 6).
- **БЕЗ Pause/RTL action-кнопок.** `contentIntent` → MainActivity (`singleTask`, `FLAG_IMMUTABLE`). Тап відкриває застосунок.

**Layout.** Стандартний `BigTextStyle` (дві-три рядки достатньо для трьох груп). Custom `RemoteViews` — open-question, за замовчуванням не потрібен.

**Throttle.** Rebuild ≤1 Гц (single Handler-tick), `setOngoing(true)`, `setOnlyAlertOnce(true)`; не churn-ити `setWhen` (щоб не впертись у NotificationManager rate-limit).

**Permissions.** `POST_NOTIFICATIONS` runtime лише `SDK_INT>=33` (denial не блокує FGS/лінк — нотифікація просто невидима). Channel `IMPORTANCE_LOW`, створення лише `SDK_INT>=26`. Small-icon — monochrome `ic_stat_drone.xml` (reuse `ic_launcher` дає білий квадрат).

**Lifecycle.** `startForeground(id, "Підключення…", TYPE_CONNECTED_DEVICE)` синхронно першою дією `onStartCommand`. Auto-start на першому `open()`; auto-stop `stopForeground(STOP_FOREGROUND_REMOVE)+stopSelf` коли останній транспорт закрито. `onTaskRemoved` — тримати живим. `START_NOT_STICKY`, без `BOOT_COMPLETED`.

---

## 6. Нативний MAVLink-парсер (`MavNotifyParser.kt`)

**Framing (v1 `0xFE` / v2 `0xFD`, підтверджено MAVLink-критикою як точне).** Rolling-буфер, hunt STX; total: **v2 = `10+len+2+((incompat&0x01)?13:0)`**, **v1 = `6+len+2`**. Одна датаграма може містити кілька кадрів; кадр може stradd-ити дві датаграми/чанки → нести remainder (`buf.subarray(i)`, дзеркало `mavlink.js`). CRC-16/MCRF4XX по 5 ID; **CRC-fail → advance 1 byte, resync, ніколи throw**. Zero-pad обірваного v2-payload перед читанням, bounds-check **пер-поле** (`payStart+off+size <= payStart+len`).

> **Корекція (усунення MAVLink-критики):** жодної v1/v2 **framing**-роботи в кодеку не треба — encode завжди v2 (`mavlink.js:162`), parse приймає обидва (`mavlink.js:214`). Єдина релевантна відмінність — повідомлення `MISSION_ITEM`(float)/`MISSION_ITEM_INT`(int), уже оброблене.

**crc_extra table (підтверджено точним):** `{0:50, 1:124, 33:104, 42:28, 74:20}`.

| Msg | ID | Поле | Offset | Тип | Нотатки |
|---|---|---|---|---|---|
| HEARTBEAT | 0 | custom_mode | +0 | u32 | → mode-name |
| | | type | +4 | u8 | =1 → APM_PLANE table |
| | | autopilot | +5 | u8 | adopt лише `!=8` |
| | | base_mode | +6 | u8 | armed = bit `0x80` |
| SYS_STATUS | 1 | voltage_battery | +14 | u16 (mV) | **`0xFFFF`=unknown** |
| | | battery_remaining | +30 | i8 (%) | **`-1`=unknown; last field → truncation-prone** |
| GLOBAL_POSITION_INT | 33 | lat | +4 | i32 (1e7) | |
| | | lon | +8 | i32 (1e7) | |
| | | relative_alt | +16 | i32 (mm) | |
| VFR_HUD | 74 | groundspeed | +4 | f32 | |
| | | alt | +8 | f32 | |
| MISSION_CURRENT | 42 | seq | +0 | u16 | live-seq |
| | | total | +2 | u16 | **optional** (v2 truncation / старий ArduPilot омить) → **native довіряє лише JS-pushed `flownWpTotal`** |

**Unknown-sentinels (усунення minor MAVLink).** Дзеркалити `link.js:331-332`: `voltage==0xFFFF → null`; `battery_remaining==-1 → null`; `battery_remaining` довіряти **лише якщо present on wire** (інакше zero-pad дав би фальшивий 0%). У нотифікації — dash/last-known, **ніколи 0%/-1%**.

**Mode-name (усунення minor MAVLink + background-truth).** **Реплікувати `modeName(custom_mode,type)` нативно** (`link.js:49-52`): `type===1 → APM_PLANE` table, інакше `ACM_REV` copter table. INAV re-map-ить власні режими на ті самі ArduPilot-номери → **окремої INAV-таблиці НЕ вигадувати**. Причина нативного decode (а не лише JS-push): нотифікація мусить показувати **істинний режим навіть поки JS заморожено** (failsafe-RTL у фоні).

**Adopt-гейт.** mode/armed лише з HEARTBEAT де `autopilot!=8 && type!=6` (`link.js:289`) — інакше GCS-heartbeat backpack-а виставить хибний режим.

**Flight-time / distance.** `flightSec` = `elapsedRealtime` since armed false→true, frozen on disarm. `distM` = equirectangular-інтеграція послідовних fix-ів **лише поки armed**, ігнор `<0.5 м` jitter і `>200 м` teleport (GPS-glitch/spoof); reset на новий arm / `missionState('running')`.

**Snapshot.** `data class {mode:Int, modeName:String, vehicleType, armed, battV, battPct, altM, gsMs, wpSeq, wpTotal, flightSec, distM, progressPct}`. Pure/offline, без WebView-залежності. Джерело для `getSnapshot()` (warm-seed HUD + native-truth stats-реконсиляція).

---

## 7. Персистентність

### 7.1 Таблиця ключів

| Ключ | Медіум | Стан | Зміст |
|---|---|---|---|
| `fmp_last_field` | localStorage | **змінено** | `{contour, exclusions, fieldId, name, ts}` (+ідентичність) |
| `fmp_session` | localStorage | наявний | `connType/addr/baud/wasConnected/resume/follow/tab` |
| `fmp_ble_last` | localStorage | наявний | BLE MAC |
| `fmp_flown` (FLOWN_KEY) | localStorage | **змінено** | `{route, home, rtl, lead, fieldId, name, wpTotal, status:'uploading'|'confirmed', ts}` (+home/hasRtl/wpTotal/status/identity) |
| `fmp_flightrec_active` | localStorage | **новий** | `{started_at, planned, work, bp_start, samples(last~600), sawComplete, wp_total}` — mirror in-flight |
| `fmp_log` | localStorage | наявний | діагностичний лог (`slice(-1000)`) |
| RESUME_KEY | localStorage | наявний | стан resume-remainder |
| `fmp_flightlog` (store `flights`) | IndexedDB | **змінено** | +`covered_ha, completion_pct, avg_speed_ms, swath_m`; `samples` дропнуто (const-гейт) |
| `fmp_fields` (store `fields`) | IndexedDB | **змінено** | тепер пишеться **на upload** (UPSERT), +`fieldId`; bounded |

Модульні змінні (не на диску, обчислюються раз): **`flownWpTotal`, `flownLead`** (усунення critical wp_total SSOT) — рахуються **один раз на upload з `items.length`** (`flownLead = 2+(hasSpeed?1:0)` для ArduPilot; `0` для INAV, reuse offset-логіки). Universal fallback: замінити `s.wp_total||0` (`app.js:3234`), передати в `NotifyBridge.setMission(name, flownWpTotal)`, лишити HUD-fallback (`:3497`). Wire `s.wp_total` — лише live-seq companion коли present, **ніколи як stored-знаменник**.

### 7.2 Порядок відновлення на буті (boot setTimeout, `app.js:1349-1413`)

1. `restoreLastField()` — contour+exclusions+**`currentFieldName` з identity**.
2. `restoreLastRoute(_routeSnap)` — маршрут без recompute (`app.js:1351`).
3. `flownRestore()` — `flownRoute/flownHome/flownHasRtl/flownWpTotal` + `status`. `clearRoute` (через adopt) **зберігає `flownRoute`** (`app.js:945`), і оскільки flown ще null під час кроків 1-2, field/route-restore не може його clobber-нути (restore-порядок sound).
4. `updateMissionStatus()` — **restored-unverified pill** («Остання відома місія — підключись і перевір»), гейт на identity-збіг, **НЕ зелена**.
5. `flightRecRestore()` — `flogHas(started_at)` dedup → інакше bank **partial** (never live-resume).
6. session-restore — form-поля (`app.js:1362-1408`).
7. `bootAutoReconnect(ss)` — single-shot, `mavConnecting`-guard, warm-probe `isOpen()` перш ніж `mavConnect`; гейт на Activity-resumed (Android FGS background-start).
8. **На першому успішному реконекті** → `verifyMission(flownRoute)`; лише при VERIFIED пілюля стає зеленою.

**Suspend-dispatcher (усунення major/contradiction перекриття lifecycle-хуків).** Усі hide/kill-хуки через **`addEventListener`** (не property-assignment, що clobber-ить). Єдиний ordered-дренаж `__fmpSuspendFlush()` з **одного** `pagehide` і **одного** `visibilitychange(hidden)`: **`flushLog()` → `flightRecPersist()` → native detach**. Native `onStop` викликає `__fmpSuspendFlush()` **синхронно до `pauseTimers()`**. Для freeze-without-pagehide — явний native→JS «about-to-suspend» bridge-виклик того ж дренажу.

---

## 8. Правило покриття площі

**Визначення завершеності (єдине, усунення major mission-complete threshold).** `lastCoverageSeq = flownWpTotal - 1 - (flownHasRtl?1:0)` (виключає trailing-RTL і lead home/takeoff/do_change_speed). `covComplete = sawComplete || (wr >= lastCoverageSeq) || (compFrac >= 0.90)`, де `wr = wp_reached` (foreground) **або native `wpSeq`** (background-substitute), `compFrac = lastCoverageSeq>0 ? min(1, wr/lastCoverageSeq) : 0`. Ця сама межа застосовується до notification-бару (max на last-coverage-wp; RTL — окремий returning-стан), JS-toast (`app.js:3446`) і `completion_pct`.

**Формула covered_ha.**
```
if (covComplete):
    covered_ha = work.area_ha            # планований контур поля (фіксоване рішення)
else:
    dist = ring_intact ? _distInField(samples, ring) : native_distM   # м
    covered_ha = min( dist * swath_m / 1e4 , area_ha )                 # capped
    approximate = used_native_distM      # флаг при background-hole
```

**Поля, що живлять правило:** `work.area_ha` (наявний, `app.js:1099`), `work.swath_m` (**новий**, з `#spacing`), `work.boundary/ring` (**новий**), `samples[]` (на finalize; при background-дірці — **native `distM`**), `wp_reached`/native `wpSeq` + `flownWpTotal` → completion.

**Guards.**
- `swath_m` truthy, інакше `covered_ha=null` («—»); `0 → null` (не divide/zero-area).
- `ring.length>=3`, інакше `_distInField` fallback на whole-track `_sampleDist` (все одно capped area_ha).
- `covComplete` vs partial — **взаємовиключні** (if/else) → немає intra-record double-count.
- **Cap `min(..., area_ha)`** — covered ніколи не перевищує поле.
- `wt>1` для `compFrac`, інакше partial; `actual_duration>0` для avg-speed (finalize early-return `<5 с`).

**Виправлення контракту хелперів (усунення major {lat,lon}/{lat,lng}).** Семпли зберігаються `{lat,**lon**}` (`app.js:3243`; `_sampleDist` читає `a.lon` `:3253`), а ring — `{lat,**lng**}`. Тому: `_pointInRing(lat, lon, ring)` бере **`lon`** семпла як x/lng-аргумент і читає **`ring[i].lng`**; `_distInField(samples, ring)` читає `sample.lon`. Інакше кожен `lng` семпла `undefined` → NaN-порівняння → жоден point не «inside» → `covered_ha===0` на **всіх** partial-польотах. Unit-assert: `_distInField` над відомим in-field-треком повертає `>0`.

**Крос-partial over-count (усунення minor).** `mavDisconnect→flightRecAbort` (`app.js:2955`) банить partial на кожному drop; auto-reconnect створює новий `started_at` → один фізичний виліт стає кількома partial, кожен зі своїм covered_ha у totals. Пом'якшення: `flogHas`-dedup (розділ 4.2) + примітка, що при native-substitution distance/covered беруться з монотонного native-акумулятора (розділ 4.5), тож transient-drop не фрагментує covered.

---

## 9. Тестування

**#1 verify (jsMav, SITL ArduCopter `~/sitl` + SpeedyBee INAV wing SITL).**
- Corrupt один WP (MAVProxy `wp`) → re-verify → **MISMATCH** з точним seq + метрова дельта (з cos(lat)), red.
- Normal upload → seq 0 (home overwritten) **НЕ** flag → green.
- INAV → legacy `MISSION_REQUEST`, seq 0 координати верифікуються, green.
- Bridge-only heartbeat (`tl.autopilot` null) + INAV → **статичний legacy-default завершує download** (не stall 0/N).
- Lossy-injection (drop частку `MISSION_ITEM`) → retry → VERIFIED; drop достатньо → **AMBER, ніколи green**.
- **try/catch:** інжектнути throw у diff-loop → AMBER (не RED, не green), `flownRoute` set.
- **verify під throttled poll:** тримати `mavPoll` на 2 Гц під pre-flight upload → підтвердити, що read-back (власні таймери) завершується (усунення missing).
- Battery-swap resume → read-back + три стани; `flownHome` derived.

**#2 persistence.**
- APK UDP cold: upload → force-stop → relaunch → restored-unverified pill, `bootAutoReconnect` rebind UDP без тапу, HUD unhide, **re-verify перед green**.
- Race: тап Connect + auto-timer одночасно → `mavConnecting`-guard → **один `MavLink`, без EADDRINUSE**.
- flown offline: upload → close → drone/Wi-Fi OFF → reopen → пілюля читає stale-стан з `fmp_flown` як **unverified**.
- `flownHome` round-trip: devtools → home present → RTL-leg/countdown коректні.
- Intent-marker: kill між ACK і flownSave → boot показує «ймовірно залито — перевір» (не «НЕ залито»).
- in-flight kill → reopen → `flightRecRestore` **завжди banks partial**, `flogHas`-dedup не перезаписує complete-запис.
- manual-disconnect guard: `wasConnected=false` → no auto-reconnect.

**#3 TelemetryService (SITL/backpack bench).**
- **JVM golden-vector test** `MavNotifyParser` проти кадрів з `mavlink.js encode`: усі 5 msg, **v2-truncated** (short SYS_STATUS без battery_remaining → **null, не 0%**; MISSION_CURRENT лише seq), CRC-corrupt → resync.
- UDP, екран OFF, `>10 хв` background → нотифікація тікає 1 Гц, recv триває (`adb logcat`), backpack стрімить (keep-alive replay).
- **Deep-Doze:** стаціонарний телефон, екран OFF, unplugged — **без** battery-opt exemption підтвердити, що телеметрія глушиться (обґрунтування load-bearing-exemption); **з** exemption — триває.
- USB `connectedDevice`: mission-track через `wp N/total`+бар.
- Lifecycle: disconnect → нотифікація+service зникають, локи звільнено (`dumpsys power/wifi`); swipe → живий; reboot → **не** рестартує (`START_NOT_STICKY`).
- Permission matrix: POST_NOTIFICATIONS granted/denied (лінк живий обидва); BLUETOOTH_CONNECT-флоу під FGS; **BLE FGS-старт лише після grant**.
- Warm re-attach: destroy+recreate WebView → `isOpen()` true → re-adopt без rebind, **без EADDRINUSE**, seed з `getSnapshot`.

**#4 contour.** Upload → named-record у `fmp_fields` (load/overview бачать). Re-upload того ж поля → **update, не duplicate**. Reopen → `currentFieldName` restored (не generic «поле»). Identity-mismatch → пілюля не green.

**#5 stats.** Empty-state (UA/EN). Complete flight → `completion_pct≈100`, `covered_ha===area_ha`, без badge. Partial → `covered_ha ≈ in-field_dist×0.020`, `≤area_ha`, «частк.»; HOME поза контуром → `_distInField` виключає transit-leg. **Background flight** → native-substitute distance/duration/completion, флаг approximate. No-plan AUTO → «—». Totals; avg-speed = `dist/dur*3.6`. Rotation (`FLOG_MAX_FLIGHTS=3` тимч.) → 3 найновіші. Samples dropped → запис без `samples`. Narrow-viewport → wrapper scroll-иться.

**#6.** Plan/Fly + disarmed 10 хв → **flat 2 Гц** (не адаптивно). HUD-diffing: лічильник style-writes ~0 у steady-state. Log-flush: JS-error → background(hidden) → foreground → export → pre-background рядки present; повтор `pagehide` на APK. **Regression:** anti-jam/anti-spoof firing під armed SITL із simulated GPS-dropout/jump — не зачеплено (flat 2 Гц).

---

## 10. Порядок реалізації

**Phase 0 — Reconcile Android tree.** Відновити `BleBridge.kt` + `PhotoBridge.kt` з живого дерева (інакше нічого не компілюється). Блокує Phase 4.

**Phase 1 — #1 verify (pure JS, найвища safety-цінність).** default-full + try/catch + три-станний render + статичний legacy-dialect + метри з cos(lat) + `#mav-verify-fast`. Тестується в SITL негайно.

**Phase 2 — #5 stats + #4 contour + covered-area (JS).** tab/render, `_distInField`/`_pointInRing` (виправлений {lat,lon}-контракт), `lastWorkContext.swath_m/boundary`, `flogTrim`, `fldPut`-on-upload UPSERT + `fieldId`-ідентичність, i18n.

**Phase 3 — #2 persistence (JS).** `flownSave(route,home,hasRtl)` + intent-marker + flownSave-перед-resumeClear, `flownRestore` + restored-unverified pill + re-verify-on-reconnect, `bootAutoReconnect` + `mavConnecting`-guard, `flightRecPersist`/`flightRecRestore`(always-partial)+`flogHas`, suspend-dispatcher.

**Phase 4 — #3 native (Android, залежить від Phase 0).** `TelemetryService` + `MavNotifyParser` + `NotifyBridge`, manifest-perms + service-декларація, Sink-рефактор bridges, локи (HIGH_PERF + MulticastLock-move), battery-opt-exemption-флоу, warm re-attach (`isOpen`+idempotent-open), link.js `setKeepAlive`.

**Phase 5 — #6 bounded opt (JS).** HUD render-diffing + log-flush (через suspend-dispatcher з Phase 3). Flat 2 Гц.

**Phase 6 — cross-cutting glue (лендиться з Phase 4).** `flownWpTotal`/`flownLead` SSOT (fallback у HUD/flightRec/NotifyBridge), notification distance-`%` (`setProgressPct`), completion=last-coverage-wp у трьох поверхнях, native-truth stats-реконсиляція (`getSnapshot` → distM/flightSec/wpSeq у запис).

### Що ПОЗА скоупом (YAGNI-cuts)
- Adaptive poll cadence (#6 change #2) — **flat 2 Гц**.
- #6 change #5 (skip HUD-writes при hidden fly-tab).
- Adaptive-dialect flip state-machine → замінено one-line статичним legacy-default.
- Структурований `diffs[]` + `seqToRouteIndex` + map-highlight mismatch-точки.
- `flightRec` live-resume гілка + 120 с поріг → **always-partial**.
- Track-on-map, CSV/GPX export у stats-tab (наявні JSON/CSV-кнопки в Політ-tab лишаються as-is).
- Pause/RTL action-кнопки в нотифікації.
- Desktop `/api/mav_upload_mission` verify-parity — **bench-only, незмінно**.
- `BOOT_COMPLETED` auto-restart (`START_NOT_STICKY` документовано).
- `fmp_flown` TTL (замість — restored-unverified pill + re-verify).
- Hard-delete семплів → за реверсивним `KEEP_SAMPLES`-гейтом.

---

## 11. Відкриті питання для Івана

1. **Battery-optimization exemption — коли просити?** first-launch / first-Connect / лише після detected background-kill. Це load-bearing для deep-Doze (телефон на борту, екран OFF) — компроміс «менше промптів vs надійність».
2. **`onTaskRemoved` при swipe-away:** тримати лінк+нотифікацію живими (рекомендовано, максимальна надійність) чи стопати (чисто, але ламає «не втратити телеметрію»)?
3. **WifiLock `HIGH_PERF` drain** прийнятний на цільових телефонах за 30-хв screen-off сесію, чи треба field-tune?
4. **Covered «complete»-джерело:** `work.area_ha` (фіксовано) vs `work.sprayed_ha` (агрономічно точніше — площа мінус edge-margin/exclusions). One-line зміна у finalize, якщо Іван віддає перевагу sprayed.
5. **`FLOG_MAX_FLIGHTS=300`** — прийнятний cap для очікуваного fleet-usage?
6. **USB per-device permission** надійно пам'ятається на цільових телефонах, чи auto-reconnect «cable» nag-атиме dialog на кожен reopen (тоді ґейтити за opt-in)?
7. **Notification layout:** стандартний `BigTextStyle` достатній для трьох груп полів, чи потрібен custom `RemoteViews`?

---

# ═══════════════════════════════════════
# ЧАСТИНА 2 — features #5-additions, #7–#13
# ═══════════════════════════════════════

# FMP — проєктна специфікація, ЧАСТИНА 2 (features #5-additions, #7–#13)

Продовження єдиної специфікації. Частина 1 (features #1–#6) — базовий контракт; тут описано лише **нове**. Скрізь, де логіка спирається на частину 1, дано посилання на її розділи (§4.1 verify, §4.2 persistence/auto-reconnect, §4.4 named-record + `{fieldId,name}`, §4.5 stats, §5 нотифікація, §6 MavNotifyParser, §7 персистентність, §8 covered-area, §10 фази). Мова коду/шляхів/MAVLink/Android API — англійська; решта — українська. Усі critical/major зауваження адверсарної рецензії усунено **всередині** дизайну (де вони конфліктували — обрано найбезпечніший варіант, причина в один рядок).

---

## A. Огляд part-2

- **#5-additions** — розширення вкладки «Статистика» (§4.5): колонка **Га/хв** на політ + плитка **Сер. Га/хв**, фільтр періоду (**з початку години / з початку дня / усе**), що перераховує всі агрегати, і виділена плитка **сумарної покритої площі** за обраний період. Чистий JS, без нових персист-полів.
- **#7** — MAVLink через **кабель до пульта EdgeTX/ELRS**: пресет «Пульт (EdgeTX/ELRS MAVLink)» поверх наявного `serial`-транспорту + baud, ELRS-толерантні таймаути заливки/verify; повна SETUP-інструкція (розділ D).
- **#8** — **прогрес по контуру** в Import-поверхні: `done_ha` / `remaining_ha` / `completed_count`, кредитування на finalize за join-ключем, ідентичним §4.4 (`{fieldId,name}`), дефолт — поточний цикл.
- **#9** — **перемикний шар смуг** (покриття/накладання/прогалини) поверх наявного `coverage_geo/overlap_geo` + опційний факт-оверлей пройденого треку.
- **#10** — **opt-in offline-first бекап** `fmp_fields`+`fmp_flightlog` на VPS Івана, креди санітизовані (публічний репо); **v1 — push-only** (див. розв'язання конфлікту).
- **#11** — **телеметрія на мапі** (карта в стилі DJI/XAG): той самий набір, що в §5-нотифікації, distance-based `%`, з єдиного пайплайну `lastStatus`+`mavProgressData`.
- **#12** — **безпечні транзитні шляхи** (вхід home→старт і повернення→home у межах поля-мінус-вирізи, visibility-graph+Dijkstra, shapely, fail-safe) + **backstop-геозона** в ArduPilot (MISSION_TYPE_FENCE upload+verify, v1 ArduPilot-only).
- **#13** — **маркери небезпек** (стовп-точка + ЛЕП-лінія) з дефолтним уникненням через exclusion-коридори + **експериментальний імпорт ЛЕП з OSM «для тесту»** (ніколи не авторитетне джерело).
- **Cross-cutting** — SITL-план для **resume-after-manual-RTL** (валідує §4.2) і **дизайн-система**, застосована до кожної нової поверхні (розділ F).

---

## B. Дизайн по підсистемах

### B.5 #5-additions — Га/хв + фільтр періоду + сумарна площа (розширення §4.5)

**Корінь/поведінка.** §4.5 постачає 4-ту вкладку `data-tab='stats'`, `renderFlightStats()` (~`app.js:3223`), і зберігає в записі польоту top-level `covered_ha` (capped `area_ha`, §8) + `actual.duration_s` + `started_at` (epoch-ms keyPath). Бракує: (a) продуктивності Га/хв на політ і в середньому; (b) фільтра періоду, що перераховує **всі** агрегати; (c) виділеної сумарної покритої площі за період. Усе це — похідне від уже наявних полів; **нових персист-полів не додаємо** (це збіглося б з §7.1-схемою, яку заборонено чіпати).

**Конкретні зміни.**
- `app.js` ~`:3187-3223` (біля `flogAll`): додати модульний `let statsRange='all';` і чистий `_statsRangeFloor(r)` → epoch-ms floor з **локального** `Date` (`setMinutes(0,0,0)` для `'hour'`, `setHours(0,0,0,0)` для `'day'`, `0` для `'all'`), напряму порівнюваний з `rec.started_at`.
- `app.js` біля `_sampleDist` (~`:3248`): `_haPerMin(rec)` → `covered_ha/(duration_s/60)`, `null` коли `covered_ha==null || duration_s<=0` (рендер «—», ніколи NaN/Infinity; `duration_s<5` уже відкинуто в finalize `:3261`).
- `renderFlightStats()` (~`:3223`) — переписати тіло filter→aggregate→render: `const rows=(await flogAll()).filter(r=>r.started_at>=_statsRangeFloor(statsRange)).sort((a,b)=>b.started_at-a.started_at);`. Агрегувати **по відфільтрованих**: `secTot`, `distTot`, і — **лише по польотах із `covered_ha!=null`** — `covTot` та `covDurMin`; `avgHaMin = covDurMin>0 ? covTot/covDurMin : null`. Це ratio-of-sums (продуктивність), не спотворена короткими вильотами; знаменник — **робочі хвилини покритих польотів**, НЕ плитка «Годин» (та рахує кожен політ, зокрема raw без плану).
- **Рядок чіпів періоду** на самому верху innerHTML (поза empty-state-гілкою, щоб чіпи не зникали на порожньому періоді): три `<button class="chip" data-range="hour|day|all">` з `active`+`aria-pressed`, стиль сегмент-контролу як `.tab.active` (див. F).
- **Totals-strip = 5 плиток** (`flex-wrap`): Польотів / Годин / Кілометрів / **Покрито (га) — виділена** / **Сер. Га/хв**. *(Розв'язання UX-major: §4.5 віддавала 4 плитки й `repeat(4,1fr)` — це недобір. Тут повний набір із 5, а грід переходить на `repeat(auto-fit, minmax(88px,1fr))`, щоб на 320 px рефлоу був чистим 3+2, а не сирота у другому рядку. Плитка «Покрито» — headline: більший шрифт, акцент `--ok`.)*
- **Таблиця**: додати 8-му колонку `Га/хв` ПІСЛЯ «Сер. швидкість»; клітинка `_haPerMin(r)` з префіксом `~` для `r.approximate` (фоновий політ, native-substituted §4.5), «—» коли немає `covered_ha`. Зберегти `overflow-x:auto`-wrapper §4.5.
- **Делегований listener** на стабільній панелі `#tab-stats` (створена раз у index.html, §4.5): `closest('[data-range]')`→`statsRange=…; renderFlightStats();`. **Обов'язково на `#tab-stats`, НЕ на `#flight-stats`** (її innerHTML перезаписується щорендеру → per-chip хендлери гинуть).
- `i18n.js` (~`:289-293`): UA→EN `Га/хв→ha/min`, `Польотів→Flights`, `Годин→Hours`, `Кілометрів→Kilometres`, `Покрито→Covered`, `Сер. Га/хв→Avg ha/min`, `з початку години→This hour`, `з початку дня→Today`, `усе→All`, `Немає польотів за обраний період.→No flights in the selected period.`.

**Нові/змінені компоненти.** `statsRange`+`_statsRangeFloor`; `_haPerMin`; чіпи періоду + делегований хендлер; розширене тіло `renderFlightStats` (5 плиток, 8 колонок).

**Крайові випадки.** Порожній період → per-period повідомлення + **видимі чіпи** (щоб розширити на «усе»); нема жодного запису → глобальний empty-state §4.5. `covered_ha===null` → «—», політ **виключено** з `covTot`/`covDurMin` (не інфлейтить/дефлейтить середнє). Cross-midnight політ (23:58→00:20) ключується на `started_at` → потрапляє в попередній день (документовано). Rapid chip-taps під час async-рендеру: `statsRange` читається на старті кожного рендеру, last-write-wins.

**Ризики.** `enUnits()` (`app.js:1216`) мапить ` га`→` ha` — тому Га/хв **як голе число**, одиниця лише в перекладеному заголовку/лейблі (інакше `0.35 га/хв`→`0.35 ha/хв`). `statsRange` in-memory, скидається на `'all'` при reload (прийнятно для read-only). `flightRecFinalize` (`:3256`) **не чіпаємо** — жодного нового поля.

---

### B.7 #7 — MAVLink через кабель до пульта EdgeTX/ELRS

**Корінь/поведінка.** `serial`-транспорт уже несе EdgeTX: `device_filter.xml:4` вайтлистить VID `0x0483` (STM32 VCP), `SerialBridge.kt` веде CDC-ACM, `jsMav.mav_connect` (`app.js:2441-2446`) відкриває через `openAndroidSerial(conn, baud)`, baud `"auto"`→115200 (`:2445`). Mission-protocol у `link.js` **уже ELRS-hardened**: request-driven self-pacing, per-item resend ArduPilot (`RESEND_GAP=500`, `:499-502`), re-COUNT для INAV (`:485-498`), `REQUEST_LIST` re-announce (`:563-567`), per-item re-request на download (`:574-590`), `_pauseStreams()` звільняє uplink на час handshake (`:393`). Реальна прогалина для ще-вужчого ELRS-кабельного режиму — **не нова retry-логіка** (вона є), а лише (a) лейбл-пресет і (b) довші no-progress-вікна + verify-cap, threaded коли пресет активний.

**Пастка, яку треба закрити разом із пресетом (load-bearing).** `mavConnString` (`:2885-2890`) і `mavSyncRows` (`:2606-2612`) перелічують cable-class значення явно, а решту скидають у **udp**. Тому «просто додати `<option value=handset>`» = тихо відкрити UDP-сокет із мережевим рядком. Пресет = **опція + 3 рядки аліасу в mavSyncRows + 1 рядок у mavConnString + baud-seed + narrow-профіль**.

**Конкретні зміни.**
- `index.html` після cable-опції (`:147`): `<option value="handset">Пульт (EdgeTX/ELRS MAVLink)</option>`; підказка в `#mav-cable-row`, видима лише для handset: «Пульт EdgeTX по USB: USB Mode = Serial (VCP), порт пульта = MAVLink, ELRS 3.5+ у MAVLink. Швидкість каналу задає ELRS, не baud».
- `app.js` `mavSyncRows()`: `:2606` `t==="cable"`→`(t==="cable"||t==="handset")`; `:2607` додати `||t==="handset"`; `:2612` додати `&& t!=="handset"`. **Усі три — інакше handset ховає COM-рядок і сідить UDP-адресу.**
- `app.js` `mavConnString()` `:2885`: `if (t==="cable"||t==="handset") return $("mav-port").value;` — без udp/tcp/ble-префікса → `mav_connect` входить у Android serial-гілку (`:2441`) / desktop Web Serial (`:2447`), не udp.
- `app.js` conn-type change-listener (біля `:1389-1390`): на `handset` seed baud `115200` + `dispatchEvent('change')` (персист у `fmp_session` через наявний handler `:1396`). **Поза `mavSyncRows`**, щоб restore/initial не clobber-или; `ss.baud` restore-иться ПІСЛЯ connType (`:1395` після `:1366`), тож пізніший кастомний baud користувача round-trip-иться.
- `app.js` module scope + `mavConnect`-success (~`:2906-2923`) + `mavDisconnect` (~`:2941`): `let mavNarrowLink=false;`; set `= ($("mav-conn-type").value==="handset")` на успіху, reset у disconnect.
- `app.js` `mavUpload()` (~`:3631`) і `resumeUploadRemainder()` (~`:3694`): додати `narrow: mavNarrowLink` в обидва `a.mav_upload_mission({...})` (additive до §4.1-правок тих самих call-site).
- `app.js` `jsMav.mav_upload_mission` `:2504`: `uploadMission(items, (p&&p.narrow)?60000:undefined, ...)`; verify-блок (§4.1 default-full) `verifyMission(items, (p&&p.narrow)?120000:60000)`. Довше **no-progress**-вікно (не hard-cap: `:434-441`) — щоб живий-але-повільний ELRS не оголосили мертвим; більший verify read-back — щоб повний byte-for-byte read-back встиг замість §4.1 AMBER «verify-incomplete». *(Merge з §4.1: default-full verify лишається, тут лише розширюємо cap для narrow — не конфліктні hunk-и.)*
- `app.js` `jsMav.mav_download_mission` `:2477`: `_mavLink.downloadMission(mavNarrowLink ? 60000 : undefined)` — standalone «Що залито в дрон» теж на толерантному вікні.
- `app.js` `bootAutoReconnect(ss)` (§4.2-заміна BLE-only `:1374-1379`): додати `handset`-case, оброблений **ідентично cable** (Android → `mav_list_ports`+single `mavConnect`, гейт `mavConnecting`+Activity-resumed; desktop Web Serial → SKIP, індекси портів не переживають reload). Без цього warm/cold auto-reconnect для пресету не спрацьовує.

**Нові/змінені компоненти.** `handset`-пресет (cable-class аліас); `mavNarrowLink`-профіль-прапор (IIFE scope).

**Крайові випадки.** Desktop Web Serial: пульт enumerates як serial-порт → працює через `:2447`; але як cable, auto-reopen пропускається (індекси не переживають reload). USB Mode=Joystick/Storage → CDC-порт не з'явиться → наявна нота «USB-пристрій не знайдено…» (`:2387`). ELRS<3.5 / MAVLink off → порт відкритий, heartbeat не йде → «з'єднання відкрито, але heartbeat не отримано» (`link.js:214`), а upload → ELRS-помилка «0/N … канал замалий» (`link.js:475`). INAV+ELRS: `_pauseStreams` навмисно пропущено (`:397`) → телеметрія контендить з uplink; 60 с stall + re-COUNT (`:485-498`) — найгірший кейс, найімовірніший 12-restart abort (`:493`). **Fence-over-ELRS (#12)** — окрема друга MISSION-передача → airtime ~×2 (див. B.12, той самий narrow-профіль).

**Ризики.** Load-bearing аліас (усі 4 правки разом). Довші вікна затримують вердикт «мертвий»: dead ELRS тепер до 60 с (upload) / 120 с (verify) — прийнятно за live N/total-прогресу. Change layered ON TOP §4.1 — merge coherently. Навіть 120 с verify може не встигнути на слабкому лінку → §4.1 AMBER + `#mav-verify-fast` count-only лишаються safety-net.

---

### B.8 #8 — Прогрес по контуру в Import-поверхні

**Корінь/поведінка.** `fmp_fields` (IndexedDB, keyPath `name`, `fldOpen` `:1783`) знає геометрію/площу; `fmp_flightlog` знає, скільки пролетіли (+ `covered_ha`/`covComplete` після §4.5). Місток між ними — ідентичність `{fieldId,name}` з §4.4. #8 споживає її, щоб кредитувати кожен завершений політ його контуру.

**Виправлення поверхні (UX-major).** «saved-fields list» — це **НЕ HTML-список**. Поля сурфейсяться двома шляхами: (1) `showSavedFields` (`:1856`) малює полігони + divIcon area-label «`<name><br>N.NN га`» **на Leaflet-мапі** (`:1873-1876`); (2) `load-project` (`:1908-1934`) будує **`prompt()`-текст** «`N. name · area га · date`» (`:1915-1919`). Тому прогрес показуємо в **divIcon-тексті + prompt-суфіксі**, а **не** в `.stats`-картці з `.fmp-bar` (такої поверхні немає). *(Дизайн-система §5 помилково спеціфікувала картку з баром для неіснуючого «Import list» — тут узгоджено з реальним деревом. Окрема HTML-панель полів = свідома scope-addition, винесено у відкриті питання.)*

**Конкретні зміни.**
- **Запис `fmp_fields`** — save-project rec (`:1900-1901`) І §4.4 upload-UPSERT: `+{done_ha:0, completed_count:0, last_flight_at:null}`. **CRITICAL cross-dep:** §4.4 upload-UPSERT мусить **MERGE-preserve** ці три поля (`fldGet` перед overwrite геометрії/params/fieldId), інакше кожен re-upload скидає прогрес циклу в 0.
- `app.js` новий `fldGet(name)` біля `fldAll` (`:1799`): читання одного запису по keyPath (null якщо нема/IDB недоступна). Потрібен UPSERT'у і `fieldProgressCredit`.
- `app.js` `flightRecTick` init (`:3230-3234`): зафіксувати ідентичність **на ARM-час** (не на finalize): `f=flownLoad(); flightRec.field_id=(f&&f.fieldId)||null; flightRec.field_name=(f&&f.name)||(lastWorkContext&&lastWorkContext.field)||'';`. Політ належить тому, що **реально залито/летіли** (`fmp_flown`), а `currentFieldName` може змінитись між upload і disarm.
- `app.js` `flightRecFinalize` після `flogPut` (`:3275`): `await fieldProgressCredit(fr, covered_ha, covComplete);` — reuse §4.5/§8 `covered_ha`/`covComplete` (НЕ перераховувати). **Після `flogPut`**, щоб фейл-write не кредитував прогрес. **#10-consistency:** тут-таки, коли #8 мутує запис поля, **виставити `rec.updated=Date.now()` перед `fldPut`** (інакше #10 LWW відкине новий прогрес).
- `app.js` новий `fieldProgressCredit(fr, coveredHa, covComplete)` (~`:3280`): `name=fr.field_name||fr.work.field; if(!name||name==='поле'||coveredHa==null) return; rec=await fldGet(name); if(!rec) return; if(rec.fieldId&&fr.field_id&&rec.fieldId!==fr.field_id) return;` (recycled `Поле N` → інше поле, skip); `if(covComplete){ rec.completed_count++; rec.done_ha=0; } else { rec.done_ha+=coveredHa; } rec.last_flight_at=fr.ended_at; rec.updated=Date.now(); await fldPut(rec);`.
- `app.js` `showSavedFields` divIcon (`:1873-1876`): три рядки прогресу; `doneHa=+(r.done_ha||0); leftHa=Math.max(0,(r.area_ha||0)-doneHa); cc=r.completed_count|0;` → «`<b>name</b><br>N.NN га<br>зроблено X.X · залишилось Y.Y<br>виконано: cc plurCount(cc)`»; iconSize `[170,64]`, iconAnchor `[85,32]`. `leftHa` clamp ≥0; `doneHa` НЕ capped (кумулятивні partial у циклі можуть перевищити `area_ha`).
- `app.js` `load-project` line-builder (`:1915-1919`): суфікс « · `dn`/`area` га · ×`cc`».
- `app.js` новий `plurCount(n)` біля `tf/enUnits` (~`:1228`): UA 1→«раз», 2-4→«рази», 5+/11-14→«разів»; EN → `time/times`.
- `i18n.js` (після `:293`): `зроблено {0} га→done {0} ha`, `залишилось {0} га→left {0} ha`, `виконано повністю: {0}→completed fully: {0}` (одиниці baked у EN-бік, бо divIcon будується поза `enUnits`).
- `style.css` `.area-label.field span` (`:338`): `white-space:normal; line-height:1.25`, розмір під 4 рядки (щоб не clip проти `[170,64]`).

**Нові/змінені компоненти.** `fldGet`; `fieldProgressCredit`; `plurCount`; поля запису `{done_ha, completed_count, last_flight_at}`.

**Крайові випадки.** Свіже поле без upload → запису ще нема (§4.4 мінтить на upload). Legacy-запис без трьох полів → дефолти 0/0/`area_ha`, без міграції. Raw/no-plan політ (`covered_ha==null`) → early-return. Recycled `Поле N` на інше поле → `fieldId`-gate skip. Complete → `completed_count++` і `done_ha=0` у тому ж finalize (наступний цикл з 0). In-flight kill→reopen → §4.2 `flightRecRestore` банкує partial **один раз** (`flogHas` dedup) → credit рівно раз. IDB недоступна → `fldGet/fldPut` no-op.

**Ризики.** Дотик до shared save-path і finalize hot-exit — **additive** (нові поля 0/null; новий виклик після `flogPut`). Залежить від §4.4 (merge-preserve UPSERT) і §4.5/§8 — лендиться ПІСЛЯ Phase 2. Мульти-disconnect фрагментація over-count-ить `done_ha` (документований residual, як §8-totals) — `done_ha` індикатор, не білінг. Density на малих екранах — mitigated §8-sizing + дублюванням у prompt.

---

### B.9 #9 — Перемикний шар смуг (покриття / прогалини / накладання)

**Корінь/поведінка.** Смуги **вже** є: `coverage_overlap_geo(home, wps, spacing, rtl, max_segments=900)` (`coverage.py:1039`) буферить увесь шлях на `spacing/2` (flat-cap) і повертає `{coverage, overlap}`; `api.py:216-217/280-281` віддає `coverage_geo/overlap_geo` під `params.get('viz')`; `app.js:1123-1143` малює cyan `#00c2ff@0.35` + red `#ff3b30@0.30` (interactive:false, deferred paint) на спільному `L.canvas` (`:156-165`); toggle `#viz-coverage` (`index.html:101`, персист `:1732`). Реальна дельта: (1) **прогалини**; (2) опційний факт-оверлей треку; (3) toggle без повного rebuild.

**CRITICAL geometry-фікс (розв'язання суперечності «gaps неможливі»).** Half-width `r=spacing/2` при кроці рівно `spacing` → сусідні проходи **стикаються** з нульовою прогалиною І нульовим накладанням для будь-якого spacing → між-прохідні прогалини **геометрично неможливі**. Тому вводимо **фізичну ширину факела `boom_m`, незалежну від кроку `spacing`**:
- `boom_m` — новий параметр (input `#boom`), **дефолт = `spacing`** коли не заданий (поведінка не змінюється, бо стик-у-стик проходи справді не мають прогалин — це коректно).
- Прогалини рахуються проти `buffer(path, boom_m/2)`, накладання — так само. Тоді `spacing > boom_m` → **справжні видимі прогалини** (саме та помилка оператора, яку фіча ловить), `spacing < boom_m` → справжнє накладання.
- Covered-area (§8) у v1 **лишається на `work.swath_m = spacing`** (частину 1 не чіпаємо); уніфікація covered на `boom_m` — one-line зміна, винесена у відкриті питання. Howto відповідно переписано: «прогалини з'являються, коли ширина факела **менша** за крок».

**Конкретні зміни (engine).**
- `coverage.py` `coverage_overlap_geo` (`:1039`): нові kwargs `boundary=None, exclusions=None, cover=None, boom=None, gap_min_area=None, gap_feather=None`; `half = (boom if boom else spacing)/2`. Backward-compatible: коли нові kwargs None — coverage/overlap байт-ідентичні.
  - **Проєкція — той самий home-frame** (`lat0,lon0` з `:1049`), **НЕ `_free_polygon`** (він репроєктує навколо centroid → mismatch, клас §8-багу).
  - **Exclusion-subtraction (major-фікс):** `clip = cover_poly.difference(unary_union(exclusion_polys)).buffer(0)` — **завжди unary_union, НЕ holes-constructor** (holes-форма дає невалідний Polygon, коли виріз торкається/перетинає межу cover → try/except ковтає → шар зникає). Це збігається з наявним `_free_polygon` (`:907`).
  - **Feather-фікс (major):** ерозію крайового пера робити **лише проти зовнішньої межі**: `clip_e = cover_poly.buffer(-feather).difference(unary_union(exclusion_polys))` (спершу стиснути cover, ПОТІМ віднімати вирізи), щоб негативний буфер **не роздував** exclusion-дірки і не з'їдав exclusion-hugging прогалини. `feather = gap_feather if set else min(0.3*half, 2.0)`.
  - `gap_geom = clip_e.difference(band)`; дропнути sliver < `gap_min_area if set else max(1.0, 0.05*spacing*spacing)`; `gap_ha = gap_geom.area/1e4`.
  - **Band — тільки з проходів (minor-фікс):** буферити `wps` (проходи), **НЕ** `[home]+wps+[home]` для gap-обчислення, бо на plan-час home = centroid (справжній home лише на upload, §12) → фіктивні lead-in/RTL-леги замалювали б реальні прогалини. (coverage/overlap можна лишити на повному шляху; gap — лише проходи.)
  - Guard увесь shapely в try/except → `[]`.
- `coverage.py` `rings()` (`:1074-1087`): `p = p.simplify(max(0.5, 0.05*spacing))` у локальних метрах перед lat/lon — для coverage/overlap/gap. Кап vertex-count на великих/OSM-полях (<~0.5-1 м похибки).
- `api.py` `build_route` (`:216-217`): `coverage_overlap_geo(ov_home, wps, spacing, rtl=rtl, boundary=boundary, exclusions=exclusions, cover=cover, boom=boom)`. `:280-281`: `+{"gap_geo": (spray_geo or {}).get("gaps"), "gap_ha": (spray_geo or {}).get("gap_ha")}`.

**Конкретні зміни (JS).**
- `app.js` ~`:472-473`: `let gapLayer=null;` (+ опційно `actualCoverageLayer`).
- `app.js` `:1123-1143` (третя гілка): magenta gap-featureGroup (interactive:false) над cyan, під route-line/markers (`:1140-1141`); додати `gapLayer` у trigger-умову `:1123`. **Колір/енкодинг** — див. F: gap = **амбер `#ffd166` або hatched** (не magenta), щоб відрізнятись від red-overlap і бути читабельним для colour-blind на зеленому супутнику.
- `app.js` `clearRoute` keepViz-teardown (`:957-960`): `if(gapLayer){map.removeLayer(gapLayer);gapLayer=null;}`.
- `app.js` stats innerHTML (`:1183-1184`): `+ (res.gap_ha>0.001 ? row('Прогалини', res.gap_ha.toFixed(3)+' га') : '')`.
- `app.js` **cache-and-toggle** (`:1418-1420`): кешувати `lastViz={coverage_geo,overlap_geo,gap_geo}` на build; toggle додає/знімає featureGroups без engine-run; повний rebuild лише коли кеша нема; reset `lastViz` у `clearRoute` (інакше stale-смуга на новому полі). *(Прибирає multi-second overlap-heading-search на телефоні лише щоб показати/сховати детерміновану геометрію.)*
- `index.html` label (`:101-102`): «Показувати смуги: покриття · прогалини · накладання»; `#boom` input (дефолт порожній → = spacing).
- `i18n.js`: `Прогалини→Gaps`, `Прогалини — пропущено (не оброблено)→Gaps — missed (unsprayed)`, новий label.

**Опційний факт-оверлей (Phase-2).** `flown_coverage_geo(track, boom, boundary, exclusions)` — буферить **сирий** flown-track (без синтетичного home/RTL), `gaps = field.difference(actual_band)`; міст через `engine-worker.js`/`engine.js` generic-dispatch (див. §12 `FMP_ENGINE.call`); рендер `actualCoverageLayer` (green `#5fd3a3@0.3`) під opt-in toggle. **Залежність:** §4.5 має `KEEP_SAMPLES=false` (drop `samples`) → з історії реконструкція не працює; лише in-session live `droneTrack` (`:3578`). Тому — Phase-2, поза v1 (консистентно з §5 track-out-of-scope).

**Нові/змінені компоненти.** `gap_geo/gap_ha`; `boom_m`-параметр; `gapLayer`; `rings()`-simplify; `lastViz` cache-and-toggle; (opt) `flown_coverage_geo`+`FMP_ENGINE.flownCoverage`.

**Крайові випадки.** `margin>0`: gaps clipped до `cover` (не `boundary`), щоб намірений незасіяний бордюр НЕ фарбувався (інакше кожен build — страшне кільце по краю). Feather ковтає centred-pass edge. Дуже велике/густе OSM-поле: overlap уже skip за `max_segments=900`; gap — один difference, але sliver-drop+simplify кап. `viz=false` на live angle-drag: `clearRoute(keepViz)` тримає останній gap-шар. Stale engine без gap-підтримки: `res.gap_geo undefined` → no-op.

**Ризики.** Colour-collision (gap vs overlap vs hazard-amber) — вирішується у F (амбер/hatched + легенда). Третій напівпрозорий шар підвищує paint-cost — mitigated shared canvas + interactive:false + deferred + engine-simplify + sliver-drop; заміряти на цільовому Android. Зміна сигнатури `coverage_overlap_geo` — kwargs optional/None → desktop `/api` байт-ідентичний; golden-test на відомому полі.

---

### B.10 #10 — Opt-in offline-first бекап полів+журналу на VPS

**Корінь/поведінка.** Сьогодні `fmp_fields` (keyPath `name`) і `fmp_flightlog` (keyPath `started_at`, append-only, immutable після finalize — **немає `updated`**) — строго device-local. Store-and-forward існує лише для діагностичного `fmp_log` і **push-only** через три транспорт-tier-и (`uploadLogToServer` `:3858`): PWA `fetch(API_BASE+"/api/log",{credentials:"include"})`; APK `window.AndroidLog.upload` → `LogBridge.kt` нативний POST з basic-auth (обхід CORS); iOS `fmpLog`. Санітизація підтверджена (§ afp-github-public): `VPS_BASE=""` (`:24`), `LogBridge/UpdateBridge` URL/AUTH порожні, `config.local.js` gitignored (`.gitignore:57`).

**Розв'язання safety-major (конфлікт: bidirectional reconcile vs push-only).** Оригінальний #10-дизайн — двобічний LWW-reconcile з **pull**, що `fldPut(srv)` коли `srv.updated>local.updated`. Але: (1) `serve.py` **не має власної auth** (покладається на Caddy), bucket single-tenant; mis-timestamped/отруєний запис міг би **тихо переписати геометрію поля**, яку потім летять; (2) `fmp_flightlog` не має `updated` → LWW там безглуздий (flights — append-only union). **Обираю найбезпечніше: v1 = PUSH-ONLY бекап.** Причина в один рядок: pull-LWW може мовчки перезаписати flyable-геометрію — неприйнятно для бекапу. Відновлення — **явна ручна дія** «Відновити з сервера», що імпортує серверні поля як **копії** (`name (сервер)`), ніколи не clobber-ить локальний запис, з confirm-діалогом. Це зберігає і бекап, і desktop-review, і fresh-phone-restore — без silent-overwrite.

**Конкретні зміни.**
- `app.js` ~`:24`: `const SYNC_BASE = window.FMP_SYNC_BASE || VPS_BASE || API_BASE;` (референсити **лениво** всередині sync-fn після `:991`); `const SYNC_TRANSPORT_NATIVE = IS_ANDROID && window.AndroidSync;`. Порожній base → sync повний no-op (публічний build, нуль egress).
- `index.html` перед `app.js` (`:306-315`): `<script src="config.local.js"></script>` (gitignored, 404-safe; CSP `script-src 'self'` дозволяє).
- `app.js` sync-модуль після `flogAll` (~`:3223`): `syncEnabled()/setSyncEnabled(b)` (localStorage `fmp_sync_enabled`, default **OFF**); `gatherLocal()`→`{fields:(await fldAll())||[], flights:(await flogAll()).map(strip samples)}`; **`syncPush(reason)`** гейт `if(!syncEnabled()||navigator.onLine===false||_syncing||(lastStatus&&lastStatus.armed))return;` + in-flight+min-interval throttle (форма `maybeAutoUploadLog` `:3924`); payload `{device:deviceId(), app:APP_VERSION, fields, flights}`; на `{ok}` → персист `fmp_sync_last={ts,nf,mf}`, clear `fmp_sync_dirty`; `markSyncDirty()` → localStorage `'1'` + debounced push; `syncSend(payload)` → native `window.AndroidSync.push(JSON.stringify(payload))`+`window.__syncResult` (13 с timeout, дзеркало `__logUploadResult`) або `fetch(SYNC_BASE+"/api/sync",{method:"POST",headers,body,credentials:"include"})`.
- `app.js` **`syncRestore()`** (ручна кнопка): `fetch`/native GET merged set → **імпорт як копії** (rename-on-collision), НЕ overwrite; confirm перед кожним imported field, що вже існує локально.
- `app.js` тригери `markSyncDirty`: `flightRecFinalize` після `flogPut` (`:3275`); field save (`:1904`)/§4.4 promotion/delete (`:1926`). **#8-consistency:** `updated=Date.now()` виставляти всюди, де #8 мутує `done_ha`/`completed_count`/`last_flight_at` (інакше нічого не сфіксувати; тут — щоб push ніс свіжий прогрес).
- `app.js` lifecycle: `online`+`visibilitychange→visible` → `if(dirty) syncPush('resume')`; `setInterval(()=>syncPush('interval'),60000)` (лише enabled+online+dirty+!armed); best-effort push у §7.2 `__fmpSuspendFlush()`.
- `index.html` tab-app (після update-контролів ~`:250`): `#sync-enabled` toggle, `#sync-now` button, `#sync-restore` button, `#sync-status`; група схована коли `SYNC_BASE` без сервера.
- `i18n.js`: UA→EN для sync-написів.
- `android/.../SyncBridge.kt` (**новий**): дзеркало `LogBridge` — `companion { URL_BASE=""; AUTH="" }`; `@JavascriptInterface push(json):String` → off-thread нативний POST `URL_BASE+"/api/sync"` з `Authorization: Basic` + `__syncResult`. **Без нативної disk-queue** (retry в JS, IndexedDB — джерело істини). URL/AUTH будуються нативно, ніколи з JS.
- `android/.../MainActivity.kt` (`:148-149`): `addJavascriptInterface(SyncBridge(this,webView),"AndroidSync")`.
- `serve.py`: `/api/sync` до підвищеного body-cap (`cap = 8_000_000 if self.path in ('/api/import_photo','/api/sync') else 1_000_000`); route біля `/api/log` (~`:411`), bypass Api+global-lock як log; новий `_store_sync(payload)` (біля `_store_log` `:364`): single-tenant bucket `logs/sync/fleet/`, load `fields.json`+`flights.json`, MERGE incoming (fields by `fieldId||name` max `updated`; flights union by `(started_at,device)`), cap ~200 fields / 300 flights, atomic `tmp+os.replace`, санітизувати будь-який id у шляху regex `_store_log`. GET-варіант повертає merged set для `syncRestore`.
- `ios/App/ViewController.swift`: DEFERRED — `SYNC_URL=""` + `fmpSync`-handler.

**Нові/змінені компоненти.** `SyncBridge.kt`; JS sync-модуль (push+ручний restore); `serve.py _store_sync`+`/api/sync`; Sync-UI; (deferred) iOS `fmpSync`.

**Крайові випадки.** Приватний режим → `fldAll()` null → gatherLocal degrade → no-op. Offline → skip+dirty+retry. Публічний build (порожній base) → sync вимкнено, нуль egress, UI-група схована — **security-default**. Payload > cap → 8 MB + record-caps (після §4.5 drop-samples flights ~300B). Same-ms `started_at` на двох девайсах → composite `(started_at,device)` key на сервері тримає обидва. VPS down/5xx → dirty лишається, UI «не синхронізовано».

**Ризики.** SECURITY (публічний репо): будь-який реальний URL/basic-auth у коміті = leak → grep перед push; публічний build **нуль sync-egress**. Disk-fill — дзеркало `_store_log` caps + single-tenant. Deploy-coupling: `/api/sync` має бути на VPS так само, як `/api/log` (`LogBridge` працює → collector існує; підтвердити, що це `serve.py` за Caddy). Cross-origin desktop-local `serve.py`→remote VPS **поза скоупом** — desktop-review через VPS-hosted PWA (same-origin) або читання файлів.

**YAGNI-cut для v1:** iOS-паритет, delta `since`-cursor, tombstone/delete-propagation, per-device provenance UI, config.local.js-loader-vs-const — усе deferred до конкретної потреби. v1 = push fields+flights + ручний restore-as-copies.

---

### B.11 #11 — Телеметрія на мапі (overlay-картка)

**Корінь/поведінка.** Live-телеметрія рендериться лише в Fly-tab HUD (`#mav-hud`, `.stats`-картка в aside). `mavPoll` (`:2987`) читає `s=await a.mav_status()`→`lastStatus` (`:2316`), `:3012` кличе `mavRenderHud(s)`. `mavRenderHud` (`:3367-3400`) кличе `mavProgressData(s)` рівно раз (`:3392`, єдиний call-site `:3483`) — а вона має **side-effects** (target-marker `mavUpdateTarget/mavClearTarget` + `mavCountdown`) і повертає `{pct,...}`, де `pct` — distance-based `(totalLen-rem)/totalLen*100` (`:3514-3515`), **та сама метрика**, що §5-нотифікація штовхає через `setProgressPct`. Мапа вже хостить absolutely-positioned дітей `map.getContainer()` (elev-badge `:337`, importPickBtn `:2151`) і L.Control-кнопки (LocateControl `:281`, FollowControl `:300`, topleft, `.active`, session-persist `:1406-1407`). HUD render-diffing є в `hudSet` (`:3359-3366`). `mavPoll` hard-stop на `document.hidden` (`:2967,:2978-2981`).

**Єдина структурна зміна.** **Hoist** єдиного `mavProgressData(s)` з `mavRenderHud` **вгору в `mavPoll`**, і fan-out `p` в обидва рендери — щоб side-effects (target-marker + countdown) спрацьовували **рівно раз/poll**. `mavRenderHud(s,p)` лишається рендером панелі байт-у-байт; новий `mavOverlayRender(s,p)` — writer оверлею.

**Конкретні зміни.**
- `app.js` `mavPoll` `:3012`: `const p=mavProgressData(s); mavRenderHud(s,p); mavOverlayRender(s,p);`.
- `app.js` `mavRenderHud` `:3392`: **видалити** локальний `const p=mavProgressData(s)`, читати параметр (кожен `hudSet` незмінний → HUD байт-у-байт).
- `app.js` новий `mavOverlayEnsure()` (дзеркало `mavHudEnsure` `:3340`): `L.DomUtil.create('div','map-card mav-overlay hidden', map.getContainer())`; фіксований скелет — header (link-dot + MODE + ARMED-badge), progress-блок (bar `.fmp-bar` + `pct%` + `wp N/total`), 3-chip strip (Battery V·%, Alt m, GS m/s); per-field `{el,lastVal,lastColor,lastShow}` для diff. **Idempotent.**
- `app.js` новий `mavOverlayRender(s,p)` — **єдиний writer**, джерело `s`(=lastStatus)+`p`(переданий, НЕ перераховувати). Gate `if(!mavOverlayOn||!mavConnected){add .hidden;return;}`. Diff-write §5-набору: link (`s.connected` ● онлайн `--ok-hi` / ○ немає heartbeat `--danger-hi`), mode (`s.mode||'—'`), armed (ARMED→`--danger-hi` / disarmed→`--ok-hi` / null→'?'), battery (`s.battery_v В · s.battery_pct%`, поріг >50 ok / 20-50 warn / <20 danger; '—' коли null — **ніколи 0%/-1%**), alt/gs, progress (`p.pct%` + bar width; distance-based; `p==null`→'—'/0-width), wp (`s.wp_current / s.wp_total||flownWpTotal||'—'`). Усі write через diff-guard (§6-консистентність); `textContent` всюди (escape для `s.mode`).
- `app.js` `OverlayControl` (L.Control, byte-for-byte клон FollowControl `:300-313`), `position:'topleft'`, `.overlay-ctl`, SVG-гліф, `.active` коли on; click→`toggleOverlay()`; `setOverlay(v)` → `mavOverlayOn=v`, `sessionPatch({overlay:v})`, `syncOverlayBtn()`, синхронне re-apply `.hidden` (миттєве сховання).
- `app.js` `mavDisconnect`: сховати overlay поряд з `mavClearTarget` (щоб картка не замерзла на останньому кадрі).

**Розв'язання UX-суперечностей (два дизайн-документи розходились).**
- **Placement — top-left, offset right від control-колонки (`left:52px`).** *(Причина: усі leaflet-контроли (zoom/locate/follow/draw) — top-**left** (`:157/:282/:301/:485`), єдиний top-right — layers-switcher (`:273`). Дизайн-система помилково казала top-right і мис-локувала контроли — тут виправлено.)* `top: calc(12px + env(safe-area-inset-top))`. На вузькому — нижче leaflet-zoom.
- **`pointer-events:none` на картці.** *(Причина: mid-flight у рукавицях мапа мусить лишатись повністю pannable; readout ніколи не має ловити жест. Дизайн-система §4b казала `auto`+tap-to-collapse — відкинуто; show/hide/collapse веде toolbar-toggle.)*
- **z-index: 800**, один на обидва документи (§ дизайн-система казала 1000, підсистема ~700 — уніфіковано). Нижче toast (1400) і gps-alarm (99999); з `pointer-events:none` це paint-order only, ніколи не capture; картка top-left, elev-badge bottom-left → різні кути, без z-fight.

**Набір даних.** §5-нотифікація ще несе flight-time/distance-flown, але їх продукує **нативний** `MavNotifyParser` (§6), їх немає в JS `lastStatus` (`blankTlm`, `link.js:119-126`). Бриф вимагає «єдине джерело lastStatus+mavProgressData, без паралельного пайплайну» → overlay **опускає** flight-time/distance (додати їх у JS = заборонений паралельний акумулятор). Опційний паритет через `NotifyBridge.getSnapshot()` (Android) — відкрите питання.

**Крайові випадки.** `p===null` → progress '—' + 0-width. Heartbeat-only (без стрімів) → alt/gs/batt/wp '—', link/mode/armed рендеряться. Battery unknown (sentinels `link.js:331-332`) → '—'. Disconnected/planning → gate `mavConnected` тримає сховано. Toggle OFF mid-flight → миттєве сховання (синхронно). `document.hidden` → overlay просто перестає оновлюватись (foreground-only; фонова неперервність — робота §3-нотифікації). Narrow (<760px) — картка top-left offset-right, чистить bottom-left FAB (`#panel-toggle`); transient top-center toast може коротко перекрити (auto-hide); gps-alarm (z-99999) навмисно накриває під час алярму.

**Ризики.** Рефактор сигнатури `mavRenderHud(s→s,p)` — єдина зміна всередині: видалення локального `p`, всі `hudSet` незмінні → HUD байт-у-байт (single caller `mavPoll :3012`). Append не-Leaflet-дитини до `map.getContainer()` доведено безпечним (elev-badge/importPickBtn). Дві toolbar-кнопки в top-left стеку — див. glove-sizing у F. `overlay`-ключ у `fmp_session` — additive, default ON коли absent.

---

### B.12 #12 — Безпечні транзитні шляхи + backstop-геозона

**Корінь/поведінка.** Engine рерутить **конектори між проходами** через free-space (`_route_freespace`/`_vis_path` у `generate_coverage`) — це вже є і **бойове**. Прямими летять лише дві леги: (1) **вхід** home→перший-coverage-WP, (2) **повернення**. У `link.js` `buildMissionItems` (`:90`) місія: `home(seq0)·NAV_TAKEOFF·[DO_CHANGE_SPEED]·coverage NAV_WAYPOINTs·[NAV_RTL]`. Після вертикального takeoff на **реальному** home (GPS/HOME_POSITION резолвиться на upload `app.js:2488-2493`, НЕ field-centroid із build-часу) автопілот летить прямою до першого WP, а RTL — прямою додому; будь-яка може різати ввігнутий notch або виріз (ставок/лісосмуга). Живої геозони немає; `mission.py to_geofence_plan/to_fence_mp` роблять лише **файли** для QGC/MP, не MAVLink-upload; `link.js` хардкодить `mission_type:0` скрізь.

**Ключове усвідомлення.** Visibility-graph+Dijkstra **НЕ net-new** — `coverage.py` уже має `_vis_path`(`:146`), `_vis_dijkstra`(`:89`), `_route_freespace`(`:188`), `_ring_vertices`(`:76`), `_free_polygon`(`:887`), `_project_to_ring`(`:1171`), `inset_boundary`(`:571`), `expand_exclusions`(`:662`). PRIMARY-робота: тонкий entry, що reuse-ить їх для двох транзит-лег + home entry/exit + **обов'язковий strict-containment gate** (див. нижче). BACKSTOP: threading `mission_type` крізь наявну mission-машинерію + fence item/param/verify helpers.

**Розв'язання safety-major (scope-split).** #12 несе дві незалежно-ризиковані фічі: (A) safe-transit коридори — **найвища зв'язаність у part-2** (інжекція ingress/egress зсуває кожен seq-індекс → §7.1 `flownLead`, §8 `lastCoverageSeq`, resume-математика, progress-%, ≥90%-complete), і (B) live-геозона з consequential `FENCE_ENABLE`. **Постачаємо їх як два окремі юніти** (розділ H): (1) геозона-backstop (простіша зв'язаність, висока safety-цінність) з guard-ами нижче; (2) safe-transit коридори — **лише коли seq-remap лендиться атомарно** з part-1 і re-tested end-to-end SITL-resume. Не постачати corridor-remap раніше, ніж resume/progress/completion перетестовано під інжектованими транзит-WP.

**Конкретні зміни (engine).**
- `coverage.py` новий `safe_transit(boundary, waypoints, home, exclusions=None, margin=0.0, spacing=20.0)` (після `:246`). Детальний алгоритм — розділ C. Ключові інваріанти, вбудовані тут:
  - **Corridor free-space на `expand_exclusions(margin)`** (та сама, що проходи), **НЕ `max(margin,fence_margin)`** *(розв'язання geometry-major: інакше `wp0/wpN` живуть у `inset−expand(margin)`, а corridor — у ширшій експансії → endpoint поза corridor-free → `_vis_path` fallback → straight leg → post-check fail → спурйозний ok:False біля вирізів на кожному плані з `fence_margin>margin`)*. Fence-легальність — **окремо** (clamp/warn, нижче).
  - **Strict-containment gate (CRITICAL).** `_vis_path` при відсутності шляху повертає **невалідований** `[a,b]` (`:182`), що може різати виріз. Тому кожну послідовну пару emitted-полілінії (ingress/egress + entry/exit + land) валідувати проти **строгого** `free` (`buffer(0)` / крихітний негатив), **НЕ** проти `free_ok=free.buffer(0.5)` *(розв'язання geometry-major: 0.5 м shell + `margin=0` → корид може врізатись 0.5 м у ставок ще до GPS-похибки)*. Будь-яка non-contained лега → **`ok:False` для цієї сторони, нуль WP**. Gate — **hard, non-optional**.
  - **Per-side ok (safety-major).** Повертати `{ingress_ok, egress_ok, ingress, egress, home_inside, entry, exit, reason}` — НЕ єдиний `ok`. *(Інакше failed egress все одно дропне RTL-fallback.)*
  - Home OUTSIDE `free` (дорожній takeoff): `_project_to_ring` по **кожному** exterior-ring `free` (MultiPolygon-safe, largest-first), foot per ring; лишити лише feet, чия straight-home→E лега НЕ перетинає `unary_union(exclusions)` І чия lobe reachable до `wp0`; найкоротша; жодної чистої → `ingress_ok:False`.
  - Zero-length: `if haversine(home,wp0)<eps: ingress=[]` (straight/no-op), явно, не через exception-path.
  - Мінімальний осмислений `margin`: corridor clearance ≈ `margin − 0.5м` → документувати, що `margin` має перевищувати GPS-похибку+0.5 м; surface у UI.
- `coverage.py` `_free_inset(boundary, exclusions, margin)` (варіант `_free_polygon` `:887`, спершу `inset_boundary`, потім `difference(expand_exclusions(margin))`) — centralized `(lat0,lon0)`-frame для home/route/ring.
- `api.py` новий `Api.safe_transit(params)` (після `:301`) → JSON in/out `{lat,lng}`, try/except `{ok:False,error}`.
- `api.py` новий `Api.build_fence(params)`: inclusion = **сирий** контур (НЕ inset — fence це hard-межа), exclusions = вирізи **+ avoid-hazard-коридори (#13)** *(розв'язання #12↔#13-major, нижче)*. Decimate кожен ring shapely `simplify(tol)` з підняттям tol до `total ≤ fence_total_cap` (**м'який** клієнтський таргет, дефолт 84; реальний backstop — upload-ACK). **Post-decimation (geometry-minor):** `.is_valid/.buffer(0)`, `≥3 vertices/ring` floor, і `inclusion.contains(each decimated exclusion)` — інакше re-tolerance/drop. Повертати `{ok, inclusion, exclusions, total_vertices, decimated, suggested:{FENCE_TYPE,FENCE_MARGIN,FENCE_ALT_MAX}, home_inside_inclusion}`; `home_inside = inclusion.buffer(-fence_margin).contains(Point(home)) and not any(ex.contains(home))`.

**Конкретні зміни (bridge).**
- `engine.js` (`:128-146`): generic `FMP_ENGINE.call(method,params)` (worker → `callWorker('call',{method,params})`; main → `getattr(_api,method)(params)`); wrappers `safeTransit(p)`, `buildFence(p)`. `buildRoute` as-is.
- `engine-worker.js` (`:34-42`): гілка `type==='call'` → `getattr(_api,d.method)(d.params)`.

**Конкретні зміни (MAVLink).**
- `link.js` `buildMissionItems` (`:90`) + `CMD_NAV_LAND=21`: `opts={ingress,egress,landAtHome}`. Emit `home·takeoff·[speed]·ingress·coverage·egress·terminal`. **Terminal = NAV_LAND@home ЛИШЕ коли `landAtHome && egress_ok && egress.length` (egress завершується AT home); інакше CMD_RTL** *(safe-major: не емітити NAV_LAND@home без валідованого шляху до дому)*. No-opts сигнатура — байт-у-байт як сьогодні.
- `link.js` `uploadMission`(`:439`)/`downloadMission`(`:552`)/`verifyMission`(`:600`)/`verifyMissionCount`(`:638`): додати `missionType` (default 0). **Merge-сигнатура `downloadMission(timeout, missionType)`** *(розв'язання #7↔#12-major: #7 кладе narrow-timeout у arg1, #12 — missionType у arg2)*. Виставити `mission_type:missionType` у sendCount(`:454`)/sendItem(`:457-461`), REQUEST_LIST(`:565`), REQUEST/REQUEST_INT(`:580`), MISSION_ACK(`:591`), verifyMissionCount(`:647,:651`).
- **`wp_total`-guard (CRITICAL MAVLink-major).** `this._tlm.wp_total = n;` у ОБОХ ACK-accept-гілках (`:508,:530`) → `if (missionType === 0) this._tlm.wp_total = n;`. Інакше fence-upload (type=1, ACK type все одно 0=ACCEPTED) переписав би HUD wp_total на **fence vertex count** → зламані `wp N/total` (`:3391`), mission-complete toast (`:3446-3447`), `sawComplete`(`:3245`), flightRec wp_total(`:3234,:3273`).
- **ACK mission_type (MAVLink-minor):** коли `missionType!==0`, вимагати `m.fields.mission_type===missionType` перед accept (інакше `continue`) — щоб straggler type-0 ACK не завершив fence-handshake хибним успіхом.
- `link.js` нові `buildFenceItems/uploadFence/verifyFence` (~`:657`): `buildFenceItems(inclusion, exclusions)` — MISSION_ITEM_INT per vertex, `command 5001 (NAV_FENCE_POLYGON_VERTEX_INCLUSION)` p1=`inclusion.length`, `5002 (…EXCLUSION)` p1=`ring.length` (**відкриті кільця**, не повторювати першу вершину; AC групує за p1). `uploadFence(inc, exc, onProgress, narrow) = uploadMission(items, narrow?60000:30000, onProgress, 1)`; `verifyFence(inc, exc, narrow) = downloadMission(narrow?120000:undefined, 1)` + compare. **Threading narrow-профілю обов'язковий** *(розв'язання #7↔#12-major: fence — друга MISSION-передача одразу після маршруту на тому ж голодному uplink, найімовірніша до stall; без narrow отримала б 30 с/15 с дефолти — саме той premature-timeout, який #7 усуває)*. **Verify-tolerance (MAVLink-minor):** реалізувати як **flat per-axis ±100 units(×1e-7°)** (реальний `verifyMission` `:618-624`, БЕЗ cos(lat)-метрики — попередній опис був неточним); кожна fence-вершина перевіряється (немає home-slot).

**Конкретні зміни (app.js).**
- `mav_upload_mission` перед `buildMissionItems` (`:2499-2503`): коли `!isInav && FMP_ENGINE` — `safe = await eng.safeTransit({boundary, waypoints:route, home:[home[0],home[1]], exclusions: collectExclusions().concat(hazardCorridors(hazardClearanceM())), margin, spacing})` *(розв'язання #12↔#13-major: hazard-коридори мусять входити в transit-free-space І в fence-exclusions, інакше вхід/повернення оминають вирізи, але НЕ ЛЕП/стовпи, а геозона не фенсить лінії — саме там дрон найімовірніше зачепить дріт)*. Якщо `safe.ingress_ok`/`safe.egress_ok` — брати відповідні леги; `opts.landAtHome = safe.egress_ok`. **Fail-safe:** будь-який engine-fail/unavailable/isInav → build як сьогодні (RTL terminal) + `res.safe_transit={ok:false,reason}` + **persistent pill** (не fading toast, safe-major): `.mission-status.warn` «Безпечний шлях НЕ побудовано (reason) — залий геозону і/або тримай RTL», що лишається до підтвердження; upload проходить лише після explicit ack, коли поле має вирізи.
- `mavUpload` success (`:3642-3671`) + `flownSave`/`FLOWN_KEY` (`:2267-2273`): `flownSave(route, home, hasRtl, ingressN, egressN)` + `{ingress:ingressN, egress:egressN, terminal:'land'|'rtl'}` (§7.1 FLOWN_KEY-розширення). Seq-математика: **`flownLead = 2 + hasSpeed + ingress.length`**; `resumeRemaining` мапить `p.wp→coverage index` через `f.lead` (тепер коректно пропускає ingress); **`lastCoverageSeq = flownWpTotal - 1(terminal) - egress.length`** (§8) — повертальний коридор НЕ рахується як coverage, notification/toast/`completion_pct` б'ють 100% на останньому COVERAGE-wp, далі окремий стан «повертається». **Це — hard-залежність, лендиться разом (розділ H).**
- новий `mavUploadFence()` + wiring: **guard `mavConnected && !isInav && !lastStatus.armed`** *(CRITICAL safe-major: PARAM_SET FENCE_* + enable на летючий дрон = consequential; enable полігон-fence з FENCE_ACTION=RTL коли коптер у дальньому куті → миттєвий breach→RTL; якщо armed — відмова з чітким повідомленням, ніколи не PARAM_SET FENCE_ACTION/ENABLE на armed)*. `fb = await eng.buildFence(...)`. **`FENCE_ENABLE=1` лише коли `lastStatus.home_lat!=null && fix_type>=3 && fb.home_inside_inclusion`** *(CRITICAL safe-major: home-fallback-chain остання сходинка = route[0]; якщо оцінка сидить у полігоні → auto-enable → реальний home поза → pre-arm «outside fence» брикне дрон у полі)*. PARAM_SET FENCE_MARGIN/ALT_MAX/TYPE(bitmask 4=polygon,+1=alt), **FENCE_ACTION** (operator-selectable Land/RTL, дефолт RTL) → uploadFence(narrow=mavNarrowLink) → verifyFence(narrow) (три стани як §4.1) → FENCE_ENABLE **останнім**. **Exact readback (MAVLink-major):** для FENCE_ENABLE/ACTION/TYPE — `getParam()===expected`, НЕ ±1-gate `setParam` (`link.js:713`, для value=1 приймає [0,2] → тихий 0→1-fail як «confirmed»). **Recovery-кнопка `#mav-fence-off`** «Вимкнути геозону (FENCE_ENABLE=0)» — щоб зняти over-restrictive/wrong-home fence у полі.
- `index.html` (після `#mav-upload :193`): `#safe-transit` checkbox (checked), `#mav-fence` button (disabled поки не connected+built), `#mav-fence-off` recovery, hint «Inclusion=контур, exclusion=вирізи+ЛЕП; FENCE_ACTION Land/RTL; дім має бути ВСЕРЕДИНІ(+запас) з реальним HOME та 3D-fix, інакше ARM завалиться. ArduPilot; INAV — geozones окремо (MSP)».

**Нові/змінені компоненти.** `coverage.safe_transit`; `Api.safe_transit`/`Api.build_fence`; `FMP_ENGINE.call/safeTransit/buildFence`; `buildFenceItems/uploadFence/verifyFence`; `buildMissionItems opts`; `mavUploadFence()`+`#mav-fence-off`.

**Крайові випадки.** Home inside, straight до wp0 чисто → `ingress=[]`, нічого не інжектимо. Home у bare inset-edge-strip → як home-outside (лега home→ring усередині поля, лише має минути вирізи). Concave/narrow neck → наявний `_vis_path`. Degenerate free (вирізи з'їли поле, <3 pts) → per-side `ok:False`, straight RTL + **persistent** warn, **ніколи** exclusion-crossing WP. Resume-after-battery → remainder через той самий `mav_upload_mission` → safe_transit recompute home→resume-start; `flownLead` включає новий ingress. INAV: safe-transit як bare NAV_WAYPOINT (INAV приймає), але LAND→RTL для INAV, fence SKIP (MSP, не MISSION_TYPE_FENCE). Fence decimation >84 → `decimated:true`. Home inside inclusion, але в межах FENCE_MARGIN → `buffer(-fence_margin)` gate тримає ENABLE=0. **Mid-mission FAILSAFE RTL** (battery/RC) все ще прямо через перешкоди — коридор захищає лише **номінальне** повернення; FENCE_ACTION=RTL має ту саму пряму-додому небезпеку → **чесно документувати, не оверселити**; єдина мітигація непланового повернення — опційний `OA_TYPE=Dijkstra` (ArduCopter, поза core). Corridor-return довший за direct RTL → підвищує ймовірність battery-failsafe **під час** повернення → врахувати в резерві/попередити коли коридор істотно довший.

**Ризики.** Seq-mapping shift — найвища зв'язаність part-2, лендиться разом із `flownLead/ingress/egress`-персистом і §8 `lastCoverageSeq`, інакше HUD/resume тихо мис-мапляться. `mission_type` threading чіпає hardened upload/download loop — тримати default 0, міняти лише значення поля, не рефакторити loop. Pyodide на APK main-thread може бути mid-init → `safe_transit` мусить `await FMP_ENGINE.init()` і на будь-якому fail → straight+warn, ніколи не блокувати upload. FENCE_RETURN_POINT (5000) НЕ емітимо → при FENCE_ACTION=RTL breach повертає на HOME (прийнятно, часто безпечніше за stored point) — **явно заявити в UI**, що dedicated return-vertex немає.

---

### B.13 #13 — Маркери небезпек + експериментальний OSM-імпорт ЛЕП

**Корінь/поведінка.** Поняття «небезпека» в коді нема. Leaflet.draw є (`drawControl :475`), але toolbar навмисно polygon-only (`polyline:false :479`, `marker:false :481`). Уся геометрія — в одному `drawnItems` (`:443`), тег `_k`: `field|excl|split`. Вирізи (`exclusionItems` `:449-455`, `collectExclusions()` `:686-694`) подаються в engine як `exclusions` (`buildRoute :1047`), engine вирізає й рерутить проходи (`coverage.py:388/509-533`). Поле персиститься `fmp_last_field` (localStorage) + `fmp_fields` (IndexedDB, keyPath `name`, §4.4 + `fieldId`). CSP `connect-src 'self' https:` (`index.html:10`) вже дозволяє Overpass. `vendor/clipper.min.js` (ClipperLib) уже вживається в `unionContours` (`:2034-2057`) — готовий інструмент для буферизації ліній у коридори.

**П'ять вимог фічі.** (1) модель + шар; (2) точку/лінію малювати **програмно** (toolbar polygon-only); (3) безплощинну геометрію → полігон-коридор (engine уникає лише полігонів; сира лінія має площу 0); (4) персист консистентно з полем (обидва ключі, `fieldId` §4.4); (5) чесний OSM-імпорт (пропущена в OSM лінія = хибне «чисто» = небезпека).

**Конкретні зміни.**
- `app.js` ~`:456`: `let hazardMode=null; let _hazDrawHandler=null; let _hazBar=null;`.
- `app.js` ~`:444-455`: `hazardLayers()` (фільтр `_k==='hazard'` у `drawnItems`) + shim `hazardItems{addLayer,clearLayers,eachLayer}`. Небезпеки в тому ж `drawnItems` → native pencil/trash, Clear-all (`:1560`), EDITED(`:869`)/DELETED(`:873`) працюють безкоштовно; DELETED-хендлер перевіряє лише `_k==='field'` (`:876`) → видалення небезпеки НЕ стирає поле.
- `app.js` CREATED (`:524-537`, ПЕРЕД `drawingExclusion`): `if(e.layerType==='marker'||e.layerType==='polyline'){ addHazardFromLayer(e.layer, hazardMode); hazardMode=null; teardownHazBar(); return; }`. Marker/polyline ніде інде не вживаються → будь-яка точка/лінія = небезпека (не впаде в `adoptField :535`).
- `app.js` DRAWSTOP (`:540`): `+ hazardMode=null; teardownHazBar();`.
- `app.js` після `addExclusionLayer` (~`:603`) — блок функцій: `hazardPoleIcon` (L.divIcon, `.area-label.hazard`, **SVG-гліф блискавки, НЕ emoji** — дизайн-система §, F); `HAZ_STYLE` manual = `{color:var(--hazard-line) #ffb020, weight:4, dashArray:'1 8', lineCap:'round'}`, osm = **desaturated `var(--hazard-osm) #b06a2e` + `dashArray:'6 8'`** *(розв'язання token-drift: рівень довіри читається з відтінку, не лише dash)*; `startHazardDraw(kind)` (`new L.Draw.Marker/Polyline`, для лінії плаваючий бар Готово/Скасувати як `importPickBtn :2127`); `addHazardFromLayer(layer,mode)` → модель `{id, kind:'pole'|'line', geom:[{lat,lng}], source:'manual', avoid:true, osm:null, ts}`; `addHazardLayer(m)` (materialize L.marker/L.polyline, `_k='hazard'`, `_hz=m`, tooltip, click→delete); `collectHazards()` (meta з `_hz` + **жива** геометрія); `removeHazardLayer(l)`; `hazardClearanceM()` = `parseFloat($('hazard-clearance').value)||25`.
- `app.js` після `collectHazards` — `hazardCorridors(halfWidthM)`: ClipperLib-офсет (reuse проєкції `unionContours :2041-2051`), `co.AddPath(geom, jtRound, etOpenRound); co.Execute(sol, halfWidthM*SC)` — точка(1 вершина)→коло, лінія→капсула. `!window.ClipperLib` → `[]` (avoid тихо degrade, небезпеки лишаються **видимими**) + one-time warn.
- `app.js` `buildRoute` params (`:1047`): `exclusions: collectExclusions().concat(hazardCorridors(hazardClearanceM())),` — коридори додаються **лише тут**, НЕ в `collectExclusions()` (KML/geozone/project лишаються чистими). **Той самий `hazardCorridors(...)` подається в #12 `safeTransit` і `buildFence`** (B.12) — інакше транзит/fence не оминають ЛЕП.
- `app.js` персист: `saveLastField` (`:754-761`) `+hazards:collectHazards()`; `restoreLastField` (`:766-778`) re-add + банер якщо є OSM; `applyProject` (`:1836-1850`) `hazardItems.clearLayers()` + re-add (per-field replace); `adoptContour` (`:2059-2066`) clear (KML без небезпек); `save-project` rec (`:1900-1901`) `+hazards`; **§4.4 upload-UPSERT (`:3642-3648`)** `+hazards:collectHazards()` (залитий контур + небезпеки одним durable-записом).
- `app.js` `collectParams`(`:1685`)/`applyParams`(`:1723`): `hazard_clearance` + `scheduleSaveSettings` (`:1334`).
- `app.js` `importOsmPowerLines()` (~`:2199`): guard `!fieldPolygon`/`!navigator.onLine`; bbox `getBounds().pad(0.15)`; Overpass `[out:json][timeout:25];(way["power"~"^(line|minor_line)$"](bbox);node["power"~"^(tower|pole)$"](bbox););out geom;`; POST `x-www-form-urlencoded`, AbortController 25с; primary `overpass-api.de`, fallback `overpass.kumi.systems` на throw/429/5xx; парс ways(`.geometry`≥2)→`kind:'line'`, nodes→`kind:'pole'`, **`source:'osm', avoid:false`**; dedup за `osm.type+id`; cap 800; банер + warn; порожньо → «ЛЕП не знайдено — НЕ доказ що їх нема, перевір очима».
- `app.js` wiring (~`:1570`): `haz-add-pole/haz-add-line/haz-import-osm`; `renderHazardList()` (per-item toggle avoid + delete + масово «Уникати всі ЛЕП з OSM»); банер show/hide.
- `index.html` Plan-tab (після Export/Import `<details>`, перед «Очистити» `:133`): `<details id="hazards-group"><summary>Небезпеки (ЛЕП / стовпи)</summary>` з кнопками Стовп/ЛЕП, `#hazard-clearance` (value 25), `#haz-import-osm`, `#hazard-osm-warn` (hint warn), `#hazard-list`.
- `i18n.js`: усі hazard-ключі UA→EN.
- `style.css`: `.area-label.hazard` (амбер, темний гліф), `.hint.warn` (bold, orange-red), `#hazard-list`, haz-бар.

**Нові/змінені компоненти.** HazardModel; `hazardItems`+`hazardLayers`; `addHazardLayer/addHazardFromLayer`; `collectHazards`; `hazardCorridors`; `startHazardDraw`; `importOsmPowerLines`; `renderHazardList`.

**Крайові випадки.** Offline OSM → зрозуміле повідомлення без fetch. Overpass timeout/429/5xx → fallback-mirror; обидва впали → «недоступний», планування не блокується. Порожня відповідь → «не доказ». Гігантський bbox → cap 800 + dedup. ClipperLib absent → `[]`+видимі. Вироджена ЛЕП (1 точка) → коридор пропускається, стовп→коло. Native edit → EDITED→`clearRoute`+`scheduleSaveField`, `collectHazards` читає живу геометрію. Native trash → DELETED перевіряє `_k==='field'` → поле не зникає. Завантаження іншого поля → небезпеки замінюються (per-field). **OSM `avoid=false` за замовчуванням** → НЕ перекроює місію тихо; масовий opt-in доступний. `margin>0` + коридор: engine добуферить на margin (`api.py:116`) → трохи більший запас.

**Ризики.** **OSM-неповнота = ХИБНЕ «чисто»** → source='osm' avoid=false ЗА ЗАМОВЧУВАННЯМ + постійний банер «перевір очима». Автоуникання OSM ПОСИЛЮЄ хибне відчуття «оброблено» → НЕ дефолт. **2D-уникання:** коридор горизонтальний; вертикальний запас (проліт над ЛЕП) НЕ моделюється у v1 — **явно в UI**, що уникання горизонтальне і не гарантує висоту; fly-over min-AGL — фаза-2. **Транзит/RTL:** hazard-коридори тепер подаються і в #12 safe_transit, тож при `#safe-transit` вхід/повернення оминають ЛЕП **на проходах І транзиті**; але mid-mission failsafe RTL і FENCE_ACTION=RTL летять прямо — та сама честь, що й у #12. Публічні Overpass — лише user-triggered, timeout, fallback, ніколи не блокує планування.

---

## C. #12 глибше — алгоритм безпечного шляху + geofence flow

### C.1 `coverage.safe_transit` — покроково

Вхід: `boundary[(lat,lon)]`, `waypoints` (coverage-проходи, порядок upload), `home=(lat,lon)` (реальний з upload-часу), `exclusions` (**вирізи + avoid-hazard-коридори**), `margin`, `spacing`.

1. **Один frame.** `free, lat0, lon0 = _free_inset(boundary, exclusions, margin)` — inset-контур мінус `expand_exclusions(exclusions, margin)`, проєкція навколо home-frame `(lat0,lon0)`. `free` може бути `Polygon`-with-holes або `MultiPolygon`. `free_strict = free.buffer(0)` (валідна строга геометрія). Спільний `ctx` (nodes/node_vis/free_ok) будується **один раз** на обидві леги.
2. **Проєкція.** `H=proj(home)`, `W0=proj(wp0)`, `WN=proj(wpN)`.
3. **home_inside** = `free_strict.contains(H)`.
4. **Ingress.**
   - Якщо `haversine(home,wp0)<eps` → `ingress=[]`, `ingress_ok=True` (straight/no-op).
   - Якщо `home_inside`: `raw = _route_freespace([H,W0], free, ctx)[1:-1]`; `poly=[H]+raw+[W0]`.
   - Інакше (home outside): для **кожного** exterior-ring `free` (largest-first) `E_i=_project_to_ring(H, ring_i)`; лишити `E_i`, де `LineString([H,E_i])` НЕ перетинає `unary_union(exclusions_proj)` І `E_i`-lobe містить `W0`; `E=argmin len(H→E_i)`; жодного → `ingress_ok=False`. `poly=[H,E]+ _vis_path(E,W0,ctx)[1:]`.
5. **Strict-containment gate (HARD).** Для кожної послідовної пари `(poly[k],poly[k+1])` (включно з entry `H→E` і, для egress, land-легою): `if not free_strict.contains(LineString([p,q])): ingress_ok=False; break`. Валідація проти `free_strict`, **НЕ** `free_ok`. Будь-який fail → `ingress=[]`, `ingress_ok=False`, `reason='ingress: leg not contained'`.
6. **Egress** — симетрично (`WN→home`, exit-foot `X` біля home); `land`-лега `X→home` теж має бути contained І завершуватись at home.
7. **Return** `{ingress_ok, egress_ok, ingress(unproj), egress(unproj), home_inside, entry:E, exit:X, reason}`; `_dedupe_ll`.

**Чому це fail-safe.** `_vis_path` при disconnected-лобах/impassable-neck повертає невалідований `[a,b]` (`:182`). Крок 5 — **єдина** гарантія «provably inside»: він проганяє КОЖНУ emitted-легу через `free_strict.contains`. На будь-якому fallback-crossing gate дає `ok:False` для сторони і **нуль WP** — краще пряма RTL (з persistent-warn), ніж baked exclusion-crossing WP. Unit-test (розділ G): дві disconnected free-lobes → `ok:False`, НЕ straight-crossing.

**Мінімальний margin.** Оскільки `expand_exclusions(margin)` при `margin<=0` повертає вирізи без змін, а `free_strict=buffer(0)` не додає запасу, реальний clearance ≈ `margin`. UI попереджає, коли `margin < GPS-похибка + запас`; safe-transit пропонується лише при осмисленому margin (інакше коридор притискається впритул до межі вирізу).

### C.2 Geofence upload/verify flow (`mavUploadFence`)

Передумови-guard (усі — інакше відмова з причиною):
- `mavConnected && !isInav` (INAV geozones — MSP, v1 out).
- **`!lastStatus.armed`** — жодного PARAM_SET/upload/enable на летючий дрон.
- Для `FENCE_ENABLE=1` додатково: `lastStatus.home_lat!=null && lastStatus.fix_type>=3 && fb.home_inside_inclusion`.

Кроки:
1. `fb = await eng.buildFence({contour: boundaryFromPolygon(), exclusions: collectExclusions().concat(hazardCorridors(hazardClearanceM())), home:[lat,lon], fence_margin, fence_total_cap:84})`. `fb` валідний (post-decimation `.is_valid`, `≥3 vertices/ring`, inclusion-contains-exclusion).
2. PARAM_SET `FENCE_MARGIN`, `FENCE_ALT_MAX` (з `#alt`+headroom), `FENCE_TYPE` (bitmask 4=polygon, +1 якщо ALT_MAX), `FENCE_ACTION` (operator Land/RTL, дефолт RTL). Кожен — з наступним **exact `getParam()===expected`** для дискретних (ENABLE/ACTION/TYPE), НЕ ±1 `setParam`-gate (`link.js:713`, для 1 приймає [0,2]).
3. `uploadFence(fb.inclusion, fb.exclusions, onProgress, mavNarrowLink)` = `uploadMission(items, mavNarrowLink?60000:30000, onProgress, 1)`. **`wp_total`-guard (`missionType===0`) означає, що ця type-1 передача НЕ чіпає HUD wp_total.**
4. `verifyFence(fb.inclusion, fb.exclusions, mavNarrowLink)` = `downloadMission(mavNarrowLink?120000:undefined, 1)` + flat per-axis ±100-порівняння кожної вершини → три стани (VERIFIED/MISMATCH/INCOMPLETE, §4.1). Over-capacity → MISSION_ACK type 4 → `link.js:64` «немає місця — забагато точок».
5. **`FENCE_ENABLE=1` — ОСТАННІМ**, лише після VERIFIED + home-inside-gate; підтвердити `getParam('FENCE_ENABLE')===1`.
6. `#mav-fence-off` recovery: PARAM_SET `FENCE_ENABLE=0` + `getParam===0` — зняти over-restrictive/wrong-home fence у полі.

Honesty-limit (в UI): FENCE_ACTION=RTL летить прямо додому через перешкоди; FENCE_RETURN_POINT не задано → breach повертає на HOME. Коридор захищає лише **номінальне** повернення; непланований — лише `OA_TYPE=Dijkstra` (поза core).

---

## D. #7 SETUP HOW-TO (повна інструкція, українською) — verbatim

### НАЛАШТУВАННЯ: MAVLink через пульт EdgeTX по КАБЕЛЮ (без WiFi-бекпака)

Ланцюг звʼязку: телефон (USB) → пульт EdgeTX (USB-VCP) → маршрутизація EdgeTX → ELRS TX-модуль → RF → ELRS-приймач → UART політника (MAVLink). Жодного WiFi.

**ПЕРЕДУМОВИ**
- EdgeTX 2.10+ на пульті (раніші версії не віддають MAVLink на USB-VCP).
- ELRS 3.5.0+ на TX-модулі І на приймачі (нативний MAVLink зʼявився саме в 3.5).
- ArduPilot на політнику (INAV/geozones через ELRS — окремо, поза цим потоком).
- Назви пунктів меню трохи різняться між версіями EdgeTX/ELRS — орієнтуйся на суть.

**A. ПОЛІТНИК (ArduPilot), один раз**
1. На UART, куди підключено ELRS-приймач: `SERIALx_PROTOCOL = 2` (MAVLink2).
2. `SERIALx_BAUD = 460` (460800 — стандарт ELRS MAVLink між приймачем і FC). Деякі збірки — 57 (57600); тоді так само на приймачі.
3. Перезавантаж політник.

**B. ELRS-ПРИЙМАЧ, один раз**
1. Зайди у веб-інтерфейс приймача (його WiFi-режим) або через passthrough.
2. Serial protocol / Protocol = MAVLink. Baud приймача = той самий, що `SERIALx_BAUD` (460800).
3. Збережи, перезавантаж, переконайся що приймач звʼязаний (bind) з TX-модулем.

**C. ELRS TX-МОДУЛЬ (у пульті), один раз**
1. У Lua-скрипті «ExpressLRS» на пульті переконайся, що модуль на 3.5+.
2. У 3.5 MAVLink на лінку узгоджується автоматично, щойно серійний порт пульта віддає MAVLink (крок D). Окремого перемикача «MAVLink» на TX може не бути — головне версія 3.5+ і однакова версія RX/TX.

**D. EdgeTX (ПУЛЬТ) — маршрут MAVLink на USB**
1. SYS (Radio settings) → Hardware → Serial ports. Знайди порт VCP (USB) і постав його Mode = MAVLink. Джерело телеметрії — module bay (ELRS).
2. USB Mode (там же в Hardware або у діалозі при підключенні кабелю) = Serial (VCP). НЕ «Joystick» і НЕ «Storage» — інакше CDC-порт не зʼявиться на телефоні.
3. Baud VCP лиши стандартним — для USB-VCP він номінальний.

**E. ТЕЛЕФОН (FMP APK)**
1. Підключи пульт до телефона кабелем USB-C↔USB-C (або через OTG). Пульт визначиться як STMicroelectronics Virtual COM (VID 0x0483 — вже у білому списку USB застосунку).
2. Дозволь доступ до USB, коли Android спитає для FMP.
3. У FMP: Тип зʼєднання → «Пульт (EdgeTX/ELRS MAVLink)». Baud підставиться 115200 (для USB-VCP він номінальний — реальну швидкість каналу задає ELRS packet rate + telemetry ratio, а не цей baud).
4. «Оновити список портів» → обери запис пульта (Virtual COM). «Підключити».
5. Дочекайся heartbeat — засвітиться HUD. Якщо «зʼєднання відкрито, але heartbeat не отримано» — MAVLink не доходить: перевір кроки A–D і що приймач звʼязаний з TX.

**F. ЗАЛИВКА МІСІЇ ПО ELRS — реалії швидкості**
- Тисни «Залити місію». Над ELRS помітно повільніше, ніж по WiFi-бекпаку: зʼявиться лічильник «N/усього» — це нормально, канал вузький, а заливка сама підлаштовується під швидкість лінка.
- Помилка «0/N» = команда на дрон не доходить: підніми ELRS packet rate або зменш telemetry ratio (напр. 1:4 замість 1:64), підійди ближче, перевір антену/зʼєднувач.
- Перевірка зчитуванням читає всю місію назад — над ELRS це триває довше, тому таймаут піднято до 120 с (це вікно **без прогресу**, не жорсткий ліміт: заливка, що стабільно рухається, завершиться однаково; більший таймаут лише не дає хибно оголосити мертвим лінк, що завмер на кілька секунд). Якщо лінк зовсім слабкий — побачиш БУРШТИНОВИЙ «перевірка не вдалася, підійди ближче / USB» (не червоний, місію вже прийнято), і зможеш «Перевірити ще раз» або увімкнути «швидку перевірку — лише кількість точок».

**G. GEOFENCE (#12) ПО ТОМУ САМОМУ ELRS**
- Fence заливається ОКРЕМОЮ передачею після маршруту → час у ефірі приблизно подвоюється. Тримай кількість вершин малою (децимація до FENCE_TOTAL, дефолт 84), інакше передача розтягнеться. Ця передача **успадковує ті самі широкі ELRS-таймаути** (60 с заливка / 120 с перевірка), що й маршрут. Перевірка fence зчитуванням — так само з бурштиновим fallback, як для місії.
- Дім має бути ВСЕРЕДИНІ геозони з реальним HOME (3D-fix), інакше вмикання завалить ARM. FENCE_ENABLE вмикається лише після успішної перевірки. Кнопка «Вимкнути геозону» знімає її у полі.

**Порада:** якщо потрібна максимальна швидкість заливки великої обприскувальної місії — на короткий час пряме USB-підключення до самого політника (той самий тип «Кабель / радіо») зальє швидше; пульт EdgeTX зручний тим, що ти вже тримаєш його в руках у полі й антена рознесена.

---

## E. Персистентність — дельта до §7 + спільний join key

### E.1 Ключі (доповнення до §7.1)

| Ключ | Медіум | Стан part-2 | Дельта |
|---|---|---|---|
| `fmp_last_field` | localStorage | **змінено** | `+hazards:[HazardModel]` (поряд з `{contour,exclusions,fieldId,name,ts}` §7.1) |
| `fmp_flown` (FLOWN_KEY) | localStorage | **змінено** | `+ingress:int, +egress:int, +terminal:'land'|'rtl'` (для seq-remap #12); `flownLead = 2+hasSpeed+ingress` |
| `fmp_fields` (store `fields`) | IndexedDB | **змінено** | `+done_ha:0, +completed_count:0, +last_flight_at:null` (#8), `+hazards` (#13); §4.4 UPSERT **merge-preserve** цих полів |
| `fmp_flightlog` (store `flights`) | IndexedDB | **змінено** | запис фіксує `field_id`/`field_name` на ARM-час (#8 join); **без нових stats-полів** (#5 похідне) |
| `fmp_session` | localStorage | **змінено** | `+overlay:bool` (#11); baud round-trip для handset (#7); (statsRange — in-memory, не персист) |
| `fmp_sync_enabled` | localStorage | **новий** | opt-in бекап OFF (#10) |
| `fmp_sync_last` | localStorage | **новий** | `{ts,nf,mf}` (#10) |
| `fmp_sync_dirty` | localStorage | **новий** | dirty-прапор store-and-forward (#10) |
| Param `boom_m` / `hazard_clearance` | у `fmp_fields.params`/settings | **новий** | ширина факела (#9), запас обходу (#13) — через `collectParams/applyParams` |
| VPS `logs/sync/fleet/{fields,flights}.json` | сервер (диск) | **новий** | single-tenant bucket #10; caps ~200/300, atomic write |

### E.2 Спільний field-record join key

**Єдиний ключ для всіх part-2-міжсторових операцій — `{fieldId, name}` з §4.4** (`fieldId` — логічний, `name` — keyPath-fallback). Використовується ідентично в:
- **#8** `fieldProgressCredit` — join `fmp_flightlog`(зафіксований на ARM `field_id/field_name`) → `fmp_fields`(keyPath `name`), **gated на `fieldId`-збіг** (recycled `Поле N` не кредитує інше фізичне поле).
- **#10** merge — fields by `fieldId||name` (max `updated`), flights union by `(started_at, device)`.
- **#13** — небезпеки живуть у тому ж `fmp_fields`-записі під тим самим `{fieldId,name}`, потрапляють у durable-store §4.4-UPSERT-ом.
- **#12** — `flownSave` несе `{fieldId,name}` §4.4 + нові `ingress/egress/terminal`; resume/completion читають цей SSOT.

`updated=Date.now()` **обов'язково** виставляється щоразу, коли #8 мутує запис поля — інакше #10 LWW відкидає новий прогрес (load-bearing cross-dep #8↔#10).

---

## F. Дизайн-система (застосована до кожної нової поверхні)

Розширює наявний `web-stable/style.css`/`index.html`/`app.js`. **Нічого не переспецьовує робочу поверхню; усі токени — additive.**

### F.0 Виправлення (перевірити перед білдом)
1. App-surface = `--bg #0b0e12` → `--panel #10151b` → `--panel-2 #151b22` → `--inset #0c1116`. `#0a0f14` — це PWA `theme-color`/status-bar (`index.html:15`), **не** surface; ніде в UI не хардкодити.
2. Swath (#9) **уже є** (`app.js:1126-1140`): cyan `#00c2ff`/`#0077b6` (coverage), red `#ff3b30`/`#c0392b` (overlap). Розширювати цю мову; зелений fill на зеленому супутнику заборонено (коментар `:1117`).
3. HUD-статуси захардкоджені hi-vis, **яскравіші** за токени: `#5fd3a3`/`#ff7b72`/`#e3b341` (`app.js:3369/3372/3382`). Кодифікувати як `*-hi`-токени для on-map + notification; м'якші `--ok/--warn/--danger` — для in-panel chrome.
4. HUD уже reuse `.stats` (`index.html:197`) → #11-рефактор наслідує row-model.
5. Progress-bar і stat-tile — **єдині справді нові примітиви** (§F.4).
6. **Restored-unverified pill (§4.2) → `.warn`, НЕ `.stale`** (`.stale` червоний зарезервовано за «plan changed after upload»).

### F.1 Токени (додати; нічого не override)
```css
:root{
  --ok-hi:#5fd3a3; --danger-hi:#ff7b72; --warn-hi:#e3b341; --info-hi:#ffd24a;   /* on-map/notif статус */
  --map-card-bg:rgba(13,18,24,.92); --map-card-bg-max:rgba(13,18,24,.97);
  --map-card-line:#253440; --map-card-shadow:0 3px 14px rgba(0,0,0,.45);
  --swath-fill:#00c2ff; --swath-line:#0077b6; --overlap-fill:#ff3b30; --overlap-line:#c0392b;
  --gap-fill:#ffd166; --gap-line:#e0a800;            /* #9 прогалини: АМБЕР (не magenta) — colour-blind-safe vs red-overlap */
  --track-done:#5fd3a3;                              /* факт-покриття (#9 opt) */
  --hazard:#ff8c1a; --hazard-line:#ffb020; --hazard-osm:#b06a2e;  /* #13; OSM desaturated = нижча довіра */
  --tile-bg:#131a22;
}
```
**Правило:** on-map + notification → `*-hi`/`--info-hi`; in-panel chrome → `--ok/--warn/--danger`. Жодного третього синього (accent `#3f80ff`, field-polygon `#2d7ff9` — обидва лишаються).
*(Розв'язання #9 colour-major: gap = **амбер `#ffd166`**, не magenta — відрізняється від red-overlap і читається для deuteranopia/protanopia на зеленому; за потреби hatched-fill + легенда. `.area-label` навмисно легша (.78 alpha) — НЕ підводити під `--map-card-bg`.)*

### F.2 Типографіка
`system-ui`, `font-variant-numeric: tabular-nums` на **кожному** числі. Hero-число (5-плитка #5, primary readout #11) — 26-30/800; overlay-secondary 20-22/700; body-value 14/700; chip/caption 11-11.5/700. **Живі числа ≥14px; hero ≥26/800; overlay/notif ≥20/700.**

### F.3 Spacing / touch
4px-база; radius `--radius 8` (cards/buttons), 6 (inputs/pills), 10 (map-cards), 999 (chips/toggles). **Field-critical control ≥48px; inline ≥44px; mobile inputs 16px** (анти-iOS-zoom). Breakpoint 760px (панель → full-screen drawer). **z-ladder:** gps-alarm 99999 > toast 1400 > panel-toggle 1300 > panel 1200 > **overlay #11 = 800 (pointer-events:none, paint-order only)** > leaflet controls.
*(Glove-major: новий overlay-toggle і locate/follow — leaflet-bar ~30px; підняти щонайменше overlay-toggle до 40-44px, або явно позначити його не-field-critical. Перевірити висоту top-left стеку (zoom+locate+follow+overlay+draw) проти bottom-left FAB + safe-area на 320px.)*

### F.4 Компоненти
- **Card in-panel** → reuse `.stats` (`style.css:165-176`).
- **Map-card** → `.map-card` (`--map-card-bg-max` для text-dense, `#253440` border, shadow, radius 10, tabular). #11 і легенди #9 — цей рецепт.
- **Stat tile** (#5): `.tile-strip{display:grid; grid-template-columns:repeat(auto-fit, minmax(88px,1fr)); gap:8px}` — **5 плиток** рефлоу 3+2 чисто; `.tile .v{26px/800 tabular}`; акцент headline-плитки (Покрито) `--ok`. *(Розв'язання #5-tile-major: 5, не 4; `auto-fit` замість `repeat(4,1fr)`.)*
- **Progress bar** (#8/#5/#11): `.fmp-bar{height:6px; radius:999; bg:--inset}`; `>i{bg:--accent; transition:width .3s}`; `.done>i{--ok}`, `.partial>i{--warn}`. На overlay #11 — 8-9px + hi-vis fill; **distance-based, єдина метрика**.
- **Chip** (#5-period / approximate / partial): 999-radius pill, кольор-родини дзеркалять `.mission-status ok/warn`. #5-period-чіпи — сегмент-контрол виглядом `.tab.active`.
- **Pill (status)** → reuse `.mission-status ok/warn/stale`; **restored-unverified = `.warn`**; **#12 fence-verify verdict = ok/warn/stale** (як mission-verify §4.1); **#12 unsafe-transit fallback = persistent `.warn`** (не fading toast).

### F.5 Map-overlay do / don't
**Do:** кути + `env(safe-area-inset-*)`, центр мапи чистий; `--map-card-bg-max`+shadow для сонця; `*-hi`-статуси; tabular; #11 collapsible через toolbar-toggle; шари #9/#13 togglable; `pointer-events:none` на декоративних (swath/gap/hazard/legend/telemetry-readout — лише hazard-маркери й toolbar-кнопки беруть тапи); z-ladder.
**Don't:** не заливати великі площі непрозорим; **max одна компактна картка на кут**; нічого bottom-left (elev-badge+FAB) чи top-right-center (layers-switcher — єдиний top-right контрол; zoom/locate/follow/draw — top-**left**); зелений fill на зеленому супутнику; **два різні progress-%** (лише distance-based); emoji-іконки (SVG `.ic` only); картка над toast/gps-alarm; **planning-картки (легенда #9) — ховати `while armed/connected`** (у польоті лишати лише telemetry-card + transient toast).

### F.6 Checklist (перед шипом будь-якої part-2-поверхні)
1. Кольори з токенів; жодного нового hex поза F.1; жодного другого синього.
2. In-panel → `--ok/--warn/--danger`; on-map/notif → `*-hi`.
3. Кожне число tabular; live ≥14px, hero ≥26/800, overlay/notif ≥20/700.
4. Cards: in-panel `.stats`; on-map `.map-card`.
5. Pills reuse `.mission-status`; restored-unverified = `.warn`; fence-verify = ok/warn/stale.
6. Chips reuse 999-pill + `.mission-status`-родини.
7. Untrusted (імена полів, `s.mode`) через `esc()`/`textContent`; copy через `t()/tf()` UA+EN; одиниці через `enUnits()` (Га/хв як голе число!).
8. Touch ≥44px (≥48 field-critical); mobile inputs 16px; overlay-toggle ≥40px.
9. Overlays: кут-anchored, safe-area, z=800 pointer-events:none, togglable/collapsible, не обскурюють поле, cyan/red/**амбер**-мова, SVG-іконки.
10. Progress distance-based, єдина; missing → «—» у `--text-faint`, ніколи 0.
11. Поверхня переживає 760px drawer + `overflow-x:auto`.
12. **4-та вкладка «Статистика»** — `white-space:nowrap` + tab-row `overflow-x:auto` (або скоротити до «Стат.»); перевірити на 320px, щоб не було 2-рядкового переносу й нерівного tab-row. *(Розв'язання #5-tab-major: `.tab` не має white-space-handling; на 320px «Статистика» (10 симв.) переноситься.)*

**Per-surface guidance для #10-Sync-групи (tab-app):** reuse `.io-group`+`label.row`+`.ghost`-button+`.hint`; група схована коли `SYNC_BASE` без сервера. **Для #12-контролів** (`#safe-transit`, `#mav-fence`, `#mav-fence-off`): reuse `.export-row`; fence-verify verdict — `.mission-status ok/warn/stale`.

**Ключові anchors:** токени `style.css:5-23` · `.stats` `165-176` · `.mission-status` `179-187` · `.elev-badge` `275-290` · `.toast` `196-210` · tabs `69-84` · HUD `app.js:3367-3400` (hi-vis 3369/3372/3382) · swath `app.js:1126-1140` · saved-fields `app.js:1856-1886` · `updateMissionStatus` `2329-2345` · tab-handler `1249-1256` · #7 preset `index.html:145-171`.

---

## G. Тестування

### G.1 #5-additions
- Порожній період: польоти лише вчора → «з початку години» → per-period empty + чіпи видимі + totals «—»; «усе» → рядки повертаються.
- Filter recompute: 3 польоти (ця година / раніше сьогодні / вчора) → hour→1, day→2, all→3; усі 5 плиток + таблиця міняються.
- Per-flight Га/хв: `covered_ha=2.0, dur=600` → 0.20; no-plan → «—».
- Avg = ratio-of-sums: (1.0га/300с, 3.0га/900с) + third no-plan → `(1.0+3.0)/((300+900)/60)=0.20`; no-plan НЕ в знаменнику.
- Approximate: `rec.approximate` → клітинка `~`, у covTot/avg лишається.
- i18n EN: header `ha/min`, чіпи `This hour/Today/All`, плитки `Flights/Hours/Kilometres/Covered/Avg ha/min`, без «га/хв»-leakage з `enUnits`.
- Narrow 360px: totals wrap (auto-fit), 8-col scroll у wrapper, body без h-scroll.
- Delegated handler: тап чіп → Plan → назад → тап іншого → рендериться (listener на `#tab-stats`).

### G.2 #7
- UI-аліас: handset → cable-рядок+COM+baud видимі, net-рядок схований, baud 115200; handset→udp→handset toggle rows; UDP-адреса сідиться лише для udp.
- Routing: `mavConnString` повертає port-id (без udp/tcp-префікса), `mav_connect` входить у serial-гілку.
- SITL over lossy ELRS (`test_sitl_elrs.py`): пресет connect, upload з N/total, full read-back < 120с → VERIFIED; throttle → AMBER (ніколи false-green); `#mav-verify-fast` → count-only.
- Stall: gap < 60с → триває; > 60с → «зупинилась на N/…».
- Session round-trip: handset → reload → connType restored, cable-рядок, `bootAutoReconnect` (Android) reopen раз; desktop reload не auto-reconnect, не throw.
- Real EdgeTX: USB=Serial, VCP=MAVLink, ELRS 3.5, `SERIALx_PROTOCOL=2` → heartbeat+HUD → real spray upload+read-back.
- #12 interaction: після маршруту — decimated fence по тому ж ELRS → обидві завершуються (fence на narrow 60/120), fence read-back AMBER-safe.

### G.3 #8
- Upload → AUTO 100% (SITL) → disarm → showSavedFields: зроблено 0.0, залишилось=area_ha, «виконано: 1 раз»; `completed_count=1, done_ha=0`.
- Partial ~40% → зроблено≈covered_ha, залишилось clamp≥0, count незмінний.
- Два partial + ≥90% → done_ha росте, reset 0 + count++ на третьому.
- Re-upload того ж поля (§4.4 UPSERT) → done_ha/count/last_flight_at PRESERVED, geometry updated.
- Recycled name: `Поле 2` → delete → новий `Поле 2` (інший fieldId) → credit лише на новий (gate rejects mismatch).
- Raw/no-plan → covered null → без змін.
- Kill→reopen → §4.2 restore банкує partial раз → credit раз (`flogHas` dedup).
- i18n: `done X.X ha · left Y.Y ha · completed fully: N time(s)`; `plurCount` 1→раз/time, 3→рази/times, 5/11→разів/times.
- Legacy-запис (без полів) → 0.0/area_ha/0 без error.

### G.4 #9
- Engine: `spacing > boom_m` → non-empty gaps ≈ field−band, `gap_ha>0`, амбер-смуги між проходами; `spacing == boom_m` (дефолт) → **немає** між-прохідних gaps (коректно).
- Central exclusion → gaps як slivers, що **виживають** проти boundary (feather-фікс не з'їв); НЕ повне margin-кільце при margin=0.
- margin=10 → clip-to-cover: без gap-кільця по краю.
- Projection: довге тонке поле далеко від екватора → gaps точно на голих смугах (home-frame, не centroid).
- Invalid-exclusion: виріз, чиє кільце перетинає межу cover → `unary_union`-subtraction не кидає, gap коректний (не зникає через try/except).
- Phantom-transit: план без anchor → gaps НЕ замальовані фіктивною home→wp0/RTL-легою (band лише з проходів).
- Perf: велике OSM (>2k vertices, сотні проходів) → build ок, overlap suppressed >900, gap рендериться; заміряти paint на Android; `rings()` simplify зрізав vertex-count.
- Toggle: off→on з кешем НЕ re-run engine; без кешу → рівно один build; зміна поля reset `lastViz`.
- i18n UA/EN gap label/row/tooltip.

### G.5 #10
- Server: POST `/api/sync` fields+flights → файли `logs/sync/fleet/`; re-POST з newer `updated` → LWW keeps newest; older → retained; new `started_at` → appended; dup `(started_at,device)` → не дублюється; >8MB → 413; malicious id → sanitized, no path-escape.
- Push happy: enable → save field → push → у серверних файлах; fresh profile → **ручний** `syncRestore` імпортує як копії (rename-collision), НЕ overwrite локальний.
- #8 survives sync: finalize bump `done_ha`+`updated` → push → сервер несе новий прогрес.
- Offline-first: airplane → save → dirty set, no error → `online` → auto-push.
- APK native: `AndroidSync.push` round-trip CORS-free; `URL_BASE=''` (public) → disabled, no crash, no egress.
- Security: grep repo VPS-host/basic-auth → none; public build → нуль sync-egress; `SYNC_BASE` empty → UI-група схована.
- Non-contention: armed AUTO → push skipped (gate `!armed`); resumes on disarm/foreground.

### G.6 #11
- Metric identity: SITL flying → overlay `%` == HUD «Прогрес» `%` == `setProgressPct` (усі `p.pct`).
- Single side-effect: instrument `mavUpdateTarget/mavCountdown` → рівно один виклик/poll після hoist.
- HUD unchanged: diff HUD-рядків до/після `mavRenderHud(s)→(s,p)` → ідентично.
- Toggle+persist: тап → миттєво hide/show; reload → `fmp_session.overlay` restored; `.active` tracks.
- Disconnect: mid-flight «Відключити» → overlay hides (без frozen-frame).
- Gate: лише planning → overlay hidden; connect → з'являється.
- Field-readability: hero ≥26/800 tabular з text-shadow; battery/armed/link пороги (ARMED red, low-batt red, no-hb red).
- Pass-through: pan/pinch починаючи на картці → мапа рухається (pointer-events:none); toolbar zoom/locate/follow клікаються (offset).
- Responsive <760px: картка чистить FAB + top-left стек; ≥760px над мапою.
- Heartbeat-only + battery-unknown: chips «—» (не 0%/-1%); p==null → «—»+0-width.
- Backgrounding: `document.hidden` → overlay стоп; foreground → resume.

### G.7 #12
- SITL ArduCopter concave L-field, home у внутрішньому куті **поза** полем → ingress = straight до nearest safe entry + corridor до wp0, жодна лега не ріже notch; download → усі NAV_WAYPOINT всередині field−exclusions (shapely-check).
- Central pond, home навпроти wp0 → ingress навколо ставка (vis-graph), egress лендить at home, terminal NAV_LAND@home.
- Degenerate: вирізи з'їли поле → per-side ok:False → straight RTL + **persistent** warn, нуль інжектованих WP (layout == legacy).
- **Disconnected-lobes unit** (engine): дві free-лоби → `ok:False`, НЕ straight-crossing (валідує strict-containment gate).
- Empty ingress: home видимий до wp0 → `ingress==[]`, layout == legacy крім terminal LAND.
- Per-side: ingress_ok=True, egress_ok=False (штучно) → terminal **RTL** (не NAV_LAND без валідного egress).
- Resume-after-battery під baked-transit: fly partway → kill/relaunch → resume → `flownLead` враховує ingress → re-takeoff at home, corridor до resume-point, progress-%/wp мапляться коректно.
- Completion: ≥90% на останньому COVERAGE-wp (не після egress); covered_ha==area_ha; egress → окремий «повертається».
- Fence: build_fence на dense contour (>84) → decimated≤84, valid, inclusion-contains-exclusion, ≥3/ring; uploadFence(type=1) → verifyFence VERIFIED; corrupt vertex → MISMATCH з seq+метрикою (flat ±100).
- **wp_total isolation:** upload mission (type 0) → одразу fence (type 1) → HUD `wp N/total` НЕ переписаний fence vertex count (guard `missionType===0`).
- **!armed guard:** спроба `mavUploadFence` при `armed` → відмова, жодного PARAM_SET.
- **home-gate:** home 1м поза inclusion АБО fallback-home (fix<3) → FENCE_ENABLE лишається 0 (точки залиті), warn; move inside+real-home → ENABLE=1 останнім, `getParam===1`, pre-arm passes.
- **exact readback:** мокнути FC, що ignore-ить FENCE_ENABLE → `getParam` ловить 0 (не «confirmed» через ±1).
- Recovery: `#mav-fence-off` → FENCE_ENABLE=0 → arming відновлено.
- Corridor-vs-fence: FENCE_MARGIN > route margin → warn; ≤ margin → baked corridor + проходи без tripping fence.
- INAV wing SITL: fence SKIP (MSP-note), safe-transit як NAV_WAYPOINT + RTL terminal, upload+verify (legacy) VERIFIED.
- Perf: 200+ vertex OSM → safe_transit < кілька сотень мс (shared ctx, node-cap).

### G.8 #13
- Manual pole → амбер SVG-маркер; reopen → повертається (`fmp_last_field.hazards`).
- Manual ЛЕП → проходи ОБХОДЯТЬ коридор `hazard-clearance`; вимкнув avoid → перетинає знову.
- Corridor: точка→коло, лінія→капсула; ширина=2×clearance.
- **#12↔#13:** з `#safe-transit` on → вхід/повернення теж оминають hazard-коридор (не лише проходи); fence exclusions включають avoid-hazard.
- OSM online: поле над реальною ЛЕП → import → лінії/стовпи **desaturated dashed** + банер; **avoid=false** (маршрут НЕ змінюється поки не увімкнув).
- OSM offline: airplane → зрозуміле повідомлення, без throw; повторний online → dedup за osm-id.
- Overpass fail: block primary → fallback; обидва впали → «недоступний», планування далі.
- ClipperLib absent (стаб): небезпеки видимі, `hazardCorridors=[]`, buildRoute ок + one-time warn.
- Персист per-field: A з небезпеками → save/upload → load B → назад A → небезпеки A з durable-record; `fieldId` не плутає.
- Native edit/trash: олівець тягне вузол → зберігається (жива геометрія); кошик видаляє небезпеку → поле НЕ зникає.
- i18n EN.
- Регрес part-1: upload→verify (три стани) не зачеплено; `collectExclusions()` без коридорів (KML/geozone/project чисті).

### G.9 SITL resume-after-manual-RTL (валідує §4.2)

**Архітектурна межа (усунення correction).** Resume-логіка (`resumeRemaining app.js:2275`, `resumeUploadRemainder :3685`, `flownSave :2267`, `#mission-resume`, `RESUME_KEY='fmp_mission_progress'`+`FLOWN_KEY='fmp_flown' :2255-2256`) — **вся в JS-IIFE**; `test_sitl*.py` ганяють `backend/mavlink_link.py` (окремий GCS без localStorage/resume). Тому ask ділиться на (a) SITL flight-behavior + persistence-**контракт** у Python, (b) Node-companion (`test_jsmav_resume.mjs`), що ганяє **реальний** JS-restore проти mock-localStorage. `web/mav/` **зникла з диска** → companion вантажить з **`web-stable/mav/`**. Kill/reopen (drop+reconnect) вимагає `sitl/sitl_mux.py` (:5763), бо SITL SERIAL0 (:5760) single-client і **виходить** на disconnect. Vertical-climb target = **cruise alt** (`buildMissionItems(home, Math.max(alt,2), wps, alt, ...)`, `:2503`), Python-mirror має `takeoff_alt=wp_alt=alt`.

- **S0 — Scaffold:** launch SITL (`test_sitl.py:78` args + `sitl/resume_params.parm`) + `sitl_mux.py`; GCS→`127.0.0.1:5763`; heartbeat + 3D-fix (reuse `test_sitl_wind.wait_gps`). **Mux обов'язковий**, інакше S4 drop вбиває SITL.
- **S1 — Fly AUTO mid-mission:** lawnmower ≥8 pts, `route[0]↔route[mid]`>40м; upload FULL з §4.1 default-full verify → `verified True`; arm→AUTO→mission_start; sample до `wp_current=LEAD+idx_target(≈len//2)`; `saved_wp=max wp_current`. Assert `saved_wp==LEAD+idx_target±1`, wp monotonic (no-rollback guard `:2310`), `wp_total==len(build_mission_items)`.
- **S2 — Manual RTL → land:** `set_mode('RTL')`; assert mode RTL ≤2с; wp_current НЕ advance за saved_wp; poll до landed (`armed False` або `alt<0.6`) ≤200с; `haversine(cur,home)<5м`.
- **S3 — Persist contract (§4.2):** `write_flown_blob(home non-null, rtl, lead=LEAD, wpTotal, status:'confirmed')` + `write_resume_blob(saved_wp)`. Assert NEW-format несе non-null home; OLD-format (без home) → `flownHome=None` (демонструє §4.2 MAJOR-bug: resume-as-first-upload писав home=null → `_progGeom` RTL/countdown unbuildable); обидва рахують той самий `rem` (remainder не залежить від home, лише RTL-лега).
- **S4 — Kill+reopen:** drop socket, null in-memory; `reopen_gcs()` fresh `MavLink()`→:5763→reconnect **без виходу SITL** (mux); re-read blobs; `rem=resume_remaining(FLOWN.route, RESUME.wp, FLOWN.lead)`; `flownHome=FLOWN.home`. Assert `rem not None`, `rem.idx==idx_target±1`, `rem.rest[0]==route[idx_target]`, `flownHome≈SITL home <1e-6°`.
- **S5 — Resume upload remainder:** `items_rem=build_mission_items(home=flownHome, takeoff_alt=alt, rest, wp_alt=alt, rtl=True, speed)`; upload+verify `verified True`; download. Assert `count==3+len(rest)+1`; seq1 cmd22 (NAV_TAKEOFF) z==alt; перший real NAV_WAYPOINT (seq3) x≈`route[idx_target]*1e7` (≤5 units) і **≠** `route[0]` (>>5); seq0 home≈SITL home (~50 units, ArduPilot re-stores home).
- **S6 — Fly remainder vertical-first:** `p0` перед mission_start; AUTO+mission_start; `assert_vertical_first(link,p0,alt,drift_tol=3.0)`: (a) `alt<0.9*alt`→`haversine<3м` І `gs<2м/с`; (b) alt≥0.9 ДО того як horizontal до `route[idx_target]` закрилась >5м; (c) min `haversine(cur,route[0])>20м` (НЕ revisits start); (d) проходить ≤8м від `route[idx_target]` перед `[idx_target+1]`; (e) до останнього remainder-WP → RTL.
- **S7 — Idempotence/guards:** після S5 `resumeClear` (RESUME_KEY removed) → друга reopen offer nothing (`resume_remaining(None)→None`); guard `idx<1`→None, `len(rest)<2`→None; ordering: FLOWN описує (коротший) remainder поки RESUME cleared, ніколи навпаки (`flownSave`-перед-`resumeClear`).
- **S8 — Airborne resume (3609e5f):** S1 але `set_mode('LOITER')` замість RTL; reopen airborne, S5 upload; AUTO+mission_start airborne. Assert від mission_start до takeoff-item-done: alt НЕ падає >2м нижче loiter, horizontal лише після alt≥target (no dive/diagonal); далі S6(c)/(d). *(Для реального airborne-CLIMB треба GUIDED-reposition-lower — open question; інакше constant-alt no-dive.)*
- **S9 — Wind:** S1→S6 під `SIM_WIND_SPD` 0 (drift_tol 3м, hard) і 7м/с (6м/gs<3м/с, soft); correct-WP/never-from-start hard в обох.
- **S10 — Node companion (реальний JS):** mock localStorage → `flownSave(route,home,hasRtl)`→`missionProgressTick`(save wp)→manual-RTL→**WIPE** in-memory→`flownRestore()`→`resumeRemaining()`. Assert `rem.rest/idx` byte-identical pre/post-kill; `flownHome` non-null після resume-as-first-upload (§4.2 MAJOR-fix); `FLOWN_KEY.status 'uploading'→'confirmed'`; boot status=='uploading' → «ймовірно залито — перевір» (не «НЕ залито»); `#mission-resume` restored з `fmp_session.resume` (`:1400`). Вантажити з **`web-stable/mav/`**.

Нові компоненти тесту: `test_sitl_resume.py` (S0-S9, через mux :5763), `resume_remaining`/`reopen_gcs`/`reconstruct_from_disk`/`assert_vertical_first` mirrors (LEAD pinned `2+(speed>0)`), `sitl/resume_params.parm` (RTL_ALT 1500/LAND_SPEED_HIGH 500/DISARM_DELAY 2/RTL_LOIT_TIME 0/ARMING_CHECK 0), `test_jsmav_resume.mjs`, опц. `web-stable/mav/resume.js` (extraction — SSOT для app.js+тесту).

---

## H. Порядок реалізації part-2 (у межах фаз §10) + поза скоупом

Продовжує фази part-1. Ключове правило: **JS-only part-2 лендиться після відповідної part-1-фази; #12 розбито на два юніти.**

- **Phase 2+ (розширення §10-Phase 2, JS)** — **#5-additions** (Га/хв, фільтр, 5 плиток), **#8** (`fldGet`, `fieldProgressCredit`, `plurCount`, divIcon+prompt-прогрес; **потребує §4.4 merge-preserve UPSERT**). Обидва — над готовим §4.5/§8. Дизайн-система §F застосовується тут (5-плитка auto-fit, 4-th tab nowrap).
- **Phase 3+ (розширення §10-Phase 3, JS)** — **#10** (push-only backup + ручний restore-as-copies; `serve.py /api/sync`; `SyncBridge.kt`; `#8 updated`-bump). Node/serve-тести.
- **Phase 4+ (розширення §10-Phase 4)** — **#7** (handset-пресет + narrow-профіль + `bootAutoReconnect handset`-case). Немає Android-змін окрім реєстрації `SyncBridge` (Phase 3).
- **Phase 5+ (розширення §10-Phase 5, JS)** — **#11** (hoist `mavProgressData`, `mavOverlayEnsure/Render`, OverlayControl), **#9** (`boom_m`, gap-engine + gapLayer + cache-and-toggle; opt факт-оверлей — Phase-2), **#13** (небезпеки + hazardCorridors + OSM-import). Дизайн-система застосовується.
- **Phase 6+ (розширення §10-Phase 6, cross-cutting) — #12 як ДВА юніти:**
  1. **#12-BACKSTOP (геозона)** — `Api.build_fence`, `buildFenceItems/uploadFence/verifyFence`, `mission_type`-threading (+ `wp_total`-guard), `mavUploadFence` з усіма guard-ами (!armed, real-home, exact-readback, `#mav-fence-off`). Простіша зв'язаність; висока safety-цінність; ArduPilot-only.
  2. **#12-PRIMARY (safe-transit)** — `coverage.safe_transit` (strict-containment gate, per-side ok), `Api.safe_transit`, `FMP_ENGINE.call`, `buildMissionItems opts`, **seq-remap** (`flownLead+=ingress`, `lastCoverageSeq−=egress`, resume/progress/completion). **Лендиться атомарно з §7.1/§8-змінами** і **лише після** SITL-resume (G.9) зеленого під інжектованими транзит-WP.

**Що ПОЗА скоупом part-2:**
- #10 pull/LWW-reconcile, tombstones, delta-cursor, iOS `fmpSync`, per-device provenance UI (v1 = push-only + ручний restore-as-copies).
- #9 факт-оверлей пройденого треку (Phase-2; конфліктує з §5 `KEEP_SAMPLES=false`; live `droneTrack` in-session).
- #9 covered-area на `boom_m` (v1 covered = spacing per §8; open question).
- #11 flight-time/distance-flown паритет (потребує native `getSnapshot`; open question).
- #12 `OA_TYPE=Dijkstra` для непланового failsafe-return; FENCE_RETURN_POINT (5000); INAV geozones (MSP).
- #13 fly-over min-AGL (фаза-2), власне Overpass-дзеркало на VPS.
- HTML scrollable saved-fields-панель для #8 (v1 = divIcon+prompt).
- Окрема HTML `.stats`-картка+`.fmp-bar` для #8-прогресу (немає такої поверхні).

---

## I. Відкриті питання для Івана (part-2)

1. **#5 Avg Га/хв:** ratio-of-sums (Σcovered/Σхв — обраний дефолт, продуктивність) чи середнє per-flight-rate? Різняться при різних розмірах вильотів.
2. **#5 statsRange persist:** тримати обраний період через relaunch (`fmp_session`) чи скидати на «усе»?
3. **#7 baud:** lock read-only на handset чи editable (деякі EdgeTX MAVLink-serial на 57600)? Дефолт: editable, seed 115200.
4. **#7 fence-over-ELRS FENCE_TOTAL decimation-target:** 84 (legacy) чи читати реальну ємність FC?
5. **#8 display-surface:** 4-рядковий divIcon чи винести done/left/completed у Leaflet-popup на тап (чистіші лейбли, +1 взаємодія)? Плюс: HTML scrollable-панель полів — робити?
6. **#8 «зроблено» cap:** capped area_ha (ніколи > поле) чи справжня кумулятивна оцінка (може перевищити)? Зараз: uncapped зроблено, clamped залишилось.
7. **#9 boom_m default:** = spacing (обрано, стик-у-стик без прогалин) чи окреме поле, яке оператор завжди задає? І чи уніфікувати covered-area (§8) на boom_m?
8. **#9 gap-clip:** interior-only (clip до `cover`, ховає margin-бордюр — рекомендовано) чи full-field (показує margin як прогалину)?
9. **#10 delete-propagation:** additive-only (обрано, безпечно) чи tombstones? І: bucket single-tenant `fleet` чи Caddy-forwarded auth-user? Чи справді `/api/sync` на VPS обслуговує `serve.py` за Caddy (як `/api/log`)?
10. **#10 restore-UX:** ручний «Відновити з сервера» як import-as-copies (обрано) — чи потрібен per-device provenance-фільтр на desktop?
11. **#11 паритет:** додати flight-time/distance-flown через native `getSnapshot()` (Android), degrade-hidden на web — чи тримати строгий `lastStatus`-subset (рекомендовано)? І ETA/«до завершення» як 4-й progress-рядок?
12. **#12 terminal:** NAV_LAND@home (обрано, буквально «точки до дому + land») чи фінальний NAV_WAYPOINT@home + RTL (climb до RTL_ALT)?
13. **#12 fence inclusion:** сирий контур (обрано, hard-межа) чи margin-inset? FENCE_ACTION дефолт RTL чи Land (operator-selectable)?
14. **#12 safe-transit default:** ON для всіх (обрано, флагманська safety) з `#safe-transit` для disable — чи opt-in?
15. **#12 home OUTSIDE поля:** лишати FENCE вимкненим+warn (обрано) чи auto-expand inclusion коридором до дому (defeats fence)?
16. **#12 min-margin:** пропонувати safe-transit лише при `margin > GPS-похибка + 0.5м`? Який поріг?
17. **#13 OSM avoid default:** OFF (display-only, рекомендовано — не створює хибного «оброблено») чи ON? Запас обходу дефолт 25 м — тюнити польово? Окремі tower/pole-вузли буферити в avoid чи лише рендерити?
18. **SITL-resume:** повний Playwright-E2E реального `app.js`+SITL (ловить DOM/HUD-регреси) чи (SITL-contract + Node-pure) достатньо для v1? І GUIDED-reposition-lower у `backend/mavlink_link.py` для реального airborne-CLIMB (S8) чи constant-alt no-dive?
