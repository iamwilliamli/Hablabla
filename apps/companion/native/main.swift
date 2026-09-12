import Foundation
import AppKit
import Security
import CryptoKit

// A deliberately fixed native vocabulary. JSON travels through stdin, never a shell.
let service = "com.hablabla.companion.device"
func emit(_ value: [String: String]) {
    let data = try! JSONSerialization.data(withJSONObject: value)
    FileHandle.standardOutput.write(data)
}
func fail() -> Never { emit(["error": "native_operation_failed"]); exit(1) }
func handleRequest() {
// --stdio is reserved for the local Terminal runner; Finder launch never reads stdin.
let data = FileHandle.standardInput.readDataToEndOfFile()
guard data.count < 16384,
      let request = try? JSONSerialization.jsonObject(with: data) as? [String: String],
      let op = request["op"] else { fail() }
if op == "identity" {
    guard let id = Bundle.main.bundleIdentifier,
          let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String else { fail() }
    emit(["value": id, "version": version, "bundlePath": Bundle.main.bundlePath])
} else if op == "open_resource" {
    guard let path = request["path"], path.hasPrefix("/"), let expected = request["sha256"] else { fail() }
    let url = URL(fileURLWithPath: path)
    let allowed = ["pdf", "ppt", "pptx", "key", "txt"]
    guard allowed.contains(url.pathExtension.lowercased()),
          url.resolvingSymlinksInPath().path == path,
          let attrs = try? FileManager.default.attributesOfItem(atPath: path),
          attrs[.type] as? FileAttributeType == .typeRegular,
          let size = attrs[.size] as? NSNumber, size.intValue <= 100 * 1024 * 1024,
          let content = try? Data(contentsOf: url) else { fail() }
    let digest = SHA256.hash(data: content).map { String(format: "%02x", $0) }.joined()
    guard digest == expected, NSWorkspace.shared.open(url) else { fail() }
    // Launch Services accepted opening. This is not a screenshot/visibility claim.
    emit(["value": "open_dispatched"])
} else {
    guard let account = request["account"], UUID(uuidString: account) != nil else { fail() }
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service, kSecAttrAccount as String: account]
    switch op {
    case "keychain_set":
        guard let value = request["value"], value.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { fail() }
        let bytes = Data(value.utf8)
        let updated = SecItemUpdate(query as CFDictionary, [kSecValueData as String: bytes] as CFDictionary)
        if updated == errSecItemNotFound {
            var item = query
            item[kSecValueData as String] = bytes
            item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { fail() }
        } else if updated != errSecSuccess { fail() }
        emit(["value": "stored"])
    case "keychain_get":
        var lookup = query
        lookup[kSecReturnData as String] = true
        lookup[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(lookup as CFDictionary, &result) == errSecSuccess,
              let bytes = result as? Data, let value = String(data: bytes, encoding: .utf8) else { fail() }
        emit(["value": value])
    case "keychain_delete":
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { fail() }
        emit(["value": "deleted"])
    default: fail()
    }
}

}

final class CompanionAppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let image = NSImage(systemSymbolName: "desktopcomputer", accessibilityDescription: "Hablabla Companion") {
            image.isTemplate = true
            item.button?.image = image
        } else { item.button?.title = "HB" }
        item.button?.toolTip = "Hablabla Companion — native helper"
        item.button?.setAccessibilityLabel("Hablabla Companion")
        let menu = NSMenu()
        let title = NSMenuItem(title: "Hablabla Companion", action: nil, keyEquivalent: "")
        title.isEnabled = false
        menu.addItem(title)
        menu.addItem(NSMenuItem(title: "Connection and approvals run in Terminal", action: nil, keyEquivalent: ""))
        menu.addItem(.separator())
        let about = NSMenuItem(title: "About Hablabla Companion…", action: #selector(showAbout), keyEquivalent: "")
        about.target = self
        menu.addItem(about)
        let quit = NSMenuItem(title: "Quit Helper", action: #selector(quitHelper), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        item.menu = menu
        statusItem = item
        showAbout()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showAbout() }
        return true
    }

    @objc private func showAbout() {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Hablabla Companion"
        alert.informativeText = "Native helper for approved document opening.\n\nPairing, the device connection, and approval prompts run in your Terminal. Quitting this menu-bar helper does not stop that separate Terminal process.\n\nScreen capture and remote input are not enabled in this version."
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    @objc private func quitHelper() { NSApp.terminate(nil) }
}

if CommandLine.arguments.dropFirst().elementsEqual(["--stdio"]) {
    handleRequest()
} else if CommandLine.arguments.count == 1 {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let delegate = CompanionAppDelegate()
    app.delegate = delegate
    withExtendedLifetime(delegate) { app.run() }
} else {
    fail()
}
