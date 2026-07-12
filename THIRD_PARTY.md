# Third-party components & attribution

This project bundles or uses the following third-party software and data. Their
licenses apply to their respective files.

## Bundled libraries
- **Leaflet** (BSD-2-Clause) — interactive map.
- **Leaflet.draw** (MIT) — polygon / polyline drawing.
- **Pyodide** (MPL-2.0) + **NumPy** / **SciPy** / **Shapely** wheels (BSD / BSD / BSD) —
  in-browser Python geometry engine. (Not committed; synced/downloaded at build time.)
- **pymavlink** (LGPL-3.0) — MAVLink protocol (desktop backend).

## Not bundled (download / build separately)
- **ArduPilot** & **SITL** (GPL-3.0) — flight-controller firmware and simulator.
  SITL binaries and their runtime DLLs are **not** included in this repository.

## Online services (attribution required when used)
- **OpenStreetMap** map data — © OpenStreetMap contributors, **ODbL**.
- **Esri** World Imagery, **Google** satellite, **CARTO**, **OpenTopoMap**,
  **Open-Meteo** (elevation) — used online only; subject to their terms.

## Notes
- Field-boundary datasets with non-commercial licenses (e.g. NASA Harvest CC-BY-NC-ND)
  are **not** included and must not be redistributed under this repository's license.
