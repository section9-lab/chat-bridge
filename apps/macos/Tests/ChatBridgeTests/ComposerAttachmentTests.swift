import AppKit
import XCTest
@testable import ChatBridge

final class ComposerAttachmentTests: XCTestCase {
    @MainActor
    func testTypingAtOpensTheFilePickerAndCancelPreservesSurroundingText() async throws {
        _ = NSApplication.shared
        let window = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 500, height: 400),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.makeKeyAndOrderFront(nil)
        defer { window.close() }
        let service = BridgeService()
        service.isRunning = true
        service.probes["codex"] = AgentProbe(installed: true, ready: true)
        service.drafts[service.draftKey] = "请分析  的内容"
        service.updateDraft("请分析 @ 的内容")
        XCTAssertTrue(service.choosingFiles)
        XCTAssertEqual(service.drafts[service.draftKey], "请分析  的内容")
        let picker = try XCTUnwrap(NSApp.windows.compactMap { $0 as? NSOpenPanel }.first)
        XCTAssertTrue(picker.allowsMultipleSelection)
        XCTAssertFalse(picker.canChooseDirectories)
        picker.cancel(nil)
        for _ in 0..<20 {
            if !service.choosingFiles { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertFalse(service.choosingFiles)
        XCTAssertTrue(service.draftAttachments.isEmpty)
        XCTAssertEqual(service.drafts[service.draftKey], "请分析  的内容")
    }

    @MainActor
    func testEmailAndPastedMentionsDoNotOpenTheFilePicker() {
        let service = BridgeService()
        service.isRunning = true
        service.probes["codex"] = AgentProbe(installed: true, ready: true)
        service.drafts[service.draftKey] = "hello"
        service.updateDraft("hello@")
        XCTAssertFalse(service.choosingFiles)
        XCTAssertEqual(service.drafts[service.draftKey], "hello@")
        service.updateDraft("请联系 hello@example.com，或者粘贴 @ 文本")
        XCTAssertFalse(service.choosingFiles)
        XCTAssertEqual(service.drafts[service.draftKey], "请联系 hello@example.com，或者粘贴 @ 文本")
    }

    @MainActor
    func testAttachmentsStayWithTheirDraftAndSurviveASendFailure() async {
        let service = BridgeService()
        service.state.selection.projectId = "one"
        let key = service.draftKey
        let file = MessageAttachment(id: "file", name: "测试.txt", path: "/tmp/测试.txt", size: 4)
        service.draftAttachments[key] = [file]
        service.drafts[key] = "检查文件"
        service.state.selection.projectId = "two"
        XCTAssertNil(service.draftAttachments[service.draftKey])
        service.state.selection.projectId = "one"
        service.send("检查文件", clearDraft: true)
        for _ in 0..<20 { await Task.yield() }
        XCTAssertNotNil(service.lastError)
        XCTAssertEqual(service.draftAttachments[key], [file])
        XCTAssertEqual(service.drafts[key], "检查文件")
        XCTAssertTrue(service.sending.isEmpty)
        service.removeAttachment(file.id)
        XCTAssertEqual(service.draftAttachments[key], [])
        XCTAssertEqual(service.drafts[key], "检查文件")
    }
}
