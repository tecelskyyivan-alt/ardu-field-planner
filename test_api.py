"""End-to-end API + pywebview wiring smoke test (no GUI window)."""
import os

import webview
from backend.api import Api

print("webview import OK; SAVE_DIALOG =", webview.SAVE_DIALOG)

api = Api()  # window stays None -> export uses headless fallback path
res = api.build_route({
    "boundary": [
        {"lat": 50.4500, "lng": 30.5200},
        {"lat": 50.4500, "lng": 30.5240},
        {"lat": 50.4518, "lng": 30.5240},
        {"lat": 50.4518, "lng": 30.5200},
    ],
    "spacing": 25, "angle": 30, "alt": 50,
    "takeoff_alt": 10, "speed": 12, "rtl": True,
})
print("build_route ok:", res["ok"], "| count:", res["count"],
      "| len_m:", res["length_m"], "| area_ha:", res["area_ha"],
      "| dur_s:", res["duration_s"])

os.chdir(os.path.dirname(os.path.abspath(__file__)))
print("export .waypoints ->", api.export("waypoints"))
print("export .plan      ->", api.export("plan"))

# Show the first few lines of the generated waypoints file.
with open("mission.waypoints", encoding="utf-8") as f:
    head = "".join(f.readlines()[:4])
print("--- mission.waypoints (head) ---")
print(head)
