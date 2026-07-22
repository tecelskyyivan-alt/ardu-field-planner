#!/usr/bin/env bash
# Sync the canonical Python coverage engine (backend/) into the two OFFLINE
# bundles that ship it:
#   web-stable/engine/                      -> the installable PWA (Pyodide loads these)
#   android/app/src/main/assets/engine/     -> the native APK (Pyodide in a WebView)
#
# engine-worker.js fetches exactly these 6 modules; keep the list in sync with it.
# Run this BEFORE every deploy / APK build so the offline engine never drifts from
# backend/ (drift = the "route algorithm broke again" class of bug).
set -e
cd "$(dirname "$0")"
MODS="__init__ geo coverage plane_turns mission api flight_calib"
DESTS="web-stable/engine android/app/src/main/assets/engine"
for d in $DESTS; do
  mkdir -p "$d"
  for m in $MODS; do cp -f "backend/$m.py" "$d/$m.py"; done
  echo "synced -> $d"
done
echo "engine sync OK ($(echo $MODS | wc -w) modules x $(echo $DESTS | wc -w) targets)"
