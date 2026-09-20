import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RPCPeer } from "../src/rpc.js";
import { createService } from "../src/service.js";
import { agentIDs, BridgeCore, BridgeError, type AgentAdapter, type Origin } from "../src/core.js";
import { defaultRoutingSettings, JevGateway, routeActions } from "../src/routing.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "bridge-smart-routing-"));
  const database = join(directory, "bridge.sqlite"), ab = new PassThrough(), ba = new PassThrough();
  let secret: { apiKey: string } | null = null, status = 200, sequence = 0;
  let decide = (_body: any): any => ({ choice: "continue", confidence: 1, probabilities: { continue: 1 } });
  let gate: Promise<void> | undefined;
  const requests: any[] = [], sends: { agent: string; nativeId: string; projectId: string | null; text: string }[] = [];
  const native = new RPCPeer(ba, ab, {
    "native.vercel.credential.read": () => secret,
    "native.vercel.credential.write": (value: any) => { secret = value.credential; return null; },
    "native.vercel.credential.remove": () => { secret = null; return null; },
  });
  const adapters = Object.fromEntries(agentIDs.map((agent) => [agent, {
    probe: async () => ({ ready: true, reason: "Fixture" }),
    listProjects: async () => [{ id: "project-" + agent, name: "商城", roots: ["/fixtures/shop/" + agent] }],
    listSessions: async () => [{ nativeId: "existing-" + agent, title: "微信断连", projectId: "project-" + agent }],
    createSession: async (target: any) => ({ nativeId: "new-" + ++sequence, title: "New", projectId: target.projectId }),
    resumeSession: async (session: any) => session,
    sendTurn: async (session: any, text: string) => {
      sends.push({ agent, nativeId: session.nativeId, projectId: session.projectId, text });
      return { turnId: "turn-" + sends.length, text: "完成" };
    },
  } satisfies AgentAdapter]));
  const service = createService(ab, ba, database, {
    codex: adapters.codex, claude: adapters.claude, agents: adapters,
    routingNow: () => Date.parse("2026-09-20T00:00:00+08:00"),
    fetchFn: async (url, init) => {
      assert.equal(String(url), "https://ai-gateway.vercel.sh/typesafe/v1/systemone");
      assert.equal(init?.redirect, "error");
      assert.match(new Headers(init?.headers).get("authorization") ?? "", /^Bearer fixture-/);
      const body = JSON.parse(String(init?.body)); requests.push(body);
      if (gate && body.questions.route) await gate;
      if (status !== 200) return new Response("upstream echoed fixture-secret-do-not-log", { status });
      const question = body.questions.route ? "route" : "connection";
      const answer = question === "route" ? decide(body) : { choice: "ok", confidence: 1, probabilities: { ok: 1, other: 0 } };
      const intent = answer.choice.startsWith("answer_") ? "answer" : /^(stop|cancel|retry)_/.test(answer.choice) ? "control" :
        answer.choice === "continue" ? "current" : answer.choice.startsWith("new_") ? "new" :
        answer.choice.startsWith("resume_") ? "resume" : answer.choice === "clarify" ? "clarify" : "navigate";
      return Response.json({ model: "typesafe-ai/jev", answers: { [question]: { type: "choice", ...answer },
        ...(body.questions.intent ? { intent: { type: "choice", choice: intent, confidence: answer.confidence, probabilities: { [intent]: 1 } } } : {}) } });
    },
  });
  const origin = (eventId: string): Origin => ({ kind: "desktop", accountId: "local", peerId: "local", eventId });
  async function enable(mode = "auto") {
    await native.call("routing.key.save", { apiKey: "fixture-secret-do-not-log" });
    await native.call("routing.configure", { mode });
  }
  async function send(text: string, id = "event-" + ++sequence) {
    const receipt = service.core.receive(origin(id), text);
    if (receipt.jobId) await service.core.run(receipt.jobId);
    return receipt;
  }
  return { native, service, database, adapters, requests, sends, origin, enable, send,
    secret: () => secret, status: (value: number) => { status = value; },
    decide: (value: typeof decide) => { decide = value; }, gate: (value: Promise<void>) => { gate = value; },
    close() { service.close(); native.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test("Vercel settings start disabled and save only a validated key in the native vault", async () => {
  const f = fixture();
  try {
    const initial = await f.native.call<any>("routing.get");
    assert.equal(initial.mode, "off"); assert.equal(initial.configured, false);
    await f.native.call("routing.key.save", { apiKey: "  fixture-secret-do-not-log  " });
    assert.deepEqual(f.secret(), { apiKey: "fixture-secret-do-not-log" });
    const state = await f.native.call<any>("state.get");
    assert.equal(state.routing.configured, true); assert.equal(state.routing.mode, "off");
    assert.equal(JSON.stringify(state).includes("fixture-secret"), false);
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(f.database + suffix)) assert.equal(readFileSync(f.database + suffix).includes(Buffer.from("fixture-secret")), false);
    }
    await f.native.call("routing.key.remove");
    assert.equal(f.secret(), null);
    assert.equal((await f.native.call<any>("routing.get")).mode, "off");
  } finally { f.close(); }
});

