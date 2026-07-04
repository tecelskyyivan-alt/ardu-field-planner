# Field Mission Planner — iOS

Нативна оболонка iOS (WKWebView) навколо того самого офлайн-веб-застосунку, що й
PWA та Android APK. Архітектура — дзеркало `android/`:

- **Локальний HTTP-сервер** (Swifter) віддає вбудований `web/` на `http://127.0.0.1`
  → реальний origin, тож Pyodide-рушій, карти й jsMav працюють офлайн, як на десктопі.
- **Swift-міст UDP** (`UdpBridge.swift`, Network.framework) дає лінк до дрона через
  **WiFi / ELRS-бекпак** — те, чого iOS Safari не вміє (немає WebSerial/WebUSB/raw-UDP).

> ⚠️ **USB-кабель до польотного контролера на iOS НЕ підтримується** — Apple пускає
> USB-залізо лише через програму сертифікації MFi. На iOS дрон під'єднується **тільки
> через WiFi/бекпак (UDP)**. Планування (карта, маршрут, Pyodide) працює повністю.

> ⚠️ Зібрано на Windows, **на Mac/пристрої ще не компілювалось** — ти перший збирач
> (як було з першим Android APK). Якщо Xcode щось не прийме — кидай помилку, поправлю.

---

## Що потрібно (неминуче)

1. **Mac з Xcode** — iOS-додаток не збирається на Windows. (Або хмарний Mac / macOS-раннер у CI.)
2. **Apple ID.** Для встановлення на свій iPhone достатньо безкоштовного (сертифікат
   живе 7 днів, далі перепідписати). Для TestFlight / App Store — **Apple Developer Program, $99/рік**.
3. **XcodeGen** (генерує `.xcodeproj` зі `project.yml`): `brew install xcodegen`.

## Збірка (на Mac)

```bash
# у корені репозиторію (потрібні папки ios/ і web-stable/)
cd ios
./sync_web.sh                 # копіює web-stable → App/web
xcodegen generate             # створює FieldMissionPlanner.xcodeproj (підтягне Swifter через SPM)
open FieldMissionPlanner.xcodeproj
```

У Xcode:
1. Target **FieldMissionPlanner → Signing & Capabilities** → обери свою **Team**
   (за потреби зміни `PRODUCT_BUNDLE_IDENTIFIER` на унікальний, напр. `com.твій-id.fmp`).
2. Під'єднай iPhone кабелем, обери його як ціль, тисни **Run (⌘R)**.
3. Перший раз на телефоні: **Settings → General → VPN & Device Management** → довір сертифікат розробника.
4. При першому запуску дозволь **Геолокацію** і **Локальну мережу** (інакше лінк до дрона заблокує iOS).

## Підключення до дрона

1. Під'єднай телефон до **WiFi бекпака** (ELRS TX backpack у режимі MAVLink/WiFi).
2. У застосунку: вкладка **Політ → тип UDP**, адреса лишити `0.0.0.0:14550` (слухати все) → **Підключити**.
3. Має піти телеметрія (як на Android через бекпак — той самий jsMav з фіксом 2.5.21).

## Оновлення веб-частини

Веб усередині оболонки **не** авто-оновлюється з VPS (на відміну від PWA). Щоб оновити:
```bash
cd ios && ./sync_web.sh && xcodegen generate   # потім пересобери в Xcode
```
(Майбутнє покращення — тягнути новий `web/` із VPS при старті, як PWA.)

## Розповсюдження

- **На свій телефон:** просто Run з Xcode (безкоштовний акаунт — перепідписувати раз на 7 днів).
- **TestFlight / App Store:** Product → Archive → Distribute (потрібен Apple Developer $99/рік,
  для App Store — рев'ю Apple). Кожне оновлення вебу = новий білд через стор.

## Файли

| Файл | Призначення |
|---|---|
| `project.yml` | Специфікація проєкту для XcodeGen (+ залежність Swifter через SPM) |
| `App/AppDelegate.swift` | Точка входу, одне вікно |
| `App/ViewController.swift` | Локальний HTTP-сервер + WKWebView + міст UDP↔JS + дозвіл геолокації |
| `App/UdpBridge.swift` | UDP-сокет (Network.framework): bind 14550, вчить peer, шле/приймає MAVLink |
| `App/Info.plist` | Дозволи (геолокація, локальна мережа), ATS для 127.0.0.1, екран запуску |
| `App/web/` | Копія `web-stable/` (заповнюється `sync_web.sh`) |
| `sync_web.sh` | Копіює `web-stable` → `App/web` |

JS-бік мосту: `web-stable/mav/transport.js → openIosUdp` (через `window.webkit.messageHandlers.fmpUdp`),
детект оболонки в `web-stable/app.js → IS_IOS`.
