import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeCore, type NativeSession } from "../src/core.js";

const desktop = (eventId: string) => ({ kind: "desktop" as const, accountId: "local", peerId: "local", eventId });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "bridge-catalog-"));
  const resumed: NativeSession[] = [], created: unknown[] = [];
  const adapter = {
    probe: async () => ({ ready: true, reason: "ready" }),
    listProjects: async () => [{ id: "native-project", name: "Existing project", roots: [directory] }],
    listSessions: async () => Array.from({ length: 12 }, (_, i) => ({ nativeId: "native-" + i, title: "Existing session " + i,
      projectId: i === 11 ? null : "native-project", cwd: directory, runtime: "fixture", updatedAt: 100 - i })),
    readHistory: async () => [{ id: "native-message", role: "assistant", text: "Existing reply", createdAt: "2026-09-18T00:00:00Z" }],
    createSession: async (target: unknown) => { created.push(target); return { nativeId: "created", title: "New", projectId: "native-project", cwd: directory, runtime: "fixture" }; },
    resumeSession: async (session: NativeSession) => { resumed.push(session); return session; },
    sendTurn: async () => ({ turnId: "turn", text: "done" }),
  };
  const core = new BridgeCore(join(directory, "bridge.sqlite"), { codex: adapter, claude: adapter });
  return { core, adapter, resumed, created, directory, close() { core.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("native projects and sessions can be selected by stable codes without creating replacements", async () => {
  const f = fixture();
  try {
    assert.equal(typeof (f.core as any).refreshCatalog, "function", "The bridge must load the native catalog.");
    await (f.core as any).refreshCatalog("codex");
    const project = (f.core.state() as any).projects[0];
    const session = f.core.state().sessions.find((session) => session.nativeId === "native-0")!;
    assert.match(f.core.receive(desktop("projects"), "/projects").message!, /Existing project/);
    f.core.receive(desktop("project"), "/project " + project.shortId);
    assert.equal(f.core.state().selection.projectId, "native-project");
    const page = f.core.receive(desktop("sessions"), "/sessions").message!;
    assert.match(page, /Existing session 0/);
    assert.ok(!page.includes("Existing session 11"));
    assert.match(page, /下一页：\/more/);
    assert.match(f.core.receive(desktop("more"), "/more").message!, /11 Existing session 10/);
    f.core.receive(desktop("use"), "/use " + session.shortId);
    await (f.core as any).loadHistory(session.id);
    assert.equal(f.core.state().messages[0]?.text, "Existing reply");
    const job = f.core.receive(desktop("work"), "continue");
    await f.core.run(job.jobId!);
    assert.equal(f.created.length, 0);
    assert.equal(f.resumed[0]?.nativeId, "native-0");
    await (f.core as any).refreshCatalog("codex");
    assert.equal(f.core.state().sessions.find((item) => item.nativeId === "native-0")?.shortId, session.shortId);
    assert.equal(f.core.state().sessions.length, 12);
  } finally { f.close(); }
});

test("project and Agent switching keep accepted work on its original target", async () => {
  const f = fixture();
  try {
    assert.equal(typeof (f.core as any).refreshCatalog, "function");
    await (f.core as any).refreshCatalog("codex");
    const project = (f.core.state() as any).projects[0];
    f.core.receive(desktop("project"), "/project " + project.shortId);
    f.core.receive(desktop("new"), "/new");
    const receipt = f.core.receive(desktop("work"), "create in project");
    f.core.receive(desktop("agent"), "/agent claude");
    await f.core.run(receipt.jobId!);
    assert.equal((f.created[0] as any).projectId, "native-project");
    assert.equal((f.created[0] as any).agent, "codex");
    assert.equal(f.core.state().selection.agent, "claude");
    f.core.receive(desktop("back"), "/agent codex");
    assert.equal(f.core.state().selection.projectId, "native-project");
    assert.ok(f.core.state().selection.sessionId);
  } finally { f.close(); }
});

test("failed catalog refresh preserves existing selection and project data", async () => {
  const f = fixture();
  try {
    assert.equal(typeof (f.core as any).refreshCatalog, "function");
    await (f.core as any).refreshCatalog("codex");
    const before = f.core.state();
    f.adapter.listSessions = async () => { throw new Error("catalog unavailable"); };
    await assert.rejects((f.core as any).refreshCatalog("codex"));
    assert.deepEqual(f.core.state(), before);
    assert.throws(() => f.core.receive(desktop("bad-project"), "/project Pmissing"), /TARGET_MISSING/);
    assert.deepEqual(f.core.state().selection, before.selection);
  } finally { f.close(); }
});

const remote = (eventId: string, kind: "imessage" | "weixin" = "imessage") => ({ kind, accountId: "account", peerId: "owner", eventId });
async function numberedFixture() {
  const f = fixture();
  f.core.bindChannel("imessage", "account", "owner");
  f.core.bindChannel("weixin", "account", "owner");
  await f.core.refreshCatalog("codex");
  return f;
}

test("project menus contain only short ordinal numbers and names", async () => {
  const f = await numberedFixture();
  try {
    const expected = "请回复编号进行选择：\n01 Existing project\n02 无项目";
    assert.equal(f.core.receive(remote("projects"), "/projects").message, expected);
    assert.equal(f.core.receive(remote("project-alias"), "/project").message, expected);
    assert.equal(f.core.state().jobs.length, 0);
  } finally { f.close(); }
});
test("project menus provide a projectless choice that clears the previous session", async () => {
  const f = await numberedFixture();
  try {
    const session = f.core.state().sessions.find((session) => session.projectId !== null)!;
    f.core.receive(remote("select"), "/use " + session.shortId);
    const menu = f.core.receive(remote("projects"), "/projects");
    assert.match(menu.message!, /02 无项目/);
    f.core.receive(remote("none"), "02");
    assert.equal(f.core.state().selection.projectId, null);
    assert.equal(f.core.state().selection.sessionId, null);
    assert.equal(f.core.state().jobs.length, 0);
  } finally { f.close(); }
});
test("a project number opens its session menu and a session number selects the original session", async () => {
  const f = await numberedFixture();
  try {
    f.core.receive(remote("projects"), "/projects");
    const sessions = f.core.receive(remote("choose-project"), "01");
    assert.equal(sessions.jobId, undefined);
    assert.equal(f.core.state().selection.projectId, "native-project");
    assert.equal(sessions.message, "请回复编号进行选择：\n" +
      Array.from({ length: 8 }, (_, i) => String(i + 1).padStart(2, "0") + " Existing session " + i).join("\n") + "\n下一页：/more");
    const selected = f.core.receive(remote("choose-session"), "02");
    assert.equal(selected.message, "当前会话：Existing session 1");
    const session = f.core.state().sessions.find((s) => s.nativeId === "native-1")!;
    assert.equal(f.core.state().selection.sessionId, session.id);
    assert.equal(f.core.state().jobs.length, 0);
    assert.deepEqual(f.core.receive(remote("choose-session"), "02"), selected, "A redelivered selection is not a task");
    const task = f.core.receive(remote("task"), "continue here");
    await f.core.run(task.jobId!);
    assert.equal(f.created.length, 0);
    assert.equal(f.resumed[0]?.nativeId, "native-1");
  } finally { f.close(); }
});
test("session pages keep ordinal mappings stable and hide paging tokens", async () => {
  const f = await numberedFixture();
  try {
    f.core.receive(remote("sessions"), "/sessions all");
    assert.throws(() => f.core.receive(remote("not-shown"), "09"), /INVALID_INPUT/);
    const second = f.core.receive(remote("more"), "/more").message!;
    assert.equal(second, "请回复编号进行选择：\n09 Existing session 8\n10 Existing session 9\n11 Existing session 10\n12 Existing session 11");
    assert.equal(f.core.receive(remote("last-page"), "/more").message, "已经是最后一页。");
    f.core.receive(remote("choose"), "09");
    assert.equal(f.core.state().sessions.find((s) => s.id === f.core.state().selection.sessionId)?.nativeId, "native-8");
  } finally { f.close(); }
});
test("menu snapshots survive catalog reordering and remain selectable on earlier pages", async () => {
  const f = await numberedFixture();
  try {
    f.core.receive(remote("sessions"), "/sessions all");
    const list = await f.adapter.listSessions();
    f.adapter.listSessions = async () => list.map((s) => ({ ...s, updatedAt: -(s.updatedAt ?? 0) }));
    await f.core.refreshCatalog("codex");
    f.core.receive(remote("more"), "/more");
    f.core.receive(remote("choose"), "01");
    assert.equal(f.core.state().sessions.find((s) => s.id === f.core.state().selection.sessionId)?.nativeId, "native-0");
  } finally { f.close(); }
});
test("numbered menus belong to their original channel and target version", async () => {
  const f = await numberedFixture();
  try {
    f.core.receive(remote("projects"), "/projects");
    f.core.receive(remote("sessions", "weixin"), "/sessions all");
    f.core.receive(remote("choose-project"), "01");
    assert.throws(() => f.core.receive(remote("stale", "weixin"), "01"), /STALE_MENU/);
    assert.equal(f.core.state().selection.projectId, "native-project");
    assert.equal(f.core.state().selection.sessionId, null);
    assert.equal(f.core.state().jobs.length, 0);
    assert.throws(() => f.core.receive(remote("page", "weixin"), "/more"), /STALE_MENU/);
  } finally { f.close(); }
});
test("expired and rebound menus reject numbers without creating tasks", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = await numberedFixture();
  try {
    f.core.receive(remote("projects"), "/projects");
    context.mock.timers.tick(10 * 60_000);
    assert.throws(() => f.core.receive(remote("expired"), "01"), /STALE_MENU/);
    f.core.receive(remote("fresh"), "/projects");
    f.core.unbindChannel("imessage"); f.core.bindChannel("imessage", "account", "owner");
    assert.throws(() => f.core.receive(remote("rebound"), "01"), /STALE_MENU/);
    assert.equal(f.core.state().jobs.length, 0);
  } finally { f.close(); }
});
test("invalid menu numbers never go to the Agent and normal text dismisses the menu", async () => {
  const f = await numberedFixture();
  try {
    const plain = f.core.receive(remote("ordinary-number"), "42");
    assert.ok(plain.jobId, "Without a menu, numbers remain ordinary messages");
    f.core.receive(remote("projects"), "/projects");
    for (const value of ["00", "99", "999999999999999999999999"]) {
      assert.throws(() => f.core.receive(remote("bad-" + value), value), /INVALID_INPUT/);
    }
    assert.equal(f.core.state().jobs.length, 1);
    f.core.receive(remote("text"), "keep working");
    assert.ok(f.core.receive(remote("number-after-text"), "01").jobId);
  } finally { f.close(); }
});
test("choosing a session consumes its numeric menu", async () => {
  const f = await numberedFixture();
  try {
    f.core.receive(remote("sessions"), "/sessions all");
    f.core.receive(remote("choose"), " 1 ");
    assert.equal(f.core.state().sessions.find((s) => s.id === f.core.state().selection.sessionId)?.nativeId, "native-0");
    assert.ok(f.core.receive(remote("number-as-task"), "01").jobId);
  } finally { f.close(); }
});
test("an empty project catalog falls back to sessions and direct selection clears the menu", async () => {
  const f = fixture();
  try {
    f.adapter.listProjects = async () => [];
    await f.core.refreshCatalog("codex");
    const menu = f.core.receive(desktop("projects"), "/projects").message!;
    assert.match(menu, /^请回复编号进行选择：\n01 Existing session 0/);
    f.core.receive(desktop("sessions"), "/sessions all");
    f.core.receive(desktop("none"), "/project none");
    const only = f.core.state().sessions.find((s) => s.projectId === null)!;
    f.core.receive(desktop("session"), "/use " + only.shortId);
    assert.ok(f.core.receive(desktop("ordinary"), "01").jobId);
  } finally { f.close(); }
});
test("a project with no sessions lets the next message start a session", async () => {
  const f = fixture();
  try {
    f.adapter.listSessions = async () => [];
    await f.core.refreshCatalog("codex");
    f.core.receive(desktop("projects"), "/project");
    const result = f.core.receive(desktop("choose"), "01");
    assert.match(result.message!, /当前项目暂无会话/);
    assert.equal(f.core.state().selection.projectId, "native-project");
    assert.equal(f.core.state().jobs.length, 0);
    const firstMessage = f.core.receive(desktop("first-message"), "01");
    assert.ok(firstMessage.jobId);
    assert.equal(f.core.state().jobs[0]?.target.projectId, "native-project");
  } finally { f.close(); }
});
test("menus and numeric mappings survive a service restart", async () => {
  const f = await numberedFixture();
  try {
    f.core.receive(remote("projects"), "/projects");
    f.core.close();
    const restored = new BridgeCore(join(f.directory, "bridge.sqlite"), { codex: f.adapter });
    try {
      assert.match(restored.receive(remote("choose"), "01").message!, /^请回复编号进行选择：\n01 Existing session 0/);
      assert.equal(restored.state().selection.projectId, "native-project");
      assert.equal(restored.state().jobs.length, 0);
    } finally { restored.close(); }
  } finally { f.close(); }
});
test("multiline names cannot create additional numbered rows", async () => {
  const f = fixture();
  try {
    f.adapter.listProjects = async () => [{ id: "project", name: "Name\n02 fake row", roots: [] }];
    await f.core.refreshCatalog("codex");
    assert.equal(f.core.receive(desktop("projects"), "/projects").message, "请回复编号进行选择：\n01 Name 02 fake row\n02 无项目");
  } finally { f.close(); }
});
test("the bare project command refreshes the catalog through channel preparation", async () => {
  const f = fixture();
  try {
    f.core.bindChannel("imessage", "account", "owner");
    const events = await f.core.prepareEvents([{ origin: remote("alias"), text: "/project" }]);
    const result = f.core.ingestBatch("imessage", "account", "cursor", events);
    assert.equal(result[0]?.message, "请回复编号进行选择：\n01 Existing project\n02 无项目");
    assert.equal(f.core.state().jobs.length, 0);
  } finally { f.close(); }
});