test("failed validation never overwrites the working key or exposes upstream bodies", async () => {
  const f = fixture();
  try {
    await f.enable(); f.status(401);
    await assert.rejects(f.native.call("routing.key.save", { apiKey: "fixture-replacement" }), (error: any) => {
      assert.equal(error.message.includes("fixture-"), false); return true;
    });
    assert.deepEqual(f.secret(), { apiKey: "fixture-secret-do-not-log" });
    await assert.rejects(f.native.call("routing.key.save", { apiKey: "fixture-key\ninvalid" }), { code: "INVALID_INPUT" });
    await assert.rejects(f.native.call("routing.configure", { mode: "auto", endpoint: "https://example.com" }), { code: "INVALID_INPUT" });
  } finally { f.close(); }
});

test("gateway validation distinguishes key, verification, free-tier and budget failures without exposing response text", async (t) => {
  const cases = [
    { status: 401, body: { error: { type: "authentication_error" } }, expected: /Key.*401/ },
    { status: 403, body: { error: { type: "customer_verification_required" } }, expected: /验证付款方式.*403/ },
    { status: 403, body: { error_type: "customer_verification_required" }, expected: /验证付款方式.*403/ },
    { status: 403, body: { error: { type: "no_providers_available", message: "Free tier users do not have access to this model" } }, expected: /免费套餐.*403/ },
    { status: 403, body: { error_type: "access_denied" }, expected: /403.*access_denied/ },
    { status: 403, body: { error: { type: "unknown" } }, expected: /403/ },
    { status: 402, body: { error: { type: "quota_for_entity_exceeded" } }, expected: /预算.*402/ },
    { status: 402, body: { error_type: "insufficient_credits" }, expected: /额度不足.*402/ },
  ];
  for (const [index, value] of cases.entries()) await t.test(String(index), async () => {
    let writes = 0;
    const gateway = new JevGateway({ read: async () => null, write: async () => { writes++; }, remove: async () => {} },
      async () => Response.json({ ...value.body, detail: "fixture-secret-do-not-log", url: "https://untrusted.example/key" }, { status: value.status }),
      () => Date.parse("2026-09-20T00:00:00+08:00"));
    await assert.rejects(gateway.save("fixture-secret-do-not-log"), (error: any) => {
      assert.match(error.message, value.expected);
      assert.doesNotMatch(error.message, /fixture-secret|untrusted\.example/);
      return true;
    });
    assert.equal(writes, 0);
    assert.equal(gateway.status().configured, false);
  });
});

test("invalid or oversized gateway errors retain the HTTP diagnosis without echoing their body", async (t) => {
  for (const body of ["fixture-secret-not-json", JSON.stringify({ message: "fixture-secret-".repeat(2000) })]) {
    await t.test(String(body.length), async () => {
      const gateway = new JevGateway({ read: async () => null, write: async () => {}, remove: async () => {} },
        async () => new Response(body, { status: 403 }), () => Date.parse("2026-09-20T00:00:00+08:00"));
      await assert.rejects(gateway.save("fixture-key"), (error: any) => {
        assert.match(error.message, /403/);
        assert.doesNotMatch(error.message, /fixture-secret/);
        return true;
      });
    });
  }
});

