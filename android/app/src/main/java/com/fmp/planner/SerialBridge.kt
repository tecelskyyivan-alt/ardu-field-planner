package com.fmp.planner

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import com.hoho.android.usbserial.driver.UsbSerialPort
import com.hoho.android.usbserial.driver.UsbSerialProber
import com.hoho.android.usbserial.util.SerialInputOutputManager
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * USB-serial bridge exposed to the WebView as `window.AndroidSerial`.
 *
 * Uses usb-serial-for-android, which drives CDC-ACM (STM32 virtual COM — the
 * common case for Betaflight / INAV / ArduPilot boards and Pixhawk) as well as
 * FTDI / CP210x / CH340 / PL2303 bridges. This is exactly the capability the
 * browser lacks on Android (the OS claims the CDC interface), so it's the whole
 * reason this native shell exists.
 *
 * JS contract:
 *   AndroidSerial.listDevices() -> JSON [{id,vid,pid,name,driver}]
 *   AndroidSerial.connect(id, baud) -> JSON {ok,pending} | {ok:false,immediate,error}
 *        ...later fires window.__androidSerialEvent('open', <bool>, '<detail>')
 *   AndroidSerial.write(base64)
 *   AndroidSerial.close()
 *   incoming bytes -> window.__androidSerialData('<base64>')
 *
 * Every inbound chunk is also mirrored into TelemetryHub (the pinned live-telemetry notification,
 * #3) — a no-op when that service isn't running.
 */
class SerialBridge(
    private val ctx: Context,
    private val web: WebView
) : SerialInputOutputManager.Listener {

    private val usb = ctx.getSystemService(Context.USB_SERVICE) as UsbManager
    private val ui = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private var port: UsbSerialPort? = null
    private var ioManager: SerialInputOutputManager? = null

    companion object {
        private const val ACTION_PERM = "com.fmp.planner.USB_PERMISSION"
    }

    @JavascriptInterface
    fun listDevices(): String {
        val arr = JSONArray()
        val prober = UsbSerialProber.getDefaultProber()
        for (dev in usb.deviceList.values) {
            val driver = prober.probeDevice(dev)
            arr.put(
                JSONObject()
                    .put("id", dev.deviceId)
                    .put("vid", String.format("%04x", dev.vendorId))
                    .put("pid", String.format("%04x", dev.productId))
                    .put("name", dev.productName ?: ("USB " + String.format("%04x:%04x", dev.vendorId, dev.productId)))
                    .put("driver", driver != null)
            )
        }
        return arr.toString()
    }

    @JavascriptInterface
    fun connect(deviceId: Int, baud: Int): String {
        val dev = usb.deviceList.values.firstOrNull { it.deviceId == deviceId }
            ?: usb.deviceList.values.firstOrNull()
            ?: return err("USB-пристрій не знайдено. Під'єднай політник кабелем (OTG) і онови список.")
        val b = if (baud <= 0) 115200 else baud
        if (usb.hasPermission(dev)) {
            io.execute { doOpen(dev, b) }
        } else {
            requestPermission(dev, b)
        }
        return JSONObject().put("ok", true).put("pending", true).toString()
    }

    private fun requestPermission(dev: UsbDevice, baud: Int) {
        val rcv = object : BroadcastReceiver() {
            override fun onReceive(c: Context, intent: Intent) {
                if (intent.action != ACTION_PERM) return
                try { ctx.unregisterReceiver(this) } catch (_: Exception) {}
                val granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
                if (granted) io.execute { doOpen(dev, baud) }
                else event("open", false, "Доступ до USB не надано.")
            }
        }
        val filter = IntentFilter(ACTION_PERM)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
            ctx.registerReceiver(rcv, filter, Context.RECEIVER_NOT_EXPORTED)
        else
            @Suppress("UnspecifiedRegisterReceiverFlag") ctx.registerReceiver(rcv, filter)
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
            PendingIntent.FLAG_MUTABLE else 0
        val pi = PendingIntent.getBroadcast(
            ctx, 0, Intent(ACTION_PERM).setPackage(ctx.packageName), flags
        )
        usb.requestPermission(dev, pi)
    }

    private fun doOpen(dev: UsbDevice, baud: Int) {
        try {
            close()
            val driver = UsbSerialProber.getDefaultProber().probeDevice(dev)
                ?: return event("open", false, "Невідомий USB-serial чип (немає драйвера).")
            val connection = usb.openDevice(dev)
                ?: return event("open", false, "Не вдалося відкрити USB-пристрій.")
            val p = driver.ports[0]
            p.open(connection)
            p.setParameters(baud, 8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE)
            try { p.dtr = true; p.rts = true } catch (_: Exception) {}
            port = p
            val mgr = SerialInputOutputManager(p, this)
            ioManager = mgr
            mgr.start()
            event("open", true, "")
        } catch (e: Exception) {
            event("open", false, e.message ?: "Помилка відкриття USB-порту.")
            close()
        }
    }

    @JavascriptInterface
    fun write(b64: String) {
        val p = port ?: return
        io.execute {
            try { p.write(Base64.decode(b64, Base64.NO_WRAP), 2000) } catch (_: Exception) {}
        }
    }

    @JavascriptInterface
    fun close() {
        try { ioManager?.stop() } catch (_: Exception) {}
        ioManager = null
        try { port?.close() } catch (_: Exception) {}
        port = null
    }

    // ---- SerialInputOutputManager.Listener ----
    override fun onNewData(data: ByteArray) {
        if (data.isEmpty()) return
        TelemetryHub.feed(data)     // pinned notification tap (#3) — no-op unless the service is running
        // JSON-quote the (remote, attacker-controlled) bytes instead of splicing them
        // into a '...' literal — injection-proof regardless of the encoder.
        val arg = JSONObject.quote(Base64.encodeToString(data, Base64.NO_WRAP))
        ui.post { web.evaluateJavascript("window.__androidSerialData&&window.__androidSerialData($arg)", null) }
    }

    override fun onRunError(e: Exception) {
        event("error", false, e.message ?: "Звʼязок з USB втрачено.")
        close()
    }

    private fun event(type: String, ok: Boolean, detail: String) {
        val d = detail.replace("\\", "\\\\").replace("'", "\\'").replace("\n", " ").replace("\r", " ")
        ui.post {
            web.evaluateJavascript(
                "window.__androidSerialEvent&&window.__androidSerialEvent('$type',$ok,'$d')", null
            )
        }
    }

    private fun err(msg: String): String =
        JSONObject().put("ok", false).put("immediate", true).put("error", msg).toString()
}
