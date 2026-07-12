# BLE MAVLink transport («як у SpeedyBee App») — design spec

Дата: 2026-07-12. Статус: затверджено Іваном («зроби весь функціонал для заливання місії по блютуз»).
Ціль: телефон (APK) підключається до дрона по Bluetooth Low Energy — скан → список пристроїв →
конект → жива телеметрія → **заливка місії** — без WiFi-бекпака і без кабеля.

## 1. Правда про SpeedyBee BT (визначає постановку)

Вбудований Bluetooth SpeedyBee-польотників — **прозорий BLE-UART місток**, приварений до одного з
UART FC. SpeedyBee App говорить по ньому MSP лише тому, що на тому UART у прошивці за замовчуванням
MSP. Фраза ArduPilot-доків «not compatible with existing ArduPilot ground stations» означає
«Mission Planner/QGC не вміють BLE GATT», а не «канал не пропускає MAVLink».

**Налаштування FC (ArduCopter, F405 V3/V4):** на BT-UART виставити `SERIALx_PROTOCOL = 2`
(MAVLink2) + `SERIALx_BAUD` = швидкість містка (типово 115200). Який саме SERIALx — див.
чеклист у кінці (докладається за результатами розвідки + польової перевірки).
**Трейд-оф:** той UART стає MAVLink-only → SpeedyBee App по BT більше не конфігурує (лише USB).

Авто-детект GATT-сервісу (пріоритет; підтверджено розвідкою 2026-07-12 — офіційний
Betaflight Configurator говорить із вбудованим SpeedyBee-BT через Web Bluetooth цими ж
сервісами, що доводить прозорість містка):
1. **SpeedyBee V2** `0000ABF0` — вбудований BT SpeedyBee-польотників (первинна ціль).
2. **SpeedyBee V1** `00001000` — старіші SpeedyBee.
3. **Nordic UART Service (NUS)** `6E400001-B5A3-…` — ESP32/nRF містки.
4. **HM-10/CC254x** `FFE0` — дешеві модулі та адаптери.
5. **Генерик-фолбек:** перший сервіс, що має notify- + write-характеристики.

Ролі (write vs notify) в зматченому сервісі визначаються за **properties характеристик**,
не за UUID — таблиці ролей цих UUID у дикій природі суперечливі.

## 2. Архітектура

JS-шар (`mav/link.js`) вже транспортно-агностичний: `MavLink.connect(transport)` приймає
`{write(Uint8Array), close(), ondata}`. BLE — **четверта** нативна фабрика поряд із
serial/udp/ios. `link.js` НЕ змінюється.

### 2.1 `BleBridge.kt` (новий, дзеркалить `UdpBridge.kt`)

JS-контракт (`window.AndroidBle`, байти base64, як у AndroidUdp):
```
AndroidBle.startScan()  -> {ok}|{ok:false,error}; знахідки → window.__androidBleScan('{"addr","name","rssi"}')
AndroidBle.stopScan()
AndroidBle.connect(addr)-> {ok,pending:true}; далі window.__androidBleEvent('open', bool, detail)
AndroidBle.write(b64)      // чанкування по MTU-3 всередині моста
AndroidBle.close()
вхідні байти            -> window.__androidBleData('<base64>')
діагностика             -> window.__fmpNativeLog('[ble] …')  (падає в клієнт-лог, як [udp])
```

GATT-конвеєр: `connectGatt(autoConnect=false, TRANSPORT_LE)` → `requestMtu(247)` →
`discoverServices()` → авто-детект характеристик (§1) → CCCD `0x2902` ENABLE →
`requestConnectionPriority(HIGH)` → `event('open', true)`.

Жорсткі правила Android BLE:
- **Одна GATT-операція за раз** → черга (`ConcurrentLinkedQueue` + busy-flag), просування у
  `onCharacteristicWrite`/`onDescriptorWrite`/`onMtuChanged`. `write*` що повернув false → повторна
  постановка в чергу.
- **MTU 247 + HIGH priority + WRITE_NO_RESPONSE обовʼязкові** (інакше ~2 кБ/с). Якщо MTU-запит
  відхилено — працюємо на 23 (20 корисних) — повільно, але живе.
- **GATT 133 на конекті** — до 3 спроб із backoff 600 мс, перед кожною `gatt.close()`.
- Розрив зʼєднання → `event('open', false, …)` / `close` — JS показує «відключено»; авто-реконект
  свідомо НЕ робимо в v1 (неперевірюваний без заліза; heartbeat-вотчдог link.js і так гасить стан).
- Фрагментація: notify-чанки віддаються в JS як є — парсер jsMav працює з довільним байтовим потоком.

### 2.2 Дозволи (обидва маніфести: main + play)

- API 31+: `BLUETOOTH_SCAN` (`neverForLocation`) + `BLUETOOTH_CONNECT` — runtime-запит
  з Activity (request code 9), тригериться першим `startScan()`.
- API ≤30: `BLUETOOTH` + `BLUETOOTH_ADMIN` (`maxSdkVersion=30`, manifest-only) +
  `ACCESS_FINE_LOCATION` (уже є, запитується на старті).
