package com.fmp.planner

import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * Native transport for the #10 backup-sync, exposed as `window.AndroidSync`.
 *
 * The WebView serves the app from local assets, so a plain JS fetch to the operator's server is
 * CROSS-origin: the basic-auth header would force a CORS preflight the server answers 401 to —
 * sync was dead on the APK («сервер не налаштовано»). Same cure as LogBridge: native HTTP has no
 * CORS and carries the auth header directly.
 *
 * JS contract (mirrors the fetch path in app.js syncCall):
 *   AndroidSync.available() -> boolean            (BASE baked into this build?)
 *   AndroidSync.call(path, jsonBody)              path ∈ {/api/sync, /api/sync_get} (whitelist)
 *        → async; response body JSON (or null on failure) via window.__syncResult('<body>')
 *
 * PUBLIC-REPO SANITIZATION: BASE/AUTH are EMPTY here — the feature is inert unless a self-hoster
 * bakes their own server into their build (exactly like LogBridge/UpdateBridge). Never commit
 * real credentials to this file.
 */
class SyncBridge(private val web: WebView) {

    private val ui = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()

    companion object {
        private const val BASE = ""       // self-host: e.g. "https://your.server/ai"
        private const val AUTH = ""       // self-host: "user:password" for basic-auth, or ""
        private val PATHS = setOf("/api/sync", "/api/sync_get")
    }

    @JavascriptInterface
    fun available(): Boolean = BASE.isNotEmpty()

    @JavascriptInterface
    fun call(path: String, jsonBody: String): String {
        if (BASE.isEmpty() || path !in PATHS) {
            deliver(null); return "{\"ok\":false}"
        }
        io.execute {
            val body = try {
                val con = URL(BASE + path).openConnection() as HttpURLConnection
                con.requestMethod = "POST"
                con.connectTimeout = 8000
                con.readTimeout = 15000
                con.doOutput = true
                con.setRequestProperty("Content-Type", "application/json")
                if (AUTH.isNotEmpty())
                    con.setRequestProperty("Authorization",
                        "Basic " + Base64.encodeToString(AUTH.toByteArray(), Base64.NO_WRAP))
                con.outputStream.use { it.write(jsonBody.toByteArray()) }
                val ok = con.responseCode in 200..299
                val text = (if (ok) con.inputStream else con.errorStream)
                    ?.bufferedReader()?.use { it.readText() }
                con.disconnect()
                if (ok) text else null
            } catch (e: Exception) { null }
            deliver(body)
        }
        return "{\"pending\":true}"
    }

    // Deliver the raw response body (or null) to JS, JSON-quoted so remote bytes can't break out.
    private fun deliver(body: String?) {
        val arg = if (body == null) "null" else JSONObject.quote(body)
        ui.post { try { web.evaluateJavascript("window.__syncResult&&window.__syncResult($arg)", null) } catch (e: Exception) {} }
    }
}
