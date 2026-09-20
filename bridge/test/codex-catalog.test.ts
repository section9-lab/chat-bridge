import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexRuntime } from "../src/codex.js";
import { BridgeCore } from "../src/core.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "codex-catalog-"));
  const globalStatePath = join(directory, "app-state.json");
  writeFileSync(globalStatePath, JSON.stringify({
    "thread-project-assignments": { existing: { projectKind: "local", projectId: "legacy" } },
    "app-server-project-id-by-legacy-project-id-by-host": { local: { legacy: "project" } },
    "projectless-thread-ids": ["loose"]
  }));
  const sent: any[] = [], opened: string[] = [];
  let onOpen = async () => {};
  let projects = [{ id: "project", name: "Existing", roots: [{ path: directory }] }];
  let trusted = true;
  const thread = (id: string) => ({ id, name: "Native " + id, cwd: directory, projectId: null, updatedAt: 100, createdAt: 90 });
  let mismatch = false, resumeError: unknown;
  const runtime = new CodexRuntime({ workspace: join(directory, "Default"), globalStatePath,
    locate: async () => ({ installed: true, executablePath: "/fixture/codex" }),
    openProject: async (_executable: string, root: string) => { opened.push(root); await onOpen(); },
    connect: () => {
      const input = new PassThrough(), output = new PassThrough();
      let buffer = "";
      output.on("data", (chunk) => {
        buffer += chunk.toString();
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); sent.push(message);
          if (!message.id) continue;
          if (message.method === "thread/resume" && resumeError) {
            input.write(JSON.stringify({ id: message.id, error: resumeError }) + "\n");
            continue;
          }
          let result: any = {};
          if (message.method === "config/read") result = { config: { projects: trusted ? {
            [directory]: { trust_level: "trusted" }, [join(directory, "new-game")]: { trust_level: "trusted" },
          } : {} } };
          if (message.method === "config/value/write") { trusted = true; result = { status: "ok" }; }
          if (message.method === "account/read") result = { requiresOpenaiAuth: false };
          if (message.method === "project/list") result = { data: projects, nextCursor: null };
          if (message.method === "project/read") result = { project: { id: "project", name: "Existing", roots: [{ path: directory }] } };
          if (message.method === "project/create") result = { project: { id: "created-project", name: message.params.name, roots: message.params.roots } };
          if (message.method === "thread/metadata/update") result = { thread: { ...thread(message.params.threadId), projectId: message.params.projectId } };
          if (message.method === "thread/list") result = { data: [thread(message.params.cursor ? "loose" : "existing")], nextCursor: message.params.cursor ? null : "page2" };
          if (message.method === "thread/read") result = { thread: thread(message.params.threadId) };
          if (message.method === "thread/turns/list") result = { data: [{ id: "turn", items: [
            { id: "u", type: "userMessage", content: [{ type: "text", text: "Hello" }] },
            { id: "reason", type: "reasoning", text: "private" },
            { id: "progress", type: "agentMessage", text: "Checking", phase: "commentary" },
            { id: "a", type: "agentMessage", text: "Reply", phase: "final_answer" }
          ] }], nextCursor: null };
          if (message.method === "thread/resume") result = { thread: thread(mismatch ? "wrong" : message.params.threadId), cwd: directory };
          if (message.method === "thread/start") result = { thread: { ...thread("new"), projectId: "project" }, cwd: directory };
          if (message.method === "turn/start") result = { turn: { id: "continued-turn", status: "completed", items: [
            { id: "answer", type: "agentMessage", text: "继续成功" }
          ] } };
          input.write(JSON.stringify({ id: message.id, result }) + "\n");
        }
      });
      return { input, output, close() { input.end(); output.end(); } };
    }
  } as any);
  return { runtime: runtime as any, sent, opened, directory, globalStatePath, projects(value: typeof projects) { projects = value; },
    onOpen(action: () => Promise<void>) { onOpen = action; },
    untrust() { trusted = false; },
    mismatch() { mismatch = true; }, rejectResume(error?: unknown) { resumeError = error; },
    close() { runtime.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("Codex reads paginated native catalogs and legacy project membership without resuming threads", async () => {
  const f = fixture();
  try {
    assert.equal(typeof f.runtime.listProjects, "function");
    const projects = await f.runtime.listProjects();
    const sessions = await f.runtime.listSessions();
    assert.equal(projects[0].name, "Existing");
    assert.deepEqual(sessions.map((s: any) => [s.nativeId, s.projectId]), [["existing", "project"], ["loose", null]]);
    assert.ok(f.sent.find((m) => m.method === "thread/list").params.sourceKinds.includes("appServer"));
    const history = await f.runtime.readHistory(sessions[0]);
    assert.deepEqual(history.map((m: any) => [m.role, m.text]), [["user", "Hello"], ["assistant", "Checking"], ["assistant", "Reply"]]);
    assert.equal(f.sent.some((m) => ["thread/start", "thread/resume", "turn/start"].includes(m.method)), false);
    await f.runtime.resumeSession(sessions[0]);
    const resume = f.sent.find((m) => m.method === "thread/resume").params;
    assert.equal(resume.threadId, "existing"); assert.equal(resume.cwd, f.directory);
  } finally { f.close(); }
});

test("Codex binds an existing thread to a verified project without creating a replacement thread", async () => {
  const f = fixture();
  try {
    assert.equal(typeof f.runtime.bindProject, "function");
    const result = await f.runtime.bindProject({ nativeId: "loose", title: "Long request", projectId: null, cwd: f.directory, runtime: "codex-app-server" },
      { root: f.directory, name: "商城" }, "商城测试");
    assert.equal(result.project.id, "project"); assert.equal(result.session.nativeId, "loose");
    assert.equal(result.session.projectId, "project"); assert.equal(result.session.title, "商城测试");
    assert.deepEqual(f.sent.find((m: any) => m.method === "thread/metadata/update").params, { threadId: "loose", projectId: "project" });
    assert.deepEqual(f.sent.find((m: any) => m.method === "thread/name/set").params, { threadId: "loose", name: "商城测试" });
    assert.equal(f.sent.some((m: any) => ["thread/start", "turn/start", "project/create"].includes(m.method)), false);
  } finally { f.close(); }
});

test("Codex creates in the selected native project and rejects resume ID mismatches", async () => {
  const f = fixture();
  try {
    const session = await f.runtime.createSession({ agent: "codex", mode: "code", projectId: "project" }, "creation");
    assert.equal(session.projectId, "project"); assert.equal(session.cwd, f.directory);
    const start = f.sent.find((m) => m.method === "thread/start").params;
    assert.equal(start.projectId, "project"); assert.equal(start.cwd, f.directory);
    f.mismatch();
    await assert.rejects(f.runtime.resumeSession({ ...session, nativeId: "existing" }), /TARGET_MISMATCH/);
    assert.equal(f.sent.filter((m) => m.method === "thread/start").length, 1);
  } finally { f.close(); }
});

test("a new empty Codex project saves only its exact trust entry and verifies desktop registration before creating a session", async () => {
  const f = fixture();
  try {
    const root = join(f.directory, "new-game"); mkdirSync(root); f.untrust();
    f.onOpen(async () => {
      f.projects([{ id: "desktop-native", name: "卡牌", roots: [{ path: root }] }]);
      writeFileSync(f.globalStatePath, JSON.stringify({ "local-projects": { saved: { id: "saved", rootPaths: [root] } },
        "app-server-project-id-by-legacy-project-id-by-host": { local: { saved: "desktop-native" } } }));
    });
    const project = await f.runtime.createProject({ root, name: "卡牌" });
    assert.equal(project.id, "desktop-native");
    const writes = f.sent.filter((m: any) => m.method === "config/value/write");
    assert.deepEqual(writes.map((m: any) => m.params), [{ keyPath: "projects." + JSON.stringify(root) + ".trust_level", value: "trusted", mergeStrategy: "upsert" }]);
    assert.equal(f.opened[0], root);
    assert.equal(f.sent.some((m: any) => m.method === "thread/start" || m.method === "turn/start"), false);
  } finally { f.close(); }
});

test("project creation cannot silently trust an existing nonempty directory or claim a backend-only project is ready", async () => {
  const f = fixture();
  try {
    f.untrust();
    await assert.rejects(f.runtime.createProject({ root: f.directory, name: "既有目录" }), /PROJECT_NOT_READY/);
    assert.equal(f.sent.some((m: any) => m.method === "config/value/write"), false);
    assert.deepEqual(f.opened, []);
    assert.equal(f.sent.some((m: any) => m.method === "thread/start" || m.method === "turn/start"), false);
  } finally { f.close(); }
});

test("Codex registers a newly created directory before binding the original thread", async () => {
  const f = fixture();
  try {
    const root = join(f.directory, "new-game"); mkdirSync(root);
    const result = await f.runtime.bindProject({ nativeId: "loose", title: "Game", projectId: null, cwd: f.directory, runtime: "codex-app-server" },
      { root, name: "新游戏" }, "游戏试玩");
    assert.equal(result.project.id, "created-project");
    assert.equal(result.session.nativeId, "loose"); assert.equal(result.session.cwd, f.directory);
    const create = f.sent.find((m: any) => m.method === "project/create");
    assert.deepEqual(create.params.roots, [{ path: root }]); assert.ok(create.params.idempotencyKey);
    assert.equal(f.sent.find((m: any) => m.method === "thread/metadata/update").params.projectId, "created-project");
    assert.deepEqual(f.opened, [root]);
    assert.match(result.notice ?? "", /Codex.*侧栏.*添加/);
    assert.ok(result.notice.includes(root));
    assert.equal(f.sent.some((m: any) => ["thread/start", "turn/start"].includes(m.method)), false);
  } finally { f.close(); }
});

test("Codex prefers the desktop project when a runtime-only project has the same root", async () => {
  const f = fixture();
  try {
    f.projects([
      { id: "runtime-only", name: "Game", roots: [{ path: f.directory }] },
      { id: "project", name: "Desktop game", roots: [{ path: f.directory }] },
    ]);
    writeFileSync(f.globalStatePath, JSON.stringify({
      "local-projects": { legacy: { id: "legacy", name: "Desktop game", rootPaths: [f.directory] } },
      "app-server-project-id-by-legacy-project-id-by-host": { local: { legacy: "project" } },
      "thread-project-assignments": { loose: { projectKind: "local", projectId: "legacy" } },
    }));
    const before = readFileSync(f.globalStatePath, "utf8");
    const result = await f.runtime.bindProject({ nativeId: "loose", title: "Game", projectId: null },
      { root: f.directory, name: "Game" }, "Game");
    assert.equal(result.project.id, "project");
    assert.equal(result.notice, undefined);
    assert.deepEqual(f.opened, [], "An already registered folder does not open the desktop again");
    assert.equal(f.sent.find((m: any) => m.method === "thread/metadata/update").params.projectId, "project");
    assert.equal(f.sent.some((m: any) => m.method === "project/create"), false);
    assert.equal(readFileSync(f.globalStatePath, "utf8"), before, "Never overwrite desktop-owned state");
  } finally { f.close(); }
});

test("Codex uses the project registered by the desktop launcher rather than creating a duplicate", async () => {
  const f = fixture();
  try {
    f.onOpen(async () => {
      writeFileSync(f.globalStatePath, JSON.stringify({
        "local-projects": { project: { id: "project", name: "Game", rootPaths: [f.directory] } },
        "thread-project-assignments": { loose: { projectKind: "local", projectId: "project" } },
      }));
    });
    const result = await f.runtime.bindProject({ nativeId: "loose", title: "Game", projectId: null },
      { root: f.directory, name: "Game" }, "Game");
    assert.deepEqual(f.opened, [f.directory]);
    assert.equal(result.project.id, "project");
    assert.equal(result.notice, undefined);
    assert.equal(f.sent.some((m: any) => m.method === "project/create"), false);
  } finally { f.close(); }
});

test("a saved desktop project without desktop thread membership still needs an explicit notice", async () => {
  const f = fixture();
  try {
    writeFileSync(f.globalStatePath, JSON.stringify({
      "local-projects": { project: { id: "project", name: "Game", rootPaths: [f.directory] } },
      "projectless-thread-ids": ["loose"],
    }));
    const result = await f.runtime.bindProject({ nativeId: "loose", title: "Game", projectId: null },
      { root: f.directory, name: "Game" }, "Game");
    assert.match(result.notice ?? "", /会话.*移入/);
    assert.equal(result.session.nativeId, "loose");
  } finally { f.close(); }
});

test("an untrusted project waits for remote consent before changing its exact config key or opening Codex", async () => {
  const f = fixture(); let allow!: (decision: string) => void;
  try {
    f.untrust();
    const consent = new Promise<string>(resolve => { allow = resolve; });
    let request: any;
    const binding = f.runtime.bindProject({ nativeId: "loose", title: "Game", projectId: null },
      { root: f.directory, name: "Game" }, "Game", async (value: any) => { request = value; return consent; });
    for (let i = 0; i < 100 && !request; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(request?.kind, "projectTrust"); assert.equal(request.cwd, f.directory);
    assert.deepEqual(f.opened, []);
    assert.equal(f.sent.some((m: any) => m.method === "config/value/write"), false);
    allow("accept"); await binding;
    assert.deepEqual(f.opened, [f.directory]);
    assert.deepEqual(f.sent.find((m: any) => m.method === "config/value/write").params, {
      keyPath: "projects." + JSON.stringify(f.directory) + ".trust_level", value: "trusted", mergeStrategy: "upsert",
    });
  } finally { allow?.("decline"); f.close(); }
});

test("declining folder trust keeps the files and native session without opening a desktop prompt", async () => {
  const f = fixture();
  try {
    f.untrust();
    const result = await f.runtime.bindProject({ nativeId: "loose", title: "Game", projectId: null },
      { root: f.directory, name: "Game" }, "Game", async () => "decline");
    assert.deepEqual(f.opened, []);
    assert.equal(f.sent.some((m: any) => m.method === "config/value/write"), false);
    assert.equal(result.session.nativeId, "loose");
    assert.match(result.notice ?? "", /未信任/);
  } finally { f.close(); }
});

test("releasing an idle Codex session gives up the native lease and can resume the same ID later", async () => {
  const f = fixture();
  try {
    const session = await f.runtime.createSession({ agent: "codex", mode: "code", projectId: "project" }, "creation");
    assert.equal(typeof f.runtime.releaseSession, "function");
    f.runtime.releaseSession();
    await f.runtime.resumeSession(session);
    assert.equal(f.sent.filter((m) => m.method === "initialize").length, 2);
    assert.equal(f.sent.find((m) => m.method === "thread/resume").params.threadId, session.nativeId);
    assert.equal(f.sent.filter((m) => m.method === "thread/start").length, 1);
  } finally { f.close(); }
});

test("an occupied Codex session without queue support stays unsent with an accurate explanation", async () => {
  const f = fixture();
  try {
    const [session] = await f.runtime.listSessions();
    f.rejectResume({ code: -32600, message: "thread existing already has an active writer" });
    await assert.rejects(f.runtime.resumeSession(session), (error: any) => {
      assert.equal(error.code, "AGENT_UNAVAILABLE");
      assert.match(error.message, /占用/);
      assert.match(error.message, /队列/);
      assert.doesNotMatch(error.message, /关闭.*窗口/);
      return true;
    });
    assert.equal(f.sent.some((m) => ["thread/start", "turn/start"].includes(m.method)), false);
  } finally { f.close(); }
});

test("other resume rejections do not claim another window owns the session or expose runtime details", async () => {
  const f = fixture();
  try {
    const [session] = await f.runtime.listSessions();
    for (const error of [
      { code: -32603, message: "required MCP initialization failed: private-runtime-detail" },
      { code: -32603, message: "thread existing already has an active writer" },
      { code: -32600, message: "invalid config: active writer private-runtime-detail" },
      "thread existing already has an active writer"
    ]) {
      f.rejectResume(error);
      await assert.rejects(f.runtime.resumeSession(session), (error: any) => {
        assert.equal(error.code, "AGENT_UNAVAILABLE");
        assert.match(error.message, /恢复/);
        assert.doesNotMatch(error.message, /其他窗口|占用|关闭|private-runtime-detail|active writer/);
        return true;
      });
    }
    assert.equal(f.sent.some((m) => ["thread/start", "turn/start"].includes(m.method)), false);
  } finally { f.close(); }
});

test("an iMessage task blocked by a Codex writer stays unsent and continues the exact session once released", async () => {
  const f = fixture();
  const core = new BridgeCore(join(f.directory, "bridge.sqlite"), { codex: f.runtime });
  const origin = (eventId: string) => ({ kind: "imessage" as const, accountId: "account", peerId: "owner", eventId });
  try {
    core.bindChannel("imessage", "account", "owner");
    await core.refreshCatalog("codex");
    core.receive(origin("projects"), "/projects");
    core.receive(origin("project"), "01");
    core.receive(origin("session"), "01");
    f.rejectResume({ code: -32600, message: "thread existing already has an active writer" });
    const receipt = core.receive(origin("task"), "当前完成了什么？");
    await core.run(receipt.jobId!);
    assert.equal(core.state().jobs[0]?.status, "waiting_agent");
    const notice = core.outbox().find((entry) => entry.kind === "status")!;
    assert.match(notice.text, /占用/);
    assert.match(notice.text, /任务未发送/);
    assert.ok(notice.text.includes("/continue " + receipt.jobId));
    assert.equal(f.sent.some((m) => ["thread/start", "turn/start"].includes(m.method)), false);
    await core.run(receipt.jobId!);
    assert.equal(f.sent.filter((m) => m.method === "thread/resume").length, 1, "No implicit retry while waiting");
    core.receive(origin("switch"), "/new");
    f.rejectResume();
    core.receive(origin("continue"), "/continue " + receipt.jobId);
    await core.run(receipt.jobId!);
    core.receive(origin("continue"), "/continue " + receipt.jobId);
    await core.run(receipt.jobId!);
    assert.equal(core.state().jobs[0]?.status, "completed");
    assert.deepEqual(f.sent.filter((m) => m.method === "turn/start").map((m) => [m.params.threadId, m.params.input[0].text]),
      [["existing", "当前完成了什么？"]]);
    assert.equal(f.sent.some((m) => m.method === "thread/start"), false);
    const reply = core.outbox().find((entry) => entry.kind === "assistant")!;
    assert.equal(reply.text, "继续成功");
    assert.equal(reply.origin.kind, "imessage");
  } finally { core.close(); f.close(); }
});
