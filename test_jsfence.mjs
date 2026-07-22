/* Headless regression for the opt-in ArduPilot GEOFENCE upload (#12p3), over the
 * SAME loopback machinery as test_jsmav.mjs — a fake vehicle talking to the real
 * web-stable/mav/link.js uploadMission(), just with mission_type=1 (FENCE).
 *
 * Run:  node test_jsfence.mjs   (needs Node 18+; no browser, no hardware)
 *
 * SITL e2e against real ArduCopter 4.6.3 found that ArduPilot answers a type-1
 * MISSION_COUNT with plain MISSION_REQUEST (NOT _INT) inside a v2 frame, mission_type=1
 * set correctly — the SAME dual-dialect behaviour the type-0 mission path already
 * handles (link.js's sendItem picks MISSION_ITEM vs MISSION_ITEM_INT off the request's
 * message NAME, regardless of mission_type). The original v1-abort check here keyed off
 * that same message name ("MISSION_REQUEST" == legacy), which misclassified ArduPilot's
 * real fence traffic as unsupported firmware and aborted every real upload. Fixed: the
 * abort now keys off the FRAME being true MAVLink1 (STX 0xFE, decoded `m.v2 === false`)
 * — the only wire format that physically cannot carry mission_type at all.
 *
 * Covers:
 *   (a) INT dialect happy path — type-1 COUNT -> type-1 REQUEST_INTs -> ACK: every fence
 *       item arrives with mission_type=1, the right cmd (5001/5002), param1 = that
 *       polygon's OWN vertex count, coords scaled ×1e7.
 *   (b) ArduPilot dialect happy path (the SITL-found case) — type-1 COUNT -> plain v2
 *       MISSION_REQUESTs (mission_type=1) -> ACK: answered with float MISSION_ITEMs,
 *       mission_type=1, same cmd/param1, coords as float32 degrees (~0.5 m resolution
 *       at 49.5° — plenty for a fence with metre-scale margins).
 *   (c) cross-type isolation — a stray type-0 request, in EITHER message form
 *       (MISSION_REQUEST_INT and plain MISSION_REQUEST), interleaved mid-transaction,
 *       must NOT be answered with a fence item.
 *   (d) true v1-frame (STX 0xFE) vehicle — physically cannot carry mission_type — must
 *       abort cleanly, never send a fence item.
 * Also re-run `node test_jsmav.mjs` alongside this — the type-0 (mission) path must
 * stay green (uploadMission's default missionType=0 keeps every existing call
 * byte-identical).
 */
import fs from "fs";
import vm from "vm";
import { fileURLToPath } from "url";
import path from "path";

const MAVDIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "web-stable", "mav");
vm.runInThisContext(fs.readFileSync(path.join(MAVDIR, "mavlink.js"), "utf8"));
vm.runInThisContext(fs.readFileSync(path.join(MAVDIR, "link.js"), "utf8"));
const { MAVLINK, MAV_LINK } = globalThis;
const specsRaw = JSON.parse(fs.readFileSync(path.join(MAVDIR, "specs.json"), "utf8"));
MAVLINK.setSpecs(specsRaw);
const specByName = {};
for (const k of Object.keys(specsRaw)) specByName[specsRaw[k].name] = specsRaw[k];

let failed = 0;
const check = (name, cond) => { console.log((cond ? "  OK  " : " FAIL ") + name); if (!cond) failed++; };

const CMD_INCLUSION = 5001, CMD_EXCLUSION = 5002;

// A square field + one triangular cut-out — enough to prove both cmd ids and
// per-polygon vertex counts (param1) are independently correct.
const boundary = [
  { lat: 49.50, lng: 24.00 },
  { lat: 49.50, lng: 24.01 },
  { lat: 49.51, lng: 24.01 },
  { lat: 49.51, lng: 24.00 },
];
const exclusion = [
  { lat: 49.503, lng: 24.003 },
  { lat: 49.503, lng: 24.006 },
  { lat: 49.506, lng: 24.004 },
];

