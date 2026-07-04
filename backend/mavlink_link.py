"""Live MAVLink link to an ArduPilot vehicle — connect, read telemetry, and
upload a mission directly (no Mission Planner / no SD-card shuffling).

Design: ONE background reader thread owns the connection. It continuously reads
incoming messages into a shared telemetry snapshot, and also drives the mission
upload handshake when one is requested (so the socket is only ever touched by a
single thread — pymavlink connections are not thread-safe). API calls just hand
the thread a request and wait on an Event.

Connection strings (pymavlink mavutil syntax):
  * "COM7"                      serial USB/telemetry radio (give baud, e.g. 57600)
  * "udp:127.0.0.1:14550"       listen for a vehicle/SITL stream (udpin)
  * "udpout:127.0.0.1:14550"    send to a fixed endpoint
  * "tcp:127.0.0.1:5760"        SITL default

Mission items mirror the file exporter (mission.py): WP0=home (abs frame),
NAV_TAKEOFF, NAV_WAYPOINTs (relative alt), optional RETURN_TO_LAUNCH.
"""
import threading
import time

# MAVLink command / frame constants (avoid importing the dialect just for these).
FRAME_GLOBAL = 0               # MAV_FRAME_GLOBAL — absolute alt (home)
FRAME_GLOBAL_REL = 3           # MAV_FRAME_GLOBAL_RELATIVE_ALT
CMD_WAYPOINT = 16              # MAV_CMD_NAV_WAYPOINT
CMD_RTL = 20                   # MAV_CMD_NAV_RETURN_TO_LAUNCH
CMD_TAKEOFF = 22              # MAV_CMD_NAV_TAKEOFF
CMD_DO_CHANGE_SPEED = 178     # MAV_CMD_DO_CHANGE_SPEED
CMD_DO_SET_MODE = 176         # MAV_CMD_DO_SET_MODE
CMD_MISSION_START = 300       # MAV_CMD_MISSION_START
CMD_ARM_DISARM = 400          # MAV_CMD_COMPONENT_ARM_DISARM
CMD_SET_MESSAGE_INTERVAL = 511  # MAV_CMD_SET_MESSAGE_INTERVAL (a COMMAND_LONG)

# Telemetry to stream, as (message_id, interval µs). ArduCopter's SRx_* stream
# rates default to 0, so nothing but HEARTBEAT/STATUSTEXT arrives until a GCS asks
# — and a single request is easily lost over ELRS. Rates kept modest for the 1:2
# link (~6.5 msg/s): position 2Hz, GPS 1Hz, battery 0.5Hz, hud 2Hz, wp 1Hz.
_STREAM_MSGS = [
    (33, 500000),    # GLOBAL_POSITION_INT
    (24, 1000000),   # GPS_RAW_INT
    (1, 2000000),    # SYS_STATUS
    (74, 500000),    # VFR_HUD
    (42, 1000000),   # MISSION_CURRENT
]

# ArduCopter flight-mode numbers (stable custom_mode values).
ACM_MODES = {
    "STABILIZE": 0, "ALT_HOLD": 2, "AUTO": 3, "GUIDED": 4, "LOITER": 5,
    "RTL": 6, "LAND": 9, "BRAKE": 17, "SMART_RTL": 21,
}

# Plain-language explanations of ArduPilot result codes (so the UI never shows a
# bare "код 4"). MAV_RESULT (command ACK):
_CMD_RESULT = {
    0: "прийнято",
    1: "тимчасово відхилено — дрон зайнятий, спробуй ще раз за мить",
    2: "відхилено — команда недоступна в цьому стані (напр. не той режим)",
    3: "ця команда не підтримується дроном",
    4: "не виконано — найчастіше не пройдено перевірку перед зльотом (pre-arm) "
       "або режим не дозволяє цю дію",
    5: "виконується…",
    6: "скасовано",
}
# MAV_MISSION_RESULT (mission ACK):
_MISSION_RESULT = {
    1: "загальна помилка місії",
    2: "непідтримувана система координат у точці",
    3: "тип команди місії не підтримується",
    4: "немає місця — забагато точок для цього дрона",
    5: "некоректна місія",
    13: "порушено послідовність точок",
    14: "відмовлено дроном",
    15: "таймаут прийому місії",
}
# Common ArduPilot pre-arm / failure phrases -> Ukrainian hints.
_REASON_HINTS = [
    ("3d fix", "немає 3D-фіксації GPS — зачекай на супутники"),
    ("need position", "немає позиції GPS — зачекай на супутники"),
    ("gps", "проблема з GPS"),
    ("ekf", "система навігації (EKF) ще не готова — зачекай"),
    ("waiting for home", "ще не встановлено домашню точку — зачекай"),
    ("compass", "проблема з компасом (потрібне калібрування)"),
    ("accel", "проблема з акселерометром (потрібне калібрування)"),
    ("gyro", "проблема з гіроскопом (потрібне калібрування)"),
    ("battery", "низька напруга/проблема батареї"),
    ("throttle", "газ не в нейтралі (опусти стік газу)"),
    ("safety", "натисни запобіжну кнопку (safety switch)"),
    ("rc", "немає сигналу пульта (RC)"),
    ("fence", "порушення геозони (fence)"),
    ("mode not armable", "у цьому режимі не можна вмикати мотори — постав GUIDED/LOITER"),
    ("arming check", "не пройдено перевірки перед зльотом (ARMING_CHECK)"),
]


def _humanize_reason(txt):
    """Turn an ArduPilot STATUSTEXT into a Ukrainian hint (keep the original too)."""
    if not txt:
        return ""
    low = txt.lower()
    for key, hint in _REASON_HINTS:
        if key in low:
            return f"{hint} (ArduPilot: {txt})"
    return f"ArduPilot: {txt}"


