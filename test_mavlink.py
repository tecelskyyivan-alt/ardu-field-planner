"""Offline MAVLink test — a fake ArduPilot vehicle over UDP loopback.

No hardware/SITL needed: a background thread acts as the vehicle (streams
heartbeat/GPS/battery and drives the mission-download handshake), while our
MavLink manager connects as the GCS, reads telemetry, and uploads a mission.
This exercises the REAL pymavlink message framing + mission protocol that the
app uses to talk to a drone over cable or radio.
"""
import sys
import threading
import time

from backend.mavlink_link import MavLink, build_mission_items


def check(name, cond):
    print(("  OK  " if cond else " FAIL ") + name)
    if not cond:
        check.failed = True


check.failed = False

# ---- build_mission_items (pure) -----------------------------------------
print("== mission item builder ==")
home = (49.5, 24.0, 0.0)
wps = [(49.501, 24.001), (49.502, 24.002), (49.503, 24.003)]
items = build_mission_items(home, 10.0, wps, 50.0, rtl=True)
check("count = home + takeoff + N + rtl", len(items) == 1 + 1 + len(wps) + 1)
check("seq is 0..n-1", [it["seq"] for it in items] == list(range(len(items))))
check("WP0 is home, absolute frame, current=1",
      items[0]["frame"] == 0 and items[0]["command"] == 16 and items[0]["current"] == 1)
check("item1 is NAV_TAKEOFF rel-alt", items[1]["command"] == 22 and items[1]["frame"] == 3)
check("takeoff alt carried", items[1]["alt"] == 10.0)
check("waypoints are NAV_WAYPOINT rel-alt @ wp_alt",
      all(it["command"] == 16 and it["frame"] == 3 and it["alt"] == 50.0 for it in items[2:2 + len(wps)]))
check("last item is RTL", items[-1]["command"] == 20)
no_rtl = build_mission_items(home, 10.0, wps, 50.0, rtl=False)
check("rtl=False drops the RTL item", len(no_rtl) == len(items) - 1)


# ---- fake vehicle over UDP loopback -------------------------------------
PORT = 14577
received_items = []
stored_mission = []   # full items the vehicle holds, echoed back on download
gcs_heartbeats = []   # HEARTBEATs the vehicle hears FROM our GCS link (ELRS bridges need these)
stream_reqs = []      # SET_MESSAGE_INTERVAL (511) message ids the GCS asked us to stream


def fake_vehicle(stop):
    from pymavlink import mavutil
    veh = mavutil.mavlink_connection(f"udpout:127.0.0.1:{PORT}", source_system=1,
                                     source_component=1)
    last_hb = 0.0
    while not stop.is_set():
        now = time.time()
        if now - last_hb >= 0.2:
            last_hb = now
            veh.mav.heartbeat_send(
                mavutil.mavlink.MAV_TYPE_QUADROTOR,
                mavutil.mavlink.MAV_AUTOPILOT_ARDUPILOTMEGA,
                0, 0, mavutil.mavlink.MAV_STATE_STANDBY)
            veh.mav.global_position_int_send(
                int(now * 1000) & 0xFFFFFFFF, int(49.49 * 1e7), int(24.01 * 1e7),
                100000, 50000, 0, 0, 0, 27000)   # hdg=270.00
            veh.mav.gps_raw_int_send(
                int(now * 1e6) & 0xFFFFFFFF, 3, int(49.49 * 1e7), int(24.01 * 1e7),
                100000, 65535, 65535, 65535, 65535, 11)   # fix=3, 11 sats
            veh.mav.sys_status_send(0, 0, 0, 500, 22400, -1, 78, 0, 0, 0, 0, 0, 0)
            veh.mav.vfr_hud_send(9.0, 8.5, 270, 50, 50.0, 0.0)   # groundspeed 8.5
        m = veh.recv_match(blocking=True, timeout=0.05)
        if m is None:
            continue
        mt = m.get_type()
        sysid, compid = m.get_srcSystem(), m.get_srcComponent()
        if mt == "HEARTBEAT" and m.type == mavutil.mavlink.MAV_TYPE_GCS:
            gcs_heartbeats.append(sysid)   # our link announcing itself as a GCS
        elif mt == "MISSION_COUNT":
            # GCS is UPLOADING: request each item, store it.
            count = m.count
            received_items.clear()
            stored_mission.clear()
            for seq in range(count):
                veh.mav.mission_request_int_send(sysid, compid, seq, 0)
                got = None
                t0 = time.time()
                while time.time() - t0 < 3.0:
                    im = veh.recv_match(type=["MISSION_ITEM_INT"], blocking=True, timeout=0.5)
                    if im is not None and im.seq == seq:
                        got = im
                        break
                if got is None:
                    break
                received_items.append((got.seq, got.command, got.x, got.y, got.z))
                stored_mission.append({
                    "seq": got.seq, "frame": got.frame, "command": got.command,
                    "current": got.current, "autocontinue": got.autocontinue,
                    "p1": got.param1, "p2": got.param2, "p3": got.param3, "p4": got.param4,
                    "x": got.x, "y": got.y, "z": got.z,
                })
            veh.mav.mission_ack_send(sysid, compid, mavutil.mavlink.MAV_MISSION_ACCEPTED, 0)
        elif mt == "MISSION_REQUEST_LIST":
            # GCS is DOWNLOADING: send count, then each stored item on request.
            veh.mav.mission_count_send(sysid, compid, len(stored_mission), 0)
            t0 = time.time()
            while time.time() - t0 < 5.0:
                rq = veh.recv_match(type=["MISSION_REQUEST_INT", "MISSION_REQUEST", "MISSION_ACK"],
                                    blocking=True, timeout=0.5)
                if rq is None:
                    continue
                if rq.get_type() == "MISSION_ACK":
                    break
                seq = rq.seq
                if 0 <= seq < len(stored_mission):
                    it = stored_mission[seq]
                    veh.mav.mission_item_int_send(
                        sysid, compid, it["seq"], it["frame"], it["command"],
                        it["current"], it["autocontinue"],
                        it["p1"], it["p2"], it["p3"], it["p4"],
                        it["x"], it["y"], it["z"], 0)
        elif mt == "COMMAND_LONG":
            if m.command == 511:           # MAV_CMD_SET_MESSAGE_INTERVAL
                stream_reqs.append(int(m.param1))
            # Accept every command (arm/mode/start) with MAV_RESULT_ACCEPTED.
            veh.mav.command_ack_send(m.command, 0)
    try:
        veh.close()
    except Exception:
        pass


