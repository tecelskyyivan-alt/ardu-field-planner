/* In-browser MAVLink GCS — async port of backend/mavlink_link.py.
 *
 * Drives a live ArduPilot vehicle entirely from the browser (offline): connect +
 * telemetry, direct mission upload with read-back verify, download, and flight
 * commands (arm / mode / mission start) + param set. Uses the hand-rolled codec
 * (MAVLINK) over a byte transport (MAV_TRANSPORT: WebSerial / WebUSB / WebSocket).
 *
 * No threads: the transport's ondata feeds the parser; every message updates the
 * telemetry snapshot AND wakes any pending _recv() waiter. Handshakes are plain
 * async/await. A `_busy` flag serializes transfers so background housekeeping
 * (periodic HOME request) never injects a command mid-handshake.
 */
(function (root) {
  "use strict";

  const FRAME_GLOBAL = 0, FRAME_GLOBAL_REL = 3, FRAME_MISSION = 2;
  const CMD_WAYPOINT = 16, CMD_RTL = 20, CMD_TAKEOFF = 22, CMD_DO_CHANGE_SPEED = 178;
  const CMD_DO_SET_MODE = 176, CMD_MISSION_START = 300, CMD_ARM_DISARM = 400;
  const CMD_PAUSE_CONTINUE = 193;   // MAV_CMD_DO_PAUSE_CONTINUE (Copter: hold on track, stay in AUTO)
  const CMD_GET_HOME = 410, CMD_DO_SET_MISSION_CURRENT = 224;
  const CMD_SET_MESSAGE_INTERVAL = 511;   // MAV_CMD_SET_MESSAGE_INTERVAL (a COMMAND_LONG)
  const GCS_SYS = 255, GCS_COMP = 190;

  // Telemetry we want streamed, as (message_id, interval µs). ArduCopter's SRx_*
  // stream rates default to 0, so nothing but HEARTBEAT/STATUSTEXT arrives until a
  // GCS asks. Rates kept modest for the narrow ELRS 1:2 link (~6.5 msg/s total).
  const STREAM_MSGS = [
    [33, 500000],    // GLOBAL_POSITION_INT 2 Hz (lat/lon/alt/heading)
    [24, 1000000],   // GPS_RAW_INT 1 Hz (fix type + sats)
    [1, 2000000],    // SYS_STATUS 0.5 Hz (battery)
    [74, 500000],    // VFR_HUD 2 Hz (groundspeed)
    [42, 1000000],   // MISSION_CURRENT 1 Hz (current waypoint)
  ];

  // Reply/handshake messages the request/upload/command/param flows wait for. If
  // one of these arrives while no _recv() waiter happens to be registered (two
  // frames in one USB read), it's buffered briefly instead of dropped — otherwise
  // a mission upload over a real serial/RF link can stall ("can't upload").
  const HANDSHAKE = new Set(["MISSION_REQUEST", "MISSION_REQUEST_INT", "MISSION_ACK",
    "MISSION_COUNT", "MISSION_ITEM", "MISSION_ITEM_INT", "COMMAND_ACK", "PARAM_VALUE"]);

  const ACM_MODES = { STABILIZE: 0, ALT_HOLD: 2, AUTO: 3, GUIDED: 4, LOITER: 5, RTL: 6, LAND: 9, BRAKE: 17, SMART_RTL: 21 };
  const ACM_REV = Object.fromEntries(Object.entries(ACM_MODES).map(([k, v]) => [v, k]));
  // ArduPlane mode numbers. INAV re-maps ITS OWN flight mode onto these numbers for
  // fixed-wing (and onto the ArduCopter table for multirotor), so one table names
  // both a real ArduPlane and an INAV wing. 23 = INAV's "unmapped" sentinel.
  const APM_PLANE = { 0:"MANUAL",1:"CIRCLE",2:"STABILIZE",3:"TRAINING",4:"ACRO",5:"FBWA",
    6:"FBWB",7:"CRUISE",8:"AUTOTUNE",10:"AUTO",11:"RTL",12:"LOITER",13:"TAKEOFF",15:"GUIDED" };
  function modeName(cm, vtype) {
    const name = (vtype === 1 ? APM_PLANE[cm] : ACM_REV[cm]);   // 1 = MAV_TYPE_FIXED_WING
    return name || ("MODE " + cm);
  }

  const CMD_RESULT = {
    0: "прийнято",
    1: "тимчасово відхилено — дрон зайнятий, спробуй ще раз за мить",
    2: "відхилено — команда недоступна в цьому стані (напр. не той режим)",
    3: "ця команда не підтримується дроном",
    4: "не виконано — найчастіше не пройдено перевірку перед зльотом (pre-arm) або режим не дозволяє цю дію",
    5: "виконується…", 6: "скасовано",
  };
  const MISSION_RESULT = {
    1: "загальна помилка місії", 2: "непідтримувана система координат у точці",
    3: "тип команди місії не підтримується", 4: "немає місця — забагато точок для цього дрона",
    5: "некоректна місія", 13: "порушено послідовність точок", 14: "відмовлено дроном",
    15: "таймаут прийому місії",
  };
  const REASON_HINTS = [
    ["3d fix", "немає 3D-фіксації GPS — зачекай на супутники"],
    ["need position", "немає позиції GPS — зачекай на супутники"],
    ["gps", "проблема з GPS"], ["ekf", "система навігації (EKF) ще не готова — зачекай"],
    ["waiting for home", "ще не встановлено домашню точку — зачекай"],
    ["compass", "проблема з компасом (потрібне калібрування)"],
    ["accel", "проблема з акселерометром (калібрування)"], ["gyro", "проблема з гіроскопом (калібрування)"],
    ["battery", "низька напруга/проблема батареї"], ["throttle", "газ не в нейтралі (опусти стік газу)"],
    ["safety", "натисни запобіжну кнопку (safety switch)"], ["rc", "немає сигналу пульта (RC)"],
    ["fence", "порушення геозони (fence)"],
    ["mode not armable", "у цьому режимі не можна вмикати мотори — постав GUIDED/LOITER"],
    ["arming check", "не пройдено перевірки перед зльотом (ARMING_CHECK)"],
  ];
  function humanize(txt) {
    if (!txt) return "";
    const low = String(txt).toLowerCase();
    for (const [k, h] of REASON_HINTS) if (low.includes(k)) return `${h} (ArduPilot: ${txt})`;
    return "ArduPilot: " + txt;
  }

  // Build the ordered mission items for upload (mirrors mavlink_link.build_mission_items).
  // Layout: 0 home(abs) · 1 takeoff · [2 do_change_speed] · waypoints… · [rtl].
  function buildMissionItems(home, takeoffAlt, waypoints, wpAlt, rtl, speed) {
    const items = [];
    const add = (frame, command, lat, lon, alt, current, p1, p2, p3, p4) =>
      items.push({ seq: items.length, frame, command, current: current || 0, autocontinue: 1,
        p1: p1 || 0, p2: p2 || 0, p3: p3 || 0, p4: p4 || 0, lat, lon, alt });
    add(FRAME_GLOBAL, CMD_WAYPOINT, home[0], home[1], home[2] || 0, 1);
    add(FRAME_GLOBAL_REL, CMD_TAKEOFF, home[0], home[1], takeoffAlt);
    if (speed && speed > 0) add(FRAME_GLOBAL_REL, CMD_DO_CHANGE_SPEED, 0, 0, 0, 0, 1.0, speed, -1.0);
    for (const [lat, lon] of waypoints) add(FRAME_GLOBAL_REL, CMD_WAYPOINT, lat, lon, wpAlt);
    if (rtl) add(FRAME_GLOBAL_REL, CMD_RTL, 0, 0, 0);
    return items;
  }

  // INAV mission builder. INAV's MAVLink receiver (src/main/telemetry/mavlink.c,
  // verified on 8.0.1) accepts ONLY NAV_WAYPOINT (frame GLOBAL_RELATIVE_ALT) and
  // NAV_RETURN_TO_LAUNCH, as MISSION_ITEM (v1 float), and seq0 = the FIRST waypoint
  // (NO home slot, NO takeoff, NO do_change_speed — each of those gets a
  // MAV_MISSION_UNSUPPORTED and the transfer dies, which is why the ArduCopter-style
  // upload hung on the wing). Cruise speed is a vehicle setting on INAV, not an item.
  function buildMissionItemsInav(waypoints, wpAlt, rtl) {
    const items = [];
    const add = (frame, command, lat, lon, alt) =>
      items.push({ seq: items.length, frame, command, current: 0, autocontinue: 1,
        p1: 0, p2: 0, p3: 0, p4: 0, lat, lon, alt });
    for (const [lat, lon] of waypoints) add(FRAME_GLOBAL_REL, CMD_WAYPOINT, lat, lon, wpAlt);
    if (rtl) add(FRAME_MISSION, CMD_RTL, 0, 0, 0);
    return items;
  }

  function blankTlm() {
    return { connected: false, heartbeat_age: null, armed: null, mode: null, lat: null, lon: null,
      alt_rel: null, sats: null, fix_type: null, groundspeed: null, heading: null,
      battery_v: null, battery_pct: null, wp_current: null, wp_total: null, last_text: null,
      home_lat: null, home_lon: null,
      // GPS quality + velocity — for the anti-jamming / anti-spoofing guard.
      hdop: null, h_acc: null, gps_vel: null, vx: null, vy: null, vz: null };
  }

  class MavLink {
    constructor() {
      this._t = null;
      this._parser = null;
      this._tlm = blankTlm();
      this._seq = 0;
      this._waiters = [];
      this._busy = false;
      this._tsys = 1; this._tcomp = 1;
      this._streamsOk = false;     // set once position/GPS telemetry actually arrives
      this._lastStreamReq = 0;     // throttle the re-request
      this._streamReqCount = 0;    // how many times we've asked (fast at first, then slow)
      this._apSeen = false;        // an autopilot heartbeat has been seen (target locked)
      this._hbAny = false;         // ANY heartbeat seen (bridge or autopilot) — link is alive
      this._lastPosTs = 0;         // last position/GPS message time (staleness re-arm)
      this._lastHomeReq = 0;
      this._lastHb = 0;
      this._ageTimer = null;
      this._pending = [];   // handshake messages that arrived with no waiter (see HANDSHAKE)
      this.onLog = null;            // app sets this to capture a diagnostic log
      this._msgCounts = {};         // per-message-type received counters
      this._hbSrc = "";             // adopted autopilot source signature (for stats)
      this._hbSeen = new Set();     // heartbeat sources already logged (once each)
    }

    _log(s) { if (this.onLog) { try { this.onLog("[mav] " + s); } catch (e) {} } }
    // Snapshot for the diagnostic log: which message types arrived (and how many),
    // whether telemetry is flowing, and the target we locked onto.
    getStats() {
      return { msgCounts: Object.assign({}, this._msgCounts), streamsOk: this._streamsOk,
        target: this._tsys + ":" + this._tcomp, hbSrc: this._hbSrc };
    }

    async connect(transport) {
      this.disconnect();
      this._t = transport;
      this._parser = MAVLINK.createParser();
      this._tlm = blankTlm();
      this._seq = 0; this._streamsOk = false; this._lastStreamReq = 0; this._lastPosTs = 0;
      this._streamReqCount = 0; this._apSeen = false; this._hbAny = false;
      this._lastHomeReq = 0; this._lastHb = 0;
      this._pending = []; this._msgCounts = {}; this._hbSrc = ""; this._hbSeen = new Set();
      this._log("connect: opening link");
      transport.ondata = (chunk) => {
        let msgs;
        try { msgs = this._parser.push(chunk); } catch (e) { return; }
        for (const m of msgs) { this._ingest(m); this._dispatch(m); }
      };
      this._ageTimer = setInterval(() => {
        if (this._lastHb && (Date.now() - this._lastHb) / 1000 > 5) this._tlm.connected = false;
        if (this._lastHb) this._tlm.heartbeat_age = Math.round((Date.now() - this._lastHb) / 100) / 10;
        // Streams died (e.g. FC reboot) → re-arm the re-request loop (fast again).
        if (this._streamsOk && this._lastPosTs && Date.now() - this._lastPosTs > 6000) {
          this._streamsOk = false; this._streamReqCount = 0; this._lastStreamReq = 0;
        }
        // Drive the stream re-request from the TIMER too, not only on a heartbeat: a
        // lossy ELRS uplink drops heartbeats, which under the old "request only on HB"
        // path slowed the asks to a crawl exactly when the link was worst. Now we keep
        // asking on a steady cadence the moment an autopilot has been seen.
        if (this._hbAny && !this._streamsOk && !this._busy)
          this._maybeRequestStreams(this._tsys, this._tcomp);
        // KEEP-ALIVE: re-assert ALL stream intervals every ~12 s even once telemetry is
        // flowing. On a lossy link the initial SET_MESSAGE_INTERVAL for a SLOW stream
        // (battery / groundspeed / current-waypoint) is easily dropped, and «streamsOk»
        // (set by the FAST position stream) would otherwise stop us re-asking — leaving
        // those fields blank for the whole flight. Re-asking is tiny + idempotent.
        if (this._hbAny && this._streamsOk && !this._busy
            && (!this._lastKeepAlive || Date.now() - this._lastKeepAlive > 12000)) {
          this._lastKeepAlive = Date.now();
          this._sendStreamRequests(this._tsys, this._tcomp);
        }
      }, 500);
      // Announce ourselves as a GCS with a periodic HEARTBEAT. This is proper GCS
      // behaviour, and it bootstraps UDP bridges (e.g. an ExpressLRS backpack)
      // that only start streaming to a ground station once they've heard from it.
      const sendHb = () => {
        try {
          this._send("HEARTBEAT", { type: 6, autopilot: 8, base_mode: 0, custom_mode: 0, system_status: 4, mavlink_version: 3 });
        } catch (e) {}
      };
      sendHb();
      this._hbTimer = setInterval(sendHb, 1000);
      // Wait up to 6 s for the first heartbeat.
      const hb = await this._recv(["HEARTBEAT"], 6000);
      this._log(hb ? "connected: heartbeat received" : "connected but NO heartbeat in 6s");
      return hb ? { ok: true, target_system: this._tsys }
                : { ok: true, warning: "Зʼєднання відкрито, але heartbeat ще не отримано." };
    }

    disconnect() {
      if (this._t) this._log("disconnect");
      if (this._ageTimer) { clearInterval(this._ageTimer); this._ageTimer = null; }
      if (this._hbTimer) { clearInterval(this._hbTimer); this._hbTimer = null; }
      for (const w of this._waiters.splice(0)) { clearTimeout(w.timer); w.resolve(null); }
      this._pending = [];
      if (this._t) { try { this._t.close(); } catch (e) {} this._t = null; }
      this._tlm = blankTlm();
      return { ok: true };
    }

    status() { return Object.assign({}, this._tlm); }

    _send(name, fields) {
      const bytes = MAVLINK.encode(name, fields, { sys: GCS_SYS, comp: GCS_COMP, seq: this._seq & 0xff });
      this._seq = (this._seq + 1) & 0xff;
      this._t.write(bytes);
    }

    _recv(types, timeoutMs) {
      const set = new Set(types);
      // Deliver a handshake reply that landed before this waiter was registered
      // (two frames in one read) instead of blocking on a message already gone by.
      for (let i = 0; i < this._pending.length; i++) {
        const p = this._pending[i];
        if (set.has(p.name) && Date.now() - p.t < 3000) { this._pending.splice(i, 1); return Promise.resolve(p.m); }
      }
      return new Promise((resolve) => {
        const w = { set, resolve, timer: null };
        w.timer = setTimeout(() => {
          const i = this._waiters.indexOf(w); if (i >= 0) this._waiters.splice(i, 1);
          resolve(null);
        }, timeoutMs);
        this._waiters.push(w);
      });
    }

    _dispatch(m) {
      for (let i = 0; i < this._waiters.length; i++) {
        if (this._waiters[i].set.has(m.name)) {
          const w = this._waiters.splice(i, 1)[0];
          clearTimeout(w.timer); w.resolve(m); return;
        }
      }
      // No waiter wanted it yet. Buffer the reply types the handshakes wait for so
      // a fast back-to-back frame isn't lost; telemetry is read from the snapshot,
      // never via _recv, so it's not buffered.
      if (HANDSHAKE.has(m.name)) {
        this._pending.push({ name: m.name, m, t: Date.now() });
        if (this._pending.length > 64) this._pending.shift();
      }
    }

    _ingest(m) {
      const tl = this._tlm, f = m.fields;
      this._msgCounts[m.name] = (this._msgCounts[m.name] || 0) + 1;
      if (m.name === "HEARTBEAT") {
        this._lastHb = Date.now();
        this._hbAny = true;
        tl.connected = true; tl.heartbeat_age = 0;
        // Only the AUTOPILOT's heartbeat defines the TARGET for commands/mission. An
        // ELRS backpack / MAVLink bridge emits its OWN heartbeat (autopilot=INVALID(8)
        // or type=GCS(6)); we must NOT adopt it as the command target — that's why the
        // target lock below is gated on isAp. But we STILL request telemetry on any
        // heartbeat, addressed to the autopilot (the locked one, else the ArduPilot
        // default sys1), which a bridge forwards to the FC.
        //
        // REGRESSION FIX: gating the stream request on the autopilot heartbeat (isAp)
        // DEADLOCKED a WiFi/UDP backpack — the app only sees the bridge's heartbeat,
        // so it never asked, so the FC never streamed, so the FC's heartbeat never
        // arrived → telemetry stayed blank the whole flight. (v2.1 asked unconditionally
        // → backpack relayed it → FC streamed → its heartbeat appeared → worked.)
        const isAp = f.autopilot !== 8 && f.type !== 6;
        const sig = `sys${m.sysid} comp${m.compid} ap${f.autopilot} type${f.type}`;
        if (!this._hbSeen.has(sig)) {   // log each distinct heartbeat source once
          this._hbSeen.add(sig);
          this._log("heartbeat src " + sig + (isAp ? " (autopilot ✓)" : " (bridge/GCS — not the target, streams still requested)"));
        }
        if (isAp) {
          this._tsys = m.sysid; this._tcomp = m.compid; this._apSeen = true;
          tl.autopilot = f.autopilot;   // 3 = ArduPilot, 0 = INAV/generic — drives dual-stack
          tl.vehicle_type = f.type;     // 1 = plane, 2 = quad… selects the mode table
          tl.armed = !!(f.base_mode & 0x80);   // MAV_MODE_FLAG_SAFETY_ARMED
          tl.mode = modeName(f.custom_mode, f.type);
          // Keep asking for HOME until we have it (first ask precedes GPS lock).
          if (tl.home_lat == null && !this._busy && Date.now() - this._lastHomeReq > 8000) {
            this._lastHomeReq = Date.now();
            try { this._send("COMMAND_LONG", { target_system: m.sysid, target_component: m.compid, command: CMD_GET_HOME, confirmation: 0, param1: 0, param2: 0, param3: 0, param4: 0, param5: 0, param6: 0, param7: 0 }); } catch (e) {}
          }
        }
        // Ask for telemetry on ANY heartbeat — targeting the locked autopilot if known,
        // else the default sys1 — so a bridge that only relays once a GCS requests data
        // starts forwarding the FC's streams. Idempotent + self-throttled inside.
        this._maybeRequestStreams(this._tsys, this._tcomp);
      } else if (m.name === "GLOBAL_POSITION_INT") {
        if (!this._streamsOk) this._log("✓ telemetry streaming (GLOBAL_POSITION_INT arrived)");
        this._streamsOk = true; this._lastPosTs = Date.now();
        tl.lat = f.lat / 1e7; tl.lon = f.lon / 1e7;
        tl.alt_rel = Math.round(f.relative_alt / 100) / 10;
        tl.heading = f.hdg !== 65535 ? Math.round(f.hdg / 10) / 10 : tl.heading;
        // EKF velocity (cm/s -> m/s) — used to sanity-check GPS position jumps (spoofing).
        tl.vx = f.vx / 100; tl.vy = f.vy / 100; tl.vz = f.vz / 100;
      } else if (m.name === "GPS_RAW_INT") {
        if (!this._streamsOk) this._log("✓ telemetry streaming (GPS_RAW_INT arrived)");
        this._streamsOk = true; this._lastPosTs = Date.now();
        tl.sats = f.satellites_visible; tl.fix_type = f.fix_type;
        // GPS quality: eph = HDOP×100, h_acc = horizontal accuracy (mm), vel = ground speed (cm/s).
        tl.hdop = (f.eph != null && f.eph !== 65535) ? Math.round(f.eph) / 100 : null;
        tl.h_acc = (f.h_acc != null && f.h_acc > 0) ? f.h_acc / 1000 : null;
        tl.gps_vel = (f.vel != null && f.vel !== 65535) ? f.vel / 100 : null;
      } else if (m.name === "VFR_HUD") {
        tl.groundspeed = Math.round(f.groundspeed * 10) / 10;
        if (tl.heading == null) tl.heading = f.heading;
      } else if (m.name === "SYS_STATUS") {
        tl.battery_v = f.voltage_battery !== 65535 ? Math.round(f.voltage_battery / 10) / 100 : null;
        tl.battery_pct = f.battery_remaining !== -1 ? f.battery_remaining : null;
      } else if (m.name === "HOME_POSITION") {
        tl.home_lat = f.latitude / 1e7; tl.home_lon = f.longitude / 1e7;
      } else if (m.name === "MISSION_CURRENT") {
        tl.wp_current = f.seq;
        // The newer MISSION_CURRENT carries the total too — use it so «wp X/Y» is
        // complete even when we didn't upload the mission this session (was X/null).
        if (f.total != null && f.total > 0) tl.wp_total = f.total;
      } else if (m.name === "STATUSTEXT") {
        tl.last_text = f.text;
      }
    }

    // Re-request telemetry every 3 s until it actually flows. ArduCopter's SRx_*
    // stream rates default to 0 and a single request packet is easily lost on the
    // narrow ELRS link, so this is idempotent and self-healing: it stops the moment
    // GLOBAL_POSITION_INT/GPS_RAW_INT arrives (sets _streamsOk), and the _ageTimer
    // re-arms it if the streams ever go stale (e.g. an FC reboot).
    //
    // We ask ONLY for the handful of messages the HUD shows, via per-message
    // SET_MESSAGE_INTERVAL — NOT the legacy REQUEST_DATA_STREAM(ALL). On a cable
    // ALL is harmless, but over an ELRS backpack it turns on every group (IMU /
    // compass / baro / RC / attitude …) and floods the narrow 1:2 link, overflowing
    // the backpack buffer so the IMPORTANT messages (GPS/position/battery) get
    // starved — which is exactly why the backpack showed far less than the cable.
    _maybeRequestStreams(sysid, compid) {
      if (this._busy || this._streamsOk) return;
      sysid = sysid || this._tsys; compid = (compid == null ? this._tcomp : compid);
      const now = Date.now();
      // Punch through a lossy ELRS uplink: the first ~6 asks go out every 1.2 s, then
      // settle to every 3 s. A single SET_MESSAGE_INTERVAL is easily dropped, so being
      // aggressive early gets telemetry flowing far sooner — the backpack often ate
      // every request in the first 15 s under the old flat 3 s cadence (only HEARTBEAT
      // arrived, GPS/battery stayed "?"). Tiny uplink commands, so no downlink flood.
      const interval = this._streamReqCount < 6 ? 1200 : 3000;
      if (now - this._lastStreamReq < interval) return;
      this._lastStreamReq = now;
      this._streamReqCount += 1;
      this._log("→ requesting telemetry streams (SET_MESSAGE_INTERVAL ×" + STREAM_MSGS.length +
                ", try " + this._streamReqCount + ") to sys" + sysid + " comp" + compid);
      this._sendStreamRequests(sysid, compid);
    }
    // Fire one SET_MESSAGE_INTERVAL per wanted stream (idempotent). Used both by the
    // aggressive startup loop AND the steady keep-alive below.
    _sendStreamRequests(sysid, compid) {
      sysid = sysid || this._tsys; compid = (compid == null ? this._tcomp : compid);
      try {
        for (const [mid, us] of STREAM_MSGS)
          this._send("COMMAND_LONG", { target_system: sysid, target_component: compid,
            command: CMD_SET_MESSAGE_INTERVAL, confirmation: 0,
            param1: mid, param2: us, param3: 0, param4: 0, param5: 0, param6: 0, param7: 0 });
      } catch (e) {}
    }

    _targets() { return { ts: this._tsys || 1, tc: this._tcomp || 1 }; }

    // Free the narrow link for a mission transfer. Over an ELRS backpack the
    // telemetry downlink (position/vfr/gps/... ~6.5 msg/s) saturates the link and
    // starves the FC's MISSION_REQUEST/ITEM replies, so upload stalls at 0/N even
    // though commands work. Tell the FC to stop those streams (interval=-1) for the
    // duration; they re-arm automatically right after (streamsOk=false).
    _pauseStreams() {
      const { ts, tc } = this._targets();
      try {
        for (const [mid] of STREAM_MSGS)
          this._send("COMMAND_LONG", { target_system: ts, target_component: tc,
            command: CMD_SET_MESSAGE_INTERVAL, confirmation: 0,
            param1: mid, param2: -1, param3: 0, param4: 0, param5: 0, param6: 0, param7: 0 });
      } catch (e) {}
      this._streamsOk = false; this._lastStreamReq = 0; this._streamReqCount = 0;
      this._log("paused telemetry streams for mission transfer");
    }

    _rejectMission(code) {
      const why = MISSION_RESULT[code] || ("код " + code);
      const hint = humanize(this._tlm.last_text);
      return `Дрон не прийняв місію: ${why}` + (hint ? ". " + hint : ".");
    }
    _rejectCommand(code) {
      const why = CMD_RESULT[code] || ("код " + code);
      const hint = humanize(this._tlm.last_text);
      return `Дрон відхилив команду: ${why}` + (hint ? ". " + hint : ".");
    }

    async _withBusy(fn) {
      if (this._busy) return { ok: false, error: "Триває інший обмін з дроном — зачекай." };
      this._busy = true;
      this._pending = [];   // start each transfer with a clean inbound buffer
      try { return await fn(); } finally { this._busy = false; }
    }

    // ---- mission upload (MISSION_COUNT → REQUEST(_INT) → ITEM_INT → ACK) ----
    // `timeout` is the NO-PROGRESS (stall) window, not a hard total: a big mission
    // over a slow ELRS/RF link keeps going as long as the vehicle keeps requesting
    // items — only a genuinely stalled link (no request for `stallMs`) fails. The
    // old fixed 20 s cap made large uploads over low-bandwidth links time out
    // mid-transfer even though they were progressing fine.
    async uploadMission(items, timeout, onProgress) {
      if (!this._t) return { ok: false, error: "Немає звʼязку. Спочатку підключись до дрона." };
      const stallMs = timeout || 30000;   // no-PROGRESS window (a fresh request/item resets it)
      const HARD_CAP = 600000;            // absolute ceiling (10 min) — safety net only
      const REQ_WAIT = 1000;              // how long to wait each round for the next request
      const RESEND_GAP = 1000;            // min gap between proactive re-sends (pace the narrow uplink)
      return this._withBusy(async () => {
        const { ts, tc } = this._targets();
        this._pauseStreams();          // clear the link so the mission handshake gets through
        const n = items.length;
        const sendCount = () => this._send("MISSION_COUNT", { target_system: ts, target_component: tc, count: n, mission_type: 0 });
        const sendItem = (seq, v1) => {
          const it = items[seq];
          const f = {
            target_system: ts, target_component: tc, seq: it.seq, frame: it.frame, command: it.command,
            current: it.current, autocontinue: it.autocontinue, param1: it.p1, param2: it.p2, param3: it.p3, param4: it.p4,
            z: it.alt, mission_type: 0,
          };
          // Match the item type to what the vehicle ASKED for: a v1 MISSION_REQUEST wants
          // MISSION_ITEM (float lat/lon in degrees) — INAV / older stacks reject the INT
          // variant; a MISSION_REQUEST_INT wants MISSION_ITEM_INT (lat/lon ×1e7, ArduPilot).
          if (v1) this._send("MISSION_ITEM", Object.assign(f, { x: it.lat, y: it.lon }));
          else this._send("MISSION_ITEM_INT", Object.assign(f, { x: Math.round(it.lat * 1e7), y: Math.round(it.lon * 1e7) }));
        };
        sendCount();
        const sent = new Set();
        const hardDeadline = Date.now() + HARD_CAP;
        let lastProgress = Date.now(), lastCount = Date.now(), lastResend = 0, gotReq = false, lastReqSeq = -1, lastReqV1 = false;
        while (sent.size < n && Date.now() < hardDeadline) {
          if (Date.now() - lastProgress > stallMs)
            return { ok: false, error: sent.size === 0
              ? `Дрон не відповів на заливку (0/${n}). Команда на дрон не доходить — по backpack/ELRS канал на завантаження часто замалий. Спробуй USB-кабель або ближче/кращу антену.`
              : `Заливка зупинилась на ${sent.size}/${n} — дрон перестав запитувати точки. Перевір зв'язок/антену.` };
          const m = await this._recv(["MISSION_REQUEST", "MISSION_REQUEST_INT", "MISSION_ACK"], REQ_WAIT);
          if (!m) {
            // No request this round — recover a LOST packet instead of just waiting:
            if (!gotReq) {
              // Before the vehicle first engages: re-announce COUNT. It RESETS the
              // vehicle's mission receiver, so throttle to safely exceed the ELRS
              // round-trip (an aggressive resend keeps resetting an in-flight transfer).
              if (Date.now() - lastCount > 4000) { sendCount(); lastCount = Date.now(); }
            } else if (lastReqSeq >= 0 && Date.now() - lastResend > RESEND_GAP) {
              // Handshake started but went quiet: RE-SEND the last requested item. If OUR
              // item was lost the vehicle finally gets it; if the vehicle's REQUEST was lost,
              // the duplicate makes it re-emit its request → the transfer un-sticks. Unlike
              // MISSION_COUNT this does NOT reset the receiver, so it's safe to repeat. This
              // is the fix for uploads stalling mid-way over a lossy WiFi/ELRS backpack link.
              sendItem(lastReqSeq, lastReqV1); lastResend = Date.now();
            }
            continue;
          }
          if (m.name === "MISSION_ACK") {
            if (m.fields.type === 0) { this._tlm.wp_total = n; return { ok: true, count: n }; }
            return { ok: false, error: this._rejectMission(m.fields.type) };
          }
          gotReq = true;   // the vehicle is engaged — stop re-announcing COUNT
          const seq = m.fields.seq;
          if (seq < 0 || seq >= n) continue;
          lastReqSeq = seq; lastReqV1 = (m.name === "MISSION_REQUEST");   // reply in the requested dialect
          sendItem(seq, lastReqV1);
          lastResend = Date.now();       // an item send also paces the next proactive resend
          lastProgress = Date.now();     // any request (even a re-request) proves the link is alive
          if (!sent.has(seq)) {          // advance the counter on NEW items only
            sent.add(seq);
            if (onProgress) { try { onProgress(sent.size, n); } catch (e) {} }
          }
        }
        // All items sent — wait (generously) for the final ACK, still nudging: the ACK,
        // or a late re-request of the last item(s), is just as easily lost as anything else.
        const ackDeadline = Date.now() + Math.max(stallMs, 10000);
        while (Date.now() < ackDeadline) {
          const m = await this._recv(["MISSION_ACK", "MISSION_REQUEST", "MISSION_REQUEST_INT"], REQ_WAIT);
          if (m && m.name === "MISSION_ACK") {
            if (m.fields.type === 0) { this._tlm.wp_total = n; return { ok: true, count: n }; }
            return { ok: false, error: this._rejectMission(m.fields.type) };
          }
          if (m && (m.name === "MISSION_REQUEST" || m.name === "MISSION_REQUEST_INT")) {
            const seq = m.fields.seq;
            const v1 = (m.name === "MISSION_REQUEST");
            if (seq >= 0 && seq < n) { lastReqSeq = seq; lastReqV1 = v1; sendItem(seq, v1); lastResend = Date.now(); }
            continue;
          }
          // Silence: re-send the last item to prompt the ACK (safe, non-resetting).
          if (lastReqSeq >= 0 && Date.now() - lastResend > RESEND_GAP) { sendItem(lastReqSeq, lastReqV1); lastResend = Date.now(); }
        }
        if (sent.size >= n) return { ok: true, count: n, warning: "Усі точки надіслано, але фінального ACK не отримано." };
        return { ok: false, error: "Таймаут заливки місії (дрон не підтвердив)." };
      });
    }

    // ---- mission download (REQUEST_LIST → COUNT → ITEM_INT → ACK) ----
    async downloadMission(timeout) {
      if (!this._t) return { ok: false, error: "Немає звʼязку." };
      const stallMs = timeout || 15000;        // no-progress window (slow-RF tolerant)
      return this._withBusy(async () => {
        const { ts, tc } = this._targets();
        this._pauseStreams();          // clear the link so the mission download gets through
        // Re-announce REQUEST_LIST until the vehicle replies with the count — the
        // first request is easily lost over a lossy ELRS link (a one-shot request
        // made "Що залито в дрон" / verify fail intermittently over the backpack).
        let cm = null;
        const listDeadline = Date.now() + Math.max(stallMs, 8000);
        while (!cm && Date.now() < listDeadline) {
          this._send("MISSION_REQUEST_LIST", { target_system: ts, target_component: tc, mission_type: 0 });
          cm = await this._recv(["MISSION_COUNT"], 2000);
        }
        if (!cm) return { ok: false, error: "Дрон не повернув кількість пунктів." };
        const n = cm.fields.count;
        const items = {};
        let seq = 0, lastReq = 0, lastProgress = Date.now();
        const deadline = Date.now() + 600000;
        while (seq < n && Date.now() < deadline) {
          if (Date.now() - lastProgress > stallMs) break;
          if (Date.now() - lastReq > 1000) {
            // INAV has NO MISSION_REQUEST_INT handler — it only answers the legacy
            // MISSION_REQUEST (and replies with MISSION_ITEM). ArduPilot handles both.
            const reqT = (this._tlm.autopilot == null || this._tlm.autopilot === 3) ? "MISSION_REQUEST_INT" : "MISSION_REQUEST";
            this._send(reqT, { target_system: ts, target_component: tc, seq, mission_type: 0 }); lastReq = Date.now();
          }
          const im = await this._recv(["MISSION_ITEM_INT", "MISSION_ITEM"], 1000);
          if (!im || im.fields.seq !== seq) continue;
          lastProgress = Date.now();
          const fx = im.fields;
          const x = im.name === "MISSION_ITEM_INT" ? fx.x : Math.round(fx.x * 1e7);
          const y = im.name === "MISSION_ITEM_INT" ? fx.y : Math.round(fx.y * 1e7);
          items[seq] = { seq, command: fx.command, frame: fx.frame, x, y, z: fx.z };
          seq += 1; lastReq = 0;
        }
        this._send("MISSION_ACK", { target_system: ts, target_component: tc, type: 0, mission_type: 0 });
        const ordered = [];
        for (let i = 0; i < n; i++) if (items[i]) ordered.push(items[i]);
        if (ordered.length !== n) return { ok: false, error: `Зчитано ${ordered.length}/${n} пунктів (таймаут).` };
        return { ok: true, count: n, items: ordered };
      });
    }

    // ---- read-back verify (download + compare to what we meant to upload) ----
    async verifyMission(expected, timeout) {
      const dl = await this.downloadMission(timeout);
      if (!dl.ok) return { ok: false, verified: false, error: dl.error, count_expected: expected.length };
      const actual = dl.items;
      const mismatches = [];
      if (actual.length !== expected.length) mismatches.push(`кількість: очікувалось ${expected.length}, у дроні ${actual.length}`);
      const equiv = [new Set([3, 6]), new Set([0, 5])];
      for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
        const e = expected[i], a = actual[i];
        if (!e) { mismatches.push(`#${i}: зайвий пункт у дроні (cmd ${a.command})`); continue; }
        if (!a) { mismatches.push(`#${i}: пункт відсутній у дроні`); continue; }
        if (e.command !== a.command) { mismatches.push(`#${e.seq}: команда ${e.command}≠${a.command}`); continue; }
        if ((e.command === CMD_WAYPOINT || e.command === CMD_TAKEOFF) && e.seq !== 0) {
          const sameFrame = e.frame === a.frame || equiv.some((g) => g.has(e.frame) && g.has(a.frame));
          if (!sameFrame) { mismatches.push(`#${e.seq}: рамка висоти ${e.frame}≠${a.frame}`); continue; }
          const ex = Math.round(e.lat * 1e7), ey = Math.round(e.lon * 1e7);
          // Tolerance 100×1e-7° ≈ 1.1 m: when the vehicle asks for the v1 dialect
          // (MISSION_ITEM, float32 lat/lon — this ArduPilot does), float32 rounds
          // coordinates by up to ~0.5 m. The old 3-unit (3 cm!) gate flagged EVERY
          // waypoint of a perfectly-stored mission (field log 2026-07-13). 1 m is
          // spray-grade honest — real corruption is metres-to-kilometres off.
          if (Math.abs(ex - a.x) > 100 || Math.abs(ey - a.y) > 100) mismatches.push(`#${e.seq}: координати розійшлись`);
          else if (Math.abs(Number(e.alt) - Number(a.z)) > 1.0) mismatches.push(`#${e.seq}: висота ${e.alt}≠${Math.round(a.z * 10) / 10}`);
        }
      }
      const verified = actual.length === expected.length && mismatches.length === 0;
      return { ok: true, verified, count_expected: expected.length, count_actual: actual.length, mismatches: mismatches.slice(0, 10) };
    }

    // ---- flight commands ----
    async command(cmd, params, timeout) {
      if (!this._t) return { ok: false, error: "Немає звʼязку." };
      const p = (params || []).concat([0, 0, 0, 0, 0, 0, 0]).slice(0, 7);
      timeout = timeout || 8000;
      return this._withBusy(async () => {
        const { ts, tc } = this._targets();
        this._send("COMMAND_LONG", { target_system: ts, target_component: tc, command: cmd, confirmation: 0,
          param1: p[0], param2: p[1], param3: p[2], param4: p[3], param5: p[4], param6: p[5], param7: p[6] });
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          const ack = await this._recv(["COMMAND_ACK"], deadline - Date.now());
          if (!ack) break;
          if (ack.fields.command !== cmd) continue;
          if (ack.fields.result === 0) return { ok: true };
          return { ok: false, error: this._rejectCommand(ack.fields.result) };
        }
        return { ok: false, error: "Команда без відповіді (таймаут)." };
      });
    }

    arm(want, force) { return this.command(CMD_ARM_DISARM, [want ? 1 : 0, force ? 21196 : 0]); }
    setMode(name) {
      const num = ACM_MODES[(name || "").toUpperCase()];
      if (num === undefined) return Promise.resolve({ ok: false, error: "Невідомий режим: " + name });
      return this.command(CMD_DO_SET_MODE, [1, num]);
    }
    setMissionCurrent(seq, reset) { return this.command(CMD_DO_SET_MISSION_CURRENT, [seq, reset || 0]); }
    // Пауза БЕЗ виходу з AUTO: дрон зупиняється на треку, ТРИМАЄ висоту місії
    // і збережену швидкість. Продовження — рівно з того ж місця, без діагоналі
    // й без набору висоти (на відміну від виходу в LOITER і повернення в AUTO,
    // де ArduCopter летить прямою 3D-лінією до точки з поточної висоти).
    missionPause() { return this.command(CMD_PAUSE_CONTINUE, [0]); }
    missionContinue() { return this.command(CMD_PAUSE_CONTINUE, [1]); }
    async missionStart() {
      await this.setMissionCurrent(0, 1);
      return this.command(CMD_MISSION_START, [0, 0]);
    }

    // ---- param set (PARAM_SET → read-back PARAM_VALUE confirm) ----
    async setParam(name, value, timeout) {
      if (!this._t) return { ok: false, error: "Немає звʼязку." };
      timeout = timeout || 5000;
      return this._withBusy(async () => {
        const { ts } = this._targets();
        for (const comp of [this._tcomp || 1, 0]) {
          this._send("PARAM_SET", { target_system: ts, target_component: comp, param_id: name, param_value: value, param_type: 9 });
          this._send("PARAM_REQUEST_READ", { target_system: ts, target_component: comp, param_id: name, param_index: -1 });
          const deadline = Date.now() + timeout;
          while (Date.now() < deadline) {
            const m = await this._recv(["PARAM_VALUE"], deadline - Date.now());
            if (!m) break;
            const pid = (m.fields.param_id || "").replace(/ +$/, "");
            if (pid !== name) continue;
            if (Math.abs(Number(m.fields.param_value) - Number(value)) <= Math.max(1.0, Math.abs(value) * 0.01))
              return { ok: true, value: m.fields.param_value };
            return { ok: false, error: `Параметр ${name} не змінився (у дроні ${m.fields.param_value}).` };
          }
        }
        return { ok: false, error: "Параметр не підтверджено (таймаут)." };
      });
    }

    // ---- param read (PARAM_REQUEST_READ → PARAM_VALUE) ----
    // Needed by the automatic BT-UART activation: BEFORE overwriting a
    // SERIALx_PROTOCOL we must know what currently owns that UART (stealing a
    // GPS/RC UART would be far worse than a silent Bluetooth link).
    async getParam(name, timeout) {
      if (!this._t) return { ok: false, error: "Немає звʼязку." };
      timeout = timeout || 4000;
      return this._withBusy(async () => {
        const { ts } = this._targets();
        for (const comp of [this._tcomp || 1, 0]) {
          this._send("PARAM_REQUEST_READ", { target_system: ts, target_component: comp, param_id: name, param_index: -1 });
          const deadline = Date.now() + timeout;
          while (Date.now() < deadline) {
            const m = await this._recv(["PARAM_VALUE"], deadline - Date.now());
            if (!m) break;
            const pid = (m.fields.param_id || "").replace(/ +$/, "");
            if (pid !== name) continue;
            return { ok: true, value: Number(m.fields.param_value) };
          }
        }
        return { ok: false, error: "Параметр не прочитано (таймаут)." };
      });
    }
  }

  root.MAV_LINK = { MavLink, buildMissionItems, buildMissionItemsInav, humanize };
})(typeof globalThis !== "undefined" ? globalThis : this);
