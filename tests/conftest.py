# The script-style suites moved here from the repo root run their checks at import time
# (and test_sitl* start a simulator), so pytest must not import them. Run each as
# `python tests/<name>.py` / `node tests/<name>.mjs`, as CI does.
collect_ignore = [
    "test_api.py", "test_api_safe_transit.py", "test_bridge.py", "test_core.py", "test_features.py",
    "test_gaps.py", "test_mavlink.py", "test_plane_turns.py", "test_safe_transit.py", "test_serve.py",
    "test_sitl.py", "test_sitl_elrs.py", "test_sitl_wind.py", "test_split.py", "test_ui.py",
    "test_upload_turn_radius.py", "test_v24.py", "test_vio_home_upload.py",
    "test_i18n_coverage.py",
]
