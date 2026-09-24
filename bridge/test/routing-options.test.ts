import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeCore, BridgeError, type AgentAdapter, type NativeSession, type Origin } from "../src/core.js";
import { JevGateway, type RouteAction, type RoutingContext } from "../src/routing.js";

const answer = (choice: string) => ({ choice, confidence: 1, probabilities: { [choice]: 1 } });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "bridge-routing-options-"));
  const database = join(directory, "bridge.sqlite");
  let sequence = 0, calls = 0;
  const sends: { agent: string; session: NativeSession; text: string }[] = [];
  const adapters: Record<string, AgentAdapter> = Object.fromEntries(["codex", "claude"].map(agent => [agent, {
    probe: async () => ({ ready: true, reason: "Fixture" }),
    listProjects: async () => [{ id: agent + "-shop", name: "商城", roots: [] }],
    listSessions: async () => [
      { nativeId: agent + "-old", title: "支付修复", projectId: agent + "-shop", updatedAt: 2 },
      { nativeId: agent + "-direct", title: "出差准备", projectId: null, updatedAt: 1 },
    ],
    createSession: async target => ({ nativeId: "new-" + ++sequence, title: "新会话", projectId: target.projectId }),
    resumeSession: async session => session,
    sendTurn: async (session, text) => { sends.push({ agent, session, text }); return { turnId: "turn-" + sequence, text: "完成" }; },
  } satisfies AgentAdapter]));
  let core = new BridgeCore(database, adapters);
  let decide = async (_context: RoutingContext, _actions: RouteAction[]) => { throw new BridgeError("ROUTER_UNAVAILABLE", "智能路由连接超时。"); return answer("continue"); };
  const connect = () => { core.routeDecision = async (context, actions) => { calls++; return decide(context, actions); }; };
  connect(); core.setRoutingSettings({ mode: "auto" });
  for (const kind of ["weixin", "imessage"] as const) core.bindChannel(kind, "account", "owner");
  const origin = (kind: Origin["kind"] = "weixin", eventId = "event-" + ++sequence): Origin => ({
    kind, accountId: kind === "desktop" ? "local" : "account", peerId: kind === "desktop" ? "local" : "owner", eventId,
  });
  const receive = (text: string, kind: Origin["kind"] = "weixin", eventId?: string) => core.receive(origin(kind, eventId), text);
  async function send(text: string, kind: Origin["kind"] = "weixin", eventId?: string) {
    const receipt = receive(text, kind, eventId); if (receipt.jobId) await core.run(receipt.jobId); return receipt;
  }
  return { get core() { return core; }, adapters, sends, origin, receive, send,
    calls: () => calls, decide(value: typeof decide) { decide = value; },
    message() { return core.outbox().filter(entry => entry.kind !== "onboarding").at(-1)?.text ?? ""; },
    async ready() { await core.probeAgents(); await Promise.all(Object.keys(adapters).map(agent => core.refreshCatalog(agent))); },
    restart() { core.close(); core = new BridgeCore(database, adapters); connect(); },
    close() { core.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test("routing exposes scoped catalog queries without changing the active target", async () => {
  const f = fixture();
  try {
    await f.ready();
    const before = f.core.state().selection;
    for (const [query, scope] of [
      ["Claude 的项目", { agent: "claude" }],
      ["Claude 的全部会话", { agent: "claude" }],
      ["Claude 的商城会话", { agent: "claude", projectId: "claude-shop" }],
      ["Claude 的直接会话", { agent: "claude", projectId: null }],
    ] as const) {
      f.decide(async (_context, actions) => {
        const action = actions.find(a => a.kind === "list" && a.command === (query.endsWith("项目") ? "project" : "sessions") &&
          JSON.stringify((a as any).scope) === JSON.stringify(scope));
        assert.ok(action, query); return answer(action.id);
      });
      await f.send(query);
      assert.match(f.message(), /Claude/);
      if ("projectId" in scope) assert.match(f.message(), scope.projectId === null ? /出差准备/ : /支付修复/);
      assert.deepEqual(f.core.state().selection, before);
      assert.equal(f.sends.length, 0);
    }
  } finally { f.close(); }
});

test("selecting a project restores its last conversation without creating or sending a task", async () => {
  const f = fixture();
  try {
    await f.ready();
    const session = f.core.state().sessions.find(s => s.nativeId === "claude-old")!;
    f.receive("/use " + session.shortId); f.receive("/agent codex");
    f.decide(async (_context, actions) => {
      const action = actions.find(a => a.id.startsWith("select_project_") && a.target?.projectId === "claude-shop");
      assert.ok(action); return answer(action.id);
    });
    await f.send("切到 Claude 的商城项目");
    assert.equal(f.core.state().selection.sessionId, session.id);
    assert.equal(f.sends.length, 0);
    assert.match(f.message(), /Claude > 商城 > 支付修复\n已切换✅/);
  } finally { f.close(); }
});

test("router failure provides local text options and preserves the original request", async () => {
  const f = fixture();
  try {
    const original = await f.send("分析商城退款流程");
    assert.match(f.message(), /尚未发送/);
    assert.match(f.message(), /\d{2} 手动选择目标/);
    assert.match(f.message(), /重新尝试智能判断/);
    assert.match(f.message(), /取消这条消息/);
    assert.doesNotMatch(f.message(), /\/(?:agent|project|continue)|J[0-9a-f]{12}/);
    const before = f.core.state().selection;
    await f.send("手动选择目标");
    assert.match(f.message(), /选择 Agent/);
    await f.send("Claude");
    assert.match(f.message(), /选择项目/);
    await f.send("商城");
    assert.match(f.message(), /支付修复/);
    assert.deepEqual(f.core.state().selection, before, "Browsing only changes the picker draft");
    await f.send("支付修复", "weixin", "selection");
    assert.equal(f.calls(), 1, "Selections never call the failed router");
    assert.deepEqual(f.sends.map(s => [s.agent, s.session.nativeId, s.text]), [["claude", "claude-old", "分析商城退款流程"]]);
    assert.equal(f.core.state().jobs.find(j => j.id === original.jobId)?.status, "completed");
    assert.ok(f.core.outbox().some(e => e.jobId === original.jobId && e.text === "Claude > 商城 > 支付修复\n已收到✅"));
    await f.send("支付修复", "weixin", "selection");
    assert.equal(f.sends.length, 1);
  } finally { f.close(); }
});

for (const project of ["商城", "无项目"]) test("local options create one session in " + project, async () => {
  const f = fixture();
  try {
    await f.send("新任务"); await f.send("手动选择目标"); await f.send("Claude"); await f.send(project); await f.send("新建会话");
    assert.equal(f.calls(), 1);
    assert.equal(f.sends.length, 1);
    assert.equal(f.sends[0]?.session.projectId, project === "商城" ? "claude-shop" : null);
    assert.ok(f.sends[0]?.session.nativeId.startsWith("new-"));
  } finally { f.close(); }
});

test("confirm mode offers distinct new and existing destinations with local selection", async () => {
  const f = fixture();
  try {
    await f.ready(); f.core.setRoutingSettings({ mode: "confirm" });
    const existing = f.core.state().sessions.find(s => s.nativeId === "codex-old")!;
    f.receive("/use " + existing.shortId);
    f.decide(async (_context, actions) => {
      const fresh = actions.find(a => a.kind === "send" && a.target?.projectId === "codex-shop" && !a.target.sessionId)!;
      return { choice: "continue", confidence: 0.5, probabilities: { continue: 0.5, [fresh.id]: 0.5 } };
    });
    await f.send("重新分析一下支付");
    assert.match(f.message(), /01 继续.*Codex > 商城 > 支付修复/);
    assert.match(f.message(), /02 新建.*Codex > 商城 > 新会话/);
    await f.send("02");
    assert.equal(f.calls(), 1); assert.equal(f.sends.length, 1);
    assert.notEqual(f.sends[0]?.session.nativeId, existing.nativeId);
  } finally { f.close(); }
});

test("retry and cancellation are local actions on the original task", async () => {
  const f = fixture();
  try {
    const original = await f.send("待处理的任务");
    await f.send("重新尝试智能判断");
    assert.equal(f.calls(), 2);
    assert.equal(f.core.state().jobs.length, 1);
    await f.send("取消这条消息");
    assert.equal(f.core.state().jobs.find(j => j.id === original.jobId)?.status, "cancelled");
    assert.equal(f.sends.length, 0);
  } finally { f.close(); }
});

test("text options survive restart and invalid selections cannot become tasks", async () => {
  const f = fixture();
  try {
    await f.send("恢复前的任务"); await f.send("手动选择目标"); await f.send("Claude");
    f.restart();
    await f.send("99");
    assert.equal(f.core.state().jobs.length, 1);
    await f.send("商城"); await f.send("支付修复");
    assert.equal(f.calls(), 1); assert.equal(f.sends[0]?.text, "恢复前的任务");
  } finally { f.close(); }
});

test("multiple pending requests require choosing the task instead of guessing", async () => {
  const f = fixture();
  try {
    const first = await f.send("任务甲"); const second = await f.send("任务乙");
    await f.send("01");
    assert.equal(f.sends.length, 0);
    assert.match(f.message(), /选择.*消息|哪条消息/);
    assert.match(f.message(), /任务甲/); assert.match(f.message(), /任务乙/);
    assert.equal(f.core.state().jobs.find(j => j.id === first.jobId)?.status, "awaiting_route");
    assert.equal(f.core.state().jobs.find(j => j.id === second.jobId)?.status, "awaiting_route");
  } finally { f.close(); }
});

test("manual legacy navigation preserves pending prompts", async () => {
  const f = fixture();
  try {
    const original = await f.send("稍后需要选择目标的请求");
    f.receive("/agent claude");
    assert.equal(f.core.state().jobs.find(j => j.id === original.jobId)?.status, "awaiting_route");
    assert.equal(f.core.state().jobs.find(j => j.id === original.jobId)?.text, "稍后需要选择目标的请求");
  } finally { f.close(); }
});

test("correcting a completed task only selects the destination for future messages", async () => {
  const f = fixture();
  try {
    f.decide(async () => answer("new_codex_none"));
    const original = await f.send("写一封邮件");
    await f.send("选错了");
    assert.match(f.message(), /已经发送|已经完成/);
    assert.match(f.message(), /后续消息选择其他目标/);
    await f.send("为后续消息选择其他目标"); await f.send("Claude"); await f.send("商城"); await f.send("支付修复");
    assert.equal(f.sends.length, 1); assert.equal(f.calls(), 1);
    assert.equal(f.core.state().selection.agent, "claude");
    assert.equal(f.core.state().jobs.find(j => j.id === original.jobId)?.status, "completed");
  } finally { f.close(); }
});

test("correction during session preparation cannot dispatch the original target", async () => {
  const f = fixture(); let release!: () => void;
  try {
    f.decide(async () => answer("new_codex_none"));
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.adapters.codex!.createSession = async target => { entered(); await new Promise<void>(resolve => { release = resolve; });
      return { nativeId: "old-preparation", projectId: target.projectId, title: "旧目标" }; };
    const receipt = f.receive("应该发给 Claude 的任务"); const running = f.core.run(receipt.jobId!);
    await started;
    await f.send("选错了");
    release(); await running;
    assert.equal(f.sends.length, 0);
    assert.equal(f.core.state().jobs.find(j => j.id === receipt.jobId)?.status, "awaiting_route");
  } finally { release?.(); f.close(); }
});

test("correcting an uncertain send cannot offer to send the original again", async () => {
  const f = fixture();
  try {
    f.decide(async () => answer("new_codex_none"));
    f.adapters.codex!.sendTurn = async () => { throw new Error("connection lost after submission"); };
    const receipt = await f.send("可能已经执行的操作");
    await f.send("选错了");
    assert.match(f.message(), /已经发送|执行状态/);
    assert.doesNotMatch(f.message(), /重新尝试智能判断|继续会话.*发送|取消这条消息/);
    assert.equal(f.core.state().jobs.find(j => j.id === receipt.jobId)?.status, "uncertain");
    assert.equal(f.calls(), 1);
  } finally { f.close(); }
});

test("expired options refresh without sending and old menu codes cannot target new options", async context => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = fixture();
  try {
    await f.send("原任务"); const code = f.core.activeMenuId(f.origin())! + "-01";
    context.mock.timers.tick(10 * 60_000);
    await f.send("01"); assert.match(f.message(), /已过期/);
    await f.send(code); assert.match(f.message(), /已被处理或替换/);
    assert.equal(f.calls(), 1); assert.equal(f.sends.length, 0);
  } finally { f.close(); }
});

test("text options cannot be used from a different channel or after rebinding", async () => {
  const f = fixture();
  try {
    await f.send("原任务"); const code = f.core.activeMenuId(f.origin())! + "-01";
    await f.send(code, "imessage"); assert.match(f.message(), /不属于当前绑定/);
    f.core.unbindChannel("weixin"); f.core.bindChannel("weixin", "account", "owner");
    await f.send(code); assert.match(f.message(), /不属于当前绑定/);
    assert.equal(f.calls(), 1); assert.equal(f.sends.length, 0);
  } finally { f.close(); }
});

test("menus never execute a target removed from a refreshed catalog", async () => {
  const f = fixture();
  try {
    await f.send("原任务"); await f.send("手动选择目标"); await f.send("Claude"); await f.send("商城");
    f.adapters.claude!.listSessions = async () => [];
    await f.core.refreshCatalog("claude"); await f.send("支付修复");
    assert.match(f.message(), /目标暂不可用/);
    assert.equal(f.calls(), 1); assert.equal(f.sends.length, 0);
  } finally { f.close(); }
});

test("local pagination reaches old sessions omitted by the router shortlist", async () => {
  const f = fixture();
  try {
    f.adapters.claude!.listSessions = async () => Array.from({ length: 48 }, (_, index) => ({
      nativeId: "old-" + index, title: "任务 " + index, projectId: "claude-shop", updatedAt: 100 - index,
    }));
    await f.send("继续一个较早的任务"); await f.send("手动选择目标"); await f.send("Claude"); await f.send("商城");
    for (let index = 0; index < 7; index++) await f.send("下一页");
    await f.send("任务 47");
    assert.equal(f.calls(), 1); assert.equal(f.sends[0]?.session.nativeId, "old-47");
  } finally { f.close(); }
});

test("a bounded lookup can find an older session in the requested project", async () => {
  const f = fixture();
  try {
    f.adapters.claude!.listSessions = async () => Array.from({ length: 55 }, (_, index) => ({
      nativeId: "old-" + index, title: "任务 " + index, projectId: "claude-shop", updatedAt: 100 - index,
    }));
    f.decide(async (_context, actions) => {
      if (f.calls() === 1) {
        const lookup = actions.find(a => (a.kind as string) === "lookup" && a.scope?.projectId === "claude-shop");
        assert.ok(lookup); return answer(lookup.id);
      }
      const resume = actions.find(a => a.kind === "send" && a.target?.sessionId === f.core.state().sessions.find(s => s.nativeId === "old-54")!.id);
      assert.ok(resume); return answer(resume.id);
    });
    await f.send("接着较早的商城任务");
    assert.equal(f.calls(), 2); assert.equal(f.sends[0]?.session.nativeId, "old-54");
  } finally { f.close(); }
});

test("a locally corrected target executes even while the previous preparation is finishing", async () => {
  const f = fixture(); let release!: () => void;
  try {
    f.decide(async () => answer("new_codex_none"));
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.adapters.codex!.createSession = async target => { entered(); await new Promise<void>(resolve => { release = resolve; });
      return { nativeId: "old-preparation", projectId: target.projectId, title: "旧目标" }; };
    const receipt = f.receive("原任务"); const running = f.core.run(receipt.jobId!); await started;
    await f.send("选错了"); await f.send("手动选择目标"); await f.send("Claude"); await f.send("商城");
    const corrected = f.send("支付修复"); release(); await Promise.all([running, corrected]);
    assert.equal(f.sends.length, 1); assert.equal(f.sends[0]?.agent, "claude");
    assert.equal(f.sends[0]?.text, "原任务"); assert.equal(f.calls(), 1);
  } finally { release?.(); f.close(); }
});

test("a late preparation failure cannot overwrite a correction", async () => {
  const f = fixture(); let release!: () => void;
  try {
    f.decide(async () => answer("new_codex_none"));
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.adapters.codex!.createSession = async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); throw new Error("late failure"); };
    const receipt = f.receive("原任务"); const running = f.core.run(receipt.jobId!); await started;
    await f.send("选错了"); release(); await running;
    assert.equal(f.core.state().jobs.find(j => j.id === receipt.jobId)?.status, "awaiting_route");
    assert.equal(f.sends.length, 0);
  } finally { release?.(); f.close(); }
});

