"""Field Mission Planner — STABLE desktop launcher.

Ivan's Desktop shortcut points here. It pins the desktop app to the released,
known-good frontend in `web-stable/` (currently v2.5.4) instead of the live
`web/` folder, where the beta / redesign work happens. So no matter how torn-up
the beta gets, the PC app on the Desktop stays stable and working.

To run the BETA on the desktop instead, launch `app_qt.py` (serves `web/`).

The env var MUST be set before `serve` is imported (serve.py reads FMP_WEB_DIR
at import time), so we set it here and only then import the real app.
"""
import os
import sys

_here = os.path.dirname(os.path.abspath(__file__))
os.environ["FMP_WEB_DIR"] = os.path.join(_here, "web-stable")

import app_qt  # noqa: E402  (import after FMP_WEB_DIR is set)

if __name__ == "__main__":
    app_qt.main()
