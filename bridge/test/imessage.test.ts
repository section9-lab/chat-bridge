import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@photon-ai/imessage-kit";
import { BridgeCore, BridgeError } from "../src/core.js";
import { IMessageController } from "../src/imessage.js";
import type { IMessageSource } from "../src/imessage-source.js";

const phone = "+6591234567", email = "bridge@example.com", chatId = "iMessage;-;" + phone;
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "bridge-imessage-"));
  const core = new BridgeCore(join(directory, "bridge.sqlite"), {});
  const transport = { rows: [] as Message[], sent: [] as string[], attachments: [] as string[], opens: 0, closes: 0, validCursor: true, failSend: false,
    openError: undefined as Error | undefined, readError: undefined as Error | undefined, echo: true,
    sendGate: undefined as Promise<void> | undefined };
  const add = (text: string, overrides: Partial<Message> = {}) => {
    const rowId = transport.rows.length + 1;
    transport.rows.push({ id: "m" + rowId, rowId, chatId, participant: phone, service: "iMessage", chatKind: "dm", text,
      kind: "text", isFromMe: false, isSystem: false, isAutoReply: false, reaction: null, hasAttachments: false,
      isDowngraded: false, attachments: [], retractedAt: null, editedAt: null, recoveredAt: null,
      createdAt: new Date(), replyToMessageId: null, ...overrides } as Message);
  };
  const source: IMessageSource = { tail: () => ({ rowId: transport.rows.length, guid: transport.rows.at(-1)?.id ?? "" }),
    matches: () => transport.validCursor, read: async (after) => {
      if (transport.readError) throw transport.readError;
      return transport.rows.filter((message) => message.rowId > after);
    },
    send: async (_phone, text, attachment?: string) => {
      assert.equal(_phone, phone); transport.sent.push(text);
      if (attachment) transport.attachments.push(attachment);
      await transport.sendGate;
      if (transport.failSend) throw new Error("uncertain");
      if (transport.echo) add(text, { isFromMe: true });
    },
    close: async () => { transport.closes++; } };
  const controller = new IMessageController(core, () => {}, () => {
    transport.opens++; if (transport.openError) throw transport.openError; return source;
  }, source.send);
  async function pair() {
    await controller.start(email, phone); add("OK"); await controller.tick();
  }
  return { core, controller, transport, source, directory, add, pair, async close() { await controller.close(); core.close(); rmSync(directory, { recursive: true, force: true }); } };
}
test("iMessage dispatches a prepared attachment once through the bound source", async () => {
  const f = fixture();
  try {
    await f.pair();
    const receipt = f.core.receive({ kind: "imessage", accountId: email, peerId: phone, eventId: "video-request" }, "发给我视频");
    const origin = f.core.state().jobs.find(j => j.id === receipt.jobId)!.origin;
    const path = join(f.directory, "demo.mp4"), bytes = Buffer.from("fixture-video"); writeFileSync(path, bytes);
    f.core.enqueueAttachment("video", origin, { path, name: "demo.mp4", size: bytes.length, type: "video", sha256: createHash("sha256").update(bytes).digest("hex") }, receipt.jobId!);
    await f.controller.flush(); await f.controller.flush();
    assert.deepEqual(f.transport.attachments, [path]);
    assert.equal(f.core.outbox().find(e => e.id === "video")?.status, "submitted");
  } finally { await f.close(); }
});
test("iMessage stays dormant until explicit configuration and validates account inputs before database access", async () => {
  const f = fixture();
  try {
    await f.controller.restore(); await f.controller.tick(); assert.equal(f.transport.opens, 0);
    await assert.rejects(f.controller.start("not-an-email", phone));
    await assert.rejects(f.controller.start(email, "91234567"));
    assert.equal(f.transport.opens, 0);
  } finally { await f.close(); }
});
for (const failure of [
  { error: Object.assign(new Error("private path"), { code: "EPERM" }), code: "IMESSAGE_ACCESS_DENIED", hint: /完全磁盘访问/ },
  { error: Object.assign(new Error("private path"), { code: "ENOENT" }), code: "IMESSAGE_DATABASE_MISSING", hint: /消息.*登录/ },
  { error: new Error("private wrapper", { cause: Object.assign(new Error("no such column: message.private_field"), { code: "SQLITE_ERROR" }) }),
    code: "IMESSAGE_SCHEMA_UNSUPPORTED", hint: /数据库结构/ },
  { error: new BridgeError("INVALID_BUILD", "iMessage 发送保护补丁缺失，请重新构建应用。"), code: "INVALID_BUILD", hint: /构建/ },
  { error: Object.assign(new Error("private path"), { code: "SQLITE_CANTOPEN" }), code: "IMESSAGE_DATABASE_UNAVAILABLE", hint: /SQLITE_CANTOPEN/ },
]) {
  test("iMessage setup reports " + failure.code + " without exposing underlying private details", async () => {
    const f = fixture();
    try {
      f.transport.readError = failure.error;
      await assert.rejects(f.controller.start(email, phone), { code: failure.code });
      assert.equal(f.controller.state.status, "error");
      assert.match(f.controller.state.message!, failure.hint);
      assert.doesNotMatch(f.controller.state.message!, /private/);
      assert.equal(f.transport.closes, 1);
      assert.equal(f.controller.state.bound, false);
      assert.equal(f.transport.sent.length, 0);
    } finally { await f.close(); }
  });
}
test("starting iMessage pairing sends one request that asks the phone to reply OK", async () => {
  const f = fixture();
  try {
    await f.controller.start(email, phone);
    assert.equal(f.transport.sent.length, 1);
    assert.match(f.transport.sent[0]!, /配对请求/);
    assert.ok(f.transport.sent[0]!.includes(email));
    assert.match(f.transport.sent[0]!, /回复 OK/);
    assert.doesNotMatch(f.transport.sent[0]!, /\/pair|\/confirm/);
    assert.equal(f.controller.state.status, "awaiting_phone");
    assert.equal(f.controller.state.bound, false);
    assert.equal(f.core.state().bindings.length, 0);
    await assert.rejects(f.controller.start(email, phone), { code: "INVALID_STATE" });
    assert.equal(f.transport.sent.length, 1, "Repeated clicks cannot send another request during pairing");
  } finally { await f.close(); }
});
test("a fresh OK reply activates iMessage without another local confirmation", async () => {
  const f = fixture();
  try {
    await f.controller.start(email, phone);
    f.add("OK"); await f.controller.tick();
    assert.equal(f.controller.state.status, "connected");
    assert.equal(f.controller.state.bound, true);
    assert.equal(f.controller.state.connected, true);
    assert.deepEqual(f.core.iMessageConfiguration(), { email, phone, chatId });
    assert.equal(f.core.state().jobs.length, 0, "The pairing reply is never an Agent task");
    assert.equal(f.core.outbox().filter((entry) => entry.kind === "onboarding").length, 1);
    await f.controller.flush();
    assert.equal(f.transport.sent.length, 2);
    assert.match(f.transport.sent[1]!, /命令指南/);
    await f.controller.restore(); await f.controller.tick(); await f.controller.flush();
    assert.equal(f.transport.sent.length, 2, "Reconnect does not resend pairing or onboarding");
  } finally { await f.close(); }
});
test("simultaneous start calls submit only one pairing request", async () => {
  const f = fixture();
  try {
    const attempts = await Promise.allSettled([f.controller.start(email, phone), f.controller.start(email, phone)]);
    assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
    assert.equal(f.transport.sent.length, 1);
  } finally { await f.close(); }
});
test("an OK received after cancellation cannot bind a channel", async () => {
  const f = fixture();
  try {
    await f.controller.start(email, phone); await f.controller.disconnect();
    f.add("OK"); await f.controller.tick();
    assert.equal(f.controller.state.status, "idle");
    assert.equal(f.core.state().bindings.length, 0);
  } finally { await f.close(); }
});
test("messages following OK in the same batch are handled after the binding is committed", async () => {
  const f = fixture();
  try {
    await f.controller.start(email, phone); f.add("before pairing"); f.add("OK"); f.add("/status");
    await f.controller.tick(); await f.controller.flush();
    assert.equal(f.controller.state.connected, true);
    assert.equal(f.core.state().jobs.length, 0);
    assert.equal(f.core.outbox().filter((entry) => entry.kind === "receipt").length, 1);
    assert.equal(f.core.outbox().filter((entry) => entry.kind === "onboarding").length, 1);
  } finally { await f.close(); }
});
test("a failure after binding never replays the pairing OK as an Agent task", async (context) => {
  const f = fixture();
  try {
    await f.controller.start(email, phone); f.add("OK"); f.add("/status");
    const prepare = context.mock.method(f.core, "prepareEvents", async () => { throw new Error("temporary failure"); });
    await f.controller.tick();
    assert.equal(f.controller.state.bound, true);
    assert.equal(f.controller.state.connected, false);
    prepare.mock.restore();
    await f.controller.tick();
    assert.equal(f.controller.state.connected, true);
    assert.equal(f.core.state().jobs.length, 0, "Recovery must not turn OK into a task");
    assert.equal(f.core.outbox().filter((entry) => entry.kind === "receipt").length, 1);
  } finally { await f.close(); }
});
test("OK is case insensitive and ignores surrounding whitespace", async () => {
  const f = fixture();
  try {
    await f.controller.start(email, phone); f.add("  ok\n"); await f.controller.tick();
    assert.equal(f.controller.state.connected, true);
  } finally { await f.close(); }
});
test("pairing rejects unrelated senders, chats, stale messages and non-text acknowledgements", async () => {
  const f = fixture();
  try {
    f.add("OK"); // Existing history is before the setup cursor.
    await f.controller.start(email, phone);
    for (const overrides of [
      { participant: "+6511111111" }, { participant: "other@example.com" }, { chatId: "other-chat" },
      { service: "SMS" }, { isDowngraded: true }, { chatKind: "group" }, { reaction: {} },
      { isAutoReply: true }, { hasAttachments: true }, { isForwarded: true },
      { createdAt: new Date(0) }, { editedAt: new Date() }, { recoveredAt: new Date() },
      { replyToMessageId: "an-older-pairing-request" },
    ] as Partial<Message>[]) {
      f.add("OK", overrides); await f.controller.tick();
      assert.equal(f.core.state().bindings.length, 0, "Must reject " + Object.keys(overrides).join(","));
      assert.equal(f.core.state().jobs.length, 0);
    }
    f.add("OK thanks"); f.add("/confirm old-code"); await f.controller.tick();
    assert.equal(f.controller.state.bound, false);
    f.add("OK"); await f.controller.tick();
    assert.equal(f.controller.state.connected, true);
  } finally { await f.close(); }
});
test("an OK reply cannot bind without the current outgoing request echo", async () => {
  const f = fixture();
  try {
    f.transport.echo = false;
    await f.controller.start(email, phone); f.add("OK"); await f.controller.tick();
    assert.equal(f.controller.state.bound, false);
    f.add(f.transport.sent[0]!, { isFromMe: true }); f.add("OK"); await f.controller.tick();
    assert.equal(f.controller.state.connected, true);
  } finally { await f.close(); }
});
test("a request echo classified as incoming fails closed", async () => {
  const f = fixture();
  try {
    f.transport.echo = false;
    await f.controller.start(email, phone); f.add(f.transport.sent[0]!); f.add("OK"); await f.controller.tick();
    assert.equal(f.controller.state.status, "error");
    assert.equal(f.core.state().bindings.length, 0);
  } finally { await f.close(); }
});
test("a phone OK classified as from-self fails closed instead of enabling an echo loop", async () => {
  const f = fixture();
  try {
    await f.controller.start(email, phone); f.add("OK", { isFromMe: true }); await f.controller.tick();
    assert.equal(f.controller.state.status, "error");
    assert.equal(f.core.state().bindings.length, 0);
    assert.equal(f.transport.sent.length, 1);
  } finally { await f.close(); }
});
test("old requests cannot satisfy a restarted pairing attempt", async () => {
  const f = fixture();
  try {
    f.transport.echo = false;
    await f.controller.start(email, phone);
    const oldRequest = f.transport.sent[0]!;
    await f.controller.disconnect(); await f.controller.start(email, phone);
    assert.notEqual(f.transport.sent[1], oldRequest);
    f.add(oldRequest, { isFromMe: true }); f.add("OK"); await f.controller.tick();
    assert.equal(f.controller.state.bound, false);
    f.add(f.transport.sent[1]!, { isFromMe: true }); f.add("OK"); await f.controller.tick();
    assert.equal(f.controller.state.connected, true);
  } finally { await f.close(); }
});
test("expired pairing does not accept OK or automatically resend", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = fixture();
  try {
    await f.controller.start(email, phone);
    context.mock.timers.tick(10 * 60_000);
    f.add("OK"); await f.controller.tick();
    assert.equal(f.controller.state.status, "error");
    assert.equal(f.controller.state.bound, false);
    assert.equal(f.transport.sent.length, 1);
  } finally { await f.close(); }
});
test("cancelling while the request is sending cannot revive pairing", async () => {
  const f = fixture();
  let release!: () => void;
  f.transport.sendGate = new Promise<void>((resolve) => { release = resolve; });
  try {
    const starting = f.controller.start(email, phone);
    for (let i = 0; i < 10 && !f.transport.sent.length; i++) await Promise.resolve();
    assert.equal(f.transport.sent.length, 1);
    await f.controller.disconnect(); release(); await starting;
    f.add("OK"); await f.controller.tick();
    assert.equal(f.controller.state.status, "idle");
    assert.equal(f.controller.state.bound, false);
  } finally { release(); await f.close(); }
});
test("paired messages persist GUID deduplication and ignore echoes, SMS, groups and reactions", async () => {
  const f = fixture();
  try {
    await f.pair();
    f.add("/status"); const originalId = f.transport.rows.at(-1)!.id;
    f.add("echo", { isFromMe: true }); f.add("sms", { service: "SMS" });
    f.add("group", { chatKind: "group" }); f.add("tapback", { reaction: {} as Message["reaction"] });
    await f.controller.tick(); await f.controller.flush();
    assert.equal(f.core.outbox().filter((entry) => entry.kind === "receipt").length, 1);
    assert.ok(f.core.outbox().every((entry) => entry.status === "submitted"));
    f.add("/status", { id: originalId }); await f.controller.tick(); await f.controller.flush();
    assert.equal(f.core.outbox().filter((entry) => entry.kind === "receipt").length, 1);
    assert.equal(f.core.state().jobs.length, 0);
  } finally { await f.close(); }
});
test("database replacement blocks resume without silently replaying old history", async () => {
  const f = fixture();
  try {
    await f.pair();
    const checkpoint = f.core.checkpoint("imessage", email);
    f.transport.validCursor = false; f.add("should never run"); await f.controller.tick();
    assert.equal(f.controller.state.connected, false);
    assert.equal(f.controller.state.status, "error");
    assert.equal(f.core.checkpoint("imessage", email), checkpoint);
    assert.equal(f.core.state().jobs.length, 0);
  } finally { await f.close(); }
});
test("a cold reconnect explains denied access while retaining the binding and unread messages", async () => {
  const f = fixture();
  let restored: IMessageController | undefined;
  try {
    await f.pair(); await f.controller.flush(); await f.controller.close();
    const checkpoint = f.core.checkpoint("imessage", email);
    f.add("/status");
    let denied = true;
    restored = new IMessageController(f.core, () => {}, () => {
      if (denied) throw Object.assign(new Error("private database path"), { code: "EPERM" });
      return f.source;
    }, f.source.send);
    await restored.restore(); await restored.tick(); await restored.flush();
    assert.equal(restored.state.connected, false);
    assert.equal(restored.state.bound, true);
    assert.equal(restored.state.email, email);
    assert.equal(restored.state.phone, phone);
    assert.match(restored.state.message!, /系统拒绝读取 Messages.*EPERM/);
    assert.doesNotMatch(restored.state.message!, /重新配对|配对请求|private/);
    assert.equal(f.core.checkpoint("imessage", email), checkpoint);
    assert.equal(f.core.outbox().filter((entry) => entry.kind === "receipt").length, 0);
    denied = false;
    await restored.restore(); await restored.tick(); await restored.flush();
    assert.equal(restored.state.connected, true);
    assert.equal(f.core.outbox().filter((entry) => entry.kind === "receipt").length, 1);
    assert.equal(f.transport.sent.length, 4, "One pairing request, one guide, one permission notice and one recovered status reply");
    assert.equal(f.core.state().jobs.length, 0);
    await restored.restore(); await restored.tick(); await restored.flush();
    assert.equal(f.transport.sent.length, 4, "Restoring again must not repeat old replies");
  } finally { await restored?.close(); await f.close(); }
});
test("read permission failures after connecting explain how to restore access", async () => {
  const f = fixture();
  try {
    await f.pair();
    const checkpoint = f.core.checkpoint("imessage", email);
    f.transport.readError = new Error("private wrapper", { cause: Object.assign(new Error("private path"), { code: "EACCES" }) });
    await f.controller.tick();
    assert.equal(f.controller.state.connected, false);
    assert.match(f.controller.state.message!, /系统拒绝读取 Messages.*EACCES/);
    assert.doesNotMatch(f.controller.state.message!, /配对请求|private/);
    assert.equal(f.core.checkpoint("imessage", email), checkpoint);
    f.transport.readError = undefined;
    await f.controller.tick();
    assert.equal(f.controller.state.connected, true);
  } finally { await f.close(); }
});
test("granting read access after a failed restore automatically resumes unread messages", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = fixture();
  try {
    await f.pair(); await f.controller.flush();
    f.transport.openError = Object.assign(new Error("denied"), { code: "EPERM" });
    await f.controller.restore(); await f.controller.flush();
    const opens = f.transport.opens, cursor = f.core.checkpoint("imessage", email);
    f.transport.openError = undefined; f.add("/status");
    context.mock.timers.tick(4999); await f.controller.tick();
    assert.equal(f.transport.opens, opens, "Do not retry on every poll");
    assert.equal(f.core.checkpoint("imessage", email), cursor);
    context.mock.timers.tick(1); await f.controller.tick(); await f.controller.flush();
    assert.equal(f.controller.state.connected, true, "Newly granted access must recover without a manual reconnect");
    assert.equal(f.transport.opens, opens + 1);
    assert.equal(f.core.outbox().filter((entry) => entry.kind === "receipt").length, 1);
    assert.equal(f.core.state().jobs.length, 0);
    const sent = f.transport.sent.length;
    context.mock.timers.tick(30_000); await f.controller.tick(); await f.controller.flush();
    assert.equal(f.transport.opens, opens + 1);
    assert.equal(f.transport.sent.length, sent, "Recovered messages must not be replayed");
  } finally { await f.close(); }
});
test("automatic access retries are spaced and concurrent polls do not resend the notice", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = fixture();
  try {
    await f.pair(); await f.controller.flush();
    f.transport.openError = Object.assign(new Error("denied"), { code: "EACCES" });
    await f.controller.restore(); await f.controller.flush();
    const opens = f.transport.opens, sent = f.transport.sent.length;
    for (let retry = 1; retry <= 3; retry++) {
      context.mock.timers.tick(5000);
      await Promise.all(Array.from({ length: 10 }, () => f.controller.tick())); await f.controller.flush();
      assert.equal(f.transport.opens, opens + retry, "Only one open attempt per interval");
      assert.equal(f.transport.sent.length, sent, "Do not repeat the permission notice");
      assert.equal(f.controller.state.connected, false);
    }
  } finally { await f.close(); }
});
test("automatic access recovery remains dormant for other errors and after shutdown or unbinding", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = fixture();
  try {
    await f.pair(); await f.controller.flush();
    for (const code of ["ENOENT", "SQLITE_CANTOPEN", "SQLITE_ERROR"]) {
      f.transport.openError = Object.assign(new Error("no such column: field"), { code });
      await f.controller.restore();
      const opens = f.transport.opens;
      f.transport.openError = undefined;
      context.mock.timers.tick(30_000); await f.controller.tick();
      assert.equal(f.transport.opens, opens);
      assert.equal(f.controller.state.connected, false);
    }
    for (const action of ["close", "disconnect"] as const) {
      f.transport.openError = Object.assign(new Error("denied"), { code: "EPERM" });
      await f.controller.restore();
      const opens = f.transport.opens;
      await f.controller[action]();
      f.transport.openError = undefined;
      context.mock.timers.tick(30_000); await f.controller.tick(); await f.controller.flush();
      assert.equal(f.transport.opens, opens);
      assert.equal(f.controller.state.connected, false);
    }
  } finally { await f.close(); }
});
test("unbinding while a reconnect is closing the old reader cannot revive connection state", async (context) => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    await f.pair();
    context.mock.method(f.source, "close", () => gate);
    const reconnecting = f.controller.restore();
    await f.controller.disconnect();
    release(); await reconnecting;
    assert.equal(f.controller.state.status, "idle");
    assert.equal(f.controller.state.bound, false);
    assert.equal(f.core.state().bindings.length, 0);
  } finally { release(); await f.close(); }
});
test("pairing dispatch failure is never automatically repeated or mistaken for a read error", async () => {
  const f = fixture();
  try {
    f.transport.failSend = true;
    await assert.rejects(f.controller.start(email, phone), { code: "SEND_UNCERTAIN" });
    f.add("OK"); await f.controller.tick(); await f.controller.flush();
    assert.equal(f.controller.state.status, "error");
    assert.match(f.controller.state.message!, /配对请求.*不确定/);
    assert.equal(f.transport.sent.length, 1);
    assert.equal(f.core.state().bindings.length, 0);
  } finally { await f.close(); }
});