test("pure projectless navigation marks the empty destination as explicitly selected", async () => {
  const f = fixture();
  try {
    f.decide(async () => answer("select_new_codex_none"));
    await f.send("在 Codex 开个无项目会话");
    assert.equal(f.core.state().selection.engaged, true);
    assert.equal(f.sends.length, 0);
  } finally { f.close(); }
});

test("all gateway failure categories offer local options without exposing upstream content", async t => {
  const cases = [
    { name: "missing key", key: false },
    ...[401, 402, 403, 429, 503, 529].map(status => ({ name: "HTTP " + status, status })),
    { name: "network", network: true }, { name: "invalid response", invalid: true },
    { name: "invalid choice", choice: true }, { name: "oversized context", oversized: true },
  ];
  for (const value of cases) await t.test(value.name, async () => {
    const f = fixture();
    const item = value as { key?: boolean; status?: number; network?: boolean; invalid?: boolean; choice?: boolean; oversized?: boolean };
    try {
      const gateway = new JevGateway({ read: async () => item.key === false ? null : { apiKey: "secret-not-for-output" }, write: async () => {}, remove: async () => {} },
        async () => {
          if (item.network) throw new Error("secret-not-for-output");
          if (item.invalid) return new Response("secret-not-for-output");
          if (item.choice) return Response.json({ answers: { route: { type: "choice", choice: "missing-action", confidence: 1, probabilities: { "missing-action": 1 } } } });
          return new Response("secret-not-for-output", { status: item.status ?? 500 });
        }, () => Date.parse("2026-09-20"));
      f.decide((context, actions) => gateway.choose(context, actions));
      const original = await f.send(item.oversized ? "大".repeat(40_000) : "原任务");
      assert.match(f.message(), /手动选择目标/); assert.doesNotMatch(f.message(), /secret-not-for-output/);
      assert.equal(f.core.state().jobs.find(j => j.id === original.jobId)?.status, "awaiting_route");
      await f.send("取消这条消息"); assert.equal(f.calls(), 1); assert.equal(f.sends.length, 0);
    } finally { f.close(); }
  });
});

