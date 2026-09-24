import AppKit
import XCTest
@testable import ChatBridge

final class ComposerAttachmentTests: XCTestCase {
    @MainActor
    func testTypingAtKeepsTheQueryInTheComposerWithoutOpeningASystemPicker() async throws {
        _ = NSApplication.shared
        let window = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 500, height: 400),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        hideFromScreen(window)
        window.makeKeyAndOrderFront(nil)
        defer { window.close() }
        let service = BridgeService()
        defer { service.dismissFileSearch() }
        service.isRunning = true
        service.probes["codex"] = AgentProbe(installed: true, ready: true)
        service.drafts[service.draftKey] = "请分析  的内容"
        service.updateDraft("请分析 @ 的内容", selection: NSRange(location: 5, length: 0))
        XCTAssertEqual(service.fileMention?.query, "")
        let picker = NSApp.windows.compactMap { $0 as? NSOpenPanel }.first { $0.isVisible }
        XCTAssertNil(picker)
        picker?.cancel(nil)
        XCTAssertTrue(service.draftAttachments.isEmpty)
        XCTAssertEqual(service.drafts[service.draftKey], "请分析 @ 的内容")
    }

    @MainActor
    func testEmailAndPastedMentionsDoNotOpenTheFilePicker() {
        let service = BridgeService()
        defer { service.dismissFileSearch() }
        service.isRunning = true
        service.probes["codex"] = AgentProbe(installed: true, ready: true)
        service.drafts[service.draftKey] = "hello"
        service.updateDraft("hello@")
        XCTAssertNil(service.fileMention)
        XCTAssertEqual(service.drafts[service.draftKey], "hello@")
        service.updateDraft("请联系 hello@example.com，或者粘贴 @ 文本")
        // A pasted filename can be searched too; the text is never consumed by a system dialog.
        XCTAssertEqual(service.drafts[service.draftKey], "请联系 hello@example.com，或者粘贴 @ 文本")
    }

    @MainActor
    func testDeletingADismissedMentionAllowsTypingANewOne() {
        let service = BridgeService()
        defer { service.dismissFileSearch() }
        service.isRunning = true
        service.probes["codex"] = AgentProbe(installed: true, ready: true)
        service.updateDraft("@设计")
        service.dismissFileSearch()
        service.updateDraft("")
        service.updateDraft("@设计")
        XCTAssertEqual(service.fileMention?.query, "设计")
    }

    @MainActor
    func testPaperclipWorksAfterTheDraftWasCleared() {
        let service = BridgeService()
        defer { service.dismissFileSearch() }
        service.isRunning = true
        service.probes["codex"] = AgentProbe(installed: true, ready: true)
        service.updateDraft("已发送的长消息")
        service.drafts[service.draftKey] = ""
        service.beginFileSearch()
        XCTAssertEqual(service.drafts[service.draftKey], "@")
        XCTAssertEqual(service.fileMention?.query, "")
    }

    @MainActor
    func testSearchFollowsTheCaretAndDismissalDoesNotChangeTheDraft() {
        let service = BridgeService()
        service.isRunning = true
        service.probes["codex"] = AgentProbe(installed: true, ready: true)
        service.updateDraft("查看 @设计 的内容", selection: NSRange(location: 6, length: 0))
        XCTAssertEqual(service.fileMention?.query, "设计")
        service.dismissFileSearch()
        service.updateDraft("查看 @设计 的内容", selection: NSRange(location: 6, length: 0))
        XCTAssertNil(service.fileMention, "Selection notifications must not reopen a dismissed menu")
        XCTAssertEqual(service.drafts[service.draftKey], "查看 @设计 的内容")
        service.beginFileSearch()
        XCTAssertEqual(service.fileMention?.query, "设计", "The paperclip reopens the current query instead of adding another @")
        service.updateDraft("查看 @设计 的内容", selection: NSRange(location: 0, length: 0))
        XCTAssertNil(service.fileMention)
        service.updateDraft("查看 @设 的内容", selection: NSRange(location: 5, length: 0), composing: true)
        XCTAssertNil(service.fileMention, "IME candidate selection must not attach a file")
        service.updateDraft("查看 @设计 的内容", selection: NSRange(location: 6, length: 0))
        XCTAssertEqual(service.fileMention?.query, "设计")
        service.dismissFileSearch()
    }

    @MainActor
    func testPaperclipInsertsAMentionAtTheSelectionAndImportFailureKeepsIt() async {
        let service = BridgeService()
        service.isRunning = true
        service.probes["codex"] = AgentProbe(installed: true, ready: true)
        service.updateDraft("查看 的内容", selection: NSRange(location: 3, length: 0))
        service.beginFileSearch()
        XCTAssertEqual(service.drafts[service.draftKey], "查看 @的内容")
        XCTAssertEqual(service.fileMention?.query, "")
        service.attachSuggestedFile(FileSuggestion(url: URL(fileURLWithPath: "/tmp/missing.txt"), size: 0, modified: .now))
        for _ in 0..<20 { await Task.yield() }
        XCTAssertNotNil(service.lastError)
        XCTAssertEqual(service.drafts[service.draftKey], "查看 @的内容")
        XCTAssertNotNil(service.fileMention)
        service.dismissFileSearch()
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
