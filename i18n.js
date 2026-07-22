/* UA → EN translation table for Field Mission Planner.
 *
 * Ukrainian is the SOURCE language (the strings in index.html / app.js). Each key
 * is the EXACT Ukrainian text (internal whitespace collapsed to single spaces, as
 * the DOM walker in app.js normalises it). app.js reads this as `window.FMP_TR`.
 * Add a key here to translate a new string; a missing key falls back to Ukrainian.
 */
window.FMP_TR = {
  // ---- static UI: buttons / labels / panel titles ----
  "ArduCopter · обприскування поля": "ArduCopter · field spraying",
  "План": "Plan",
  "Політ": "Flight",
  "Додаток": "App",
  "Параметри маршруту": "Route parameters",
  "Побудова та експорт": "Build & export",
  "Побудувати маршрут": "Build route",
  "Скасувати побудову маршруту": "Cancel route build",
  "Показувати покриття та накладання": "Show coverage & overlap",
  "Ширина внесення (крок проходів), м": "Swath width (pass spacing), m",
  "Кут проходів, °": "Pass angle, °",
  "Кут проходів": "Pass angle",
  "Автокут — мінімальний час польоту": "Auto angle — minimum flight time",
  "Відступ від країв, м": "Edge margin, m",
  "Висота польоту (над точкою зльоту), м": "Flight altitude (above take-off), m",
  "Швидкість, м/с": "Speed, m/s",
  "Повернення (RTL) в кінці місії": "Return (RTL) at mission end",
  "Круглий розворот (діаметр = крок гонів)": "Rounded turn (diameter = pass spacing)",
  "Дрон робить круглий розворот вкінці кожного гону радіусом «крок / 2» — виставляється автопілоту при заливці по кабелю (WP_RADIUS_M). Точки маршруту не додаються; на більшому радіусі дрон трохи зрізає торці гонів.":
    "The drone flies a rounded U-turn at each pass end with a radius of «spacing / 2» — set on the autopilot at upload over the cable (WP_RADIUS_M). No extra waypoints are added; a larger radius makes the drone cut the pass ends slightly.",

  // ---- exclusions / contour ----
  "Додати виріз": "Add cut-out",
  "Зберегти вирізи": "Save cut-outs",
  "Очистити вирізи": "Clear cut-outs",
  "Редагувати вирізи": "Edit cut-outs",
  "Редагувати вершини контуру": "Edit contour vertices",
  "Очистити": "Clear",
  "Усі поля на карті": "All fields on the map",

  // ---- export / import ----
  "Експорт / Імпорт": "Export / Import",
  "Експорт маршруту:": "Route export:",
  "Геозона (контур):": "Geofence (contour):",
  "Геозона .plan": "Geofence .plan",
  "Контур .geojson": "Contour .geojson",
  "Контур .kml": "Contour .kml",
  "Імпорт .kml": "Import .kml",
  "Проєкт (поле + параметри):": "Project (field + parameters):",
  "Зберегти проєкт": "Save project",
  "Завантажити проєкт": "Load project",
  "Журнал польотів (JSON)": "Flight log (JSON)",
  "Записи робіт (CSV)": "Work records (CSV)",
  "Зберегти карту району офлайн": "Save area map offline",

  // ---- connection / MAVLink ----
  "Підключення до дрона": "Connect to drone",
  "Тип зʼєднання": "Connection type",
  "Кабель (USB) / радіо / мережа. Маршрут — у вкладці «План».": "Cable (USB) / radio / network. Route is on the «Plan» tab.",
  "Кабель / радіо (COM-порт)": "Cable / radio (COM port)",
  "COM-порт": "COM port",
  "Оновити список портів": "Refresh port list",
  "Вибрати пристрій (USB)": "Select device (USB)",
  "UDP (мережа / SITL)": "UDP (network / SITL)",
  "Адреса (host:port) — авто": "Address (host:port) — auto",
  "авто: 0.0.0.0:14550": "auto: 0.0.0.0:14550",
  "Порожнє = слухати всі мережі на 14550.": "Empty = listen on all interfaces on 14550.",
  "Швидкість (baud)": "Baud rate",
  "Підключити": "Connect",
  "Відключити": "Disconnect",
  "Завантажити місію в дрон": "Upload mission to drone",
  "Місія в дроні": "Mission on drone",
  "Стежити за дроном (центрувати карту)": "Follow the drone (center the map)",

  // ---- GPS guard ----
  "Захист GPS (глушіння / спуфінг)": "GPS guard (jamming / spoofing)",
  "Захист GPS (глушіння/спуфінг)": "GPS guard (jamming/spoofing)",
  "Контроль супутників / HDOP і стрибків позиції. При глушінні чи спуфінгу — звуковий сигнал і вібрація. Рішення (посадка / зміна режиму) — за оператором.":
    "Monitors satellites / HDOP and position jumps. On jamming or spoofing it beeps and vibrates. The decision (land / change mode) is the operator's.",
  "ЗАГРОЗА GPS": "GPS THREAT",
  "Зрозумів — заглушити сигнал": "Got it — silence the alarm",

  // ---- flight control ----
  "Керування польотом": "Flight control",
  "Режим польоту": "Flight mode",
  "Встановити режим": "Set mode",
  "Старт місії (AUTO)": "Start mission (AUTO)",
  "AUTO (місія)": "AUTO (mission)",
  "RTL (додому)": "RTL (home)",
  "LOITER (пауза)": "LOITER (hold)",
  "LAND (посадка)": "LAND",
  "BRAKE (стоп)": "BRAKE (stop)",
  "ARM/СТАРТ/RTL «протягни-щоб-підтвердити»": "ARM/START/RTL «slide-to-confirm»",
  "Послідовність: ARM → «Старт місії» (AUTO). Тримайте готовність до перехоплення керування.":
    "Sequence: ARM → «Start mission» (AUTO). Stay ready to take over control.",
  "Кожен виліт логується офлайн і калібрує оцінку часу / заряду.": "Every flight is logged offline and calibrates the time / battery estimate.",
  "Лог для аналізу (надіслати/зберегти)": "Log for analysis (send/save)",

  // ---- baud options ----
  "115200 (USB-кабель)": "115200 (USB cable)",
  "57600 (радіо SiK)": "57600 (SiK radio)",
  "Авто (підібрати)": "Auto (detect)",

  // ---- update / install / app tab ----
  "Перевірити / оновити додаток": "Check / update the app",
  "Перевірити оновлення": "Check for updates",
  "Перевіряє сервер на нову версію й оновлює прямо тут: веб-версія — миттєво, APK — завантажить новий і запропонує встановити.":
    "Checks the server for a new version and updates right here: web — instantly, APK — downloads the new one and offers to install.",
  "Встановити додаток": "Install the app",
  "Встановити як додаток (ПК / Android-веб)": "Install as an app (PC / Android web)",
  "Офлайн-додаток. Тут завжди актуальна версія — встановив раз, далі працює без інтернету.":
    "Offline app. Always the current version here — install once, then it works without internet.",
  "У Chrome: меню (⋮) → «Встановити додаток» / «Додати на головний екран».":
    "In Chrome: menu (⋮) → «Install app» / «Add to Home screen».",
  "Android — нативний (APK):": "Android — native (APK):",
  "Завантажити Android APK — БЕТА v2.6.6-beta": "Download Android APK — BETA v2.6.6-beta",
  "Версія стабільного APK:": "Stable APK version:",
  "Бета (тестова збірка):": "Beta (test build):",
  "прямий зв'язок з польотником (STM32 / Pixhawk) по USB-кабелю. Завантаж → дозволь встановлення з невідомих джерел → відкрий.":
    "direct link to the flight controller (STM32 / Pixhawk) over USB. Download → allow install from unknown sources → open.",
  "iOS — TestFlight (скоро)": "iOS — TestFlight (soon)",
  "ПК (Windows / Mac):": "PC (Windows / Mac):",
  "дрон по USB-кабелю": "drone over the USB cable",
  "просто відкрий цей додаток у": "just open this app in",
  "нові функції на перевірку. Ставиться": "new features to test. Installs",

  // ---- backup-sync (own server, opt-in) (#10) ----
  "Резервна копія (свій сервер)": "Backup (own server)",
  "Опційно: зберігає поля, журнал польотів і параметри на твоєму сервері, щоб не втратити їх при заміні або втраті телефону. Дані йдуть лише на твій сервер.":
    "Optional: backs up fields, flight log and settings to your own server, so you don't lose them if the phone is replaced or lost. Data goes only to your server.",
  "Автосинхронізація": "Auto-sync",
  "Синхронізувати зараз": "Sync now",
  "Відновити з сервера": "Restore from server",
  "вимкнено": "off",
  "остання синхронізація: {0}": "last sync: {0}",
  "синхронізацій ще не було": "no sync yet",
  "Сервер не налаштовано.": "Server not configured.",
  "Не вдалося синхронізувати із сервером.": "Could not sync with the server.",
  "Синхронізовано із сервером.": "Synced with the server.",
  "Отримую копію з сервера…": "Fetching the server copy…",
  "Немає копії на сервері.": "No copy on the server.",
  "Копія на сервері від {0}, полів: {1}.": "Server copy from {0}, fields: {1}.",
  "Локально зараз полів: {0}.": "Locally right now, fields: {0}.",
  "Перезаписати локальні дані копією з сервера? Застосунок перезавантажиться.":
    "Overwrite local data with the server copy? The app will reload.",
  "Відновлено з сервера. Перезавантаження…": "Restored from the server. Reloading…",
  "Відновлено частково — перевір поля/статистику.": "Partially restored — check fields/stats.",
  "оновлюється з середини додатку": "updates from inside the app",

  // ---- fragmented help sentences (translated node-by-node) ----
  "(USB Apple забороняє).": "(Apple forbids USB).",
  "(WebSerial). Тисни «Встановити» нижче, щоб був як окремий застосунок і працював офлайн.":
    "(WebSerial). Tap «Install» below to make it a standalone app that works offline.",
  "(захист від випадкових дотиків у полі); фікс пропуску вузьких ділянок поля.":
    "(protection against accidental touches in the field); fix for skipping narrow field areas.",
  "(потрібен Apple Developer Program, $99/рік) — тоді тут з'явиться посилання-запрошення. Поки iOS-збірка готова й перевірена, але не опублікована. Зв'язок з дроном на iOS — лише":
    "(requires the Apple Developer Program, $99/yr) — then an invite link appears here. For now the iOS build is ready and tested, but not published. Drone link on iOS is only via",
  "(тапни версію вгорі → «Оновити») — далі не треба качати вручну.":
    "(tap the version at the top → «Update») — no more manual downloads.",
  "APK вище": "the APK above",
  "Android у браузері": "Android in a browser",
  "Mac + Xcode по кабелю (безкоштовний Apple ID, сертифікат діє 7 днів) — шлях розробника; або":
    "Mac + Xcode over cable (free Apple ID, certificate valid 7 days) — the developer path; or",
  "WiFi / ELRS-бекпак": "WiFi / ELRS backpack",
  "», стабільну не замінює й не видаляє. Зараз у беті:": "», it does not replace or remove the stable one. Currently in beta:",
  "З версії 2.6.5 бета": "Since version 2.6.5 the beta",
  "НОВИЙ польовий інтерфейс": "NEW field interface",
  "На": "On",
  "ОКРЕМО": "SEPARATELY",
  "від стабільної — інша іконка «": "from the stable one — a different icon «",
  "не дозволяє": "does not allow",
  "ставити додатки із сайту, як APK — тому «завантажити й відкрити» на iOS неможливо. Нативний застосунок ставиться лише через:":
    "installing apps from a website like an APK — so «download & open» is impossible on iOS. The native app installs only via:",
  "— карта на весь екран + великі кнопки по кроках Поле→Маршрут→Дрон→Політ (видно, що тиснути далі); керування":
    "— full-screen map + big step buttons Field→Route→Drone→Flight (you see what to press next); controls",
  "— лише ПЛАНУВАННЯ (браузер Android не має доступу до USB). Для дрона на телефоні —":
    "— PLANNING only (an Android browser has no USB access). For the drone on a phone —",
  "— оновити список —": "— refresh the list —",
  "— повний функціонал: планування +": "— full functionality: planning +",

  // ---- misc ----
  "Меню / параметри": "Menu / parameters",
  "Закрити панель": "Close panel",
  "Увімкнено": "On",
  "Маршрут не побудовано.": "No route built.",
};