test("short action words resolve a unique displayed choice without invoking JEV", async () => {
  const f = fixture();
  try {
    await f.ready(); f.core.setRoutingSettings({ mode: "confirm" });
    const session = f.core.state().sessions.find(s => s.nativeId === "codex-old")!;
    f.receive("/use " + session.shortId);
    f.decide(async (_context, actions) => {
      const fresh = actions.find(a => a.kind === "send" && a.target?.projectId === "codex-shop" && !a.target.sessionId)!;
      return { choice: "continue", confidence: 0.5, probabilities: { continue: 0.5, [fresh.id]: 0.5 } };
    });
    await f.send("重新分析支付"); await f.send("新建");
    assert.equal(f.calls(), 1); assert.equal(f.sends.length, 1);
  } finally { f.close(); }
});

test("channel preparation refreshes a manually chosen agent without using JEV", async () => {
  const f = fixture();
  try {
    f.adapters.claude!.probe = async () => ({ ready: false, reason: "需要登录" });
    await f.send("原任务"); await f.send("手动选择目标");
    f.adapters.claude!.probe = async () => ({ ready: true, reason: "已经登录" });
    for (const text of ["Claude", "商城", "支付修复"]) {
      const origin = f.origin(); const [event] = await f.core.prepareEvents([{ origin, text }]);
      const receipt = f.core.receive(origin, text, event?.rejection);
      if (receipt.jobId) await f.core.run(receipt.jobId);
    }
    assert.equal(f.calls(), 1); assert.equal(f.sends[0]?.session.nativeId, "claude-old");
  } finally { f.close(); }
});

