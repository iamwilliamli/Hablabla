import AppKit
import ScreenCaptureKit

/// Snapshot pixels must not become the window's minimum layout size.
private final class SnapshotImageView: NSImageView {
    override var intrinsicContentSize: NSSize {
        NSSize(width: NSView.noIntrinsicMetric, height: NSView.noIntrinsicMetric)
    }
}

/// A separate observer per picker request prevents late callbacks from selecting
/// content for a newer request after Clear or window closure.
@available(macOS 14.0, *)
private final class CapturePickerObserver: NSObject, SCContentSharingPickerObserver {
    let selected: (SCContentFilter) -> Void
    let cancelled: () -> Void
    let failed: () -> Void

    init(selected: @escaping (SCContentFilter) -> Void,
         cancelled: @escaping () -> Void, failed: @escaping () -> Void) {
        self.selected = selected
        self.cancelled = cancelled
        self.failed = failed
    }

    func contentSharingPicker(_ picker: SCContentSharingPicker, didUpdateWith filter: SCContentFilter, for stream: SCStream?) {
        DispatchQueue.main.async { self.selected(filter) }
    }
    func contentSharingPicker(_ picker: SCContentSharingPicker, didCancelFor stream: SCStream?) {
        DispatchQueue.main.async { self.cancelled() }
    }
    func contentSharingPickerStartDidFailWithError(_ error: Error) {
        DispatchQueue.main.async { self.failed() }
    }
}

@available(macOS 14.0, *)
final class CaptureWindowController: NSWindowController, NSWindowDelegate {
    private let preview = SnapshotImageView()
    private let placeholder = NSTextField(labelWithString: "Your snapshot will appear here")
    private let source = NSTextField(wrappingLabelWithString: "No source selected")
    private let status = NSTextField(wrappingLabelWithString: "Choose one window or display to begin.")
    private let metadata = NSTextField(wrappingLabelWithString: "No image captured")
    private var windowButton: NSButton!
    private var displayButton: NSButton!
    private var captureButton: NSButton!
    private var clearButton: NSButton!
    private var shareButton: NSButton!
    private var sharingRow: NSStackView!
    private var dashboardRequest: DashboardSnapshotRequest?
    private var onShare: (([String: Any], @escaping (Bool) -> Void) -> Void)?
    private var onDecline: (() -> Void)?
    private var requestTimeout: DispatchWorkItem?
    private var sharing = false
    private var snapshot: CGImage?
    private var snapshotMetadata: [String: Any]?
    private var filter: SCContentFilter?
    private var observer: CapturePickerObserver?
    private var selectionID: UUID?
    private var captureID: UUID?
    private var timeout: DispatchWorkItem?
    private var picking = false
    private var sourceDescription = ""

