import XCTest
@testable import ChatBridge

final class ChannelStateTests: XCTestCase {
    @MainActor
    func testConfiguredRoutingCanAcceptAnIntentBeforeTheCurrentAgentIsAvailable() {
        let service = BridgeService()
        service.isRunning = true
        service.state.routing = RoutingState(mode: "confirm", configured: true)
        XCTAssertTrue(service.canSend)
        service.state.routing?.mode = "off"
        XCTAssertFalse(service.canSend)
    }

    func testRoutingTasksExposeOnlySafeActionsBeforeDispatch() {
        var job = JobSummary(id: "J1", text: "任务", status: "routing", target: Selection())
        XCTAssertEqual(job.statusLabel, "正在判断 Agent、项目和会话…")
        XCTAssertTrue(job.canCancel)
        XCTAssertFalse(job.canContinue)
        XCTAssertFalse(job.canStop)
        job.status = "awaiting_route"
        XCTAssertEqual(job.statusLabel, "等待选择目标，任务尚未发送")
        XCTAssertTrue(job.canContinue)
        XCTAssertTrue(job.canCancel)
        XCTAssertFalse(job.canStop)
    }

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
        service.imessage("start", params: ["email": "invalid", "phone": "1234"])
        for _ in 0..<20 { if !service.channelBusy { break }; await Task.yield() }
        XCTAssertNotNil(service.channelErrors["imessage"])
        XCTAssertNil(service.lastError)
        service.weixin("start")
        for _ in 0..<20 { if !service.channelBusy { break }; await Task.yield() }
        XCTAssertNotNil(service.channelErrors["weixin"])
        XCTAssertNil(service.lastError)
    }
    func testIMessagePairingDoesNotClaimConnectionBeforeTheTransportIsRunning() {
        var state = IMessageState()
        state.status = "dispatching_verification"
        XCTAssertEqual(state.statusLabel, "正在发送配对请求")
        state.status = "awaiting_phone"
        XCTAssertEqual(state.statusLabel, "等待手机回复 OK")
        XCTAssertFalse(state.bound)
        XCTAssertFalse(state.connected)
        state.connected = true
        XCTAssertEqual(state.statusLabel, "已连接")
        let channels = ChannelStates(weixin: WeixinState(), imessage: state)
        XCTAssertTrue(channels.connected)
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