test("a failed catalog refresh is identified separately and cannot authorize a cached destination", async () => {
  const f = fixture();
  try {
    await f.send("原任务"); await f.send("手动选择目标"); await f.send("Claude"); await f.send("商城");
    f.adapters.claude!.listSessions = async () => { throw new Error("catalog unavailable"); };
    const origin = f.origin(); const [event] = await f.core.prepareEvents([{ origin, text: "支付修复" }]);
    const receipt = f.core.receive(origin, "支付修复", event?.rejection); if (receipt.jobId) await f.core.run(receipt.jobId);
    assert.match(f.message(), /目录.*不可用|无法读取.*会话/);
    assert.equal(f.calls(), 1); assert.equal(f.sends.length, 0);
  } finally { f.close(); }
});

test("a native route confirmation leaves its resulting catalog menu usable", async () => {
  const f = fixture();
  try {
    f.core.setRoutingSettings({ mode: "confirm" }); f.decide(async () => answer("list_sessions_claude"));
    const original = await f.send("看看 Claude 的会话");
    f.core.resolveRouting(original.jobId!, 1, f.origin("desktop"));
    await f.send("支付修复");
    assert.equal(f.calls(), 1); assert.equal(f.sends.length, 0);
    assert.equal(f.core.state().selection.agent, "claude");
  } finally { f.close(); }
});

