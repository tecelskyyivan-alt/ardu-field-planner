/* Headless regression for the opt-in ArduPilot GEOFENCE upload (#12p3), over the
 * SAME loopback machinery as test_jsmav.mjs — a fake vehicle talking to the real
 * web-stable/mav/link.js uploadMission(), just with mission_type=1 (FENCE).
 *
 * Run:  node test_jsfence.mjs   (needs Node 18+; no browser, no hardware)
 *
 * Covers the three protocol-safety requirements from the brief:
 *   (a) happy path — a type-1 COUNT answered with type-1 REQUEST_INTs + final ACK:
 *       every fence item must arrive with mission_type=1, the right cmd (5001/5002),
 *       param1 = that polygon's OWN vertex count, and coords scaled ×1e7.
 *   (b) cross-type isolation — a stray type-0 REQUEST_INT interleaved mid-transaction
 *       must NOT be answered with a fence item (no duplicate/misrouted send).
 *   (c) v1-only vehicle — answers with plain MISSION_REQUEST (no mission_type on the
 *       wire) instead of _INT: the fence transaction requires MAVLink2+INT, so this
 *       must abort cleanly with a specific error, not hang or upload garbage.
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
MAVLINK.setSpecs(JSON.parse(fs.readFileSync(path.join(MAVDIR, "specs.json"), "utf8")));

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
}

// ---- fake vehicle over a loopback transport, FENCE-aware -------------------
// opts.v1Only:      answer the fence COUNT with a plain (v1-dialect) MISSION_REQUEST
// opts.strayType0:  interleave a stray type-0 MISSION_REQUEST_INT before each real
//                   type-1 request (cross-transaction noise, must be ignored)
function makeFenceVehicle(opts = {}) {
  const veh = MAVLINK.createParser();
  const t = { ondata: null, close() {}, received: [], itemSeqCounts: {} };
  const send = (name, fields) => { const b = MAVLINK.encode(name, fields, { sys: 1, comp: 1, seq: 0 }); if (t.ondata) t.ondata(b); };
  let n = 0;
  const reqReal = (seq) => send("MISSION_REQUEST_INT", { target_system: 255, target_component: 0, seq, mission_type: 1 });
  const reqStray = (seq) => send("MISSION_REQUEST_INT", { target_system: 255, target_component: 0, seq, mission_type: 0 });
  t.write = (bytes) => {
    for (const m of veh.push(bytes)) {
      if (m.name === "MISSION_COUNT") {
        if (m.fields.mission_type !== 1) continue;    // not the fence list — ignore (mirrors a real FC)
        n = m.fields.count;
        if (opts.v1Only) { send("MISSION_REQUEST", { target_system: 255, target_component: 0, seq: 0 }); continue; }
        if (opts.strayType0) reqStray(0);
        reqReal(0);
      } else if (m.name === "MISSION_ITEM_INT") {
        const seq = m.fields.seq;
        t.received.push(Object.assign({}, m.fields));
        t.itemSeqCounts[seq] = (t.itemSeqCounts[seq] || 0) + 1;
        if (seq + 1 < n) {
          if (opts.strayType0) reqStray(seq + 1);
          reqReal(seq + 1);
        } else {
          send("MISSION_ACK", { target_system: 255, target_component: 0, type: 0, mission_type: 1 });
        }
      } else if (m.name === "MISSION_ITEM") {
        // A v1-only vehicle asked for MISSION_ITEM (float) — if the GCS ever sent one for
        // a fence transaction, that's exactly the "uploaded garbage" the abort must prevent.
        t.gotV1Item = true;
      }
    }
  };
  const hb = setInterval(() => send("HEARTBEAT", { type: 2, autopilot: 3, base_mode: 0, custom_mode: 4, system_status: 3, mavlink_version: 3 }), 200);
  t._stopHb = () => clearInterval(hb);
  return t;
}

console.log("\n== (a) happy path: type-1 COUNT -> type-1 REQUEST_INTs -> ACK ==");
{
  const fenceItems = MAV_LINK.buildFenceItems(boundary, [exclusion]);
  const t = makeFenceVehicle({});
  const link = new MAV_LINK.MavLink();
  await link.connect(t);
  const up = await link.uploadMission(fenceItems, undefined, undefined, 1);
  check("[happy] upload ok", up.ok === true);
  check("[happy] correct count", up.count === fenceItems.length);
  check("[happy] vehicle received all 7 items", t.received.length === 7);
  check("[happy] every item carries mission_type=1", t.received.every((f) => f.mission_type === 1));
  check("[happy] cmd/param1 preserved (5001×4, 5002×3)",
    t.received.slice(0, 4).every((f) => f.command === CMD_INCLUSION && f.param1 === 4) &&
    t.received.slice(4).every((f) => f.command === CMD_EXCLUSION && f.param1 === 3));
  check("[happy] coords scaled ×1e7", t.received.every((f, i) => {
    const src = fenceItems[i];
    return f.x === Math.round(src.lat * 1e7) && f.y === Math.round(src.lon * 1e7);
  }));
  link.disconnect(); t._stopHb();
}

console.log("\n== (b) cross-type isolation: stray type-0 REQUEST_INT must NOT get a fence item ==");
{
  const fenceItems = MAV_LINK.buildFenceItems(boundary, [exclusion]);
  const t = makeFenceVehicle({ strayType0: true });
  const link = new MAV_LINK.MavLink();
  await link.connect(t);
  const up = await link.uploadMission(fenceItems, undefined, undefined, 1);
  check("[cross-type] upload still completes ok despite the stray noise", up.ok === true);
  check("[cross-type] correct count", up.count === fenceItems.length);
  check("[cross-type] every seq answered EXACTLY once (stray never got its own item)",
    Object.values(t.itemSeqCounts).every((c) => c === 1) && Object.keys(t.itemSeqCounts).length === 7);
  check("[cross-type] every delivered item is still mission_type=1 (never the stray's type)",
    t.received.every((f) => f.mission_type === 1));
  link.disconnect(); t._stopHb();
}

console.log("\n== (c) v1-only vehicle: clean abort, no garbage upload ==");
{
  const fenceItems = MAV_LINK.buildFenceItems(boundary, [exclusion]);
  const t = makeFenceVehicle({ v1Only: true });
  const link = new MAV_LINK.MavLink();
  await link.connect(t);
  const up = await link.uploadMission(fenceItems, undefined, undefined, 1);
  check("[v1-only] upload cleanly rejected (ok:false)", up.ok === false);
  check("[v1-only] error names the unsupported firmware/protocol", /геозон/i.test(up.error || "") || /mavlink2/i.test(up.error || ""));
  check("[v1-only] no fence item was ever sent (no MISSION_ITEM, no MISSION_ITEM_INT)",
    t.received.length === 0 && !t.gotV1Item);
  link.disconnect(); t._stopHb();
}

console.log("\nRESULT: " + (failed ? `${failed} FAILURE(S)` : "ALL CHECKS PASSED"));
process.exit(failed ? 1 : 0);
