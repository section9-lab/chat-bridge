import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeCore, type AgentAdapter, type Origin } from "../src/core.js";

// Chat Bridge only routes a message into the right agent session. Whether and where to create a
// project is decided by the agent inside that session, so a request to create one is ordinary work.
function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "bridge-create-project-")));
  const events: any[] = [], sessions: any[] = [];
  let sequence = 0;
  const offered: string[][] = [];
  const adapters = Object.fromEntries(["codex", "claude"].map(agent => [agent, {
    probe: async () => ({ ready: true, reason: "Fixture" }),
    listProjects: async () => [],
    listSessions: async () => sessions.filter(s => s.agent === agent),
    createSession: async (target: any) => {
      events.push({ type: "session", agent, target });
      const session = { nativeId: "session-" + ++sequence, title: "普通对话", projectId: target.projectId, agent };
      sessions.push(session); return session;
    },
    resumeSession: async (session: any) => session,
    sendTurn: async (session: any, text: string, id: string, hooks: any) => {
      events.push({ type: "send", agent, session, text }); hooks?.started?.(id);
      return { turnId: id, text: "已完成" };
    },
  } as AgentAdapter]));
  const core = new BridgeCore(join(directory, "bridge.sqlite"), adapters);
  core.bindChannel("weixin", "bot", "owner");
  core.setRoutingSettings({ mode: "auto" });
  const choose = (id: string) => { core.routeDecision = async (_context, actions) => {
    offered.push(actions.map(a => a.id));
    return { choice: id, confidence: 1, probabilities: { [id]: 1 } };
  }; };
  const send = async (text: string) => {
    const receipt = core.receive({ kind: "weixin", accountId: "bot", peerId: "owner", eventId: String(++sequence) } as Origin, text);
    if (receipt.jobId) await core.run(receipt.jobId); return receipt;
  };
  return { core, directory, events, offered, choose, send,
    close() { core.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("asking to create a project inside a conversation goes to that conversation unchanged", async () => {
  const f = fixture();
  try {
    f.choose("new_codex_none"); await f.send("你好");
    f.choose("continue"); await f.send("在这里创建一个卡牌游戏项目");
    const sends = f.events.filter(e => e.type === "send");
    assert.equal(f.events.filter(e => e.type === "session").length, 1);
    assert.deepEqual(sends.map(e => e.text), ["你好", "在这里创建一个卡牌游戏项目"]);
    assert.equal(sends[1].session.nativeId, sends[0].session.nativeId);
    assert.equal(readdirSync(f.directory).includes("Workspaces"), false, "Chat Bridge creates no project directory");
  } finally { f.close(); }
});

test("asking to create a project with no conversation starts a projectless session and sends the request as is", async () => {
  const f = fixture();
  try {
    f.choose("new_codex_none"); await f.send("用 Codex 创建名为“远程卡牌”的项目，先给出方案。");
    assert.deepEqual(f.events.map(e => e.type), ["session", "send"]);
    assert.equal(f.events[0].target.projectId, null);
    assert.equal(f.events[1].text, "用 Codex 创建名为“远程卡牌”的项目，先给出方案。");
    assert.equal(f.offered[0]!.some(id => id.startsWith("new_project_")), false, "no bridge-side project creation is offered");
  } finally { f.close(); }
});