test("an invalid native timestamp cannot bypass fallback handling", async () => {
  const f = fixture();
  try {
    f.adapters.claude!.listSessions = async () => [{ nativeId: "bad-date", title: "旧会话", projectId: null, updatedAt: Infinity }];
    // JSON persistence turns Infinity into null; a finite value outside Date's range is retained.
    f.adapters.codex!.listSessions = async () => [{ nativeId: "bad-date", title: "旧会话", projectId: null, updatedAt: 9e15 }];
    await f.send("继续旧任务");
    assert.match(f.message(), /手动选择目标/); assert.equal(f.sends.length, 0);
  } finally { f.close(); }
});

test("retargeting queued work respects the new agent queue and updates its receipt", async () => {
  const f = fixture(); const releases = new Map<string, () => void>(), runs: Promise<unknown>[] = [];
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));
  const until = async (check: () => boolean) => { for (let count = 0; count < 100 && !check(); count++) await tick(); assert.ok(check()); };
  try {
    for (const agent of ["codex", "claude"]) {
      const send = f.adapters[agent]!.sendTurn;
      f.adapters[agent]!.sendTurn = async (session, text, id, hooks) => {
        const result = await send(session, text, id, hooks);
        if (text !== "排队任务") await new Promise<void>(resolve => releases.set(agent, resolve));
        return result;
      };
    }
    f.decide(async context => answer(context.text === "Claude 前置任务" ? "new_claude_none" : "new_codex_none"));
    const first = f.receive("Codex 前置任务"); runs.push(f.core.run(first.jobId!)); await until(() => releases.has("codex"));
    const second = f.receive("Claude 前置任务"); runs.push(f.core.run(second.jobId!)); await until(() => releases.has("claude"));
    const queued = f.receive("排队任务"); runs.push(f.core.run(queued.jobId!));
    await until(() => f.core.outbox().some(e => e.jobId === queued.jobId && e.kind === "receipt"));
    await f.send("选错了"); await f.send("03"); await f.send("手动选择目标"); await f.send("Claude"); await f.send("商城");
    runs.push(f.send("支付修复"));
    releases.get("codex")!(); await runs[0];
    for (let count = 0; count < 10; count++) await tick();
    assert.equal(f.sends.filter(s => s.text === "排队任务").length, 0, "The corrected request must wait for Claude's existing work");
    releases.get("claude")!(); await Promise.all(runs);
    assert.deepEqual(f.sends.filter(s => s.text === "排队任务").map(s => s.agent), ["claude"]);
    const receipt = f.core.outbox().filter(e => e.jobId === queued.jobId && e.kind === "receipt" && e.status !== "cancelled").at(-1);
    assert.match(receipt?.text ?? "", /Claude > 商城 > 支付修复\n已收到✅/);
  } finally { for (const release of releases.values()) release(); await Promise.allSettled(runs); f.close(); }
});

