import Foundation
import Security

/// Where the control plane lives. One value per build configuration (Config/*.xcconfig).
enum AppConfig {
    static let baseURL: URL = {
        guard let value = Bundle.main.object(forInfoDictionaryKey: "ATTNBaseURL") as? String,
              let url = URL(string: value), url.scheme == "https" else {
            fatalError("ATTNBaseURL must be an https URL (set ATTN_HOST in Config/Release.xcconfig)")
        }
        return url
    }()

    /// Only pages from the control plane's own origin run inside the app.
    static func isControlPlane(_ url: URL) -> Bool {
        url.scheme == baseURL.scheme && url.host == baseURL.host && url.port == baseURL.port
    }

    /// Turns any link the app receives into a control-plane URL, or nil if it isn't one.
    /// Accepts https universal links, textme://conversations/<id>/live, and relative paths from push payloads.
    static func controlPlaneURL(from link: String) -> URL? {
        if link.hasPrefix("/") { return URL(string: link, relativeTo: baseURL)?.absoluteURL }
        guard let url = URL(string: link) else { return nil }
        if url.scheme == "textme" {
            var components = URLComponents()
            components.path = "/" + [url.host ?? "", url.path].joined().trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            components.query = url.query
            return components.url(relativeTo: baseURL)?.absoluteURL
        }
        return isControlPlane(url) ? url : nil
    }
}

/// The sign-in session. Nothing about the customer is compiled into the app: the user
/// signs in (or signs up) on the page with their email and password, the server returns
/// a session for their account, and the page hands the session to the app, which keeps
/// it in the Keychain so notification actions work without opening the app. Signing in
/// to a different account replaces it; the same binary serves every customer.
final class SessionStore {
    static let shared = SessionStore()
    private let service = "app.textme.session"
    private let account = "session"

    var token: String? {
        get {
            let query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: account,
                kSecReturnData as String: true,
                kSecMatchLimit as String: kSecMatchLimitOne,
            ]
            var result: AnyObject?
            guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
                  let data = result as? Data else { return nil }
            return String(data: data, encoding: .utf8)
        }
        set {
            let base: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: account,
            ]
            SecItemDelete(base as CFDictionary)
            guard let newValue, let data = newValue.data(using: .utf8) else { return }
            var item = base
            item[kSecValueData as String] = data
            // Available after first unlock, so a Reply action works from the lock screen.
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            SecItemAdd(item as CFDictionary, nil)
        }
    }
}

/// Links that must open in the control plane: notification taps (including from a
/// terminated app), universal links and textme:// links. The web view drains it once loaded.
@MainActor
final class LinkRouter: ObservableObject {
    static let shared = LinkRouter()
    @Published private(set) var pending: URL?

    func open(_ url: URL) { pending = url }

    func take() -> URL? {
        defer { pending = nil }
        return pending
    }
}

/// The small part of the control-plane API the app calls itself (everything else is the page).
enum ControlPlaneAPI {
    enum Failure: Error { case signedOut, offline, rejected(String) }

    static func request(_ path: String, method: String, body: [String: Any]) async throws -> Data {
        guard let token = SessionStore.shared.token else { throw Failure.signedOut }
        guard let url = URL(string: path, relativeTo: AppConfig.baseURL)?.absoluteURL else { throw Failure.rejected("Bad path") }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        request.timeoutInterval = 20
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw Failure.offline
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 { throw Failure.signedOut }
        guard (200..<300).contains(status) else {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw Failure.rejected(message ?? "HTTP \(status)")
        }
        return data
    }
}
