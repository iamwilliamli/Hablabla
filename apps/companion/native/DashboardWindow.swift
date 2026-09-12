import AppKit
import ApplicationServices

struct DashboardSnapshotRequest {
    let id: String
    let expiresAt: Date
}

// This GUI process owns capture permission. It makes outbound requests only to
// one literal loopback origin, with ephemeral credentials and no redirects.
private final class LocalDashboardHTTP: NSObject, URLSessionDataDelegate {
    private var data = Data()
    private var completion: (([String: Any]?) -> Void)?
    private var session: URLSession?

    func send(_ body: [String: Any], token: String?, completion: @escaping ([String: Any]?) -> Void) {
        self.completion = completion
        var request = URLRequest(url: URL(string: "http://127.0.0.1:3100/api/devices?native=1")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 8
        config.timeoutIntervalForResource = 8
        config.httpCookieStorage = nil
        config.urlCache = nil
        config.urlCredentialStorage = nil
        config.connectionProxyDictionary = [:]
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        self.session = session
        session.dataTask(with: request).resume()
    }
    func cancel() { session?.invalidateAndCancel(); completion = nil }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let response = response as? HTTPURLResponse, response.statusCode == 200,
              response.expectedContentLength <= 16384 else { completionHandler(.cancel); return }
        completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive chunk: Data) {
        guard data.count + chunk.count <= 16384 else { dataTask.cancel(); return }
        data.append(chunk)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let object = error == nil ? (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] : nil
        session.finishTasksAndInvalidate()
        DispatchQueue.main.async { [self] in completion?(object); completion = nil; self.session = nil }
    }
}

final class DashboardWindowController: NSWindowController, NSWindowDelegate {
    var onRequest: ((DashboardSnapshotRequest) -> Void)?
    var onCancelRequest: (() -> Void)?
    private let code = NSTextField(string: "")
    private let status = NSTextField(wrappingLabelWithString: "Not connected. Open the dashboard and create a pairing code.")
    private var pairButton: NSButton!
    private var stopButton: NSButton!
    private var timer: Timer?
    private var token: String?
    private var generation = UUID()
    private var currentRequest: DashboardSnapshotRequest?
    private var connections: [UUID: LocalDashboardHTTP] = [:]
    private var polling = false

