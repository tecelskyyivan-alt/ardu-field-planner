/* Field Mission Planner — offline planning engine (Pyodide + the Python coverage core).
 *
 * Two execution modes, with automatic fallback:
 *   1. WORKER  — Pyodide runs in engine-worker.js on a SEPARATE thread (smooth UI).
 *                Used on a real https origin (PWA / desktop-web).
 *   2. MAIN    — Pyodide runs on the MAIN thread. Used when the worker can't load —
 *                notably the native Android APK, where a dedicated Web Worker's
 *                requests to the WebViewAssetLoader virtual host (appassets…) are NOT
 *                intercepted, so the worker can't fetch pyodide/engine and crashes.
 *                Main-FRAME requests ARE intercepted, so main-thread Pyodide works
 *                fully offline. The build is a one-shot button, so a brief freeze is OK.
 *
 *   window.FMP_ENGINE.init()             -> Promise (idempotent)
 *   window.FMP_ENGINE.isReady()          -> bool
 *   window.FMP_ENGINE.available()        -> bool (false only if BOTH modes failed)
 *   window.FMP_ENGINE.buildRoute(params) -> Promise<result>  (== /api/build_route)
 */
(function (root) {
  "use strict";
  const DIR = new URL("./", location.href).href;
  const MODULES = ["__init__", "geo", "coverage", "plane_turns", "mission", "api", "flight_calib"];
  // Native APK: skip the worker entirely (its asset fetches don't get intercepted) and
  // go straight to main-thread Pyodide, which works offline.
  const IS_APK = /FMPAndroid/i.test(navigator.userAgent || "");

  let mode = null;            // "worker" | "main"
  let worker = null;
  let pyMain = null;          // Pyodide instance (main-thread mode)
  let ready = null;           // the init() promise (idempotent)
  let readyDone = false;
  let failed = false;
  let seq = 0;
  const pending = new Map();

  // Surface boot progress / failures to the app's diagnostic log (set by app.js), so
  // an uploaded log shows EXACTLY where/why the engine failed on a user's device.
  function report(msg) { try { if (typeof root.FMP_ENGINE_LOG === "function") root.FMP_ENGINE_LOG("[engine] " + msg); } catch (e) {} }

  // ---- worker mode --------------------------------------------------------
  function startWorker() {
    worker = new Worker(DIR + "engine-worker.js");
    worker.onmessage = (e) => {
      const { id, ok, result, error } = e.data || {};
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      ok ? p.resolve(result) : p.reject(new Error(error || "engine error"));
    };
    worker.onerror = (e) => {
      report("worker.onerror: " + ((e && e.message) || "crashed"));
      for (const p of pending.values()) p.reject(new Error("engine worker crashed"));
      pending.clear();
      worker = null;
    };
  }
  function callWorker(type, params, timeoutMs) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const to = timeoutMs ? setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error("worker timeout")); }
      }, timeoutMs) : null;
      pending.set(id, {
        resolve: (v) => { if (to) clearTimeout(to); resolve(v); },
        reject: (e) => { if (to) clearTimeout(to); reject(e); },
      });
      worker.postMessage({ id, type, params });
    });
  }

  // ---- main-thread mode ---------------------------------------------------
  async function bootMain() {
    report("main-thread boot: loading pyodide.js");
    if (typeof root.loadPyodide !== "function") {
      await new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = DIR + "pyodide/pyodide.js";
        s.onload = res;
        s.onerror = () => rej(new Error("pyodide.js failed to load"));
        document.head.appendChild(s);
      });
    }
    report("loadPyodide…");
    // Kick the .py fetches off NOW (network) so they overlap the WASM compile below.
    const _modFetch = MODULES.map((m) => fetch(DIR + "engine/" + m + ".py").then((r) => {
      if (!r.ok) throw new Error("engine module " + m + " -> HTTP " + r.status);
      return r.text();
    }));
    pyMain = await root.loadPyodide({ indexURL: DIR + "pyodide/" });
    report("loadPackage numpy+shapely…");
    await pyMain.loadPackage(["numpy", "shapely"]);
    report("mounting engine modules…");
    try { pyMain.FS.mkdir("/backend"); } catch (e) {}
    const _modTexts = await Promise.all(_modFetch);
    MODULES.forEach((m, i) => pyMain.FS.writeFile("/backend/" + m + ".py", _modTexts[i]));
    pyMain.runPython("import sys; sys.path.insert(0, '/'); from backend.api import Api; _api = Api()");
    report("main-thread engine ready");
  }
  function buildMain(params) {
    pyMain.globals.set("_pj", JSON.stringify(params));
    const out = pyMain.runPython("import json as _j; _j.dumps(_api.build_route(_j.loads(_pj)))");
    return JSON.parse(out);
  }

  // ---- init: worker first, fall back to main-thread -----------------------
  async function doInit() {
    if (!IS_APK) {
      try {
        startWorker();
        await callWorker("init", null, 60000);   // 60s: a slow phone worker mustn't fall back to re-loading 28MB WASM on the main thread
        mode = "worker";
        readyDone = true;
        report("worker engine ready");
        return;
      } catch (e) {
        report("worker mode failed (" + ((e && e.message) || e) + ") → main-thread fallback");
        try { if (worker) worker.terminate(); } catch (e2) {}
        worker = null;
      }
    } else {
      report("APK → main-thread engine (worker asset fetches aren't intercepted)");
    }
    // Main-thread fallback (also the APK's primary path).
    await bootMain();
    mode = "main";
    readyDone = true;
  }

  root.FMP_ENGINE = {
    init() {
      if (!ready) {
        ready = doInit().catch((e) => {
          failed = true;
          report("init FAILED: " + ((e && e.message) || e));
          throw e;
        });
      }
      return ready;
    },
    isReady() { return readyDone && !failed; },
    available() { return !failed; },
    async buildRoute(params) {
      await this.init();
      if (mode === "worker") return callWorker("build", params);
      return buildMain(params);
    },
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
