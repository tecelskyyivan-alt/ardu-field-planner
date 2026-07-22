package com.fmp.planner

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Golden test for MavNotifyParser: the frames below were encoded by web-stable/mav/mavlink.js
 * (the authoritative codec) with known field values, so decoding them back must yield those values.
 * Guards the hardcoded byte offsets / crc_extra / sentinels against transcription drift.
 */
class MavNotifyParserTest {
    // v2 frames from mavlink.js encode() (see the test-generation note in the commit).
    private val HEARTBEAT = byteArrayOf(-3, 9, 0, 0, 0, 1, 1, 0, 0, 0, 3, 0, 0, 0, 2, 3, -128, 4, 3, 77, -114)
    private val SYS_STATUS = byteArrayOf(-3, 31, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 56, 49, -1, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 75, -94, -78)
    private val GPI = byteArrayOf(-3, 28, 0, 0, 0, 1, 1, 33, 0, 0, 0, 0, 0, 0, 32, -109, 127, 29, -96, -94, 79, 14, -96, -122, 1, 0, -88, 97, 0, 0, 0, 0, 0, 0, 0, 0, 120, 105, 35, 108)
    private val VFR_HUD = byteArrayOf(-3, 19, 0, 0, 0, 1, 1, 74, 0, 0, 0, 0, 0, 0, 0, 0, 8, 65, 0, 0, -56, 65, 0, 0, 0, 0, 14, 1, 50, 21, 83)
    private val MISSION_CURRENT = byteArrayOf(-3, 1, 0, 0, 0, 1, 1, 42, 0, 0, 5, 40, -74)

    @Test fun heartbeat_mode_armed_type() {
        val p = MavNotifyParser { 1000L }
        p.push(HEARTBEAT)
        val s = p.snapshot()
        assertEquals(true, s.armed)
        assertEquals(3, s.mode)
        assertEquals("AUTO", s.modeName)
        assertEquals(2, s.vehicleType)
    }

    @Test fun sys_status_battery() {
        val p = MavNotifyParser { 0L }
        p.push(SYS_STATUS)
        val s = p.snapshot()
        assertEquals(12.6, s.battV!!, 1e-6)
        assertEquals(75, s.battPct)
    }

    @Test fun position_and_vfr() {
        val p = MavNotifyParser { 0L }
        p.push(GPI); assertEquals(25.0, p.snapshot().altM!!, 1e-3)
        p.push(VFR_HUD); assertEquals(8.5, p.snapshot().gsMs!!, 1e-4)
    }

    @Test fun mission_current_and_progress() {
        val p = MavNotifyParser { 0L }
        p.setMission(10)
        p.push(MISSION_CURRENT)
        val s = p.snapshot()
        assertEquals(5, s.wpSeq)
        assertEquals(50, s.progressPct)   // 5 / 10
    }

    @Test fun flight_seconds_accumulate_while_armed() {
        var t = 1000L
        val p = MavNotifyParser { t }
        p.push(HEARTBEAT)                 // armed at t=1000
        t = 6000L
        assertEquals(5L, p.snapshot().flightSec)
    }

    @Test fun bad_crc_does_not_adopt() {
        val hb = HEARTBEAT.copyOf(); hb[10] = 99   // corrupt custom_mode → CRC fail
        val p = MavNotifyParser { 0L }
        p.push(hb)
        assertEquals(-1, p.snapshot().mode)
        assertNull(p.snapshot().armed)
    }

    @Test fun frame_split_across_chunks_reassembles() {
        val p = MavNotifyParser { 0L }
        p.push(HEARTBEAT.copyOfRange(0, 8))
        p.push(HEARTBEAT.copyOfRange(8, HEARTBEAT.size))
        assertEquals(3, p.snapshot().mode)
    }

    @Test fun two_frames_one_push() {
        val p = MavNotifyParser { 0L }
        p.setMission(10)
        p.push(HEARTBEAT + MISSION_CURRENT)
        val s = p.snapshot()
        assertTrue(s.armed == true && s.wpSeq == 5)
    }

    /**
     * IMPORTANT staleness finding: fakes the clock, feeds one HEARTBEAT (armed, no position fix
     * yet), then advances the clock with NO further frames arriving — simulating a dead MAVLink
     * link. Asserts the snapshot exposes the growing age (so TelemetryService can flag the
     * notification stale after STALE_MS) and that distance does not grow purely from time passing:
     * distM only advances inside the GLOBAL_POSITION_INT handler on a freshly arrived frame, so a
     * silent stream must leave it frozen. flightSec, by contrast, is documented (see
     * MavNotifyParser.snapshot()) to keep ticking on wall-clock time even while stale — asserted
     * here too, to lock in that this is a deliberate choice and not an oversight.
     */
    @Test fun staleness_age_exposed_and_distance_frozen_during_silence() {
        var t = 1000L
        val p = MavNotifyParser { t }
        p.push(HEARTBEAT)                 // armed at t=1000; lastRxMs=1000
        p.push(GPI)                       // first position fix at t=1000; no prior fix -> distM stays 0

        val before = p.snapshot()
        assertEquals(0L, before.ageMs)
        assertEquals(0.0, before.distM, 1e-9)

        t = 15000L                        // 14s of silence: no new frames pushed
        val after = p.snapshot()
        assertEquals(14000L, after.ageMs)
        assertEquals(0.0, after.distM, 1e-9)         // must NOT grow from stale positions
        assertTrue(after.flightSec > before.flightSec) // documented: flight time keeps running
    }

    @Test fun ageMs_is_null_before_any_frame_arrives() {
        val p = MavNotifyParser { 500L }
        assertNull(p.snapshot().ageMs)
    }
}
