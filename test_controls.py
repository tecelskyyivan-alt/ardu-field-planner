"""Guard: the flight controls are SLIDE-to-confirm, never tap-fireable.

Ivan's field requirement: "щоб не було випадкових кліків під час роботи у руках".
The dangerous flight triad (ARM/DISARM · СТАРТ/ПАУЗА/ПРОДОВЖ · RTL) must fire ONLY
on a deliberate slide gesture — an accidental tap with the phone in your hands must
do nothing. The behaviour is proven end-to-end in a browser by ctrltest.js
(tap≠fire / slide=fire); this static guard locks the invariant into the suite so a
future refactor can't silently wire a flight action back onto a plain click.
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
JS = open(os.path.join(HERE, "web", "app.js"), encoding="utf-8").read()


def check(name, cond):
    print(("  OK  " if cond else " FAIL ") + name)
    if not cond:
        check.failed = True


check.failed = False

print("== slide-to-confirm machinery present ==")
check("abSlide() builder exists", "function abSlide(" in JS)
check("attachSlide() gesture handler exists", "function attachSlide(" in JS)
check("SLIDE_ACTS maps the flight actions", "const SLIDE_ACTS" in JS)
for act in ("arm", "disarm", "start", "pause", "resume", "rtl"):
    check(f"SLIDE_ACTS has '{act}'", re.search(r"SLIDE_ACTS\s*=\s*{[^}]*\b" + act + r"\b", JS, re.S) is not None)
check("gesture records window.__fmpLastAction", "__fmpLastAction" in JS)
check("slide needs a real drag (threshold on width)", "w * 0.66" in JS or "w*0.66" in JS)

print("\n== the flight triad is rendered as slide buttons ==")
for act, label in (("arm", "ARM"), ("disarm", "DISARM"), ("start", "СТАРТ"),
                   ("rtl", "RTL"), ("pause", "ПАУЗА"), ("resume", "ПРОДОВЖ")):
    check(f"triad uses abSlide(\"{act}\", …)", f'abSlide("{act}"' in JS)
check("triad no longer uses tap-only abBig for flight", 'abBig("arm"' not in JS and 'abBig("start"' not in JS and 'abBig("rtl"' not in JS)

print("\n== a plain click can NOT fire a flight action ==")
# action-bar click delegation must skip slide buttons
check("click delegation skips '.swipe' buttons", 'classList.contains("swipe")' in JS)
# and the tap action map must NOT route flight actions to a button click
for bad in ('arm: () => proxyClick("mav-arm")',
            'start: () => proxyClick("mav-start")',
            'rtl: () => proxyClick("mav-rtl")',
            'disarm: () => proxyClick("mav-disarm")'):
    check(f"UI_ACTS does NOT tap-wire: {bad[:18]}…", bad not in JS)

print("\nRESULT: " + ("ALL CHECKS PASSED" if not check.failed else "FAILURES ABOVE"))
sys.exit(1 if check.failed else 0)
