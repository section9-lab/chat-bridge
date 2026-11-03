import XCTest
@testable import ChatBridge

final class ConnectorTests: XCTestCase {
    func testConnectorSummaryAndAccountsDecodeFromServiceState() throws {
        let json = Data(#"{
          "preferences":{"defaultAgent":"codex","pinned":[],"keepAlive":false,"names":{},"enabledAgents":["codex"]},
          "selection":{"agent":"codex","mode":"code","version":0},
          "sessions":[],"messages":[],"jobs":[],"historyPartial":true,
          "connectors":{"provider":{"configured":true,"status":"ready"},"connectedCount":1,"attentionCount":0,"availableByAgent":{"codex":1},"toolExecutionEnabled":false}
        }"#.utf8)
        let state = try JSONDecoder().decode(BridgeState.self, from: json)
        XCTAssertEqual(state.connectors?.connectedCount, 1)
        XCTAssertEqual(state.connectors?.availableByAgent["codex"], 1)
    }

    func testConnectorPolicyKeepsExplicitAgentAccess() throws {
        let data = Data(#"{"accountId":"ca_1","allowedAgents":["codex","claude"],"mode":"confirm-writes"}"#.utf8)
        let policy = try JSONDecoder().decode(ConnectorPolicy.self, from: data)
        XCTAssertEqual(policy.allowedAgents, ["codex", "claude"])
        XCTAssertEqual(policy.mode, "confirm-writes")
    }
}
