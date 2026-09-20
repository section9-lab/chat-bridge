import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function fixture(id = "cursor", options: { approval?: boolean; hold?: boolean; missing?: boolean; modelError?: boolean; nativeAuth?: boolean; extension?: string } = {}) {
  const modulePath = "../src/acp.js";
  const module = await import(modulePath).catch(() => ({}));
  assert.equal(typeof module.ACPRuntime, "function", "The four additional agents need an ACP runtime adapter");
  const directory = mkdtempSync(join(tmpdir(), "bridge-acp-"));
  let input = new PassThrough(), output = new PassThrough();
  const requests: any[] = [], decisions: any[] = [];
  let buffer = "", promptId: number, authenticated = true;
  let began!: () => void;
  const started = new Promise<void>((resolve) => { began = resolve; });
  const emit = (value: any) => input.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
  const update = (kind: string, text: string, sessionId = "original") => emit({ method: "session/update",
    params: { sessionId, update: { sessionUpdate: kind, content: { type: "text", text } } } });
  const finish = (stopReason = "end_turn") => emit({ id: promptId, result: { stopReason } });
  const handleOutput = (chunk: Buffer) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const frame = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      if (!frame.method) { decisions.push(frame); finish(); continue; }
      requests.push(frame);
      const respond = (result: any) => emit({ id: frame.id, result });
      if (frame.method === "initialize") respond({ protocolVersion: 1, agentInfo: { name: id, version: "test" },
        agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } }, authMethods: [] });
      if (frame.method === "session/list") respond({ sessions: [{ sessionId: "original", cwd: directory, title: "Existing session", updatedAt: "2026-09-20T00:00:00Z" }] });
      if (frame.method === "_x.ai/auth/info") respond({ methodId: authenticated ? "xai-api-key" : null });
      if (frame.method === "authenticate") respond(authenticated ? {} : null);
      if (frame.method === "session/new") respond({ sessionId: "original" });
      if (frame.method === "session/load") {
        if (options.missing) { respond(null); continue; }
        update("user_message_chunk", "Question"); update("agent_thought_chunk", "private reasoning");
        update("agent_message_chunk", "Previous answer"); respond({});
      }
      if (frame.method === "session/prompt") {
        promptId = frame.id; began();
        update("agent_message_chunk", "foreign", "another-session");
        update("agent_thought_chunk", "private reasoning");
        if (options.modelError) update("agent_message_chunk", "HTTP 403: This API endpoint is only accessible via the official Claude CLI");
        else { update("agent_message_chunk", "Hello"); update("agent_message_chunk", " world"); }
        if (options.approval) emit({ id: "approval", method: "session/request_permission", params: {
          sessionId: "original", toolCall: { toolCallId: "tool", title: "Edit a file", kind: "edit", status: "pending", rawInput: { path: "notes.txt", content: "Hello" } },
          options: [{ kind: "allow_always", optionId: "always", name: "Always" }, { kind: "allow_once", optionId: "once", name: "Once" },
            { kind: "reject_once", optionId: "reject", name: "Reject" }] } });
        else if (options.extension) emit({ id: "extension", method: options.extension, params: { toolCallId: "tool" } });
        else if (!options.hold) finish();
      }
      if (frame.method === "session/cancel") finish("cancelled");
    }
  };
  const runtime = new module.ACPRuntime({ id, workspace: join(directory, "Default"),
    locate: async () => ({ installed: true, executablePath: "/fixture/" + id }),
    authenticate: options.nativeAuth ? undefined : async () => authenticated,
    connect: () => {
      input = new PassThrough(); output = new PassThrough(); buffer = "";
      output.on("data", handleOutput);
      const transportInput = input, transportOutput = output;
      return { input, output, close() { transportInput.end(); transportOutput.end(); } };
    } });
  return { runtime, directory, requests, decisions, started, update, finish,
    auth(value: boolean) { authenticated = value; },
    close() { runtime.close(); input.destroy(); output.destroy(); rmSync(directory, { recursive: true, force: true }); } };
}

