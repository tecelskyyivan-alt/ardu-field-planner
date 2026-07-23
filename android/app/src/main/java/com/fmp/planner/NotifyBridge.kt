package com.fmp.planner

import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject

/**
 * Starts/stops TelemetryService — the pinned live-telemetry notification (#3) — exposed to the
 * WebView as `window.AndroidNotify`.
 *
 * JS contract:
 *   AndroidNotify.start()        -> JSON {ok,pending}. Requests POST_NOTIFICATIONS at runtime
 *                                    (API 33+) then starts the foreground service regardless of
 *                                    that permission's outcome (only the visible notification is
 *                                    lost if denied — the MAVLink link must keep running either
 *                                    way). On the very first ever start, also fires the
 *                                    battery-optimization-exemption dialog so Android doesn't
 *                                    freeze the app in the background mid-flight.
 *   AndroidNotify.stop()         -> stops the service.
 *   AndroidNotify.setMission(n)  -> TelemetryHub.setMission(n)
 *   AndroidNotify.resetFlight()  -> TelemetryHub.resetFlight()
 *   AndroidNotify.isRunning()    -> boolean
 */
class NotifyBridge(private val act: MainActivity, @Suppress("unused") private val web: WebView) {

    private val prefs: SharedPreferences = act.getSharedPreferences("fmp_notify", Context.MODE_PRIVATE)

    @JavascriptInterface
    fun start(): String {
        // Start the service IMMEDIATELY — its foreground protection (MAVLink bridges staying
        // alive in the background) must not wait on the pilot noticing the permission dialog.
        // POST_NOTIFICATIONS is requested fire-and-forget: a denial (or a dialog ignored for a
        // minute) only means the pinned notification itself isn't visible. (review Important)
        startServiceNow()
        act.requestNotifyPermission { _ -> maybeRequestBatteryExemption() }
        return JSONObject().put("ok", true).put("pending", true).toString()
    }

    private fun startServiceNow() {
        try {
            val i = Intent(act, TelemetryService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) act.startForegroundService(i)
            else act.startService(i)
        } catch (e: Exception) {
            // OEM background-start restriction or similar — nothing more we can do from here;
            // Ivan validates real-device behaviour.
        }
    }

    @JavascriptInterface
    fun stop() {
        try { act.stopService(Intent(act, TelemetryService::class.java)) } catch (e: Exception) {}
    }

    @JavascriptInterface
    fun setMission(total: Int) {
        TelemetryHub.setMission(total)
    }

    @JavascriptInterface
    fun resetFlight() {
        TelemetryHub.resetFlight()
    }

    @JavascriptInterface
    fun isRunning(): Boolean = TelemetryHub.active

    /** Background flown-track buffer: JSON [[tMs,lat,lng,relAltM],...] recorded by the native
     *  parser while the WebView was frozen (screen off). Drain-and-clear — JS backfills the map
     *  track + flight record from it on resume. */
    @JavascriptInterface
    fun drainTrack(): String {
        val arr = org.json.JSONArray()
        for (s4 in TelemetryHub.drainTrack()) {
            val row = org.json.JSONArray()
            row.put(s4[0].toLong()); row.put(s4[1]); row.put(s4[2]); row.put(s4[3])
            arr.put(row)
        }
        return arr.toString()
    }

    /** First-ever start only: ask to be exempted from Doze/App-Standby battery restrictions so
     *  Android doesn't freeze the MAVLink link mid-flight. Some OEMs block this intent entirely
     *  (MIUI etc.) — never fatal, the operator can still grant it manually in Settings. */
    private fun maybeRequestBatteryExemption() {
        if (prefs.getBoolean(KEY_ASKED_BATTERY, false)) return
        prefs.edit().putBoolean(KEY_ASKED_BATTERY, true).apply()
        try {
            val i = Intent(
                Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                Uri.parse("package:" + act.packageName)
            )
            act.startActivity(i)
        } catch (e: Exception) { /* OEM blocks it — ignore */ }
    }

    companion object {
        private const val KEY_ASKED_BATTERY = "asked_battery_opt"
    }
}
