import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { agentIDs, BridgeCore, BridgeError, type AgentAdapter, type Origin } from "../src/core.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "bridge-enabled-agents-")), database = join(directory, "bridge.sqlite");
  let sequence = 0;
  const sends: { agent: string; nativeId: string; text: string }[] = [];
  const adapters: Record<string, AgentAdapter> = Object.fromEntries(agentIDs.map(agent => [agent, {
    probe: async () => ({ ready: true, reason: "Fixture" }),
    createSession: async target => ({ nativeId: agent + "-" + ++sequence, title: "新会话", projectId: target.projectId }),
    resumeSession: async session => session,
    sendTurn: async (session, text) => { sends.push({ agent, nativeId: session.nativeId, text }); return { turnId: "turn-" + sends.length, text: "完成" }; },
  } satisfies AgentAdapter]));
  let core = new BridgeCore(database, adapters);
  core.bindChannel("weixin", "bot", "owner");
  const origin = (kind: Origin["kind"] = "weixin"): Origin => ({ kind, accountId: kind === "desktop" ? "local" : "bot",
    peerId: kind === "desktop" ? "local" : "owner", eventId: "event-" + ++sequence });
  async function send(text: string, kind: Origin["kind"] = "weixin") {
    const receipt = core.receive(origin(kind), text);
    if (receipt.jobId) await core.run(receipt.jobId);
    return receipt;
  }
  return { get core() { return core; }, database, sends, origin, send,
    // The whole latest phone reply, joined back together when it was split into parts.
    reply() { const outbox = core.outbox(), last = outbox.at(-1); return outbox.filter(entry => entry.batchId === last?.batchId).map(entry => entry.text).join("\n"); },
    restart() { core.close(); core = new BridgeCore(database, adapters); },
    close() { core.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("new stores enable every agent and stores saved before the picker keep every agent enabled", async () => {
  const f = fixture();
  try {
    assert.deepEqual(f.core.state().preferences.enabledAgents, [...agentIDs]);
    f.core.close();
    const db = new Database(f.database);
    db.prepare("UPDATE kv SET value=? WHERE key='preferences'").run(JSON.stringify({ defaultAgent: "claude", pinned: ["codex"], keepAlive: false, names: {} }));
    db.close();
    f.restart();
    assert.deepEqual(f.core.state().preferences.enabledAgents, [...agentIDs]);
    assert.equal(f.core.state().preferences.defaultAgent, "claude");
    await f.send("/agent cursor");
    assert.equal(f.core.state().selection.agent, "cursor");
    f.core.setPreferences({ keepAlive: true });
    assert.deepEqual(f.core.state().preferences.enabledAgents, [...agentIDs]);
  } finally { f.close(); }
});

test("enabled agents must be a non-empty list of unique known agents", () => {
  const f = fixture();
  try {
    for (const enabledAgents of [[], ["codex", "unknown"], ["codex", "codex"], "codex", [1], null]) {
      assert.throws(() => f.core.setPreferences({ enabledAgents } as never), { code: "INVALID_INPUT" });
    }
    assert.deepEqual(f.core.state().preferences.enabledAgents, [...agentIDs]);
    f.core.setPreferences({ enabledAgents: ["cursor", "codex"] });
    assert.deepEqual(f.core.state().preferences.enabledAgents, ["codex", "cursor"], "kept in the fixed agent order");
  } finally { f.close(); }
});

test("disabling the default agent moves the default to the first enabled agent", () => {
  const f = fixture();
  try {
    f.core.setPreferences({ enabledAgents: ["grok", "claude"] });
    assert.equal(f.core.state().preferences.defaultAgent, "claude");
    assert.equal(f.core.state().selection.agent, "claude", "an untouched selection follows the default");
    f.core.setPreferences({ defaultAgent: "grok" });
    f.core.setPreferences({ enabledAgents: ["codex", "grok"] });
    assert.equal(f.core.state().preferences.defaultAgent, "grok", "an enabled default is kept");
    f.core.setPreferences({ defaultAgent: "hermes" });
    assert.equal(f.core.state().preferences.defaultAgent, "codex", "a disabled default falls back as well");
  } finally { f.close(); }
});

test("/agent lists only enabled agents and a phone cannot switch to a disabled one", async () => {
  const f = fixture();
  try {
    await f.send("/agent claude", "desktop");
    await f.send("桌面会话", "desktop");
    const session = f.core.state().sessions.find(session => session.agent === "claude")!;
    await f.send("/agent codex", "desktop");
    f.core.setPreferences({ enabledAgents: ["codex", "grok"] });
    await f.send("/agent");
    assert.match(f.reply(), /Codex：/); assert.match(f.reply(), /Grok：/);
    assert.doesNotMatch(f.reply(), /Claude|Cursor|OpenCode|Hermes/);
    const cursor = await f.send("/agent cursor");
    assert.equal(cursor.message, "Cursor 未在 Chat Bridge 中启用，可在设置里开启。");
    assert.equal(f.reply(), cursor.message);
    const resume = await f.send("/use " + session.shortId);
    assert.equal(resume.message, "Claude 未在 Chat Bridge 中启用，可在设置里开启。");
    assert.equal(f.core.state().selection.agent, "codex");
    await f.send("/help");
    assert.match(f.reply(), /\/agent grok — /);
    assert.doesNotMatch(f.reply(), /\/agent (claude|cursor|opencode|hermes) — /);
  } finally { f.close(); }
});

test("a phone message to a disabled agent, including its existing session, is not dispatched", async () => {
  const f = fixture();
  try {
    await f.send("/agent claude");
    await f.send("第一条");
    assert.deepEqual(f.sends.map(send => send.agent), ["claude"]);
    f.core.setPreferences({ enabledAgents: ["codex", "cursor"] });
    const receipt = await f.send("继续");
    assert.equal(receipt.jobId, undefined);
    assert.equal(receipt.message, "Claude 未在 Chat Bridge 中启用，可在设置里开启。");
    assert.equal(f.reply(), receipt.message);
    await f.send("/sessions");
    assert.equal(f.reply(), receipt.message);
    f.core.setPreferences({ enabledAgents: [...agentIDs] });
    const queued = f.core.receive(f.origin(), "排队中的任务");
    f.core.setPreferences({ enabledAgents: ["codex"] });
    await f.core.run(queued.jobId!);
    const job = f.core.state().jobs.find(job => job.id === queued.jobId)!;
    assert.equal(job.status, "cancelled");
    assert.match(job.error!, /Claude 未在 Chat Bridge 中启用.*任务未发送/);
    assert.match(f.reply(), /任务未发送/);
    assert.equal(f.sends.length, 1);
  } finally { f.close(); }
});

test("the Mac app can still send to an explicitly selected disabled agent", async () => {
  const f = fixture();
  try {
    f.core.setPreferences({ enabledAgents: ["codex"] });
    await f.send("/agent claude", "desktop");
    assert.equal(f.core.state().selection.agent, "claude");
    await f.send("桌面任务", "desktop");
    await f.send("再来一条", "desktop");
    assert.deepEqual(f.sends.map(send => send.agent), ["claude", "claude"]);
    assert.equal(f.sends[0]!.nativeId, f.sends[1]!.nativeId);
    assert.ok(f.core.state().jobs.every(job => job.status === "completed"));
  } finally { f.close(); }
});
