import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeCore, type AgentAdapter } from "../src/core.js";

const answer = (choice: string) => ({ choice, confidence: 1, probabilities: { [choice]: 1 } });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "bridge-lookup-"));
  const adapters: Record<string, AgentAdapter> = Object.fromEntries(["codex", "claude"].map((agent) => [agent, {
    probe: async () => ({ ready: true, reason: "Fixture" }),
    listProjects: async () => [], listSessions: async () => [],
    createSession: async () => ({ nativeId: "s1", projectId: null, title: "会话" }),
    resumeSession: async (session) => session,
    sendTurn: async () => { throw new Error("a bridge-introspection question must never reach an agent"); },
  } satisfies AgentAdapter]));
  const core = new BridgeCore(join(directory, "bridge.sqlite"), adapters);
  core.bindChannel("weixin", "bot", "owner");
  core.setRoutingSettings({ mode: "auto" });
  const origin = { kind: "weixin" as const, accountId: "bot", peerId: "owner", eventId: "e1" };
  return { core, origin, close() { core.close(); rmSync(directory, { recursive: true, force: true }); } };
}

// These questions used to be intercepted locally before ever reaching Jev. Now Jev classifies
// them like any other message; this only asserts the safety property that mattered: a confident
// bridge-introspection answer never reaches a real agent and never leaves a job behind.
test("a confident 'which agents' classification answers with the list and creates no job", async () => {
  const f = fixture();
  try {
    f.core.routeDecision = async () => answer("list_agents");
    const receipt = f.core.receive(f.origin, "你现在支持哪些Agent?");
    if (receipt.jobId) await f.core.run(receipt.jobId);
    assert.match(f.core.outbox().at(-1)!.text, /Codex/);
    assert.equal(f.core.state().jobs.filter((job) => job.status !== "completed").length, 0);
  } finally { f.close(); }
});

test("a confident status classification reads the status summary without dispatching", async () => {
  const f = fixture();
  try {
    f.core.routeDecision = async () => answer("list_status");
    const receipt = f.core.receive(f.origin, "现在用的是什么Agent？");
    if (receipt.jobId) await f.core.run(receipt.jobId);
    assert.match(f.core.outbox().at(-1)!.text, /Codex/);
    assert.doesNotMatch(f.core.outbox().at(-1)!.text, /现在用的是什么Agent|正在判断目标/, "the question itself is not listed as a pending task");
  } finally { f.close(); }
});

test("a confident help classification returns the command guide without dispatching", async () => {
  const f = fixture();
  try {
    f.core.routeDecision = async () => answer("help");
    const receipt = f.core.receive(f.origin, "怎么用这个？");
    if (receipt.jobId) await f.core.run(receipt.jobId);
    assert.match(f.core.outbox().at(-1)!.text, /命令指南/);
  } finally { f.close(); }
});
