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

    // Minor fix (1 Hz identical re-post): cache the previous tick's rendered title+text so the
    // ticker can skip nm.notify() entirely when nothing visible changed — notify() forces SystemUI
    // to re-process the ongoing row even for a byte-identical Notification.
    private var lastTitle: String? = null
    private var lastText: String? = null

    private val ticker = object : Runnable {
        override fun run() {
            renderIfChanged()
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
        startForeground(NOTIF_ID, render())
        if (!ticking) {
            ticking = true
            ui.post(ticker)
        }
        // Minor fix (START_STICKY zombie): this service is useless on its own — it only renders
        // TelemetryHub's shared parser state, which lives in-process alongside the WebView and the
        // MAVLink bridges. If the OS kills the whole process and STICKY resurrects just this service,
        // there is no WebView/bridges to repopulate it (blank "FMP — — · 00:00" zombie notification,
        // or a startForeground() crash-loop on API 31+ background-FGS policy). NOT_STICKY lets it die
        // with the process; JS starts it again via NotifyBridge on the next real MAVLink connect.
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        ticking = false
        ui.removeCallbacks(ticker)
        TelemetryHub.active = false
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    /** Renders the current snapshot, updates the last-posted cache (so a subsequent tick can tell
     *  it's unchanged), and returns the Notification — used for the mandatory startForeground()
     *  call, which must always post regardless of the cache. */
    private fun render(): Notification {
        val s = TelemetryHub.snapshot()
        val title = computeTitle(s)
        val text = buildText(s)
        lastTitle = title
        lastText = text
        return buildNotification(title, text)
    }

    /** 1 Hz ticker path (minor fix): skip nm.notify() entirely when this tick's title+text are
     *  byte-identical to the previous tick's — avoids ~3600 redundant SystemUI re-posts/hour plus
     *  their PendingIntent construction while connected-but-idle. */
    private fun renderIfChanged() {
        val s = TelemetryHub.snapshot()
        val title = computeTitle(s)
        val text = buildText(s)
        if (title == lastTitle && text == lastText) return
        lastTitle = title
        lastText = text
        nm.notify(NOTIF_ID, buildNotification(title, text))
    }

    /** Staleness fix (IMPORTANT finding): once the parser hasn't seen a CRC-verified frame for
     *  STALE_MS, the title stops claiming a live mode/armed state (which would just be the last
     *  values seen before the link died) and instead surfaces the outage explicitly, with the
     *  outage duration so the operator can judge how long they've been flying blind. */
    private fun computeTitle(s: MavNotifyParser.Snapshot): String {
        val age = s.ageMs
        val stale = age == null || age >= STALE_MS
        if (!stale) return "FMP — ${s.modeName}" + (if (s.armed == true) " · ARMED" else "")
        val secs = age?.let { it / 1000 }
        return if (secs != null) "⚠ немає звʼязку (${secs}с)" else "⚠ немає звʼязку"
    }

    /** Telemetry line intentionally renders the last-known values AS-IS even while stale (see
     *  computeTitle above) — NotificationCompat's plain setContentText has no practical way to
     *  "dim" part of the text without a Spannable, and the title already carries the staleness
     *  warning, so duplicating it in the body would add complexity for no extra operator signal. */
    private fun buildNotification(title: String, text: String): Notification {
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
            .setContentText(text)
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
        // IMPORTANT staleness finding: no CRC-verified frame for this long -> notification goes stale.
        private const val STALE_MS = 10_000L
    }
}
