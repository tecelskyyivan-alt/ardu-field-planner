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
