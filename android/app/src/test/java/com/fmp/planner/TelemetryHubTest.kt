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
}
