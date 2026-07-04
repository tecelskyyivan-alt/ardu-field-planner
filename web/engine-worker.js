/* Field Mission Planner — planning engine in a Web Worker.
 *
 * Runs Pyodide (CPython/WASM) + the backend Python engine OFF the main thread,
 * so loading/initialising it and every route build never block the UI. This is
 * what keeps the map smooth on phones (Pyodide on the main thread froze it).
 *
 * Messages in:  {id, type:"init"}               -> {id, ok}
 *               {id, type:"build", params}      -> {id, ok, result}  (build_route)
 */
const DIR = self.location.href.replace(/[^/]*$/, "");   // app root (works under /ai too)
let py = null;
let booting = null;

async function boot() {
  importScripts(DIR + "pyodide/pyodide.js");            // defines loadPyodide
  py = await loadPyodide({ indexURL: DIR + "pyodide/" });
  await py.loadPackage(["numpy", "shapely"]);
  py.FS.mkdir("/backend");
  for (const m of ["__init__", "geo", "coverage", "mission", "api", "flight_calib"]) {
    const resp = await fetch(DIR + "engine/" + m + ".py");
    if (!resp.ok) throw new Error("engine module " + m + " -> " + resp.status);
    py.FS.writeFile("/backend/" + m + ".py", await resp.text());
  }
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
    } else {
      self.postMessage({ id, ok: false, error: "unknown message: " + type });
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
