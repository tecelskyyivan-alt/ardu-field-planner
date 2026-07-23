/* Boot smoke: actually EXECUTE web-stable/app.js under a stubbed DOM and assert the IIFE
 * survives to its last line. node --check only parses; nothing else runs the file — which is
 * how a TemporalDeadZone crash (top-level $() before its const) shipped in 2.5.72 and killed
 * every feature past line ~874 while the map still rendered. This harness exists so an
 * app.js that dies mid-boot can never pass CI again.
 *
 * Run:  node test_boot.mjs
 */
import fs from "fs";
import vm from "vm";

let failed = 0;
const check = (name, cond) => { console.log((cond ? "  OK  " : " FAIL ") + name); if (!cond) failed++; };

// ---- universal callable/gettable stub: every property access returns another stub, every
// call returns a stub, so arbitrary DOM/Leaflet chains (L.map(...).addTo(...).on(...)) work.
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

const storage = new Map();
const localStorageStub = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
  key: (i) => [...storage.keys()][i] ?? null,
  get length() { return storage.size; },
};

// getElementById mirrors reality: ids DECLARED in index.html resolve to a stub element,
// unknown ids to null — so unguarded $("declared-id").addEventListener works exactly like in
// the browser, while a typo'd id still surfaces as it would live.
const htmlSrc = fs.readFileSync(new URL("./web-stable/index.html", import.meta.url), "utf8");
const DECLARED_IDS = new Set([...htmlSrc.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

const documentStub = new Proxy({}, {
  get(t, p) {
    if (p === "getElementById") return (id) => (DECLARED_IDS.has(id) ? makeStub("#" + id) : null);
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

const windowStub = {};   // filled below (self-reference)
const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, JSON, Math, Date, Promise,
  parseFloat, parseInt, isNaN, isFinite, encodeURIComponent, decodeURIComponent, RegExp,
  Object, Array, String, Number, Boolean, Error, Map, Set, Symbol, Proxy, Reflect, Intl,
  Uint8Array, ArrayBuffer, DataView, Infinity, NaN, undefined,
  document: documentStub,
  localStorage: localStorageStub,
  navigator: { userAgent: "test-boot", language: "uk", onLine: false, geolocation: makeStub("geo") },
  location: { href: "http://t/", protocol: "http:", pathname: "/", search: "", hash: "", origin: "http://t", hostname: "t", reload() {} },
  fetch: () => new Promise(() => {}),           // never resolves — boot must not await network
  L: makeStub("L"),                              // Leaflet
  ClipperLib: makeStub("ClipperLib"),
  MAVLINK: makeStub("MAVLINK"),
  MAV_LINK: makeStub("MAV_LINK"),
  confirm: () => false, alert: () => {}, prompt: () => null,
  indexedDB: { open: () => makeStub("idbreq") },
  URL: Object.assign(function (u) { return { href: String(u) }; }, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }),
  Blob: function () {}, FileReader: function () { return makeStub("fr"); },
  requestAnimationFrame: (f) => setTimeout(f, 0),
  performance: { now: () => 0 },
  screen: { width: 1000, height: 800 },
  Notification: undefined, caches: undefined,
  NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 },
  MutationObserver: function () { return { observe() {}, disconnect() {} }; },
  ResizeObserver: function () { return { observe() {}, disconnect() {} }; },
  addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
  matchMedia: () => ({ matches: false, addListener() {}, addEventListener() {} }),
  getComputedStyle: () => ({ getPropertyValue: () => "" }),
  history: { replaceState() {}, pushState() {} },
};
sandbox.window = sandbox;                        // app.js does window.X = ...
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
Object.assign(windowStub, sandbox);

const src = fs.readFileSync(new URL("./web-stable/app.js", import.meta.url), "utf8");
let bootError = null;
try {
  vm.runInNewContext(src, sandbox, { filename: "app.js", timeout: 30000 });
} catch (e) {
  bootError = e;
}

check("app.js IIFE evaluates to the end without throwing" + (bootError ? "  →  " + bootError.message : ""), bootError === null);
// A marker assigned on the LAST stretch of the IIFE proves the whole body ran (this exact
// global was undefined during the 2.5.72 incident):
check("late-file boot marker present (window.__fmpImportKml)", typeof sandbox.__fmpImportKml === "function");

console.log("\nRESULT: " + (failed ? failed + " FAILURE(S)" : "ALL CHECKS PASSED"));
process.exit(failed ? 1 : 0);
