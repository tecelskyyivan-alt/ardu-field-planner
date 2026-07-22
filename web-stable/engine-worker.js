/* Field Mission Planner — planning engine in a Web Worker.
 *
 * Runs Pyodide (CPython/WASM) + the backend Python engine OFF the main thread,
 * so loading/initialising it and every route build never block the UI. This is
 * what keeps the map smooth on phones (Pyodide on the main thread froze it).
 *
 * Messages in:  {id, type:"init"}               -> {id, ok}
 *               {id, type:"build", params}      -> {id, ok, result}  (build_route)
 *               {id, type:"safe_transit", params} -> {id, ok, result}  (safe_transit; #12)
 */
const DIR = self.location.href.replace(/[^/]*$/, "");   // app root (works under /ai too)
let py = null;
let booting = null;

async function boot() {
  const _mods = ["__init__", "geo", "coverage", "plane_turns", "mission", "api", "flight_calib"];
  const _modFetch = _mods.map((m) => fetch(DIR + "engine/" + m + ".py").then((r) => {
    if (!r.ok) throw new Error("engine module " + m + " -> " + r.status);
    return r.text();
  }));                                                 // fetch in parallel with the WASM boot below
  importScripts(DIR + "pyodide/pyodide.js");            // defines loadPyodide
  py = await loadPyodide({ indexURL: DIR + "pyodide/" });
  await py.loadPackage(["numpy", "shapely"]);
  py.FS.mkdir("/backend");
  const _modTexts = await Promise.all(_modFetch);
  _mods.forEach((m, i) => py.FS.writeFile("/backend/" + m + ".py", _modTexts[i]));
  py.runPython("import sys; sys.path.insert(0, '/'); from backend.api import Api; _api = Api()");
}

self.onmessage = async (e) => {
  const { id, type, params } = e.data || {};
  try {
    if (!booting) booting = boot();
    await booting;
    if (type === "init") {
      self.postMessage({ id, ok: true });
    } else if (type === "build") {
      py.globals.set("_pj", JSON.stringify(params));
      const out = py.runPython("import json as _j; _j.dumps(_api.build_route(_j.loads(_pj)))");
      self.postMessage({ id, ok: true, result: JSON.parse(out) });
    } else if (type === "safe_transit") {
      // #12: safe ingress/egress legs for the last-built route (viz + mission splice callers).
      py.globals.set("_pj", JSON.stringify(params));
      const out = py.runPython("import json as _j; _j.dumps(_api.safe_transit(_j.loads(_pj)))");
      self.postMessage({ id, ok: true, result: JSON.parse(out) });
    } else {
      self.postMessage({ id, ok: false, error: "unknown message: " + type });
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
