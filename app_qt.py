"""Field Mission Planner — native desktop app (Qt / QtWebEngine).

Stable replacement for the pywebview/WebView2 window (which crashes on this
Python build — get_ZoomFactor, accessibility recursion). QtWebEngine is a mature
embedded Chromium that handles resize/maximize cleanly.

Architecture: the existing HTTP backend (serve.py) runs on a background thread;
a QWebEngineView shows the same UI from http://127.0.0.1:<port>/. The frontend
(app.js) already talks to the backend over HTTP when pywebview is absent.

Run:  python app_qt.py
"""
import os
import sys

# Resource base. When packaged with PyInstaller, bundled files live under
# sys._MEIPASS; the user-editable folder is next to the .exe.
if getattr(sys, "frozen", False):
    HERE = getattr(sys, "_MEIPASS", os.path.dirname(sys.executable))
    EXE_DIR = os.path.dirname(sys.executable)
else:
    HERE = os.path.dirname(os.path.abspath(__file__))
    EXE_DIR = HERE
sys.path.insert(0, HERE)

# Keep GPU acceleration ON (do NOT pass --disable-gpu — software rendering makes
# the Leaflet map lag). Ignore noisy GPU info logs.
os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS", "--enable-gpu-rasterization --ignore-gpu-blocklist")

from serve import start  # noqa: E402

from PySide6.QtCore import QUrl  # noqa: E402
from PySide6.QtGui import QIcon  # noqa: E402
from PySide6.QtWidgets import QApplication, QMainWindow  # noqa: E402
from PySide6.QtWebEngineWidgets import QWebEngineView  # noqa: E402


def main():
    port = start()
    url = f"http://127.0.0.1:{port}/"

    app = QApplication(sys.argv)
    app.setApplicationName("Field Mission Planner")
    icon_path = os.path.join(HERE, "icon.ico")
    if os.path.exists(icon_path):
        app.setWindowIcon(QIcon(icon_path))

    win = QMainWindow()
    win.setWindowTitle("Field Mission Planner — ArduCopter")
    if os.path.exists(icon_path):
        win.setWindowIcon(QIcon(icon_path))

    view = QWebEngineView()
    # PERSISTENT browser profile so localStorage (the "last mission settings"
    # autosave, flight log, saved fields) SURVIVES restarts. Qt's default profile is
    # off-the-record (everything in memory), which is exactly why the desktop app
    # forgot settings between launches while the phone (persistent WebView storage)
    # remembered them. A NAMED profile with a storage path persists to disk.
    try:
        from PySide6.QtWebEngineCore import QWebEngineProfile, QWebEnginePage
        appdata = os.environ.get("LOCALAPPDATA") or os.path.join(
            os.path.expanduser("~"), ".local", "share")
        store = os.path.join(appdata, "FieldMissionPlanner")
        os.makedirs(store, exist_ok=True)
        profile = QWebEngineProfile("fmp", app)              # named -> persistent
        profile.setPersistentStoragePath(store)
        profile.setCachePath(os.path.join(store, "cache"))
        profile.setPersistentCookiesPolicy(
            QWebEngineProfile.PersistentCookiesPolicy.ForcePersistentCookies)
        # Keep the HTTP cache OFF (so an updated index.html/app.js/style.css always
        # loads) — that's separate from localStorage, which the named profile keeps.
        profile.setHttpCacheType(QWebEngineProfile.HttpCacheType.NoCache)
        view.setPage(QWebEnginePage(profile, view))
    except Exception:
        try:
            from PySide6.QtWebEngineCore import QWebEngineProfile
            view.page().profile().setHttpCacheType(QWebEngineProfile.HttpCacheType.NoCache)
        except Exception:
            pass
    view.load(QUrl(url))
    win.setCentralWidget(view)

    # Packaging smoke test: FMP_SELFTEST=1 loads the real UI, prints whether the
    # page rendered, and exits — so a frozen build can be verified without a window.
    if os.environ.get("FMP_SELFTEST") == "1":
        from PySide6.QtCore import QTimer
        def _fin(ok):
            print("SELFTEST loadFinished", ok, flush=True)
            app.exit(0 if ok else 3)
        view.loadFinished.connect(_fin)
        QTimer.singleShot(25000, lambda: app.exit(4))
        sys.exit(app.exec())

    win.resize(1600, 1000)
    win.showMaximized()   # Qt handles resize/maximize natively — no crash
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
