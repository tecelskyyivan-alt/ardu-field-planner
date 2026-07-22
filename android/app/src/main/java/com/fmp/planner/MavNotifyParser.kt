package com.fmp.planner

/**
 * Minimal, PURE (no Android deps → JVM-unit-testable) MAVLink parser for the pinned notification
 * (#3). It decodes just the handful of fields the notification needs — mode, armed, battery, alt,
 * groundspeed, current waypoint, plus flight-time/distance — so the notification stays live even
 * while the WebView is frozen in the background.
 *
 * Byte offsets, crc_extra and the CRC-16/MCRF4XX algorithm are replicated verbatim from
 * web-stable/mav/{mavlink.js,link.js} and covered by MavNotifyParserTest (golden frames encoded by
 * mavlink.js). Frames it doesn't model are skipped by their self-describing length; a bad CRC on a
 * modelled frame advances one byte and resyncs (never throws — the ELRS stream is lossy).
 */
class MavNotifyParser(private val nowMs: () -> Long = { System.currentTimeMillis() }) {

    data class Snapshot(
        val mode: Int, val modeName: String, val vehicleType: Int, val armed: Boolean?,
        val battV: Double?, val battPct: Int?, val altM: Double?, val gsMs: Double?,
        val wpSeq: Int?, val wpTotal: Int?, val flightSec: Long, val distM: Double, val progressPct: Int?,
        /** ms since the last successfully CRC-verified frame; null if none has ever arrived. Lets
         *  TelemetryService detect a dead link and mark the notification stale (see STALE_MS there). */
        val ageMs: Long?
    )

    companion object {
        private const val NEED = -1
        private const val BAD = -2
        // crc_extra for the 5 modelled messages (verified exact, spec §6 / specs.json).
        private val CRC_EXTRA = mapOf(0 to 50, 1 to 124, 33 to 104, 42 to 28, 74 to 20)
        private val ACM = mapOf(0 to "STABILIZE", 2 to "ALT_HOLD", 3 to "AUTO", 4 to "GUIDED",
            5 to "LOITER", 6 to "RTL", 9 to "LAND", 17 to "BRAKE", 21 to "SMART_RTL")
        private val PLANE = mapOf(0 to "MANUAL", 1 to "CIRCLE", 2 to "STABILIZE", 3 to "TRAINING",
            4 to "ACRO", 5 to "FBWA", 6 to "FBWB", 7 to "CRUISE", 8 to "AUTOTUNE", 10 to "AUTO",
            11 to "RTL", 12 to "LOITER", 13 to "TAKEOFF", 15 to "GUIDED")
        fun modeName(cm: Int, vtype: Int): String =
            (if (vtype == 1) PLANE[cm] else ACM[cm]) ?: "MODE $cm"
    }

    private var buf = ByteArray(0)
    private var mode = -1
    private var vehicleType = 0
    private var modeName = "—"
    private var armed: Boolean? = null
    private var battV: Double? = null
    private var battPct: Int? = null
    private var altM: Double? = null
    private var gsMs: Double? = null
    private var wpSeq: Int? = null
    private var wpTotalPushed = 0
    private var flightStartMs = 0L
    private var flightAccumMs = 0L
    private var lastArmed = false
    private var distM = 0.0
    private var lastLat: Double? = null
    private var lastLon: Double? = null
    private var lastRxMs = 0L

    /** wp_total is trusted ONLY from JS (it uploaded the mission); MISSION_CURRENT.total is optional. */
    fun setMission(total: Int) { wpTotalPushed = if (total > 0) total else 0 }
    fun resetFlight() {
        flightAccumMs = 0; distM = 0.0; lastLat = null; lastLon = null
        flightStartMs = if (lastArmed) nowMs() else 0
    }

    fun snapshot(): Snapshot {
        // Deliberate choice (staleness fix, IMPORTANT finding): flightSec keeps ticking on wall-clock
        // time even while the link is dead and lastArmed is stale — we have no reliable disarm signal
        // without a live HEARTBEAT, so freezing the timer would just replace one wrong signal (a dead
        // link disguised as live) with another (a flight that "ended" while possibly still airborne).
        // TelemetryService surfaces the actual staleness via the title/ageMs instead of stopping this.
        val live = if (lastArmed && flightStartMs > 0) nowMs() - flightStartMs else 0
        val fSec = (flightAccumMs + live) / 1000
        val wt = if (wpTotalPushed > 0) wpTotalPushed else null
        val pct = if (wt != null && wt > 1 && wpSeq != null)
            (wpSeq!!.coerceIn(0, wt) * 100) / wt else null
        // distM (unlike flightSec) is NOT wall-clock-derived: it only grows inside the msgId==33
        // handler below, on a freshly arrived GLOBAL_POSITION_INT frame. While the stream is dead no
        // frames arrive, so distM is naturally frozen during a gap — nothing here needs to special-case
        // staleness for distance.
        val age = if (lastRxMs > 0) nowMs() - lastRxMs else null
        return Snapshot(mode, modeName, vehicleType, armed, battV, battPct, altM, gsMs,
            wpSeq, wt, fSec, distM, pct, age)
    }

    fun push(bytes: ByteArray) {
        buf = if (buf.isEmpty()) bytes.copyOf() else buf + bytes
        var i = 0
        while (i < buf.size) {
            val b = buf[i].toInt() and 0xff
            if (b != 0xFD && b != 0xFE) { i++; continue }
            val r = decodeFrame(buf, i)
            when {
                r == NEED -> break
                r == BAD -> i++
                else -> i += r
            }
        }
        buf = if (i >= buf.size) ByteArray(0) else buf.copyOfRange(i, buf.size)
    }

