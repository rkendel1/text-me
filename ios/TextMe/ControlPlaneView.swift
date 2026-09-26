import Combine
import SwiftUI
import WebKit

/// The control plane, hosted natively. It is the same page, API, session and
/// commands as the browser; the app adds push, the Keychain and link routing.
struct ControlPlaneView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        let controller = configuration.userContentController
        controller.add(WeakMessageHandler(context.coordinator), name: "attn")
        controller.addUserScript(WKUserScript(source: Coordinator.bootstrapScript(), injectionTime: .atDocumentStart, forMainFrameOnly: true))

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isOpaque = false
        webView.backgroundColor = .systemGroupedBackground
        context.coordinator.attach(webView)
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        private weak var webView: WKWebView?
        private var loaded = false
        private var subscription: AnyCancellable?

        /// Hands the Keychain session to the page before any of its scripts run.
        static func bootstrapScript() -> String {
            func literal(_ value: String?) -> String {
                guard let value, let data = try? JSONSerialization.data(withJSONObject: [value]),
                      let json = String(data: data, encoding: .utf8) else { return "null" }
                return String(json.dropFirst().dropLast())
            }
            return "window.__ATTN_SESSION__ = \(literal(SessionStore.shared.token));"
        }

        func attach(_ webView: WKWebView) {
            self.webView = webView
            // A notification tap from a terminated app is already pending: open straight into it.
            let first = LinkRouter.shared.take() ?? AppConfig.baseURL
            webView.load(URLRequest(url: first))
            subscription = LinkRouter.shared.$pending.compactMap { $0 }.sink { [weak self] _ in
                guard let self, let url = LinkRouter.shared.take() else { return }
                self.open(url)
            }
            NotificationCoordinator.shared.onStateChange = { [weak self] state, error in
                var event: [String: Any] = ["type": "pushState", "state": state.rawValue]
                if let error { event["error"] = error }
                self?.send(event)
            }
        }

        private func sendPushState() {
            Task { [weak self] in
                let state = await NotificationCoordinator.shared.currentState()
                self?.send(["type": "pushState", "state": state.rawValue])
            }
        }

        private func open(_ url: URL) {
            guard let webView else { return }
            if loaded {
                // The page routes it like a Web Push tap: same deep link, same stale-notification handling.
                send(["type": "open", "url": url.absoluteString])
            } else {
                webView.load(URLRequest(url: url))
            }
        }

        private func send(_ event: [String: Any]) {
            guard let webView, JSONSerialization.isValidJSONObject(event), let data = try? JSONSerialization.data(withJSONObject: event),
                  let json = String(data: data, encoding: .utf8) else { return }
            webView.evaluateJavaScript("window.attnNativeEvent && window.attnNativeEvent(\(json))")
        }

        // MARK: page → app

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any], let type = body["type"] as? String,
                  let origin = message.frameInfo.request.url, AppConfig.isControlPlane(origin) else { return }
            switch type {
            case "session":
                SessionStore.shared.token = body["token"] as? String
                NotificationCoordinator.shared.refreshRegistrationIfEnabled()
            case "signedOut":
                SessionStore.shared.token = nil
            case "enablePush":
                Task { await NotificationCoordinator.shared.enable() }
            default:
                break
            }
        }

        // MARK: navigation

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard let url = navigationAction.request.url else { return .cancel }
            if AppConfig.isControlPlane(url) || url.scheme == "about" { return .allow }
            // Anything else (tel:, sms:, other sites) leaves the app.
            await UIApplication.shared.open(url)
            return .cancel
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            loaded = webView.url.map(AppConfig.isControlPlane) ?? false
            guard loaded else { return }
            sendPushState()
            if let url = LinkRouter.shared.take() { open(url) }
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            loaded = false
            webView.loadHTMLString(Self.offlinePage, baseURL: nil)
        }

        /// Shown when the control plane can't be reached; Retry reloads the durable state.
        static let offlinePage = """
        <html><head><meta name=viewport content="width=device-width,initial-scale=1">
        <style>body{font:17px -apple-system;display:grid;place-items:center;height:90vh;text-align:center;color:#6e6e73;background:#f2f2f7}
        a{display:inline-block;margin-top:14px;color:#007aff;text-decoration:none;font-weight:600}</style></head>
        <body><div><b style="color:#1d1d1f;font-size:20px">You’re offline</b><br>Your assistant keeps working.<br>
        <a href="\(AppConfig.baseURL.absoluteString)">Try Again</a></div></body></html>
        """
    }
}

/// WKUserContentController retains its handlers; this breaks the cycle.
@MainActor
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}