test("natural-language projectless creation and ten continuations keep one native session", async () => {
  const f = fixture();
  try {
    await f.service.core.refreshCatalog("codex");
    const session = f.service.core.state().sessions[0]!;
    await f.send("/use " + session.shortId);
    await f.enable();
    f.decide(() => ({ choice: "new_claude_none", confidence: 1, probabilities: { new_claude_none: 1 } }));
    await f.send("退出项目，新聊一个问题：帮我写封邮件");
    f.decide(() => ({ choice: "continue", confidence: 1, probabilities: { continue: 1 } }));
    for (let index = 0; index < 10; index++) await f.send(index % 2 ? "好，现在实现" : "继续，先分析风险");
    assert.equal(f.sends.length, 11);
    assert.equal(new Set(f.sends.map((send) => send.nativeId)).size, 1);
    assert.ok(f.sends.every((send) => send.agent === "claude" && send.projectId === null));
    assert.equal(f.service.core.state().selection.projectId, null);
  } finally { f.close(); }
});

test("channel prompts receive the resolved destination before the AI answer, without IDs or menus", async (t) => {
  for (const kind of ["imessage", "weixin"] as const) await t.test(kind, async () => {
    const f = fixture();
    try {
      await f.enable(); f.service.core.bindChannel(kind, "bot", "owner");
      f.decide(() => ({ choice: "new_codex_none", confidence: 1, probabilities: { new_codex_none: 1 } }));
      const origin: Origin = { kind, accountId: "bot", peerId: "owner", eventId: "new-task" };
      const receipt = f.service.core.receive(origin, "用 Codex 新开无项目会话，记住蓝鲸七号，只回复记住了。");
      const replies = () => f.service.core.outbox().filter((entry) => entry.jobId === receipt.jobId);
      assert.deepEqual(replies(), [], "Do not acknowledge an unresolved destination with an internal job ID");
      const sendTurn = f.adapters.codex!.sendTurn;
      f.adapters.codex!.sendTurn = async (session, text) => {
        assert.deepEqual(replies().map(({ kind, text }) => ({ kind, text })),
          [{ kind: "receipt", text: "Codex > 无项目 > New\n已收到✅" }]);
        return sendTurn(session, text);
      };
      await f.service.core.run(receipt.jobId!);
      assert.deepEqual(replies().map(({ kind, text }) => ({ kind, text })), [
        { kind: "receipt", text: "Codex > 无项目 > New\n已收到✅" }, { kind: "final", text: "完成" },
      ]);
      assert.ok(replies().every((entry) => entry.origin.kind === kind));
      assert.deepEqual(f.service.core.receive(origin, "重复事件"), receipt);
      await f.service.core.run(receipt.jobId!);
      assert.equal(replies().length, 2); assert.equal(f.sends.length, 1);
    } finally { f.close(); }
  });
});

test("a continuation receipt uses the actual project and session names", async () => {
  const f = fixture();
  try {
    await f.service.core.refreshCatalog("codex");
    const session = f.service.core.state().sessions[0]!;
    await f.send("/use " + session.shortId);
    await f.enable(); f.service.core.bindChannel("weixin", "bot", "owner");
    const receipt = f.service.core.receive({ kind: "weixin", accountId: "bot", peerId: "owner", eventId: "follow-up" }, "继续刚才的问题");
    await f.service.core.run(receipt.jobId!);
    assert.deepEqual(f.service.core.outbox().filter((entry) => entry.jobId === receipt.jobId).map((entry) => entry.text),
      ["Codex > 商城 > 微信断连\n已收到✅", "完成"]);
    assert.equal(f.sends[0]?.nativeId, session.nativeId);
  } finally { f.close(); }
});

