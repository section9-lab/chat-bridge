import AppKit
import SwiftUI
import XCTest
@testable import ChatBridge

final class ComposerTextViewTests: XCTestCase {
    @MainActor
    func testNativeTypingAndKeyboardSelectionDoNotSendTheSearchQuery() async throws {
        for workspace in [false, true] {
            let service = BridgeService()
            service.isRunning = true
            service.probes["codex"] = AgentProbe(installed: true, ready: true)
            var closed = 0
            let content = NSHostingView(rootView: ChatView(service: service, settings: {}, close: { closed += 1 }, workspace: workspace)
                .background(workspace ? Color(nsColor: .windowBackgroundColor) : .clear))
            let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: workspace ? 720 : 380, height: 560),
                                  styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.appearance = NSAppearance(named: .aqua)
            window.contentView = content
            hideFromScreen(window)
            window.makeKeyAndOrderFront(nil)
            defer { service.dismissFileSearch(); window.close() }
            content.layoutSubtreeIfNeeded()
            let editor = try XCTUnwrap(descendants(content).compactMap { $0 as? NSTextView }.first)
            window.makeFirstResponder(editor)
            try await Task.sleep(nanoseconds: 50_000_000)
            editor.insertText("请看 @", replacementRange: editor.selectedRange())
            editor.setMarkedText("sheji", selectedRange: NSRange(location: 5, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
            XCTAssertTrue(editor.hasMarkedText())
            XCTAssertNil(service.fileMention, "Native IME composition suspends file suggestions")
            try await Task.sleep(nanoseconds: 50_000_000)
            XCTAssertTrue(window.firstResponder === editor, "Updating suggestions keeps the input focused")
            XCTAssertTrue(descendants(content).contains { $0 === editor }, "The composer editor retains its identity")
            XCTAssertTrue(editor.hasMarkedText(), "Rendering the search UI must preserve uncommitted IME text")
            editor.insertText("设计", replacementRange: NSRange(location: NSNotFound, length: 0))
            XCTAssertEqual(service.fileMention?.query, "设计")
            let mention = service.fileMention
            service.dismissFileSearch()
            service.fileMention = mention
            service.fileSuggestions = ["设计.txt", "设计说明.md"].map {
                FileSuggestion(url: URL(fileURLWithPath: "/tmp/" + $0), size: 4, modified: .now)
            }
            try await Task.sleep(nanoseconds: 50_000_000)
            content.layoutSubtreeIfNeeded()
            XCTAssertGreaterThan(editor.bounds.width, 100)
            editor.doCommand(by: #selector(NSResponder.moveDown(_:)))
            XCTAssertEqual(service.highlightedFile, 1)
            editor.doCommand(by: #selector(NSResponder.insertNewline(_:)))
            for _ in 0..<20 { await Task.yield() }
            XCTAssertNotNil(service.lastError, "Return attempted to import the selection through the offline service")
            XCTAssertTrue(service.sending.isEmpty)
            XCTAssertEqual(service.drafts[service.draftKey], "请看 @设计")
            editor.doCommand(by: #selector(NSResponder.cancelOperation(_:)))
            XCTAssertNil(service.fileMention)
            XCTAssertEqual(closed, 0, "Escape closes suggestions before closing the conversation")
            editor.doCommand(by: #selector(NSResponder.cancelOperation(_:)))
            XCTAssertEqual(closed, 1)
            if let directory = ProcessInfo.processInfo.environment["CHAT_BRIDGE_RENDER_OUTPUT"] {
                service.lastError = nil
                service.fileMention = mention
                service.fileSuggestions = [FileSuggestion(url: URL(fileURLWithPath: "/Users/example/Documents/设计说明.md"), size: 1234, modified: .now)]
                try await Task.sleep(nanoseconds: 50_000_000)
                content.layoutSubtreeIfNeeded()
                let url = URL(fileURLWithPath: directory)
                try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
                let bitmap = try XCTUnwrap(content.bitmapImageRepForCachingDisplay(in: content.bounds))
                content.cacheDisplay(in: content.bounds, to: bitmap)
                try bitmap.representation(using: .png, properties: [:])?.write(to: url.appendingPathComponent(workspace ? "dashboard-files.png" : "panel-files.png"))
            }
        }
    }

    @MainActor
    private func descendants(_ view: NSView) -> [NSView] { view.subviews.flatMap { [$0] + descendants($0) } }
}
