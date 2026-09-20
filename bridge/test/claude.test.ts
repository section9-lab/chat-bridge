import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Claude distinguishes a missing CLI, a signed-out account and a failed check", async () => {
  const { ClaudeRuntime } = await import("../src/claude.js");
  for (const [path, auth, status] of [[undefined, false, "missing"], ["/fixture/claude", false, "needs_login"],
    ["/fixture/claude", "error", "error"]] as const) {
    const runtime = new ClaudeRuntime({ workspace: tmpdir(), locate: async () => ({ installed: !!path, executablePath: path }),
      authenticate: async () => { if (auth === "error") throw new Error("private detail"); return auth; } });
    try {
      assert.equal((await runtime.probe() as any).status, status);
    } finally { runtime.close(); }
  }
});

async function fixture({ mismatch = false, hold = false } = {}) {
  const modulePath = "../src/claude.js";
  const module = await import(modulePath).catch(() => ({}));
  assert.equal(typeof module.ClaudeRuntime, "function", "Claude Code must use a real runtime adapter.");
  const directory = mkdtempSync(join(tmpdir(), "claude-adapter-"));
  const nativeId = "f83f860a-4d05-4fa6-a04f-2be9b9cc8357";
  const info = { sessionId: nativeId, summary: "Code session", cwd: directory, lastModified: 100 };
  const calls: any[] = [], decisions: any[] = [];
  let release!: () => void;
  const interrupted = new Promise<void>((resolve) => { release = resolve; });
  let closed = 0;
  const api = {
    listSessions: async () => [info], getSessionInfo: async (id: string) => id === nativeId ? info : undefined,
    getSessionMessages: async () => [
      { type: "user", uuid: "one", message: { content: "Question" }, parent_tool_use_id: null },
      { type: "assistant", uuid: "two", message: { content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "Answer" }] }, parent_tool_use_id: null }
    ],
    query(request: any) {
      calls.push(request);
      const session_id = mismatch ? "wrong" : request.options.resume ?? request.options.sessionId;
      const stream = (async function* () {
        yield { type: "system", subtype: "init", session_id };
        decisions.push(await request.options.canUseTool("Bash", { command: "echo test" }, { signal: new AbortController().signal }));
        if (hold) await interrupted;
        yield { type: "result", subtype: "success", session_id, result: "Claude reply", is_error: false };
      })();
      return Object.assign(stream, { interrupt: async () => { release(); }, close: () => { closed++; release(); } });
    }
  };
  const runtime = new module.ClaudeRuntime({ workspace: join(directory, "Default"),
    locate: async () => ({ installed: true, executablePath: "/fixture/claude" }), authenticate: async () => true, api });
  return { runtime, directory, calls, decisions, api, nativeId, closed: () => closed,
    close() { runtime.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("Claude Code imports original projects, sessions and visible history without running a prompt", async () => {
  const f = await fixture();
  try {
    const projects = await f.runtime.listProjects(), sessions = await f.runtime.listSessions();
    assert.equal(projects[0].roots[0], f.directory);
    assert.equal(sessions[0].nativeId, f.nativeId);
    assert.equal(sessions[0].projectId, projects[0].id);
    const history = await f.runtime.readHistory(sessions[0]);
    assert.deepEqual(history.map((m: any) => m.text), ["Question", "Answer"]);
    assert.equal(f.calls.length, 0);
    await f.runtime.resumeSession(sessions[0]);
    const result = await f.runtime.sendTurn(sessions[0], "continue", "job", { approval: async () => "accept" });
    assert.equal(result.text, "Claude reply");
    assert.equal(f.calls[0].options.resume, f.nativeId);
    assert.equal(f.calls[0].options.cwd, f.directory);
    assert.equal(f.calls[0].options.forkSession, undefined);
    assert.equal(f.calls[0].options.permissionMode, "bypassPermissions");
    assert.equal(f.calls[0].options.allowDangerouslySkipPermissions, true);
    assert.equal(f.decisions[0].behavior, "allow");
    assert.equal(f.decisions[0].updatedPermissions, undefined);
    assert.equal(f.closed(), 1);
  } finally { f.close(); }
});

test("Claude Code verifies exact IDs, never silently creates a replacement for a missing session", async () => {
  const f = await fixture({ mismatch: true });
  try {
    const session = (await f.runtime.listSessions())[0];
    await assert.rejects(f.runtime.resumeSession({ ...session, nativeId: "missing" }), /TARGET_MISSING/);
    assert.equal(f.calls.length, 0);
    await assert.rejects(f.runtime.sendTurn(session, "hello", "job"), /TARGET_MISMATCH/);
    assert.equal(f.calls.length, 1);
    assert.equal(f.closed(), 1);
  } finally { f.close(); }
});

test("Claude can start the first session in an existing Bridge-managed project directory", async () => {
  const f = await fixture();
  try {
    const project = join(f.directory, "new-project"); mkdirSync(project);
    const registered = await f.runtime.createProject({ root: project, name: "卡牌" });
    assert.equal(registered.id, project); assert.deepEqual(registered.roots, [project]);
    assert.equal(f.calls.length, 0, "Creating the project does not run a prompt in another directory");
    const session = await f.runtime.createSession({ agent: "claude", mode: "code", projectId: project, sessionTitle: "项目启动" }, "37d8c3a2-238f-4415-bd55-e62a437dfb24");
    assert.equal(session.projectId, project); assert.equal(session.cwd, project);
    await f.runtime.sendTurn(session, "开始", "job", { approval: async () => "accept" });
    assert.equal(f.calls[0].options.cwd, project);
    assert.equal(f.calls[0].options.title, "项目启动");
    await assert.rejects(f.runtime.createSession({ agent: "claude", mode: "code", projectId: join(project, "missing") }, "missing"), /TARGET_MISSING/);
  } finally { f.close(); }
});

test("new Claude Code sessions keep their chosen project, and stop closes only the running query", async () => {
  const f = await fixture({ hold: true });
  try {
    const project = (await f.runtime.listProjects())[0];
    const session = await f.runtime.createSession({ agent: "claude", mode: "code", projectId: project.id }, "37d8c3a2-238f-4415-bd55-e62a437dfb24");
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const turn = f.runtime.sendTurn(session, "hello", "job", { started });
    await ready;
    await f.runtime.stopTurn("job");
    assert.equal((await turn).status, "interrupted");
    assert.equal(f.calls[0].options.sessionId, session.nativeId);
    assert.equal(f.calls[0].options.resume, undefined);
    assert.equal(f.calls[0].options.title, undefined, "Ordinary new conversations keep the SDK's automatic title");
    assert.equal(f.calls[0].options.permissionMode, "bypassPermissions");
    assert.equal(f.calls[0].options.allowDangerouslySkipPermissions, true);
    assert.equal(f.decisions[0].behavior, "deny");
  } finally { f.close(); }
});

test("Claude Code accepts the same working directory through a macOS path alias", async () => {
  const f = await fixture();
  try {
    const session = (await f.runtime.listSessions())[0];
    const alias = join(f.directory, "alias");
    symlinkSync(f.directory, alias);
    await assert.doesNotReject(f.runtime.resumeSession({ ...session, cwd: alias }));
  } finally { f.close(); }
});

test("Claude streams only top-level text, reconciles completed blocks and does not repeat the result", async () => {
  const f = await fixture();
  const updates: any[] = [];
  try {
    (f.api as any).query = (request: any) => {
      assert.equal(request.options.includePartialMessages, true);
      const partial = (event: any, parent_tool_use_id: string | null = null) => ({ type: "stream_event", event, session_id: parent_tool_use_id ? "child-session" : f.nativeId, parent_tool_use_id });
      const assistant = (id: string, uuid: string, content: any[], parent_tool_use_id: string | null = null) =>
        ({ type: "assistant", message: { id, content }, uuid, session_id: parent_tool_use_id ? "child-session" : f.nativeId, parent_tool_use_id });
      const stream = (async function* () {
        yield { type: "system", subtype: "init", session_id: f.nativeId };
        yield partial({ type: "message_start", message: { id: "progress" } });
        yield partial({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "private" } });
        yield partial({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "private" } });
        yield assistant("progress", "thought", [{ type: "thinking", thinking: "private" }]);
        yield partial({ type: "content_block_stop", index: 0 });
        yield partial({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
        yield partial({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "正在" } });
        yield partial({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "检查" } });
        assert.equal(updates.at(-1)?.text, "正在检查", "text is visible while the SDK is still generating");
        yield assistant("progress", "block-one", [{ type: "text", text: "正在检查。" }]);
        yield partial({ type: "content_block_stop", index: 1 });
        yield partial({ type: "content_block_start", index: 2, content_block: { type: "text", text: "" } });
        yield partial({ type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "发现问题。" } });
        yield assistant("progress", "block-two", [{ type: "text", text: "发现问题。" }]);
        yield partial({ type: "content_block_stop", index: 2 });
        yield partial({ type: "content_block_start", index: 3, content_block: { type: "tool_use", name: "Bash" } });
        yield partial({ type: "content_block_delta", index: 3, delta: { type: "input_json_delta", partial_json: "private" } });
        yield assistant("progress", "tool", [{ type: "tool_use", name: "Bash", input: { secret: "private" } }]);
        yield partial({ type: "content_block_stop", index: 3 });
        yield partial({ type: "message_stop" });
        assert.equal(updates.at(-1)?.completed, true, "public progress completes before the final answer");
        yield partial({ type: "message_start", message: { id: "subagent" } }, "tool-parent");
        yield assistant("subagent", "sub", [{ type: "text", text: "private" }], "tool-parent");
        yield { type: "tool_progress", session_id: f.nativeId, tool_name: "private" };
        yield assistant("answer", "final", [{ type: "text", text: "**已完成**" }]);
        yield assistant("answer", "final", [{ type: "text", text: "**已完成**" }]);
        yield { type: "result", subtype: "success", session_id: f.nativeId, result: "**已完成**", is_error: false };
      })();
      return Object.assign(stream, { close() {} });
    };
    const session = (await f.runtime.listSessions())[0];
    await f.runtime.sendTurn(session, "task", "job", { message: (value: any) => updates.push(value) });
    assert.deepEqual(updates.filter((value) => value.completed), [
      { id: "progress", text: "正在检查。\n\n发现问题。", completed: true },
      { id: "answer", text: "**已完成**", completed: true }
    ]);
    assert.equal(updates.some((value) => /private|Bash/.test(value.text)), false);
  } finally { f.close(); }
});

test("Claude completed-block fallback keeps distinct blocks with the same API message ID", async () => {
  const f = await fixture();
  try {
    (f.api as any).query = () => Object.assign((async function* () {
      yield { type: "system", subtype: "init", session_id: f.nativeId };
      for (const [uuid, text] of [["a", "第一段"], ["b", "第二段"], ["b", "第二段"]]) {
        yield { type: "assistant", session_id: f.nativeId, uuid, parent_tool_use_id: null,
          message: { id: "same-message", content: [{ type: "text", text }] } };
      }
      yield { type: "result", subtype: "success", session_id: f.nativeId, result: "第一段\n\n第二段", is_error: false };
    })(), { close() {} });
    const updates: any[] = [];
    await f.runtime.sendTurn((await f.runtime.listSessions())[0], "task", "job", { message: (value: any) => updates.push(value) });
    assert.deepEqual(updates.filter((value) => value.completed), [{ id: "same-message", text: "第一段\n\n第二段", completed: true }]);
  } finally { f.close(); }
});