    private fun u8(a: ByteArray, i: Int) = a[i].toInt() and 0xff
    private fun u16(a: ByteArray, i: Int) = u8(a, i) or (u8(a, i + 1) shl 8)
    private fun i16(a: ByteArray, i: Int) = u16(a, i).toShort().toInt()
    private fun u32(a: ByteArray, i: Int): Long =
        (u8(a, i).toLong()) or (u8(a, i + 1).toLong() shl 8) or (u8(a, i + 2).toLong() shl 16) or (u8(a, i + 3).toLong() shl 24)
    private fun i32(a: ByteArray, i: Int) = u32(a, i).toInt()
    private fun f32(a: ByteArray, i: Int) = Float.fromBits(i32(a, i))

    // returns bytes consumed (>0), or NEED / BAD.
    private fun decodeFrame(a: ByteArray, off: Int): Int {
        val v2 = u8(a, off) == 0xFD
        val hdr = if (v2) 10 else 6
        if (off + hdr > a.size) return NEED
        val len = u8(a, off + 1)
        val incompat = if (v2) u8(a, off + 2) else 0
        val sig = if (v2 && (incompat and 0x01) != 0) 13 else 0
        val total = hdr + len + 2 + sig
        if (off + total > a.size) return NEED
        val msgId: Int; val payStart: Int
        if (v2) { msgId = u8(a, off + 7) or (u8(a, off + 8) shl 8) or (u8(a, off + 9) shl 16); payStart = off + 10 }
        else { msgId = u8(a, off + 5); payStart = off + 6 }
        val extra = CRC_EXTRA[msgId] ?: return total          // not modelled → skip by self-describing length
        // CRC-16/MCRF4XX over header[from off+1] + payload, then crc_extra appended.
        var crc = 0xffff
        val acc = { x: Int -> var t = (x xor (crc and 0xff)) and 0xff; t = (t xor (t shl 4)) and 0xff; crc = ((crc ushr 8) xor (t shl 8) xor (t shl 3) xor (t ushr 4)) and 0xffff }
        for (k in (off + 1) until (payStart + len)) acc(u8(a, k))
        acc(extra and 0xff)
        val wire = u16(a, payStart + len)
        if (crc != wire) return BAD
        lastRxMs = nowMs()   // staleness fix: only CRC-verified, modeled frames count as "link alive"
        ingest(msgId, a, payStart, len)
        return total
    }

    // v2 drops TRAILING ZEROS, so a truncated payload's missing bytes are known-zero → zero-pad and
    // read. Only the battery fields must NOT be zero-padded-into (a fake 0% is dangerous): those are
    // gated on being fully present on the wire (`present`).
    private fun ingest(msgId: Int, a: ByteArray, p: Int, len: Int) {
        val pay = ByteArray(48)
        System.arraycopy(a, p, pay, 0, minOf(len, 48))       // zero-padded payload
        fun present(off: Int, size: Int) = off + size <= len
        when (msgId) {
            0 -> {   // HEARTBEAT: custom_mode+0 u32, type+4 u8, autopilot+5 u8, base_mode+6 u8
                val type = u8(pay, 4); val autopilot = u8(pay, 5)
                if (autopilot != 8 && type != 6) {           // adopt only a real vehicle, not a GCS/backpack HB
                    mode = u32(pay, 0).toInt(); vehicleType = type; modeName = modeName(mode, type)
                    val nowArmed = (u8(pay, 6) and 0x80) != 0
                    armed = nowArmed
                    if (nowArmed != lastArmed) {
                        if (nowArmed) { flightStartMs = nowMs(); distM = 0.0; lastLat = null; lastLon = null }
                        else { flightAccumMs += if (flightStartMs > 0) nowMs() - flightStartMs else 0; flightStartMs = 0 }
                        lastArmed = nowArmed
                    }
                }
            }
            1 -> {   // SYS_STATUS: voltage_battery+14 u16 mV (0xFFFF=unknown), battery_remaining+30 i8 % (-1=unknown)
                if (present(14, 2)) { val mv = u16(pay, 14); battV = if (mv == 0xFFFF) null else mv / 1000.0 }
                battPct = if (present(30, 1)) { val pc = pay[30].toInt(); if (pc == -1) null else pc } else null
            }
            33 -> {  // GLOBAL_POSITION_INT: lat+4 i32(1e7), lon+8 i32(1e7), relative_alt+16 i32(mm)
                val lat = i32(pay, 4) / 1e7; val lon = i32(pay, 8) / 1e7
                altM = i32(pay, 16) / 1000.0
                val pl = lastLat; val po = lastLon
                if (lastArmed && pl != null && po != null) {
                    val d = equirectM(pl, po, lat, lon)
                    if (d in 0.5..200.0) distM += d           // ignore GPS jitter (<0.5) and teleport/spoof (>200)
                }
                lastLat = lat; lastLon = lon
            }
            74 -> {  // VFR_HUD: groundspeed+4 f32, alt+8 f32
                gsMs = f32(pay, 4).toDouble(); altM = f32(pay, 8).toDouble()
            }
            42 -> {  // MISSION_CURRENT: seq+0 u16 (total+2 optional → ignored, JS pushes flownWpTotal)
                wpSeq = u16(pay, 0)
            }
        }
    }

    private fun equirectM(la1: Double, lo1: Double, la2: Double, lo2: Double): Double {
        val r = 6371000.0; val rad = Math.PI / 180.0
        val x = (lo2 - lo1) * rad * Math.cos((la1 + la2) * 0.5 * rad)
        val y = (la2 - la1) * rad
        return r * Math.hypot(x, y)
    }
}