    init() {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 590, height: 395),
            styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Hablabla Companion — Local Dashboard"
        window.isReleasedWhenClosed = false
        super.init(window: window)
        window.delegate = self
        guard let content = window.contentView else { return }
        let title = NSTextField(labelWithString: "Connect your local dashboard")
        title.font = .systemFont(ofSize: 24, weight: .bold)
        let intro = NSTextField(wrappingLabelWithString: "Open http://127.0.0.1:3100/devices on this Mac. Create a pairing code, then paste it here. Pairing lets that browser request a snapshot; you choose the source and approve each image before sharing.")
        let codeLabel = NSTextField(labelWithString: "Pairing code")
        code.placeholderString = "Paste the 32-character code"
        code.setAccessibilityLabel("Dashboard pairing code")
        code.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        pairButton = NSButton(title: "Pair Dashboard", target: self, action: #selector(pair))
        pairButton.bezelStyle = .rounded
        stopButton = NSButton(title: "Disconnect & Clear", target: self, action: #selector(stop))
        stopButton.bezelStyle = .rounded
        stopButton.isEnabled = false
        let buttons = NSStackView(views: [pairButton, stopButton])
        buttons.spacing = 12
        let privacy = NSTextField(wrappingLabelWithString: "This connection stays on this Mac. Shared images expire after one minute. Closing this window disconnects. Pair again after quitting the companion or restarting the web server.")
        privacy.font = .systemFont(ofSize: 12)
        privacy.textColor = .secondaryLabelColor
        let stack = NSStackView(views: [title, intro, codeLabel, code, buttons, status, privacy])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: content.bottomAnchor, constant: -24)
        ])
        for view in [intro, code, status, privacy] { view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true }
        window.center()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    func present() { showWindow(nil); NSApp.activate(ignoringOtherApps: true); window?.makeKeyAndOrderFront(nil) }

    private func permissions() -> [String: Bool] {
        ["screenRecording": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted()]
    }
    private func send(_ body: [String: Any], token: String?, completion: @escaping ([String: Any]?) -> Void) {
        let id = UUID(), epoch = generation
        let connection = LocalDashboardHTTP()
        connections[id] = connection
        connection.send(body, token: token) { [weak self] result in
            guard let self else { return }
            self.connections[id] = nil
            guard self.generation == epoch else { return }
            completion(result)
        }
    }
    @objc private func pair() {
        guard token == nil, connections.isEmpty else { return }
        let value = code.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard value.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil else {
            status.stringValue = "Paste the complete pairing code from the local dashboard."; return
        }
        pairButton.isEnabled = false
        stopButton.isEnabled = true
        status.stringValue = "Connecting to the local dashboard…"
        send(["operation": "pair", "code": value, "name": String((Host.current().localizedName ?? "My Mac").prefix(100)), "permissions": permissions()], token: nil) { [weak self] result in
            guard let self else { return }
            guard let token = result?["token"] as? String, token.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
                  let deviceId = result?["deviceId"] as? String, UUID(uuidString: deviceId) != nil else {
                self.disconnect(message: "Could not pair. Check the web server is running and create a fresh code."); return
            }
            self.token = token
            self.code.stringValue = ""
            self.code.isEnabled = false
            self.status.stringValue = "Connected to your local browser. Waiting for a snapshot request."
            self.timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.poll() }
            self.poll()
        }
    }
    private func poll() {
        guard let token, !polling else { return }
        polling = true
        send(["operation": "poll", "permissions": permissions()], token: token) { [weak self] result in
            guard let self else { return }
            self.polling = false
            guard let result else { self.disconnect(message: "Connection lost. Pending images were discarded. Pair again to reconnect."); return }
            if let pending = result["request"] as? [String: Any] {
                let formatter = ISO8601DateFormatter()
                formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                guard let id = pending["id"] as? String, UUID(uuidString: id) != nil,
                      let expiry = pending["expiresAt"] as? String, let date = formatter.date(from: expiry),
                      date > Date(), date.timeIntervalSinceNow <= 125 else {
                    self.disconnect(message: "Invalid or expired request. Pair again to reconnect."); return
                }
                if self.currentRequest?.id != id {
                    self.onCancelRequest?()
                    let request = DashboardSnapshotRequest(id: id, expiresAt: date)
                    self.currentRequest = request
                    self.status.stringValue = "Snapshot requested. Choose a source in Capture, then review and share or decline."
                    self.onRequest?(request)
                }
            } else if result["request"] is NSNull {
                if self.currentRequest != nil { self.onCancelRequest?(); self.currentRequest = nil }
                let message = "Connected to your local browser. Waiting for a snapshot request."
                if self.status.stringValue != message { self.status.stringValue = message }
            } else { self.disconnect(message: "Unexpected reply. Pair again to reconnect.") }
        }
    }

    func share(requestId: String, snapshot: [String: Any], completion: @escaping (Bool) -> Void) {
        guard let token, currentRequest?.id == requestId, let expiry = currentRequest?.expiresAt, expiry > Date() else { completion(false); return }
        var body = snapshot
        body["operation"] = "share"
        body["requestId"] = requestId
        send(body, token: token) { [weak self] result in
            completion(result != nil)
            if result == nil { self?.disconnect(message: "Sharing was not confirmed. The preview was discarded. Pair again to reconnect.") }
        }
    }
    func decline(requestId: String) {
        guard let token, currentRequest?.id == requestId else { return }
        send(["operation": "result", "requestId": requestId, "result": "denied"], token: token) { [weak self] result in
            if result == nil { self?.disconnect(message: "Connection lost. Pair again to reconnect.") }
        }
    }
    @objc private func stop() { disconnect(message: "Disconnected. Pending images were discarded.") }
    func disconnect(message: String = "Disconnected.") {
        let oldToken = token
        generation = UUID()
        timer?.invalidate(); timer = nil
        for connection in connections.values { connection.cancel() }
        connections.removeAll()
        token = nil; currentRequest = nil; polling = false
        onCancelRequest?()
        code.stringValue = ""; code.isEnabled = true
        pairButton.isEnabled = true; stopButton.isEnabled = false
        status.stringValue = message
        if let oldToken {
            // Best effort revocation; the broker also expires offline work.
            send(["operation": "disconnect"], token: oldToken) { _ in }
        }
    }
    func windowWillClose(_ notification: Notification) { stop() }
}
