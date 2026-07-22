package com.fmp.planner

import android.webkit.JavascriptInterface
import android.webkit.WebView

/**
 * Photo-import upload bridge exposed to the WebView as `window.AndroidPhoto`.
 *
 * The in-app photo-import UI was removed (the web app no longer calls `AndroidPhoto.*`), so this is
 * an inert bridge kept only because MainActivity still registers the `AndroidPhoto` interface. If
 * photo import is reintroduced, its upload methods go here (mirroring LogBridge's store-and-forward).
 *
 * Reconstructed from the JS contract (currently none) + the bridge pattern — the original file lived
 * only in the build tree and was never committed.
 */
class PhotoBridge(@Suppress("unused") private val web: WebView) {
    @JavascriptInterface
    fun available(): Boolean = false     // no active photo-import pipeline in the current web app
}