test("an ambiguous route asks in natural language and preserves the prompt when the user clarifies", async () => {
  const f = fixture();
  try {
    await f.enable(); f.service.core.bindChannel("weixin", "bot", "owner");
    f.decide(() => ({ choice: "new_claude_none", confidence: 0.4, probabilities: { new_claude_none: 0.6, continue: 0.4 } }));
    const origin: Origin = { kind: "weixin", accountId: "bot", peerId: "owner", eventId: "ambiguous" };
    const receipt = f.service.core.receive(origin, "帮我规划下一步");
    await f.service.core.run(receipt.jobId!);
    const replies = () => f.service.core.outbox().filter((entry) => entry.jobId === receipt.jobId);
    assert.equal(f.sends.length, 0); assert.equal(replies().length, 1);
    assert.match(replies()[0]!.text, /回复编号或选项文字/);
    assert.doesNotMatch(replies()[0]!.text, /J[0-9a-f]{12}|\/continue|更新时间/);
    const question = f.service.core.state().jobs.find(job => job.id === receipt.jobId)!.error;
    f.decide((body) => {
      const choice = body.state.message === "用 Claude 开新会话做规划" ? "answer_" + receipt.jobId : "new_claude_none";
      return { choice, confidence: 1, probabilities: { [choice]: 1 } };
    });
    const clarified = f.service.core.receive({ ...origin, eventId: "clarified" }, "用 Claude 开新会话做规划");
    assert.notEqual(clarified.jobId, receipt.jobId);
    assert.equal(replies().length, 1, "Do not insert another acknowledgement before the resolved destination");
    await f.service.core.run(clarified.jobId!);
    assert.equal(f.sends[0]?.text, "帮我规划下一步\n\n路由询问：" + question + "\n补充目标信息：用 Claude 开新会话做规划");
    assert.deepEqual(replies().slice(1).map((entry) => entry.text), ["Claude > 无项目 > New\n已收到✅", "完成"]);
  } finally { f.close(); }
});

test("session preparation failures never claim the destination has received the prompt", async () => {
  const f = fixture();
  try {
    await f.enable(); f.service.core.bindChannel("weixin", "bot", "owner");
    f.adapters.codex!.createSession = async () => { throw new BridgeError("AGENT_UNAVAILABLE", "暂时无法创建会话。"); };
    const receipt = f.service.core.receive({ kind: "weixin", accountId: "bot", peerId: "owner", eventId: "unavailable" }, "回答一个问题");
    await f.service.core.run(receipt.jobId!);
    const replies = f.service.core.outbox().filter((entry) => entry.jobId === receipt.jobId);
    assert.equal(f.sends.length, 0);
    assert.equal(replies.some((entry) => entry.kind === "receipt"), false);
    assert.match(replies.at(-1)!.text, /任务未发送/);
  } finally { f.close(); }
});

test("navigation changes the target without forwarding the navigation sentence", async () => {
  const f = fixture();
  try {
    await f.enable();
    f.decide(() => ({ choice: "switch_claude", confidence: 1, probabilities: { switch_claude: 1 } }));
    await f.send("切到 Claude");
    assert.equal(f.service.core.state().selection.agent, "claude");
    assert.equal(f.sends.length, 0);
  } finally { f.close(); }
});

test("escaped slash content bypasses semantic routing and stays in the selected session", async () => {
  const f = fixture();
  try {
    await f.enable();
    f.decide(() => ({ choice: "switch_claude", confidence: 1, probabilities: { switch_claude: 1 } }));
    await f.send("//agent claude");
    assert.equal(f.sends[0]?.text, "/agent claude");
    assert.equal(f.sends[0]?.agent, "codex");
    assert.equal(f.requests.some((request) => request.questions.route), false);
  } finally { f.close(); }
});

test("a low-confidence decision keeps the original prompt until an explicit choice", async () => {
  const f = fixture();
  try {
    await f.enable();
    f.decide(() => ({ choice: "new_claude_none", confidence: 0.4, probabilities: { new_claude_none: 0.6, continue: 0.4 } }));
    const receipt = await f.send("帮我规划下一步", "original");
    assert.equal(f.sends.length, 0);
    assert.equal(f.service.core.state().jobs[0]?.status, "awaiting_route");
    assert.deepEqual((f.service.core.state().jobs[0] as any).routingDecision,
      { provider: "vercel", choice: "new_claude_none", confidence: 0.4, probability: 0.6, margin: 0.6 - 0.4,
        intent: { choice: "new", confidence: 0.4, probability: 1 } });
    await f.send("1", "choice");
    assert.equal(f.sends[0]?.text, "帮我规划下一步");
    assert.equal(f.sends[0]?.agent, "claude");
    await f.send("1", "choice");
    await f.send("帮我规划下一步", "original");
    assert.equal(f.sends.length, 1);
    assert.equal(f.service.core.state().jobs.find((job) => job.id === receipt.jobId)?.status, "completed");
  } finally { f.close(); }
});

