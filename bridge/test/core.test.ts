import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { BridgeCore, type AgentAdapter, type NativeSession, type Target } from "../src/core.js";
import { OutboxDispatcher } from "../src/delivery.js";

class FixtureAgent implements AgentAdapter {
  creates = 0;
  sends: Array<{ nativeId: string; text: string }> = [];
  ready = true;
  missing = false;
  failSend = false;
  beforeCreate?: () => Promise<void>;
  async probe() { return { ready: this.ready, reason: "桌面接入尚未验证" }; }
  async createSession(target: Target): Promise<NativeSession> {
    this.creates++;
    await this.beforeCreate?.();
    return { nativeId: "native-" + this.creates, title: "Test session", projectId: target.projectId };
  }
  async resumeSession(session: NativeSession) {
    if (this.missing) throw new Error("TARGET_MISSING");
    return session;
  }
  async sendTurn(session: NativeSession, text: string) {
    this.sends.push({ nativeId: session.nativeId, text });
    if (this.failSend) throw new Error("transport closed after dispatch");
    return { turnId: "turn-" + this.sends.length, text: "完成：" + text };
  }
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "chat-bridge-test-"));
  const db = join(directory, "bridge.sqlite");
  const codex = new FixtureAgent();
  const claude = new FixtureAgent();
  const core = new BridgeCore(db, { codex, claude });
  return { core, codex, claude, db, close() { core.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const desktop = (eventId: string) => ({ kind: "desktop" as const, accountId: "local", peerId: "local", eventId });

test("first message creates one projectless session and later messages reuse it", async () => {
  const f = fixture();
  try {
    const first = f.core.receive(desktop("1"), "first");
    await f.core.run(first.jobId!);
    const second = f.core.receive(desktop("2"), "second");
    await f.core.run(second.jobId!);
    assert.equal(f.codex.creates, 1);
    assert.equal(f.core.state().selection.projectId, null);
    assert.equal(f.codex.sends[0]?.nativeId, f.codex.sends[1]?.nativeId);
  } finally { f.close(); }
});

test("pending messages share the same creation reservation", async () => {
  const f = fixture();
  try {
    const a = f.core.receive(desktop("1"), "one");
    const b = f.core.receive(desktop("2"), "two");
    await Promise.all([f.core.run(a.jobId!), f.core.run(b.jobId!)]);
    assert.equal(f.codex.creates, 1);
    assert.deepEqual(f.codex.sends.map((x) => x.text), ["one", "two"]);
  } finally { f.close(); }
});

test("duplicate native event is accepted only once", async () => {
  const f = fixture();
  try {
    const a = f.core.receive(desktop("same"), "run once");
    const b = f.core.receive(desktop("same"), "run once");
    assert.equal(a.jobId, b.jobId);
    await f.core.run(a.jobId!);
    await f.core.run(b.jobId!);
    assert.equal(f.codex.sends.length, 1);
  } finally { f.close(); }
});

test("unbound social messages and self echoes never create jobs", () => {
  const f = fixture();
  try {
    assert.throws(() => f.core.receive({ kind: "imessage", accountId: "mail", peerId: "stranger", eventId: "1" }, "run"), /UNAUTHORIZED/);
    f.core.bindChannel("imessage", "mail", "owner");
    assert.throws(() => f.core.receive({ kind: "imessage", accountId: "mail", peerId: "owner", eventId: "2", fromSelf: true }, "echo"), /ECHO/);
    assert.equal(f.core.state().jobs.length, 0);
  } finally { f.close(); }
});

test("channels share selection but completed replies keep their origin", async () => {
  const f = fixture();
  try {
    f.core.bindChannel("imessage", "mail", "owner-phone");
    f.core.bindChannel("weixin", "bot", "owner-weixin");
    const a = f.core.receive({ kind: "imessage", accountId: "mail", peerId: "owner-phone", eventId: "a" }, "first");
    await f.core.run(a.jobId!);
    const b = f.core.receive({ kind: "weixin", accountId: "bot", peerId: "owner-weixin", eventId: "b" }, "second");
    await f.core.run(b.jobId!);
    assert.equal(f.codex.creates, 1);
    assert.deepEqual(f.core.outbox().filter((x) => x.kind === "final").map((x) => x.origin.kind), ["imessage", "weixin"]);
    assert.deepEqual(f.core.outbox().filter((x) => x.kind === "receipt").map((x) => x.origin.kind), ["imessage", "weixin"]);
  } finally { f.close(); }
});

test("changing agent never retargets an already accepted job", async () => {
  const f = fixture();
  try {
    const job = f.core.receive(desktop("1"), "stay in Codex");
    f.core.receive(desktop("2"), "/agent claude");
    await f.core.run(job.jobId!);
    assert.equal(f.codex.sends.length, 1);
    assert.equal(f.claude.sends.length, 0);
    assert.equal(f.core.state().selection.agent, "claude");
  } finally { f.close(); }
});

test("twenty avatar clicks create exactly one session", async () => {
  const f = fixture();
  try {
    await Promise.all(Array.from({ length: 20 }, () => f.core.openAgent("codex")));
    assert.equal(f.codex.creates, 1);
    assert.equal(f.core.state().sessions.length, 1);
  } finally { f.close(); }
});

test("late creation saves its session without stealing the last selection", async () => {
  const f = fixture();
  let release!: () => void;
  f.codex.beforeCreate = () => new Promise<void>((resolve) => { release = resolve; });
  try {
    const a = f.core.openAgent("codex");
    await new Promise((resolve) => setImmediate(resolve));
    await f.core.openAgent("claude");
    release();
    await a;
    assert.equal(f.core.state().selection.agent, "claude");
    assert.equal(f.core.state().sessions.length, 2);
    await f.core.openAgent("codex");
    assert.equal(f.codex.creates, 1);
  } finally { f.close(); }
});

test("agents without a registered runtime can be pinned but cannot become active or default", async () => {
  const f = fixture();
  try {
    f.core.setPreferences({ pinned: ["codex", "cursor", "hermes"] });
    await assert.rejects(f.core.openAgent("cursor"), /AGENT_UNAVAILABLE/);
    assert.throws(() => f.core.setPreferences({ defaultAgent: "cursor" }), /AGENT_UNAVAILABLE/);
    assert.equal(f.core.state().selection.agent, "codex");
    assert.deepEqual(f.core.state().preferences.pinned, ["codex", "cursor", "hermes"]);
  } finally { f.close(); }
});

test("unverified adapters cannot create or send sessions", async () => {
  const f = fixture();
  f.codex.ready = false;
  try {
    await assert.rejects(f.core.openAgent("codex"), /AGENT_UNAVAILABLE/);
    const job = f.core.receive(desktop("1"), "task");
    await f.core.run(job.jobId!);
    assert.equal(f.codex.creates, 0);
    assert.equal(f.codex.sends.length, 0);
    assert.equal(f.core.state().jobs[0]?.status, "waiting_agent");
  } finally { f.close(); }
});

test("known missing session does not silently create a replacement", async () => {
  const f = fixture();
  try {
    await f.core.openAgent("codex");
    const sessionId = f.core.state().selection.sessionId;
    f.codex.missing = true;
    await assert.rejects(f.core.openAgent("codex"), /TARGET_MISSING/);
    assert.equal(f.core.state().selection.sessionId, sessionId);
    assert.equal(f.codex.creates, 1);
  } finally { f.close(); }
});

test("selection and display preferences survive process restart", async () => {
  const f = fixture();
  try {
    await f.core.openAgent("claude");
    f.core.setPreferences({ pinned: ["claude", "cursor"], keepAlive: true });
    const id = f.core.state().selection.sessionId;
    f.core.close();
    const restored = new BridgeCore(f.db, { codex: f.codex, claude: f.claude });
    assert.equal(restored.state().selection.sessionId, id);
    assert.deepEqual(restored.state().preferences.pinned, ["claude", "cursor"]);
    assert.equal(restored.state().preferences.keepAlive, true);
    restored.close();
  } finally { f.close(); }
});

test("transport failure after dispatch is uncertain and is not auto-retried", async () => {
  const f = fixture();
  f.codex.failSend = true;
  try {
    const job = f.core.receive(desktop("1"), "may have run");
    await f.core.run(job.jobId!);
    assert.equal(f.core.state().jobs[0]?.status, "uncertain");
    await f.core.run(job.jobId!);
    assert.equal(f.codex.sends.length, 1);
  } finally { f.close(); }
});

test("changing the default agent leaves an existing selection untouched", async () => {
  const f = fixture();
  try {
    await f.core.openAgent("codex");
    f.core.setPreferences({ defaultAgent: "claude" });
    assert.equal(f.core.state().selection.agent, "codex");
  } finally { f.close(); }
});

test("new clears the active session and does not reuse it through the avatar", async () => {
  const f = fixture();
  try {
    await f.core.openAgent("codex");
    const before = f.core.state().selection.sessionId;
    f.core.receive(desktop("new"), "/new");
    await f.core.openAgent("codex");
    assert.notEqual(f.core.state().selection.sessionId, before);
    assert.equal(f.codex.creates, 2);
  } finally { f.close(); }
});

test("display changes preserve an unconfirmed selection and default changes advance its version", async () => {
  const f = fixture();
  f.codex.ready = false;
  try {
    await assert.rejects(f.core.openAgent("codex"), /AGENT_UNAVAILABLE/);
    const before = f.core.state().selection;
    f.core.setPreferences({ pinned: ["codex", "cursor"] });
    assert.deepEqual(f.core.state().selection, before);
    f.core.setPreferences({ defaultAgent: "claude" });
    assert.equal(f.core.state().selection.agent, "claude");
    assert.equal(f.core.state().selection.version, before.version + 1);
  } finally { f.close(); }
});

test("cancel prevents an accepted task from reaching the agent", async () => {
  const f = fixture();
  try {
    const job = f.core.receive(desktop("new"), "do not execute");
    f.core.receive(desktop("cancel"), "/cancel " + job.jobId);
    await f.core.run(job.jobId!);
    assert.equal(f.core.state().jobs[0]?.status, "cancelled");
    assert.equal(f.codex.creates, 0);
    assert.equal(f.codex.sends.length, 0);
  } finally { f.close(); }
});

test("cancel during session preparation never sends the prompt", async () => {
  const f = fixture();
  let release!: () => void;
  f.codex.beforeCreate = () => new Promise<void>((resolve) => { release = resolve; });
  try {
    const job = f.core.receive(desktop("new"), "do not send");
    const running = f.core.run(job.jobId!);
    await new Promise((resolve) => setImmediate(resolve));
    f.core.receive(desktop("cancel"), "/cancel " + job.jobId);
    release(); await running;
    assert.equal(f.core.state().jobs[0]?.status, "cancelled");
    assert.equal(f.codex.sends.length, 0);
  } finally { f.close(); }
});

test("continue preserves the waiting task target even after switching agent", async () => {
  const f = fixture();
  f.codex.ready = false;
  try {
    const job = f.core.receive(desktop("task"), "original target");
    await f.core.run(job.jobId!);
    f.core.receive(desktop("switch"), "/agent claude");
    f.codex.ready = true;
    const resumed = f.core.receive(desktop("continue"), "/continue " + job.jobId);
    assert.equal(resumed.jobId, job.jobId);
    await f.core.run(resumed.jobId!);
    assert.equal(f.codex.sends.length, 1);
    assert.equal(f.claude.sends.length, 0);
    assert.equal(f.core.state().selection.agent, "claude");
    f.core.receive(desktop("continue"), "/continue " + job.jobId);
    await f.core.run(resumed.jobId!);
    assert.equal(f.codex.sends.length, 1);
  } finally { f.close(); }
});

test("expired tasks require explicit continue before dispatch", async () => {
  const f = fixture();
  try {
    const receipt = f.core.receive(desktop("old"), "old prompt");
    const job = f.core.state().jobs[0]!;
    job.createdAt = new Date(Date.now() - 25 * 3600_000).toISOString();
    const db = new Database(f.db);
    db.prepare("UPDATE records SET data=? WHERE kind='job' AND id=?").run(JSON.stringify(job), job.id);
    db.close();
    await f.core.run(receipt.jobId!);
    assert.equal(f.core.state().jobs[0]?.status, "awaiting_confirmation");
    const resumed = f.core.receive(desktop("resume"), "/continue " + receipt.jobId);
    await f.core.run(resumed.jobId!);
    assert.equal(f.codex.sends.length, 1);
    assert.equal(f.core.state().jobs[0]?.createdAt, job.createdAt);
  } finally { f.close(); }
});

test("continue and cancel cannot erase an uncertain send", async () => {
  const f = fixture();
  f.codex.failSend = true;
  try {
    const job = f.core.receive(desktop("task"), "uncertain");
    await f.core.run(job.jobId!);
    assert.throws(() => f.core.receive(desktop("continue"), "/continue " + job.jobId), /SEND_UNCERTAIN/);
    assert.throws(() => f.core.receive(desktop("cancel"), "/cancel " + job.jobId), /SEND_UNCERTAIN/);
    assert.equal(f.core.state().jobs[0]?.status, "uncertain");
    assert.equal(f.codex.sends.length, 1);
  } finally { f.close(); }
});

test("closing during session preparation preserves uncertainty and never dispatches the prompt", async () => {
  const f = fixture();
  let release!: () => void;
  f.codex.beforeCreate = () => new Promise<void>((resolve) => { release = resolve; });
  try {
    const receipt = f.core.receive(desktop("shutdown"), "do not dispatch after shutdown");
    const pending = f.core.run(receipt.jobId!);
    await new Promise((resolve) => setImmediate(resolve));
    f.core.close(); release();
    await pending;
    assert.equal(f.codex.sends.length, 0);
    const restored = new BridgeCore(f.db, { codex: f.codex });
    try {
      await restored.run(receipt.jobId!);
      assert.equal(restored.state().jobs[0]?.status, "uncertain");
      assert.equal(f.codex.creates, 1);
    } finally { restored.close(); }
  } finally { f.close(); }
});

test("reconnecting the same owner cannot deliver a late result from a revoked binding", async () => {
  const f = fixture();
  let release!: () => void;
  f.codex.sendTurn = async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    return { turnId: "late-turn", text: "late result" };
  };
  try {
    f.core.bindChannel("weixin", "bot", "owner");
    const receipt = f.core.receive({ kind: "weixin", accountId: "bot", peerId: "owner", eventId: "old-binding" }, "work");
    const running = f.core.run(receipt.jobId!);
    await new Promise((resolve) => setImmediate(resolve));
    f.core.unbindChannel("weixin"); f.core.bindChannel("weixin", "bot", "owner");
    release(); await running;
    const sentKinds: (string | undefined)[] = [];
    await new OutboxDispatcher(f.core, "weixin", () => true, async (entry) => { sentKinds.push(entry.kind); }).drain();
    assert.deepEqual(sentKinds, ["onboarding"]);
    assert.equal(f.core.outbox().find((entry) => entry.kind === "final")?.status, "cancelled");
  } finally { f.close(); }
});
