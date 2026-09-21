import AppKit
import AVKit
import SwiftUI
import XCTest
@testable import ChatBridge

final class MessageRenderingTests: XCTestCase {
    @MainActor
    func testLocalMediaLinksHaveVisiblePreviewsInBothConversationSurfaces() async throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        for workspace in [false, true] {
            for (name, text) in [
                ("image-link", "查看 [图片](\(root.appendingPathComponent("docs/assets/chat-bridge-demo-poster.png").absoluteString))"),
                ("video-link", "查看 [试玩视频](\(root.appendingPathComponent("docs/assets/chat-bridge-demo.mp4").absoluteString))"),
                ("markdown-image", "![图片](\(root.appendingPathComponent("docs/assets/chat-bridge-demo-poster.png").path))"),
                ("missing-image", "[已移动的图片](/tmp/chat-bridge-missing-\(UUID().uuidString).png)"),
            ] {
                let service = BridgeService()
                service.state.messages = [Message(id: "media", sessionId: "fixture", role: "assistant",
                    text: text)]
                let (window, content) = host(ChatView(service: service, settings: {}, close: {}, workspace: workspace),
                                             width: workspace ? 720 : 380, height: 700)
                defer { window.close() }
                try await Task.sleep(nanoseconds: 400_000_000)
                content.layoutSubtreeIfNeeded()
                let card = try XCTUnwrap(descendants(content).compactMap { $0 as? NSVisualEffectView }
                    .first { $0.layer?.cornerRadius == 22 })
                XCTAssertGreaterThan(card.bounds.height, 140, "\(name) must have a visible media preview, not only a text link")
                XCTAssertLessThanOrEqual(card.bounds.width, workspace ? 640 : 310)
                XCTAssertFalse(descendants(content).contains { $0 is AVPlayerView }, "Video must not autoplay")
                if let directory = ProcessInfo.processInfo.environment["CHAT_BRIDGE_RENDER_OUTPUT"] {
                    let url = URL(fileURLWithPath: directory, isDirectory: true)
                    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
                    for dark in [false, true] {
                        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
                        try await Task.sleep(nanoseconds: 100_000_000)
                        let bitmap = try XCTUnwrap(content.bitmapImageRepForCachingDisplay(in: content.bounds))
                        content.cacheDisplay(in: content.bounds, to: bitmap)
                        try bitmap.representation(using: .png, properties: [:])?.write(to: url.appendingPathComponent(
                            "\(workspace ? "dashboard" : "panel")-\(name)-\(dark ? "dark" : "light").png"))
                    }
                }
            }
        }
    }

    @MainActor
    func testVideoStartsOnClickAndPausesWhenRemoved() async throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let media = try XCTUnwrap(MessageMedia(url: root.appendingPathComponent("docs/assets/chat-bridge-demo.mp4"), title: "演示"))
        let (window, content) = host(AnyView(MessageMediaView(media: media)), width: 420, height: 320)
        defer { window.close() }
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertFalse(descendants(content).contains { $0 is AVPlayerView })
        let location = content.convert(NSPoint(x: content.bounds.midX, y: content.bounds.midY), to: nil)
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            let event = try XCTUnwrap(NSEvent.mouseEvent(with: type, location: location, modifierFlags: [],
                timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1))
            window.sendEvent(event)
        }
        try await Task.sleep(nanoseconds: 100_000_000)
        let playerView = try XCTUnwrap(descendants(content).compactMap { $0 as? AVPlayerView }.first)
        let player = try XCTUnwrap(playerView.player)
        player.isMuted = true
        for _ in 0..<50 {
            if player.currentTime().seconds > 0 { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTAssertEqual(player.currentItem?.status, .readyToPlay)
        XCTAssertGreaterThan(player.currentTime().seconds, 0, "The real video must advance after clicking play")
        content.rootView = AnyView(EmptyView())
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(player.rate, 0, "Removing the media view must stop playback")
    }

    @MainActor
    func testGrowingMessageFollowsTheSameBubbleInBothConversationSurfaces() async throws {
        for workspace in [false, true] {
            let service = BridgeService()
            service.state.messages = [Message(id: "stream", sessionId: "fixture", role: "assistant", text: "开始检查。")]
            let (window, content) = host(ChatView(service: service, settings: {}, close: {}, workspace: workspace),
                                         width: workspace ? 720 : 380, height: 500)
            defer { window.close() }
            try await Task.sleep(nanoseconds: 100_000_000)
            service.state.messages[0].text = (1...50).map { "第 \($0) 段 **正文** 已生成。" }.joined(separator: "\n\n")
            try await Task.sleep(nanoseconds: 300_000_000)
            content.layoutSubtreeIfNeeded()
            let scroll = try XCTUnwrap(descendants(content).compactMap { $0 as? NSScrollView }.first)
            let document = try XCTUnwrap(scroll.documentView)
            XCTAssertGreaterThan(document.bounds.height, scroll.contentView.bounds.height * 2)
            XCTAssertGreaterThan(document.visibleRect.minY, 100, "Text growth must scroll even when message count and ID stay the same")
            XCTAssertEqual(service.state.messages.map(\.id), ["stream"])
        }
    }

    @MainActor
    func testMarkdownTableAndCodeStayScrollableInsideBothConversationSurfaces() async throws {
        for workspace in [false, true] {
            let service = BridgeService()
            service.state.messages = [Message(id: "markdown", sessionId: "fixture", role: "assistant", text: """
                ## 消息格式

                支持 **Hermes Agent** 和 [文档](https://example.com)。

                | 类别 | 当前开放 | 即将支持 |
                | --- | --- | --- |
                | 消息 Channel | iMessage、微信 | Telegram、WhatsApp |
                | Agent | Codex、Claude | Cursor、Grok、OpenCode、Hermes Agent |

                - 第一项
                - 第二项

                > 引用内容

                ```swift
                let value = "**原样保留**" // This long code line must remain readable inside the message bubble without widening the conversation.
                ```
                """)]
            let (window, content) = host(ChatView(service: service, settings: {}, close: {}, workspace: workspace),
                                         width: workspace ? 720 : 380, height: 900)
            defer { window.close() }
            try await Task.sleep(nanoseconds: 100_000_000)
            content.layoutSubtreeIfNeeded()
            let horizontal = descendants(content).compactMap { $0 as? NSScrollView }
                .filter { $0.hasHorizontalScroller }
            XCTAssertEqual(horizontal.count, 2, "Tables and code must render as separate scrollable blocks")
            for scroll in horizontal {
                XCTAssertLessThanOrEqual(content.convert(scroll.bounds, from: scroll).maxX, content.bounds.maxX)
            }
            let overflowing = horizontal.filter { ($0.documentView?.bounds.width ?? 0) > $0.contentView.bounds.width }
            XCTAssertEqual(overflowing.count, workspace ? 1 : 2,
                           "Code scrolls in both surfaces; this table fits the dashboard and scrolls in the narrow panel")
        }
    }

    @MainActor
    func testConversationBubblesAlignWithTheComposer() throws {
        for (workspace, user) in [(false, false), (false, true), (true, false), (true, true)] {
            let service = BridgeService()
            service.state.messages = [Message(id: "side", sessionId: "fixture", role: user ? "user" : "assistant", text: "你好")]
            let (window, content) = host(ChatView(service: service, settings: {}, close: {}, workspace: workspace),
                                         width: workspace ? 720 : 380, height: 500)
            defer { window.close() }
            let surfaces = descendants(content).compactMap { $0 as? NSVisualEffectView }
            let card = try XCTUnwrap(surfaces.first { $0.layer?.cornerRadius == 22 })
            let frame = content.convert(card.bounds, from: card)
            var composer = NSRect(x: 24, y: 0, width: 672, height: 0)
            if !workspace {
                let surface = try XCTUnwrap(surfaces.first { $0.layer?.cornerRadius == 28 })
                composer = content.convert(surface.bounds, from: surface)
            }
            if user {
                XCTAssertEqual(frame.maxX, composer.maxX, accuracy: 1)
            } else {
                XCTAssertEqual(frame.minX, composer.minX, accuracy: 1)
            }
        }
    }

    @MainActor
    func testUserBubbleHasAGraySurfaceDistinctFromAssistant() throws {
        var brightness: [CGFloat] = []
        for user in [false, true] {
            let (window, content) = host(MessageBubble(user: user) { Text("你好") }
                .padding(20).background(Color.white).environment(\.colorScheme, .light), width: 360, height: 100)
            defer { window.close() }
            let card = try XCTUnwrap(descendants(content).compactMap { $0 as? NSVisualEffectView }.first)
            let frame = content.convert(card.bounds, from: card)
            let bitmap = try XCTUnwrap(content.bitmapImageRepForCachingDisplay(in: content.bounds))
            content.cacheDisplay(in: content.bounds, to: bitmap)
            let color = try XCTUnwrap(bitmap.colorAt(
                x: Int(frame.midX * CGFloat(bitmap.pixelsWide) / content.bounds.width),
                y: Int((frame.minY + 6) * CGFloat(bitmap.pixelsHigh) / content.bounds.height))?.usingColorSpace(.deviceRGB))
            brightness.append((color.redComponent + color.greenComponent + color.blueComponent) / 3)
        }
        XCTAssertLessThan(brightness[1], brightness[0] - 0.04, "User bubbles must be visibly gray instead of white")
    }

    @MainActor
    func testMarkdownKeepsShortBubblesCompactAndOnTheirOwnSide() throws {
        for user in [false, true] {
            let (window, content) = host(MessageBubble(user: user) { MessageMarkdown(text: "**你好**") }, width: 360, height: 100)
            defer { window.close() }
            let card = try XCTUnwrap(descendants(content).compactMap { $0 as? NSVisualEffectView }.first)
            let frame = content.convert(card.bounds, from: card)
            XCTAssertLessThan(frame.width, 150)
            XCTAssertEqual(user ? frame.maxX : frame.minX, user ? 360 : 0, accuracy: 1)
        }
    }

    @MainActor
    func testPlainMessageLineBreaksRemainVisible() {
        let oneLine = NSHostingView(rootView: MessageMarkdown(text: "01 项目一 02 项目二"))
        let twoLines = NSHostingView(rootView: MessageMarkdown(text: "01 项目一\n02 项目二"))
        XCTAssertGreaterThan(twoLines.fittingSize.height, oneLine.fittingSize.height + 10,
                             "Numbered menus and multiline user messages must retain their line breaks")
    }

    @MainActor
    func testConversationAppearanceFixtures() async throws {
        for workspace in [false, true] {
            for dark in [false, true] {
                let service = BridgeService()
                service.state.messages = [
                    Message(id: "user", sessionId: "fixture", role: "user", text: "请列出 **Agent** 和消息通道。"),
                    Message(id: "assistant", sessionId: "fixture", role: "assistant", text: """
                        ### 当前支持

                        支持 **Codex**、*Claude*，以及 `iMessage` 和微信。

                        | 类别 | 当前支持 | Coming soon |
                        | --- | --- | --- |
                        | 通道 | iMessage、微信 | Telegram、WhatsApp |
                        | Agent | Codex、Claude | Cursor、Hermes Agent |

                        - 回复编号选择项目
                        - 在同一会话继续对话

                        > 设置会保存在这台 Mac。

                        ```swift
                        let message = "你好，世界"
                        print(message)
                        ```

                        查看 [使用指南](https://example.com)。
                        """)
                ]
                let (window, content) = host(ChatView(service: service, settings: {}, close: {}, workspace: workspace)
                    .background(workspace ? (dark ? Color(white: 0.12) : .white) : .clear)
                    .environment(\.colorScheme, dark ? .dark : .light), width: workspace ? 720 : 380, height: 820)
                defer { window.close() }
                window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
                try await Task.sleep(nanoseconds: 100_000_000)
                content.layoutSubtreeIfNeeded()
                let bitmap = try XCTUnwrap(content.bitmapImageRepForCachingDisplay(in: content.bounds))
                content.cacheDisplay(in: content.bounds, to: bitmap)
                let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                if let directory = ProcessInfo.processInfo.environment["CHAT_BRIDGE_RENDER_OUTPUT"] {
                    let url = URL(fileURLWithPath: directory, isDirectory: true)
                    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
                    try png.write(to: url.appendingPathComponent("\(workspace ? "dashboard" : "panel")-\(dark ? "dark" : "light").png"))
                }
            }
        }
    }

    @MainActor
    private func host<Content: View>(_ root: Content, width: CGFloat, height: CGFloat) -> (NSWindow, NSHostingView<Content>) {
        _ = NSApplication.shared
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let content = NSHostingView(rootView: root)
        window.contentView = content
        window.orderFrontRegardless()
        content.layoutSubtreeIfNeeded()
        return (window, content)
    }

    @MainActor
    private func descendants(_ view: NSView) -> [NSView] {
        view.subviews.flatMap { [$0] + descendants($0) }
    }
}
