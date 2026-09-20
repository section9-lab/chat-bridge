import Foundation
import XCTest
@testable import ChatBridgeKit

final class CredentialTests: XCTestCase {
    func testRoutingCredentialKeepsOnlyTheToken() throws {
        let data = try JSONSerialization.data(withJSONObject: ["apiKey": "fixture-vercel-key", "endpoint": "https://untrusted.test"])
        let result = try RoutingSecret.validatedData(data)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: result) as? [String: String])
        XCTAssertEqual(object, ["apiKey": "fixture-vercel-key"])
    }
    func testRoutingCredentialRejectsEmptyWhitespaceAndOversizedKeys() throws {
        for key in ["", "key\nheader", "a key", "密钥", String(repeating: "x", count: 4097)] {
            let data = try JSONSerialization.data(withJSONObject: ["apiKey": key])
            XCTAssertThrowsError(try RoutingSecret.validatedData(data))
        }
    }

    private var valid: [String: String] {
        ["accountId": "bot", "ownerId": "owner", "token": "private-token",
         "baseUrl": "https://ilinkai.weixin.qq.com", "contextKey": Data(repeating: 1, count: 32).base64EncodedString()]
    }
    func testCredentialKeepsOnlyKnownFields() throws {
        var value = valid
        value["keychainService"] = "another-app"
        let result = try WeixinSecret.validatedData(JSONSerialization.data(withJSONObject: value))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: result) as? [String: String])
        XCTAssertEqual(object["token"], "private-token")
        XCTAssertNil(object["keychainService"])
    }
    func testUntrustedEndpointsAndMissingOwnerAreRejected() throws {
        for endpoint in ["http://ilinkai.weixin.qq.com", "https://evil.test", "https://ilinkai.weixin.qq.com/path", "https://user@ilinkai.weixin.qq.com"] {
            var value = valid
            value["baseUrl"] = endpoint
            XCTAssertThrowsError(try WeixinSecret.validatedData(JSONSerialization.data(withJSONObject: value)))
        }
        var value = valid
        value["ownerId"] = ""
        XCTAssertThrowsError(try WeixinSecret.validatedData(JSONSerialization.data(withJSONObject: value)))
    }
    func testInvalidKeyAndOversizedCredentialAreRejected() throws {
        var value = valid
        value["contextKey"] = "bad"
        XCTAssertThrowsError(try WeixinSecret.validatedData(JSONSerialization.data(withJSONObject: value)))
        XCTAssertThrowsError(try WeixinSecret.validatedData(Data(repeating: 65, count: 32769)))
    }
}
