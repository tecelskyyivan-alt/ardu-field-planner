#!/usr/bin/env node
/* BLE-transport headless simulation for the in-browser MAVLink GCS.
 *
 * BLE differs from the transports we already fly (USB serial, WiFi UDP) in two
 * ways that matter to the JS layer:
 *   1. bytes arrive in SMALL CHUNKS at ARBITRARY boundaries (a notification is
 *      ≤ MTU-3, worst case 20 bytes, and never aligned to MAVLink frames);
 *   2. the link is RELIABLE but SLOW-ish (link-layer ACKs, tens of ms latency) —
 *      unlike UDP there is no silent loss.
 * This sim proves the existing parser + mission-upload handshake survive both,
 * with zero hardware: A) adversarial re-chunking of a real encoded byte stream,
 * B) a full uploadMission() against a simulated ArduPilot FC behind a BLE-like
 * chunked+latent pipe, C) the openAndroidBle() transport contract against a
 * mocked window.AndroidBle bridge.
 *
 * Run:  node tests/ble_sim.js   (exit 0 = all green)
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const WEB = path.join(__dirname, "..", "web-stable");
function load(rel) {
  vm.runInThisContext(fs.readFileSync(path.join(WEB, rel), "utf8"), { filename: rel });
}
load("mav/mavlink.js");
load("mav/link.js");
load("mav/transport.js");
MAVLINK.setSpecs(JSON.parse(fs.readFileSync(path.join(WEB, "mav", "specs.json"), "utf8")));

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log("  ok  " + name); }
  else { failures++; console.error("  FAIL " + name + (detail ? " — " + detail : "")); }
}

/* ------------------------------------------------------------------ Test A --
 * Fragmentation: one encoded stream, many chunkings — identical parse result. */
(function testFragmentation() {
  console.log("A. фрагментація на довільних межах");
  const frames = [];
  const FC = { sys: 1, comp: 1 };
  let seq = 0;
  const push = (name, fields) => frames.push(MAVLINK.encode(name, fields, { sys: FC.sys, comp: FC.comp, seq: seq++ & 0xff }));
  for (let i = 0; i < 30; i++) {
    push("HEARTBEAT", { type: 2, autopilot: 3, base_mode: 81, custom_mode: 0, system_status: 3, mavlink_version: 3 });
    push("GLOBAL_POSITION_INT", { time_boot_ms: i * 100, lat: 504500000 + i, lon: 305500000 - i, alt: 120000, relative_alt: 50000, vx: 1, vy: 2, vz: 3, hdg: 9000 });
    push("VFR_HUD", { airspeed: 5.5, groundspeed: 6.25, heading: 90, throttle: 42, alt: 120.5, climb: -0.5 });
    push("MISSION_REQUEST_INT", { target_system: 255, target_component: 190, seq: i, mission_type: 0 });
  }
  const stream = Buffer.concat(frames.map((f) => Buffer.from(f)));
  const expected = frames.length;

  const chunkings = { "1B": 1, "3B": 3, "7B": 7, "20B (BLE MTU23)": 20, "244B (BLE MTU247)": 244 };
  for (const [label, size] of Object.entries(chunkings)) {
    const p = MAVLINK.createParser();
    let got = 0;
    for (let off = 0; off < stream.length; off += size)
      got += p.push(new Uint8Array(stream.subarray(off, Math.min(off + size, stream.length)))).length;
    check(`chunk ${label}: ${got}/${expected}`, got === expected);
  }
  // pseudo-random chunk sizes (deterministic LCG so the run is reproducible)
  let s = 12345;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) % 20 + 1;
  const p = MAVLINK.createParser();
  let got = 0, fields = null;
  for (let off = 0; off < stream.length;) {
    const size = rnd();
    const msgs = p.push(new Uint8Array(stream.subarray(off, Math.min(off + size, stream.length))));
    got += msgs.length;
    for (const m of msgs) if (m.name === "GLOBAL_POSITION_INT" && fields === null) fields = m.fields;
    off += size;
  }
  check(`chunk random(1..20): ${got}/${expected}`, got === expected);
  check("поля не спотворені (lat першого GLOBAL_POSITION_INT)", fields && fields.lat === 504500000);
})();

/* ------------------------------------------------------------------ Test B --
 * Full uploadMission() over a BLE-like pipe against a simulated ArduPilot FC:
 * every FC→GCS frame is split into ≤20-byte notifications delivered with jitter;
 * the link never loses bytes (BLE link-layer ACKs) — reliable but chunked+slow. */
