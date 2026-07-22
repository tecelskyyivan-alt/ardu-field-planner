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