test("a late inference cannot overwrite a manual selection or send its prompt", async () => {
  const f = fixture();
  let release!: () => void;
  try {
    await f.enable(); f.gate(new Promise<void>((resolve) => { release = resolve; }));
    const receipt = f.service.core.receive(f.origin("late"), "帮我做规划");
    const run = f.service.core.run(receipt.jobId!);
    for (let i = 0; i < 100 && !f.requests.some((body) => body.questions.route); i++) await new Promise((resolve) => setImmediate(resolve));
    f.service.core.receive(f.origin("manual"), "/agent cursor");
    release(); await run;
    assert.equal(f.service.core.state().selection.agent, "cursor");
    assert.equal(f.sends.length, 0);
    assert.equal(f.service.core.state().jobs[0]?.status, "awaiting_route");
  } finally { release?.(); f.close(); }
});

test("reopening the current session does not invalidate a pending follow-up", async (t) => {
  for (const entry of ["avatar", "session-picker"]) await t.test(entry, async () => {
    const f = fixture(); let release!: () => void;
    try {
      await f.send("先给出卡牌游戏方案"); await f.enable();
      const selected = f.service.core.state().selection;
      const session = f.service.core.state().sessions.find((session) => session.id === selected.sessionId)!;
      f.gate(new Promise<void>((resolve) => { release = resolve; }));
      const receipt = f.service.core.receive(f.origin("clarification"), "是，指卡牌递进");
      const running = f.service.core.run(receipt.jobId!);
      for (let i = 0; i < 100 && !f.requests.some((body) => body.questions.route); i++) await new Promise((resolve) => setImmediate(resolve));
      if (entry === "avatar") await f.service.core.openAgent("codex");
      else await f.send("/use " + session.shortId);
      release(); await running;
      assert.equal(f.service.core.state().jobs.find((job) => job.id === receipt.jobId)?.status, "completed");
      assert.deepEqual(f.service.core.state().selection, selected);
      assert.equal(f.sends[1]?.nativeId, session.nativeId);
      assert.equal(f.sends[1]?.text, "是，指卡牌递进");
    } finally { release?.(); f.close(); }
  });
});

test("opening the current agent preserves an unanswered routing clarification", async () => {
  const f = fixture();
  try {
    await f.send("先讨论游戏方案"); await f.enable("confirm");
    const receipt = await f.send("帮我规划下一步");
    const selected = f.service.core.state().selection;
    await f.service.core.openAgent("codex");
    assert.equal(f.service.core.state().jobs.find((job) => job.id === receipt.jobId)?.status, "awaiting_route");
    assert.deepEqual(f.service.core.state().selection, selected);
  } finally { f.close(); }
});

test("reopening the current agent supersedes an unfinished navigation to another agent", async () => {
  const f = fixture(); let release!: () => void;
  try {
    await f.send("继续当前任务");
    const selected = f.service.core.state().selection;
    let started!: () => void;
    const catalogStarted = new Promise<void>((resolve) => { started = resolve; });
    f.adapters.claude!.listSessions = async () => { started(); await new Promise<void>((resolve) => { release = resolve; }); return []; };
    const other = f.service.core.openAgent("claude");
    await catalogStarted;
    await f.service.core.openAgent("codex");
    release(); await other;
    assert.deepEqual(f.service.core.state().selection, selected);
  } finally { release?.(); f.close(); }
});

test("provider failure preserves the request instead of forwarding to the old session", async () => {
  const f = fixture();
  try {
    await f.enable(); f.status(429);
    await f.send("在另一个项目修复支付");
    assert.equal(f.sends.length, 0);
    const job = f.service.core.state().jobs[0]!;
    assert.equal(job.status, "awaiting_route");
    assert.equal(job.text, "在另一个项目修复支付");
    assert.equal(JSON.stringify(f.service.core.state()).includes("fixture-secret"), false);
  } finally { f.close(); }
});

test("a manual project menu preserves the previous pending task without dispatching it", async () => {
  const f = fixture();
  try {
    await f.enable("confirm");
    const original = await f.send("修复问题");
    await f.send("/projects");
    await f.send("1");
    assert.equal(f.sends.length, 0, "A project menu answer must never dispatch the old routing option");
    assert.equal(f.service.core.state().selection.projectId, "project-codex");
    assert.equal(f.service.core.state().jobs.find((job) => job.id === original.jobId)?.status, "awaiting_route");
  } finally { f.close(); }
});

