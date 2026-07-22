package com.fmp.planner

import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject
import java.util.ArrayDeque
import java.util.UUID

/**
 * MAVLink-over-Bluetooth-LE bridge exposed to the WebView as `window.AndroidBle`.
 *
 * A SpeedyBee-style flight controller (or any Nordic-UART / HM-10 BLE-UART module) tunnels an FC
 * UART over BLE GATT. The Android WebView has no Web Bluetooth, so this native bridge scans,
 * connects, negotiates MTU, enables notifications and shovels raw MAVLink bytes both ways —
 * base64-encoded, the SAME contract as UdpBridge/SerialBridge.
 *
 * JS contract (mirrors web-stable/mav/transport.js::openAndroidBle + app.js scan UI):
 *   AndroidBle.startScan() -> JSON {ok} | {ok:false,error}; each device -> window.__androidBleScan('{addr,name,rssi}')
 *   AndroidBle.stopScan()
 *   AndroidBle.connect(mac) -> JSON {ok:true,pending:true} | {ok:false,error}
 *        ...connect result later -> window.__androidBleEvent('open', <bool>, '<detail>')
 *   AndroidBle.write(base64)
 *   AndroidBle.close()
 *   incoming bytes -> window.__androidBleData('<base64>')
 *
 * BLE permissions (BLUETOOTH_SCAN/CONNECT on API 31+, else BLUETOOTH*+location) are requested at
 * runtime via MainActivity.requestBlePermissions before any scan/connect.
 *
 * Reconstructed from the JS contract + UdpBridge/SerialBridge patterns — the original lived only in
 * the build tree and was never committed. NOTE: BLE GATT is device-specific; validate on hardware.
 *
 * Every inbound notification is also mirrored into TelemetryHub (the pinned live-telemetry
 * notification, #3) — a no-op when that service isn't running.
 */
class BleBridge(private val act: MainActivity, private val web: WebView) {

    private val ui = Handler(Looper.getMainLooper())
    private val mgr = act.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager?
    private val adapter get() = mgr?.adapter

    @Volatile private var gatt: BluetoothGatt? = null
    @Volatile private var writeChar: BluetoothGattCharacteristic? = null
    @Volatile private var notifyChar: BluetoothGattCharacteristic? = null
    @Volatile private var opened = false
    @Volatile private var scanning = false
    private var mtu = 23                                   // default ATT MTU until negotiated
    private val writeQueue = ArrayDeque<ByteArray>()
    @Volatile private var writing = false

    companion object {
        // Nordic UART Service (SpeedyBee / most BLE-UART bridges)
        private val NUS_SVC = UUID.fromString("6e400001-b5a3-f393-e0a9-e50e24dcca9e")
        private val NUS_RX = UUID.fromString("6e400002-b5a3-f393-e0a9-e50e24dcca9e")   // write (phone→FC)
        private val NUS_TX = UUID.fromString("6e400003-b5a3-f393-e0a9-e50e24dcca9e")   // notify (FC→phone)
        // HM-10 / clones (service FFE0, single char FFE1 for both directions)
        private val HM10_SVC = UUID.fromString("0000ffe0-0000-1000-8000-00805f9b34fb")
        private val HM10_CH = UUID.fromString("0000ffe1-0000-1000-8000-00805f9b34fb")
        private val CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")     // notify descriptor
    }

    // ---- JS interface ----

