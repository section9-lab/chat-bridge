import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeCore, type AgentAdapter, type Origin } from "../src/core.js";

function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "bridge-create-project-")));
  const events: any[] = [], projects: any[] = [], sessions: any[] = [];
  let sequence = 0, fail = false;
  const adapters = Object.fromEntries(["codex", "claude"].map(agent => [agent, {
    probe: async () => ({ ready: true, reason: "Fixture" }),
    listProjects: async () => projects.filter(p => p.agent === agent),
    listSessions: async () => sessions.filter(s => s.agent === agent),
    createProject: async (value: any) => {
      events.push({ type: "project", agent, value });
      assert.deepEqual(readdirSync(value.root), []);
      if (fail) throw new Error("Desktop registration failed");
      const project = { id: agent + ":" + value.root, name: value.name, roots: [value.root], agent };
      projects.push(project); return project;
    },
    createSession: async (target: any) => {
      events.push({ type: "session", agent, target });
      const project = projects.find(p => p.id === target.projectId);
      const session = { nativeId: "session-" + ++sequence, title: target.sessionTitle ?? "普通对话", projectId: target.projectId,
        cwd: project?.roots[0], agent };
      sessions.push(session); return session;
    },
    resumeSession: async (session: any) => session,
    sendTurn: async (session: any, text: string, id: string, hooks: any) => {
      events.push({ type: "send", agent, session, text }); hooks?.started?.(id);
      return { turnId: id, text: "已完成" };
    },
  } as AgentAdapter]));
  const core = new BridgeCore(join(directory, "bridge.sqlite"), adapters);
  core.bindChannel("weixin", "bot", "owner"); core.bindChannel("imessage", "mail", "phone");
  core.setRoutingSettings({ mode: "auto" });
  const choose = (id: string) => { core.routeDecision = async (_context, actions) => {
    assert.ok(actions.some(a => a.id === id), "The requested project action must be available");
    return { choice: id, confidence: 1, probabilities: { [id]: 1 } };
  }; };
  const receive = (text: string, kind: Origin["kind"] = "weixin", eventId = String(++sequence)) => core.receive({
    kind, accountId: kind === "weixin" ? "bot" : "mail", peerId: kind === "weixin" ? "owner" : "phone", eventId,
  }, text);
  const send = async (text: string, kind?: Origin["kind"], eventId?: string) => {
    const receipt = receive(text, kind, eventId); if (receipt.jobId) await core.run(receipt.jobId); return receipt;
  };
  return { core, directory, events, choose, receive, send, fail(value: boolean) { fail = value; },
    close() { core.close(); rmSync(directory, { recursive: true, force: true }); } };
}

for (const [agent, channel] of [["codex", "weixin"], ["claude", "imessage"]] as const) {
  test(`${channel} creates a real ${agent} project before its first session and preserves follow-up context`, async () => {
    const f = fixture();
    try {
      f.choose("new_project_" + agent);
      const text = `用 ${agent} 创建名为“远程卡牌”的项目，先给出方案。`;
      const receipt = await f.send(text, channel, "create");
      assert.deepEqual(f.events.map(e => e.type), ["project", "session", "send"]);
      assert.equal(f.events[0].value.name, "远程卡牌");
      const first = f.events[2].session;
      assert.equal(first.cwd, f.events[0].value.root);
      assert.equal(first.projectId, f.events[1].target.projectId);
      const notices = f.core.outbox().filter(e => e.jobId === receipt.jobId);
      assert.match(notices[0]!.text, /(?:Codex|Claude) > 远程卡牌 > 项目启动\n已收到✅/);
      assert.doesNotMatch(notices[0]!.text, /无项目|J[a-f0-9]{12}|回复编号/);
      assert.ok(f.events[2].text.includes(text), "The full original prompt is retained");
      assert.equal(f.core.state().jobs[0]!.status, "completed");
      await f.send(text, channel, "create");
      assert.equal(f.events.length, 3, "A duplicate channel event does not create another project/session");
      f.choose("continue"); await f.send("继续刚才的方案", channel);
      assert.equal(f.events.at(-1).session.nativeId, first.nativeId);
      assert.equal(f.events.at(-1).session.cwd, first.cwd);
      assert.equal(f.events.filter(e => e.type === "project").length, 1);
    } finally { f.close(); }
  });
}

test("project registration failure retains the prompt and directory without sending it to a projectless session", async () => {
  const f = fixture();
  try {
    f.choose("new_project_codex"); f.fail(true);
    const receipt = await f.send("用 Codex 创建“卡牌”项目");
    assert.deepEqual(f.events.map(e => e.type), ["project"]);
    assert.equal(f.core.state().sessions.length, 0);
    const job = f.core.state().jobs.find(j => j.id === receipt.jobId)!;
    assert.equal(job.status, "awaiting_confirmation");
    assert.match(job.error!, /项目.*尚未发送/);
    const root = f.events[0].value.root;
    f.fail(false); f.choose("retry_" + job.id); await f.send("继续刚才未发送的任务");
    assert.equal(f.events.filter(e => e.type === "project").length, 2);
    assert.equal(f.events[1].value.root, root, "Retry reuses the reserved directory");
    assert.equal(f.events.filter(e => e.type === "send").length, 1);
  } finally { f.close(); }
});

test("an unrelated new project never overwrites an existing directory or reuses the old conversation", async () => {
  const f = fixture();
  try {
    f.choose("new_project_claude"); await f.send("用 Claude 创建“商城”项目");
    const first = f.events[2].session; writeFileSync(join(first.cwd, "keep.txt"), "keep");
    await f.send("另建一个“商城”项目，用 Claude");
    const second = f.events.at(-1).session;
    assert.notEqual(second.cwd, first.cwd); assert.notEqual(second.nativeId, first.nativeId);
    assert.ok(readdirSync(first.cwd).includes("keep.txt"));
  } finally { f.close(); }
});

test("project names cannot escape the managed projects directory", async () => {
  const f = fixture();
  try {
    f.choose("new_project_codex"); await f.send('创建名为“../../其他目录”的项目');
    assert.equal(f.events.length, 3);
    assert.equal(f.events[0].value.root.startsWith(join(f.directory, "Workspaces", "Projects") + "/"), true);
    assert.equal(f.events[0].value.name.includes("/"), false);
  } finally { f.close(); }
});

test("an uncertain project decision makes no directory and a projectless conversation remains projectless", async () => {
  const f = fixture();
  try {
    f.core.routeDecision = async () => ({ choice: "new_project_codex", confidence: 0.5,
      probabilities: { new_project_codex: 0.5, continue: 0.5 } });
    await f.send("是不是要新建项目？");
    assert.equal(f.events.length, 0);
    assert.equal(readdirSync(f.directory).includes("Workspaces"), false);
    f.choose("new_codex_none"); await f.send("不要创建项目，新开无项目会话，只回答你好");
    assert.deepEqual(f.events.map(e => e.type), ["session", "send"]);
    assert.equal(f.events[1].session.projectId, null);
  } finally { f.close(); }
});
