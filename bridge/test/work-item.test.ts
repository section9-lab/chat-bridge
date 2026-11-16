import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeCore, type AgentAdapter, type NativeSession, type Target } from "../src/core.js";

class FixtureAgent implements AgentAdapter {
  creates = 0;
  sends: Array<{ nativeId: string; text: string }> = [];
  async probe() { return { ready: true, reason: "ready" }; }
  async createSession(target: Target): Promise<NativeSession> {
    this.creates++;
    return { nativeId: "native-" + this.creates, title: "Session " + this.creates, projectId: target.projectId };
  }
  async resumeSession(session: NativeSession) { return session; }
  async sendTurn(session: NativeSession, text: string) {
    this.sends.push({ nativeId: session.nativeId, text });
    return { turnId: "turn-" + this.sends.length, text: "完成：" + text };
  }
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "chat-bridge-work-item-"));
  const codex = new FixtureAgent();
  const core = new BridgeCore(join(directory, "bridge.sqlite"), { codex });
  return { core, codex, close() { core.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const desktop = (eventId: string) => ({ kind: "desktop" as const, accountId: "local", peerId: "local", eventId });

test("ordinary messages reuse one work item and one native session", async () => {
  const f = fixture();
  try {
    const first = f.core.receive(desktop("1"), "帮我修登录 bug");
    await f.core.run(first.jobId!);
    const second = f.core.receive(desktop("2"), "加个测试");
    await f.core.run(second.jobId!);

    const state = f.core.state();
    assert.equal(state.workItems.length, 1);
    assert.deepEqual(state.workItems[0]!.jobIds, [first.jobId, second.jobId]);
    assert.equal(state.workItems[0]!.target.sessionId, state.selection.sessionId);
    assert.equal(f.codex.creates, 1);
    assert.equal(f.codex.sends[0]!.nativeId, f.codex.sends[1]!.nativeId);
  } finally { f.close(); }
});

test("saying 任务 lists tasks without creating another job", async () => {
  const f = fixture();
  try {
    const first = f.core.receive(desktop("1"), "修复登录 bug");
    await f.core.run(first.jobId!);
    const jobs = f.core.state().jobs.length;

    const listing = f.core.receive(desktop("2"), "任务");
    assert.equal(listing.jobId, undefined);
    assert.match(listing.message ?? "", /修复登录 bug/u);
    assert.equal(f.core.state().jobs.length, jobs);
    assert.equal(f.core.state().workItems.length, 1);
    const alias = f.core.receive(desktop("3"), "/tasks");
    assert.equal(alias.jobId, undefined);
    assert.match(alias.message ?? "", /修复登录 bug/u);
  } finally { f.close(); }
});

test("numbered task menu switches focus without sending the number", async () => {
  const f = fixture();
  try {
    const first = f.core.receive(desktop("1"), "修复登录 bug");
    await f.core.run(first.jobId!);
    const second = f.core.receive(desktop("2"), "新任务：写请假邮件");
    await f.core.run(second.jobId!);

    const listing = f.core.receive(desktop("3"), "任务");
    assert.match(listing.message ?? "", /写请假邮件/u);
    assert.match(listing.message ?? "", /修复登录 bug/u);

    const switched = f.core.receive(desktop("4"), "2");
    assert.equal(switched.jobId, undefined);
    assert.match(switched.message ?? "", /已切换/u);

    const followUp = f.core.receive(desktop("5"), "加个测试");
    const job = f.core.state().jobs.find((item) => item.id === followUp.jobId);
    assert.equal(job?.workItemId, f.core.state().workItems.find((item) => item.title === "修复登录 bug")?.id);
    assert.equal(f.codex.sends.length, 2);
  } finally { f.close(); }
});

test("new task clears focus and the next message creates another work item", async () => {
  const f = fixture();
  try {
    const first = f.core.receive(desktop("1"), "修复登录 bug");
    await f.core.run(first.jobId!);

    const cleared = f.core.receive(desktop("2"), "新任务");
    assert.equal(cleared.jobId, undefined);
    assert.match(cleared.message ?? "", /新任务/u);

    const second = f.core.receive(desktop("3"), "写请假邮件");
    await f.core.run(second.jobId!);
    assert.equal(f.core.state().workItems.length, 2);
    assert.equal(f.core.state().workItems[0]?.title, "写请假邮件");
    assert.equal(f.codex.creates, 2);
  } finally { f.close(); }
});

test("a task title switches focus and the next message joins that task", async () => {
  const f = fixture();
  try {
    const first = f.core.receive(desktop("1"), "修复登录 bug");
    await f.core.run(first.jobId!);
    const second = f.core.receive(desktop("2"), "新任务：写请假邮件");
    await f.core.run(second.jobId!);

    const switched = f.core.receive(desktop("3"), "继续登录 bug");
    assert.equal(switched.jobId, undefined);
    assert.match(switched.message ?? "", /修复登录 bug/u);

    const followUp = f.core.receive(desktop("4"), "加个测试");
    const job = f.core.state().jobs.find((item) => item.id === followUp.jobId);
    assert.equal(job?.workItemId, f.core.state().workItems.find((item) => item.title === "修复登录 bug")?.id);
  } finally { f.close(); }
});

test("inline new task content creates a work item immediately", async () => {
  const f = fixture();
  try {
    const first = f.core.receive(desktop("1"), "修复登录 bug");
    await f.core.run(first.jobId!);
    const second = f.core.receive(desktop("2"), "新任务：写请假邮件");
    assert.ok(second.jobId);
    await f.core.run(second.jobId!);
    assert.equal(f.core.state().workItems.length, 2);
    assert.equal(f.core.state().workItems[0]?.title, "写请假邮件");
    assert.equal(f.core.state().focus.workItemId, f.core.state().workItems[0]?.id);
  } finally { f.close(); }
});