print("\n== live link: connect + telemetry ==")
stop = threading.Event()
vt = threading.Thread(target=fake_vehicle, args=(stop,), daemon=True)
vt.start()

link = MavLink()
res = link.connect(f"udpin:127.0.0.1:{PORT}", baud=57600)
check("connect ok", res.get("ok"))
# Give the streams a moment to populate the snapshot.
time.sleep(1.5)
tl = link.status()
check("connected / heartbeat seen", tl["connected"] is True)
check("our link sends a GCS heartbeat (ELRS bridges rely on it)", len(gcs_heartbeats) > 0)
check("our link requests telemetry via SET_MESSAGE_INTERVAL (GPS streams over ELRS)",
      33 in stream_reqs and 24 in stream_reqs)
check("flight mode parsed", tl["mode"] is not None)
check("armed flag read (disarmed)", tl["armed"] is False)
check("GPS position parsed", tl["lat"] is not None and abs(tl["lat"] - 49.49) < 1e-3)
check("sats parsed", tl["sats"] == 11)
check("fix type parsed", tl["fix_type"] == 3)
check("battery voltage parsed (~22.4V)", tl["battery_v"] is not None and abs(tl["battery_v"] - 22.4) < 0.1)
check("battery pct parsed", tl["battery_pct"] == 78)
check("heading value parsed (270.0)", tl["heading"] == 270.0)
check("groundspeed parsed from VFR_HUD (8.5)", tl["groundspeed"] == 8.5)
check("mode is a non-empty string", isinstance(tl["mode"], str) and len(tl["mode"]) > 0)

print("\n== live link: mission upload handshake ==")
up = link.upload_mission(items, timeout=15.0)
check("upload ok", up.get("ok"))
check("upload reports correct count", up.get("count") == len(items))
check("vehicle received all items", len(received_items) == len(items))
if received_items:
    # Spot-check a waypoint round-trips lat/lon as int32 deg*1e7.
    seq2 = next((r for r in received_items if r[0] == 2), None)
    check("waypoint lat round-trips (deg*1e7)",
          seq2 is not None and abs(seq2[2] - int(round(49.501 * 1e7))) <= 1)
    check("waypoint command preserved", seq2 is not None and seq2[1] == 16)

print("\n== live link: mission download (read-back) ==")
dl = link.download_mission(timeout=15.0)
check("download ok", dl.get("ok"))
check("download count matches upload", dl.get("count") == len(items))
if dl.get("items"):
    di = dl["items"]
    check("downloaded count == items", len(di) == len(items))
    check("downloaded seqs ordered 0..n-1", [d["seq"] for d in di] == list(range(len(di))))
    d2 = next((d for d in di if d["seq"] == 2), None)
    check("downloaded waypoint lat round-trips",
          d2 is not None and abs(d2["x"] - int(round(49.501 * 1e7))) <= 3)
    check("downloaded waypoint command preserved", d2 is not None and d2["command"] == 16)