test("route candidates use native seconds timestamps and exclude agents with execution errors", () => {
  const actions = routeActions({ text: "继续昨天微信断连的任务", current: { agent: "codex", mode: "code", projectId: null },
    active: {}, history: [], defaultAgent: "codex", settings: defaultRoutingSettings, projects: [],
    probes: { codex: { ready: true, reason: "" }, opencode: { ready: true, reason: "", executionError: "Model unavailable" } },
    sessions: [{ id: "session", shortId: "S1", nativeId: "native", title: "微信断连", agent: "codex", mode: "code",
      projectId: null, updatedAt: Date.parse("2026-09-19T02:00:00Z") / 1000 }] });
  assert.match(actions.find((action) => action.id === "resume_S1")!.label, /2026-09-19/);
  assert.equal(actions.some((action) => action.id === "new_opencode_none"), false);
});

test("the current session has one send candidate while other sessions with the same title remain selectable", () => {
  const current = { agent: "codex", mode: "code", projectId: null, sessionId: "current" };
  const actions = routeActions({ text: "刚才的暗号是什么？只回复暗号，不操作文件。", current,
    active: { codex: current }, history: [], defaultAgent: "codex", settings: defaultRoutingSettings, projects: [],
    probes: { codex: { ready: true, reason: "" } },
    sessions: ["current", "other"].map((id) => ({ ...current, id, shortId: "S-" + id, nativeId: "native-" + id, title: "记住暗号" })) });
  const continuation = actions.filter((action) => action.kind === "send" && action.target?.sessionId === current.sessionId);
  assert.equal(continuation.length, 1, "Continuing and resuming the same session must not compete for routing probability");
  assert.equal(continuation[0]?.id, "continue");
  assert.ok(actions.some((action) => action.kind === "send" && action.target?.sessionId === "other"));
  assert.ok(actions.some((action) => action.kind === "select" && action.target?.sessionId === current.sessionId),
    "Navigation without sending remains a separate action");
});

test("the gateway distinguishes replying from navigation even when target labels are identical", async () => {
  const criteria: Record<string, any>[] = [];
  let rules: Record<string, any> = {};
  const gateway = new JevGateway({ read: async () => ({ apiKey: "fixture-key" }), write: async () => {}, remove: async () => {} },
    async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      criteria.push(body.questions.route.criteria);
      rules = body.state.actionRules;
      return Response.json({ answers: { route: { type: "choice", choice: "reply", confidence: 1, probabilities: { reply: 1 } },
        intent: { type: "choice", choice: "resume", confidence: 1, probabilities: { resume: 1 } } } });
    }, () => Date.parse("2026-09-20T00:00:00+08:00"));
  const current = { agent: "codex", mode: "code", projectId: null, sessionId: "current" };
  await gateway.choose({ text: "刚才的暗号是什么？只回复暗号，不操作文件。", current,
    active: {}, history: [], defaultAgent: "codex", settings: defaultRoutingSettings, projects: [], sessions: [], probes: {} },
  [{ id: "reply", kind: "send", target: current, label: "Codex · 无项目 · 当前会话" },
    { id: "navigate", kind: "select", target: current, label: "Codex · 无项目 · 当前会话" }]);
  assert.notEqual(criteria[0]?.reply, criteria[0]?.navigate, "The model must receive the different action semantics, not just the destination label");
  assert.equal(criteria[0]!.reply!.action, "send");
  assert.equal(criteria[0]!.navigate!.action, "select");
  assert.ok(rules[criteria[0]!.navigate!.rules].not_for, "Navigation must explicitly exclude messages that also contain an executable task");
});

test("the routing model receives independent-new-task criteria and the current conversation identity", async () => {
  const f = fixture();
  try {
    await f.send("记住蓝鲸七号");
    const current = f.service.core.state().selection;
    await f.enable();
    const prompt = "使用 Codex 开一个无项目的新会话，写请假邮件";
    f.decide((body) => {
      assert.equal(body.state.current.session.id, current.sessionId);
      assert.equal(body.state.current.agent, "codex");
      assert.equal(body.state.message, prompt);
      assert.ok(body.state.history.some((message: any) => message.text === "记住蓝鲸七号"));
      const options = body.questions.route.criteria;
      assert.equal(options.continue.operation, "continue_task");
      assert.equal(options.new_codex_none.operation, "new_task");
      assert.match(body.state.actionRules[options.continue.rules].not_for, /independent|new project/i);
      assert.match(body.state.actionRules[options.new_codex_none.rules].when, /projectless/i);
      return { choice: "new_codex_none", confidence: 1, probabilities: { new_codex_none: 1 } };
    });
    const receipt = await f.send(prompt);
    assert.equal(f.service.core.state().jobs.find((job) => job.id === receipt.jobId)?.status, "completed");
    assert.notEqual(f.sends[0]?.nativeId, f.sends[1]?.nativeId);
  } finally { f.close(); }
});