// ---- unit-level: buildFenceItems geometry (no vehicle needed) --------------
console.log("== buildFenceItems: geometry ==");
{
  const items = MAV_LINK.buildFenceItems(boundary, [exclusion]);
  check("total item count (4 boundary + 3 exclusion)", items.length === 7);
  check("first 4 are INCLUSION (5001)", items.slice(0, 4).every((it) => it.command === CMD_INCLUSION));
  check("first 4 carry param1=4 (boundary's own vertex count)", items.slice(0, 4).every((it) => it.p1 === 4));
  check("last 3 are EXCLUSION (5002)", items.slice(4).every((it) => it.command === CMD_EXCLUSION));
  check("last 3 carry param1=3 (exclusion's own vertex count)", items.slice(4).every((it) => it.p1 === 3));
  check("seq runs 0..6", items.every((it, i) => it.seq === i));
  check("frame is MAV_FRAME_GLOBAL (0)", items.every((it) => it.frame === 0));
  check("autocontinue=0, current=0", items.every((it) => it.autocontinue === 0 && it.current === 0));

  // Closing duplicate vertex (first === last) must be dropped, not counted as a real vertex.
  const closed = boundary.concat([boundary[0]]);
  const itemsClosed = MAV_LINK.buildFenceItems(closed, []);
  check("closing duplicate vertex dropped (still 4, not 5)", itemsClosed.length === 4);

  // A degenerate boundary (<3 real vertices) must yield an EMPTY item list. This is the
  // exact signal app.js's guard uses to skip the fence upload entirely (an empty upload
  // would send COUNT=0/type=1, which CLEARS any fence already stored on the vehicle) —
  // the guard itself is a plain `if (!fenceItems.length)` in app.js, so this geometry-level
  // check is the cheap equivalent of "uploadMission is never called for a degenerate boundary".
  const degenerate = [{ lat: 49.50, lng: 24.00 }, { lat: 49.50, lng: 24.01 }];
  check("degenerate (<3 vertex) boundary yields an empty item list", MAV_LINK.buildFenceItems(degenerate, []).length === 0);
  check("a degenerate EXCLUSION alone (valid boundary) still yields only the boundary's items",
    MAV_LINK.buildFenceItems(boundary, [degenerate]).length === 4);
}

// Hand-roll a genuine MAVLink1 frame (STX 0xFE) for the "true v1 vehicle" scenario.
// MAVLINK.encode() only ever produces v2 — but a real v1 frame is exactly the
// "unsupported firmware" case the abort must key on. v1's MISSION_REQUEST payload is
// JUST seq/target_system/target_component (4 bytes); mission_type does not exist on
// the wire at all, which is the whole point of the test.
function encodeV1MissionRequest(seq, frameSeqNum) {
  const spec = specByName.MISSION_REQUEST;
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint16(0, seq, true);
  payload[2] = 255; payload[3] = 0;   // target_system, target_component
  const sysid = 1, compid = 1;
  const head = [payload.length, frameSeqNum & 0xff, sysid, compid, spec.id];
  const crcInput = new Uint8Array(head.length + payload.length);
  crcInput.set(head, 0); crcInput.set(payload, head.length);
  const crc = MAVLINK.crc16(crcInput, spec.crc_extra);
  const frame = new Uint8Array(1 + head.length + payload.length + 2);
  frame[0] = 0xfe;
  frame.set(head, 1);
  frame.set(payload, 1 + head.length);
  frame[1 + head.length + payload.length] = crc & 0xff;
  frame[1 + head.length + payload.length + 1] = (crc >> 8) & 0xff;
  return frame;
}

