package com.fmp.planner

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
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
 *
 * Every inbound packet is also mirrored into TelemetryHub (the pinned live-telemetry notification,
 * #3) — a no-op when that service isn't running.
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
    // Well-known GCS/telemetry-bridge addresses to ALSO unicast the GCS heartbeat
    // to before we've learned the peer. Some bridges only start streaming after a
    // UNICAST packet at their own IP (a subnet broadcast isn't always enough).
    //   10.0.0.1  — ExpressLRS TX Backpack AP (documented) in MAVLink mode.
    //   192.168.4.1 — common ESP-based backpack/SoftAP default.
    private val knownPeers: List<InetAddress> = listOf(
        InetAddress.getByName("10.0.0.1"),
        InetAddress.getByName("192.168.4.1"),
    )
    // The phone's OWN addresses. Our GCS-heartbeat broadcast LOOPS BACK to our
    // own listening socket on some networks/Android builds; without this filter
    // the bridge "learns" ITSELF as the peer and then talks to itself forever —
    // the backpack never hears the GCS (field log: «ПЕРШИЙ пакет від 10.0.0.100»
    // where 10.0.0.100 was the phone). Never learn or count self-packets.
    private var ownAddrs: Set<InetAddress> = emptySet()
    @Volatile private var loggedSelfDrop = false
    @Volatile private var rxDumped = 0        // how many raw packets we've hex-dumped (diag)
    private var mcast: WifiManager.MulticastLock? = null

    // Diagnostics
    @Volatile private var rxPackets = 0L
    @Volatile private var rxBytes = 0L
    @Volatile private var txPackets = 0L
    @Volatile private var txBytes = 0L
    @Volatile private var loggedFirstRx = false
    @Volatile private var loggedFirstTx = false
    @Volatile private var openedAt = 0L
    private var lastSummary = 0L
    private var lastTxSummary = 0L
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
        txPackets = 0L; txBytes = 0L; lastTxSummary = 0L
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

        // (2b) FORCE this socket to EGRESS via WiFi. An ELRS backpack AP has NO internet,
        // so when mobile data is on, Android sends our uplink out the CELLULAR default
        // network — the backpack never receives it (its stats show «Packets Uplink: 0 /
        // GCS IP UNSET») even though downlink telemetry arrives fine over WiFi. Binding
        // the socket to the WiFi Network makes uplink go out WiFi regardless of mobile data.
        try {
            val cm = ctx.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            var wifiNet: Network? = null
            for (nw in cm.allNetworks) {
                val caps = cm.getNetworkCapabilities(nw) ?: continue
                if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) { wifiNet = nw; break }
            }
            if (wifiNet != null) {
                wifiNet.bindSocket(socket)
                dlog("сокет прив'язано до WiFi-мережі — uplink піде через WiFi навіть із увімкненими мобільними даними")
            } else {
                dlog("⚠ WiFi-мережу не знайдено для прив'язки — якщо ввімкнено мобільні дані, uplink може піти повз backpack; вимкни мобільні дані")
            }
        } catch (e: Exception) {
            dlog("прив'язка до WiFi не вдалась (${e.message}) — як обхід вимкни мобільні дані на телефоні")
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
            // Drop our own looped-back broadcasts BEFORE learning the peer.
            if (pkt.address in ownAddrs) {
                if (!loggedSelfDrop) {
                    loggedSelfDrop = true
                    dlog("ігнорую власний broadcast (${pkt.address?.hostAddress}) — чекаю пакети саме від backpack")
                }
                continue
            }
            remote = pkt.address                     // learn who the backpack/FC is
            remotePort = pkt.port
            rxPackets++
            rxBytes += pkt.length
            if (!loggedFirstRx) {
                loggedFirstRx = true
                dlog("✓ ПЕРШИЙ пакет: ${pkt.length} байт від ${pkt.address?.hostAddress}:${pkt.port} — телефон ОТРИМУЄ дані")
            }
            // DIAG: dump the raw bytes of the first few packets + decode the MAVLink
            // magic/msgid, so a non-parsing link ("no heartbeat" despite data) can be
            // pinned down — is it the vehicle's telemetry or just the ELRS link's own?
            if (rxDumped < 6 && pkt.length > 0) {
                rxDumped++
                val n = minOf(pkt.length, 40)
                val hex = StringBuilder()
                for (k in 0 until n) hex.append(String.format("%02x", pkt.data[k].toInt() and 0xff))
                val b0 = pkt.data[0].toInt() and 0xff
                val info = when (b0) {
                    0xFD -> { // MAVLink2: magic,len,inc,cmp,seq,sys,cmp,msgid(3)
                        val ln = pkt.data[1].toInt() and 0xff
                        val sys = pkt.data[5].toInt() and 0xff
                        val cmp = pkt.data[6].toInt() and 0xff
                        val mid = (pkt.data[7].toInt() and 0xff) or ((pkt.data[8].toInt() and 0xff) shl 8) or ((pkt.data[9].toInt() and 0xff) shl 16)
                        "MAVLink2 len=$ln sys=$sys comp=$cmp msgid=$mid"
                    }
                    0xFE -> {
                        val ln = pkt.data[1].toInt() and 0xff
                        val sys = pkt.data[3].toInt() and 0xff
                        val mid = pkt.data[5].toInt() and 0xff
                        "MAVLink1 len=$ln sys=$sys msgid=$mid"
                    }
                    else -> "НЕ MAVLink (перший байт 0x%02x)".format(b0)
                }
                dlog("пакет#$rxDumped [$info] hex=$hex")
            }
            val now = System.currentTimeMillis()
            if (now - lastSummary > 3000) {
                lastSummary = now
                dlog("rx: $rxPackets пакетів / $rxBytes байт, останній від ${pkt.address?.hostAddress}:${pkt.port}")
            }
            if (pkt.length > 0) {
                TelemetryHub.feed(pkt.data.copyOf(pkt.length))   // pinned notification tap (#3) — no-op unless running
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
                    txPackets++; txBytes += bytes.size
                    val now = System.currentTimeMillis()
                    if (now - lastTxSummary > 3000) { lastTxSummary = now; dlog("tx: $txPackets пакетів / $txBytes байт → ${peer.hostAddress}:$remotePort") }
                } else {
                    // No peer yet: blast the GCS heartbeat at every subnet broadcast
                    // (Android often drops the global 255.255.255.255) AND unicast it
                    // to the known bridge IPs (ELRS backpack 10.0.0.1 etc.) — some
                    // backpacks only start replying after a unicast at their own IP.
                    val targets = (if (subnetBroadcasts.isEmpty()) listOf(broadcast)
                                   else subnetBroadcasts + broadcast) + knownPeers
                    if (!loggedFirstTx) {
                        loggedFirstTx = true
                        dlog("tx→ ${targets.joinToString { it.hostAddress ?: "?" }}:$port (peer ще невідомий)")
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

    /** Every IPv4 interface's directed broadcast address (e.g. 192.168.4.255).
     *  Also records the phone's own IPv4s so recvLoop can drop looped-back
     *  self-broadcasts (see ownAddrs above). */
    private fun computeBroadcasts(): List<InetAddress> {
        val outs = ArrayList<InetAddress>()
        val own = HashSet<InetAddress>()
        try {
            val ifaces = NetworkInterface.getNetworkInterfaces() ?: return outs
            for (nif in ifaces) {
                try {
                    if (!nif.isUp || nif.isLoopback) continue
                    for (ia in nif.interfaceAddresses) {
                        if (ia.address is Inet4Address) own.add(ia.address)
                        val b = ia.broadcast ?: continue
                        if (ia.address is Inet4Address) {
                            outs.add(b)
                            dlog("iface ${nif.name}: ip=${ia.address.hostAddress}/${ia.networkPrefixLength} bcast=${b.hostAddress}")
                        }
                    }
                } catch (e: Exception) { /* skip this iface */ }
            }
        } catch (e: Exception) { dlog("перелік інтерфейсів: ${e.message}") }
        ownAddrs = own
        loggedSelfDrop = false
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
