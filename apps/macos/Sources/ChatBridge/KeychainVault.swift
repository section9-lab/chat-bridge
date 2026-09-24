import Foundation
import Security
import ChatBridgeKit

enum KeychainVault {
    private static let credentials = [
        "weixin": (account: "weixin-v1", label: "微信"),
        "vercel": (account: "vercel-ai-gateway-v1", label: "Vercel AI Gateway"),
        "openrouter": (account: "openrouter-v1", label: "OpenRouter"),
        "typesafe": (account: "typesafe-v1", label: "TypeSafe")
    ]
    static let methods = credentials.keys.flatMap { provider in
        ["read", "write", "remove"].map { "native.\(provider).credential.\($0)" }
    }
    private static func query(account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "com.chatbridge.credentials",
         kSecAttrAccount as String: account]
    }
    struct Failure: Error { let status: OSStatus }
    static func routingKey(for provider: String, read: (String, Data?) throws -> Data? = perform) throws -> String? {
        guard RoutingProvider.all.contains(where: { $0.id == provider }) else { throw Failure(status: errSecParam) }
        guard let data = try read("native.\(provider).credential.read", nil) else { return nil }
        return try JSONDecoder().decode(RoutingSecret.self, from: data).apiKey
    }
    static func perform(_ method: String, credential: Data?) throws -> Data? {
        guard methods.contains(method) else { throw Failure(status: errSecParam) }
        let parts = method.split(separator: ".").map(String.init)
        let provider = parts[1], configuration = credentials[provider]!
        let query = query(account: configuration.account)
        let validate = provider == "weixin" ? WeixinSecret.validatedData : RoutingSecret.validatedData
        switch parts[3] {
        case "read":
            var request = query
            request[kSecReturnData as String] = true
            request[kSecMatchLimit as String] = kSecMatchLimitOne
            var result: CFTypeRef?
            let status = SecItemCopyMatching(request as CFDictionary, &result)
            if status == errSecItemNotFound { return nil }
            guard status == errSecSuccess, let data = result as? Data else { throw Failure(status: status) }
            return try validate(data)
        case "write":
            guard let credential else { throw Failure(status: errSecParam) }
            let data = try validate(credential)
            let attributes = [kSecValueData as String: data] as [String: Any]
            var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
            if status == errSecItemNotFound {
                var item = query
                item[kSecValueData as String] = data
                item[kSecAttrLabel as String] = "Chat Bridge · " + configuration.label
                status = SecItemAdd(item as CFDictionary, nil)
            }
            guard status == errSecSuccess else { throw Failure(status: status) }
            return nil
        case "remove":
            let status = SecItemDelete(query as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw Failure(status: status) }
            return nil
        default: throw Failure(status: errSecParam)
        }
    }
}
