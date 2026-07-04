import UIKit
import WebKit
import CoreLocation
import Swifter

/// Hosts the WKWebView. Serves the bundled offline web app over a local HTTP
/// server (real origin → Pyodide / service worker / secure-context APIs all work,
/// exactly like the desktop serve.py) and bridges MAVLink-over-UDP to JS.
final class ViewController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate, CLLocationManagerDelegate {

    private var webView: WKWebView!
    private let server = HttpServer()
    private let udp = UdpBridge()
    private let loc = CLLocationManager()
    private var serverPort: Int = 0

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        startServer()
        setupWebView()
        wireUdp()
        // Ask for location up front so WKWebView's navigator.geolocation works in flight.
        loc.delegate = self
        loc.requestWhenInUseAuthorization()
        loadApp()
    }

    // MARK: - local static server (serves App/web from the bundle)

    private func webRoot() -> String { Bundle.main.bundlePath + "/web" }

    private func startServer() {
        let root = webRoot()
        // Swifter has no recursive static handler with correct MIME for .wasm, so
        // serve every path ourselves from the not-found handler (the catch-all).
        server.notFoundHandler = { [weak self] req in
            self?.serveFile(root: root, path: req.path) ?? .notFound
        }
        do {
            // Bind LOOPBACK ONLY (127.0.0.1) — not 0.0.0.0 — so the bundled web app is
            // NOT reachable by other devices on the drone/backpack WiFi. (security audit S4)
            server.listenAddressIPv4 = "127.0.0.1"
            try server.start(0, forceIPv4: true)        // 0 = OS picks a free port
            serverPort = (try? server.port()) ?? 0
        } catch {
            serverPort = 0
        }
    }

    private func serveFile(root: String, path: String) -> HttpResponse {
        var rel = path.isEmpty || path == "/" ? "/index.html" : path
        if let q = rel.firstIndex(of: "?") { rel = String(rel[..<q]) }
        // Disallow path traversal.
        if rel.contains("..") { return .forbidden }
        let full = root + rel
        guard let data = FileManager.default.contents(atPath: full) else { return .notFound }
        let mime = Self.mimeType(for: rel)
        return .raw(200, "OK", ["Content-Type": mime, "Cache-Control": "no-cache"]) { writer in
            try? writer.write([UInt8](data))
        }
    }

    private static func mimeType(for path: String) -> String {
        let ext = (path as NSString).pathExtension.lowercased()
        switch ext {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs":   return "text/javascript; charset=utf-8"
        case "css":         return "text/css; charset=utf-8"
        case "json", "map": return "application/json; charset=utf-8"
        case "wasm":        return "application/wasm"            // Pyodide needs this
        case "data":        return "application/octet-stream"    // Pyodide package data
        case "whl", "zip":  return "application/octet-stream"
        case "png":         return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif":         return "image/gif"
        case "svg":         return "image/svg+xml"
        case "ico":         return "image/x-icon"
        case "woff2":       return "font/woff2"
        case "woff":        return "font/woff"
        case "ttf":         return "font/ttf"
        case "txt":         return "text/plain; charset=utf-8"
        default:            return "application/octet-stream"
        }
    }

    // MARK: - WKWebView

    private func setupWebView() {
        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(self, name: "fmpUdp")
        cfg.allowsInlineMediaPlayback = true
        // Appending here keeps the normal Safari UA and adds our marker, so the web
        // app detects the iOS shell (IS_IOS) and routes UDP through this bridge.
        cfg.applicationNameForUserAgent = "FMPiOS"

        webView = WKWebView(frame: view.bounds, configuration: cfg)
        webView.navigationDelegate = self
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        view.addSubview(webView)
    }

    private func loadApp() {
        guard serverPort > 0, let url = URL(string: "http://127.0.0.1:\(serverPort)/") else {
            let html = "<h2 style=\"font-family:sans-serif;padding:24px\">Не вдалося запустити локальний сервер.</h2>"
            webView.loadHTMLString(html, baseURL: nil)
            return
        }
        webView.load(URLRequest(url: url))
    }

    // MARK: - UDP bridge wiring (native → JS)

    private func wireUdp() {
        udp.onData = { [weak self] data in
            let b64 = data.base64EncodedString()           // base64 → safe to inline
            DispatchQueue.main.async {
                self?.webView.evaluateJavaScript(
                    "window.__iosUdpData && window.__iosUdpData('\(b64)')", completionHandler: nil)
            }
        }
        udp.onEvent = { [weak self] type, ok, detail in
            let safe = (detail ?? "").replacingOccurrences(of: "\\", with: "\\\\")
                                     .replacingOccurrences(of: "'", with: "\\'")
            DispatchQueue.main.async {
                self?.webView.evaluateJavaScript(
                    "window.__iosUdpEvent && window.__iosUdpEvent('\(type)', \(ok ? "true" : "false"), '\(safe)')",
                    completionHandler: nil)
            }
        }
    }

    // MARK: - JS → native

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "fmpUdp",
              let body = message.body as? [String: Any],
              let op = body["op"] as? String else { return }
        switch op {
        case "open":
            let port = UInt16(truncatingIfNeeded: (body["port"] as? Int) ?? 14550)
            udp.open(port: port)
        case "write":
            if let b64 = body["data"] as? String, let d = Data(base64Encoded: b64) { udp.write(d) }
        case "close":
            udp.close()
        default:
            break
        }
    }

    // MARK: - CLLocationManagerDelegate (no-op; authorisation is what matters)
    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {}
}