print("\n== live link: verify (upload confirmation) ==")
v = link.verify_mission(items, timeout=15.0)
check("verify ok", v.get("ok"))
check("verify reports VERIFIED (mission matches)", v.get("verified") is True)
check("verify no mismatches", v.get("mismatches") == [])
check("verify counts agree", v.get("count_expected") == v.get("count_actual") == len(items))

print("\n== verify catches a mismatch ==")
# Compare the stored mission against a DIFFERENT expected route -> not verified.
other = build_mission_items((49.5, 24.0, 0.0),
                            10.0, [(49.9, 24.9)], 50.0, rtl=True)  # fewer/diff wps
vbad = link.verify_mission(other, timeout=15.0)
check("verify ok (ran)", vbad.get("ok"))
check("verify flags MISMATCH", vbad.get("verified") is False)
check("verify lists what differs", len(vbad.get("mismatches", [])) > 0)

print("\n== verify catches a SAME-COUNT per-item difference ==")
# Same number of items, but one waypoint moved -> must flag a coordinate diff,
# NOT a count mismatch (exercises the per-item comparator, not zip-truncation).
same_count = build_mission_items((49.5, 24.0, 0.0),
                                 10.0, [(49.501, 24.001), (49.502, 24.002), (49.9, 24.9)],
                                 50.0, rtl=True)
vsc = link.verify_mission(same_count, timeout=15.0)
check("same-count verify ran", vsc.get("ok"))
check("same-count counts equal", vsc.get("count_expected") == vsc.get("count_actual"))
check("same-count flagged NOT verified", vsc.get("verified") is False)
_ms = " ".join(vsc.get("mismatches", []))
check("flagged a per-item coord diff (not a count diff)",
      "координати" in _ms and "кількість" not in _ms)

print("\n== live link: flight commands (arm / mode / start) ==")
ra = link.arm(True)
check("arm accepted", ra.get("ok"))
rd = link.arm(False)
check("disarm accepted", rd.get("ok"))
rm = link.set_mode("AUTO")
check("set_mode AUTO accepted", rm.get("ok"))
check("unknown mode rejected locally", link.set_mode("NOPE").get("ok") is False)
rs = link.mission_start()
check("mission_start accepted", rs.get("ok"))

link.disconnect()
stop.set()
vt.join(timeout=2.0)
check("disconnect clears state", link.status()["connected"] is False)


# ---- configurable edge-case vehicle -------------------------------------
# A second fake vehicle whose behaviour is driven by `opts`, to exercise the
# rejection / soft-success / float-item / partial-download branches.
def edge_vehicle(stop, port, opts):
    from pymavlink import mavutil
    veh = mavutil.mavlink_connection(f"udpout:127.0.0.1:{port}", source_system=1,
                                     source_component=1)
    store = []
    last_hb = 0.0
    while not stop.is_set():
        now = time.time()
        if now - last_hb >= 0.2:
            last_hb = now
            veh.mav.heartbeat_send(mavutil.mavlink.MAV_TYPE_QUADROTOR,
                                   mavutil.mavlink.MAV_AUTOPILOT_ARDUPILOTMEGA,
                                   0, 0, mavutil.mavlink.MAV_STATE_STANDBY)
        m = veh.recv_match(blocking=True, timeout=0.05)
        if m is None:
            continue
        mt = m.get_type()
        sysid, compid = m.get_srcSystem(), m.get_srcComponent()
        if mt == "MISSION_COUNT":
            if opts.get("reject"):
                veh.mav.mission_ack_send(sysid, compid, 13, 0)   # 13 = MAV_MISSION_ERROR
                continue
            store = []
            for seq in range(m.count):
                veh.mav.mission_request_int_send(sysid, compid, seq, 0)
                t0 = time.time()
                while time.time() - t0 < 3.0:
                    im = veh.recv_match(type=["MISSION_ITEM_INT"], blocking=True, timeout=0.5)
                    if im is not None and im.seq == seq:
                        store.append({"seq": im.seq, "frame": im.frame, "command": im.command,
                                      "current": im.current, "autocontinue": im.autocontinue,
                                      "p1": im.param1, "p2": im.param2, "p3": im.param3, "p4": im.param4,
                                      "x": im.x, "y": im.y, "z": im.z})
                        break
            if not opts.get("withhold_ack"):
                veh.mav.mission_ack_send(sysid, compid, mavutil.mavlink.MAV_MISSION_ACCEPTED, 0)
        elif mt == "MISSION_REQUEST_LIST":
            claimed = len(store)
            veh.mav.mission_count_send(sysid, compid, claimed, 0)
            serve = claimed - 1 if opts.get("partial") else claimed
            t0 = time.time()
            while time.time() - t0 < 4.0:
                rq = veh.recv_match(type=["MISSION_REQUEST_INT", "MISSION_REQUEST", "MISSION_ACK"],
                                    blocking=True, timeout=0.5)
                if rq is None:
                    continue
                if rq.get_type() == "MISSION_ACK":
                    break
                seq = rq.seq
                if seq >= serve or seq >= len(store):
                    continue                       # withhold the last item (partial)
                it = store[seq]
                if opts.get("float_items"):
                    # Legacy float MISSION_ITEM: x/y carry DEGREES, not deg*1e7.
                    veh.mav.mission_item_send(
                        sysid, compid, it["seq"], it["frame"], it["command"],
                        it["current"], it["autocontinue"],
                        it["p1"], it["p2"], it["p3"], it["p4"],
                        it["x"] / 1e7, it["y"] / 1e7, it["z"], 0)
                else:
                    veh.mav.mission_item_int_send(
                        sysid, compid, it["seq"], it["frame"], it["command"],
                        it["current"], it["autocontinue"],
                        it["p1"], it["p2"], it["p3"], it["p4"],
                        it["x"], it["y"], it["z"], 0)
        elif mt == "COMMAND_LONG":
            veh.mav.command_ack_send(m.command, opts.get("cmd_result", 0))
    try:
        veh.close()
    except Exception:
        pass


