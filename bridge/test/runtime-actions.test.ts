import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeCore, BridgeError, type AgentAdapter, type TurnHooks, type TurnResult } from "../src/core.js";

const local = (eventId: string) => ({ kind: "desktop" as const, accountId: "local", peerId: "local", eventId });
const remote = (eventId: string) => ({ kind: "weixin" as const, accountId: "bot", peerId: "owner", eventId });
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "bridge-actions-"));
  const path = join(directory, "bridge.sqlite");
  let hooks: TurnHooks | undefined, finish!: (value: TurnResult) => void;
  const decisions: string[] = [], stops: string[] = [];
  const adapter: AgentAdapter = {
    probe: async () => ({ ready: true, reason: "" }),
    createSession: async () => ({ nativeId: "thread", projectId: null, title: "Test" }),
    resumeSession: async (session) => session,
    async sendTurn(_session, _text, _id, events) {
      hooks = events; hooks?.started?.("native-turn");
      return new Promise((resolve) => { finish = resolve; });
    },
    async stopTurn(id) { stops.push(id); finish({ turnId: "native-turn", status: "interrupted", text: "stopped" }); }
  };
  const core = new BridgeCore(path, { codex: adapter }); core.bindChannel("weixin", "bot", "owner");
  return { core, adapter, path, decisions, stops,
    finish: (status: TurnResult["status"]) => finish({ turnId: "native-turn", text: "result", status }),
    approval() { return hooks?.approval?.({ kind: "command", detail: "echo fixture", cwd: directory, reason: "需要确认" }).then((decision) => { decisions.push(decision); return decision; }); },
    close() { core.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("live native turns expose an exact ID and accept stop without claiming an unsent cancellation", async () => {
  const f = fixture();
  try {
    const receipt = f.core.receive(local("send"), "task"); const run = f.core.run(receipt.jobId!); await settle();
    assert.equal(f.core.state().jobs[0]?.status, "running");
    assert.equal(f.core.state().jobs[0]?.turnId, "native-turn");
    f.core.receive(local("stop"), "/stop " + receipt.jobId); await run;
    assert.equal(f.core.state().jobs[0]?.status, "interrupted");
    assert.deepEqual(f.stops, [receipt.jobId]);
  } finally { f.close(); }
});

test("approval is persisted and sent only to the frozen task origin; unrelated peers cannot grant it", async () => {
  const f = fixture();
  try {
    const receipt = f.core.receive(remote("send"), "task"); const run = f.core.run(receipt.jobId!); await settle();
    const approval = f.approval(); await settle();
    const pending = (f.core.state() as any).approvals?.[0];
    assert.ok(pending?.id, "running task must expose its approval request");
    assert.equal(pending.status, "pending"); assert.equal(f.core.state().jobs[0]?.status, "awaiting_approval");
    assert.equal(f.decisions.length, 0);
    assert.match(f.core.outbox().find((entry) => entry.kind === "approval")!.text, new RegExp("/approve " + pending.id));
    f.core.bindChannel("imessage", "email", "phone");
    assert.throws(() => f.core.receive({ kind: "imessage", accountId: "email", peerId: "phone", eventId: "other" }, "/approve " + pending.id), /UNAUTHORIZED/);
    f.core.receive(remote("approve"), "/approve " + pending.id); assert.equal(await approval, "accept");
    assert.throws(() => f.core.receive(remote("repeat"), "/approve " + pending.id), /INVALID_STATE/);
    f.finish("completed"); await run;
  } finally { f.close(); }
});

test("denial and channel removal cannot leave a live approval waiting", async () => {
  const f = fixture();
  try {
    const receipt = f.core.receive(remote("send"), "task"); const run = f.core.run(receipt.jobId!); await settle();
    const approval = f.approval(); await settle();
    assert.ok((f.core.state() as any).approvals?.length, "approval must exist before channel removal");
    f.core.unbindChannel("weixin"); assert.equal(await approval, "decline");
    f.finish("completed"); await run;
    assert.ok(!f.core.outbox().some((entry) => entry.kind === "approval" && entry.status === "pending"));
  } finally { f.close(); }
});

test("failed native completion is terminal failure and never a completed task", async () => {
  const f = fixture();
  try {
    const receipt = f.core.receive(local("send"), "task"); const run = f.core.run(receipt.jobId!); await settle();
    f.finish("failed"); await run;
    assert.equal(f.core.state().jobs[0]?.status, "failed");
  } finally { f.close(); }
});

test("restart expires approvals and marks submitted turns uncertain instead of replaying them", async () => {
  const f = fixture();
  try {
    const receipt = f.core.receive(remote("send"), "task"); const run = f.core.run(receipt.jobId!); await settle();
    const approval = f.approval(); await settle();
    assert.ok((f.core.state() as any).approvals?.length, "approval must be persisted");
    f.core.close(); assert.equal(await approval, "decline"); f.finish("completed"); await run;
    const restored = new BridgeCore(f.path, { codex: f.adapter });
    try { assert.equal(restored.state().jobs[0]?.status, "uncertain"); assert.equal((restored.state() as any).approvals[0].status, "expired");
      assert.equal(restored.outbox().filter((entry) => entry.kind === "approval" && entry.status === "pending").length, 0); }
    finally { restored.close(); }
  } finally { f.close(); }
});

test("desktop-owned queued turns expose their state and leave stop and approval controls in the original app", async () => {
  const f = fixture();
  let events: TurnHooks | undefined, finish!: (value: TurnResult) => void;
  f.adapter.sendTurn = async (_session, _text, _id, hooks) => {
    events = hooks; (hooks as any)?.queued?.();
    return new Promise((resolve) => { finish = resolve; });
  };
  try {
    const receipt = f.core.receive(remote("send"), "continue original desktop session");
    const run = f.core.run(receipt.jobId!); await settle();
    assert.equal(f.core.state().jobs[0]?.status, "queued");
    assert.equal((f.core.state().jobs[0] as any).externalControl, true);
    const queuedStatus = f.core.receive(remote("queued-status"), "/status").message!;
    assert.match(queuedStatus, /原会话队列/);
    assert.doesNotMatch(queuedStatus, /停止：\/stop/);
    assert.throws(() => f.core.receive(remote("stop-queued"), "/stop " + receipt.jobId), /原会话/);
    events?.started?.("desktop-turn");
    assert.equal(f.core.state().jobs[0]?.status, "running");
    assert.throws(() => f.core.receive(remote("stop-running"), "/stop " + receipt.jobId), /原会话/);
    assert.equal(f.core.state().jobs[0]?.status, "running");
    assert.deepEqual(f.stops, []);
    f.core.close();
    finish({ turnId: "desktop-turn", text: "done", status: "completed" }); await run;
    const restored = new BridgeCore(f.path, { codex: f.adapter });
    try { assert.equal(restored.state().jobs[0]?.status, "uncertain"); }
    finally { restored.close(); }
  } finally { f.close(); }
});

test("restart never resubmits a message already accepted by the original desktop queue", async () => {
  const f = fixture();
  let finish!: (value: TurnResult) => void, submissions = 0;
  f.adapter.sendTurn = async (_session, _text, _id, hooks) => {
    submissions++; (hooks as any)?.queued?.();
    return new Promise((resolve) => { finish = resolve; });
  };
  try {
    const receipt = f.core.receive(remote("send"), "queued task"); const run = f.core.run(receipt.jobId!); await settle();
    f.core.close(); finish({ turnId: "desktop-turn", text: "done" }); await run;
    const restored = new BridgeCore(f.path, { codex: f.adapter });
    try {
      assert.equal(restored.state().jobs[0]?.status, "uncertain");
      await restored.run(receipt.jobId!);
      assert.equal(submissions, 1);
      assert.throws(() => restored.receive(remote("retry"), "/continue " + receipt.jobId), /SEND_UNCERTAIN/);
    } finally { restored.close(); }
  } finally { f.close(); }
});

test("a stop racing desktop queue acceptance reports external controls without losing execution tracking", async () => {
  const f = fixture();
  f.adapter.stopTurn = async () => { throw new BridgeError("EXTERNAL_CONTROL", "请在 Codex 原会话中停止。"); };
  try {
    const receipt = f.core.receive(remote("send"), "task"); const run = f.core.run(receipt.jobId!); await settle();
    f.core.receive(remote("stop"), "/stop " + receipt.jobId); await settle();
    assert.equal(f.core.state().jobs[0]?.status, "running");
    assert.equal(f.core.state().jobs[0]?.externalControl, true);
    assert.match(f.core.outbox().find((entry) => entry.kind === "status")!.text, /原会话/);
    f.finish("completed"); await run;
    assert.equal(f.core.state().jobs[0]?.status, "completed");
  } finally { f.close(); }
});
