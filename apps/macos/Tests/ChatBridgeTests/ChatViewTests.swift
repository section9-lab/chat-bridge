import AppKit
import SwiftUI
import XCTest
@testable import ChatBridge

final class ChatViewTests: XCTestCase {
    @MainActor
    func testBackdropFadesTheNativeMaterialAtEveryEdge() throws {
        _ = NSApplication.shared
        let content = NSHostingView(rootView: ChatView(service: BridgeService(), settings: {}, close: {}))
        content.frame = NSRect(x: 0, y: 0, width: 380, height: 560)
        content.layoutSubtreeIfNeeded()
        let backdrop = try XCTUnwrap(descendants(of: content).compactMap { $0 as? NSVisualEffectView }
            .first { $0.bounds.height > 500 })
        // The compositor needs a material mask; a SwiftUI-only mask leaves rectangular blur bounds.
        let mask = try XCTUnwrap(backdrop.maskImage)
        let bitmap = try XCTUnwrap(NSBitmapImageRep(data: try XCTUnwrap(mask.tiffRepresentation)))
        let x = bitmap.pixelsWide / 2, y = bitmap.pixelsHigh / 2
        let center = try XCTUnwrap(bitmap.colorAt(x: x, y: y)).alphaComponent
        XCTAssertGreaterThan(center, 0.95)
        for edge in [NSPoint(x: 0, y: y), NSPoint(x: bitmap.pixelsWide - 1, y: y),
                     NSPoint(x: x, y: 0), NSPoint(x: x, y: bitmap.pixelsHigh - 1)] {
            XCTAssertLessThan(try XCTUnwrap(bitmap.colorAt(x: Int(edge.x), y: Int(edge.y))).alphaComponent, 0.01)
        }
        let transition = try XCTUnwrap(bitmap.colorAt(x: x / 2, y: y)).alphaComponent
        XCTAssertGreaterThan(transition, 0.1)
        XCTAssertLessThan(transition, 0.9)
    }

    @MainActor
    func testShortMessagesAlignToTheirConversationSide() throws {
        _ = NSApplication.shared
        for user in [false, true] {
            let content = NSHostingView(rootView: MessageBubble(user: user) { Text("你好") })
            content.frame = NSRect(x: 0, y: 0, width: 360, height: 80)
            content.layoutSubtreeIfNeeded()

            let card = try XCTUnwrap(descendants(of: content).compactMap { $0 as? NSVisualEffectView }.first)
            let frame = content.convert(card.bounds, from: card)
            XCTAssertLessThan(frame.width, 150, "Short messages should keep their natural width")
            if user {
                XCTAssertEqual(frame.maxX, content.bounds.maxX, accuracy: 1,
                               "User messages must reach the right edge, not just indent from the left")
            } else {
                XCTAssertEqual(frame.minX, content.bounds.minX, accuracy: 1,
                               "Assistant messages must stay on the left")
            }
        }
    }

    @MainActor
    func testConversationGapsReceiveMouseEventsThroughTheTranslucentBackdrop() async throws {
        // Hit-testing transparent pixels is done by the window server, so the panel has to be really on screen.
        try requireDesktop()
        _ = NSApplication.shared
        let service = BridgeService()
        service.state.messages = (0..<20).map {
            Message(id: "message-\($0)", sessionId: "session", role: "assistant", text: "消息 \($0)")
        }
        let panel = ChatPanel(contentRect: NSRect(x: 200, y: 200, width: 380, height: 560),
                              styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isReleasedWhenClosed = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .floating
        panel.hidesOnDeactivate = false
        defer { panel.close() }
        let content = NSHostingView(rootView: ChatView(service: service, settings: {}, close: {}))
        panel.contentView = content
        panel.orderFrontRegardless()
        content.layoutSubtreeIfNeeded()
        try await Task.sleep(nanoseconds: 150_000_000)

        let scroll = try XCTUnwrap(descendants(of: content).compactMap { $0 as? NSScrollView }
            .first { $0.bounds.height > 100 })
        XCTAssertGreaterThan(try XCTUnwrap(scroll.documentView).bounds.height, scroll.contentView.bounds.height)
        let card = try XCTUnwrap(descendants(of: scroll).compactMap { $0 as? NSVisualEffectView }
            .first { !$0.visibleRect.isEmpty })
        let cardPoint = panel.convertPoint(toScreen: card.convert(
            NSPoint(x: card.visibleRect.midX, y: card.visibleRect.midY), to: nil))
        // Wait for earlier tests' window transitions before testing transparent pixels.
        for _ in 0..<40 {
            if NSWindow.windowNumber(at: cardPoint, belowWindowWithWindowNumber: 0) == panel.windowNumber { break }
            panel.orderFrontRegardless()
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertEqual(NSWindow.windowNumber(at: cardPoint, belowWindowWithWindowNumber: 0), panel.windowNumber)
        let gap = NSPoint(x: scroll.bounds.maxX - 28, y: scroll.bounds.midY)
        let screenPoint = panel.convertPoint(toScreen: scroll.convert(gap, to: nil))
        XCTAssertTrue(panel.isVisible)
        let hit = NSWindow.windowNumber(at: screenPoint, belowWindowWithWindowNumber: 0)
        let hitWindow = NSApplication.shared.window(withWindowNumber: hit)
        XCTAssertEqual(hit, panel.windowNumber,
                       "Transparent gap \(screenPoint) must hit panel \(panel.frame); received \(hitWindow?.title ?? "another app") \(String(describing: hitWindow?.frame))")

        let bitmap = try XCTUnwrap(content.bitmapImageRepForCachingDisplay(in: content.bounds))
        content.cacheDisplay(in: content.bounds, to: bitmap)
        let pixel = content.convert(gap, from: scroll)
        let scaleX = CGFloat(bitmap.pixelsWide) / content.bounds.width
        let scaleY = CGFloat(bitmap.pixelsHigh) / content.bounds.height
        let alpha = try XCTUnwrap(bitmap.colorAt(x: Int(pixel.x * scaleX), y: Int(pixel.y * scaleY))).alphaComponent
        XCTAssertGreaterThan(alpha, 0, "The message gap needs a nonzero hit surface")
        XCTAssertLessThan(alpha, 1, "The backdrop must let the desktop remain visible")
    }

    @MainActor
    private func descendants(of view: NSView) -> [NSView] {
        view.subviews.flatMap { [$0] + descendants(of: $0) }
    }
}
