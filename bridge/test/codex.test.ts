import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(options: { authenticated?: boolean; early?: boolean; approval?: string; failed?: boolean; hold?: boolean; deferStart?: boolean; earlyEvents?: any[] } = {}) {
  const modulePath = "../src/codex.js";
  const module = await import(modulePath).catch(() => ({}));
  assert.equal(typeof module.CodexRuntime, "function", "Codex App Server adapter must be implemented");
  const directory = mkdtempSync(join(tmpdir(), "bridge-codex-"));
  const input = new PassThrough(), output = new PassThrough();
  const sent: any[] = [], decisions: any[] = [];
  let buffer = "", turns = 0;
  const emit = (value: unknown) => input.write(JSON.stringify(value) + "\n");
  const finish = (id: string, status = "completed") => emit({ method: "turn/completed", params: { threadId: "thread-1",
    turn: { id, status, items: [{ type: "agentMessage", id: "answer", phase: "final_answer", text: "完成" }] } } });
  output.on("data", (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); sent.push(message);
      if (!message.method) { decisions.push(message); finish("turn-1"); continue; }
      const respond = (result: unknown) => emit({ id: message.id, result });
      if (message.method === "initialize") respond({ userAgent: "fixture" });
      if (message.method === "account/read") respond({ requiresOpenaiAuth: true, account: options.authenticated === false ? null : { type: "chatgpt" } });
      if (["thread/start", "thread/resume"].includes(message.method)) respond({ thread: { id: "thread-1", cwd: directory }, cwd: directory });
      if (message.method === "turn/start") {
        const id = "turn-" + ++turns;
        emit({ method: "item/completed", params: { threadId: "unrelated", turnId: id,
          item: { id: "foreign", type: "agentMessage", text: "must not appear" } } });
        emit({ method: "item/completed", params: { threadId: "thread-1", turnId: id,
          item: { id: "reason", type: "reasoning", text: "must not appear" } } });
        for (const event of options.earlyEvents ?? []) emit(event);
        if (options.early) finish(id);
        respond({ turn: { id, status: "inProgress", items: [] } });
        if (!options.deferStart) emit({ method: "turn/started", params: { threadId: "thread-1", turn: { id, status: "inProgress" } } });
        if (options.approval) emit({ id: "server-approval", method: options.approval, params: {
          threadId: "thread-1", turnId: id, itemId: "command", command: "echo fixture", reason: "test", cwd: directory } });
        else if (!options.early && !options.hold) finish(id, options.failed ? "failed" : "completed");
      }
      if (message.method === "turn/interrupt") { respond({}); finish(message.params.turnId, "interrupted"); }
    }
  });
  const runtime = new module.CodexRuntime({ workspace: directory,
    locate: async () => ({ installed: true, executablePath: "/fixture/codex", version: "fixture" }),
    connect: () => ({ input, output, close: () => input.end() }) });
  return { runtime, sent, decisions, input, emit, finish, directory,
    close() { runtime.close(); input.destroy(); output.destroy(); rmSync(directory, { recursive: true, force: true }); } };
}

test("Codex initializes the official runtime and requires an authenticated account", async () => {
  const f = await fixture({ authenticated: false });
  try {
    const probe = await f.runtime.probe();
    assert.equal(probe.ready, false);
    assert.equal(probe.status, "needs_login");
    assert.deepEqual(f.sent.map((m) => m.method), ["initialize", "initialized", "account/read"]);
    assert.equal(f.sent.some((m) => m.method === "thread/start"), false);
  } finally { f.close(); }
});