test("an unselected empty destination is never offered as the current conversation after failure", async () => {
  const f = fixture();
  try {
    await f.send("开始一个新任务");
    assert.doesNotMatch(f.message(), /\d{2} 继续：/);
    assert.match(f.message(), /01 手动选择目标/);
  } finally { f.close(); }
});

test("uncertain model rankings cannot offer an unselected empty target as a continuation", async () => {
  const f = fixture();
  try {
    f.decide(async () => ({ choice: "continue", confidence: 0.5, probabilities: { continue: 0.5, clarify: 0.5 } }));
    await f.send("开始一个新任务");
    assert.doesNotMatch(f.message(), /\d{2} 继续：/);
    assert.equal(f.sends.length, 0);
  } finally { f.close(); }
});

test("turning routing off cannot forward an unmatched answer from a pending question", async () => {
  const f = fixture();
  try {
    await f.send("原任务"); f.core.setRoutingSettings({ mode: "off" });
    await f.send("我指的是昨天那个");
    assert.match(f.message(), /选项|编号/);
    assert.equal(f.sends.length, 0); assert.equal(f.core.state().jobs.length, 1);
  } finally { f.close(); }
});

test("all pending tasks remain reachable through local task pagination", async () => {
  const f = fixture();
  try {
    for (let index = 0; index < 10; index++) await f.send("任务 " + index);
    await f.send("01");
    assert.match(f.message(), /任务 0/); assert.match(f.message(), /下一页/);
    await f.send("下一页"); assert.match(f.message(), /任务 9/);
    assert.equal(f.calls(), 10); assert.equal(f.sends.length, 0);
  } finally { f.close(); }
});

