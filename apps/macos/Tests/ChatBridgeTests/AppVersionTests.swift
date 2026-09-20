import XCTest
@testable import ChatBridge

final class AppVersionTests: XCTestCase {
    func testReleaseVersionKeepsPrereleaseLabel() {
        XCTAssertEqual(AppVersion.label(["ChatBridgeReleaseVersion": "1.2.3-rc.1",
                                         "CFBundleShortVersionString": "1.2.3"]), "1.2.3-rc.1")
    }

    func testLocalBuildUsesBundleVersion() {
        XCTAssertEqual(AppVersion.label(["CFBundleShortVersionString": "1.2.3"]), "1.2.3")
    }

    func testUnbundledBuildDoesNotInventAReleaseVersion() {
        XCTAssertEqual(AppVersion.label([:]), "Development")
    }
}
