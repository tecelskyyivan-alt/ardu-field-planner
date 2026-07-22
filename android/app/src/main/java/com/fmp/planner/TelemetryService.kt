package com.fmp.planner

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import java.util.Locale

/**
 * Foreground service behind the pinned live-telemetry notification (#3 — a music-player-style
 * ongoing notification). While the phone screen is off / FMP is backgrounded mid-flight, this
 * keeps a silent, LOW-importance notification alive showing mode/battery/altitude/speed/waypoint
 * progress/flight-time — refreshed once a second from TelemetryHub.snapshot() — so the operator
 * can glance at the lock screen, AND so Android treats the process as foreground and doesn't kill
 * the MAVLink bridges for being "just background work".
 *
 * Started/stopped from JS via NotifyBridge (`window.AndroidNotify`); never called directly by the
 * bridges. Tapping the notification reopens MainActivity (singleTop — resumes the running WebView
 * instead of recreating it).
 */
class TelemetryService : Service() {

    private val ui = Handler(Looper.getMainLooper())
    private lateinit var nm: NotificationManager
    private var ticking = false

    private val ticker = object : Runnable {
        override fun run() {
            nm.notify(NOTIF_ID, buildNotification())
            if (ticking) ui.postDelayed(this, 1000L)
        }
    }

    override fun onCreate() {
        super.onCreate()
        nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(CHANNEL_ID, "Телеметрія польоту", NotificationManager.IMPORTANCE_LOW)
            ch.description = "Постійне сповіщення з польотними даними, поки FMP працює у фоні."
            ch.setShowBadge(false)
            ch.enableVibration(false)
            ch.setSound(null, null)
            nm.createNotificationChannel(ch)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        TelemetryHub.active = true
        startForeground(NOTIF_ID, buildNotification())
        if (!ticking) {
            ticking = true
            ui.post(ticker)
        }
        return START_STICKY
    }

    override fun onDestroy() {
        ticking = false
        ui.removeCallbacks(ticker)
        TelemetryHub.active = false
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun buildNotification(): Notification {
        val s = TelemetryHub.snapshot()
        val title = "FMP — ${s.modeName}" + (if (s.armed == true) " · ARMED" else "")

        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK
        }
        val contentIntent = PendingIntent.getActivity(
            this, 0, openIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val stopIntent = PendingIntent.getService(
            this, 0,
            Intent(this, TelemetryService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        // No monochrome status-bar icon exists in res/ yet (only the color mipmap launcher) —
        // the platform stat_notify_sync glyph is the documented fallback until one is added.
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(buildText(s))
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentIntent(contentIntent)
            .addAction(0, "Стоп", stopIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setShowWhen(false)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    /** e.g. "🔋 12.6V 75% · ↑12м · 8.5м/с · WP 5/24 (21%) · 03:12" — omits fields the parser
     *  hasn't seen yet (null in the snapshot); flight time (never null) is always shown. */
    private fun buildText(s: MavNotifyParser.Snapshot): String {
        val parts = ArrayList<String>()
        if (s.battV != null || s.battPct != null) {
            val v = if (s.battV != null) String.format(Locale.US, "%.1fV", s.battV) else null
            val p = if (s.battPct != null) "${s.battPct}%" else null
            parts.add("🔋 " + listOfNotNull(v, p).joinToString(" "))
        }
        if (s.altM != null) parts.add("↑${Math.round(s.altM)}м")
        if (s.gsMs != null) parts.add(String.format(Locale.US, "%.1fм/с", s.gsMs))
        if (s.wpSeq != null) {
            val total = if (s.wpTotal != null) "/${s.wpTotal}" else ""
            val pct = if (s.progressPct != null) " (${s.progressPct}%)" else ""
            parts.add("WP ${s.wpSeq}$total$pct")
        }
        val mm = s.flightSec / 60
        val ss = s.flightSec % 60
        parts.add(String.format(Locale.US, "%02d:%02d", mm, ss))
        return parts.joinToString(" · ")
    }

    companion object {
        const val CHANNEL_ID = "fmp_telemetry"
        const val ACTION_STOP = "com.fmp.planner.action.STOP_TELEMETRY"
        private const val NOTIF_ID = 1001
    }
}
