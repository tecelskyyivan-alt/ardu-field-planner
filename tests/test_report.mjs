/* Bug report without a server (#11): boot web-stable/app.js as if served from GitHub Pages,
 * click «Надіслати поштою» / «Створити issue» and check what actually leaves the page —
 * the mailto:/issue URL, its size, and that a public issue carries no coordinates.
 * Same stubbed-DOM idea as test_boot.mjs; here the few elements under test are real objects
 * so their listeners and style can be inspected.
 *
 * Run:  node test_report.mjs
 */
import fs from "fs";
import vm from "vm";

let failed = 0;
const check = (name, cond) => { console.log((cond ? "  OK  " : " FAIL ") + name); if (!cond) failed++; };

function makeStub(name) {
  const fn = function () { return makeStub(name + "()"); };
  return new Proxy(fn, {
    get(t, p) {
      if (p === Symbol.toPrimitive) return () => 0;
      if (p === "toString") return () => "";
      if (p === "value" || p === "textContent" || p === "innerHTML") return "";
      if (p === "checked" || p === "disabled") return false;
      if (p === "classList") return { add() {}, remove() {}, toggle() {}, contains: () => false };
      if (p === "style") return {};
      if (p === "length") return 0;
      if (p === Symbol.iterator) return function* () {};
      return makeStub(name + "." + String(p));
    },
    set() { return true; },
    apply() { return makeStub(name + "()"); },
    construct() { return makeStub("new " + name); },
  });
}

const htmlSrc = fs.readFileSync(new URL("../web-stable/index.html", import.meta.url), "utf8");
const DECLARED_IDS = new Set([...htmlSrc.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
function realEl() {
  const listeners = {};
  return { listeners, style: {}, addEventListener(ev, f) { listeners[ev] = f; }, classList: { add() {}, remove() {}, toggle() {} } };
}
const REAL = Object.fromEntries(["report-mail", "report-issue", "sync-box"].map((id) => [id, realEl()]));

const documentStub = new Proxy({}, {
  get(t, p) {
    if (p === "getElementById") return (id) => REAL[id] || (DECLARED_IDS.has(id) ? makeStub("#" + id) : null);
    if (p === "createTreeWalker") return () => ({ nextNode: () => null, currentNode: null });
    if (p === "querySelector" || p === "querySelectorAll") return () => (p === "querySelectorAll" ? [] : null);
    if (p === "createElement") return () => makeStub("el");
    if (p === "addEventListener" || p === "removeEventListener") return () => {};
    if (p === "body" || p === "documentElement" || p === "head") return makeStub("docpart");
    if (p === "hidden") return false;
    if (p === "visibilityState") return "visible";
    return makeStub("document." + String(p));
  },
  set() { return true; },
});

let clipboard = "", opened = [];
const uploads = [];
const loc = { protocol: "https:", pathname: "/ardu-field-planner/", search: "", hash: "",
  origin: "https://tecelskyyivan-alt.github.io", hostname: "tecelskyyivan-alt.github.io", reload() {},
  _href: "https://tecelskyyivan-alt.github.io/ardu-field-planner/",
  get href() { return this._href; }, set href(v) { opened.push(String(v)); } };
const storage = new Map();
// A long previous session (with coordinates in it) so the URL cap and the scrub both have work to do.
// Error lines carry the kinds of personal data a real log has (#13); none may reach the public issue.
const PRIVATE = ["Mozilla/5.0", "chrome-extension://eppiocemh", "192.168.4.1", "fe80::1c2:3ff:fe4", "AA:BB:CC:DD:EE:FF", "AA-BB-CC-DD-EE-01",
  "pilot@example.com", "/Users/ivan/", "C:\\Users\\pilot", "48.1234567", "0123456789abcdef", "PRIVATE-INFO-LINE"];
storage.set("fmp_log", [
  ...Array.from({ length: 400 }, (_, i) => "11:29:" + String(i % 60).padStart(2, "0") + ".149 [t] подія " + i + " позиція 48.1234567,35.7654321 PRIVATE-INFO-LINE"),
  "11:29:09.149 start 2.5.86 web ua=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
  "11:29:09.359 PROMISE REJECT: boom | TypeError at Y (chrome-extension://eppiocemhmnlbhjplcgkofciiegomcon/executors/200.js:1:761)",
  "11:30:00.000 [ЧЕРВОНЕ] WiFi 192.168.4.1:14550 fe80::1c2:3ff:fe4b:12 BLE AA:BB:CC:DD:EE:FF / AA-BB-CC-DD-EE-01 не відповідає",
  "11:30:01.000 JS ERROR: pilot@example.com /Users/ivan/fields/x.kml C:\\Users\\pilot\\a.kml at 48.1234567,35.7654321 dev 0123456789abcdef",
].join("\n"));
const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, JSON, Math, Date, Promise,
  parseFloat, parseInt, isNaN, isFinite, encodeURIComponent, decodeURIComponent, RegExp,
  Object, Array, String, Number, Boolean, Error, Map, Set, Symbol, Proxy, Reflect, Intl,
  Uint8Array, ArrayBuffer, DataView, Infinity, NaN, undefined,
  document: documentStub,
  localStorage: { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k), key: () => null, length: 0 },
  // A coordinate in the user agent lands in the report header — the issue must not carry it.
  navigator: { userAgent: "test-report 50.4501234,30.5234567", language: "uk", onLine: false,
    geolocation: makeStub("geo"), clipboard: { writeText: async (s) => { clipboard = s; } } },
  location: loc,
  open: (u) => { opened.push(String(u)); },
  fetch: async (url, opt) => { uploads.push({ url, opt }); return { ok: true }; },
  L: makeStub("L"), ClipperLib: makeStub("ClipperLib"), MAVLINK: makeStub("MAVLINK"), MAV_LINK: makeStub("MAV_LINK"),
  confirm: () => false, alert: () => {}, prompt: () => null,
  indexedDB: { open: () => makeStub("idbreq") },
  URL: Object.assign(function (u) { return { href: String(u) }; }, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }),
  Blob: function () {}, FileReader: function () { return makeStub("fr"); },
  requestAnimationFrame: (f) => setTimeout(f, 0), performance: { now: () => 0 }, screen: { width: 1000, height: 800 },
  Notification: undefined, caches: undefined,
  NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 },
  MutationObserver: function () { return { observe() {}, disconnect() {} }; },
  ResizeObserver: function () { return { observe() {}, disconnect() {} }; },
  addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
  matchMedia: () => ({ matches: false, addListener() {}, addEventListener() {} }),
  getComputedStyle: () => ({ getPropertyValue: () => "" }),
  history: { replaceState() {}, pushState() {} },
};
sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;

