import AppKit
import SwiftUI
import XCTest
@testable import ChatBridge

final class StatusItemTests: XCTestCase {
    // Starts the app as a returning user; first-run onboarding has its own tests.
    override func setUp() {
        super.setUp()
        UserDefaults.standard.set(true, forKey: OnboardingCoordinator.completedKey)
    }

    @MainActor
    func testSystemStatusButtonRepeatedlyOpensAndClosesConversation() async throws {
        let application = NSApplication.shared
        let existingWindows = Set(application.windows.map(\.windowNumber))
        let delegate = HiddenDesktop().makeDelegate()
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
        let closedLogo = try XCTUnwrap(host.image?.tiffRepresentation)
        delegate.showSettings()
        host.performClick(nil)

        XCTAssertFalse(application.windows.contains { $0.title == "Chat Bridge 设置" && $0.isVisible })
        let panel = try XCTUnwrap(application.windows.compactMap { $0 as? ChatPanel }.first)
        XCTAssertTrue(panel.isVisible)
        XCTAssertNotEqual(host.image?.tiffRepresentation, closedLogo, "An open conversation has a visible selection ring")
        XCTAssertFalse(panel.isOpaque)
        XCTAssertEqual(panel.backgroundColor.alphaComponent, 0)
        XCTAssertTrue(panel.styleMask.contains(.nonactivatingPanel))
        XCTAssertFalse(panel.styleMask.contains(.titled))
        for _ in 0..<5 {
            host.performClick(nil)
            XCTAssertFalse(panel.isVisible)
            XCTAssertEqual(host.image?.tiffRepresentation, closedLogo, "Closing the conversation removes its selection ring")
            host.performClick(nil)
            XCTAssertTrue(panel.isVisible)
            XCTAssertNotEqual(host.image?.tiffRepresentation, closedLogo)
        }
    }

    @MainActor
    func testFloatingPanelDashboardActionReusesWorkspaceAndDraft() async throws {
        // Clicks the dashboard arrow where it lines up with the real menu bar item.
        try requireDesktop()
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
        let closedLogo = try XCTUnwrap(host.image?.tiffRepresentation)
        let buttonWindow = try XCTUnwrap(host.window)
        // The status item receives its screen coordinates asynchronously.
        for _ in 0..<50 {
            if buttonWindow.isVisible && buttonWindow.frame.height > 0 { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTAssertGreaterThan(buttonWindow.frame.height, 0)
        host.performClick(nil)
        let panel = try XCTUnwrap(application.windows.compactMap { $0 as? ChatPanel }
            .first { !existingWindows.contains($0.windowNumber) && $0.isVisible })
        let content = try XCTUnwrap(panel.contentView as? NSHostingView<ChatView>)
        content.layoutSubtreeIfNeeded()
        XCTAssertEqual(application.activationPolicy(), .accessory)
        delegate.service.drafts[delegate.service.draftKey] = "保留这份草稿"
        let selectedSession = delegate.service.state.selection.sessionId
        let drafts = delegate.service.drafts
        let anchor = buttonWindow.convertToScreen(host.convert(host.bounds, to: nil))
        let location = panel.convertPoint(fromScreen: NSPoint(x: anchor.midX, y: panel.frame.maxY - 23))
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            let event = try XCTUnwrap(NSEvent.mouseEvent(with: type, location: location, modifierFlags: [],
                timestamp: 0, windowNumber: panel.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1))
            panel.sendEvent(event)
        }
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertFalse(panel.isVisible)
        XCTAssertEqual(host.image?.tiffRepresentation, closedLogo, "Opening the dashboard removes the floating conversation's selection ring")
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
