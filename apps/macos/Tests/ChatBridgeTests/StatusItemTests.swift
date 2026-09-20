import AppKit
import SwiftUI
import XCTest
@testable import ChatBridge

final class StatusItemTests: XCTestCase {
    @MainActor
    func testSystemStatusButtonRepeatedlyOpensAndClosesConversation() async throws {
        let application = NSApplication.shared
        let existingWindows = Set(application.windows.map(\.windowNumber))
        let delegate = AppDelegate()
        delegate.applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
        defer {
            delegate.applicationWillTerminate(Notification(name: NSApplication.willTerminateNotification))
            for window in application.windows where !existingWindows.contains(window.windowNumber) {
                if let sheet = window.attachedSheet { window.endSheet(sheet) }
                if window.title.hasPrefix("Chat Bridge") { window.close() }
            }
        }
        let host = try XCTUnwrap(application.windows
            .filter { !existingWindows.contains($0.windowNumber) }
            .compactMap { statusButton(in: $0.contentView) }.first)
        XCTAssertEqual(host.accessibilityLabel(), "Chat Bridge")
        delegate.showSettings()
        host.performClick(nil)

        XCTAssertFalse(application.windows.contains { $0.title == "Chat Bridge 设置" && $0.isVisible })
        let panel = try XCTUnwrap(application.windows.compactMap { $0 as? ChatPanel }.first)
        XCTAssertTrue(panel.isVisible)
        XCTAssertFalse(panel.isOpaque)
        XCTAssertEqual(panel.backgroundColor.alphaComponent, 0)
        XCTAssertTrue(panel.styleMask.contains(.nonactivatingPanel))
        XCTAssertFalse(panel.styleMask.contains(.titled))
        for _ in 0..<5 {
            host.performClick(nil)
            XCTAssertFalse(panel.isVisible)
            host.performClick(nil)
            XCTAssertTrue(panel.isVisible)
        }
    }

    @MainActor
    func testFloatingPanelDashboardActionReusesWorkspaceAndDraft() async throws {
        let application = NSApplication.shared
        let originalPolicy = application.activationPolicy()
        let existingWindows = Set(application.windows.map(\.windowNumber))
        let delegate = AppDelegate()
        delegate.applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
        defer {
            delegate.applicationWillTerminate(Notification(name: NSApplication.willTerminateNotification))
            for window in application.windows where !existingWindows.contains(window.windowNumber) && window.title.hasPrefix("Chat Bridge") {
                window.close()
            }
            application.setActivationPolicy(originalPolicy)
        }
        let host = try XCTUnwrap(application.windows
            .filter { !existingWindows.contains($0.windowNumber) }
            .compactMap { statusButton(in: $0.contentView) }.first)
        host.performClick(nil)
        let panel = try XCTUnwrap(application.windows.compactMap { $0 as? ChatPanel }
            .first { !existingWindows.contains($0.windowNumber) && $0.isVisible })
        let content = try XCTUnwrap(panel.contentView as? NSHostingView<ChatView>)
        content.layoutSubtreeIfNeeded()
        XCTAssertEqual(application.activationPolicy(), .accessory)
        delegate.service.drafts[delegate.service.draftKey] = "保留这份草稿"
        let selectedSession = delegate.service.state.selection.sessionId
        let drafts = delegate.service.drafts
        content.rootView.openDashboard()
        XCTAssertFalse(panel.isVisible)
        XCTAssertTrue(application.windows.contains { $0.title == "Chat Bridge" && $0.isVisible })
        XCTAssertEqual(application.activationPolicy(), .regular)
        XCTAssertEqual(delegate.service.state.selection.sessionId, selectedSession)
        XCTAssertEqual(delegate.service.drafts, drafts)
    }

    @MainActor
    private func statusButton(in view: NSView?) -> NSStatusBarButton? {
        guard let view else { return nil }
        if let button = view as? NSStatusBarButton, button.accessibilityLabel() == "Chat Bridge" { return button }
        return view.subviews.lazy.compactMap { self.statusButton(in: $0) }.first
    }
}
