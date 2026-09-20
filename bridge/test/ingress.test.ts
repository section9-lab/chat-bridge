import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { BridgeCore, type AgentAdapter, type ChannelEvent } from "../src/core.js";

const adapter: AgentAdapter = {
  probe: async () => ({ ready: false, reason: "unverified" }),
  createSession: async () => { throw new Error("unexpected"); },
  resumeSession: async () => { throw new Error("unexpected"); },
  sendTurn: async () => { throw new Error("unexpected"); },
};
function fixture(runtime = adapter) {
  const directory = mkdtempSync(join(tmpdir(), "chat-bridge-ingress-")), db = join(directory, "bridge.sqlite");
  const core = new BridgeCore(db, { codex: runtime, claude: runtime });
  core.bindChannel("weixin", "bot", "owner");
  return { core, db, close() { core.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const event = (id: string, text = "do work", peerId = "owner"): ChannelEvent => ({
  origin: { kind: "weixin", accountId: "bot", peerId, eventId: id }, text, sealedContext: "encrypted-token",
});

test("durable batch commits inbox, queue, context and cursor before a destination receipt", () => {
  const f = fixture();
  try {
    const [receipt] = f.core.ingestBatch("weixin", "bot", "cursor-1", [event("m1")]);
    assert.ok(receipt?.jobId);
    assert.equal(f.core.checkpoint("weixin", "bot"), "cursor-1");
    assert.equal(f.core.context("weixin", "bot", "owner"), "encrypted-token");
    assert.equal(f.core.pendingJobs().length, 1);
    assert.equal(f.core.outbox().filter((item) => item.kind === "receipt").length, 0);
    const db = new Database(f.db, { readonly: true });
    try { assert.deepEqual(JSON.parse((db.prepare("SELECT receipt FROM inbox").get() as { receipt: string }).receipt), receipt); }
    finally { db.close(); }
  } finally { f.close(); }
});

test("cursor and all events roll back when inbox persistence fails", () => {
  const f = fixture();
  try {
    f.core.ingestBatch("weixin", "bot", "before", []);
    const previousOutbox = f.core.outbox();
    const db = new Database(f.db);
    db.exec("CREATE TRIGGER disk_failure BEFORE INSERT ON inbox BEGIN SELECT RAISE(ABORT, 'disk fixture failure'); END");
    db.close();
    let notifications = 0;
    f.core.onChange = () => { notifications++; };
    assert.throws(() => f.core.ingestBatch("weixin", "bot", "after", [event("m1")]), /disk fixture/);
    assert.equal(f.core.checkpoint("weixin", "bot"), "before");
    assert.equal(f.core.state().jobs.length, 0);
    assert.deepEqual(f.core.outbox(), previousOutbox);
    assert.equal(notifications, 0);
  } finally { f.close(); }
});

test("replayed native messages do not create another task or destination receipt", async () => {
  let sends = 0;
  const f = fixture({ ...adapter, probe: async () => ({ ready: true, reason: "fixture" }),
    createSession: async () => ({ nativeId: "new", title: "新会话", projectId: null }),
    sendTurn: async () => { sends++; return { turnId: "turn", text: "完成" }; } });
  try {
    const first = f.core.ingestBatch("weixin", "bot", "one", [event("same")]);
    const second = f.core.ingestBatch("weixin", "bot", "two", [event("same")]);
    assert.ok(first[0]?.jobId);
    assert.equal(second[0]?.jobId, first[0]?.jobId);
    assert.equal(f.core.state().jobs.length, 1);
    assert.equal(f.core.outbox().filter((entry) => entry.kind === "receipt").length, 0);
    await f.core.run(first[0]!.jobId!);
    await f.core.run(second[0]!.jobId!);
    f.core.ingestBatch("weixin", "bot", "three", [event("same")]);
    assert.equal(sends, 1);
    assert.equal(f.core.outbox().filter((entry) => entry.kind === "receipt").length, 1);
  } finally { f.close(); }
});

test("strangers cannot change selection or write a context token", () => {
  const f = fixture();
  try {
    assert.equal(f.core.isBound(event("owner").origin), true);
    const previousOutbox = f.core.outbox();
    f.core.ingestBatch("weixin", "bot", "seen", [event("stranger", "/agent claude", "stranger")]);
    assert.equal(f.core.context("weixin", "bot", "stranger"), undefined);
    assert.equal(f.core.state().selection.agent, "codex");
    assert.deepEqual(f.core.outbox(), previousOutbox);
  } finally { f.close(); }
});

test("unsupported media and invalid commands get durable rejections without blocking a batch", () => {
  const f = fixture();
  try {
    const media = { ...event("media", ""), rejection: "当前只支持文字，附件未执行。" };
    f.core.ingestBatch("weixin", "bot", "seen", [media, event("bad", "/agent cursor"), event("good", "/status")]);
    assert.equal(f.core.outbox().filter((entry) => entry.kind === "receipt").length, 3);
    assert.equal(f.core.state().jobs.length, 0);
    assert.equal(f.core.checkpoint("weixin", "bot"), "seen");
  } finally { f.close(); }
});

test("interrupted outbox dispatch becomes unknown after restart, without automatic retry", () => {
  const f = fixture();
  try {
    f.core.ingestBatch("weixin", "bot", "c", [event("status", "/status")]);
    const entry = f.core.outbox().find((entry) => entry.kind === "receipt");
    assert.ok(entry);
    f.core.markDelivery(entry.id, "dispatching");
    f.core.close();
    const restored = new BridgeCore(f.db, { codex: adapter, claude: adapter });
    try {
      assert.equal(restored.outbox().find((item) => item.id === entry.id)?.status, "delivery_unknown");
      assert.throws(() => restored.markDelivery(entry.id, "dispatching"), /INVALID_STATE/);
    } finally { restored.close(); }
  } finally { f.close(); }
});

test("unbinding prevents pending task execution and queued replies", () => {
  const f = fixture();
  try {
    f.core.ingestBatch("weixin", "bot", "c", [event("task")]);
    assert.equal(f.core.pendingJobs().length, 1);
    f.core.unbindChannel("weixin");
    assert.equal(f.core.isBound(event("owner").origin), false);
    assert.equal(f.core.pendingJobs().length, 0);
    assert.equal(f.core.state().jobs[0]?.status, "cancelled");
    assert.ok(f.core.outbox().every((entry) => entry.status === "cancelled"));
  } finally { f.close(); }
});
