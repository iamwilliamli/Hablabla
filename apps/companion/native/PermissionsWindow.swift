import AppKit
import ApplicationServices
import CoreGraphics

/// These checks run in the launched companion, never in the Terminal RPC helper.
final class PermissionsWindowController: NSWindowController, NSWindowDelegate {
    var onOpenCapture: (() -> Void)?
    var onOpenDashboard: (() -> Void)?
    private let screenStatus = NSTextField(labelWithString: "Checking…")
    private let accessibilityStatus = NSTextField(labelWithString: "Checking…")
    private let checkedAt = NSTextField(labelWithString: "")
    private let feedback = NSTextField(wrappingLabelWithString: "")
    private var screenRequest: NSButton!
    private var accessibilityRequest: NSButton!
    private var refreshTimer: Timer?
    private var lastAccess: (screen: Bool, accessibility: Bool)?

    init() {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 640, height: 650),
                              styleMask: [.titled, .closable, .miniaturizable],
                              backing: .buffered, defer: false)
        window.title = "Hablabla Companion — Setup"
        window.isReleasedWhenClosed = false
        super.init(window: window)
        window.delegate = self
        buildContent()
        window.center()
        NotificationCenter.default.addObserver(self, selector: #selector(pollStatus),
            name: NSApplication.didBecomeActiveNotification, object: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func present() {
        showWindow(nil)
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
        refreshStatus()
        refreshTimer?.invalidate()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            self?.pollStatus()
        }
    }

    func windowWillClose(_ notification: Notification) {
        refreshTimer?.invalidate()
        refreshTimer = nil
    }

    private func label(_ text: String, size: CGFloat = 13, weight: NSFont.Weight = .regular) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: text)
        label.font = .systemFont(ofSize: size, weight: weight)
        return label
    }

    private func button(_ title: String, action: Selector) -> NSButton {
        let button = NSButton(title: title, target: self, action: action)
        button.bezelStyle = .rounded
        return button
    }

    private func section(_ title: String, description: String, status: NSTextField,
                         request: NSButton, settingsAction: Selector) -> NSView {
        let heading = label(title, size: 16, weight: .semibold)
        status.font = .systemFont(ofSize: 13, weight: .semibold)
        let settings = button("Open Settings…", action: settingsAction)
        settings.setAccessibilityLabel("Open \(title) settings")
        let actions = NSStackView(views: [request, settings])
        actions.orientation = .horizontal
        actions.spacing = 10
        let stack = NSStackView(views: [heading, status, label(description), actions])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 9
        return stack
    }

    private func buildContent() {
        guard let content = window?.contentView else { return }
        screenRequest = button("Request Screen Recording…", action: #selector(requestScreen))
        accessibilityRequest = button("Request Accessibility…", action: #selector(requestAccessibility))
        let title = label("Set up your companion", size: 25, weight: .bold)
        let intro = label("Live macOS permission checks for Hablabla Companion on this Mac. Opening this window does not request access.")
        let screen = section("Screen Recording",
            description: "Allows reading screen content. Open Capture to choose a window or display and preview one snapshot locally.",
            status: screenStatus, request: screenRequest, settingsAction: #selector(openScreenSettings))
        let accessibility = section("Accessibility",
            description: "Allows controlling apps for future approved actions. This version does not send mouse or keyboard input.",
            status: accessibilityStatus, request: accessibilityRequest, settingsAction: #selector(openAccessibilitySettings))
        let note = label("After changing access in System Settings, return here to check again. Screen Recording may require quitting and reopening this app. “Not granted” means macOS currently reports no access; it does not tell us whether you declined or have never been asked.")
        note.textColor = .secondaryLabelColor
        feedback.font = .systemFont(ofSize: 13)
        let refresh = button("Refresh Status", action: #selector(refreshStatus))
        refresh.keyEquivalent = "r"
        refresh.keyEquivalentModifierMask = .command
        checkedAt.font = .systemFont(ofSize: 12)
        checkedAt.textColor = .secondaryLabelColor
        let capture = button("Open Capture…", action: #selector(openCapture))
        let dashboard = button("Local Dashboard…", action: #selector(openDashboard))
        let footer = NSStackView(views: [refresh, capture, dashboard])
        footer.orientation = .horizontal
        footer.spacing = 12
        let identity = label("App: \(Bundle.main.bundleIdentifier ?? "Unknown")\nDocument approvals continue in Terminal. Use Local Dashboard for approved snapshot sharing.", size: 12)
        identity.textColor = .secondaryLabelColor
        identity.isSelectable = true
        let stack = NSStackView(views: [title, intro, screen, accessibility, note, feedback, footer, checkedAt, identity])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 15
        stack.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 28),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -28),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 26),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: content.bottomAnchor, constant: -24)
        ])
        for view in [intro, screen, accessibility, note, feedback, identity] {
            view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
    }

    @objc private func refreshStatus() {
        readStatus(updateTime: true)
    }

    @objc private func pollStatus() {
        readStatus(updateTime: false)
    }

    private func readStatus(updateTime: Bool) {
        guard window?.isVisible == true else { return }
        // Preflight APIs only: neither check displays a permission prompt.
        let screenGranted = CGPreflightScreenCaptureAccess()
        let accessibilityGranted = AXIsProcessTrusted()
        let changed = lastAccess?.screen != screenGranted || lastAccess?.accessibility != accessibilityGranted
        if changed {
            update(screenStatus, permission: "Screen Recording", granted: screenGranted)
            update(accessibilityStatus, permission: "Accessibility", granted: accessibilityGranted)
            screenRequest.isEnabled = !screenGranted
            accessibilityRequest.isEnabled = !accessibilityGranted
            lastAccess = (screenGranted, accessibilityGranted)
        }
        // Keep background polling quiet for VoiceOver and other accessibility clients.
        if changed || updateTime {
            checkedAt.stringValue = "Checked \(DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .medium))"
        }
    }

    private func update(_ status: NSTextField, permission: String, granted: Bool) {
        status.stringValue = granted ? "Granted" : "Not granted"
        status.textColor = granted ? .systemGreen : .labelColor
        status.setAccessibilityLabel("\(permission): \(status.stringValue)")
    }

    @objc private func requestScreen() {
        // Only an explicit click requests access; use a fresh preflight for the displayed state.
        _ = CGRequestScreenCaptureAccess()
        feedback.stringValue = "If access still shows as not granted, open Screen Recording settings. macOS may ask you to quit and reopen the companion."
        refreshStatus()
    }

    @objc private func requestAccessibility() {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
        feedback.stringValue = "Complete the Accessibility request in System Settings, then return here. The request itself does not grant access."
        refreshStatus()
    }

    private func openSettings(_ pane: String) {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)"),
              NSWorkspace.shared.open(url) else {
            feedback.stringValue = "Open System Settings → Privacy & Security manually, then select the permission."
            return
        }
        feedback.stringValue = "In Privacy & Security, select Hablabla Companion. Return here after making your choice."
    }

    @objc private func openScreenSettings() { openSettings("Privacy_ScreenCapture") }
    @objc private func openAccessibilitySettings() { openSettings("Privacy_Accessibility") }
    @objc private func openCapture() { onOpenCapture?() }
    @objc private func openDashboard() { onOpenDashboard?() }
}