def run_edge(name, port, opts):
    st = threading.Event()
    th = threading.Thread(target=edge_vehicle, args=(st, port, opts), daemon=True)
    th.start()
    lk = MavLink()
    r = lk.connect(f"udpin:127.0.0.1:{port}")
    if not r.get("ok"):
        check(f"[{name}] connect", False)
        st.set(); th.join(timeout=2.0)
        return None, lk, st, th
    time.sleep(0.6)
    return lk, lk, st, th


print("\n== edge: vehicle REJECTS the mission (non-zero ACK) ==")
lk, _, st, th = run_edge("reject", 14578, {"reject": True})
if lk:
    up = lk.upload_mission(items, timeout=8.0)
    check("rejected upload -> ok False", up.get("ok") is False)
    check("rejection surfaces a plain-language reason",
          "місію" in (up.get("error") or "") and len(up.get("error") or "") > 12)
    lk.disconnect(); st.set(); th.join(timeout=2.0)

print("\n== edge: SOFT success (all sent, no final ACK) ==")
lk, _, st, th = run_edge("soft", 14579, {"withhold_ack": True})
if lk:
    up = lk.upload_mission(items, timeout=12.0)
    check("soft-success upload -> ok True", up.get("ok") is True)
    check("soft-success carries a warning", bool(up.get("warning")))
    check("wp_total NOT set on soft success", lk.status().get("wp_total") is None)
    lk.disconnect(); st.set(); th.join(timeout=2.0)

print("\n== edge: legacy float MISSION_ITEM download scales to deg*1e7 ==")
lk, _, st, th = run_edge("float", 14580, {"float_items": True})
if lk:
    up = lk.upload_mission(items, timeout=10.0)   # store the mission first
    check("float-case upload ok", up.get("ok"))
    dl = lk.download_mission(timeout=12.0)
    check("float download ok", dl.get("ok"))
    if dl.get("items"):
        d2 = next((d for d in dl["items"] if d["seq"] == 2), None)
        # Despite arriving as float degrees, x must be stored as deg*1e7 int.
        check("float item stored as deg*1e7 int",
              d2 is not None and abs(d2["x"] - int(round(49.501 * 1e7))) <= 5)
    lk.disconnect(); st.set(); th.join(timeout=2.0)

print("\n== edge: PARTIAL download (count N, only N-1 served) -> error ==")
lk, _, st, th = run_edge("partial", 14581, {"partial": True})
if lk:
    up = lk.upload_mission(items, timeout=10.0)
    check("partial-case upload ok", up.get("ok"))
    dl = lk.download_mission(timeout=8.0)
    check("partial download -> ok False", dl.get("ok") is False)
    check("partial download reports shortfall", "Зчитано" in (dl.get("error") or ""))
    lk.disconnect(); st.set(); th.join(timeout=2.0)

print("\n== edge: vehicle REJECTS a command (non-zero result) ==")
lk, _, st, th = run_edge("cmdreject", 14582, {"cmd_result": 4})   # 4 = FAILED
if lk:
    rc = lk.arm(True)
    check("rejected command -> ok False", rc.get("ok") is False)
    check("rejection surfaces the result code", "відхилив" in (rc.get("error") or ""))
    lk.disconnect(); st.set(); th.join(timeout=2.0)

print()
if check.failed:
    print("RESULT: FAILURES PRESENT")
    sys.exit(1)
print("RESULT: ALL CHECKS PASSED")
