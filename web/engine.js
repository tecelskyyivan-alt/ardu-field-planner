/* Field Mission Planner — offline planning engine (main-thread proxy).
 *
 * The heavy work (Pyodide + the Python coverage engine) runs in engine-worker.js
 * on a SEPARATE thread, so the map/UI never freeze — critical on phones. This
 * file just spawns the worker and exposes a small async API to app.js.
 *
 *   window.FMP_ENGINE.init()            -> Promise (idempotent; boots Pyodide off-thread)
 *   window.FMP_ENGINE.isReady()         -> bool
 *   window.FMP_ENGINE.available()       -> bool (false only if the worker failed)
 *   window.FMP_ENGINE.buildRoute(params)-> Promise<result>  (== /api/build_route)
 */
(function (root) {
  "use strict";
  const DIR = new URL("./", location.href).href;
  let worker = null;
  let ready = null;
  let readyDone = false;
  let failed = false;
  let seq = 0;
  const pending = new Map();

  function ensureWorker() {
    if (worker || failed) return;
    try {
      worker = new Worker(DIR + "engine-worker.js");
    } catch (e) { failed = true; return; }
    worker.onmessage = (e) => {
      const { id, ok, result, error } = e.data || {};
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      ok ? p.resolve(result) : p.reject(new Error(error || "engine error"));
    };
    worker.onerror = () => {
      failed = true;
      for (const p of pending.values()) p.reject(new Error("engine worker crashed"));
      pending.clear();
    };
  }

  function call(type, params) {
    ensureWorker();
    if (!worker) return Promise.reject(new Error("engine unavailable"));
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, type, params });
    });
  }

  root.FMP_ENGINE = {
    init() {
      if (!ready) {
        ready = call("init")
          .then(() => { readyDone = true; })
          .catch((e) => { failed = true; console.error("[engine] init failed:", e); throw e; });
      }
      return ready;
    },
    isReady() { return readyDone && !failed; },
    available() { return !failed; },
    async buildRoute(params) {
      await this.init();
      return call("build", params);
    },
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
