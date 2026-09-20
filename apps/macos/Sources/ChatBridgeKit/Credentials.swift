import Foundation

public struct WeixinSecret: Codable {
    let accountId: String
    let ownerId: String
    let token: String
    let baseUrl: String
    let contextKey: String
    enum Failure: Error { case invalidCredential }
    public static func validatedData(_ data: Data) throws -> Data {
        guard data.count <= 32768 else { throw Failure.invalidCredential }
        let value = try JSONDecoder().decode(Self.self, from: data)
        let strings = [value.accountId, value.ownerId, value.token, value.baseUrl, value.contextKey]
        guard strings.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 16384 && $0.rangeOfCharacter(from: .controlCharacters) == nil }),
              let url = URLComponents(string: value.baseUrl), url.scheme == "https",
              let host = url.host, host == "ilinkai.weixin.qq.com" || host.hasSuffix(".weixin.qq.com"),
              url.user == nil, url.password == nil, url.port == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/",
              let key = Data(base64Encoded: value.contextKey), key.count == 32,
              key.base64EncodedString() == value.contextKey else { throw Failure.invalidCredential }
        return try JSONEncoder().encode(value)
    }
}

public struct RoutingSecret: Codable {
    public let apiKey: String
    enum Failure: Error { case invalidCredential }
    public static func validatedData(_ data: Data) throws -> Data {
        guard data.count <= 8192 else { throw Failure.invalidCredential }
        let value = try JSONDecoder().decode(Self.self, from: data)
        guard !value.apiKey.isEmpty, value.apiKey.utf8.count <= 4096,
              value.apiKey.unicodeScalars.allSatisfy({ $0.value > 32 && $0.value < 127 }) else { throw Failure.invalidCredential }
        return try JSONEncoder().encode(value)
    }
}
