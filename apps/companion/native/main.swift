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
let data = FileHandle.standardInput.readDataToEndOfFile()
guard data.count < 16384,
      let request = try? JSONSerialization.jsonObject(with: data) as? [String: String],
      let op = request["op"] else { fail() }
if op == "open_resource" {
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
