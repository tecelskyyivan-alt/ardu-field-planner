"""Guard: every element id that app.js looks up must exist in index.html.

Across many iterations the UI grew a lot of inputs/buttons; a renamed or missing
id breaks silently (the handler just no-ops). This cross-checks the two files —
pure text, no browser — so such a mismatch fails the test suite instead.
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
JS = open(os.path.join(HERE, "web-stable", "app.js"), encoding="utf-8").read()
HTML = open(os.path.join(HERE, "web-stable", "index.html"), encoding="utf-8").read()


def check(name, cond):
    print(("  OK  " if cond else " FAIL ") + name)
    if not cond:
        check.failed = True


check.failed = False

# ids referenced from JS: $("id") and getElementById("id"), single or double quotes
refs = set(re.findall(r"""\$\(\s*["']([\w-]+)["']\s*\)""", JS))
refs |= set(re.findall(r"""getElementById\(\s*["']([\w-]+)["']\s*\)""", JS))
# ids declared in HTML: id="..."
declared = set(re.findall(r"""\bid\s*=\s*["']([\w-]+)["']""", HTML))

# app.js is shared with a fuller (beta) UI, so it references some controls that the
# canonical web-stable/index.html intentionally omits. Every such reference is GUARDED
# (`if ($("id")) …`), so a missing one is a no-op, not a bug. Allow-list them here; the
# check still fails on any OTHER (unexpected) missing id — e.g. a genuine rename.
OPTIONAL = {"takeoff-info", "sections", "anchor-source", "my-position",
            "set-start", "start-finish", "split-field", "clear-split"}

print("== app.js element ids exist in index.html ==")
print(f"  {len(refs)} ids referenced in app.js, {len(declared)} declared in index.html")
missing = sorted(refs - declared - OPTIONAL)
if missing:
    print("  MISSING in index.html: " + ", ".join(missing))
check("no unexpected app.js id is missing from index.html", not missing)

# sanity: the key controls present in the canonical UI are all declared.
for _id in ["build", "margin", "round-turn", "lang-toggle",
            "save-project", "load-project", "add-exclusion", "clear-exclusions",
            "save-exclusions", "edit-exclusions",
            "mav-conn-type", "mav-port", "mav-connect", "mav-disconnect",
            "mav-upload", "mav-hud", "mav-arm", "mav-disarm", "mav-mode",
            "mav-set-mode", "mav-start", "mav-rtl", "mav-check", "mission-status",
            "mav-baud", "mav-follow", "export-flights",
            "exp-kml", "import-kml", "kml-file", "export-flights-csv"]:
    check(f"control '{_id}' present in HTML", _id in declared)

print("\nRESULT: " + ("ALL CHECKS PASSED" if not check.failed else "FAILURES ABOVE"))
sys.exit(1 if check.failed else 0)
