import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeCore, type AgentAdapter } from "../src/core.js";
import { OutboxDispatcher } from "../src/delivery.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "bridge-delivery-"));
  const adapter: AgentAdapter = { probe: async () => ({ ready: false, reason: "not ready" }),
    createSession: async () => { throw new Error("unexpected"); }, resumeSession: async () => { throw new Error("unexpected"); },
    sendTurn: async () => { throw new Error("unexpected"); } };
  const core = new BridgeCore(join(directory, "bridge.sqlite"), { codex: adapter });
  core.bindChannel("weixin", "bot", "owner");
  const origin = { kind: "weixin" as const, accountId: "bot", peerId: "owner", eventId: "e1" };
  return { core, origin, close() { core.close(); rmSync(directory, { recursive: true, force: true }); } };
}
test("unavailable agents return a durable status card with recovery commands", async () => {
  const f = fixture();
  try {
    const job = f.core.receive(f.origin, "task");
    await f.core.run(job.jobId!);
    const status = f.core.outbox().find((entry) => entry.kind === "status");
    assert.ok(status);
    assert.match(status.text, /任务未发送/);
    assert.match(status.text, new RegExp("/continue " + job.jobId));
  } finally { f.close(); }
});
test("concurrent drains submit each reply once and never claim delivery", async () => {
  const f = fixture();
  try {
    f.core.receive(f.origin, "/status");
    const sentIDs: string[] = [];
    const dispatcher = new OutboxDispatcher(f.core, "weixin", () => true, async (entry) => { sentIDs.push(entry.id); });
    await Promise.all([dispatcher.drain(), dispatcher.drain(), dispatcher.drain()]);
    assert.deepEqual(sentIDs, f.core.outbox().map((entry) => entry.id));
    assert.ok(f.core.outbox().every((entry) => entry.status === "submitted"));
  } finally { f.close(); }
});
test("ambiguous send is recorded without retry and missing context stays pending", async () => {
  const f = fixture();
  try {
    f.core.receive(f.origin, "/status");
    let ready = false, sends = 0;
    const dispatcher = new OutboxDispatcher(f.core, "weixin", () => ready, async () => { sends++; throw new Error("network secret"); });
    await dispatcher.drain();
    assert.ok(f.core.outbox().every((entry) => entry.status === "pending"));
    ready = true;
    await dispatcher.drain(); await dispatcher.drain();
    assert.equal(sends, 2);
    assert.ok(f.core.outbox().every((entry) => entry.status === "delivery_unknown"));
    assert.ok(!JSON.stringify(f.core.outbox()).includes("network secret"));
  } finally { f.close(); }
});
test("split replies are persisted before dispatch and stop after an ambiguous fragment", async () => {
  const f = fixture();
  try {
    f.core.enqueueReply("long-result", f.origin, "结果".repeat(2000), "final");
    assert.ok(f.core.outbox().filter((entry) => entry.kind === "final").length > 2);
    let sends = 0;
    const dispatcher = new OutboxDispatcher(f.core, "weixin", () => true, async (entry) => { if (entry.kind === "final" && ++sends === 2) throw new Error("lost response"); });
    await dispatcher.drain();
    assert.equal(sends, 2);
    const parts = f.core.outbox().filter((entry) => entry.kind === "final");
    assert.equal(parts[0]?.status, "submitted");
    assert.equal(parts[1]?.status, "delivery_unknown");
    assert.ok(parts.slice(2).every((entry) => entry.status === "cancelled"));
  } finally { f.close(); }
});
