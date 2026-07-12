package com.fmp.planner

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.SocketTimeoutException
import java.util.concurrent.Executors

/**
 * UDP-over-WiFi MAVLink bridge exposed to the WebView as `window.AndroidUdp`.
 *
 * The whole point: an ExpressLRS TX Backpack in MAVLink mode forwards MAVLink
 * over WiFi UDP (port 14550). A browser/WebView can't open a raw UDP socket, so
 * this native bridge does it — letting the phone (joined to the backpack's WiFi)
 * act as a wireless ground station over the ELRS link.
 *
 * Binds 0.0.0.0:port and listens. It learns the remote (backpack/FC) address
 * from the first incoming packet; until then, outgoing GCS packets are sent to
 * the subnet broadcast so the backpack learns us and starts replying.
 *
 * WiFi gotchas this handles (were the reason "cable works, WiFi doesn't"):
 *   • Android's WiFi driver DROPS incoming broadcast/multicast UDP to save power
 *     unless a WifiManager.MulticastLock is held. An ELRS backpack that BROADCASTS
 *     MAVLink was therefore invisible — zero packets reached the app. We now hold a
 *     MulticastLock while the socket is open (needs CHANGE_WIFI_MULTICAST_STATE).
 *   • Global broadcast 255.255.255.255 is often NOT delivered by Android; the GCS
 *     heartbeat must go to the SUBNET-directed broadcast (e.g. 192.168.4.255). We
 *     send to every interface broadcast we can find, plus 255.255.255.255.
 *
 * Every step is logged to the app's diagnostic log via window.__fmpNativeLog so a
 * failed connection shows EXACTLY where it breaks (bind / 0 packets / peer / tx).
 *
 * JS contract:
 *   AndroidUdp.open(port) -> JSON {ok} | {ok:false,error}
 *        ...also fires window.__androidUdpEvent('open', <bool>, '<detail>')
 *   AndroidUdp.write(base64)
 *   AndroidUdp.close()
 *   incoming bytes -> window.__androidUdpData('<base64>')
 */
class UdpBridge(private val ctx: Context, private val web: WebView) {

    private val ui = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    @Volatile private var socket: DatagramSocket? = null
    @Volatile private var recvThread: Thread? = null
    @Volatile private var remote: InetAddress? = null
    @Volatile private var remotePort = 0
    private var port = 14550
    private val broadcast: InetAddress = InetAddress.getByName("255.255.255.255")
    private var subnetBroadcasts: List<InetAddress> = emptyList()
    private var mcast: WifiManager.MulticastLock? = null

    // Diagnostics
    @Volatile private var rxPackets = 0L
    @Volatile private var rxBytes = 0L
    @Volatile private var loggedFirstRx = false
    @Volatile private var loggedFirstTx = false
    @Volatile private var openedAt = 0L
    private var lastSummary = 0L
    private var idleStage = 0

    // ------------------------------------------------------------- diagnostics
    private fun dlog(msg: String) {
        Log.i("FMP-UDP", msg)
        val arg = JSONObject.quote("[udp] $msg")
        ui.post { web.evaluateJavascript("window.__fmpNativeLog&&window.__fmpNativeLog($arg)", null) }
    }

    // ------------------------------------------------------------------- open
    @JavascriptInterface
    fun open(p: Int): String {
        close()
        port = if (p > 0) p else 14550
        rxPackets = 0L; rxBytes = 0L; loggedFirstRx = false; loggedFirstTx = false
        idleStage = 0; lastSummary = 0L
        openedAt = System.currentTimeMillis()

        // (1) Hold a MulticastLock so the WiFi driver stops filtering broadcast/
        // multicast UDP — otherwise a broadcasting backpack is invisible.
        try {
            val wifi = ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            val lock = wifi.createMulticastLock("fmp-udp")
            lock.setReferenceCounted(false)
            lock.acquire()
            mcast = lock
            dlog("MulticastLock отримано (broadcast/multicast приймаються)")
        } catch (e: Exception) {
            dlog("MulticastLock НЕ отримано: ${e.message} — broadcast-телеметрію може бути відкинуто")
        }

        // (2) Open the listening socket.
        try {
            val s = DatagramSocket(null)
            s.reuseAddress = true
            s.broadcast = true
            s.soTimeout = 2000                     // wake periodically so we can log "0 packets"
            s.bind(InetSocketAddress(port))        // 0.0.0.0:port — all interfaces (the WiFi one)
            socket = s
        } catch (e: Exception) {
            dlog("bind :$port ПОМИЛКА — ${e.message}")
            releaseMcast()
            return err("Не вдалося відкрити UDP :$port — ${e.message}")
        }

        // (3) Figure out where to send GCS heartbeats before we learn the peer.
        subnetBroadcasts = computeBroadcasts()
        val bcs = if (subnetBroadcasts.isEmpty()) "(жодного — тільки 255.255.255.255)"
                  else subnetBroadcasts.joinToString { it.hostAddress ?: "?" }
        dlog("сокет слухає 0.0.0.0:$port. Підмережеві broadcast: $bcs")
        dlog("чекаю пакети від backpack… (heartbeat GCS шлю на broadcast)")

        val t = Thread { recvLoop() }
        t.isDaemon = true
        recvThread = t
        t.start()
        event("open", true, "")
        return JSONObject().put("ok", true).toString()
    }