async function testUpload() {
  console.log("B. заливка місії через BLE-подібний канал (чанки ≤20Б + затримка)");
  let s = 424242;
  const rnd = (n) => (s = (s * 1103515245 + 12345) & 0x7fffffff) % n;

  const fcParser = MAVLINK.createParser();
  let fcSeq = 0;
  const received = new Map();          // seq -> MISSION_ITEM_INT fields
  let missionCount = -1;
  let sendAckAfter = -1;

  const t = {
    ondata: null,
    _closed: false,
    write(bytes) { for (const m of fcParser.push(bytes)) fcHandle(m); },
    close() { this._closed = true; },
  };
  // FC → GCS: encode, split into ≤20-byte chunks, deliver each with 5-25 ms jitter.
  function fcSend(name, fields) {
    const frame = MAVLINK.encode(name, fields, { sys: 1, comp: 1, seq: fcSeq++ & 0xff });
    for (let off = 0; off < frame.length; off += 20) {
      const chunk = frame.slice(off, Math.min(off + 20, frame.length));
      const delay = 5 + rnd(20) + off; // off keeps chunk order (BLE preserves ordering)
      setTimeout(() => { if (t.ondata && !t._closed) t.ondata(chunk); }, delay);
    }
  }
  function fcHandle(m) {
    if (m.name === "MISSION_COUNT") {
      missionCount = m.fields.count;
      received.clear();
      fcSend("MISSION_REQUEST_INT", { target_system: 255, target_component: 190, seq: 0, mission_type: 0 });
    } else if (m.name === "MISSION_ITEM_INT") {
      received.set(m.fields.seq, m.fields);
      const next = m.fields.seq + 1;
      if (next < missionCount)
        fcSend("MISSION_REQUEST_INT", { target_system: 255, target_component: 190, seq: next, mission_type: 0 });
      else
        fcSend("MISSION_ACK", { target_system: 255, target_component: 190, type: 0, mission_type: 0 });
    }
    // COMMAND_LONG (stream pause) needs no reply for this test.
  }
  const hbTimer = setInterval(() => fcSend("HEARTBEAT", { type: 2, autopilot: 3, base_mode: 81, custom_mode: 0, system_status: 4, mavlink_version: 3 }), 700);

  const link = new MAV_LINK.MavLink();
  const conn = await link.connect(t);
  check("connect ok + heartbeat прийнято", conn.ok && !conn.warning, JSON.stringify(conn));

  // A realistic field mission: home + takeoff + 38 waypoints + RTL.
  const wps = [];
  for (let i = 0; i < 38; i++) wps.push([50.45 + i * 0.0005, 30.55 + (i % 2) * 0.002]);
  const items = MAV_LINK.buildMissionItems([50.45, 30.55, 0], 30, wps, 12, true, 7);
  const t0 = Date.now();
  const res = await link.uploadMission(items);
  const dt = Date.now() - t0;
  check(`uploadMission ok (${items.length} елементів за ${dt} мс)`, !!res.ok, res.error);
  check("FC отримав усі елементи", received.size === items.length, `${received.size}/${items.length}`);
  const it7 = received.get(7), src7 = items[7];
  check("координати не спотворені (item 7, ×1e7)",
    it7 && it7.x === Math.round(src7.lat * 1e7) && it7.y === Math.round(src7.lon * 1e7));
  clearInterval(hbTimer);
  link.disconnect();
}

/* ------------------------------------------------------------------ Test C --
 * openAndroidBle() transport contract against a mocked native bridge. */
async function testOpenAndroidBle() {
  console.log("C. openAndroidBle: контракт транспорту через мок AndroidBle");
  global.window = global;             // transport.js addresses the bridge as window.*
  const written = [];
  global.AndroidBle = {
    connect(addr) {
      check("connect отримує адресу як рядок", addr === "AA:BB:CC:DD:EE:FF");
      setTimeout(() => { if (window.__androidBleEvent) window.__androidBleEvent("open", true, ""); }, 10);
      return JSON.stringify({ ok: true, pending: true });
    },
    write(b64) { written.push(Buffer.from(b64, "base64")); },
    close() { this.closed = true; },
  };
  const t = await MAV_TRANSPORT.openAndroidBle("AA:BB:CC:DD:EE:FF");
  check("транспорт має форму {write, close, ondata}", typeof t.write === "function" && typeof t.close === "function" && "ondata" in t);
  const probe = new Uint8Array([0xfd, 1, 2, 3, 254, 255]);
  t.write(probe);
  check("write → base64 → байти без спотворень", written.length === 1 && Buffer.compare(written[0], Buffer.from(probe)) === 0);
  let got = null;
  t.ondata = (b) => { got = b; };
  window.__androidBleData(Buffer.from([9, 8, 7]).toString("base64"));
  check("вхідні b64 → Uint8Array", got && got.length === 3 && got[0] === 9 && got[2] === 7);
  t.close();
  check("close знімає обробник __androidBleData", window.__androidBleData === null);
  check("close закриває нативний міст", global.AndroidBle.closed === true);
  // failure path: native refuses
  global.AndroidBle.connect = () => JSON.stringify({ ok: false, error: "Bluetooth вимкнено" });
  let err = null;
  try { await MAV_TRANSPORT.openAndroidBle("AA:BB:CC:DD:EE:FF"); } catch (e) { err = e; }
  check("відмова нативного мосту → reject з помилкою", !!err && /Bluetooth/.test(err.message));
}

(async () => {
  await testUpload();
  await testOpenAndroidBle();
  console.log(failures === 0 ? "\nУСІ BLE-СИМУЛЯЦІЇ ЗЕЛЕНІ" : `\nПРОВАЛІВ: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
})();
