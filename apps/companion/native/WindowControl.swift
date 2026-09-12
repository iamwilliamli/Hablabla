import AppKit
import ApplicationServices
import Carbon

struct DashboardControlRequest {
    let id: String
    let expiresAt: Date
    let kind: String
    let catalogId: String?
    let windowId: String?
    let action: [String: Any]?
}

private func axValue(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
    return value
}
private func axElement(_ value: CFTypeRef?) -> AXUIElement? {
    guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}
private struct SharedWindow {
    let id = UUID().uuidString.lowercased()
    let app: NSRunningApplication
    let element: AXUIElement
    let title: String
    let minimized: Bool
    var name: String { String((app.localizedName ?? "Application").prefix(100)) }
    var json: [String: Any] { ["id": id, "app": name, "title": String(title.prefix(160)), "minimized": minimized] }
}

/// Retained AX handles never cross the connection. Every input is separately
/// approved, claimed once at the broker, and checked against the focused window.
final class WindowControlController: NSWindowController, NSWindowDelegate {
    var share: ((String, [String: Any], @escaping (Bool) -> Void) -> Void)?
    var authorize: ((DashboardControlRequest, @escaping (Bool) -> Void) -> Void)?
    var finish: ((String, String) -> Void)?
    private let heading = NSTextField(labelWithString: "Window access")
    private let detail = NSTextField(wrappingLabelWithString: "")
    private let rows = NSStackView()
    private let status = NSTextField(wrappingLabelWithString: "")
    private var approveButton: NSButton!
    private var denyButton: NSButton!
    private var checks: [NSButton] = []
    private var candidates: [SharedWindow] = []
    private var shared: [SharedWindow] = []
    private var catalogId: String?
    private var catalogExpires = Date.distantPast
    private var request: DashboardControlRequest?
    private var epoch = UUID()
    private var timer: Timer?
    private var working = false
    private let queue = DispatchQueue(label: "com.hablabla.companion.windows", qos: .userInitiated)
    private var admitted = Set<String>()