def build_mission_items(home, takeoff_alt, waypoints, wp_alt, rtl=True, speed=0.0):
    """Build the ordered mission items for upload.

    Returns a list of dicts: {seq, frame, command, current, autocontinue,
    p1..p4, lat, lon, alt}. lat/lon are degrees here; the uploader converts to
    int32 (deg*1e7) for MISSION_ITEM_INT.

    When `speed` > 0 a DO_CHANGE_SPEED item is inserted right after takeoff so
    the vehicle flies the mission at the CHOSEN speed (otherwise it just uses its
    default WPNAV_SPEED and ignores the planned speed). Layout:
        0 home · 1 takeoff · [2 do_change_speed] · waypoints… · [rtl]
    """
    items = []

    def add(frame, command, lat, lon, alt, current=0, p1=0.0, p2=0.0, p3=0.0, p4=0.0):
        items.append({
            "seq": len(items), "frame": frame, "command": command,
            "current": current, "autocontinue": 1,
            "p1": p1, "p2": p2, "p3": p3, "p4": p4,
            "lat": lat, "lon": lon, "alt": alt,
        })

    # WP0 = home (absolute frame, current=1) — ArduPilot overwrites with the real
    # home at arm, same convention as the .waypoints export.
    add(FRAME_GLOBAL, CMD_WAYPOINT, home[0], home[1], home[2], current=1)
    # Takeoff to relative altitude.
    add(FRAME_GLOBAL_REL, CMD_TAKEOFF, home[0], home[1], takeoff_alt)
    # Hold the planned ground speed for the whole mission.
    if speed and speed > 0:
        add(FRAME_GLOBAL_REL, CMD_DO_CHANGE_SPEED, 0.0, 0.0, 0.0,
            p1=1.0, p2=float(speed), p3=-1.0)   # type=groundspeed, speed m/s, throttle no-change
    for lat, lon in waypoints:
        add(FRAME_GLOBAL_REL, CMD_WAYPOINT, lat, lon, wp_alt)
    if rtl:
        add(FRAME_GLOBAL_REL, CMD_RTL, 0.0, 0.0, 0.0)
    return items


