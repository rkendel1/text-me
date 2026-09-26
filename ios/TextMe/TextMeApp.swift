import SwiftUI
import UIKit

@main
struct TextMeApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            ControlPlaneView()
                .ignoresSafeArea()
                // textme://conversations/<id>/live
                .onOpenURL { url in
                    if let target = AppConfig.controlPlaneURL(from: url.absoluteString) { LinkRouter.shared.open(target) }
                }
                // Universal links: https://<domain>/conversations/<id>/live
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    if let url = activity.webpageURL, let target = AppConfig.controlPlaneURL(from: url.absoluteString) {
                        LinkRouter.shared.open(target)
                    }
                }
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // Set before launch finishes so a tap that launched the app is delivered (terminated → tap → conversation).
        NotificationCoordinator.shared.configure()
        NotificationCoordinator.shared.refreshRegistrationIfEnabled()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCoordinator.shared.didRegister(deviceToken: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCoordinator.shared.didFailToRegister(error)
    }
}
