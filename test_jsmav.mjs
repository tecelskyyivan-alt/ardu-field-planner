/* Headless regression for the BROWSER/ANDROID MAVLink path (web/mav/link.js)
 * against a fake ArduPilot vehicle over an in-process loopback. The Python link is
 * covered by test_mavlink.py; this guards the JS port the phone/PWA actually use.
 *
 * Run:  node test_jsmav.mjs        (needs Node 18+; no browser, no hardware)
 *
 * Covers the field-reported failures over an ELRS link:
 *   • mission upload over a SLOW link must not time out mid-transfer (progress timeout)
 *   • a dropped first MISSION_COUNT recovers (re-announce)
 *   • a HIGH-LATENCY first response must NOT trigger a COUNT spam that resets the
 *     vehicle's mission receiver (the v1.8 regression: 1 s resend reset the upload)
 *   • telemetry streams self-heal: GPS/position only arrive after the GCS keeps
 *     re-requesting SET_MESSAGE_INTERVAL — proving "? · ? sat" is fixed.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fake vehicle over a loopback transport.
//   opts.itemDelay        ms before answering each item request (slow RF link)
//   opts.dropFirstCount   ignore the first MISSION_COUNT (tests re-announce)
//   opts.firstReqDelay    ms to delay the FIRST request after a COUNT (high latency)
//   opts.streamsOnRequest only stream GPS/position AFTER a SET_MESSAGE_INTERVAL(511)
function makeVehicle(opts = {}) {
  const veh = MAVLINK.createParser();
  let n = 0, streamReqSeen = 0;
  const t = { ondata: null, close() {}, _countSeen: 0, _streaming: !opts.streamsOnRequest };
  const send = (name, fields) => { const b = MAVLINK.encode(name, fields, { sys: 1, comp: 1, seq: 0 }); if (t.ondata) t.ondata(b); };
  const reqInt = (seq) => send("MISSION_REQUEST_INT", { target_system: 255, target_component: 0, seq, mission_type: 0 });
  const ack = () => send("MISSION_ACK", { target_system: 255, target_component: 0, type: 0, mission_type: 0 });
  t.write = (bytes) => {
    for (const m of veh.push(bytes)) {
      if (m.name === "MISSION_COUNT") {
        t._countSeen++;
        if (opts.dropFirstCount && t._countSeen === 1) continue;
        n = m.fields.count;
        const first = () => reqInt(0);
        if (opts.firstReqDelay) setTimeout(first, opts.firstReqDelay); else first();
      } else if (m.name === "MISSION_ITEM_INT") {
        const seq = m.fields.seq;
        const next = () => { if (seq + 1 < n) reqInt(seq + 1); else ack(); };
        opts.itemDelay ? setTimeout(next, opts.itemDelay) : next();
      } else if (m.name === "COMMAND_LONG" && m.fields.command === 511) {
        // SET_MESSAGE_INTERVAL for GPS/position → start streaming telemetry.
        // Key on msg 33 only = one trigger per request BURST (a burst sends 511 for
        // several ids). dropFirstStreamReq simulates the first burst lost on RF — only
        // a re-request makes telemetry flow (proves the self-heal loop, not one-shot).
        if (m.fields.param1 === 33) {
          streamReqSeen++;
          if (!opts.dropFirstStreamReq || streamReqSeen > 1) t._streaming = true;
        }
      }
    }
  };
  // Always heartbeat (so connect resolves). Stream GPS only when enabled.
  const hb = setInterval(() => {
    send("HEARTBEAT", { type: 2, autopilot: 3, base_mode: 0, custom_mode: 4, system_status: 3, mavlink_version: 3 });
    if (t._streaming) {
      send("GPS_RAW_INT", { fix_type: 3, satellites_visible: 11, lat: 494900000, lon: 240100000 });
      send("GLOBAL_POSITION_INT", { lat: 494900000, lon: 240100000, relative_alt: 0, hdg: 27000 });
    }
  }, 200);
  t._stopHb = () => clearInterval(hb);
  return t;
}

// Fake vehicle that STORES a mission and serves it for download/verify.
//   stored: [{seq,command,frame,x,y,z}] — x,y are int32 1e-7°, z is metres.
//   opts.legacyOnly: answer ONLY MISSION_REQUEST (ignore MISSION_REQUEST_INT) — INAV / bridge dialect
//   opts.itemDelay:  ms before answering each item request (slow RF link)
function makeMissionVehicle(stored, opts = {}) {
  const veh = MAVLINK.createParser();
  const t = { ondata: null, close() {} };
  const send = (name, fields) => { const b = MAVLINK.encode(name, fields, { sys: 1, comp: 1, seq: 0 }); if (t.ondata) t.ondata(b); };
  const sendItem = (seq) => {
    const it = stored[seq]; if (!it) return;
    send("MISSION_ITEM_INT", { target_system: 255, target_component: 0, seq, frame: it.frame, command: it.command,
      current: 0, autocontinue: 1, param1: 0, param2: 0, param3: 0, param4: 0, x: it.x, y: it.y, z: it.z, mission_type: 0 });
  };
  t.write = (bytes) => {
    for (const m of veh.push(bytes)) {
      if (m.name === "MISSION_REQUEST_LIST") {
        send("MISSION_COUNT", { target_system: 255, target_component: 0, count: stored.length, mission_type: 0 });
      } else if (m.name === "MISSION_REQUEST_INT") {
        if (opts.legacyOnly) continue;            // legacy-only приймач не має _INT-хендлера
        const seq = m.fields.seq; opts.itemDelay ? setTimeout(() => sendItem(seq), opts.itemDelay) : sendItem(seq);
      } else if (m.name === "MISSION_REQUEST") {
        const seq = m.fields.seq; opts.itemDelay ? setTimeout(() => sendItem(seq), opts.itemDelay) : sendItem(seq);
      }
    }
  };
  const hb = setInterval(() => send("HEARTBEAT", { type: 2, autopilot: 3, base_mode: 0, custom_mode: 4, system_status: 3, mavlink_version: 3 }), 200);
  t._stopHb = () => clearInterval(hb);
  return t;
}
// Convert built (lat/lon/alt) items → stored MISSION_ITEM_INT field objects.
const toStored = (exp) => exp.map((e) => ({ seq: e.seq, command: e.command, frame: e.frame, x: Math.round(e.lat * 1e7), y: Math.round(e.lon * 1e7), z: e.alt }));

const wps = Array.from({ length: 60 }, (_, i) => [49.49 + i * 1e-4, 24.0 + i * 1e-4]);
const items = MAV_LINK.buildMissionItems([49.49, 24.0, 0], 30, wps, 30, true, 7);

async function upload(label, opts) {
  const t = makeVehicle(opts);
  const link = new MAV_LINK.MavLink();
  const c = await link.connect(t);
  check(`[${label}] connect ok`, c.ok === true);
  const up = await link.uploadMission(items);
  check(`[${label}] upload ok`, up.ok === true);
  check(`[${label}] correct count (${items.length})`, up.count === items.length);
  link.disconnect(); t._stopHb();
  return { t, up };
}

console.log("== happy path ==");
await upload("fast", {});

console.log("\n== slow link (80 ms/item) must not time out mid-transfer ==");
await upload("slow", { itemDelay: 80 });

console.log("\n== first MISSION_COUNT dropped -> re-announce, upload completes ==");
await upload("retransmit", { dropFirstCount: true });

console.log("\n== HIGH LATENCY (first response after 2.5 s) must NOT spam/reset COUNT ==");
{
  const { t } = await upload("high-latency", { firstReqDelay: 2500 });
  check("[high-latency] vehicle got exactly ONE COUNT (no reset spam)", t._countSeen === 1);
}

console.log("\n== telemetry self-heals: 1st stream request dropped, RE-request makes GPS flow ==");
{
  const t = makeVehicle({ streamsOnRequest: true, dropFirstStreamReq: true });
  const link = new MAV_LINK.MavLink();
  const logs = [];
  link.onLog = (s) => logs.push(s);          // capture the diagnostic log
  const c = await link.connect(t);
  check("[streams] connect ok", c.ok === true);
  check("[streams] no GPS after the first (dropped) request", link.status().fix_type == null);
  let got = false;
  for (let i = 0; i < 60 && !got; i++) { await sleep(100); const s = link.status(); if (s.fix_type != null && s.sats != null && s.lat != null) got = true; }
  const s = link.status();
  check("[streams] GPS/position arrived after the GCS re-requested streams", got);
  check("[streams] fix_type parsed (3)", s.fix_type === 3);
  check("[streams] sats parsed (11)", s.sats === 11);
  // diagnostic log + stats (for the "analyze errors" export)
  check("[log] recorded the stream re-request", logs.some((l) => l.includes("requesting telemetry streams")));
  check("[log] recorded telemetry start", logs.some((l) => l.includes("telemetry streaming")));
  check("[log] recorded the autopilot heartbeat source", logs.some((l) => l.includes("heartbeat src") && l.includes("autopilot")));
  const st = link.getStats();
  check("[log] getStats counts received messages", st.msgCounts.HEARTBEAT > 0 && st.msgCounts.GPS_RAW_INT > 0);
  link.disconnect(); t._stopHb();
}

console.log("\n== readback dialect: unknown autopilot must use legacy MISSION_REQUEST ==");
{
  const exp = MAV_LINK.buildMissionItems([49.49, 24.0, 0], 30, wps, 30, true, 7);
  const t = makeMissionVehicle(toStored(exp), { legacyOnly: true });   // vehicle only answers legacy REQUEST
  const link = new MAV_LINK.MavLink();
  await link.connect(t);
  t._stopHb();                        // stop heartbeats so the override below survives
  link._tlm.autopilot = null;         // simulate a bridge that forwards but never revealed the autopilot
  const dl = await link.downloadMission(3000);
  check("[dialect] download completed over legacy-only link", dl.ok === true);
  check("[dialect] read back all items", dl.ok && dl.count === exp.length);
  link.disconnect();
}

console.log("\nRESULT: " + (failed ? `${failed} FAILURE(S)` : "ALL CHECKS PASSED"));
process.exit(failed ? 1 : 0);
