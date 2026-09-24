import AppKit
import XCTest
@testable import ChatBridge

final class AppNavigationTests: XCTestCase {
    @MainActor
    func testEditingShortcutsUseTheResponderChain() async throws {
        let application = NSApplication.shared
        let originalMenu = application.mainMenu
        let originalResponder = application.nextResponder
        let originalPolicy = application.activationPolicy()
        let existingWindows = Set(application.windows.map(\.windowNumber))
        let delegate = AppDelegate()
        delegate.applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
        defer {
            delegate.applicationWillTerminate(Notification(name: NSApplication.willTerminateNotification))
            for window in application.windows where !existingWindows.contains(window.windowNumber)
                && window.title.hasPrefix("Chat Bridge") {
                window.close()
            }
            application.mainMenu = originalMenu
            application.nextResponder = originalResponder
            application.setActivationPolicy(originalPolicy)
        }

        let editor = PasteTestEditor(frame: NSRect(x: 0, y: 0, width: 300, height: 100))
        application.nextResponder = editor
        XCTAssertTrue(application.target(forAction: #selector(NSText.paste(_:))) as AnyObject? === editor)
        let menu = try XCTUnwrap(application.mainMenu)
        let paste = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero,
            modifierFlags: .command, timestamp: 0, windowNumber: 0,
            context: nil, characters: "v", charactersIgnoringModifiers: "v", isARepeat: false, keyCode: 9))

        XCTAssertTrue(menu.performKeyEquivalent(with: paste), "Command-V must follow the responder chain")
        XCTAssertEqual(editor.string, "paste-check-only")

        let selectAll = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero,
            modifierFlags: .command, timestamp: 0, windowNumber: 0,
            context: nil, characters: "a", charactersIgnoringModifiers: "a", isARepeat: false, keyCode: 0))
        XCTAssertTrue(menu.performKeyEquivalent(with: selectAll))
        XCTAssertEqual(editor.selectedRange(), NSRange(location: 0, length: editor.string.utf16.count))
    }

    @MainActor
    func testLaunchOpensConversationWindowInsteadOfSettings() async {
        let application = NSApplication.shared
        let delegate = AppDelegate()
        delegate.applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
        defer {
            delegate.applicationWillTerminate(Notification(name: NSApplication.willTerminateNotification))
            for window in application.windows where window.title.hasPrefix("Chat Bridge") {
                window.close()
            }
        }

        XCTAssertTrue(application.windows.contains { $0.title == "Chat Bridge" && $0.isVisible },
                      "Launching should show the Agent and conversation workspace.")
        XCTAssertFalse(application.windows.contains { $0.title == "Chat Bridge 设置" && $0.isVisible },
                       "Settings should only appear when requested.")
    }

    @MainActor
    func testReopenReturnsToConversationWindow() async {
        let application = NSApplication.shared
        let delegate = AppDelegate()
        defer {
            for window in application.windows where window.title.hasPrefix("Chat Bridge") {
                window.close()
            }
        }

        XCTAssertTrue(delegate.applicationShouldHandleReopen(application, hasVisibleWindows: false))
        XCTAssertTrue(application.windows.contains { $0.title == "Chat Bridge" && $0.isVisible })
        XCTAssertFalse(application.windows.contains { $0.title == "Chat Bridge 设置" && $0.isVisible })
    }

    @MainActor
    func testWorkspaceShowsInDockAndClosingReturnsToMenuBar() async throws {
        let application = NSApplication.shared
        let originalPolicy = application.activationPolicy()
        application.setActivationPolicy(.accessory)
        let delegate = AppDelegate()
        defer {
            for window in application.windows where window.title == "Chat Bridge" { window.close() }
            application.setActivationPolicy(originalPolicy)
        }

        delegate.showMainWindow()
        let workspace = try XCTUnwrap(application.windows.first { $0.title == "Chat Bridge" && $0.isVisible })
        XCTAssertEqual(application.activationPolicy(), .regular, "The dashboard must have a Dock icon")
        delegate.showMainWindow()
        XCTAssertEqual(application.windows.filter { $0.title == "Chat Bridge" && $0.isVisible }.count, 1)
        XCTAssertTrue(workspace.isVisible)

        workspace.close()
        XCTAssertEqual(application.activationPolicy(), .accessory, "Closing the dashboard should keep the menu bar app running")
        XCTAssertFalse(delegate.applicationShouldTerminateAfterLastWindowClosed(application))
        _ = delegate.applicationShouldHandleReopen(application, hasVisibleWindows: false)
        XCTAssertTrue(workspace.isVisible, "Reopening should reuse the original workspace")
        XCTAssertEqual(application.activationPolicy(), .regular)
    }

    @MainActor
    func testDockReopenRestoresMinimizedWorkspace() async throws {
        let application = NSApplication.shared
        let originalPolicy = application.activationPolicy()
        application.setActivationPolicy(.regular)
        let delegate = AppDelegate()
        defer {
            for window in application.windows where window.title == "Chat Bridge" { window.close() }
            application.setActivationPolicy(originalPolicy)
        }
        delegate.showMainWindow()
        let workspace = try XCTUnwrap(application.windows.first { $0.title == "Chat Bridge" && $0.isVisible })
        let minimized = expectation(forNotification: NSWindow.didMiniaturizeNotification, object: workspace)
        workspace.miniaturize(nil)
        await fulfillment(of: [minimized], timeout: 5)
        XCTAssertTrue(workspace.isMiniaturized)
        let restored = expectation(forNotification: NSWindow.didDeminiaturizeNotification, object: workspace)
        _ = delegate.applicationShouldHandleReopen(application, hasVisibleWindows: true)
        await fulfillment(of: [restored], timeout: 5)
        XCTAssertFalse(workspace.isMiniaturized)
        XCTAssertTrue(workspace.isVisible)
        XCTAssertEqual(application.activationPolicy(), .regular)
    }

    @MainActor
    func testDashboardArrowCollapsesIntoTheFloatingConversationAndBack() async throws {
        let application = NSApplication.shared
        let originalPolicy = application.activationPolicy()
        application.setActivationPolicy(.accessory)
        let delegate = AppDelegate()
        defer {
            for window in application.windows where ["Chat Bridge", "Chat Bridge 会话"].contains(window.title) { window.close() }
            application.setActivationPolicy(originalPolicy)
        }

        delegate.showMainWindow()
        let workspace = try XCTUnwrap(application.windows.first { $0.title == "Chat Bridge" && $0.isVisible })

        delegate.showFloatingConversation()
        let panel = try XCTUnwrap(application.windows.first { $0.title == "Chat Bridge 会话" })
        XCTAssertTrue(panel.isVisible, "The dashboard arrow opens the floating conversation")
        XCTAssertFalse(workspace.isVisible, "Collapsing hides the dashboard instead of stacking both")
        XCTAssertEqual(application.activationPolicy(), .accessory, "Menu bar mode drops the Dock icon")

        delegate.showFloatingConversation()
        XCTAssertTrue(panel.isVisible, "Repeating the collapse must not toggle the panel closed")

        delegate.showMainWindow()
        XCTAssertTrue(workspace.isVisible)
        XCTAssertFalse(panel.isVisible, "The floating arrow hands off to the dashboard")
        XCTAssertEqual(application.activationPolicy(), .regular)
    }
}

private final class PasteTestEditor: NSTextView {
    override func validateUserInterfaceItem(_ item: NSValidatedUserInterfaceItem) -> Bool {
        if item.action == #selector(paste(_:)) { return true }
        return super.validateUserInterfaceItem(item)
    }

    override func paste(_ sender: Any?) {
        // Exercise the real menu/responder chain without reading or replacing the user's clipboard.
        insertText("paste-check-only", replacementRange: selectedRange())
    }

}