test("Codex streams public commentary and answers in place, excluding reasoning, tools and unrelated turns", async () => {
  const f = await fixture({ hold: true });
  try {
    await f.runtime.probe();
    const session = await f.runtime.createSession({ agent: "codex", mode: "code", projectId: null }, "key");
    const updates: any[] = [], ready = signal();
    const turn = f.runtime.sendTurn(session, "task", "J1", { started: ready.resolve, message: (value: any) => updates.push(value) });
    await ready.promise;
    const event = (method: string, params: any) => f.emit({ method, params: { threadId: "thread-1", turnId: "turn-1", ...params } });
    event("item/started", { item: { id: "progress", type: "agentMessage", phase: "commentary", text: "" } });
    event("item/agentMessage/delta", { itemId: "progress", delta: "正在" });
    event("item/agentMessage/delta", { itemId: "progress", delta: "检查。" });
    assert.equal(updates.at(-1)?.text, "正在检查。", "body text must arrive before turn completion");
    event("item/completed", { item: { id: "progress", type: "agentMessage", phase: "commentary", text: "正在检查代码。" } });
    event("item/agentMessage/delta", { itemId: "progress", delta: "late duplicate" });
    for (const type of ["reasoning", "commandExecution", "mcpToolCall"]) event("item/completed", { item: { id: type, type, text: "private" } });
    event("item/reasoning/textDelta", { itemId: "private", delta: "private" });
    event("item/commandExecution/outputDelta", { itemId: "tool", delta: "private" });
    event("item/agentMessage/delta", { itemId: "foreign", delta: "private", turnId: "another-turn" });
    event("item/agentMessage/delta", { itemId: "foreign", delta: "private", threadId: "another-thread" });
    event("item/agentMessage/delta", { itemId: "answer", delta: "完成" });
    event("item/completed", { item: { id: "answer", type: "agentMessage", phase: "final_answer", text: "完成" } });
    f.finish("turn-1"); await turn;
    assert.deepEqual(updates.filter((value) => value.completed), [
      { id: "progress", text: "正在检查代码。", completed: true }, { id: "answer", text: "完成", completed: true }
    ]);
    assert.equal(updates.some((value) => /private|duplicate/.test(value.text)), false);
  } finally { f.close(); }
});

test("Codex replays early text notifications only after matching the accepted turn", async () => {
  const f = await fixture({ early: true, earlyEvents: [
    { method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "progress", delta: "检查中" } },
    { method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "progress", type: "agentMessage", phase: "commentary", text: "检查中" } } }
  ] });
  try {
    await f.runtime.probe();
    const session = await f.runtime.createSession({ agent: "codex", mode: "code", projectId: null }, "key");
    const order: string[] = [];
    await f.runtime.sendTurn(session, "task", "J1", {
      started: () => order.push("started"), message: (value: any) => order.push(value.text)
    });
    assert.deepEqual(order, ["started", "检查中", "检查中", "完成"]);
  } finally { f.close(); }
});

test("projectless sessions default to full access and keep the same native ID for every turn", async () => {
  const f = await fixture({ early: true });
  try {
    assert.equal((await f.runtime.probe()).ready, true);
    const session = await f.runtime.createSession({ agent: "codex", mode: "code", projectId: null }, "reservation");
    assert.equal(session.runtime, "codex-app-server");
    assert.equal(session.projectId, null);
    const first = await f.runtime.sendTurn(session, "one", "J1");
    await f.runtime.resumeSession(session);
    const second = await f.runtime.sendTurn(session, "two", "J2");
    assert.equal(first.text, "完成"); assert.equal(second.text, "完成");
    const start = f.sent.find((m) => m.method === "thread/start").params;
    assert.equal(start.cwd, f.directory); assert.equal(start.sandbox, "danger-full-access");
    assert.equal(start.approvalPolicy, "never"); assert.equal(start.approvalsReviewer, "user");
    assert.equal(start.model, undefined);
    assert.deepEqual(f.sent.filter((m) => m.method === "turn/start").map((m) => m.params.threadId), [session.nativeId, session.nativeId]);
    await assert.rejects(f.runtime.resumeSession({ nativeId: "foreign", title: "", projectId: null }), /TARGET_MISMATCH/);
  } finally { f.close(); }
});

test("resuming an existing Codex session applies full access before sending a turn", async () => {
  const f = await fixture();
  try {
    const session = { nativeId: "thread-1", title: "Existing session", projectId: null,
      cwd: f.directory, runtime: "codex-app-server" };
    await f.runtime.resumeSession(session);
    assert.equal((await f.runtime.sendTurn(session, "continue", "J1")).status, "completed");
    const resume = f.sent.find((m) => m.method === "thread/resume").params;
    assert.equal(resume.threadId, session.nativeId); assert.equal(resume.cwd, f.directory);
    assert.equal(resume.sandbox, "danger-full-access"); assert.equal(resume.approvalPolicy, "never");
    assert.equal(f.sent.some((m) => m.method === "thread/start"), false);
  } finally { f.close(); }
});

