import UIKit

// Plain AppDelegate window lifecycle (no scene manifest in Info.plist → iOS uses
// this path). One window, one ViewController that hosts the WKWebView.
@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let w = UIWindow(frame: UIScreen.main.bounds)
        w.rootViewController = ViewController()
        w.makeKeyAndVisible()
        self.window = w
        return true
    }
}
