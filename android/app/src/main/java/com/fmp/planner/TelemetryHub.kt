package com.fmp.planner

/**
 * Tiny thread-safe singleton: the ONE shared MavNotifyParser instance and the single tap point
 * all three MAVLink bridges (Serial/UDP/BLE) feed raw bytes into for the pinned live-telemetry
 * notification (#3). TelemetryService flips `active` on/off around its own lifecycle so the
 * bridges can cheaply skip feeding when the service isn't running (no notification -> nobody
 * reading the snapshot -> parsing every byte would be wasted work).
 *
 * `parser` itself is NOT thread-safe (see MavNotifyParser), so every access here is serialised
 * on the parser instance — bridges can call `feed` from their own I/O threads (USB read thread,
 * UDP recv thread, BLE GATT callback thread) while TelemetryService's ticker calls `snapshot`
 * from the main thread, with no risk of concurrent mutation.
 */
object TelemetryHub {
    val parser = MavNotifyParser()

    // Background flown-track buffer (#3 field report): while the WebView is frozen (screen off)
    // JS collects nothing, so the map track had a hole. The parser taps every armed position
    // here (1 Hz throttle, ring of 7200 = ~2 h); JS drains it on resume and backfills the map.
    private val track = ArrayDeque<DoubleArray>()          // [tMs, lat, lon, relAltM]
    @Volatile private var lastTrackMs = 0L

    init {
        parser.onPosition = { lat, lon, alt, armed ->
            if (active && armed) {
                val now = System.currentTimeMillis()
                if (now - lastTrackMs >= 1000) {
                    lastTrackMs = now
                    synchronized(track) {
                        track.addLast(doubleArrayOf(now.toDouble(), lat, lon, alt))
                        if (track.size > 7200) track.removeFirst()
                    }
                }
            }
        }
    }

    /** Drain-and-clear the buffered background track (oldest first). */
    fun drainTrack(): List<DoubleArray> = synchronized(track) {
        val out = track.toList(); track.clear(); out
    }

    /** true only while TelemetryService is running (i.e. someone is actually reading snapshots). */
    @Volatile var active = false

    /** Feed raw MAVLink bytes from a bridge's receive path. No-op while inactive. */
    fun feed(bytes: ByteArray) {
        if (!active) return
        synchronized(parser) { parser.push(bytes) }
    }

    fun snapshot(): MavNotifyParser.Snapshot = synchronized(parser) { parser.snapshot() }

    fun setMission(total: Int) {
        synchronized(parser) { parser.setMission(total) }
    }

    fun resetFlight() {
        synchronized(parser) { parser.resetFlight() }
    }
}