test("an approval waits for the matching explicit decision and never grants future operations", async () => {
  const f = await fixture({ approval: "item/commandExecution/requestApproval" });
  try {
    await f.runtime.probe();
    const session = await f.runtime.createSession({ agent: "codex", mode: "code", projectId: null }, "key");
    let decide!: (decision: string) => void;
    const ready = signal();
    const turn = f.runtime.sendTurn(session, "task", "J1", {
      started() {}, approval(request: any) {
        assert.equal(request.kind, "command"); assert.match(request.detail, /echo fixture/);
        ready.resolve(); return new Promise((resolve) => { decide = resolve; });
      }
    });
    await ready.promise; assert.equal(f.decisions.length, 0);
    decide("accept"); await turn;
    assert.deepEqual(f.decisions, [{ id: "server-approval", result: { decision: "accept" } }]);
  } finally { f.close(); }
});

test("unsupported server requests fail closed instead of hanging or granting permissions", async () => {
  const f = await fixture({ approval: "item/permissions/requestApproval" });
  try {
    await f.runtime.probe();
    const session = await f.runtime.createSession({ agent: "codex", mode: "code", projectId: null }, "key");
    await f.runtime.sendTurn(session, "task", "J1");
    assert.deepEqual(f.decisions[0]?.result, { permissions: {}, scope: "turn" });
  } finally { f.close(); }
});

test("stop interrupts the exact native turn and reports interruption as a known outcome", async () => {
  const f = await fixture({ hold: true });
  try {
    await f.runtime.probe();
    const session = await f.runtime.createSession({ agent: "codex", mode: "code", projectId: null }, "key");
    const ready = signal();
    const turn = f.runtime.sendTurn(session, "task", "J1", { started: ready.resolve });
    await ready.promise; await f.runtime.stopTurn("J1");
    assert.equal((await turn).status, "interrupted");
    assert.deepEqual(f.sent.find((m) => m.method === "turn/interrupt").params, { threadId: "thread-1", turnId: "turn-1" });
  } finally { f.close(); }
});

test("transport loss after sending rejects without replaying the turn", async () => {
  const f = await fixture({ hold: true });
  try {
    await f.runtime.probe();
    const session = await f.runtime.createSession({ agent: "codex", mode: "code", projectId: null }, "key");
    const ready = signal();
    const turn = f.runtime.sendTurn(session, "task", "J1", { started: ready.resolve });
    const failure = assert.rejects(turn, /SEND_UNCERTAIN/);
    await ready.promise; f.input.end(); await failure;
    assert.equal(f.sent.filter((m) => m.method === "turn/start").length, 1);
  } finally { f.close(); }
});


test("stop requested after acceptance waits for the native turn/started event", async () => {
  const f = await fixture({ hold: true, deferStart: true });
  try {
    await f.runtime.probe();
    const session = await f.runtime.createSession({ agent:"codex",mode:"code",projectId:null }, "key");
    const ready = signal();
    const turn = f.runtime.sendTurn(session, "task", "J1", { started: ready.resolve });
    await ready.promise;
    const stop = f.runtime.stopTurn("J1");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.sent.filter((message) => message.method === "turn/interrupt").length, 0);
    f.emit({ method:"turn/started", params:{threadId:"thread-1",turn:{id:"turn-1",status:"inProgress"}} });
    await stop; assert.equal((await turn).status, "interrupted");
  } finally { f.close(); }
});

test("an immediate stop cannot race ahead of the adapter registering its active turn", async () => {
  const f = await fixture({ hold:true });
  try {
    await f.runtime.probe();
    const session = await f.runtime.createSession({agent:'codex',mode:'code',projectId:null},'key');
    const turn = f.runtime.sendTurn(session,'task','J1');
    const stopped = f.runtime.stopTurn('J1');
    await stopped; assert.equal((await turn).status,'interrupted');
  } finally { f.close(); }
});
