/* Minimal MAVLink v1/v2 codec for the in-browser GCS — hand-rolled but validated
 * byte-for-byte against pymavlink (golden test). Covers exactly the messages our
 * GCS uses (specs.json). Pure, dependency-free, works offline.
 *
 * Security: the parser is fully bounds-checked — payloads are copied into a
 * fixed-size buffer sized from the spec (never from the wire length), so a
 * malformed/hostile frame can't over-read or crash the GCS. Unknown messages are
 * skipped by their declared length; known messages are CRC-verified before use.
 *
 * API (window.MAVLINK):
 *   setSpecs(obj)                       load specs.json (id -> {name,crc_extra,fmt,names})
 *   encode(name, fields, {sys,comp,seq}) -> Uint8Array   build a v2 frame
 *   createParser() -> { push(bytes) -> [ {name,id,sysid,compid,seq,fields}, ... ] }
 */
(function (root) {
  "use strict";

  const SIZES = { B: 1, b: 1, H: 2, h: 2, I: 4, i: 4, Q: 8, q: 8, f: 4, d: 8, s: 1 };

  let specById = {};
  let specByName = {};

  function tokenize(fmt) {
    const toks = [];
    const re = /(\d*)([A-Za-z])/g;   // leading '<' is ignored (not a letter)
    let m;
    while ((m = re.exec(fmt))) {
      const type = m[2];
      if (!(type in SIZES)) throw new Error("unsupported struct type: " + type);
      const count = m[1] ? parseInt(m[1], 10) : 1;
      toks.push({ type, count, size: SIZES[type], isString: type === "s" });
    }
    return toks;
  }

  function setSpecs(obj) {
    specById = {};
    specByName = {};
    for (const k of Object.keys(obj)) {
      const s = obj[k];
      const tokens = tokenize(s.fmt);
      const fulllen = tokens.reduce((a, t) => a + t.size * t.count, 0);
      const rec = { id: s.id, name: s.name, crc_extra: s.crc_extra, names: s.names, tokens, fulllen };
      specById[s.id] = rec;
      specByName[s.name] = rec;
    }
  }

  // ---- struct scalars (little-endian) -------------------------------------
  function writeScalar(dv, off, type, v) {
    switch (type) {
      case "B": dv.setUint8(off, v & 0xff); break;
      case "b": dv.setInt8(off, v | 0); break;
      case "H": dv.setUint16(off, v & 0xffff, true); break;
      case "h": dv.setInt16(off, v | 0, true); break;
      case "I": dv.setUint32(off, v >>> 0, true); break;
      case "i": dv.setInt32(off, v | 0, true); break;
      case "f": dv.setFloat32(off, +v || 0, true); break;
      case "d": dv.setFloat64(off, +v || 0, true); break;
      case "Q": dv.setBigUint64(off, BigInt(Math.trunc(+v || 0)), true); break;
      case "q": dv.setBigInt64(off, BigInt(Math.trunc(+v || 0)), true); break;
    }
  }
  function readScalar(dv, off, type) {
    switch (type) {
      case "B": return dv.getUint8(off);
      case "b": return dv.getInt8(off);
      case "H": return dv.getUint16(off, true);
      case "h": return dv.getInt16(off, true);
      case "I": return dv.getUint32(off, true);
      case "i": return dv.getInt32(off, true);
      case "f": return dv.getFloat32(off, true);
      case "d": return dv.getFloat64(off, true);
      case "Q": return Number(dv.getBigUint64(off, true));
      case "q": return Number(dv.getBigInt64(off, true));
    }
    return 0;
  }

  function packStruct(tokens, values) {
    const full = tokens.reduce((a, t) => a + t.size * t.count, 0);
    const out = new Uint8Array(full);
    const dv = new DataView(out.buffer);
    let off = 0;
    tokens.forEach((t, k) => {
      const v = values[k];
      if (t.isString) {
        const enc = new TextEncoder().encode(v == null ? "" : String(v));
        for (let j = 0; j < t.count; j++) out[off + j] = j < enc.length ? enc[j] : 0;
        off += t.count;
      } else if (t.count > 1) {
        const arr = Array.isArray(v) ? v : [];
        for (let j = 0; j < t.count; j++) { writeScalar(dv, off, t.type, arr[j] || 0); off += t.size; }
      } else {
        writeScalar(dv, off, t.type, v == null ? 0 : v); off += t.size;
      }
    });
    return out;
  }

  function unpackStruct(tokens, dv) {
    const vals = [];
    let off = 0;
    tokens.forEach((t) => {
      if (t.isString) {
        const bytes = [];
        for (let j = 0; j < t.count; j++) { const c = dv.getUint8(off + j); if (c === 0) break; bytes.push(c); }
        vals.push(new TextDecoder().decode(new Uint8Array(bytes)));
        off += t.count;
      } else if (t.count > 1) {
        const a = [];
        for (let j = 0; j < t.count; j++) { a.push(readScalar(dv, off, t.type)); off += t.size; }
        vals.push(a);
      } else {
        vals.push(readScalar(dv, off, t.type)); off += t.size;
      }
    });
    return vals;
  }

  // ---- CRC-16/MCRF4XX (the MAVLink "X25"-style checksum) -------------------
  function crc16(bytes, extra) {
    let crc = 0xffff;
    const acc = (b) => {
      let t = (b ^ (crc & 0xff)) & 0xff;
      t = (t ^ (t << 4)) & 0xff;
      crc = ((crc >> 8) ^ (t << 8) ^ (t << 3) ^ (t >> 4)) & 0xffff;
    };
    for (let i = 0; i < bytes.length; i++) acc(bytes[i]);
    if (extra !== undefined) acc(extra & 0xff);
    return crc;
  }

  // ---- encode (always MAVLink v2) -----------------------------------------
  function encode(name, fields, opts) {
    const sp = specByName[name];
    if (!sp) throw new Error("unknown message: " + name);
    opts = opts || {};
    const sys = (opts.sys == null ? 255 : opts.sys) & 0xff;
    const comp = (opts.comp == null ? 190 : opts.comp) & 0xff;
    const seq = (opts.seq || 0) & 0xff;
    fields = fields || {};

    const values = sp.names.map((nm, k) => {
      const t = sp.tokens[k];
      const v = fields[nm];
      if (t.isString) return v == null ? "" : String(v);
      if (t.count > 1) { const arr = Array.isArray(v) ? v : []; return Array.from({ length: t.count }, (_, j) => arr[j] || 0); }
      return v == null ? 0 : v;
    });
    const payloadFull = packStruct(sp.tokens, values);
    let plen = payloadFull.length;                       // v2: drop trailing zeros, keep >=1
    while (plen > 1 && payloadFull[plen - 1] === 0) plen--;

    const header = [plen, 0, 0, seq, sys, comp, sp.id & 0xff, (sp.id >> 8) & 0xff, (sp.id >> 16) & 0xff];
    const crcInput = new Uint8Array(header.length + plen);
    crcInput.set(header, 0);
    crcInput.set(payloadFull.subarray(0, plen), header.length);
    const crc = crc16(crcInput, sp.crc_extra);

    const frame = new Uint8Array(1 + 9 + plen + 2);
    frame[0] = 0xfd;
    frame.set(header, 1);
    frame.set(payloadFull.subarray(0, plen), 10);
    frame[10 + plen] = crc & 0xff;
    frame[11 + plen] = (crc >> 8) & 0xff;
    return frame;
  }

  // ---- decode one frame (buffer positioned at STX) ------------------------
  // Returns a message object, {unknown:true,total} to skip, or null on bad CRC.
  function decodeFrame(buf, i) {
    const stx = buf[i];
    const v2 = stx === 0xfd;
    const hdr = v2 ? 10 : 6;
    if (buf.length - i < hdr) return { need: true };
    const len = buf[i + 1];
    const signed = v2 ? ((buf[i + 2] & 0x01) ? 13 : 0) : 0;
    const total = hdr + len + 2 + signed;
    if (buf.length - i < total) return { need: true };

    let seq, sysid, compid, msgid, payStart;
    if (v2) { seq = buf[i + 4]; sysid = buf[i + 5]; compid = buf[i + 6]; msgid = buf[i + 7] | (buf[i + 8] << 8) | (buf[i + 9] << 16); payStart = i + 10; }
    else { seq = buf[i + 2]; sysid = buf[i + 3]; compid = buf[i + 4]; msgid = buf[i + 5]; payStart = i + 6; }

    const sp = specById[msgid];
    if (!sp) return { unknown: true, total };            // skip whole frame, trust length

    const crcInput = buf.subarray(i + 1, payStart + len);  // len..end-of-payload
    const crc = crc16(crcInput, sp.crc_extra);
    const fcrc = buf[payStart + len] | (buf[payStart + len + 1] << 8);
    if (crc !== fcrc) return null;                         // corrupt -> caller resyncs

    const pay = new Uint8Array(sp.fulllen);                // bounds-safe: spec length, zero-padded
    const copy = Math.min(len, sp.fulllen);
    for (let k = 0; k < copy; k++) pay[k] = buf[payStart + k];
    const values = unpackStruct(sp.tokens, new DataView(pay.buffer));
    const fields = {};
    sp.names.forEach((nm, k) => { fields[nm] = values[k]; });
    // v2 flag: which FRAME (STX byte) carried this message, not which message it is.
    // A v1 frame (0xFE) physically cannot carry a MAVLink2 extension field (e.g.
    // mission_type) — callers that need to tell "legacy firmware" apart from "modern
    // firmware legitimately using the non-INT message form" must key off THIS, not the
    // message name (#12p3 fence dual-dialect fix).
    return { msg: { name: sp.name, id: msgid, sysid, compid, seq, fields, v2 }, total };
  }

  function createParser() {
    let buf = new Uint8Array(0);
    return {
      push(chunk) {
        const merged = new Uint8Array(buf.length + chunk.length);
        merged.set(buf); merged.set(chunk, buf.length);
        buf = merged;
        const out = [];
        let i = 0;
        while (i < buf.length) {
          const b = buf[i];
          if (b !== 0xfd && b !== 0xfe) { i++; continue; }   // hunt for STX
          const r = decodeFrame(buf, i);
          // Order matters: decodeFrame returns null on a BAD CRC, so this must be
          // checked FIRST — accessing r.need/r.unknown on null throws, which (over a
          // jammed ELRS link where corrupt frames are routine) would leave the bad
          // byte at the front of the buffer and re-throw on every push → telemetry
          // dies permanently mid-flight until manual reconnect. (security audit C1)
          if (r === null) { i++; continue; }                  // bad CRC -> resync
          if (r.need) break;                                  // wait for more bytes
          if (r.unknown) { i += r.total; continue; }          // skip unknown msg
          out.push(r.msg); i += r.total;
        }
        buf = buf.subarray(i);
        return out;
      },
    };
  }

  root.MAVLINK = { setSpecs, encode, createParser, crc16 };
})(typeof globalThis !== "undefined" ? globalThis : this);
