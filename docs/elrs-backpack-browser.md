# Phone browser → drone over WiFi, no computer: backpack firmware with WebSocket

A browser can't send or receive UDP, and the stock ELRS backpack speaks MAVLink only over
UDP `14550`. So FMP in a phone browser (iPhone included) needs the backpack itself to speak
WebSocket. `firmware/elrs-backpack-1.5.7-fmp-ws.patch` adds that to ExpressLRS TX Backpack
1.5.7; everything else in the backpack (UDP for QGC / Mission Planner / the FMP apps) keeps
working.

What the patch adds:

- `ws://<backpack>/mavlink-ws` — raw MAVLink both ways, the same stream as UDP.
  Accepts only pages served by the backpack itself on an IP or `*.local` address, or
  non-browser clients (no `Origin`); any other site, including GitHub Pages directly, is closed.
- `http://<backpack>/fmp-relay.html` — FMP on GitHub Pages opens it as a window; it holds the
  WebSocket and passes bytes through `postMessage` (the same protocol as the computer bridge's
  `relay.html`). An https page can't open `ws://` to the LAN itself.

## Ready-made firmware

In every FMP release since [v2.5.97](https://github.com/tecelskyyivan-alt/ardu-field-planner/releases/tag/v2.5.97) (next to the APK): `ESP_TX_Backpack-1.5.7-fmp-ws.bin` (ESP8285: RadioMaster Ranger / Ranger Micro / Ranger Nano, …) and `ESP32C3_TX_Backpack-1.5.7-fmp-ws.bin`, built from source with no Wi-Fi or personal data inside (source: [`fmp-ws`](https://github.com/tecelskyyivan-alt/Backpack/tree/fmp-ws), same as `firmware/elrs-backpack-1.5.7-fmp-ws.patch`). Flash it through the backpack's web page → Update; your saved Home WiFi stays. Upstream proposal: [ExpressLRS/Backpack#252](https://github.com/ExpressLRS/Backpack/issues/252).

## Build and flash (once)

```sh
git clone https://github.com/ExpressLRS/Backpack.git && cd Backpack
git checkout 1.5.7
git am /path/to/ardu-field-planner/firmware/elrs-backpack-1.5.7-fmp-ws.patch
pip install platformio
pio run -e ESP_TX_Backpack_via_WIFI        # ESP8285 TX backpacks (RadioMaster Ranger, ...)
```

Flash `.pio/build/ESP_TX_Backpack_via_WIFI/firmware.bin` through the backpack's web page
(`http://<backpack IP>` or `http://10.0.0.1` → Update), or the ELRS Configurator's local file option.
ESP32-C3 backpacks: `ESP32C3_TX_Backpack_via_WIFI`. Back to stock: flash stock 1.5.7 the same way.

## Each flight

1. Radio: ELRS Lua → **Backpack** → **Telemetry** → **WiFi**.
2. Phone on the same WiFi as the backpack: its Home WiFi network
   ([elrs-backpack-home-wifi.md](elrs-backpack-home-wifi.md)), or the backpack's own access point.
3. FMP → **Flight** → **UDP**, address **empty** → **Connect**. FMP finds the backpack itself:
   the backpack that answered last time, then `elrs_txbp.local` (Home WiFi), then `10.0.0.1`
   (the backpack's own access point), then the iPhone hotspot's client addresses (`172.20.10.2`–`.14`, the same on every iPhone), all in one small "FMP: drone link" tab; the one that
   answers is remembered. Keep that tab, it closes with FMP. Allow pop-ups if the browser blocks it.

**iPhone hotspot as the network:** Settings → Personal Hotspot → **Maximize Compatibility** on (the
backpack is 2.4 GHz only), and give the iPhone an ASCII name (Settings → General → About → Name):
its default name has a curly apostrophe (`’`) that a computer keyboard doesn't type. Set that name
and password as the backpack's Home WiFi on its page (`http://10.0.0.1` on its own access point).
Keep the Personal Hotspot screen open until the backpack joins: iOS hides the hotspot when nobody uses it.

Only if none of these answers, type the backpack's IP (router's client list) once; it is remembered. Anyone on that WiFi who can open the backpack's page can
reach the drone — same as with UDP.

---

**UA коротко.** Браузер не вміє UDP, а стоковий бекпак ELRS дає MAVLink лише по UDP. Патч
`firmware/elrs-backpack-1.5.7-fmp-ws.patch` додає в бекпак 1.5.7 WebSocket `/mavlink-ws` і
сторінку `/fmp-relay.html`. FMP з GitHub Pages у браузері телефона (iPhone теж) відкриває цю
сторінку вкладкою й через неї говорить з дроном — без комп'ютера й застосунку. Зібрати —
`pio run -e ESP_TX_Backpack_via_WIFI`, прошити через веб бекпака (Update). У FMP: **UDP**, адреса
порожня → **Підключити**: FMP сам пробує останній бекпак, `elrs_txbp.local`, `10.0.0.1`, адреси клієнтів хотспота iPhone (`172.20.10.2`–`.14`, однакові на кожному iPhone) і запам'ятовує, що відповіло; на пульті Backpack → Telemetry → WiFi.
