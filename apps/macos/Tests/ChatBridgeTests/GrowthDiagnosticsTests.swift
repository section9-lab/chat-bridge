import AppKit
import SwiftUI
import XCTest
@testable import ChatBridge

// Temporary: finds which layer keeps a growing message from resizing on older macOS runners.
final class GrowthDiagnosticsTests: XCTestCase {
    private final class Model: ObservableObject { @Published var text = "开始检查。" }
    private let long = (1...50).map { "第 \($0) 段 **正文** 已生成。" }.joined(separator: "\n\n")

    @MainActor
    func testReportGrowth() async throws {
        let os = ProcessInfo.processInfo.operatingSystemVersionString
        func variant<V: View>(_ name: String, _ make: @escaping (Model) -> V) async throws {
            let model = Model()
            let (window, content) = host(Wrapper(model: model, make: make), width: 380, height: 500)
            defer { window.close() }
            try await Task.sleep(nanoseconds: 200_000_000)
            model.text = long
            for ms in [300, 1500] {
                try await Task.sleep(nanoseconds: UInt64(ms) * 1_000_000)
                content.layoutSubtreeIfNeeded()
                report("\(os) \(name) +\(ms)ms", content)
            }
        }
        try await variant("lazy-text") { m in ScrollView { LazyVStack { Text(m.text) } } }
        try await variant("lazy-markdown-equatable") { m in ScrollView { LazyVStack { MessageMarkdown(text: m.text).equatable() } } }
        try await variant("lazy-markdown") { m in ScrollView { LazyVStack { MessageMarkdown(text: m.text) } } }
        try await variant("vstack-markdown-equatable") { m in ScrollView { VStack { MessageMarkdown(text: m.text).equatable() } } }
        try await variant("lazy-bubble") { m in
            ScrollView { LazyVStack { MessageBubble { VStack(alignment: .leading) { MessageMarkdown(text: m.text).equatable() } } } }
        }
        for workspace in [false, true] {
            let service = BridgeService()
            service.state.messages = [Message(id: "stream", sessionId: "fixture", role: "assistant", text: "开始检查。")]
            let (window, content) = host(ChatView(service: service, settings: {}, close: {}, workspace: workspace),
                                         width: workspace ? 720 : 380, height: 500)
            defer { window.close() }
            try await Task.sleep(nanoseconds: 200_000_000)
            service.state.messages[0].text = long
            for ms in [300, 1500] {
                try await Task.sleep(nanoseconds: UInt64(ms) * 1_000_000)
                content.layoutSubtreeIfNeeded()
                report("\(os) chatview-\(workspace ? "workspace" : "floating") +\(ms)ms", content)
            }
        }
    }

    private struct Wrapper<V: View>: View {
        @ObservedObject var model: Model
        var make: (Model) -> V
        var body: some View { make(model) }
    }
    @MainActor
    private func report(_ label: String, _ content: NSView) {
        for (index, scroll) in descendants(content).compactMap({ $0 as? NSScrollView }).enumerated() {
            let document = scroll.documentView
            print("DIAG \(label) #\(index) \(type(of: scroll)) clip=\(scroll.contentView.bounds.size) "
                  + "doc=\(document.map { String(describing: type(of: $0)) } ?? "nil") docHeight=\(document?.frame.height ?? -1) "
                  + "visibleMinY=\(document?.visibleRect.minY ?? -1)")
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
        hideFromScreen(window)
        window.orderFrontRegardless()
        content.layoutSubtreeIfNeeded()
        return (window, content)
    }
    @MainActor
    private func descendants(_ view: NSView) -> [NSView] { view.subviews.flatMap { [$0] + descendants($0) } }
}