- `<uses-feature android.hardware.bluetooth_le required=false>` + runtime-перевірка адаптера.

### 2.3 JS/UI (обидві web-копії: `web-stable` git + APK `assets/web`; `mav/*.js` ідентичні)

- `mav/transport.js`: `openAndroidBle(addr)` — копія `openAndroidUdp` з `__androidBleData`/
  `__androidBleEvent`, таймаут конекту 20 с; export у `MAV_TRANSPORT`.
- `index.html`: `<option value="ble">Bluetooth (BLE)</option>` + `#mav-ble-row`
  (кнопка «🔍 Сканувати» / список `#mav-ble-list` з імʼям+RSSI).
- `app.js`: опція ble ховається, якщо нема `window.AndroidBle` (браузер/Qt/PWA — інертно);
  `mavSyncRows()` показує ble-row; `mavConnString()` → `"ble:"+addr`;
  `jsMav.mav_connect` — гілка `conn.startsWith("ble:")` → `openAndroidBle(conn.slice(4))`
  (slice, НЕ split — MAC містить двокрапки); скан-хендлер апсертить пристрої в список,
  автостоп 15 с; останній пристрій памʼятається (localStorage `fmp_ble_last`).

### 2.4 Пропускна здатність

Стрім-рейти link.js уже врізані під вузький ELRS (~6.5 msg/s ≈ 0.4 кБ/с); BLE з MTU 247 + HIGH
дає 10–30 кБ/с — запас ×20. **Нічого не міняємо.** Заливка місії: BLE має link-layer ACK
(на відміну від UDP), `MISSION_ITEM_INT` ≈ 51–63 Б < MTU; наявна loss-tolerant заливка +
`MISSION_ACK`-верифікація працюють без змін. WiFi лишається кращим для швидкої телеметрії/дальності.

## 3. Безпека

Без змін — уже транспортно-агностичне в link.js: heartbeat-вотчдог (5 с тиші → connected=false),
заливка звітує успіх лише після `MISSION_ACK` + read-back verify. GATT-розрив додатково бʼє
`event('open',false)` → миттєвий стан «відключено».

## 4. Поверхні

| Поверхня | Зміни |
|---|---|
| `~/fmp-build/android` натив | `BleBridge.kt` (новий), `MainActivity.kt` (реєстрація + permissions), обидва `AndroidManifest.xml`, `build.gradle` (version) |
| `assets/web` (APK) | `mav/transport.js`, `index.html`, `app.js`, `version.json` |
| `web-stable` (git, канон) | ті самі web-зміни (ble-опція інертна поза APK) |
| VPS (прод-веб) | НЕ чіпаємо зараз (інертно в браузері; синк при промоуті за документованим порядком) |
| Диск-копія android | синк джерел назад після збірки |

Версія: 2.5.40 → **2.5.41** (versionCode 57) у gradle + обидві web-копії (APP_VERSION + version.json).
VPS version.json НЕ бампається (інакше update-цикл; бамп — лише при промоуті APK).

## 5. Тести (headless, без заліза)

- Node: фрагментаційний сим — MAVLink-потік, порізаний на довільних межах (1..MTU байт) →
  парсер збирає всі фрейми; заливка місії через «BLE-подібний» транспорт (надійний, чанкований,
  із затримкою) → 8/8 точок.
- `node --check` на всіх змінених JS (обидві копії).
- Мок `window.AndroidBle` → гілка `mav_connect` повертає транспорт правильної форми.
- На залізі (поле, Іван): скан бачить FC, конект, HUD, заливка. Діагностика — кнопка «Лог»
  (клієнт-логи вже їдуть на VPS, `[ble]`-рядки в них).

## 6. Чеклист налаштування FC (ArduCopter)

Вбудований BT сидить на UART, за платами (розвідка 2026-07-12, hwdef/мануали):
| Плата | UART | Параметри |
|---|---|---|
| F405 V3 / V4 | UART4 | `SERIAL4_PROTOCOL=2`, `SERIAL4_BAUD=115` |
| F405 AIO | UART1 | `SERIAL1_PROTOCOL=2`, `SERIAL1_BAUD=115` |
| F405 WING / MINI | UART6 | дефолт уже MAVLink2@115200 — лише перевірити |

1. USB → Mission Planner/mavproxy: виставити параметри з таблиці, перезавантажити FC.
   (Для ArduPilot трейд-офу немає: SpeedyBee App з ArduPilot і так не працює.)
2. FMP → вкладка «Політ» → Тип зʼєднання «Bluetooth (BLE)» → Сканувати → вибрати SpeedyBee → Підключити.
3. Якщо конект є, а телеметрії нема — лог покаже «[ble] rx: 0 пакетів … SERIALx_PROTOCOL=2?».
4. Заливка ~100 WP по BLE ≈ 5–15 с (+read-back верифікація) — latency-bound, це норма.
5. Перша польова перевірка нового заліза: nRF Connect → скан → конект → GATT-таблиця
   (скрін) — підтверджує сервіс `ABF0`/`1000` і MTU.
