import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeCore, BridgeError, type AgentAdapter, type Target } from "../src/core.js";

// When the conversation to continue is gone, or the project folder a new one needs is gone, the task
// still runs: in a fresh conversation in the same project if that works, otherwise without a project.
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "bridge-session-fallback-"));
  const state = { sessionGone: false, projectGone: false, sequence: 0 };
  const created: Target[] = [], sends: { nativeId: string; projectId: string | null; text: string }[] = [];
  const adapter: AgentAdapter = {
    probe: async () => ({ ready: true, reason: "Fixture" }),
    listProjects: async () => [{ id: "shop", name: "商城", roots: [directory] }],
    listSessions: async () => [{ nativeId: "old", title: "支付修复", projectId: "shop" }],
    createSession: async (target) => {
      if (target.projectId && state.projectGone) throw new BridgeError("TARGET_MISSING", "项目目录已不存在，请重新选择项目。");
      created.push(target);
      return { nativeId: "new-" + ++state.sequence, title: "新会话", projectId: target.projectId };
    },
    resumeSession: async (session) => {
      if (state.sessionGone) throw new BridgeError("TARGET_MISSING", "原会话不存在。");
      return session;
    },
    sendTurn: async (session, text) => { sends.push({ nativeId: session.nativeId, projectId: session.projectId, text }); return { turnId: "t", text: "完成" }; },
  };
  const core = new BridgeCore(join(directory, "bridge.sqlite"), { codex: adapter });
  core.bindChannel("weixin", "bot", "owner");
  let event = 0;
  const origin = () => ({ kind: "weixin" as const, accountId: "bot", peerId: "owner", eventId: "e" + ++event });
  const send = async (text: string) => { const receipt = core.receive(origin(), text); if (receipt.jobId) await core.run(receipt.jobId); return receipt; };
  const receipt = (jobId: string) => core.outbox().find((entry) => entry.jobId === jobId && entry.kind === "receipt")?.text ?? "";
  return { core, state, created, sends, send, receipt, origin, async ready() { await core.probeAgents(); await core.refreshCatalog("codex"); },
    close() { core.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("a conversation that no longer exists is replaced by a new one in the same project", async () => {
  const f = fixture();
  try {
    await f.ready();
    const old = f.core.state().sessions.find((s) => s.nativeId === "old")!;
    f.core.receive(f.origin(), "/use " + old.shortId);
    f.state.sessionGone = true;
    const job = await f.send("继续修复支付");
    assert.equal(f.core.state().jobs.find((j) => j.id === job.jobId)?.status, "completed");
    assert.deepEqual(f.sends, [{ nativeId: "new-1", projectId: "shop", text: "继续修复支付" }]);
    assert.match(f.receipt(job.jobId!), /原会话已不存在，已改在新会话中执行/);
    f.state.sessionGone = false;
    await f.send("再看一下");
    assert.equal(f.sends[1]?.nativeId, "new-1", "follow-ups go to the conversation that actually ran");
  } finally { f.close(); }
});

test("when the project folder is gone too, the replacement conversation has no project", async () => {
  const f = fixture();
  try {
    await f.ready();
    const old = f.core.state().sessions.find((s) => s.nativeId === "old")!;
    f.core.receive(f.origin(), "/use " + old.shortId);
    f.state.sessionGone = true; f.state.projectGone = true;
    const job = await f.send("继续修复支付");
    assert.equal(f.core.state().jobs.find((j) => j.id === job.jobId)?.status, "completed");
    assert.deepEqual(f.sends, [{ nativeId: "new-1", projectId: null, text: "继续修复支付" }]);
    assert.match(f.receipt(job.jobId!), /原会话已不存在，已改在无项目会话中执行/);
  } finally { f.close(); }
});

test("a new conversation in a project whose folder is gone starts without a project", async () => {
  const f = fixture();
  try {
    await f.ready();
    const project = f.core.state().projects.find((p) => p.id === "shop")!;
    f.core.receive(f.origin(), "/project " + project.shortId);
    f.state.projectGone = true;
    const job = await f.send("写个测试");
    assert.equal(f.core.state().jobs.find((j) => j.id === job.jobId)?.status, "completed");
    assert.deepEqual(f.sends, [{ nativeId: "new-1", projectId: null, text: "写个测试" }]);
    assert.match(f.receipt(job.jobId!), /原项目目录已不存在，已改在无项目会话中执行/);
    await f.send("继续");
    assert.equal(f.sends[1]?.nativeId, "new-1");
  } finally { f.close(); }
});
