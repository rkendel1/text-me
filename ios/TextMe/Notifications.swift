import UIKit
import UserNotifications

/// Native notifications for owner attention. The server sends the same attention
/// (title, body, deep link) it sends to Web Push; the app decides nothing itself.
@MainActor
final class NotificationCoordinator: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationCoordinator()

    nonisolated static let category = "OWNER_ATTENTION"
    nonisolated static let replyAction = "REPLY"
    nonisolated static let takeOverAction = "TAKE_OVER"

    /// Reported to the page so Settings shows the real state.
    enum PushState: String { case on, off, denied }
    var onStateChange: ((PushState, String?) -> Void)?
    private var registrationContinuation: CheckedContinuation<String, Error>?

    func configure() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let reply = UNTextInputNotificationAction(
            identifier: Self.replyAction, title: "Reply", options: [],
            textInputButtonTitle: "Send", textInputPlaceholder: "Your answer")
        let takeOver = UNNotificationAction(identifier: Self.takeOverAction, title: "Take Over", options: [.foreground])
        center.setNotificationCategories([
            UNNotificationCategory(identifier: Self.category, actions: [reply, takeOver], intentIdentifiers: [], options: []),
        ])
    }

    func currentState() async -> PushState {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .denied: return .denied
        case .authorized, .provisional, .ephemeral: return UIApplication.shared.isRegisteredForRemoteNotifications ? .on : .off
        default: return .off
        }
    }

    /// Asked for from a tap in Settings or onboarding (the page posts `enablePush`).
    func enable() async {
        do {
            let granted = try await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound, .badge])
            guard granted else { onStateChange?(.denied, nil); return }
            let token = try await withCheckedThrowingContinuation { continuation in
                registrationContinuation = continuation
                UIApplication.shared.registerForRemoteNotifications()
            }
            try await register(token: token)
            onStateChange?(.on, nil)
        } catch ControlPlaneAPI.Failure.rejected(let message) {
            onStateChange?(.off, message)
        } catch {
            onStateChange?(.off, "Couldn’t turn on notifications. Try again.")
        }
    }

    /// APNs tokens can change; re-register on every launch while signed in.
    func refreshRegistrationIfEnabled() {
        Task {
            guard SessionStore.shared.token != nil, await currentState() != .denied else { return }
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            if settings.authorizationStatus == .authorized { UIApplication.shared.registerForRemoteNotifications() }
        }
    }

    func didRegister(deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        if let continuation = registrationContinuation {
            registrationContinuation = nil
            continuation.resume(returning: token)
        } else {
            Task { try? await register(token: token) }
        }
    }

    func didFailToRegister(_ error: Error) {
        registrationContinuation?.resume(throwing: error)
        registrationContinuation = nil
    }

    private func register(token: String) async throws {
        _ = try await ControlPlaneAPI.request("/owner/push/devices", method: "POST", body: [
            "platform": "ios", "apnsToken": token, "label": UIDevice.current.name,
        ])
    }

    // MARK: UNUserNotificationCenterDelegate

    /// While the app is open the page already shows the change live; keep a quiet banner.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification)
        async -> UNNotificationPresentationOptions {
        [.banner, .list]
    }

    /// Taps and actions, including when the tap launched the app from terminated.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        guard let link = info["url"] as? String else { return }
        let attentionId = info["attentionId"] as? String

        if response.actionIdentifier == Self.replyAction,
           let text = (response as? UNTextInputNotificationResponse)?.userText.trimmingCharacters(in: .whitespacesAndNewlines),
           !text.isEmpty, let attentionId {
            // Answered from the lock screen: sent straight to the server, no app UI needed.
            await sendReply(text, attentionId: attentionId, fallbackLink: link)
            return
        }
        var target = link
        if response.actionIdentifier == Self.takeOverAction { target += (link.contains("?") ? "&" : "?") + "intent=take_over" }
        if let url = AppConfig.controlPlaneURL(from: target) {
            await MainActor.run { LinkRouter.shared.open(url) }
        }
    }

    private nonisolated func sendReply(_ text: String, attentionId: String, fallbackLink: String) async {
        do {
            // One command id per attention: if iOS retries the action, the server sends the reply once.
            _ = try await ControlPlaneAPI.request("/owner/attention/\(attentionId)/actions", method: "POST", body: [
                "action": "reply", "body": text, "commandId": "ios:\(attentionId):reply",
            ])
        } catch {
            // Offline, signed out, or already handled elsewhere: say so, and let a tap open the conversation.
            let content = UNMutableNotificationContent()
            switch error {
            case ControlPlaneAPI.Failure.signedOut: content.title = "Sign in to reply"
            case ControlPlaneAPI.Failure.rejected(let message): content.title = message
            default: content.title = "Your reply wasn’t sent"
            }
            content.body = "Tap to open the conversation."
            content.userInfo = ["url": fallbackLink + (fallbackLink.contains("?") ? "&" : "?") + "intent=reply"]
            try? await UNUserNotificationCenter.current().add(
                UNNotificationRequest(identifier: "reply-failed-\(attentionId)", content: content, trigger: nil))
        }
    }
}