    init() {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 820, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Hablabla Companion — Capture"
        window.minSize = NSSize(width: 700, height: 720)
        window.isReleasedWhenClosed = false
        super.init(window: window)
        window.delegate = self
        buildContent()
        window.center()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func present() {
        showWindow(nil)
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    func beginDashboardRequest(_ request: DashboardSnapshotRequest,
                               share: @escaping ([String: Any], @escaping (Bool) -> Void) -> Void,
                               decline: @escaping () -> Void) {
        cancelDashboardRequest()
        reset() // Never reuse a standalone preview for a new dashboard request.
        dashboardRequest = request
        onShare = share; onDecline = decline
        sharingRow.isHidden = false
        status.stringValue = "Your paired browser requested a snapshot. Choose a source, capture it, then review the preview before sharing."
        let timeout = DispatchWorkItem { [weak self] in
            guard let self, self.dashboardRequest?.id == request.id else { return }
            self.cancelDashboardRequest()
            self.status.stringValue = "Dashboard request expired. No pending image was shared."
        }
        requestTimeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + max(0, request.expiresAt.timeIntervalSinceNow), execute: timeout)
        updateButtons()
        present()
    }

    func cancelDashboardRequest() {
        let hadRequest = dashboardRequest != nil
        dashboardRequest = nil; onShare = nil; onDecline = nil; sharing = false
        requestTimeout?.cancel(); requestTimeout = nil
        sharingRow.isHidden = true
        if hadRequest { reset(); status.stringValue = "Dashboard request ended. The local preview was cleared." }
    }

    @objc private func declineDashboardRequest() {
        let decline = onDecline
        cancelDashboardRequest()
        decline?()
        status.stringValue = "Declined. No image was shared with the dashboard."
    }

    @objc private func shareWithDashboard() {
        guard let request = dashboardRequest, request.expiresAt > Date(), !sharing,
              let snapshot, let metadata = snapshotMetadata, let onShare else { return }
        let bitmap = NSBitmapImageRep(cgImage: snapshot)
        guard let jpeg = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.7]),
              jpeg.count <= 2 * 1024 * 1024 else {
            status.stringValue = "This image is too large to share. Choose a smaller window or decline."; return
        }
        sharing = true
        status.stringValue = "Sharing this preview with your paired browser on this Mac…"
        updateButtons()
        onShare(["jpeg": jpeg.base64EncodedString(), "metadata": metadata]) { [weak self] succeeded in
            guard let self, self.dashboardRequest?.id == request.id else { return }
            self.cancelDashboardRequest()
            self.status.stringValue = succeeded ? "Shared with your local dashboard. The image expires there in one minute." : "Sharing was not confirmed. The local preview was cleared."
        }
    }

    private func label(_ text: String, size: CGFloat = 13, weight: NSFont.Weight = .regular) -> NSTextField {
        let view = NSTextField(wrappingLabelWithString: text)
        view.font = .systemFont(ofSize: size, weight: weight)
        return view
    }

    private func button(_ title: String, action: Selector) -> NSButton {
        let view = NSButton(title: title, target: self, action: action)
        view.bezelStyle = .rounded
        return view
    }

    private func buildContent() {
        guard let content = window?.contentView else { return }
        windowButton = button("Choose Window…", action: #selector(chooseWindow))
        displayButton = button("Choose Display…", action: #selector(chooseDisplay))
        captureButton = button("Capture Once", action: #selector(captureOnce))
        clearButton = button("Clear", action: #selector(clear))
        clearButton.setAccessibilityHelp("Discard the selected source and snapshot; ignore any pending result.")
        shareButton = button("Share with Dashboard", action: #selector(shareWithDashboard))
        let declineButton = button("Decline Request", action: #selector(declineDashboardRequest))
        sharingRow = NSStackView(views: [shareButton, declineButton])
        sharingRow.spacing = 12
        sharingRow.isHidden = true
        let buttons = NSStackView(views: [windowButton, displayButton, captureButton, clearButton])
        buttons.orientation = .horizontal
        buttons.spacing = 10
        source.font = .systemFont(ofSize: 13, weight: .semibold)
        source.maximumNumberOfLines = 2
        source.lineBreakMode = .byTruncatingTail
        metadata.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        metadata.textColor = .secondaryLabelColor
        metadata.isSelectable = true
        let well = NSView()
        well.wantsLayer = true
        well.layer?.cornerRadius = 12
        well.layer?.borderWidth = 1
        well.layer?.borderColor = NSColor.separatorColor.cgColor
        preview.imageScaling = .scaleProportionallyUpOrDown
        preview.setAccessibilityLabel("Snapshot preview, no image captured")
        placeholder.textColor = .secondaryLabelColor
        for view in [preview, placeholder] {
            view.translatesAutoresizingMaskIntoConstraints = false
            well.addSubview(view)
        }
        NSLayoutConstraint.activate([
            preview.leadingAnchor.constraint(equalTo: well.leadingAnchor, constant: 12),
            preview.trailingAnchor.constraint(equalTo: well.trailingAnchor, constant: -12),
            preview.topAnchor.constraint(equalTo: well.topAnchor, constant: 12),
            preview.bottomAnchor.constraint(equalTo: well.bottomAnchor, constant: -12),
            placeholder.centerXAnchor.constraint(equalTo: well.centerXAnchor),
            placeholder.centerYAnchor.constraint(equalTo: well.centerYAnchor),
            well.heightAnchor.constraint(greaterThanOrEqualToConstant: 220)
        ])
        let title = label("One moment from your Mac", size: 25, weight: .bold)
        let intro = label("Select a window or display using the macOS picker, then capture one still image. You choose a source again for each snapshot.")
        let privacy = label("Kept in memory. A dashboard request reveals nothing until you click Share with Dashboard. That sends this preview only to your paired browser at 127.0.0.1:3100 on this Mac, for one minute. No model receives it. Clear or close to discard.", size: 12)
        privacy.textColor = .secondaryLabelColor
        let stack = NSStackView(views: [title, intro, buttons, source, status, sharingRow, well, metadata, privacy])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.distribution = .fill
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 28),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -28),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -24)
        ])
        for view in [intro, source, status, well, metadata, privacy] {
            view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        preview.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
        well.setContentHuggingPriority(.defaultLow, for: .vertical)
        updateButtons()
    }

    private func updateButtons() {
        let busy = picking || captureID != nil || sharing
        windowButton.isEnabled = !busy
        displayButton.isEnabled = !busy
        captureButton.isEnabled = filter != nil && !busy
        clearButton.isEnabled = busy || filter != nil || preview.image != nil
        shareButton.isEnabled = dashboardRequest != nil && snapshot != nil && !busy
    }

    @objc private func chooseWindow() { choose(.window) }
    @objc private func chooseDisplay() { choose(.display) }

    private func choose(_ style: SCShareableContentStyle) {
        guard !picking, captureID == nil, !sharing else { return }
        reset()
        let id = UUID()
        selectionID = id
        picking = true
        status.stringValue = "Select one source in the macOS picker. Cancel to leave without capturing."
        let picker = SCContentSharingPicker.shared
        var configuration = SCContentSharingPickerConfiguration()
        configuration.allowedPickerModes = style == .window ? [.singleWindow] : [.singleDisplay]
        configuration.allowsChangingSelectedContent = false
        // Do not offer the preview itself as a single-window capture source.
        configuration.excludedWindowIDs = window.map { [$0.windowNumber] } ?? []
        picker.defaultConfiguration = configuration
        let observer = CapturePickerObserver(selected: { [weak self] filter in
            guard let self, self.selectionID == id, self.picking, self.window?.isVisible == true else { return }
            guard filter.style == style else {
                self.reset()
                self.status.stringValue = "The selected source type changed. Please choose again."
                return
            }
            self.picking = false
            self.filter = filter
            self.sourceDescription = self.describe(filter, selection: id)
            self.source.stringValue = self.sourceDescription
            self.status.stringValue = "Ready. Capture Once takes one image of this source."
            self.updateButtons()
            self.present()
        }, cancelled: { [weak self] in
            guard let self, self.selectionID == id else { return }
            self.reset()
            self.status.stringValue = "Selection cancelled. No image was captured."
            self.present()
        }, failed: { [weak self] in
            guard let self, self.selectionID == id else { return }
            self.reset()
            self.status.stringValue = "macOS could not open the picker. Check Screen Recording in Setup & Permissions, then try again."
            self.present()
        })
        self.observer = observer
        picker.add(observer)
        picker.isActive = true
        updateButtons()
        picker.present(using: style)
    }

    private func describe(_ filter: SCContentFilter, selection: UUID) -> String {
        if #available(macOS 15.2, *) {
            if filter.style == .window, let window = filter.includedWindows.first {
                let app = window.owningApplication?.applicationName ?? "App"
                let title = window.title?.isEmpty == false ? window.title! : "Untitled window"
                return "\(app) — \(title.prefix(120)) · Window ID \(window.windowID)"
            }
            if filter.style == .display, let display = filter.includedDisplays.first {
                return "Display ID \(display.displayID)"
            }
        }
        // Earlier SDKs expose geometry but not the picker filter's OS target IDs.
        return "Selected \(filter.style == .window ? "window" : "display") · Selection \(selection.uuidString.prefix(8))"
    }

    @objc private func captureOnce() {
        guard let filter, !picking, captureID == nil else { return }
        let rect = filter.contentRect
        let scale = Double(filter.pointPixelScale)
        let width = Double(rect.width) * scale
        let height = Double(rect.height) * scale
        guard width.isFinite, height.isFinite, width > 0, height > 0 else {
            reset()
            status.stringValue = "That source is no longer available. Choose a window or display again."
            return
        }
        let factor = min(1, 2560 / max(width, height))
        let configuration = SCStreamConfiguration()
        configuration.width = max(1, Int((width * factor).rounded()))
        configuration.height = max(1, Int((height * factor).rounded()))
        configuration.showsCursor = false
        configuration.capturesAudio = false
        configuration.ignoreShadowsSingleWindow = true
        configuration.scalesToFit = true
        let id = UUID()
        let requestedAt = Date()
        let target = sourceDescription
        var targetId = "selection:\(selectionID?.uuidString ?? UUID().uuidString)"
        if #available(macOS 15.2, *) {
            if filter.style == .window, let selected = filter.includedWindows.first { targetId = "window:\(selected.windowID)" }
            if filter.style == .display, let selected = filter.includedDisplays.first { targetId = "display:\(selected.displayID)" }
        }
        let targetKind = filter.style == .window ? "window" : "display"
        captureID = id
        status.stringValue = "Capturing one image… Clear discards any pending result."
        updateButtons()
        let timeout = DispatchWorkItem { [weak self] in
            guard let self, self.captureID == id else { return }
            self.reset()
            self.status.stringValue = "Capture timed out. No preview was kept. Choose the source again to retry."
        }
        self.timeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: timeout)
        // The picker grants access only to its selected filter. A global CG
        // preflight result is not a substitute for this scoped authorization.
        // No SCStream is created, and the result never enters the Terminal RPC.
        let completion: (CGImage?, Error?) -> Void = { [weak self] image, error in
            DispatchQueue.main.async {
                guard let self, self.captureID == id, self.window?.isVisible == true else { return }
                self.timeout?.cancel()
                self.timeout = nil
                self.captureID = nil
                self.releaseSelection()
                guard error == nil, let image else {
                    if let error = error as NSError? {
                        self.metadata.stringValue = "No image captured · macOS error \(error.code)"
                        if error.domain == SCStreamErrorDomain && error.code == SCStreamError.Code.userDeclined.rawValue {
                            self.status.stringValue = "macOS did not authorize this capture. Check Screen Recording in Setup & Permissions, quit and reopen the companion, then choose the source again."
                        } else {
                            self.status.stringValue = "Capture unavailable. The source may have closed or access may have changed. Check Setup & Permissions, then choose the source again."
                        }
                    } else {
                        self.status.stringValue = "macOS returned no image. Choose the source again to retry."
                    }
                    self.source.stringValue = "No source selected"
                    self.updateButtons()
                    return
                }
                self.preview.image = NSImage(cgImage: image, size: NSSize(width: image.width, height: image.height))
                self.snapshot = image
                self.placeholder.isHidden = true
                self.source.stringValue = target
                let receivedAt = Date()
                let iso = ISO8601DateFormatter()
                iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                self.snapshotMetadata = ["target": target, "targetId": targetId, "kind": targetKind,
                    "width": image.width, "height": image.height, "scale": scale, "capturedAt": iso.string(from: receivedAt)]
                let format = DateFormatter()
                format.dateStyle = .medium
                format.timeStyle = .medium
                self.metadata.stringValue = "\(image.width) × \(image.height) pixels · Still image\nRequested \(format.string(from: requestedAt)) · Received \(format.string(from: receivedAt))"
                self.preview.setAccessibilityLabel("Snapshot of \(target), \(image.width) by \(image.height) pixels, received \(format.string(from: receivedAt))")
                self.status.stringValue = self.dashboardRequest == nil ? "Captured locally. This image does not update. Choose a source for another snapshot." : "Review this preview. Share with Dashboard sends exactly this still image to your paired browser; Decline Request discards it."
                self.updateButtons()
            }
        }
        if #available(macOS 26.0, *) {
            let screenshot = SCScreenshotConfiguration()
            screenshot.width = configuration.width
            screenshot.height = configuration.height
            screenshot.showsCursor = false
            screenshot.ignoreShadows = true
            screenshot.includeChildWindows = false
            screenshot.dynamicRange = .sdr
            screenshot.fileURL = nil
            SCScreenshotManager.captureScreenshot(contentFilter: filter, configuration: screenshot) { output, error in
                completion(output?.sdrImage, error)
            }
        } else {
            SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration, completionHandler: completion)
        }
    }

    private func releaseSelection() {
        selectionID = nil
        filter = nil
        picking = false
        if let observer {
            SCContentSharingPicker.shared.remove(observer)
            self.observer = nil
        }
        SCContentSharingPicker.shared.isActive = false
    }

    private func reset() {
        captureID = nil // Late screenshot results must not repopulate the preview.
        timeout?.cancel()
        timeout = nil
        releaseSelection()
        preview.image = nil
        snapshot = nil
        snapshotMetadata = nil
        preview.setAccessibilityLabel("Snapshot preview, no image captured")
        placeholder.isHidden = false
        sourceDescription = ""
        source.stringValue = "No source selected"
        metadata.stringValue = "No image captured"
        updateButtons()
    }

    @objc private func clear() {
        if dashboardRequest != nil { declineDashboardRequest(); return }
        reset()
        status.stringValue = "Cleared. Any pending snapshot will be discarded."
    }

    func windowWillClose(_ notification: Notification) {
        if dashboardRequest != nil { declineDashboardRequest() }
        reset()
        status.stringValue = "Choose one window or display to begin."
    }
}
