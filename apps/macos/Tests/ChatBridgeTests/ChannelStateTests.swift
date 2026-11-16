import XCTest
@testable import ChatBridge

final class ChannelStateTests: XCTestCase {
    @MainActor
    func testRunningTaskCanRequestStopThroughTheService() async {
        let service = BridgeService()
        let job = JobSummary(id: "J123456789abc", text: "Task", status: "running", target: Selection())
        service.taskAction("stop", job: job)
        for _ in 0..<20 { await Task.yield() }
        XCTAssertNotNil(service.lastError, "Without a helper, an allowed stop action must report a connection error instead of silently doing nothing")
    }
    @MainActor
    func testChannelErrorsStayWithTheirSetupForm() async {
        let service = BridgeService()
        service.weixin("start")
        for _ in 0..<20 { if !service.channelBusy { break }; await Task.yield() }
        XCTAssertNotNil(service.channelErrors["weixin"])
        XCTAssertNil(service.lastError)
    }
    func testConnectionLabelNeedsConfirmedTransportState() {
        var state = WeixinState()
        state.status = "connected"
        XCTAssertNotEqual(state.statusLabel, "已连接")
        state.connected = true
        XCTAssertEqual(state.statusLabel, "已连接")
        state.connected = false
        state.status = "awaiting_confirmation"
        XCTAssertEqual(state.statusLabel, "待本机确认")
    }
    func testTaskControlsNeverOfferRetryForUncertainSends() {
        var job = JobSummary(id: "J1", text: "Task", status: "waiting_agent", target: Selection())
        XCTAssertTrue(job.canContinue)
        XCTAssertTrue(job.canCancel)
        job.status = "accepted"
        XCTAssertFalse(job.canContinue)
        XCTAssertTrue(job.canCancel)
        for status in ["uncertain", "dispatching", "running", "completed", "failed"] {
            job.status = status
            XCTAssertFalse(job.canContinue)
            XCTAssertFalse(job.canCancel)
        }
    }
    func testDesktopOwnedTaskControlsStayInTheOriginalApp() throws {
        let data = Data(#"{"id":"J1","text":"Continue","status":"queued","externalControl":true,"target":{"agent":"codex","mode":"code","projectId":null,"version":1}}"#.utf8)
        var job = try JSONDecoder().decode(JobSummary.self, from: data)
        XCTAssertEqual(job.statusLabel, "已加入原会话队列，等待执行")
        XCTAssertFalse(job.canContinue)
        XCTAssertFalse(job.canCancel)
        job.status = "running"
        XCTAssertFalse(job.canStop)
    }
}