test("new-task intent excludes the old conversation even when a flat route prefers continuing it", async () => {
  const requests: any[] = [];
  const gateway = new JevGateway({ read: async () => ({ apiKey: "fixture-key" }), write: async () => {}, remove: async () => {} },
    async (_url, init) => {
      const body = JSON.parse(String(init?.body)); requests.push(body);
      const route = body.questions.intent ? { choice: "continue", confidence: 0.76, probabilities: { continue: 0.77, new_codex_none: 0.23 } } :
        { choice: "new_codex_none", confidence: 1, probabilities: { new_codex_none: 1 } };
      return Response.json({ answers: { route: { type: "choice", ...route },
        intent: { type: "choice", choice: "new", confidence: 1, probabilities: { new: 1 } } } });
    }, () => Date.parse("2026-09-20T00:00:00+08:00"));
  const current = { agent: "codex", mode: "code", projectId: null, sessionId: "whale" };
  const context = { text: "使用 codex 新开无项目会话，写一封请假邮件", current, active: { codex: current },
    history: [{ role: "user", text: "记住蓝鲸七号" }, { role: "assistant", text: "记住了" }],
    defaultAgent: "codex", settings: defaultRoutingSettings, projects: [],
    sessions: [{ ...current, id: "whale", shortId: "S-whale", nativeId: "native-whale", title: "记住暗号" }],
    probes: { codex: { ready: true, reason: "" } } };
  const answer = await gateway.choose(context, routeActions(context));
  assert.equal(requests.length, 2, "Resolve a conflicting destination against the independently classified intent");
  assert.deepEqual(Object.keys(requests[1].questions.route.criteria).sort(), ["clarify", "new_codex_none"]);
  assert.equal(answer.choice, "new_codex_none");
});

test("a create-project intent excludes projectless chats before resolving an uncertain destination", async () => {
  const requests: any[] = [];
  const gateway = new JevGateway({ read: async () => ({ apiKey: "fixture-key" }), write: async () => {}, remove: async () => {} },
    async (_url, init) => {
      const body = JSON.parse(String(init?.body)); requests.push(body);
      const route = body.questions.intent ? { choice: "new_project_codex", confidence: 0.78,
        probabilities: { new_project_codex: 0.89, new_codex_none: 0.11 } } :
        { choice: "new_project_codex", confidence: 1, probabilities: { new_project_codex: 1 } };
      return Response.json({ answers: { route: { type: "choice", ...route },
        intent: { type: "choice", choice: "project", confidence: 1, probabilities: { project: 1 } } } });
    }, () => Date.parse("2026-09-20T00:00:00+08:00"));
  const current = { agent: "codex", mode: "code", projectId: null, sessionId: "old" };
  const context = { text: "使用codex创建一个项目，先设计Godot卡牌游戏", current, active: { codex: current },
    history: [], defaultAgent: "codex", settings: defaultRoutingSettings, projects: [], sessions: [],
    projectCreationAgents: ["codex"], probes: { codex: { ready: true, reason: "" } } };
  const answer = await gateway.choose(context, routeActions(context));
  assert.equal(requests.length, 2);
  assert.deepEqual(Object.keys(requests[1].questions.route.criteria).sort(), ["clarify", "new_project_codex"]);
  assert.equal(answer.choice, "new_project_codex");
  assert.equal(answer.confidence, 1);
});

test("same-task intent cannot override a destination that requires clarification", async () => {
  const gateway = new JevGateway({ read: async () => ({ apiKey: "fixture-key" }), write: async () => {}, remove: async () => {} },
    async () => Response.json({ answers: {
      route: { type: "choice", choice: "clarify", confidence: 1, probabilities: { clarify: 1 } },
      intent: { type: "choice", choice: "current", confidence: 1, probabilities: { current: 1 } },
    } }), () => Date.parse("2026-09-20T00:00:00+08:00"));
  const current = { agent: "codex", mode: "code", projectId: null, sessionId: "current" };
  const context = { text: "把刚才的任务交给另一个 Agent 接着做", current, active: {}, history: [],
    defaultAgent: "codex", settings: defaultRoutingSettings, projects: [], sessions: [], probes: {} };
  assert.equal((await gateway.choose(context, routeActions(context))).choice, "clarify");
});

