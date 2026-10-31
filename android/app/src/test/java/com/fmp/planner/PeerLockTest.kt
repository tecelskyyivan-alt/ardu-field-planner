package com.fmp.planner

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PeerLockTest {
    private val drone = "192.0.2.101:14550"
    private val intruder = "192.0.2.66:14550"

    @Test fun another_host_cannot_take_over_while_the_drone_talks() {
        val lock = PeerLock(3000)
        assertTrue(lock.accept(drone, 0))
        assertFalse(lock.accept(intruder, 100))
        assertTrue(lock.accept(drone, 2500))
        assertFalse("hold counts from the drone's LAST packet", lock.accept(intruder, 5000))
    }

    @Test fun new_sender_wins_after_the_drone_goes_silent() {
        val lock = PeerLock(3000)
        lock.accept(drone, 0)
        assertTrue(lock.accept(intruder, 3000))   // e.g. backpack rebooted with a new port
        assertFalse(lock.accept(drone, 3100))
    }

    @Test fun reset_forgets_the_peer() {
        val lock = PeerLock(3000)
        lock.accept(drone, 0)
        lock.reset()
        assertTrue(lock.accept(intruder, 1))
    }
}
