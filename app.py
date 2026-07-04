"""Field Mission Planner — desktop entry point.

Opens a native window (Edge WebView2 on Windows 11) hosting the Leaflet map UI,
with the Python coverage/mission core exposed to JS via pywebview's js_api.

Run:  python app.py
"""
import os

import webview

from backend.api import Api

HERE = os.path.dirname(os.path.abspath(__file__))
INDEX = os.path.join(HERE, "web", "index.html")


def main():
    api = Api()
    window = webview.create_window(
        "Field Mission Planner — ArduCopter",
        INDEX,
        js_api=api,
        width=1760,
        height=1040,
        resizable=False,   # WebView2 on this Python build crashes (get_ZoomFactor,
                           # UI-thread COM error) on resize/maximize — so we pin the
                           # size. For full-screen, use the browser mode (serve.py).
    )
    api.set_window(window)
    # Also never move/resize the window from outside (Win32) — same crash.
    webview.start()


if __name__ == "__main__":
    main()