// ---- fake vehicle over a loopback transport, FENCE-aware -------------------
// opts.dialect:        "int" (default, MISSION_REQUEST_INT/MISSION_ITEM_INT) or
//                       "ardupilot" (plain v2 MISSION_REQUEST/MISSION_ITEM, mission_type
//                       set correctly — the real ArduCopter 4.6.3 SITL-observed dialect)
// opts.strayCrossType: before EACH real request, also send a stray type-0 request in
//                      BOTH message forms (REQUEST_INT and plain REQUEST) — cross-
//                      transaction noise that must never be answered with a fence item
// opts.trueV1Abort:    answer the fence COUNT with a genuine MAVLink1 (0xFE) frame —
//                      physically cannot carry mission_type; must abort cleanly
function makeFenceVehicle(opts = {}) {
  const veh = MAVLINK.createParser();
  const t = { ondata: null, close() {}, received: [], itemSeqCounts: {} };
  const send = (name, fields) => { const b = MAVLINK.encode(name, fields, { sys: 1, comp: 1, seq: 0 }); if (t.ondata) t.ondata(b); };
  let n = 0, frameSeq = 0;
  const reqInt = (seq, mtype) => send("MISSION_REQUEST_INT", { target_system: 255, target_component: 0, seq, mission_type: mtype });
  const reqPlain = (seq, mtype) => send("MISSION_REQUEST", { target_system: 255, target_component: 0, seq, mission_type: mtype });
  const askNext = (seq) => {
    if (opts.strayCrossType) { reqInt(seq, 0); reqPlain(seq, 0); }   // cross-transaction noise, must be ignored
    if (opts.dialect === "ardupilot") reqPlain(seq, 1); else reqInt(seq, 1);
  };
  t.write = (bytes) => {
    for (const m of veh.push(bytes)) {
      if (m.name === "MISSION_COUNT") {
        if (m.fields.mission_type !== 1) continue;    // not the fence list — ignore (mirrors a real FC)
        n = m.fields.count;
        if (opts.trueV1Abort) { t.ondata(encodeV1MissionRequest(0, frameSeq++)); continue; }
        askNext(0);
      } else if (m.name === "MISSION_ITEM_INT" || m.name === "MISSION_ITEM") {
        const seq = m.fields.seq;
        t.received.push({ form: m.name, fields: Object.assign({}, m.fields) });
        t.itemSeqCounts[seq] = (t.itemSeqCounts[seq] || 0) + 1;
        if (seq + 1 < n) askNext(seq + 1);
        else send("MISSION_ACK", { target_system: 255, target_component: 0, type: 0, mission_type: 1 });
      }
    }
  };
  const hb = setInterval(() => send("HEARTBEAT", { type: 2, autopilot: 3, base_mode: 0, custom_mode: 4, system_status: 3, mavlink_version: 3 }), 200);
  t._stopHb = () => clearInterval(hb);
  return t;
}

console.log("\n== (a) INT dialect happy path: type-1 COUNT -> type-1 REQUEST_INTs -> ACK ==");
{
  const fenceItems = MAV_LINK.buildFenceItems(boundary, [exclusion]);
  const t = makeFenceVehicle({ dialect: "int" });
  const link = new MAV_LINK.MavLink();
  await link.connect(t);
  const up = await link.uploadMission(fenceItems, undefined, undefined, 1);
  check("[int] upload ok", up.ok === true);
  check("[int] correct count", up.count === fenceItems.length);
  check("[int] vehicle received all 7 items, all MISSION_ITEM_INT", t.received.length === 7 && t.received.every((r) => r.form === "MISSION_ITEM_INT"));
  check("[int] every item carries mission_type=1", t.received.every((r) => r.fields.mission_type === 1));
  check("[int] cmd/param1 preserved (5001×4, 5002×3)",
    t.received.slice(0, 4).every((r) => r.fields.command === CMD_INCLUSION && r.fields.param1 === 4) &&
    t.received.slice(4).every((r) => r.fields.command === CMD_EXCLUSION && r.fields.param1 === 3));
  check("[int] coords scaled ×1e7", t.received.every((r, i) => {
    const src = fenceItems[i];
    return r.fields.x === Math.round(src.lat * 1e7) && r.fields.y === Math.round(src.lon * 1e7);
  }));
  link.disconnect(); t._stopHb();
}

