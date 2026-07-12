package com.fmp.planner

import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * In-app self-update for the native APK, exposed as `window.AndroidUpdate`.
 *
 * The APK can't auto-update like the PWA, so this lets the operator update from
 * inside: `check()` reads the server's version.json (native HTTP + basic-auth, no
 * CORS), and `download()` fetches the new APK via the system DownloadManager
 * (auth header attached) AND, when the download finishes, AUTOMATICALLY launches
 * the system installer (no need to tap the notification). The user only confirms
 * the install (and grants "install unknown apps" the first time).
 *
 *   AndroidUpdate.check()    -> fires window.__updateCheckResult('<version>')
 *   AndroidUpdate.download()  -> {ok:true} | {ok:false,error}
 */
class UpdateBridge(private val ctx: Context, private val web: WebView) {

    private val ui = Handler(Looper.getMainLooper())
    // The side-by-side BETA build (applicationId …​.beta) self-updates from its OWN
    // version source + APK, so it never offers/installs the stable build by mistake.
    private val isBeta = ctx.packageName.endsWith(".beta")
    private fun versionUrl() = BASE + if (isBeta) "/beta-version.json" else "/version.json"
    private fun apkUrl() = BASE + if (isBeta) "/downloads/FieldMissionPlanner-beta.apk"
                                  else "/downloads/FieldMissionPlanner.apk"

    companion object {
        private const val BASE = ""     // self-host: set your update server (empty = self-update disabled)
        private const val AUTH = ""      // self-host: "user:pass" for the endpoint basic-auth
        private fun authHeader() = "Basic " + Base64.encodeToString(AUTH.toByteArray(), Base64.NO_WRAP)
    }

    @JavascriptInterface
    fun check(): String {
        Thread {
            val ver = try {
                val con = URL(versionUrl()).openConnection() as HttpURLConnection
                con.setRequestProperty("Authorization", authHeader())
                con.connectTimeout = 8000
                con.readTimeout = 8000
                val txt = con.inputStream.bufferedReader().use { it.readText() }
                con.disconnect()
                JSONObject(txt).optString("version", "")
            } catch (e: Exception) {
                ""
            }
            ui.post {
                web.evaluateJavascript(
                    "window.__updateCheckResult&&window.__updateCheckResult(${JSONObject.quote(ver)})", null
                )
            }
        }.start()
        return "{\"queued\":true}"
    }

    @JavascriptInterface
    fun download(): String {
        // The download URL is built HERE, never taken from JS — so a compromised
        // page can only ever mean "fetch the official update", not choose the source.
        return try {
            val dm = ctx.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
            val req = DownloadManager.Request(Uri.parse(apkUrl()))
            req.addRequestHeader("Authorization", authHeader())
            req.setMimeType("application/vnd.android.package-archive")
            req.setTitle((if (isBeta) "FMP BETA" else "Field Mission Planner") + " — оновлення")
            req.setDescription("Завантаження нової версії…")
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            req.setDestinationInExternalPublicDir(
                Environment.DIRECTORY_DOWNLOADS,
                if (isBeta) "FieldMissionPlanner-beta-update.apk" else "FieldMissionPlanner-update.apk"
            )
            val id = dm.enqueue(req)
            registerAutoInstall(dm, id)
            "{\"ok\":true}"
        } catch (e: Exception) {
            JSONObject().put("ok", false).put("error", e.message ?: "download failed").toString()
        }
    }

    /** When THIS download finishes, fire the system installer automatically. */
    private fun registerAutoInstall(dm: DownloadManager, id: Long) {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context, intent: Intent) {
                if (intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L) != id) return
                try { c.applicationContext.unregisterReceiver(this) } catch (e: Exception) {}
                // Only install on a SUCCESSFUL download.
                try {
                    dm.query(DownloadManager.Query().setFilterById(id)).use { cur ->
                        if (cur != null && cur.moveToFirst()) {
                            val st = cur.getInt(cur.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
                            if (st != DownloadManager.STATUS_SUCCESSFUL) return
                        } else return
                    }
                } catch (e: Exception) { return }
                val uri: Uri = try { dm.getUriForDownloadedFile(id) ?: return } catch (e: Exception) { return }
                val install = Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(uri, "application/vnd.android.package-archive")
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                try { c.startActivity(install) } catch (e: Exception) {}
            }
        }
        val filter = IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE)
        // Android 13+ requires an export flag for dynamically-registered receivers.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ctx.applicationContext.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            ctx.applicationContext.registerReceiver(receiver, filter)
        }
    }
}