    init() {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 700, height: 590), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Hablabla Companion — Approve Control"
        window.minSize = NSSize(width: 620, height: 500)
        window.isReleasedWhenClosed = false
        super.init(window: window)
        window.delegate = self
        heading.font = .systemFont(ofSize: 23, weight: .bold)
        detail.isSelectable = true
        rows.orientation = .vertical; rows.alignment = .leading; rows.spacing = 10
        rows.translatesAutoresizingMaskIntoConstraints = false
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true; scroll.borderType = .bezelBorder
        scroll.documentView = rows
        approveButton = NSButton(title: "Share Selected Windows", target: self, action: #selector(approve))
        denyButton = NSButton(title: "Decline", target: self, action: #selector(deny))
        for button in [approveButton!, denyButton!] { button.bezelStyle = .rounded }
        let buttons = NSStackView(views: [approveButton, denyButton]); buttons.spacing = 12
        let note = NSTextField(wrappingLabelWithString: "Only this Mac’s paired browser receives selected window titles. Each control request needs a separate approval here. Disconnect in Local Dashboard to stop. An action already sent cannot be undone.")
        note.font = .systemFont(ofSize: 12); note.textColor = .secondaryLabelColor
        let stack = NSStackView(views: [heading, detail, scroll, status, buttons, note])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 16; stack.translatesAutoresizingMaskIntoConstraints = false
        window.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(equalTo: window.contentView!.bottomAnchor, constant: -24),
            rows.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor, constant: -16),
            scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 180)
        ])
        for view in [detail, scroll, status, note] { view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true }
        window.center()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            guard let self else { return }
            if Date() >= self.catalogExpires || !AXIsProcessTrusted() { self.shared.removeAll(); self.catalogId = nil }
            if let request = self.request, request.expiresAt <= Date() || !AXIsProcessTrusted() {
                self.complete(self.working ? "unknown" : "failed", "Request expired or Accessibility is unavailable.")
            }
        }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func cancel(clearCatalog: Bool = false) {
        epoch = UUID(); request = nil; working = false
        candidates.removeAll(); checks.removeAll()
        for view in rows.arrangedSubviews { rows.removeArrangedSubview(view); view.removeFromSuperview() }
        detail.stringValue = ""; status.stringValue = ""
        window?.orderOut(nil)
        if clearCatalog { shared.removeAll(); catalogId = nil; admitted.removeAll() }
    }
    func begin(_ input: DashboardControlRequest) {
        cancel()
        request = input
        guard AXIsProcessTrusted() else { complete("failed", "Accessibility is not granted. Open Setup & Permissions."); return }
        heading.stringValue = input.kind == "list_windows" ? "Choose windows to share" : "Approve one action"
        approveButton.title = input.kind == "list_windows" ? "Share Selected Windows" : "Approve Once"
        approveButton.isEnabled = false; denyButton.isEnabled = true; denyButton.title = "Decline"
        status.stringValue = ""
        showWindow(nil); NSApp.activate(ignoringOtherApps: true); window?.makeKeyAndOrderFront(nil)
        if input.kind == "list_windows" {
            shared.removeAll(); catalogId = nil
            detail.stringValue = "Choose which app names and window titles this browser may see. Nothing is selected automatically. The list expires after three minutes."
            status.stringValue = "Reading available windows…"
            let generation = epoch
            let apps = Array(NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular && $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }.prefix(40))
            queue.async { [weak self] in
                var found: [SharedWindow] = []
                let deadline = Date().addingTimeInterval(6)
                for app in apps where !app.isTerminated {
                    if Date() >= deadline || found.count >= 50 || !AXIsProcessTrusted() { break }
                    let root = AXUIElementCreateApplication(app.processIdentifier)
                    AXUIElementSetMessagingTimeout(root, 0.15)
                    var values: CFArray?
                    guard AXUIElementCopyAttributeValues(root, kAXWindowsAttribute as CFString, 0, 50 - found.count, &values) == .success,
                          let windows = values as? [AXUIElement] else { continue }
                    for element in windows {
                        if Date() >= deadline { break }
                        AXUIElementSetMessagingTimeout(element, 0.15)
                        guard axValue(element, kAXRoleAttribute) as? String == kAXWindowRole else { continue }
                        let title = axValue(element, kAXTitleAttribute) as? String ?? ""
                        found.append(SharedWindow(app: app, element: element, title: title.isEmpty ? "Untitled window" : title,
                            minimized: axValue(element, kAXMinimizedAttribute) as? Bool ?? false))
                    }
                }
                let result = found
                DispatchQueue.main.async {
                    guard let self, self.epoch == generation, self.request?.id == input.id else { return }
                    self.candidates = result
                    for item in result {
                        let button = NSButton(checkboxWithTitle: "\(item.name) — \(String(item.title.prefix(160)))\(item.minimized ? " (minimized)" : "")", target: nil, action: nil)
                        button.lineBreakMode = .byTruncatingTail
                        button.toolTip = String(item.title.prefix(160))
                        self.checks.append(button); self.rows.addArrangedSubview(button)
                        button.widthAnchor.constraint(lessThanOrEqualTo: self.rows.widthAnchor).isActive = true
                    }
                    self.status.stringValue = "\(result.count) windows available. Some apps do not expose windows through Accessibility."
                    self.approveButton.isEnabled = true
                }
            }
        } else {
            guard let target = target(for: input), let action = input.action, let summary = describe(action) else {
                complete("failed", "This window selection is no longer available. Share a fresh list."); return
            }
            let review = NSTextField(wrappingLabelWithString: "Target: \(target.name)\nWindow: \(String(target.title.prefix(160)))\n\n\(summary)\n\nThe companion will bring this window forward first. Review the full action before approving.")
            review.isSelectable = true; rows.addArrangedSubview(review)
            review.widthAnchor.constraint(equalTo: rows.widthAnchor).isActive = true
            detail.stringValue = "Review the target and exact action below. Nothing is sent until you approve."
            status.stringValue = "Waiting for your approval. Keyboard input goes to this window’s focused control."
            approveButton.isEnabled = true
        }
    }
    private func target(for input: DashboardControlRequest) -> SharedWindow? {
        guard input.catalogId == catalogId, Date() < catalogExpires else { return nil }
        return shared.first { $0.id == input.windowId && !$0.app.isTerminated }
    }
    private func describe(_ action: [String: Any]) -> String? {
        guard let kind = action["kind"] as? String else { return nil }
        switch kind {
        case "activate_window": return "Bring this window to the front. Restore it if minimized."
        case "type_text":
            guard let text = action["text"] as? String, !text.isEmpty, text.count <= 500, text.unicodeScalars.allSatisfy({ $0.value >= 32 && $0.value != 127 }) else { return nil }
            return "Type exactly this text (without pressing Return):\n\n\(text)"
        case "key":
            guard let key = action["key"] as? String, Self.keys[key] != nil, let modifiers = action["modifiers"] as? [String], modifiers.count <= 4, Set(modifiers).count == modifiers.count,
                  modifiers.allSatisfy({ ["command", "shift", "option", "control"].contains($0) }) else { return nil }
            return "Press: \((modifiers + [key]).joined(separator: " + "))"
        case "pointer", "scroll":
            guard let point = normalizedPoint(action["point"]) else { return nil }
            let location = "\(Int(point.x * 100))% from the left, \(Int(point.y * 100))% from the top of the window"
            if kind == "scroll" {
                guard let dx = action["dx"] as? Int, let dy = action["dy"] as? Int, abs(dx) <= 600, abs(dy) <= 600 else { return nil }
                return "Scroll at \(location). Horizontal: \(dx) pixels; vertical: \(dy) pixels (positive = up/left)."
            }
            guard let mode = action["mode"] as? String, ["move", "click", "double_click", "right_click", "drag"].contains(mode) else { return nil }
            if mode == "drag" {
                guard let end = normalizedPoint(action["end"]) else { return nil }
                return "Drag from \(location) to \(Int(end.x * 100))% left / \(Int(end.y * 100))% top within this window."
            }
            guard action["end"] == nil else { return nil }
            return "\(mode.replacingOccurrences(of: "_", with: " ").capitalized) at \(location)."
        default: return nil
        }
    }
    private func normalizedPoint(_ value: Any?) -> CGPoint? {
        guard let point = value as? [String: Any], let x = point["x"] as? Double, let y = point["y"] as? Double, x.isFinite, y.isFinite, (0...1).contains(x), (0...1).contains(y) else { return nil }
        return CGPoint(x: x, y: y)
    }
    @objc private func approve() {
        guard let request, !working, request.expiresAt > Date(), AXIsProcessTrusted() else { return }
        working = true; approveButton.isEnabled = false; denyButton.isEnabled = false
        let generation = epoch
        if request.kind == "list_windows" {
            let selected = zip(candidates, checks).filter { $0.1.state == .on }.map { $0.0 }
            let id = UUID().uuidString.lowercased(), expiry = Date().addingTimeInterval(175)
            let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            share?(request.id, ["id": id, "expiresAt": formatter.string(from: expiry), "windows": selected.map(\.json)]) { [weak self] ok in
                guard let self, self.epoch == generation else { return }
                if ok { self.shared = selected; self.catalogId = id; self.catalogExpires = expiry }
                self.request = nil; self.working = false
                self.status.stringValue = ok ? "Shared \(selected.count) selected windows with your local dashboard." : "Sharing was not confirmed. Request a fresh list."
                self.denyButton.title = "Close"; self.denyButton.isEnabled = true
            }
        } else {
            guard let target = target(for: request), let action = request.action, describe(action) != nil, !admitted.contains(request.id) else { complete("failed", "Stale or invalid action. Request a fresh window list."); return }
            admitted.insert(request.id)
            authorize?(request) { [weak self] allowed in
                guard let self, self.epoch == generation, self.request?.id == request.id else { return }
                guard allowed, self.valid(request, target) else { self.complete("unknown", "Authorization or target could not be confirmed. No input was sent."); return }
                self.window?.orderOut(nil)
                // A single approved attempt; no fallback keystrokes or retries.
                if axValue(target.element, kAXMinimizedAttribute) as? Bool == true {
                    guard AXUIElementSetAttributeValue(target.element, kAXMinimizedAttribute as CFString, kCFBooleanFalse) == .success else { self.complete("failed", "Could not restore the selected window."); return }
                }
                _ = AXUIElementSetAttributeValue(target.element, kAXMainAttribute as CFString, kCFBooleanTrue)
                if #available(macOS 14.0, *) { NSApp.yieldActivation(to: target.app) }
                _ = target.app.activate(options: [.activateIgnoringOtherApps])
                _ = AXUIElementPerformAction(target.element, kAXRaiseAction as CFString)
                self.confirmFocus(request, target, action, generation: generation, remaining: 20)
            }
        }
    }
    private func confirmFocus(_ request: DashboardControlRequest, _ target: SharedWindow, _ action: [String: Any], generation: UUID, remaining: Int) {
        // Unminimizing animates asynchronously. Recheck state for at most two
        // seconds without replaying activation or any input event.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            guard self.epoch == generation else { return }
            guard self.valid(request, target) else { self.complete("unknown", "Target changed while activating. No input was sent."); return }
            guard self.focused(target) else {
                if remaining > 1 { self.confirmFocus(request, target, action, generation: generation, remaining: remaining - 1) }
                else { self.complete("unknown", "The selected window is not focused. No input was sent.") }
                return
            }
            if action["kind"] as? String == "activate_window" { self.complete("succeeded", "The selected window is now focused."); return }
            let delivered = self.sendInput(action, to: target)
            self.complete(delivered ? "dispatched" : "failed", delivered ? "Input sent once. Check the target app for its result." : "Input was blocked: focus, protected input, or pointer target could not be verified.")
        }
    }
    private func valid(_ request: DashboardControlRequest, _ target: SharedWindow) -> Bool {
        guard self.request?.id == request.id, Date() < request.expiresAt, AXIsProcessTrusted(), self.target(for: request) != nil,
              axValue(target.element, kAXRoleAttribute) as? String == kAXWindowRole else { return false }
        let title = axValue(target.element, kAXTitleAttribute) as? String ?? ""
        return (title.isEmpty ? "Untitled window" : title) == target.title
    }
    private func focused(_ target: SharedWindow) -> Bool {
        guard AXIsProcessTrusted(), !target.app.isTerminated, NSWorkspace.shared.frontmostApplication?.processIdentifier == target.app.processIdentifier else { return false }
        let app = AXUIElementCreateApplication(target.app.processIdentifier); AXUIElementSetMessagingTimeout(app, 0.15)
        guard let window = axElement(axValue(app, kAXFocusedWindowAttribute)) else { return false }
        return CFEqual(window, target.element)
    }
    private func bounds(_ target: SharedWindow) -> CGRect? {
        guard let p = axValue(target.element, kAXPositionAttribute), CFGetTypeID(p) == AXValueGetTypeID(),
              let s = axValue(target.element, kAXSizeAttribute), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
        var origin = CGPoint.zero, size = CGSize.zero
        guard AXValueGetValue(p as! AXValue, .cgPoint, &origin), AXValueGetValue(s as! AXValue, .cgSize, &size),
              origin.x.isFinite, origin.y.isFinite, size.width > 1, size.height > 1, size.width < 20000, size.height < 20000 else { return nil }
        return CGRect(origin: origin, size: size)
    }
    private func ownsPoint(_ point: CGPoint, _ target: SharedWindow) -> Bool {
        let root = AXUIElementCreateSystemWide(); AXUIElementSetMessagingTimeout(root, 0.15)
        var value: AXUIElement?
        guard AXUIElementCopyElementAtPosition(root, Float(point.x), Float(point.y), &value) == .success, let element = value else { return false }
        var pid: pid_t = 0
        guard AXUIElementGetPid(element, &pid) == .success, pid == target.app.processIdentifier else { return false }
        if CFEqual(element, target.element) { return true }
        guard let window = axElement(axValue(element, kAXWindowAttribute)) else { return false }
        return CFEqual(window, target.element)
    }
    private func sendInput(_ action: [String: Any], to target: SharedWindow) -> Bool {
        guard focused(target), !IsSecureEventInputEnabled(), let kind = action["kind"] as? String,
              let source = CGEventSource(stateID: .privateState) else { return false }
        if kind == "type_text" || kind == "key" {
            let key = kind == "key" ? Self.keys[action["key"] as? String ?? ""] : CGKeyCode(0)
            guard let key, let down = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: true),
                  let up = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: false) else { return false }
            if kind == "type_text", let text = action["text"] as? String {
                let units = Array(text.utf16)
                down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
                up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
            } else {
                var flags: CGEventFlags = []
                for modifier in action["modifiers"] as? [String] ?? [] {
                    switch modifier { case "command": flags.insert(.maskCommand); case "shift": flags.insert(.maskShift); case "option": flags.insert(.maskAlternate); case "control": flags.insert(.maskControl); default: return false }
                }
                down.flags = flags; up.flags = flags
            }
            guard focused(target), !IsSecureEventInputEnabled() else { return false }
            // Target the approved process; a last-moment app switch cannot type into another app.
            down.postToPid(target.app.processIdentifier); up.postToPid(target.app.processIdentifier)
            return true
        }
        guard let rect = bounds(target), let relative = normalizedPoint(action["point"]) else { return false }
        func absolute(_ point: CGPoint) -> CGPoint { CGPoint(x: rect.minX + point.x * (rect.width - 1), y: rect.minY + point.y * (rect.height - 1)) }
        let point = absolute(relative)
        guard ownsPoint(point, target), focused(target) else { return false }
        if kind == "scroll" {
            guard let dx = action["dx"] as? Int, let dy = action["dy"] as? Int,
                  let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: Int32(dy), wheel2: Int32(dx), wheel3: 0) else { return false }
            event.location = point
            guard CGWarpMouseCursorPosition(point) == .success, ownsPoint(point, target), focused(target) else { return false }
            event.post(tap: .cghidEventTap); return true
        }
        guard let mode = action["mode"] as? String else { return false }
        var events: [CGEvent] = []
        func append(_ type: CGEventType, _ location: CGPoint, _ button: CGMouseButton = .left, count: Int64 = 1) -> Bool {
            guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: location, mouseButton: button) else { return false }
            event.setIntegerValueField(.mouseEventClickState, value: count); events.append(event); return true
        }
        if mode == "move" { return focused(target) && CGWarpMouseCursorPosition(point) == .success }
        else if mode == "drag" {
            guard let relativeEnd = normalizedPoint(action["end"]) else { return false }
            let end = absolute(relativeEnd)
            for index in 0...12 {
                let fraction = Double(index) / 12
                let position = CGPoint(x: point.x + (end.x - point.x) * fraction, y: point.y + (end.y - point.y) * fraction)
                guard ownsPoint(position, target), append(index == 0 ? .leftMouseDown : .leftMouseDragged, position) else { return false }
            }
            guard append(.leftMouseUp, end) else { return false }
        } else {
            let right = mode == "right_click"
            for count in 1...(mode == "double_click" ? 2 : 1) {
                guard append(right ? .rightMouseDown : .leftMouseDown, point, right ? .right : .left, count: Int64(count)),
                      append(right ? .rightMouseUp : .leftMouseUp, point, right ? .right : .left, count: Int64(count)) else { return false }
            }
        }
        guard focused(target), !IsSecureEventInputEnabled() else { return false }
        // A complete finite gesture includes its release; no held keys/buttons survive cancellation.
        guard CGWarpMouseCursorPosition(point) == .success, ownsPoint(point, target), focused(target) else { return false }
        for event in events { event.post(tap: .cghidEventTap) }
        return true
    }
    private func complete(_ result: String, _ message: String) {
        if let request { finish?(request.id, result) }
        request = nil; working = false; epoch = UUID()
        status.stringValue = message; detail.stringValue = ""
        approveButton.isEnabled = false; denyButton.title = "Close"; denyButton.isEnabled = true
    }
    @objc private func deny() {
        if let request, !working { finish?(request.id, "denied") }
        cancel()
    }
    func windowWillClose(_ notification: Notification) {
        if let request { finish?(request.id, working ? "unknown" : "denied") }
        cancel()
    }
    private static let keys: [String: CGKeyCode] = [
        "a": 0, "s": 1, "f": 3, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "r": 15, "t": 17, "p": 35, "n": 45, "i": 34, "u": 32,
        "Enter": 36, "Tab": 48, "Escape": 53, "Backspace": 51, "Delete": 117, "Space": 49,
        "ArrowUp": 126, "ArrowDown": 125, "ArrowLeft": 123, "ArrowRight": 124, "Home": 115, "End": 119, "PageUp": 116, "PageDown": 121
    ]
}
