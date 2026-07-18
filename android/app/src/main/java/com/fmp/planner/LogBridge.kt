package com.fmp.planner

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

/**
 * Uploads the app's diagnostic log to the VPS so it can be read + analysed
 * remotely. Exposed to the WebView as `window.AndroidLog.upload(jsonPayload)`.
 *
 * Native HTTP (not fetch) so the basic-auth header doesn't trigger a WebView CORS
 * preflight — which, being unauthenticated, would 401. Work runs off the JS thread
 * (a synchronous @JavascriptInterface call would freeze the UI); the immediate
 * result is delivered back to JS via `window.__logUploadResult(bool)`.
 *
 * STORE-AND-FORWARD: when there is no internet (offline in the field, or on the
 * backpack's internet-less WiFi with mobile data off), the payload is persisted to
 * a local on-disk queue and resent AUTOMATICALLY the moment a validated internet
 * network appears (ConnectivityManager callback) and on next app start — so a field
 * log is never lost. The queue is bounded (newest QUEUE_CAP kept) so it can't grow
 * without limit even if the auto-uploader keeps firing while offline.
 */
class LogBridge(private val ctx: Context, private val web: WebView) {

    private val ui = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()   // serialises all queue+network ops
    private val seq = AtomicLong(0)
    private val queueDir: File by lazy { File(ctx.filesDir, "logqueue").apply { mkdirs() } }

    companion object {
        private const val URL_STR = ""   // self-host: set your log endpoint to enable (empty = disabled)
        private const val AUTH = ""      // self-host: "user:pass" for the endpoint basic-auth
        private const val QUEUE_CAP = 40                   // max payloads kept on disk (newest wins)
    }

    init {
        // Resend anything left over from a previous session (if there's internet now),
        // and auto-flush whenever a validated internet network becomes available.
        io.execute { flushQueue() }
        try {
            val cm = ctx.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            val req = NetworkRequest.Builder()
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .addCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)   // only when internet is REAL
                .build()
            cm.registerNetworkCallback(req, object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) { io.execute { flushQueue() } }
            })
        } catch (e: Exception) { /* connectivity monitoring unavailable — flush still runs on each upload/start */ }
    }

    @JavascriptInterface
    fun upload(json: String): String {
        io.execute {
            val ok = post(json)
            if (ok) flushQueue()          // sent now → also drain any backlog
            else enqueue(json)            // no internet → keep it, resend later
            ui.post { web.evaluateJavascript("window.__logUploadResult&&window.__logUploadResult($ok)", null) }
        }
        return "{\"queued\":true}"
    }

    /** POST one payload. Returns true on HTTP 2xx. */
    private fun post(json: String): Boolean {
        return try {
            val con = URL(URL_STR).openConnection() as HttpURLConnection
            con.requestMethod = "POST"
            con.connectTimeout = 8000
            con.readTimeout = 10000
            con.doOutput = true
            con.setRequestProperty("Content-Type", "application/json")
            con.setRequestProperty(
                "Authorization",
                "Basic " + Base64.encodeToString(AUTH.toByteArray(), Base64.NO_WRAP)
            )
            con.outputStream.use { it.write(json.toByteArray(Charsets.UTF_8)) }
            val code = con.responseCode
            con.disconnect()
            code in 200..299
        } catch (e: Exception) {
            false
        }
    }

    /** Persist a payload to the on-disk queue, trimming to the newest QUEUE_CAP. */
    private fun enqueue(json: String) {
        try {
            val f = File(queueDir, "${System.currentTimeMillis()}-${seq.incrementAndGet()}.json")
            f.writeText(json, Charsets.UTF_8)
            val files = queueDir.listFiles()?.sortedBy { it.name } ?: return
            if (files.size > QUEUE_CAP) for (i in 0 until files.size - QUEUE_CAP) files[i].delete()
        } catch (e: Exception) { /* disk full / no dir — drop rather than crash */ }
    }

    /** Send queued payloads oldest-first; delete each on success, stop at the first
     *  failure (still offline — try again on the next connectivity event / start). */
    private fun flushQueue() {
        val files = try { queueDir.listFiles()?.sortedBy { it.name } } catch (e: Exception) { null } ?: return
        for (f in files) {
            val json = try { f.readText(Charsets.UTF_8) } catch (e: Exception) { f.delete(); continue }
            if (post(json)) f.delete() else break
        }
    }
}