for (const id of ["cursor", "grok", "opencode", "hermes"]) {
  test(id + " probes without creating sessions and resumes the same native ID", async () => {
    const f = await fixture(id);
    try {
      assert.equal((await f.runtime.probe()).ready, true);
      assert.equal(f.requests.some((r) => ["session/new", "session/prompt"].includes(r.method)), false);
      const projects = await f.runtime.listProjects(), sessions = await f.runtime.listSessions();
      assert.equal(projects[0].id, f.directory);
      assert.equal(sessions[0].nativeId, "original");
      const history = await f.runtime.readHistory(sessions[0]);
      assert.deepEqual(history.map((m: any) => m.text), ["Question", "Previous answer"]);
      const resumed = await f.runtime.resumeSession(sessions[0]);
      const updates: any[] = [];
      const result = await f.runtime.sendTurn(resumed, "task", "J1", { message: (m: any) => updates.push(m) });
      assert.equal(result.text, "Hello world");
      assert.equal(updates.at(-1).completed, true);
      assert.equal(f.requests.find((r) => r.method === "session/prompt").params.sessionId, "original");
      assert.equal(f.requests.some((r) => r.method === "session/new"), false);
      assert.doesNotMatch(JSON.stringify(updates), /private|foreign/);
      f.auth(false); assert.equal((await f.runtime.probe()).status, "needs_login");
      f.auth(true); assert.equal((await f.runtime.probe()).ready, true);
    } finally { f.close(); }
  });
}

test("ACP approvals allow once only after the bridge decision", async () => {
  const f = await fixture("grok", { approval: true });
  let decide!: (value: string) => void;
  try {
    await f.runtime.probe();
    const session = await f.runtime.createSession({ projectId: null, mode: "code" }, "key");
    let detail = "";
    const run = f.runtime.sendTurn(session, "task", "J1", { approval: (request: any) => { detail = request.detail; return new Promise((resolve) => { decide = resolve; }); } });
    await f.started;
    for (let i = 0; i < 10 && !decide; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.decisions.length, 0);
    assert.match(detail, /notes.txt/);
    decide("accept"); await run;
    assert.equal(f.decisions[0].result.outcome.optionId, "once");
  } finally { f.close(); }
});

test("Cursor blocking extensions receive a valid cancellation instead of hanging or granting plan approval", async () => {
  for (const extension of ["cursor/ask_question", "cursor/create_plan"]) {
    const f = await fixture("cursor", { extension });
    try {
      await f.runtime.probe();
      const session = await f.runtime.createSession({ projectId: null, mode: "code" }, "key");
      await f.runtime.sendTurn(session, "task", "J1");
      assert.deepEqual(f.decisions[0].result, { outcome: { outcome: "cancelled" } });
    } finally { f.close(); }
  }
});

for (const id of ["grok", "hermes"]) test(id + " checks native credentials and detects a later login without creating a session", async () => {
  const f = await fixture(id, { nativeAuth: true });
  try {
    f.auth(false); assert.equal((await f.runtime.probe()).status, "needs_login");
    f.auth(true); assert.equal((await f.runtime.probe()).ready, true);
    assert.equal(f.requests.some((r) => r.method.startsWith("session/")), false);
  } finally { f.close(); }
});

test("missing ACP sessions fail instead of silently creating a replacement", async () => {
  const f = await fixture("hermes", { missing: true });
  try {
    await f.runtime.probe();
    const session = (await f.runtime.listSessions())[0];
    await assert.rejects(f.runtime.resumeSession(session), { code: "TARGET_MISSING" });
    assert.equal(f.requests.some((r) => ["session/new", "session/resume"].includes(r.method)), false);
  } finally { f.close(); }
});

test("stopping an ACP task cancels the same session", async () => {
  const f = await fixture("opencode", { hold: true });
  try {
    await f.runtime.probe();
    const session = await f.runtime.createSession({ projectId: null, mode: "code" }, "key");
    const run = f.runtime.sendTurn(session, "task", "J1");
    await f.started; await f.runtime.stopTurn("J1");
    assert.equal((await run).status, "interrupted");
    assert.equal(f.requests.find((r) => r.method === "session/cancel").params.sessionId, "original");
  } finally { f.close(); }
});

test("Hermes HTTP failures are visible after a healthy handshake and clear after an explicit successful retry", async () => {
  const options = { modelError: true };
  const f = await fixture("hermes", options);
  try {
    await f.runtime.probe();
    const session = await f.runtime.createSession({ projectId: null, mode: "code" }, "key");
    assert.equal((await f.runtime.sendTurn(session, "task", "J1")).status, "failed");
    const failed = await f.runtime.probe();
    assert.equal(failed.ready, true, "The connected runtime allows an explicit retry after the user fixes configuration");
    assert.match(failed.executionError, /模型/);
    options.modelError = false;
    assert.equal((await f.runtime.sendTurn(session, "retry", "J2")).status, "completed");
    assert.equal((await f.runtime.probe()).executionError, undefined);
    assert.equal(f.requests.filter((r) => r.method === "session/prompt").length, 2);
  } finally { f.close(); }
});