const src = fs.readFileSync(new URL("../web-stable/app.js", import.meta.url), "utf8");
vm.runInNewContext(src, sandbox, { filename: "app.js", timeout: 30000 });

check("sync block hidden on a static host", REAL["sync-box"].style.display === "none");
// Pages has no /downloads/ (it lived on the VPS): every APK link must point at GitHub Releases.
check("no download link into the dead /downloads/ path", !/href="downloads\//.test(htmlSrc));

await REAL["report-mail"].listeners.click();
const mail = opened.pop() || "";
check("mail goes to the README address", mail.startsWith("mailto:teselskyy@gmail.com?subject="));
check("mail URL fits (<= 7500)", mail.length > 0 && mail.length <= 7500);
check("full log copied to the clipboard", clipboard.includes("діагностичний лог"));

clipboard = "untouched";
await REAL["report-issue"].listeners.click();
const issue = opened.filter((u) => u.startsWith("https://github.com/")).pop() || "";
const body = decodeURIComponent((issue.split("&body=")[1] || ""));
const leaked = PRIVATE.filter((x) => body.includes(x));
check("public issue carries no personal data" + (leaked.length ? "  →  " + leaked.join(", ") : ""), body.length > 0 && leaked.length === 0);
check("issue keeps the error text", body.includes("PROMISE REJECT: boom") && body.includes("JS ERROR"));
check("timestamps survive the scrub", body.includes("11:30:00.000"));
check("issue does not put the full log in the clipboard", clipboard === "untouched");
const up = uploads.find((u) => /^report_id: r\w+/.test((() => { try { return JSON.parse(u.opt.body).log; } catch (e) { return ""; } })()));
const rid = up ? JSON.parse(up.opt.body).log.match(/^report_id: (r\w+)/)[1] : "";
check("full log sent privately with a report id", !!rid);
check("issue names that report id", !!rid && body.includes("ID звіту: " + rid));
check("issue opens the repo's new-issue page", issue.startsWith("https://github.com/tecelskyyivan-alt/ardu-field-planner/issues/new?title="));
check("issue URL fits (<= 7500)", issue.length > 0 && issue.length <= 7500);
check("issue body has the report header", body.includes("версія:"));
check("issue body has no coordinates", !/\d{1,3}\.\d{4,}/.test(body) && !body.includes("50.4501234"));

// ---- with the collector configured (#12), «Лог» on the static site posts the log there
const COLLECTOR = "https://script.google.com/macros/s/TEST/exec";
const posts = [];
for (const id of ["report-mail", "report-issue", "sync-box", "mav-log"]) REAL[id] = realEl();
const sandbox2 = { ...sandbox, fetch: async (url, opt) => { posts.push({ url, opt }); return { ok: true }; } };
sandbox2.window = sandbox2; sandbox2.globalThis = sandbox2; sandbox2.self = sandbox2;
const src2 = src.replace(/const REPORT_LOG_URL = "[^"]*";/, 'const REPORT_LOG_URL = "' + COLLECTOR + '";');
check("test can set the collector URL", src2 !== src);
vm.runInNewContext(src2, sandbox2, { filename: "app.js", timeout: 30000 });
await REAL["mav-log"].listeners.click();
const p = posts.find((x) => x.url === COLLECTOR);
check("«Лог» posts to the collector", !!p);
check("posted as text/plain (no CORS preflight)", !!p && p.opt.headers["Content-Type"] === "text/plain");
let payload = {}; try { payload = JSON.parse(p.opt.body); } catch (e) {}
check("payload carries the log and the version", typeof payload.log === "string" && payload.log.includes("діагностичний лог") && !!payload.version);

// ---- UDP in a desktop browser: empty address = auto -> the local bridge (scripts/udp_ws_bridge.py)
const wsUrls = [];
for (const id of ["mav-connect", "mav-conn-type", "mav-address", "mav-baud", "msg"]) REAL[id] = realEl();
REAL["mav-conn-type"].value = "udp"; REAL["mav-conn-type"].querySelector = () => null; REAL["mav-address"].value = ""; REAL["mav-baud"].value = "auto";
const sandbox3 = { ...sandbox, MAV_TRANSPORT: { serialSupported: () => false,
  openWebSocket: async (u) => { wsUrls.push(u); throw new Error("no bridge"); },
  openRelay: async (u) => { wsUrls.push(u); throw new Error("no bridge"); } } };
sandbox3.fetch = async (u) => { if (String(u).endsWith("/ping")) throw new TypeError("Failed to fetch"); return { ok: true }; };
sandbox3.window = sandbox3; sandbox3.globalThis = sandbox3; sandbox3.self = sandbox3;
vm.runInNewContext(src, sandbox3, { filename: "app.js", timeout: 30000 });
await REAL["mav-connect"].listeners.click();
// Direct WebSocket first; Chrome blocks Pages -> 127.0.0.1, so then the bridge's relay popup.
check("UDP with empty address tries the local bridge directly", wsUrls[0] === "ws://127.0.0.1:14550");
check("blocked -> falls back to the bridge's relay window", wsUrls[1] === "http://127.0.0.1:14550/relay.html");
check("no bridge -> error names the bridge script", String(REAL["msg"].textContent || "").includes("udp_ws_bridge.py"));

const phoneUrls = [];
for (const id of ["mav-connect", "mav-conn-type", "mav-address", "mav-baud", "msg"]) REAL[id] = realEl();
REAL["mav-conn-type"].value = "udp"; REAL["mav-conn-type"].querySelector = () => null; REAL["mav-address"].value = ""; REAL["mav-baud"].value = "auto";
REAL["bp-fw-help"] = realEl(); REAL["bp-fw-help"].hidden = true; REAL["bp-fw-help"].scrollIntoView = () => {};
const sandbox4 = { ...sandbox3, navigator: { ...sandbox.navigator, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) CriOS/156" },
  MAV_TRANSPORT: { serialSupported: () => false, openWebSocket: async (u) => { phoneUrls.push(u); throw 0; }, openRelay: async (u) => { phoneUrls.push(u); throw 0; } } };
sandbox4.window = sandbox4; sandbox4.globalThis = sandbox4; sandbox4.self = sandbox4;
vm.runInNewContext(src, sandbox4, { filename: "app.js", timeout: 30000 });
await REAL["mav-connect"].listeners.click();
// A phone browser can't do UDP and has no bridge on 127.0.0.1: the backpack's own relay window.
const AUTO = ["http://elrs_txbp.local/fmp-relay.html", "http://10.0.0.1/fmp-relay.html", "http://172.20.10.2/fmp-relay.html", "http://172.20.10.3/fmp-relay.html"];
check("phone browser: empty address -> mDNS name, its access point, then iPhone hotspot clients", phoneUrls.length === 1 && String(phoneUrls[0]) === String(AUTO));
check("phone browser: no backpack -> error recommends the FMP backpack firmware", String(REAL["msg"].textContent || "").includes("прошивкою FMP"));
check("phone browser: no backpack -> firmware help card shown", REAL["bp-fw-help"].hidden === false);
// A typed backpack IP (with the UDP port) -> that IP on port 80.
phoneUrls.length = 0;
REAL["mav-address"].value = "192.168.0.101:14550";
await REAL["mav-connect"].listeners.click();
check("phone browser: typed IP -> only that IP", String(phoneUrls[0]) === "http://192.168.0.101/fmp-relay.html");
// The backpack that answered is remembered and tried first next time (address left empty).
const savedUrls = [];
for (const id of ["mav-connect", "mav-conn-type", "mav-address", "mav-baud", "msg"]) REAL[id] = realEl();
REAL["mav-conn-type"].value = "udp"; REAL["mav-conn-type"].querySelector = () => null; REAL["mav-address"].value = ""; REAL["mav-baud"].value = "auto";
const sandbox4b = { ...sandbox4, MAV_TRANSPORT: { serialSupported: () => false,
  openRelay: async (u) => { savedUrls.push(u); if (savedUrls.length === 1) return { url: [].concat(u)[1], write() {}, close() {}, ondata: null }; throw 0; } } };
sandbox4b.window = sandbox4b; sandbox4b.globalThis = sandbox4b; sandbox4b.self = sandbox4b;
vm.runInNewContext(src, sandbox4b, { filename: "app.js", timeout: 30000 });
await REAL["mav-connect"].listeners.click();
check("phone browser: answering backpack is remembered", sandbox4b.localStorage.getItem("fmp_backpack_host") === "10.0.0.1");
await REAL["mav-connect"].listeners.click();
check("phone browser: remembered backpack is tried first", String(savedUrls[1]) === "http://10.0.0.1/fmp-relay.html,http://elrs_txbp.local/fmp-relay.html,http://172.20.10.2/fmp-relay.html,http://172.20.10.3/fmp-relay.html");

// ...but a phone that opened FMP from a computer's bridge (--lan) connects to that bridge.
const lanUrls = [];
for (const id of ["mav-connect", "mav-conn-type", "mav-address", "mav-baud", "msg"]) REAL[id] = realEl();
REAL["mav-conn-type"].value = "udp"; REAL["mav-conn-type"].querySelector = () => null; REAL["mav-address"].value = ""; REAL["mav-baud"].value = "auto";
const lanLoc = { ...loc, protocol: "http:", hostname: "192.168.0.103", port: "14550", host: "192.168.0.103:14550",
  origin: "http://192.168.0.103:14550", pathname: "/", reload() {} };
const sandbox5 = { ...sandbox4, location: lanLoc,
  MAV_TRANSPORT: { serialSupported: () => false, openWebSocket: async (u) => { lanUrls.push(u); throw 0; }, openRelay: async (u) => { lanUrls.push(u); throw 0; } } };
sandbox5.window = sandbox5; sandbox5.globalThis = sandbox5; sandbox5.self = sandbox5;
vm.runInNewContext(src, sandbox5, { filename: "app.js", timeout: 30000 });
await REAL["mav-connect"].listeners.click();
check("phone on a --lan bridge page: WebSocket to that bridge", lanUrls[0] === "ws://192.168.0.103:14550");

// ✕ on the backpack-firmware card hides it.
REAL["bp-fw-close"] = realEl();
vm.runInNewContext(src, sandbox4, { filename: "app.js", timeout: 30000 });
REAL["bp-fw-help"].hidden = false;
REAL["bp-fw-close"].listeners.click();
check("✕ closes the backpack-firmware card", REAL["bp-fw-help"].hidden === true);

// Opening the site must not auto-connect (a closed tab leaves wasConnected=true) — the apps still do.
const bootConn = [];
storage.set("fmp_session", JSON.stringify({ wasConnected: true, connType: "udp", addr: "" }));
for (const id of ["mav-connect", "mav-conn-type", "mav-address", "mav-baud", "msg"]) REAL[id] = realEl();
REAL["mav-conn-type"].value = "udp"; REAL["mav-conn-type"].querySelector = () => ({ remove() {} }); REAL["mav-address"].value = ""; REAL["mav-baud"].value = "auto";
const sbWeb = { ...sandbox3, MAV_TRANSPORT: { serialSupported: () => false,
  openWebSocket: async (u) => { bootConn.push("web " + u); throw 0; }, openRelay: async (u) => { bootConn.push("web " + u); throw 0; } } };
sbWeb.window = sbWeb; sbWeb.globalThis = sbWeb; sbWeb.self = sbWeb;
vm.runInNewContext(src, sbWeb, { filename: "app.js", timeout: 30000 });
await new Promise((r) => setTimeout(r, 1800));
check("browser: opening the site with a stale session does NOT connect", bootConn.length === 0);
const sbApk = { ...sbWeb, AndroidSerial: {}, AndroidUdp: {},
  MAV_TRANSPORT: { serialSupported: () => false, openAndroidUdp: async (port) => { bootConn.push("apk udp " + port); throw 0; } } };
sbApk.window = sbApk; sbApk.globalThis = sbApk; sbApk.self = sbApk;
vm.runInNewContext(src, sbApk, { filename: "app.js", timeout: 30000 });
await new Promise((r) => setTimeout(r, 1800));
check("APK: still reconnects after being reopened", bootConn.some((c) => c.startsWith("apk udp")));
storage.delete("fmp_session");

console.log("\nRESULT: " + (failed ? failed + " FAILURE(S)" : "ALL CHECKS PASSED"));
process.exit(failed ? 1 : 0);
