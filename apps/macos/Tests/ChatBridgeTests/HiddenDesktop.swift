import AppKit
import XCTest
@testable import ChatBridge

/// Stands in for the real desktop in AppDelegate tests. It records the Dock policy instead of changing it, keeps the
/// status item out of the menu bar, never takes focus and hides every window, so tests can run while someone works.
@MainActor
final class HiddenDesktop {
    private(set) var policy = NSApplication.ActivationPolicy.accessory
    /// One private bar for the whole run. Releasing a bar together with its item crashes AppKit on macOS 14 and 15.
    private static let statusBar = NSStatusBar()

    func makeDelegate() -> AppDelegate {
        AppDelegate(desktop: Desktop(statusBar: Self.statusBar, setActivationPolicy: { self.policy = $0 },
                                     activate: {}, watchesOtherApps: false, prepare: hideFromScreen))
    }
}

/// Keeps a window ordered in, as the code under test expects, but invisible and click-through.
@MainActor
func hideFromScreen(_ window: NSWindow) {
    window.alphaValue = 0
    window.ignoresMouseEvents = true
}

/// Skips a test that needs the real menu bar, Dock or window server. Those tests show windows and a Dock icon,
/// so they only run with CHAT_BRIDGE_UI_TESTS=1, which release builds set.
func requireDesktop() throws {
    try XCTSkipUnless(ProcessInfo.processInfo.environment["CHAT_BRIDGE_UI_TESTS"] == "1",
                      "Uses the real desktop; set CHAT_BRIDGE_UI_TESTS=1 to run it")
}
