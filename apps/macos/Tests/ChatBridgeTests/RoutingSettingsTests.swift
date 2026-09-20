import XCTest
@testable import ChatBridge

final class RoutingSettingsTests: XCTestCase {
    func testSavedKeyIsLoadedDirectlyForTheSelectedProvider() throws {
        let key = try KeychainVault.routingKey(for: "openrouter") { method, credential in
            XCTAssertEqual(method, "native.openrouter.credential.read")
            XCTAssertNil(credential)
            return Data(#"{"apiKey":"fixture-openrouter"}"#.utf8)
        }
        XCTAssertEqual(key, "fixture-openrouter")
    }

    func testMissingOrUnreadableKeyIsNotReplacedWithAnotherProvidersKey() throws {
        XCTAssertNil(try KeychainVault.routingKey(for: "vercel") { _, _ in nil })
        XCTAssertThrowsError(try KeychainVault.routingKey(for: "openrouter") { _, _ in
            throw KeychainVault.Failure(status: -1)
        })
        XCTAssertThrowsError(try KeychainVault.routingKey(for: "openrouter") { _, _ in Data("{}".utf8) })
    }

    func testRemovedProviderCannotBeReadIntoTheForm() {
        XCTAssertThrowsError(try KeychainVault.routingKey(for: "jevforhood") { _, _ in
            XCTFail("Removed provider must be rejected before reading the vault")
            return nil
        })
    }

    func testCredentialIPCAllowsOnlySupportedProviders() {
        for provider in ["vercel", "openrouter"] {
            for action in ["read", "write", "remove"] {
                XCTAssertTrue(KeychainVault.methods.contains("native.\(provider).credential.\(action)"))
            }
        }
        XCTAssertEqual(RoutingProvider.all.map(\.id), ["vercel", "openrouter"])
        for action in ["read", "write", "remove"] {
            XCTAssertFalse(KeychainVault.methods.contains("native.jevforhood.credential.\(action)"))
        }
        XCTAssertFalse(KeychainVault.methods.contains("native.unknown.credential.read"))
        XCTAssertFalse(KeychainVault.methods.contains("native.openrouter.credential.list"))
    }
}
