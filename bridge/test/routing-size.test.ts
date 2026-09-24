import { test } from "node:test";
import assert from "node:assert/strict";
import { agentIDs } from "../src/core.js";
import { defaultRoutingSettings, JevGateway, routeActions, type RoutingContext } from "../src/routing.js";

function catalog(): RoutingContext {
  const current = { agent: "codex", mode: "code", projectId: "project-0", sessionId: "session-0" };
  return {
    text: "用 CodeX 创建一个无项目会话，记住测试口令是上海 0921，只回复已记住，不要操作文件。",
    current, defaultAgent: "codex", settings: { ...defaultRoutingSettings, provider: "openrouter", mode: "auto" },
    active: { codex: current }, probes: Object.fromEntries(agentIDs.map(agent => [agent, { ready: true, reason: "Fixture" }])),
    projects: Array.from({ length: 47 }, (_, index) => ({ id: "project-" + index, shortId: "P" + index,
      agent: agentIDs[index % agentIDs.length]!, name: "项目" + index + "-" + "场景".repeat(40), roots: [] })),
    sessions: Array.from({ length: 217 }, (_, index) => ({ id: "session-" + index, nativeId: "native-" + index,
      shortId: "S" + index, agent: agentIDs[index % agentIDs.length]!, mode: "code", projectId: "project-" + index % 42,
      title: "会话" + index + "-" + "这是已有会话的历史标题".repeat(8), updatedAt: 1_790_000_000 + index })),
    history: Array.from({ length: 6 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", text: "历史内容".repeat(250) })),
    tasks: Array.from({ length: 15 }, (_, index) => ({ id: "J" + index, text: "原消息".repeat(166),
      status: index < 12 ? "awaiting_route" : "completed", target: current, question: "请选择这条消息的目标。", canAnswer: true, canStop: true })),
  };
}

test("a short prompt with the supported catalog and history fits the routing request budget", async t => {
  for (const expanded of [false, true]) await t.test(expanded ? "expanded session lookup" : "initial catalog", async () => {
    const context = catalog();
    if (expanded) {
      context.lookupScope = { agent: "codex", projectId: "project-0" };
      context.sessions = context.sessions.map(session => ({ ...session, agent: "codex", projectId: "project-0" }));
    }
    const actions = routeActions(context);
    let requests = 0;
    const gateway = new JevGateway({ read: async () => ({ apiKey: "fixture-key" }), write: async () => {}, remove: async () => {} },
      async (_url, init) => {
        requests++;
        const wire = String(init?.body), body = JSON.parse(wire);
        assert.ok(Buffer.byteLength(wire) <= 96 * 1024, "Keep the existing outbound request limit");
        assert.equal(body.state.message, context.text, "Never truncate the user's request to hide catalog overhead");
        assert.deepEqual(Object.keys(body.questions.route.criteria).sort(), actions.map(action => action.id).sort(),
          "Keep every legal action within the advertised catalog limits");
        for (const action of actions) {
          const criterion = body.questions.route.criteria[action.id];
          if (criterion.rules) assert.ok(body.state.actionRules[criterion.rules]);
          if (action.target && !action.jobId) {
            const destination = body.state.catalog.targets[criterion.target];
            assert.equal(destination.agent, action.target.agent);
            assert.equal(destination.mode, action.target.mode);
            assert.equal(destination.project === null ? null : body.state.catalog.projects[destination.project].id, action.target.projectId);
            assert.equal(destination.session === null ? null : body.state.catalog.sessions[destination.session].id, action.target.sessionId ?? null);
          }
          if (action.scope?.projectId !== undefined) {
            assert.equal(criterion.scope.project === null ? null : body.state.catalog.projects[criterion.scope.project].id, action.scope.projectId);
          }
          if (action.jobId) assert.ok(body.state.tasks.some((task: any) => task.id === action.jobId && body.state.catalog.targets[task.target]));
        }
        assert.equal(body.state.contextTruncated, true, "Oversized background is explicitly marked as summarized");
        return Response.json({ answers: {
          route: { type: "choice", choice: "new_codex_none", confidence: 1, probabilities: { new_codex_none: 1 } },
          intent: { type: "choice", choice: "new", confidence: 1, probabilities: { new: 1 } },
        } });
      }, () => Date.parse("2026-09-21T00:00:00+08:00"), "openrouter");
    assert.equal((await gateway.choose(context, actions)).choice, "new_codex_none");
    assert.equal(requests, 1);
  });
});
