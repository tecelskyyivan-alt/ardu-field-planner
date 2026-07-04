/* Byte transports for the in-browser MAVLink link. Each returns a uniform
 * object { write(Uint8Array), close(), ondata } where the link sets `ondata` to
 * receive raw incoming bytes. Three transports cover every field scenario:
 *   • WebSerial  — PC over a USB cable / SiK radio (Chrome/Edge desktop)
 *   • WebUSB     — Android over USB-OTG (Chrome) where WebSerial isn't available
 *   • WebSocket  — SITL / a TCP↔WS bridge (browsers can't open raw TCP/UDP)
 * All work offline (no server) once the page is loaded.
 */
(function (root) {
  "use strict";

  // ---- WebSocket (SITL via a tcp<->ws bridge; also any ws telemetry relay) ----
  async function openWebSocket(url) {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const t = {
      ondata: null,
      write(bytes) { if (ws.readyState === 1) ws.send(bytes); },
      close() { try { ws.close(); } catch (e) {} },
    };
    ws.onmessage = (ev) => { if (t.ondata) t.ondata(new Uint8Array(ev.data)); };
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error("Не вдалося відкрити WebSocket " + url));
    });
    return t;
  }

  // ---- WebSerial (PC: USB cable / SiK radio) ----
  // Mirrors how Betaflight/ESC Configurator do it: getPorts() lists ports the
  // user already granted, and a SEPARATE requestPort() click (pure user gesture,
  // no filters → shows ALL serial devices) grants a new one. Connecting then just
  // opens an already-granted SerialPort. This is far more reliable than calling
  // requestPort() at connect time (the gesture is easy to lose / the popup easy
  // to miss → "doesn't see the controller").
  function serialSupported() { return typeof navigator !== "undefined" && !!navigator.serial; }
  async function serialRequestPort() {
    if (!navigator.serial) throw new Error("Web Serial недоступний (потрібен Chrome/Edge на ПК).");
    return navigator.serial.requestPort({});   // {} = no vendor filter → list every serial device
  }
  async function serialGetPorts() {
    if (!navigator.serial) return [];
    try { return await navigator.serial.getPorts(); } catch (e) { return []; }
  }
  // Open an ALREADY-GRANTED SerialPort (from serialRequestPort/serialGetPorts).
  async function openSerial(port, baud) {
    if (!port) throw new Error("USB-порт не вибрано.");
    await port.open({ baudRate: baud || 115200, bufferSize: 8192 });
    const writer = port.writable.getWriter();
    const t = {
      ondata: null,
      _closed: false,
      _reader: null,
      write(bytes) { writer.write(bytes).catch(() => {}); },
      async close() {
        this._closed = true;
        try { await this._reader.cancel(); } catch (e) {}
        try { writer.releaseLock(); } catch (e) {}
        try { await port.close(); } catch (e) {}
      },
    };
    (async () => {
      const reader = port.readable.getReader();
      t._reader = reader;
      try {
        while (!t._closed) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value && t.ondata) t.ondata(value);
        }
      } catch (e) { /* cancelled / unplugged */ }
    })();
    return t;
  }

  // ---- WebUSB (Android USB-OTG to the FC / radio) ----
  // Best-effort USB-serial over WebUSB: claim the first interface that has a bulk
  // IN + bulk OUT endpoint (CDC-ACM data iface or a vendor serial chip), set the
  // CDC line state, and pump transfers. Needs on-device validation per FC.
  async function openWebUSB() {
    if (!navigator.usb) throw new Error("WebUSB недоступний (потрібен Chrome на Android).");
    const dev = await navigator.usb.requestDevice({ filters: [] });
    await dev.open();
    if (dev.configuration === null) await dev.selectConfiguration(1);

    let ifaceNum = null, epIn = null, epOut = null;
    for (const iface of dev.configuration.interfaces) {
      const alt = iface.alternate;
      let bin = null, bout = null;
      for (const ep of alt.endpoints) {
        if (ep.type === "bulk" && ep.direction === "in") bin = ep.endpointNumber;
        if (ep.type === "bulk" && ep.direction === "out") bout = ep.endpointNumber;
      }
      if (bin !== null && bout !== null) { ifaceNum = iface.interfaceNumber; epIn = bin; epOut = bout; break; }
    }
    if (ifaceNum === null) { try { await dev.close(); } catch (e) {} throw new Error("Не знайдено USB-serial інтерфейсу на пристрої."); }
    await dev.claimInterface(ifaceNum);
    // CDC SET_CONTROL_LINE_STATE (DTR|RTS) — harmless on most serial chips.
    try {
      await dev.controlTransferOut({ requestType: "class", recipient: "interface", request: 0x22, value: 0x03, index: ifaceNum });
    } catch (e) {}

    const t = {
      ondata: null,
      _closed: false,
      write(bytes) { dev.transferOut(epOut, bytes).catch(() => {}); },
      async close() {
        this._closed = true;
        try { await dev.releaseInterface(ifaceNum); } catch (e) {}
        try { await dev.close(); } catch (e) {}
      },
    };
    (async () => {
      while (!t._closed) {
        try {
          const r = await dev.transferIn(epIn, 64);
          if (r.data && r.data.byteLength && t.ondata) t.ondata(new Uint8Array(r.data.buffer));
        } catch (e) { break; }
      }
    })();
    return t;
  }

  // ---- Android native bridge (window.AndroidSerial) ----
  // The native APK shell exposes a usb-serial-for-android bridge that DOES reach
  // CDC-ACM flight controllers (STM32 VCP / Pixhawk) and FTDI/CP210x/CH340/PL2303
  // — which the browser cannot on Android. Bytes cross the bridge base64-encoded.
  function _b64enc(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function _b64dec(b64) {
    const s = atob(b64);
    const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u;
  }
  async function openAndroidSerial(deviceId, baud) {
    const A = window.AndroidSerial;
    if (!A) throw new Error("AndroidSerial недоступний.");
    const t = {
      ondata: null,
      _closed: false,
      write(bytes) { if (!this._closed) { try { A.write(_b64enc(bytes)); } catch (e) {} } },
      close() {
        this._closed = true;
        try { A.close(); } catch (e) {}
        if (window.__androidSerialData === onData) window.__androidSerialData = null;
      },
    };
    const onData = (b64) => { if (t.ondata && !t._closed) { try { t.ondata(_b64dec(b64)); } catch (e) {} } };
    window.__androidSerialData = onData;
    const id = parseInt(deviceId, 10);
    await new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn, arg) => { if (done) return; done = true; window.__androidSerialEvent = null; clearTimeout(to); fn(arg); };
      const to = setTimeout(() => finish(reject, new Error("Тайм-аут підключення USB (немає дозволу або порт зайнятий?).")), 25000);
      window.__androidSerialEvent = (type, ok, detail) => {
        if (type === "open") finish(ok ? resolve : reject, ok ? undefined : new Error(detail || "Не вдалося відкрити USB-порт."));
      };
      let r;
      try { r = A.connect(isNaN(id) ? -1 : id, baud | 0); } catch (e) { return finish(reject, e); }
      try { const j = JSON.parse(r); if (j && j.ok === false) finish(reject, new Error(j.error || "USB-порт недоступний.")); } catch (e) {}
    });
    return t;
  }

  // ---- Android native UDP (window.AndroidUdp) ----
  // For MAVLink-over-WiFi (an ExpressLRS TX Backpack forwards MAVLink on UDP
  // 14550). Browsers can't open raw UDP, so the native APK does it; the phone
  // joins the backpack's WiFi and becomes a wireless GCS over ELRS.
  async function openAndroidUdp(port) {
    const A = window.AndroidUdp;
    if (!A) throw new Error("AndroidUdp недоступний (потрібен APK).");
    const t = {
      ondata: null,
      _closed: false,
      write(bytes) { if (!this._closed) { try { A.write(_b64enc(bytes)); } catch (e) {} } },
      close() {
        this._closed = true;
        try { A.close(); } catch (e) {}
        if (window.__androidUdpData === onData) window.__androidUdpData = null;
      },
    };
    const onData = (b64) => { if (t.ondata && !t._closed) { try { t.ondata(_b64dec(b64)); } catch (e) {} } };
    window.__androidUdpData = onData;
    await new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn, arg) => { if (done) return; done = true; window.__androidUdpEvent = null; clearTimeout(to); fn(arg); };
      const to = setTimeout(() => finish(reject, new Error("Не вдалося відкрити UDP-порт.")), 8000);
      window.__androidUdpEvent = (type, ok, detail) => {
        if (type === "open") finish(ok ? resolve : reject, ok ? undefined : new Error(detail || "UDP помилка."));
      };
      let r;
      try { r = A.open(port | 0); } catch (e) { return finish(reject, e); }
      try { const j = JSON.parse(r); if (j && j.ok === false) finish(reject, new Error(j.error || "UDP недоступний.")); } catch (e) {}
    });
    return t;
  }

  // ---- iOS native UDP (window.webkit.messageHandlers.fmpUdp) ----
  // Same job as openAndroidUdp, for the native iOS shell (ios/). iOS Safari has no
  // WebSerial/WebUSB/raw-UDP, so the WKWebView host opens the UDP socket and bridges
  // bytes: JS→native via postMessage({op}), native→JS via window.__iosUdp* globals.
  async function openIosUdp(port) {
    const H = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.fmpUdp;
    if (!H) throw new Error("iOS UDP-міст недоступний (потрібен застосунок iOS).");
    const t = {
      ondata: null,
      _closed: false,
      write(bytes) { if (!this._closed) { try { H.postMessage({ op: "write", data: _b64enc(bytes) }); } catch (e) {} } },
      close() {
        this._closed = true;
        try { H.postMessage({ op: "close" }); } catch (e) {}
        if (window.__iosUdpData === onData) window.__iosUdpData = null;
      },
    };
    const onData = (b64) => { if (t.ondata && !t._closed) { try { t.ondata(_b64dec(b64)); } catch (e) {} } };
    window.__iosUdpData = onData;
    await new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn, arg) => { if (done) return; done = true; window.__iosUdpEvent = null; clearTimeout(to); fn(arg); };
      const to = setTimeout(() => finish(reject, new Error("Не вдалося відкрити UDP-порт (iOS).")), 8000);
      window.__iosUdpEvent = (type, ok, detail) => {
        if (type === "open") finish(ok ? resolve : reject, ok ? undefined : new Error(detail || "UDP помилка (iOS)."));
      };
      try { H.postMessage({ op: "open", port: port | 0 }); } catch (e) { return finish(reject, e); }
    });
    return t;
  }

  root.MAV_TRANSPORT = {
    openWebSocket, openSerial, openWebUSB, openAndroidSerial, openAndroidUdp, openIosUdp,
    serialSupported, serialRequestPort, serialGetPorts,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