// ---- dynamic user-facing strings (messages / statuses / stats labels) ----
Object.assign(window.FMP_TR, {
  // stats panel labels + section
  "Точок маршруту": "Route waypoints",
  "Площа": "Area",
  "Вирізано (перешкоди)": "Cut out (obstacles)",
  "Покрита площа": "Sprayed area",
  "Робочий розчин": "Working liquid",
  "Заправок бака": "Tank refills",
  "Довжина": "Length",
  "Орієнт. час": "Est. time",
  "Покриття поля": "Field coverage",
  "Перекриття": "Overlap",
  "Відступ": "Margin",
  "Секцій (рівні за площею)": "Sections (equal area)",
  "Висоти поля (макс · мін · перепад)": "Field elevation (max · min · range)",
  // build / route
  "Будую…": "Building…",
  "Готую офлайн-рушій…": "Preparing the offline engine…",
  "Побудову маршрут скасовано.": "Route build cancelled.",
  "Побудову маршруту скасовано.": "Route build cancelled.",
  "Маршрут не побудовано.": "No route built.",
  "Контур поля задано.": "Field contour set.",
  "Спочатку задай поле на карті.": "Set the field on the map first.",
  "Спочатку задай поле.": "Set the field first.",
  "Спочатку задайте контур поля на карті.": "Set the field contour on the map first.",
  "Офлайн-рушій не зміг побудувати маршрут. Онови застосунок у вкладці «Додаток» (або перевстанови APK).":
    "The offline engine could not build the route. Update the app on the «App» tab (or reinstall the APK).",
  "Рушій недоступний (немає ні офлайн-рушія, ні сервера).": "Engine unavailable (no offline engine and no server).",
  "Площа внесення недоступна — застаріла версія рушія. Повністю закрий і знову відкрий додаток, щоб завершити оновлення.":
    "Spray area unavailable — outdated engine. Fully close and reopen the app to finish updating.",
  // cut-outs / drawing
  "Виріз додано.": "Cut-out added.",
  "Виріз видалено.": "Cut-out removed.",
  "Вирізи оновлено.": "Cut-outs updated.",
  "Вирізи очищено.": "Cut-outs cleared.",
  "Малюєш ВИРІЗ-перешкоду.": "Drawing an obstacle CUT-OUT.",
  "Малюєш КОНТУР поля.": "Drawing the field CONTOUR.",
  "Намалюй полігон-перешкоду на карті (вирізається з покриття).": "Draw an obstacle polygon on the map (cut from coverage).",
  "Спершу додай виріз (), потім редагуй вузли.": "Add a cut-out () first, then edit the vertices.",
  "Тягни вершини контуру — маршрут оновлюється наживо.": "Drag the contour vertices — the route updates live.",
  "Тягни вузли вирізів. Натисни «ГОТОВО» коли завершиш.": "Drag the cut-out vertices. Tap «DONE» when finished.",
  // button text toggles
  "ГОТОВО — зберегти вузли": "DONE — save vertices",
  "Готово (редагування)": "Done (editing)",
  "Редагувати вершини контуру": "Edit contour vertices",
  "Редагувати вирізи": "Edit cut-outs",
  // fields / projects / export
  "Відновлено останнє поле.": "Restored the last field.",
  "Немає збережених полів. Намалюй контур і збережи ().": "No saved fields. Draw a contour and save ().",
  "Збережених полів немає — імпортую з файлу…": "No saved fields — importing from a file…",
  "Проєкт завантажено з файлу.": "Project loaded from a file.",
  "Контур експортовано в .kml.": "Contour exported to .kml.",
  "Контур поля задано.": "Field contour set.",
  "KML без коректного контуру поля.": "KML without a valid field contour.",
  "У KML немає полігонів (Polygon).": "The KML has no polygons.",
  "Помилка читання KML: ": "KML read error: ",
  "Помилка читання проєкту: ": "Project read error: ",
  "Не вдалося зберегти: ": "Could not save: ",
  "Збережено: ": "Saved: ",
  "Скасовано.": "Cancelled.",
  "Не вдалося зберегти.": "Could not save.",
  "API недоступний.": "API unavailable.",
  "pywebview API недоступний.": "pywebview API unavailable.",
  // elevation / GPS location
  "Рахую висоти точок контуру…": "Computing contour elevations…",
  "Намалюй контур поля — тоді на «Карті висот» з'являться найвища й найнижча точки.":
    "Draw the field contour — then the «Elevation map» shows the highest and lowest points.",
  "Не вдалося отримати висоти (потрібен інтернет).": "Could not fetch elevations (internet required).",
  "Не вдалося отримати висоти.": "Could not fetch elevations.",
  "Точка зльоту: центр поля (з'явиться після побудови маршруту).": "Take-off point: field centre (appears after building the route).",
  "Шукаю ваше розташування…": "Locating you…",
  "Показую ваше розташування наживо.": "Showing your live location.",
  "Показ розташування вимкнено.": "Location display off.",
  "Геолокація недоступна на цьому пристрої.": "Geolocation is unavailable on this device.",
  "Не вдалося отримати GPS. Вийди на відкрите небо й спробуй ще раз.": "Could not get GPS. Go under open sky and try again.",
  "Локація заборонена. Дозволь: Налаштування → Додатки → Field Mission Planner → Дозволи → Локація.":
    "Location denied. Allow it: Settings → Apps → Field Mission Planner → Permissions → Location.",
  // connection / MAVLink / flight
  "Підключаюсь до дрона…": "Connecting to the drone…",
  "Відключено від дрона.": "Disconnected from the drone.",
  "Обери COM-порт або введи адресу.": "Choose a COM port or enter an address.",
  "Пристрій додано.": "Device added.",
  "Вибір скасовано (або Web Serial недоступний).": "Selection cancelled (or Web Serial unavailable).",
  "MAVLink-модуль не завантажено.": "MAVLink module not loaded.",
  "Заливаю місію в дрон…": "Uploading the mission to the drone…",
  "Зчитую місію з дрона…": "Reading the mission from the drone…",
  "Помилка заливки: ": "Upload error: ",
  "Помилка зчитування: ": "Read error: ",
  "Помилка підключення: ": "Connection error: ",
  "Не вдалося зчитати: ": "Could not read: ",
  "Маршрут НЕ залито в дрон. Натисни «Залити місію».": "Route NOT uploaded. Tap «Upload mission».",
  "План ЗМІНЕНО після заливки — у дроні СТАРА місія. Залий заново!": "Plan CHANGED after upload — the drone has the OLD mission. Upload again!",
  "Перевірено зчитуванням — збігається.": "Verified by read-back — matches.",
  "Спершу увімкни мотори: ARM (за потреби постав режим GUIDED).": "Arm the motors first: ARM (set GUIDED mode if needed).",
  "Місію завершено — остання точка досягнута.": "Mission complete — the last waypoint was reached.",
  "Посадка — апарат на землі (DISARM).": "Landed — the aircraft is on the ground (DISARM).",
  // update
  "Перевіряю оновлення на сервері…": "Checking the server for updates…",
  "Не вдалося перевірити оновлення (немає інтернету / сервер недоступний).": "Could not check for updates (no internet / server unavailable).",
  "Не вдалося завантажити APK. Скачай вручну з вкладки «Додаток».": "Could not download the APK. Get it manually from the «App» tab.",
  // log
  "надіслано на сервер для аналізу": "sent to the server for analysis",
  "на сервер не пішло — скопійовано в буфер": "did not reach the server — copied to the clipboard",
  "Журнал польотів порожній.": "The flight log is empty.",
  "Журнал польотів порожній — ще не було записаних вильотів.": "The flight log is empty — no flights recorded yet.",
  // GPS guard states
  "GPS у нормі": "GPS OK",
  "GPS втрачено (немає 3D-фіксу) — ймовірне глушіння": "GPS lost (no 3D fix) — likely jamming",
  "ГЛУШІННЯ GPS": "GPS JAMMING",
  "СПУФІНГ GPS": "GPS SPOOFING",
  "HOME дрона (точка arm)": "Drone HOME (arm point)",
  // yes/no + online
  "так": "yes", "ні": "no",
  "● онлайн": "● online", "○ немає heartbeat": "○ no heartbeat",
  // ---- interpolated templates (used with tf(), {0}=value) ----
  "Місію залито в дрон ({0} пунктів).": "Mission uploaded to the drone ({0} items).",
  "У дроні поточна місія: {0} точок.": "Current mission on the drone: {0} waypoints.",
  "Режим {0} не дозволяє ARM — перемикаю на GUIDED…": "Mode {0} does not allow ARM — switching to GUIDED…",
  "У вас остання версія (v{0}).": "You have the latest version (v{0}).",
  "Заливаю місію в дрон… {0}/{1} точок": "Uploading the mission… {0}/{1} waypoints",
  "{0} збережених полів на карті — натисни на поле, щоб обрати для роботи.": "{0} saved fields on the map — tap a field to select it for work.",
});