class MavLink:
    """Singleton-style live link. One instance shared by the API."""

    def __init__(self):
        self._conn = None
        self._thread = None
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._tlm = self._blank_tlm()
        self._conn_str = None
        self._target_sys = 0
        self._target_comp = 0
        # Pending mission upload / download / command, handed to the reader
        # thread (the only thread allowed to touch the connection).
        self._upload = None        # {"items":[...], "event":Event, "result":dict}
        self._download = None      # {"event":Event, "result":dict}
        self._command = None       # {"cmd":int, "params":[7], "event":Event, "result":dict}
        self._param = None         # {"name":str, "value":float, "event":Event, "result":dict}
        self._streams_ok = False          # set once position/GPS telemetry arrives
        self._last_stream_req = 0.0       # throttle the telemetry re-request
        self._stream_req_count = 0        # how many asks (fast at first, then slow)
        self._ap_seen = False             # an autopilot heartbeat seen (target locked)
        self._hb_any = False              # ANY heartbeat seen (bridge or autopilot) — link alive
        self._last_pos_ts = 0.0           # last position/GPS message time (staleness re-arm)
        self._busy = False                # a mission/command transfer owns the link
        self._last_gcs_hb = 0.0           # when we last announced ourselves as a GCS

    @staticmethod
    def _blank_tlm():
        return {
            "connected": False, "heartbeat_age": None, "armed": None,
            "mode": None, "lat": None, "lon": None, "alt_rel": None,
            "sats": None, "fix_type": None, "groundspeed": None,
            "heading": None, "battery_v": None, "battery_pct": None,
            "wp_current": None, "wp_total": None, "last_text": None,
            "home_lat": None, "home_lon": None,   # ArduPilot's actual home (arm point)
            # GPS quality + velocity — for the anti-jamming / anti-spoofing guard.
            "hdop": None, "h_acc": None, "gps_vel": None, "vx": None, "vy": None, "vz": None,
        }

    # Standard MAVLink baud rates (same set Mission Planner/QGC offer). USB
    # cable is almost always 115200; SiK telemetry radios 57600.
    STD_BAUDS = [115200, 57600, 921600, 230400, 460800, 38400, 19200, 9600]

    # ------------------------------------------------------------- connect
    def connect(self, conn_str, baud="auto"):
        try:
            from pymavlink import mavutil  # noqa: F401
        except Exception:
            return {"ok": False, "error": "pymavlink не встановлено (pip install pymavlink)."}

        self.disconnect()  # tear down any previous link
        is_serial = conn_str.upper().startswith("COM") or "/dev/" in conn_str

        # AUTO baud (serial only): try the common rates until one gives a
        # heartbeat — like Mission Planner's auto-detect.
        if is_serial and str(baud).lower() in ("auto", "0", ""):
            for b in self.STD_BAUDS:
                r = self._open(conn_str, b, hb_wait=3.0)
                if r.get("ok") and not r.get("warning"):
                    r["baud"] = b
                    return r
                self.disconnect()
            # No heartbeat at any rate — open at 115200 so the user can still try.
            r = self._open(conn_str, 115200, hb_wait=1.0)
            r["baud"] = 115200
            r.setdefault("warning", "Авто-baud не знайшов heartbeat — відкрито на 115200.")
            return r

        b = (int(baud) if str(baud).lower() not in ("auto", "0", "") else 115200) if is_serial else None
        return self._open(conn_str, b, hb_wait=6.0)

    def _open(self, conn_str, baud, hb_wait=6.0):
        """Open one connection (baud=None for UDP/TCP) and wait hb_wait s for a heartbeat."""
        from pymavlink import mavutil
        try:
            kwargs = {"baud": int(baud)} if baud else {}
            conn = mavutil.mavlink_connection(conn_str, **kwargs)
        except Exception as exc:
            low = str(exc).lower()
            if "refused" in low or "10061" in low:
                why = "немає відповіді за цією адресою — дрон/симулятор не запущено або не той порт"
            elif "permission" in low or "access is denied" in low or ("13" in low and "com" in conn_str.lower()):
                why = "порт зайнятий іншою програмою (закрий Mission Planner/інший GCS на цьому порту)"
            elif "could not open port" in low or "filenotfound" in low or "no such" in low:
                why = "порт не знайдено — перевір кабель і вибраний COM-порт"
            else:
                why = str(exc)
            return {"ok": False, "error": f"Не вдалося підключитися до {conn_str}: {why}."}

        self._conn = conn
        self._conn_str = conn_str
        self._stop.clear()
        self._streams_ok = False
        self._last_stream_req = 0.0
        self._stream_req_count = 0
        self._ap_seen = False
        self._hb_any = False
        self._last_pos_ts = 0.0
        self._last_gcs_hb = 0.0
        with self._lock:
            self._tlm = self._blank_tlm()
        self._thread = threading.Thread(target=self._reader, daemon=True)
        self._thread.start()

        deadline = time.time() + hb_wait
        while time.time() < deadline:
            with self._lock:
                if self._tlm["connected"]:
                    return {"ok": True, "target_system": self._target_sys, "conn": conn_str}
            time.sleep(0.1)
        return {"ok": True, "warning": "Зʼєднання відкрито, але heartbeat ще не отримано.",
                "conn": conn_str}

    def disconnect(self):
        self._stop.set()
        t = self._thread
        if t and t.is_alive():
            t.join(timeout=2.0)
        self._thread = None
        if self._conn:
            try:
                self._conn.close()
            except Exception:
                pass
        self._conn = None
        # Abort any pending transfer so a new connection doesn't service it.
        with self._lock:
            up, self._upload = self._upload, None
            dl, self._download = self._download, None
            cmd, self._command = self._command, None
            par, self._param = self._param, None
        for pend in (up, dl, cmd, par):
            if pend is not None:
                self._complete(pend, {"ok": False, "error": "Звʼязок розірвано."})
        with self._lock:
            self._tlm = self._blank_tlm()
        return {"ok": True}

    def status(self):
        with self._lock:
            return dict(self._tlm)

    # ----------------------------------------------------- transfer helpers
    def _targets(self):
        """Target (system, component) for mission messages — the autopilot we
        last heard a heartbeat from. Component defaults to 1 (AUTOPILOT1), NOT 0,
        so routed/multi-component links don't drop the targeted mission traffic."""
        with self._lock:
            return (self._target_sys or 1, self._target_comp or 1)

    def _complete(self, req, result):
        """Finalize a pending request exactly once (idempotent vs disconnect)."""
        with self._lock:
            if not req["event"].is_set():
                req["result"] = result
                req["event"].set()

    def _recv_mission(self, conn, types, timeout):
        """Receive the next message whose type is in `types`, while FEEDING every
        other message to _ingest. This keeps telemetry (heartbeat/GPS/battery)
        and STATUSTEXT alive during a multi-second mission transfer instead of
        dropping them (so the link doesn't 'age out' mid-upload)."""
        end = time.time() + timeout
        while True:
            remain = end - time.time()
            if remain <= 0:
                return None
            try:
                msg = conn.recv_match(blocking=True, timeout=min(0.5, max(0.05, remain)))
            except Exception:
                return None
            if msg is None:
                continue
            if msg.get_type() in types:
                return msg
            self._ingest(conn, msg)   # telemetry + STATUSTEXT stay current

    # -------------------------------------------------------- mission upload
    def upload_mission(self, items, timeout=660.0):
        """Hand a mission to the reader thread and wait for the ACK. The wait is
        generous (the handshake itself is bounded by a no-progress stall timeout)
        so a large mission over a slow ELRS/RF link isn't cut off mid-transfer."""
        if not self._conn or not (self._thread and self._thread.is_alive()):
            return {"ok": False, "error": "Немає звʼязку. Спочатку підключись до дрона."}
        with self._lock:
            if not self._tlm["connected"]:
                return {"ok": False, "error": "Heartbeat відсутній — дрон не відповідає."}
        ev = threading.Event()
        req = {"items": items, "event": ev, "result": None}
        with self._lock:
            if self._upload is not None or self._download is not None or self._command is not None:
                return {"ok": False, "error": "Триває інший обмін місією — зачекай."}
            self._upload = req
        if not ev.wait(timeout=timeout):
            with self._lock:
                if self._upload is req:
                    self._upload = None
            return {"ok": False, "error": "Таймаут заливки місії (дрон не підтвердив)."}
        return req["result"] or {"ok": False, "error": "Невідома помилка заливки."}

    def download_mission(self, timeout=660.0):
        """Read the mission currently stored on the vehicle back to the GCS.

        Returns {ok, count, items:[{seq,command,frame,x,y,z}, ...]} where x/y are
        int32 (deg*1e7) exactly as MISSION_ITEM_INT carries them."""
        if not self._conn or not (self._thread and self._thread.is_alive()):
            return {"ok": False, "error": "Немає звʼязку. Спочатку підключись до дрона."}
        with self._lock:
            if not self._tlm["connected"]:
                return {"ok": False, "error": "Heartbeat відсутній — дрон не відповідає."}
        ev = threading.Event()
        # No-progress (stall) window the reader uses to give up — kept just under
        # the caller's overall wait so it reports a shortfall before this wait ends,
        # but generous by default (slow ELRS/RF links) when no tight timeout given.
        stall = min(15.0, max(4.0, timeout - 3.0))
        req = {"event": ev, "result": None, "stall": stall}
        with self._lock:
            if self._upload is not None or self._download is not None or self._command is not None:
                return {"ok": False, "error": "Триває інший обмін місією — зачекай."}
            self._download = req
        if not ev.wait(timeout=timeout):
            with self._lock:
                if self._download is req:
                    self._download = None
            return {"ok": False, "error": "Таймаут зчитування місії з дрона."}
        return req["result"] or {"ok": False, "error": "Невідома помилка зчитування."}

    def verify_mission(self, expected, timeout=660.0):
        """Upload-confirmation: download the stored mission and compare it to the
        items we meant to upload. Returns {ok, verified, count_expected,
        count_actual, mismatches:[...]}. The home item (seq 0) and the RTL item
        carry no real coordinates, so only their command is checked; NAV items
        are compared on command + lat/lon (int) + altitude (±1 m)."""
        dl = self.download_mission(timeout=timeout)
        if not dl.get("ok"):
            return {"ok": False, "verified": False, "error": dl.get("error"),
                    "count_expected": len(expected)}
        actual = dl["items"]
        mismatches = []
        if len(actual) != len(expected):
            mismatches.append(f"кількість: очікувалось {len(expected)}, у дроні {len(actual)}")
        # Compare per-seq across the FULL range so extra/missing items surface
        # explicitly instead of being hidden by zip() truncation.
        for i in range(max(len(expected), len(actual))):
            e = expected[i] if i < len(expected) else None
            a = actual[i] if i < len(actual) else None
            if e is None:
                mismatches.append(f"#{i}: зайвий пункт у дроні (cmd {a['command']})")
                continue
            if a is None:
                mismatches.append(f"#{i}: пункт відсутній у дроні")
                continue
            if e["command"] != a["command"]:
                mismatches.append(f"#{e['seq']}: команда {e['command']}≠{a['command']}")
                continue
            # Only NAV items past home carry meaningful coordinates / frame.
            if e["command"] in (CMD_WAYPOINT, CMD_TAKEOFF) and e["seq"] != 0:
                # Relative-alt frames 3 and 6 (the _INT variant) are synonymous in
                # MISSION_ITEM_INT, as are absolute 0 and 5 — some autopilots store
                # one and report the other, so don't flag that as a mismatch.
                _equiv = ({3, 6}, {0, 5})
                same_frame = e["frame"] == a["frame"] or any(
                    e["frame"] in g and a["frame"] in g for g in _equiv)
                if not same_frame:
                    mismatches.append(f"#{e['seq']}: рамка висоти {e['frame']}≠{a['frame']}")
                    continue
                ex, ey = int(round(e["lat"] * 1e7)), int(round(e["lon"] * 1e7))
                if abs(ex - a["x"]) > 3 or abs(ey - a["y"]) > 3:
                    mismatches.append(f"#{e['seq']}: координати розійшлись")
                elif abs(float(e["alt"]) - float(a["z"])) > 1.0:
                    mismatches.append(f"#{e['seq']}: висота {e['alt']}≠{round(a['z'], 1)}")
        verified = (len(actual) == len(expected)) and not mismatches
        return {"ok": True, "verified": verified,
                "count_expected": len(expected), "count_actual": len(actual),
                "mismatches": mismatches[:10]}

    # ----------------------------------------------------- flight commands
    def command(self, cmd, params, timeout=8.0):
        """Queue a COMMAND_LONG for the reader thread and wait for COMMAND_ACK."""
        if not self._conn or not (self._thread and self._thread.is_alive()):
            return {"ok": False, "error": "Немає звʼязку. Спочатку підключись до дрона."}
        ev = threading.Event()
        params = list(params) + [0.0] * (7 - len(params))
        req = {"cmd": cmd, "params": params, "event": ev, "result": None}
        with self._lock:
            if not self._tlm["connected"]:
                return {"ok": False, "error": "Heartbeat відсутній — дрон не відповідає."}
            if self._upload or self._download or self._command:
                return {"ok": False, "error": "Триває інший обмін з дроном — зачекай."}
            self._command = req
        if not ev.wait(timeout=timeout):
            with self._lock:
                if self._command is req:
                    self._command = None
            return {"ok": False, "error": "Команда без відповіді (таймаут)."}
        return req["result"] or {"ok": False, "error": "Невідома помилка команди."}

    def arm(self, want=True, force=False):
        # param2=21196 = force (bypasses pre-arm checks; NOT the safety switch —
        # that needs BRD_SAFETY_DEFLT=0). ACCEPTED != armed: callers must confirm
        # via the HEARTBEAT armed bit (status()["armed"]).
        return self.command(CMD_ARM_DISARM,
                            [1.0 if want else 0.0, 21196.0 if force else 0.0])

    def set_mode(self, name):
        num = ACM_MODES.get((name or "").upper())
        if num is None:
            return {"ok": False, "error": f"Невідомий режим: {name}"}
        # base_mode = MAV_MODE_FLAG_CUSTOM_MODE_ENABLED (1), param2 = mode number.
        return self.command(CMD_DO_SET_MODE, [1.0, float(num)])

    def set_param(self, name, value, timeout=5.0):
        """Set an autopilot parameter (e.g. WPNAV_SPEED) and wait for confirmation."""
        if not self._conn or not (self._thread and self._thread.is_alive()):
            return {"ok": False, "error": "Немає звʼязку. Спочатку підключись до дрона."}
        ev = threading.Event()
        req = {"name": name, "value": float(value), "event": ev, "result": None}
        with self._lock:
            if self._upload or self._download or self._command or self._param:
                return {"ok": False, "error": "Триває інший обмін з дроном — зачекай."}
            self._param = req
        if not ev.wait(timeout=timeout):
            with self._lock:
                if self._param is req:
                    self._param = None
            return {"ok": False, "error": "Параметр не підтверджено (таймаут)."}
        return req["result"] or {"ok": False, "error": "Невідома помилка параметра."}

    def set_mission_current(self, seq, reset=0):
        # MAV_CMD_DO_SET_MISSION_CURRENT (224): jump the mission pointer to `seq`.
        # param2 (reset)=1 also resets DO_JUMP repeat counters AND moves a
        # COMPLETED mission back to runnable — needed to re-fly the same field.
        return self.command(224, [float(seq), float(reset)])

    def mission_start(self):
        # Reset to the first item (the takeoff) FIRST, so a stale current-wp from
        # a previous run can't make it resume mid-mission and skip the takeoff.
        # reset=1 so a previously-COMPLETED mission restarts cleanly (re-fly).
        self.set_mission_current(0, reset=1)
        return self.command(CMD_MISSION_START, [0.0, 0.0])

    # ------------------------------------------------------------- internals
    def _reader(self):
        """Own the connection: parse telemetry, service upload requests."""
        from pymavlink import mavutil  # noqa: F401  (ensures dialect loaded)
        conn = self._conn
        while not self._stop.is_set():
            # Claim a pending mission upload/download atomically, then service it.
            up = dl = None
            with self._lock:
                if self._upload is not None:
                    up, self._upload = self._upload, None
                if self._download is not None:
                    dl, self._download = self._download, None
                if self._command is not None:
                    cmd, self._command = self._command, None
                else:
                    cmd = None
                if self._param is not None:
                    par, self._param = self._param, None
                else:
                    par = None
            if up or dl or cmd or par:
                # Mark the link busy so background telemetry housekeeping (e.g. the
                # periodic HOME re-request) never injects a stray command into the
                # middle of a mission/command handshake.
                self._busy = True
                try:
                    if up is not None:
                        self._do_upload(conn, up)
                    if dl is not None:
                        self._do_download(conn, dl)
                    if cmd is not None:
                        self._do_command(conn, cmd)
                    if par is not None:
                        self._do_param(conn, par)
                finally:
                    self._busy = False
            # Keep a steady GCS heartbeat going (skip while a transfer owns the
            # link — _recv_mission runs the handshake and would interleave sends).
            if not self._busy:
                self._maybe_gcs_heartbeat(conn)
                # Drive the stream re-request from the LOOP too, not only on a heartbeat:
                # a lossy ELRS uplink drops heartbeats, which under "ask only on HB"
                # slowed the asks exactly when the link was worst. Self-throttled inside.
                # Ask once ANY heartbeat is seen (not only the autopilot's): a WiFi/UDP
                # backpack relays only its OWN bridge heartbeat until a GCS requests
                # data, so waiting for the autopilot's heartbeat deadlocked telemetry.
                if self._hb_any and not self._streams_ok:
                    self._maybe_request_streams(conn, self._target_sys, self._target_comp)
                # KEEP-ALIVE: re-assert ALL stream intervals every ~12 s even once
                # telemetry flows — a lossy link drops the initial request for a SLOW
                # stream (battery / groundspeed / current-waypoint), and _streams_ok
                # (set by the fast position stream) would otherwise stop us re-asking,
                # leaving those fields blank for the whole flight. Tiny + idempotent.
                elif self._hb_any and self._streams_ok:
                    if time.time() - getattr(self, "_last_keepalive", 0) > 12.0:
                        self._last_keepalive = time.time()
                        self._send_stream_requests(conn, self._target_sys, self._target_comp)
            try:
                msg = conn.recv_match(blocking=True, timeout=0.5)
            except Exception:
                msg = None
            if msg is None:
                self._age_out()
                continue
            self._ingest(conn, msg)

    def _maybe_gcs_heartbeat(self, conn):
        """Announce ourselves as a GCS ~1 Hz, exactly like Mission Planner / QGC.
        Proper GCS behaviour, and it bootstraps MAVLink bridges (e.g. an ExpressLRS
        TX backpack over WiFi) that only start streaming to a ground station once
        they have heard from one. Mirrors the browser link's GCS heartbeat."""
        now = time.time()
        if now - self._last_gcs_hb < 1.0:
            return
        self._last_gcs_hb = now
        try:
            from pymavlink import mavutil
            mav = mavutil.mavlink
            # type=GCS(6), autopilot=INVALID(8), no mode flags, status=ACTIVE(4).
            conn.mav.heartbeat_send(mav.MAV_TYPE_GCS, mav.MAV_AUTOPILOT_INVALID,
                                    0, 0, mav.MAV_STATE_ACTIVE)
        except Exception:
            # udpin with no peer yet (nothing received) has nowhere to send — fine,
            # the vehicle/bridge address is learned from the first inbound packet.
            pass

    def _maybe_request_streams(self, conn, sysid, compid):
        """Re-request telemetry every 3 s until it actually flows. ArduCopter's
        SRx_* default to 0 and a single request packet is easily lost on the narrow
        ELRS link, so this is idempotent and self-healing — it stops once position/
        GPS arrives (_streams_ok) and the staleness check re-arms it if the streams
        die. Called from the already-locked HEARTBEAT branch, so it must NOT lock.

        We ask ONLY for the messages the HUD shows, via per-message SET_MESSAGE_INTERVAL
        — NOT REQUEST_DATA_STREAM(ALL). Over an ELRS backpack ALL turns on every group
        (IMU/compass/baro/RC/attitude…) and floods the narrow 1:2 link, starving the
        important GPS/position/battery messages — the reason the backpack showed far
        less telemetry than a cable. The surgical request fits the link."""
        if self._busy or self._streams_ok:
            return
        sysid = sysid or self._target_sys
        compid = self._target_comp if compid is None else compid
        now = time.time()
        # Punch through a lossy ELRS uplink: the first ~6 asks go out every 1.2 s, then
        # settle to every 3 s. A single SET_MESSAGE_INTERVAL is easily dropped, so being
        # aggressive early gets telemetry flowing far sooner (the backpack ate every
        # request in the first ~15 s under the old flat 3 s cadence — only HEARTBEAT
        # arrived, GPS/battery stayed "?"). Tiny uplink commands → no downlink flood.
        interval = 1.2 if self._stream_req_count < 6 else 3.0
        if now - self._last_stream_req < interval:
            return
        self._last_stream_req = now
        self._stream_req_count += 1
        self._send_stream_requests(conn, sysid, compid)

    def _send_stream_requests(self, conn, sysid, compid):
        """Fire one SET_MESSAGE_INTERVAL per wanted stream (idempotent). Used by both
        the aggressive startup loop and the steady keep-alive."""
        sysid = sysid or self._target_sys
        compid = self._target_comp if compid is None else compid
        try:
            for mid, us in _STREAM_MSGS:
                conn.mav.command_long_send(sysid, compid, CMD_SET_MESSAGE_INTERVAL, 0,
                                           float(mid), float(us), 0, 0, 0, 0, 0)
        except Exception:
            pass

    def _pause_streams(self, conn):
        """Stop the telemetry streams for the duration of a mission transfer so they
        don't saturate a narrow ELRS link and starve the FC's MISSION_REQUEST/ITEM
        replies (upload stalls at 0/N). They re-arm right after (next heartbeat,
        since _streams_ok=False)."""
        ts, tc = self._targets()
        try:
            for mid, _us in _STREAM_MSGS:
                conn.mav.command_long_send(ts, tc, CMD_SET_MESSAGE_INTERVAL, 0,
                                           float(mid), -1.0, 0, 0, 0, 0, 0)
        except Exception:
            pass
        with self._lock:
            self._streams_ok = False
            self._last_stream_req = 0.0
            self._stream_req_count = 0

    def _age_out(self):
        with self._lock:
            ts = getattr(self, "_last_hb_ts", None)
            if ts is not None:
                age = time.time() - ts
                self._tlm["heartbeat_age"] = round(age, 1)
                if age > 5.0:
                    self._tlm["connected"] = False
            # Streams died (e.g. FC reboot) → re-arm the re-request loop.
            if self._streams_ok and self._last_pos_ts and \
                    time.time() - self._last_pos_ts > 6.0:
                self._streams_ok = False
                self._last_stream_req = 0.0
                self._stream_req_count = 0

    def _ingest(self, conn, msg):
        t = msg.get_type()
        if t == "BAD_DATA":
            return
        with self._lock:
            tl = self._tlm
            if t == "HEARTBEAT":
                from pymavlink import mavutil
                self._last_hb_ts = time.time()
                self._hb_any = True
                tl["connected"] = True
                tl["heartbeat_age"] = 0.0
                # Only the AUTOPILOT's heartbeat defines the TARGET for commands/mission
                # — never adopt an ELRS backpack / MAVLink bridge heartbeat
                # (autopilot=INVALID(8) or type=GCS(6)) as the target, hence the isAp
                # gate below. But STILL request telemetry on any heartbeat (addressed to
                # the autopilot, default sys1), which a bridge forwards to the FC.
                # REGRESSION FIX: gating the stream request on the autopilot heartbeat
                # deadlocked a WiFi/UDP backpack — only the bridge heartbeat is seen, so
                # the FC was never asked, never streamed, and its heartbeat never came.
                if msg.autopilot != 8 and msg.type != 6:
                    self._target_sys = msg.get_srcSystem()
                    self._target_comp = msg.get_srcComponent()
                    self._ap_seen = True
                    # Keep asking for HOME (410) until we have it: no home until GPS
                    # lock, so a single early request goes unanswered. Hold off while a
                    # transfer owns the link.
                    if tl["home_lat"] is None and not self._busy and \
                            time.time() - getattr(self, "_last_home_req", 0.0) > 8.0:
                        self._last_home_req = time.time()
                        try:
                            conn.mav.command_long_send(
                                msg.get_srcSystem(), msg.get_srcComponent(),
                                410, 0, 0, 0, 0, 0, 0, 0, 0)
                        except Exception:
                            pass
                    tl["armed"] = bool(msg.base_mode & mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED)
                    try:
                        tl["mode"] = mavutil.mode_string_v10(msg)
                    except Exception:
                        tl["mode"] = None
                # Ask for telemetry on ANY heartbeat — targeting the locked autopilot if
                # known, else the default sys1 — so a bridge that only relays once a GCS
                # requests data starts forwarding the FC streams. Self-throttles inside.
                if not self._busy:
                    self._maybe_request_streams(
                        conn, self._target_sys, self._target_comp)
            elif t == "GLOBAL_POSITION_INT":
                self._streams_ok = True
                self._last_pos_ts = time.time()
                tl["lat"] = msg.lat / 1e7
                tl["lon"] = msg.lon / 1e7
                tl["alt_rel"] = round(msg.relative_alt / 1000.0, 1)
                tl["heading"] = round(msg.hdg / 100.0, 1) if msg.hdg != 65535 else None
                # EKF velocity (cm/s -> m/s) — sanity-checks GPS position jumps (spoofing).
                tl["vx"] = msg.vx / 100.0
                tl["vy"] = msg.vy / 100.0
                tl["vz"] = msg.vz / 100.0
            elif t == "GPS_RAW_INT":
                self._streams_ok = True
                self._last_pos_ts = time.time()
                tl["sats"] = msg.satellites_visible
                tl["fix_type"] = msg.fix_type
                # GPS quality: eph = HDOP×100, h_acc = horiz accuracy (mm), vel = ground speed (cm/s).
                eph = getattr(msg, "eph", None)
                tl["hdop"] = round(eph / 100.0, 2) if (eph is not None and eph != 65535) else None
                hacc = getattr(msg, "h_acc", None)
                tl["h_acc"] = round(hacc / 1000.0, 2) if (hacc is not None and hacc > 0) else None
                vel = getattr(msg, "vel", None)
                tl["gps_vel"] = round(vel / 100.0, 2) if (vel is not None and vel != 65535) else None
            elif t == "VFR_HUD":
                tl["groundspeed"] = round(msg.groundspeed, 1)
                if tl.get("heading") is None:
                    tl["heading"] = msg.heading
            elif t == "SYS_STATUS":
                tl["battery_v"] = round(msg.voltage_battery / 1000.0, 2) if msg.voltage_battery != 65535 else None
                tl["battery_pct"] = msg.battery_remaining if msg.battery_remaining != -1 else None
            elif t == "HOME_POSITION":
                # The home ArduPilot actually uses (set at arm / first fix).
                tl["home_lat"] = msg.latitude / 1e7
                tl["home_lon"] = msg.longitude / 1e7
            elif t == "MISSION_CURRENT":
                tl["wp_current"] = msg.seq
                total = getattr(msg, "total", None)   # newer MISSION_CURRENT carries it
                if total is not None and total > 0:
                    tl["wp_total"] = total
            elif t == "STATUSTEXT":
                try:
                    tl["last_text"] = msg.text
                except Exception:
                    pass

    def _reject_reason(self, code):
        """Plain-language mission rejection + the vehicle's own STATUSTEXT reason."""
        with self._lock:
            txt = self._tlm.get("last_text")
        why = _MISSION_RESULT.get(code, f"код {code}")
        msg = f"Дрон не прийняв місію: {why}"
        hint = _humanize_reason(txt)
        return msg + (f". {hint}" if hint else ".")

    def _command_reject(self, code):
        """Plain-language command rejection + the vehicle's own STATUSTEXT reason."""
        with self._lock:
            txt = self._tlm.get("last_text")
        why = _CMD_RESULT.get(code, f"код {code}")
        msg = f"Дрон відхилив команду: {why}"
        hint = _humanize_reason(txt)
        return msg + (f". {hint}" if hint else ".")

    def _do_upload(self, conn, req):
        """Run the MISSION_COUNT → ITEM_INT → ACK handshake on this thread."""
        items = req["items"]
        n = len(items)
        ts, tc = self._targets()
        mav = conn.mav
        self._pause_streams(conn)   # clear the link so the mission handshake gets through
        result = {"ok": False, "error": "Заливка не завершилась (таймаут)."}
        try:
            mav.mission_count_send(ts, tc, n, 0)   # mission_type=0 (mission)
            sent = set()
            # Progress-based timeout, not a fixed total: a big mission over a slow
            # ELRS/RF link keeps going as long as the vehicle keeps requesting items
            # (a fixed cap timed out mid-transfer even while it was progressing).
            STALL = 15.0
            hard_deadline = time.time() + 600.0
            last_progress = time.time()
            last_count = time.time()
            got_req = False
            while len(sent) < n and time.time() < hard_deadline:
                if time.time() - last_progress > STALL:
                    if not sent:
                        result = {"ok": False, "error":
                                  f"Дрон не відповів на заливку (0/{n}). Команда не доходить "
                                  f"— по backpack/ELRS канал на завантаження часто замалий. "
                                  f"Спробуй USB-кабель або кращу антену."}
                    else:
                        result = {"ok": False, "error":
                                  f"Заливка зупинилась на {len(sent)}/{n} — дрон перестав "
                                  f"запитувати точки. Перевір зв'язок."}
                    return
                m = self._recv_mission(
                    conn, ("MISSION_REQUEST", "MISSION_REQUEST_INT", "MISSION_ACK"), 1.0)
                if m is None:
                    # Re-announce COUNT ONLY until the vehicle first responds, ≤ once per
                    # 4 s. Each MISSION_COUNT RESETS the vehicle's mission receiver, so an
                    # aggressive resend over a high-latency ELRS link keeps resetting an
                    # in-flight transfer and the upload never starts. 4 s > round-trip.
                    if not got_req and time.time() - last_count > 4.0:
                        mav.mission_count_send(ts, tc, n, 0)
                        last_count = time.time()
                    continue
                if m.get_type() == "MISSION_ACK":
                    if m.type == 0:
                        # Accepted before we saw the last request — done.
                        with self._lock:
                            self._tlm["wp_total"] = n
                        result = {"ok": True, "count": n}
                        return
                    result = {"ok": False, "error": self._reject_reason(m.type)}
                    return
                got_req = True   # vehicle is engaged — stop re-announcing COUNT
                seq = m.seq
                if seq < 0 or seq >= n:
                    continue   # spurious / out-of-range request — ignore
                it = items[seq]
                mav.mission_item_int_send(
                    ts, tc, it["seq"], it["frame"], it["command"],
                    it["current"], it["autocontinue"],
                    it["p1"], it["p2"], it["p3"], it["p4"],
                    int(round(it["lat"] * 1e7)), int(round(it["lon"] * 1e7)),
                    float(it["alt"]), 0)   # mission_type=0
                sent.add(seq)   # a re-request just resends; set tolerates it
                last_progress = time.time()   # a request serviced → the link is alive
            # All items sent — wait for the final ACK.
            ack = self._recv_mission(conn, ("MISSION_ACK",), 8.0)
            if ack is not None and ack.type == 0:
                with self._lock:
                    self._tlm["wp_total"] = n
                result = {"ok": True, "count": n}
            elif ack is not None:
                result = {"ok": False, "error": self._reject_reason(ack.type)}
            elif len(sent) >= n:
                result = {"ok": True, "count": n,
                          "warning": "Усі точки надіслано, але фінального ACK не отримано."}
        except Exception as exc:
            result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        finally:
            self._complete(req, result)

    def _do_download(self, conn, req):
        """Run the MISSION_REQUEST_LIST → COUNT → ITEM_INT → ACK handshake."""
        ts, tc = self._targets()
        mav = conn.mav
        self._pause_streams(conn)   # clear the link so the mission download gets through
        result = {"ok": False, "error": "Зчитування не завершилось."}
        try:
            # Re-announce REQUEST_LIST until the vehicle replies with the count — the
            # first request is easily lost over a lossy ELRS link (a one-shot request
            # made read-back / verify fail intermittently over the backpack).
            cm = None
            list_deadline = time.time() + 10.0
            while cm is None and time.time() < list_deadline:
                mav.mission_request_list_send(ts, tc, 0)   # mission_type=0
                cm = self._recv_mission(conn, ("MISSION_COUNT",), 2.0)
            if cm is None:
                result = {"ok": False, "error": "Дрон не повернув кількість пунктів."}
                return
            n = cm.count
            items = {}
            deadline = time.time() + 600.0
            stall = req.get("stall", 15.0)
            seq = 0
            last_req = 0.0
            last_progress = time.time()    # give up only if items stop arriving (stall)
            while seq < n and time.time() < deadline:
                if time.time() - last_progress > stall:
                    break                  # no new item for `stall` s — vehicle stalled
                # Re-request only on a new seq or after a per-item gap (don't
                # flood the link by re-asking every loop turn).
                now = time.time()
                if now - last_req > 1.0:
                    mav.mission_request_int_send(ts, tc, seq, 0)
                    last_req = now
                im = self._recv_mission(conn, ("MISSION_ITEM_INT", "MISSION_ITEM"), 1.0)
                if im is None or im.seq != seq:
                    continue
                last_progress = time.time()
                if im.get_type() == "MISSION_ITEM_INT":
                    x, y = int(im.x), int(im.y)
                else:                       # legacy float MISSION_ITEM: x/y in degrees
                    x, y = int(round(im.x * 1e7)), int(round(im.y * 1e7))
                items[seq] = {
                    "seq": seq, "command": im.command, "frame": im.frame,
                    "x": x, "y": y, "z": float(im.z),
                }
                seq += 1
                last_req = 0.0             # request the next seq immediately
            # Tell the vehicle we're done so it stops the transfer.
            mav.mission_ack_send(ts, tc, 0, 0)
            ordered = [items[i] for i in range(n) if i in items]
            if len(ordered) != n:
                result = {"ok": False,
                          "error": f"Зчитано {len(ordered)}/{n} пунктів (таймаут)."}
            else:
                result = {"ok": True, "count": n, "items": ordered}
        except Exception as exc:
            result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        finally:
            self._complete(req, result)

    def _do_param(self, conn, req):
        """Set a param, then READ IT BACK to confirm it actually took (the bare
        PARAM_SET echo is unreliable on some stacks). Targets the autopilot
        component, and also broadcasts (comp 0) as a fallback."""
        from pymavlink import mavutil
        ts = self._target_sys or 1
        name = req["name"]
        val = req["value"]
        nm = name.encode("ascii")
        result = {"ok": False, "error": "Параметр не підтверджено."}

        def _match(m):
            pid = m.param_id
            if isinstance(pid, bytes):
                pid = pid.decode("ascii", "ignore")
            return pid.rstrip("\x00") == name

        try:
            for comp in (self._target_comp or 1, 0):       # autopilot, then broadcast
                conn.mav.param_set_send(ts, comp, nm, float(val),
                                        mavutil.mavlink.MAV_PARAM_TYPE_REAL32)
                conn.mav.param_request_read_send(ts, comp, nm, -1)
                deadline = time.time() + 3.0
                while time.time() < deadline:
                    m = self._recv_mission(conn, ("PARAM_VALUE",), deadline - time.time())
                    if m is None:
                        break
                    if _match(m):
                        # Confirm the value actually changed (within 1%).
                        if abs(float(m.param_value) - float(val)) <= max(1.0, abs(val) * 0.01):
                            result = {"ok": True, "value": m.param_value}
                        else:
                            result = {"ok": False,
                                      "error": f"Параметр {name} не змінився "
                                               f"(у дроні {m.param_value})."}
                        return
        except Exception as exc:
            result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        finally:
            self._complete(req, result)

    def _do_command(self, conn, req):
        """Send a COMMAND_LONG and wait for its matching COMMAND_ACK."""
        ts, tc = self._targets()
        result = {"ok": False, "error": "Команда без відповіді."}
        try:
            p = req["params"]
            conn.mav.command_long_send(ts, tc, req["cmd"], 0,
                                       p[0], p[1], p[2], p[3], p[4], p[5], p[6])
            deadline = time.time() + 5.0
            while time.time() < deadline:
                ack = self._recv_mission(conn, ("COMMAND_ACK",), deadline - time.time())
                if ack is None:
                    break
                if ack.command != req["cmd"]:
                    continue              # ACK for some other command — keep waiting
                if ack.result == 0:       # MAV_RESULT_ACCEPTED
                    result = {"ok": True}
                else:
                    result = {"ok": False, "error": self._command_reject(ack.result)}
                return
        except Exception as exc:
            result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        finally:
            self._complete(req, result)


# Module-level shared instance (the API holds onto this).
LINK = MavLink()
