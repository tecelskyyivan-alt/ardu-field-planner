package com.fmp.planner

import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import java.net.HttpURLConnection
import java.net.URL

/**
 * Uploads the app's diagnostic log to the VPS so it can be read + analysed
 * remotely. Exposed to the WebView as `window.AndroidLog.upload(jsonPayload)`.
 *
 * Native HTTP (not fetch) so the basic-auth header doesn't trigger a WebView CORS
 * preflight — which, being unauthenticated, Caddy would 401. The work runs on a
 * background thread (a synchronous @JavascriptInterface call would otherwise block
 * the JS thread and freeze the UI); the result is delivered back to JS via
 * `window.__logUploadResult(bool)`.
 */
class LogBridge(private val web: WebView) {

    private val ui = Handler(Looper.getMainLooper())

    companion object {
        private const val URL_STR = ""   // self-host: set your log endpoint to enable (empty = disabled)
        private const val AUTH = ""      // self-host: "user:pass" for the endpoint basic-auth
    }

    @JavascriptInterface
    fun upload(json: String): String {
        Thread {
            val ok = try {
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
            ui.post {
                web.evaluateJavascript(
                    "window.__logUploadResult&&window.__logUploadResult($ok)", null
                )
            }
        }.start()
        return "{\"queued\":true}"
    }
}