test("two rapidly received messages share the new target selected by the first route", async () => {
  const f = fixture();
  try {
    await f.enable();
    f.decide((body) => ({ choice: body.state.message === "规划项目" ? "new_claude_none" : "continue", confidence: 1,
      probabilities: { [body.state.message === "规划项目" ? "new_claude_none" : "continue"]: 1 } }));
    const first = f.service.core.receive(f.origin("first"), "规划项目");
    const second = f.service.core.receive(f.origin("second"), "按第二种方案继续");
    await Promise.all([f.service.core.run(first.jobId!), f.service.core.run(second.jobId!)]);
    assert.equal(f.sends.length, 2); assert.equal(f.sends[0]?.nativeId, f.sends[1]?.nativeId);
    assert.ok(f.sends.every((send) => send.agent === "claude"));
  } finally { f.close(); }
});

test("routed messages and channel cursor survive restart without creating an execution early", async () => {
  const f = fixture();
  let restored: BridgeCore | undefined;
  try {
    await f.enable(); f.service.core.bindChannel("weixin", "bot", "owner");
    const event = { origin: { kind: "weixin" as const, accountId: "bot", peerId: "owner", eventId: "durable" }, text: "继续" };
    f.service.core.ingestBatch("weixin", "bot", "cursor", [event]);
    f.service.close();
    restored = new BridgeCore(f.database, f.adapters);
    assert.equal(restored.checkpoint("weixin", "bot"), "cursor");
    assert.equal(restored.pendingJobs()[0]?.status, "routing");
    assert.equal(f.sends.length, 0);
    restored.routeDecision = async () => ({ choice: "continue", confidence: 1, probabilities: { continue: 1 } });
    const receipt = restored.ingestBatch("weixin", "bot", "cursor2", [event])[0]!;
    await restored.run(receipt.jobId!); await restored.run(receipt.jobId!);
    assert.equal(f.sends.length, 1);
    assert.equal(restored.outbox().filter((entry) => entry.kind === "final")[0]?.origin.kind, "weixin");
  } finally { restored?.close(); f.close(); }
});

test("confirmation mode independently waits for each message and unbinding cancels both", async () => {
  const f = fixture();
  try {
    await f.enable("confirm"); f.service.core.bindChannel("weixin", "bot", "owner");
    const event = (id: string) => ({ origin: { kind: "weixin" as const, accountId: "bot", peerId: "owner", eventId: id }, text: id });
    const receipts = f.service.core.ingestBatch("weixin", "bot", "cursor", [event("first"), event("second")]);
    await f.service.core.run(receipts[0]!.jobId!); await f.service.core.run(receipts[1]!.jobId!);
    assert.equal(f.sends.length, 0); assert.equal(f.service.core.pendingJobs().length, 0);
    f.service.core.unbindChannel("weixin");
    assert.ok(f.service.core.state().jobs.every((job) => job.status === "cancelled"));
  } finally { f.close(); }
});

test("the trial cutoff prevents even a connection test from making a paid request", async () => {
  let calls = 0;
  const gateway = new JevGateway({ read: async () => ({ apiKey: "fixture-key" }), write: async () => {}, remove: async () => {} },
    async () => { calls++; return Response.json({}); }, () => Date.parse("2026-09-25T00:00:00+08:00"));
  await assert.rejects(gateway.test(), /免费试验已到期/); assert.equal(calls, 0);
});

test("invalid provider choices cannot escape the catalog or clear a project", async () => {
  const f = fixture();
  try {
    await f.enable();
    f.decide(() => ({ choice: "invented_target", confidence: 1, probabilities: { invented_target: 1 } }));
    const before = f.service.core.state().selection;
    await f.send("修复支付");
    assert.equal(f.sends.length, 0); assert.deepEqual(f.service.core.state().selection, before);
    assert.equal(f.service.core.state().jobs[0]?.status, "awaiting_route");
  } finally { f.close(); }
});
