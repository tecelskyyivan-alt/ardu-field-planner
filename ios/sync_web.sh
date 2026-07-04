#!/usr/bin/env bash
# Copy the stable web app into the iOS bundle dir (App/web), the same code the PWA
# and Android APK ship. Run before `xcodegen generate` / before every build to pick
# up web changes. Mirrors android/ populating assets/web from web-stable.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/../web-stable"
DST="$HERE/App/web"

if [ ! -d "$SRC" ]; then echo "web-stable not found at $SRC" >&2; exit 1; fi

rm -rf "$DST"
mkdir -p "$DST"
cp -R "$SRC"/. "$DST"/

# The Pyodide runtime (~28 MB: pyodide.asm.wasm + numpy/shapely wheels + stdlib) is a
# large asset kept OUTSIDE web-stable, so copy it in from the canonical location. The
# offline planning engine (coverage/mission/geo) won't load without it.
PYO=""
for c in "$HERE/../web/pyodide" "$HERE/../android/app/src/main/assets/web/pyodide"; do
  if [ -d "$c" ]; then PYO="$c"; break; fi
done
if [ -n "$PYO" ]; then
  mkdir -p "$DST/pyodide"
  cp -R "$PYO"/. "$DST/pyodide"/
else
  echo "WARNING: pyodide runtime not found — offline planning engine will NOT work." >&2
fi

# The service worker is pointless inside the native shell (the app is already
# offline + served locally); the web app unregisters it when it sees the FMPiOS UA.
echo "synced web-stable (+pyodide) → App/web ($(find "$DST" -type f | wc -l | tr -d ' ') files, $(du -sh "$DST" 2>/dev/null | cut -f1))"
