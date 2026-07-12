package com.fmp.planner

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.AssetManager
import android.net.Uri
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.GeolocationPermissions
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import java.io.IOException
import java.io.InputStream

/**
 * Native shell: a full-screen WebView running the existing Field Mission Planner
 * web app offline from the APK. Planning (Pyodide) runs unchanged; the only new
 * capability is USB serial to the flight controller, exposed to JS as
 * `window.AndroidSerial` (see SerialBridge) — this is what the browser cannot do.
 */
class MainActivity : Activity() {

    private lateinit var webView: WebView
    private var serial: SerialBridge? = null
    private var udp: UdpBridge? = null
    // A WebView geolocation request awaiting the OS location-permission result.
    private var pendingGeo: Pair<String?, GeolocationPermissions.Callback?>? = null
    // A WebView <input type=file> click awaiting the SAF document-picker result.
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    // A .kml handed to us by a VIEW/SEND intent, delivered to the web app once loaded.
    private var pendingKml: String? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Serve the bundled web app over a secure https origin so Web Workers,
        // Pyodide and fetch() all behave exactly like the deployed PWA.
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/engine/", AssetHandler(assets, "engine")) // backend *.py
            .addPathHandler("/", AssetHandler(assets, "web"))           // the web app
            .build()

        webView = WebView(this)
        // Remote WebView debugging only in debug builds — in release nobody with ADB
        // can drive the JS bridges from a debugger.
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            cacheMode = WebSettings.LOAD_DEFAULT
            mediaPlaybackRequiresUserGesture = false
            setGeolocationEnabled(true)          // the «📍 my GPS» map button needs this
            // Tell the page it's the native shell -> skip the service worker.
            userAgentString = "$userAgentString FMPAndroid/1.0"
        }
        // Ask for the phone's location once, so the WebView's geolocation can resolve
        // (the map «📍 my GPS» button + GPS anchor for the route start/finish).
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            try {
                requestPermissions(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION,
                                           Manifest.permission.ACCESS_COARSE_LOCATION), 1)
            } catch (e: Exception) {}
        }
        // Grant the bundled page geolocation when it asks (navigator.geolocation). But
        // the WebView can only get a fix if the APP itself holds ACCESS_*_LOCATION at
        // the OS level — if the user denied the startup prompt, getCurrentPosition fails
        // with "application does not have sufficient geolocation permissions". So if the
        // app permission isn't granted yet, request it ON DEMAND (when «📍 Мій GPS» is
        // tapped) and deliver the result back to the WebView callback.
        webView.webChromeClient = object : WebChromeClient() {
            override fun onGeolocationPermissionsShowPrompt(
                origin: String?, callback: GeolocationPermissions.Callback?
            ) {
                val granted =
                    checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
                    checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
                if (granted) {
                    callback?.invoke(origin, true, false)
                } else {
                    pendingGeo = origin to callback
                    try {
                        requestPermissions(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION,
                                                   Manifest.permission.ACCESS_COARSE_LOCATION), 7)
                    } catch (e: Exception) {
                        callback?.invoke(origin, false, false); pendingGeo = null
                    }
                }
            }
            // A WebView <input type=file> tap (the «Імпорт .kml» button) — WebView does
            // NOTHING here unless the shell opens a picker itself. Launch the SAF document
            // picker and hand the chosen file back to the page.
            override fun onShowFileChooser(
                view: WebView?, callback: ValueCallback<Array<Uri>>?,
                params: FileChooserParams?
            ): Boolean {
                filePathCallback?.onReceiveValue(null)     // cancel a stale request
                filePathCallback = callback
                return try {
                    val i = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "*/*"                       // a .kml often reports octet-stream — don't grey it out
                    }
                    this@MainActivity.startActivityForResult(i, REQ_FILE); true
                } catch (e: Exception) { filePathCallback = null; false }
            }
        }
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView, request: WebResourceRequest
            ): WebResourceResponse? = loader.shouldInterceptRequest(request.url)

            // Keep the top frame pinned to the bundled app origin. A stray link /
            // redirect must never navigate the WebView (and thus the privileged JS
            // bridges: serial / UDP / log / update) onto a remote page.
            override fun shouldOverrideUrlLoading(
                view: WebView, request: WebResourceRequest
            ): Boolean {
                return request.url.host != "appassets.androidplatform.net"   // true = block
            }
            // Once the offline app is up, hand it any .kml we were opened with.
            override fun onPageFinished(view: WebView?, url: String?) {
                pendingKml?.let { deliverKml(it); pendingKml = null }
            }
        }

        serial = SerialBridge(this, webView)
        webView.addJavascriptInterface(serial!!, "AndroidSerial")
        udp = UdpBridge(this, webView)                 // MAVLink over WiFi (ELRS backpack)
        webView.addJavascriptInterface(udp!!, "AndroidUdp")
        webView.addJavascriptInterface(LogBridge(webView), "AndroidLog")  // diagnostic-log upload
        // In-app self-update (download + install an APK): only for the self-distributed
        // builds. The Google Play build (SELF_UPDATE=false) omits it — Play forbids apps
        // installing APKs, and the REQUEST_INSTALL_PACKAGES permission is stripped too.
        if (BuildConfig.SELF_UPDATE)
            webView.addJavascriptInterface(UpdateBridge(this, webView), "AndroidUpdate")

        setContentView(
            webView,
            ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT
            )
        )
        // Android 15/16 (targetSdk 35) forces EDGE-TO-EDGE: the WebView would otherwise
        // draw UNDER the status + navigation bars, so the app's top controls overlap the
        // status bar. Pad the WebView by the system-bar (+ display-cutout) insets so the
        // content stays within the safe area; the dark window background fills the bar
        // strips (no white flash).
        window.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(0xFF0A0F14.toInt()))
        // Primary fix is the theme's android:windowOptOutEdgeToEdgeEnforcement (res/values/
        // themes.xml) — the official opt-out for targetSdk 35. This inset listener is a
        // belt-and-suspenders fallback: if edge-to-edge is still active it pads the WebView;
        // if the theme opted out, the insets are already 0 here so it's a no-op.
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(webView) { v, insets ->
            val i = insets.getInsets(
                androidx.core.view.WindowInsetsCompat.Type.systemBars()
                    or androidx.core.view.WindowInsetsCompat.Type.displayCutout())
            v.setPadding(i.left, i.top, i.right, i.bottom)
            androidx.core.view.WindowInsetsCompat.CONSUMED
        }
        // Force a dispatch NOW — the listener is attached after the first inset pass, so
        // without this the padding wouldn't apply until some later relayout (or never).
        androidx.core.view.ViewCompat.requestApplyInsets(webView)
        pendingKml = readKmlFromIntent(intent)          // launched via "Open with" / share a .kml?
        webView.loadUrl("https://appassets.androidplatform.net/")
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    // A .kml opened from a file manager / share sheet while we're already running
    // (launchMode=singleTask → the new intent arrives here, not a fresh onCreate).
    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        readKmlFromIntent(intent)?.let { deliverKml(it) }
    }

    // Result of the SAF document picker launched for a WebView <input type=file>.
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_FILE) {
            val cb = filePathCallback; filePathCallback = null
            // parseResult handles a single Uri and multi-select; null = user cancelled
            // (must still be delivered, else the <input> stays wedged).
            cb?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
        }
    }

    // Read the KML text a VIEW/SEND intent points at (content:// or file://).
    private fun readKmlFromIntent(intent: Intent?): String? {
        intent ?: return null
        val uri: Uri = when (intent.action) {
            Intent.ACTION_SEND -> intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
            else -> intent.data
        } ?: return null
        return try {
            contentResolver.openInputStream(uri)?.use { it.readBytes().toString(Charsets.UTF_8) }
        } catch (e: Exception) { null }
    }

    // Hand a KML string to the web app; retry until its JS import hook is defined
    // (Pyodide/app boot is async). Base64 keeps arbitrary text safe inside the JS.
    private fun deliverKml(kml: String) {
        val b64 = android.util.Base64.encodeToString(kml.toByteArray(Charsets.UTF_8), android.util.Base64.NO_WRAP)
        val js = "(function(){var b='" + b64 + "';function d(s){return decodeURIComponent(escape(window.atob(s)));}" +
                 "function go(){if(window.__fmpImportKml){try{window.__fmpImportKml(d(b));}catch(e){}}else{setTimeout(go,300);}}go();})();"
        webView.evaluateJavascript(js, null)
    }

    companion object { private const val REQ_FILE = 42 }

    // Deliver the OS location-permission result to a WebView geolocation request that
    // was waiting on it (the «📍 Мій GPS» on-demand prompt).
    override fun onRequestPermissionsResult(
        requestCode: Int, permissions: Array<out String>, grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 7) {
            val ok = grantResults.isNotEmpty() && grantResults.any { it == PackageManager.PERMISSION_GRANTED }
            pendingGeo?.let { (origin, cb) -> cb?.invoke(origin, ok, false) }
            pendingGeo = null
        }
    }

    override fun onDestroy() {
        try { serial?.close() } catch (_: Exception) {}
        try { udp?.close() } catch (_: Exception) {}
        super.onDestroy()
    }
}