    private fun recvLoop() {
        val buf = ByteArray(2048)
        val s = socket ?: return
        while (socket === s && !s.isClosed) {
            val pkt = DatagramPacket(buf, buf.size)
            try {
                s.receive(pkt)                       // blocks up to soTimeout
            } catch (te: SocketTimeoutException) {
                logIdle()
                continue
            } catch (e: Exception) {
                if (socket === s && !s.isClosed) continue else break
            }
            remote = pkt.address                     // learn who the backpack/FC is
            remotePort = pkt.port
            rxPackets++
            rxBytes += pkt.length
            if (!loggedFirstRx) {
                loggedFirstRx = true
                dlog("✓ ПЕРШИЙ пакет: ${pkt.length} байт від ${pkt.address?.hostAddress}:${pkt.port} — телефон ОТРИМУЄ дані")
            }
            val now = System.currentTimeMillis()
            if (now - lastSummary > 3000) {
                lastSummary = now
                dlog("rx: $rxPackets пакетів / $rxBytes байт, останній від ${pkt.address?.hostAddress}:${pkt.port}")
            }
            if (pkt.length > 0) {
                // JSON-quote the (remote) bytes — injection-proof vs splicing into '...'.
                val arg = JSONObject.quote(Base64.encodeToString(pkt.data, 0, pkt.length, Base64.NO_WRAP))
                ui.post { web.evaluateJavascript("window.__androidUdpData&&window.__androidUdpData($arg)", null) }
            }
        }
    }

    /** Log escalating warnings while NO packet has arrived, so the log tells the story. */
    private fun logIdle() {
        if (rxPackets > 0L) return
        val secs = (System.currentTimeMillis() - openedAt) / 1000
        val stage = when {
            secs >= 20 -> 3
            secs >= 10 -> 2
            secs >= 4 -> 1
            else -> 0
        }
        if (stage > idleStage) {
            idleStage = stage
            dlog("⚠ 0 пакетів за ~${secs}с — у телефон НІЧОГО не надходить. Перевір: телефон у WiFi мережі backpack? backpack у режимі MAVLink? порт $port правильний? (кабель для порівняння працює)")
        }
    }

    @JavascriptInterface
    fun write(b64: String) {
        val s = socket ?: return
        io.execute {
            try {
                val bytes = Base64.decode(b64, Base64.NO_WRAP)
                val peer = remote
                if (peer != null) {
                    if (!loggedFirstTx) { loggedFirstTx = true; dlog("tx→ peer ${peer.hostAddress}:$remotePort") }
                    s.send(DatagramPacket(bytes, bytes.size, peer, remotePort))
                } else {
                    // No peer yet: blast the GCS heartbeat at every subnet broadcast
                    // (Android often drops the global 255.255.255.255) so the backpack
                    // hears us and starts replying.
                    val targets = if (subnetBroadcasts.isEmpty()) listOf(broadcast)
                                  else subnetBroadcasts + broadcast
                    if (!loggedFirstTx) {
                        loggedFirstTx = true
                        dlog("tx→ broadcast ${targets.joinToString { it.hostAddress ?: "?" }}:$port (peer ще невідомий)")
                    }
                    for (tgt in targets) {
                        try { s.send(DatagramPacket(bytes, bytes.size, tgt, port)) } catch (e: Exception) {}
                    }
                }
            } catch (e: Exception) { /* transient */ }
        }
    }

    @JavascriptInterface
    fun close() {
        val s = socket
        socket = null
        remote = null
        if (s != null && rxPackets == 0L && openedAt > 0L) {
            dlog("закрито: 0 пакетів отримано за весь сеанс — WiFi-лінк не приніс телеметрії")
        } else if (s != null) {
            dlog("закрито: $rxPackets пакетів / $rxBytes байт отримано")
        }
        try { s?.close() } catch (e: Exception) {}
        recvThread = null
        releaseMcast()
    }

    private fun releaseMcast() {
        try { mcast?.let { if (it.isHeld) it.release() } } catch (e: Exception) {}
        mcast = null
    }

    /** Every IPv4 interface's directed broadcast address (e.g. 192.168.4.255). */
    private fun computeBroadcasts(): List<InetAddress> {
        val outs = ArrayList<InetAddress>()
        try {
            val ifaces = NetworkInterface.getNetworkInterfaces() ?: return outs
            for (nif in ifaces) {
                try {
                    if (!nif.isUp || nif.isLoopback) continue
                    for (ia in nif.interfaceAddresses) {
                        val b = ia.broadcast ?: continue
                        if (ia.address is Inet4Address) {
                            outs.add(b)
                            dlog("iface ${nif.name}: ip=${ia.address.hostAddress}/${ia.networkPrefixLength} bcast=${b.hostAddress}")
                        }
                    }
                } catch (e: Exception) { /* skip this iface */ }
            }
        } catch (e: Exception) { dlog("перелік інтерфейсів: ${e.message}") }
        return outs
    }

    private fun event(type: String, ok: Boolean, detail: String) {
        val d = detail.replace("\\", "\\\\").replace("'", "\\'").replace("\n", " ").replace("\r", " ")
        ui.post {
            web.evaluateJavascript("window.__androidUdpEvent&&window.__androidUdpEvent('$type',$ok,'$d')", null)
        }
    }

    private fun err(msg: String): String =
        JSONObject().put("ok", false).put("error", msg).toString()
}
