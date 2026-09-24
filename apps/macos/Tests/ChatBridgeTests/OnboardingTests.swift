import SwiftUI
import XCTest
@testable import ChatBridge

final class OnboardingTests: XCTestCase {
    private func apply(_ t: ProjectionTransform, _ p: CGPoint) -> CGPoint {
        let w = t.m13 * p.x + t.m23 * p.y + t.m33
        return CGPoint(x: (t.m11 * p.x + t.m21 * p.y + t.m31) / w, y: (t.m12 * p.x + t.m22 * p.y + t.m32) / w)
    }
    private func assertClose(_ a: CGPoint, _ b: CGPoint, accuracy: CGFloat = 0.01, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(a.x, b.x, accuracy: accuracy, file: file, line: line)
        XCTAssertEqual(a.y, b.y, accuracy: accuracy, file: file, line: line)
    }

    func testHomographyPlacesTheRectangleOnTheQuad() {
        let rect = CGRect(x: 40, y: 20, width: 800, height: 500)
        let map = Homography(from: rect, to: CameraRig.mac)
        let corners = [CGPoint(x: rect.minX, y: rect.minY), CGPoint(x: rect.maxX, y: rect.minY),
                       CGPoint(x: rect.maxX, y: rect.maxY), CGPoint(x: rect.minX, y: rect.maxY)]
        for (corner, target) in zip(corners, CameraRig.mac) {
            assertClose(map.apply(corner), target)
            assertClose(apply(map.projection, corner), target)
        }
    }

    func testTheIntroStartsAndEndsOnTheRealScreen() {
        for size in [CGSize(width: 1512, height: 982), CGSize(width: 1920, height: 1080), CGSize(width: 1440, height: 900)] {
            let rig = CameraRig(size: size)
            for point in [CGPoint(x: 0, y: 0), CGPoint(x: size.width, y: 0), CGPoint(x: size.width, y: size.height), CGPoint(x: 300, y: 200)] {
                assertClose(apply(rig.camera(0), apply(rig.desk(0), point)), point, accuracy: 0.05)
            }
        }
    }

    func testTheDesktopLandsOnTheLaptopGlassInTheWideShot() {
        let rig = CameraRig(size: CGSize(width: 1512, height: 982))
        let v = rig.visible
        let corners = [CGPoint(x: v.minX, y: v.minY), CGPoint(x: v.maxX, y: v.minY), CGPoint(x: v.maxX, y: v.maxY), CGPoint(x: v.minX, y: v.maxY)]
        for (corner, glass) in zip(corners, CameraRig.mac) {
            assertClose(apply(rig.desk(1), corner), glass, accuracy: 0.05)
        }
        XCTAssertEqual(rig.photoOpacity(0), 0)
        XCTAssertEqual(rig.photoOpacity(1), 1)
    }

    func testThePhoneFillsThePhotosIPhoneScreen() {
        let rig = CameraRig(size: CGSize(width: 1512, height: 982))
        assertClose(apply(rig.phone, .zero), CameraRig.iPhone[0])
        assertClose(apply(rig.phone, CGPoint(x: 393, y: 852)), CameraRig.iPhone[2])
    }

    func testThePhoneShotKeepsThePhotoOnScreen() {
        for size in [CGSize(width: 1512, height: 982), CGSize(width: 2560, height: 1440), CGSize(width: 1280, height: 800)] {
            let rig = CameraRig(size: size)
            for t in stride(from: 1.0, through: 2.0, by: 0.1) {
                let topLeft = apply(rig.camera(t), .zero), bottomRight = apply(rig.camera(t), CGPoint(x: 1536, y: 1024))
                XCTAssertLessThanOrEqual(topLeft.x, 0.5); XCTAssertLessThanOrEqual(topLeft.y, 0.5)
                XCTAssertGreaterThanOrEqual(bottomRight.x, size.width - 0.5); XCTAssertGreaterThanOrEqual(bottomRight.y, size.height - 0.5)
            }
        }
    }

    func testOnboardingShowsUntilItIsCompleted() {
        let key = OnboardingCoordinator.completedKey, saved = UserDefaults.standard.object(forKey: key)
        defer { UserDefaults.standard.set(saved, forKey: key) }
        UserDefaults.standard.removeObject(forKey: key)
        XCTAssertTrue(OnboardingCoordinator.shouldShow)
        UserDefaults.standard.set(true, forKey: key)
        XCTAssertFalse(OnboardingCoordinator.shouldShow)
    }

    func testEnabledAgentsDefaultToAllForOlderServices() throws {
        let older = #"{"defaultAgent":"codex","pinned":["codex"],"keepAlive":false,"names":{}}"#
        XCTAssertEqual(try JSONDecoder().decode(Preferences.self, from: Data(older.utf8)).enabledAgents, Agent.all.map(\.id))
        let current = #"{"defaultAgent":"claude","pinned":[],"keepAlive":true,"names":{},"enabledAgents":["claude","opencode"]}"#
        let preferences = try JSONDecoder().decode(Preferences.self, from: Data(current.utf8))
        XCTAssertEqual(preferences.enabledAgents, ["claude", "opencode"])
        XCTAssertTrue(preferences.keepAlive)
    }
}