Object.assign(window.FMP_TR, {
  "Зчитана місія НЕ збігається ({0}).": "The read-back mission does NOT match ({0}).",
  "розбіжності": "discrepancies",
  "Не вдалося залити місію.": "Could not upload the mission.",
});

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

Object.assign(window.FMP_TR, {
  "зроблено {0} · лишилось {1} га": "done {0} · left {1} ha",
  "виконано {0} {1}": "completed {0} {1}",
});

Object.assign(window.FMP_TR, {
  "Остання відома місія (з пам'яті) — підключись і перевір, чи вона ще в дроні.":
    "Last known mission (from memory) — connect and verify it's still on the drone.",
});

Object.assign(window.FMP_TR, {
  "Небезпеки (ЛЕП / стовпи)": "Hazards (power lines / poles)",
  "+ Стовп": "+ Pole",
  "+ ЛЕП": "+ Power line",
  "Запас обходу, м": "Avoidance clearance, m",
  "Підтягнути ЛЕП з OSM (тест)": "Import power lines from OSM (test)",
  "OSM може бути неповним — перевір очима, це НЕ гарантія.": "OSM may be incomplete — verify with your eyes, it is NOT a guarantee.",
  "Небезпек: {0} (стовпів {1} · ліній {2})": "Hazards: {0} (poles {1} · lines {2})",
});

Object.assign(window.FMP_TR, { "Пульт (EdgeTX/ELRS MAVLink)": "Handset (EdgeTX/ELRS MAVLink)" });

Object.assign(window.FMP_TR, {
  "Прогалини": "Gaps",
  "Фактична ширина факела, м (порожньо = крок)": "Actual boom width, m (empty = spacing)",
});
