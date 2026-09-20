import XCTest
@testable import ChatBridge

final class AgentSelectionTests: XCTestCase {
    func testAllSixAgentsHaveRuntimeIntegration() {
        XCTAssertEqual(Agent.all.filter { !$0.comingSoon }.map(\.id), ["codex", "claude", "cursor", "grok", "opencode", "hermes"])
    }
    func testExecutionFailureIsVisibleWhileTheConnectedAgentAllowsRetry() throws {
        let json = Data(#"{"installed":true,"ready":true,"status":"ready","reason":"Connected","executionError":"模型服务拒绝请求"}"#.utf8)
        let probe = try JSONDecoder().decode(AgentProbe.self, from: json)
        XCTAssertTrue(probe.ready)
        XCTAssertEqual(probe.statusLabel, "执行异常")
    }
    @MainActor
    func testServiceSnapshotsAutomaticallyEnableAndDisableTheComposer() {
        let service = BridgeService()
        service.isRunning = true
        var snapshot: [String: Any] = ["preferences": ["defaultAgent": "codex", "pinned": [], "keepAlive": false, "names": [:]],
            "selection": ["agent": "codex", "mode": "code", "version": 1],
            "sessions": [], "messages": [], "jobs": [], "historyPartial": true]
        snapshot["probes"] = ["codex": ["installed": true, "ready": true, "status": "ready", "reason": "已就绪"]]
        service.updateState(snapshot)
        XCTAssertTrue(service.canSend)
        snapshot["probes"] = ["codex": ["installed": true, "ready": false, "status": "needs_login", "reason": "请登录"]]
        service.updateState(snapshot)
        XCTAssertFalse(service.canSend)
        XCTAssertEqual(service.probes["codex"]?.reason, "请登录")
    }

    @MainActor
    func testNewConversationCanSendAndProjectDraftsStaySeparate() {
        let service = BridgeService()
        service.isRunning = true
        service.probes["codex"] = AgentProbe(installed: true, ready: true)
        XCTAssertTrue(service.canSend)
        service.state.selection.projectId = "project-one"
        service.drafts[service.draftKey] = "Unsent project one message"
        service.state.selection.projectId = "project-two"
        XCTAssertNil(service.drafts[service.draftKey])
        service.viewedAgent = "claude"
        XCTAssertFalse(service.canSend)
    }

    @MainActor
    func testRemoteAgentSwitchFollowsSelectionWithoutOverridingAnotherAgentPreview() throws {
        let service = BridgeService()
        let snapshot: [String: Any] = ["preferences": ["defaultAgent": "codex", "pinned": [], "keepAlive": false, "names": [:]],
            "selection": ["agent": "claude", "mode": "code", "version": 1],
            "sessions": [], "messages": [], "jobs": [], "historyPartial": true]
        service.updateState(snapshot)
        XCTAssertEqual(service.viewedAgent, "claude")
        service.viewedAgent = "cursor"
        var changed = snapshot
        changed["selection"] = ["agent": "codex", "mode": "code", "version": 2]
        service.updateState(changed)
        XCTAssertEqual(service.viewedAgent, "cursor")
    }

    @MainActor
    func testOpeningAnAgentWithTheServiceOfflinePreservesTheOriginalDraft() async {
        let service = BridgeService()
        service.state.selection.sessionId = "existing-session"
        service.drafts[service.draftKey] = "Unsent message"

        service.openAgent("cursor")

        XCTAssertEqual(service.viewedAgent, "cursor")
        for _ in 0..<20 { await Task.yield() }
        XCTAssertTrue(service.opening.isEmpty)
        XCTAssertNotNil(service.lastError)
        XCTAssertEqual(service.state.selection.agent, "codex")
        XCTAssertEqual(service.state.selection.sessionId, "existing-session")
        XCTAssertEqual(service.drafts["codex:existing-session"], "Unsent message")
    }
}
