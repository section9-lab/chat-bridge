import AppKit
import SwiftUI
import XCTest
@testable import ChatBridge

final class StatusLogoTests: XCTestCase {
    @MainActor
    func testStatusItemHasOneTemplateLogoRegardlessOfPinnedAgents() async throws {
        try withApplication { delegate, button in
            XCTAssertEqual(button.image?.isTemplate, true)
            XCTAssertEqual(button.image?.size, NSSize(width: 22, height: 18))
            XCTAssertEqual(button.frame.width, 32)
            XCTAssertTrue(button.subviews.isEmpty, "The native button owns the entire click target")
            let image = button.image
            for pinned in [[], ["claude"], ["codex", "claude", "cursor"]] {
                delegate.service.state.preferences.pinned = pinned
                delegate.service.viewedAgent = "claude"
                XCTAssertEqual(button.frame.width, 32)
                XCTAssertTrue(button.image === image)
            }
        }
    }

    @MainActor
    func testLogoReopensLastConversationWithoutChangingSessionOrDraft() async throws {
        try withApplication { delegate, button in
            delegate.service.state.preferences.defaultAgent = "codex"
            delegate.service.state.selection = Selection(agent: "claude", projectId: "shop", sessionId: "last-session")
            delegate.service.viewedAgent = "claude"
            delegate.service.drafts[delegate.service.draftKey] = "保留这份草稿"
            let drafts = delegate.service.drafts
            button.performClick(nil)
            let panel = try XCTUnwrap(NSApp.windows.compactMap { $0 as? ChatPanel }.first { $0.isVisible })
            for _ in 0..<3 {
                XCTAssertEqual(delegate.service.viewedAgent, "claude")
                XCTAssertEqual(delegate.service.state.selection.sessionId, "last-session")
                XCTAssertEqual(delegate.service.drafts, drafts)
                XCTAssertTrue(delegate.service.opening.isEmpty, "Opening the panel must not request another session")
                button.performClick(nil)
                XCTAssertFalse(panel.isVisible)
                button.performClick(nil)
                XCTAssertTrue(panel.isVisible)
            }
        }
    }

    @MainActor
    func testOpeningSettingsRemovesTheConversationSelectionRing() throws {
        try withApplication { delegate, button in
            let closedLogo = try XCTUnwrap(button.image?.tiffRepresentation)
            button.performClick(nil)
            XCTAssertNotEqual(button.image?.tiffRepresentation, closedLogo)
            delegate.showSettings()
            XCTAssertEqual(button.image?.tiffRepresentation, closedLogo)
            XCTAssertFalse(NSApp.windows.contains { $0 is ChatPanel && $0.isVisible })
            XCTAssertEqual(button.frame.width, 32, "Selection does not move neighboring menu bar items")
        }
    }

    @MainActor
    private func withApplication(_ verify: (AppDelegate, NSStatusBarButton) throws -> Void) throws {
        let application = NSApplication.shared
        let existing = Set(application.windows.map(\.windowNumber))
        let policy = application.activationPolicy()
        let delegate = AppDelegate()
        delegate.applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
        defer {
            delegate.applicationWillTerminate(Notification(name: NSApplication.willTerminateNotification))
            for window in application.windows where !existing.contains(window.windowNumber) {
                if let sheet = window.attachedSheet { window.endSheet(sheet) }
                if window.title.hasPrefix("Chat Bridge") { window.close() }
            }
            application.setActivationPolicy(policy)
        }
        let button = try XCTUnwrap(application.windows.filter { !existing.contains($0.windowNumber) }
            .compactMap { statusButton(in: $0.contentView) }.first)
        try verify(delegate, button)
    }

    @MainActor
    private func statusButton(in view: NSView?) -> NSStatusBarButton? {
        guard let view else { return nil }
        if let button = view as? NSStatusBarButton, button.accessibilityLabel() == "Chat Bridge" { return button }
        return view.subviews.lazy.compactMap { self.statusButton(in: $0) }.first
    }
}
