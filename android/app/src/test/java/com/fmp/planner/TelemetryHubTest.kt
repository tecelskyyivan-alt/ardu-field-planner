package com.fmp.planner

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Guards TelemetryHub's CONTRACT (see MavNotifyParserTest for the byte-level golden coverage this
 * builds on): `feed` must be a no-op while `active == false`, and must reach the shared parser
 * (reflected in `snapshot()`) once `active == true`. Uses the same golden HEARTBEAT frame as
 * MavNotifyParserTest (encoded by web-stable/mav/mavlink.js).
 *
 * Both cases live in one test method — TelemetryHub is a process-wide singleton (object), so
 * relying on JUnit method ordering across two separate @Test methods to establish "inactive
 * first, active second" would be fragile; a single method makes the sequencing explicit.
 */
class TelemetryHubTest {
    private val HEARTBEAT = byteArrayOf(-3, 9, 0, 0, 0, 1, 1, 0, 0, 0, 3, 0, 0, 0, 2, 3, -128, 4, 3, 77, -114)

    @Test fun feed_is_noop_while_inactive_and_reaches_parser_while_active() {
        TelemetryHub.active = false
        TelemetryHub.feed(HEARTBEAT)
        assertNull("feed() must not touch the parser while inactive", TelemetryHub.snapshot().armed)

        TelemetryHub.active = true
        TelemetryHub.feed(HEARTBEAT)
        val s = TelemetryHub.snapshot()
        assertEquals(true, s.armed)
        assertEquals(3, s.mode)
        assertEquals("AUTO", s.modeName)

        TelemetryHub.active = false   // leave the shared singleton inactive for any later test
    }

    // Golden GPI frame from MavNotifyParserTest (lat/lon 1e7-scaled, relative_alt 25 m).
    private val GPI = byteArrayOf(-3, 28, 0, 0, 0, 1, 1, 33, 0, 0, 0, 0, 0, 0, 32, -109, 127, 29, -96, -94, 79, 14, -96, -122, 1, 0, -88, 97, 0, 0, 0, 0, 0, 0, 0, 0, 120, 105, 35, 108)

    @Test fun background_track_buffers_armed_positions_and_drains_once() {
        TelemetryHub.drainTrack()                    // clear any residue from other tests
        TelemetryHub.active = true
        TelemetryHub.feed(HEARTBEAT)                 // armed=true
        TelemetryHub.feed(GPI)                       // one armed position
        val t = TelemetryHub.drainTrack()
        assertEquals(1, t.size)
        assertEquals(25.0, t[0][3], 1e-3)            // relative alt, not AMSL
        assertEquals(0, TelemetryHub.drainTrack().size)   // drain clears
        TelemetryHub.active = false
    }
}