console.log("\n== (b) ArduPilot dialect happy path (real SITL behaviour): plain v2 MISSION_REQUEST, mission_type=1 ==");
{
  const fenceItems = MAV_LINK.buildFenceItems(boundary, [exclusion]);
  const t = makeFenceVehicle({ dialect: "ardupilot" });
  const link = new MAV_LINK.MavLink();
  await link.connect(t);
  const up = await link.uploadMission(fenceItems, undefined, undefined, 1);
  check("[ardupilot] upload SUCCEEDS (was the SITL-found regression)", up.ok === true);
  check("[ardupilot] correct count", up.count === fenceItems.length);
  check("[ardupilot] vehicle received all 7 items, all float MISSION_ITEM (not _INT)",
    t.received.length === 7 && t.received.every((r) => r.form === "MISSION_ITEM"));
  check("[ardupilot] every item carries mission_type=1", t.received.every((r) => r.fields.mission_type === 1));
  check("[ardupilot] cmd/param1 preserved (5001×4, 5002×3)",
    t.received.slice(0, 4).every((r) => r.fields.command === CMD_INCLUSION && r.fields.param1 === 4) &&
    t.received.slice(4).every((r) => r.fields.command === CMD_EXCLUSION && r.fields.param1 === 3));
  // Float32 degrees (exact bit-for-bit round-trip through the codec's Float32 pack/unpack) —
  // at ~49.5° that's ~0.5 m resolution, well inside a fence's metre-scale margins.
  check("[ardupilot] coords are float32 lat/lon (exact fround round-trip)", t.received.every((r, i) => {
    const src = fenceItems[i];
    return r.fields.x === Math.fround(src.lat) && r.fields.y === Math.fround(src.lon);
  }));
  link.disconnect(); t._stopHb();
}

console.log("\n== (c) cross-type isolation: a stray type-0 request (either message form) must NOT get a fence item ==");
{
  const fenceItems = MAV_LINK.buildFenceItems(boundary, [exclusion]);
  const t = makeFenceVehicle({ dialect: "ardupilot", strayCrossType: true });
  const link = new MAV_LINK.MavLink();
  await link.connect(t);
  const up = await link.uploadMission(fenceItems, undefined, undefined, 1);
  check("[cross-type] upload still completes ok despite the stray noise", up.ok === true);
  check("[cross-type] correct count", up.count === fenceItems.length);
  check("[cross-type] every seq answered EXACTLY once (neither stray form got its own item)",
    Object.values(t.itemSeqCounts).every((c) => c === 1) && Object.keys(t.itemSeqCounts).length === 7);
  check("[cross-type] every delivered item is still mission_type=1 (never the stray's type)",
    t.received.every((r) => r.fields.mission_type === 1));
  link.disconnect(); t._stopHb();
}

console.log("\n== (d) true v1-frame (STX 0xFE) vehicle: clean abort, no garbage upload ==");
{
  const fenceItems = MAV_LINK.buildFenceItems(boundary, [exclusion]);
  const t = makeFenceVehicle({ trueV1Abort: true });
  const link = new MAV_LINK.MavLink();
  await link.connect(t);
  const up = await link.uploadMission(fenceItems, undefined, undefined, 1);
  check("[v1-frame] upload cleanly rejected (ok:false)", up.ok === false);
  check("[v1-frame] error names the unsupported firmware/protocol", /геозон/i.test(up.error || "") && /mavlink/i.test(up.error || ""));
  check("[v1-frame] no fence item was ever sent", t.received.length === 0);
  link.disconnect(); t._stopHb();
}

console.log("\nRESULT: " + (failed ? `${failed} FAILURE(S)` : "ALL CHECKS PASSED"));
process.exit(failed ? 1 : 0);