test("semantic corrections are destination actions, not execution prompts", async () => {
  const f = fixture();
  try {
    f.decide(async () => answer("new_codex_none")); const original = await f.send("原任务");
    f.decide(async (_context, actions) => {
      const action = actions.find(a => a.id === "correct_" + original.jobId);
      assert.ok(action); return answer(action.id);
    });
    await f.send("刚才这条应该去 Claude 的商城会话，你发错地方了");
    assert.match(f.message(), /已经完成|已经发送/);
    assert.match(f.message(), /为后续消息选择其他目标/);
    assert.equal(f.sends.length, 1);
  } finally { f.close(); }
});

test("a wobbling flat choice defers to a task intent instead of asking", async () => {
  const f = fixture();
  try {
    await f.ready();
    const existing = f.core.state().sessions.find(s => s.nativeId === "codex-old")!;
    f.receive("/use " + existing.shortId);
    // Observed: the router leaned toward a status lookup while its task intent said "current work".
    f.decide(async () => ({ choice: "list_status", confidence: 0.35, probabilities: { list_status: 0.36, continue: 0.29, new_codex_none: 0.35 },
      intent: { choice: "current", confidence: 0.38, probabilities: { current: 0.46, navigate: 0.34, new: 0.2 } } }));
    await f.send("原来 ChatBridge 下边的那个余烬远征项目删除了吗？存在吗");
    assert.deepEqual(f.sends.map(s => [s.session.nativeId, s.text]), [["codex-old", "原来 ChatBridge 下边的那个余烬远征项目删除了吗？存在吗"]]);
    // Observed again: the lookup led clearly enough to clear its low bar (0.46 vs 0.30) while the intent still said work.
    f.decide(async () => ({ choice: "list_status", confidence: 0.36, probabilities: { list_status: 0.46, continue: 0.3, new_codex_none: 0.24 },
      intent: { choice: "current", confidence: 0.36, probabilities: { current: 0.45, navigate: 0.35, new: 0.2 } } }));
    await f.send("那个项目现在还存在吗");
    assert.equal(f.sends.at(-1)?.text, "那个项目现在还存在吗", "a task intent is answered by the agent, not with a status list");
    f.decide(async () => ({ choice: "list_status", confidence: 0.35, probabilities: { list_status: 0.4, continue: 0.3, new_codex_none: 0.3 },
      intent: { choice: "navigate", confidence: 0.4, probabilities: { navigate: 0.5, current: 0.5 } } }));
    await f.send("现在是什么状态");
    assert.equal(f.sends.length, 2, "an uncertain navigation question still asks rather than sending");
  } finally { f.close(); }
});