/**
 * Serves an APK assets subtree with explicit MIME types. WebViewAssetLoader's
 * default guesser doesn't recognise .wasm (which Pyodide's streaming compile
 * needs) or .whl/.py, so we map them here.
 */
class AssetHandler(
    private val assets: AssetManager,
    private val root: String
) : WebViewAssetLoader.PathHandler {

    override fun handle(path: String): WebResourceResponse? {
        var rel = path.trimStart('/')
        if (rel.isEmpty()) rel = "index.html"
        val full = if (root.isEmpty()) rel else "$root/$rel"
        return try {
            val ins: InputStream = assets.open(full)
            val mime = mimeOf(full)
            val enc = if (isText(mime)) "utf-8" else null
            WebResourceResponse(mime, enc, ins)
        } catch (e: IOException) {
            null // not found -> let other handlers / default network handle it
        }
    }

    private fun isText(mime: String) =
        mime.startsWith("text/") || mime == "application/javascript" ||
            mime == "application/json" || mime == "image/svg+xml"

    private fun mimeOf(name: String): String = when {
        name.endsWith(".html") -> "text/html"
        name.endsWith(".js") || name.endsWith(".mjs") -> "application/javascript"
        name.endsWith(".css") -> "text/css"
        name.endsWith(".json") -> "application/json"
        name.endsWith(".wasm") -> "application/wasm"
        name.endsWith(".svg") -> "image/svg+xml"
        name.endsWith(".png") -> "image/png"
        name.endsWith(".webp") -> "image/webp"
        name.endsWith(".ico") -> "image/x-icon"
        name.endsWith(".py") -> "text/plain"
        else -> "application/octet-stream" // .whl .zip and the rest
    }
}
