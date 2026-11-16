import XCTest
@testable import ChatBridge

final class UpdateCheckerTests: XCTestCase {
    func testVersionComparison() {
        XCTAssertTrue(UpdateChecker.isNewer("0.3.1", than: "0.3.0"))
        XCTAssertTrue(UpdateChecker.isNewer("v0.4.0", than: "0.3.9"))
        XCTAssertTrue(UpdateChecker.isNewer("1.0", than: "0.9.9"))
        XCTAssertFalse(UpdateChecker.isNewer("0.3.0", than: "0.3.0"))
        XCTAssertFalse(UpdateChecker.isNewer("0.2.9", than: "0.3.0"))
        XCTAssertFalse(UpdateChecker.isNewer("Development", than: "0.3.0"))
    }

    func testLatestReleaseSelectsTheCurrentArchitectureAndChecksum() throws {
        let json = """
        {
          "tag_name": "v0.4.0",
          "html_url": "https://github.com/section9-lab/chat-bridge/releases/tag/v0.4.0",
          "assets": [
            {"name":"ChatBridge-0.4.0-macos-x86_64.dmg","browser_download_url":"https://example.com/intel.dmg"},
            {"name":"ChatBridge-0.4.0-macos-arm64.dmg","browser_download_url":"https://example.com/arm.dmg"},
            {"name":"SHA256SUMS.txt","browser_download_url":"https://example.com/SHA256SUMS.txt"}
          ]
        }
        """
        let checker = UpdateChecker(currentVersion: "0.3.0", architecture: "arm64")
        let release = try XCTUnwrap(checker.release(from: Data(json.utf8)))
        XCTAssertEqual(release.version, "0.4.0")
        XCTAssertEqual(release.assetName, "ChatBridge-0.4.0-macos-arm64.dmg")
        XCTAssertEqual(release.assetURL.absoluteString, "https://example.com/arm.dmg")
        XCTAssertEqual(release.checksumURL?.lastPathComponent, "SHA256SUMS.txt")
    }

    func testOlderReleaseAndMissingArchitectureAreIgnored() throws {
        let older = """
        {"tag_name":"v0.3.0","html_url":"https://example.com","assets":[
          {"name":"ChatBridge-0.3.0-macos-arm64.dmg","browser_download_url":"https://example.com/a.dmg"}]}
        """
        let checker = UpdateChecker(currentVersion: "0.3.0", architecture: "arm64")
        XCTAssertNil(try checker.release(from: Data(older.utf8)))

        let missing = """
        {"tag_name":"v0.4.0","html_url":"https://example.com","assets":[
          {"name":"ChatBridge-0.4.0-macos-x86_64.dmg","browser_download_url":"https://example.com/i.dmg"}]}
        """
        XCTAssertNil(try checker.release(from: Data(missing.utf8)))
    }

    @MainActor
    func testControllerPublishesAnAvailableRelease() async throws {
        let json = """
        {"tag_name":"v0.4.0","html_url":"https://example.com","assets":[
          {"name":"ChatBridge-0.4.0-macos-arm64.dmg","browser_download_url":"https://example.com/a.dmg"},
          {"name":"SHA256SUMS.txt","browser_download_url":"https://example.com/SHA256SUMS.txt"}]}
        """
        let controller = UpdateController(currentVersion: "0.3.0", architecture: "arm64") { request in
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (Data(json.utf8), response)
        }
        let status = await controller.check(manual: true)
        XCTAssertEqual(status.release?.version, "0.4.0")
        XCTAssertEqual(controller.status.release?.assetName, "ChatBridge-0.4.0-macos-arm64.dmg")
    }
}