    @JavascriptInterface
    fun startScan(): String {
        val a = adapter ?: return err("Bluetooth вимкнено або недоступний.")
        if (!a.isEnabled) return err("Увімкни Bluetooth і повтори.")
        act.requestBlePermissions { granted ->
            if (!granted) { event("scan", false, "Немає дозволу Bluetooth."); return@requestBlePermissions }
            try {
                val scanner = a.bluetoothLeScanner ?: return@requestBlePermissions
                scanning = true
                scanner.startScan(emptyList(), ScanSettings.Builder()
                    .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), scanCb)
            } catch (e: SecurityException) { event("scan", false, "Немає дозволу Bluetooth.") }
            catch (e: Exception) { event("scan", false, e.message ?: "Помилка сканування.") }
        }
        return JSONObject().put("ok", true).put("pending", true).toString()
    }

    @JavascriptInterface
    fun stopScan() {
        scanning = false
        try { adapter?.bluetoothLeScanner?.stopScan(scanCb) } catch (_: Exception) {}
    }

    @JavascriptInterface
    fun connect(mac: String): String {
        val a = adapter ?: return err("Bluetooth недоступний.")
        val addr = mac.trim()
        if (addr.isEmpty()) return err("Не вказано MAC-адресу дрона.")
        act.requestBlePermissions { granted ->
            if (!granted) { event("open", false, "Немає дозволу Bluetooth."); return@requestBlePermissions }
            try { stopScan() } catch (_: Exception) {}
            try {
                close()                                    // drop any previous link first
                val dev = a.getRemoteDevice(addr)
                opened = false
                gatt = dev.connectGatt(act, false, gattCb, BluetoothProfile.GATT)   // TRANSPORT_LE via GATT
            } catch (e: SecurityException) { event("open", false, "Немає дозволу Bluetooth.") }
            catch (e: Exception) { event("open", false, e.message ?: "Не вдалося підключитись по BLE.") }
        }
        return JSONObject().put("ok", true).put("pending", true).toString()
    }

    @JavascriptInterface
    fun write(b64: String) {
        val g = gatt ?: return
        val wc = writeChar ?: return
        val bytes = try { Base64.decode(b64, Base64.NO_WRAP) } catch (e: Exception) { return }
        val cap = (mtu - 3).coerceAtLeast(20)              // ATT payload = MTU − 3
        synchronized(writeQueue) {
            var off = 0
            while (off < bytes.size) {
                val end = (off + cap).coerceAtMost(bytes.size)
                writeQueue.add(bytes.copyOfRange(off, end))
                off = end
            }
        }
        pump(g, wc)
    }

    @JavascriptInterface
    fun close() {
        opened = false
        writing = false
        synchronized(writeQueue) { writeQueue.clear() }
        writeChar = null; notifyChar = null
        val g = gatt; gatt = null
        try { g?.disconnect() } catch (_: Exception) {}
        try { g?.close() } catch (_: Exception) {}
        if (jsDataHooked) { /* JS releases __androidBleData on its side */ }
    }

    private val jsDataHooked = true

    // ---- BLE callbacks ----

    private val scanCb = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult?) {
            val d = result?.device ?: return
            val name = try { d.name } catch (e: SecurityException) { null }
            val o = JSONObject().put("addr", d.address).put("rssi", result.rssi)
            if (name != null) o.put("name", name)
            emit("window.__androidBleScan", o.toString())
        }
        override fun onScanFailed(errorCode: Int) { event("scan", false, "Сканування не вдалося ($errorCode).") }
    }

    private val gattCb = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            when (newState) {
                BluetoothProfile.STATE_CONNECTED -> {
                    try { g.requestMtu(185) } catch (e: Exception) { try { g.discoverServices() } catch (_: Exception) {} }
                }
                BluetoothProfile.STATE_DISCONNECTED -> {
                    val wasOpen = opened
                    opened = false
                    try { g.close() } catch (_: Exception) {}
                    if (gatt === g) gatt = null
                    if (wasOpen) event("error", false, "Звʼязок BLE втрачено.")
                    else event("open", false, "BLE-підключення не вдалося (status $status).")
                }
            }
        }

        override fun onMtuChanged(g: BluetoothGatt, m: Int, status: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS) mtu = m
            try { g.discoverServices() } catch (_: Exception) { event("open", false, "Не вдалося прочитати сервіси BLE.") }
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS) { event("open", false, "Сервіси BLE недоступні."); return }
            var svc = g.getService(NUS_SVC)
            if (svc != null) {
                writeChar = svc.getCharacteristic(NUS_RX)
                notifyChar = svc.getCharacteristic(NUS_TX)
            } else {
                svc = g.getService(HM10_SVC)
                if (svc != null) {
                    writeChar = svc.getCharacteristic(HM10_CH)
                    notifyChar = writeChar
                }
            }
            val nc = notifyChar
            if (writeChar == null || nc == null) { event("open", false, "Не знайдено UART-сервіс (NUS/HM-10)."); return }
            try {
                g.setCharacteristicNotification(nc, true)
                val cccd = nc.getDescriptor(CCCD)
                if (cccd != null) {
                    cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                    g.writeDescriptor(cccd)                // → onDescriptorWrite fires "open"
                } else {
                    opened = true; event("open", true, "")   // some clones lack a CCCD but still notify
                }
            } catch (e: Exception) { event("open", false, "Не вдалося увімкнути сповіщення BLE.") }
        }

        override fun onDescriptorWrite(g: BluetoothGatt, d: BluetoothGattDescriptor, status: Int) {
            if (d.uuid == CCCD) {
                if (status == BluetoothGatt.GATT_SUCCESS) { opened = true; event("open", true, "") }
                else event("open", false, "Не вдалося підписатись на дані BLE.")
            }
        }

        @Suppress("DEPRECATION")
        override fun onCharacteristicChanged(g: BluetoothGatt, ch: BluetoothGattCharacteristic) {
            if (ch.uuid == notifyChar?.uuid) {
                val v = ch.value ?: return
                if (v.isNotEmpty()) {
                    TelemetryHub.feed(v)   // pinned notification tap (#3) — no-op unless the service is running
                    emit("window.__androidBleData", Base64.encodeToString(v, Base64.NO_WRAP))
                }
            }
        }

        override fun onCharacteristicWrite(g: BluetoothGatt, ch: BluetoothGattCharacteristic, status: Int) {
            writing = false
            pump(g, writeChar ?: return)                   // send the next queued chunk
        }
    }

    // ---- helpers ----

    @Suppress("DEPRECATION")
    private fun pump(g: BluetoothGatt, wc: BluetoothGattCharacteristic) {
        if (writing) return
        val chunk = synchronized(writeQueue) { if (writeQueue.isEmpty()) null else writeQueue.poll() } ?: return
        writing = true
        try {
            wc.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
            wc.value = chunk
            if (!g.writeCharacteristic(wc)) { writing = false }
        } catch (e: Exception) { writing = false }
    }

    // Fire window.<fn>('<base64/json>') on the UI thread, JSON-quoting the (remote-controlled) arg
    // so remote bytes can't break out of the string literal (injection-proof).
    private fun emit(fn: String, arg: String) {
        val q = JSONObject.quote(arg)
        ui.post { try { web.evaluateJavascript("$fn&&$fn($q)", null) } catch (_: Exception) {} }
    }

    private fun event(type: String, ok: Boolean, detail: String) {
        val d = detail.replace("\\", "\\\\").replace("'", "\\'").replace("\n", " ").replace("\r", " ")
        ui.post {
            try { web.evaluateJavascript("window.__androidBleEvent&&window.__androidBleEvent('$type',$ok,'$d')", null) } catch (_: Exception) {}
        }
    }

    private fun err(msg: String): String = JSONObject().put("ok", false).put("error", msg).toString()
}
