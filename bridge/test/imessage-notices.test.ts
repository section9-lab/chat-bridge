import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMessageSDK, getDefaultDatabasePath, type SendRequest } from "@photon-ai/imessage-kit";
import { BridgeCore } from "../src/core.js";
import { IMessageController } from "../src/imessage.js";
import { sendIMessageNotice } from "../src/imessage-source.js";
import type { IMessageSource } from "../src/imessage-source.js";

const email = "bridge@example.com", phone = "+6591234567", chatId = "iMessage;-;" + phone;
const denied = () => Object.assign(new Error("private Messages path"), { code: "EPERM" });
function fixture(bound = true) {
  const directory = mkdtempSync(join(tmpdir(), "bridge-imessage-notice-")), path = join(directory, "bridge.sqlite");
  let core = new BridgeCore(path, {});
  const transport = { openError: undefined as Error | undefined, readError: undefined as Error | undefined,
    sendError: undefined as Error | undefined, notices: [] as { phone: string; text: string }[], normal: [] as string[] };
  const source: IMessageSource = {
    tail: () => ({ rowId: 0, guid: "" }), matches: () => true,
    read: async () => { if (transport.readError) throw transport.readError; return []; },
    send: async (_phone, text) => { transport.normal.push(text); }, close: async () => {},
  };
  function makeController() {
    return new IMessageController(core, () => {}, () => {
      if (transport.openError) throw transport.openError;
      return source;
    }, async (recipient: string, text: string) => {
      assert.ok(core.outbox().some((entry) => entry.kind === "access_notice" && entry.status === "dispatching"),
        "Persist the dispatch before the external send");
      transport.notices.push({ phone: recipient, text });
      if (transport.sendError) throw transport.sendError;
    });
  }
  let controller = makeController();
  const bind = () => core.activateIMessage({ email, phone, chatId }, JSON.stringify({ rowId: 0, guid: "" }));
  if (bound) bind();
  return { get core() { return core; }, get controller() { return controller; }, transport, bind,
    async restart() { await controller.close(); core.close(); core = new BridgeCore(path, {}); controller = makeController(); },
    async close() { await controller.close(); core.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("denied Messages access sends one durable notice to the bound phone without opening the reader", async () => {
  const f = fixture();
  try {
    const cursor = f.core.checkpoint("imessage", email);
    f.transport.openError = denied();
    await f.controller.restore(); await f.controller.flush();
    assert.equal(f.transport.notices.length, 1);
    assert.equal(f.transport.notices[0]!.phone, phone);
    assert.match(f.transport.notices[0]!.text, /电脑.*完全磁盘访问.*无法读取 iMessage/);
    assert.match(f.transport.notices[0]!.text, /系统设置.*隐私与安全.*完全磁盘访问/);
    assert.doesNotMatch(f.transport.notices[0]!.text, /private|bridge@example|EPERM|已收到/);
    assert.equal(f.core.outbox().find((entry) => entry.kind === "access_notice")?.status, "submitted");
    assert.equal(f.transport.normal.length, 0, "Normal replies cannot bypass a disconnected channel");
    assert.equal(f.controller.state.connected, false);
    assert.equal(f.controller.state.bound, true);
    assert.equal(f.core.checkpoint("imessage", email), cursor);
    assert.equal(f.core.state().jobs.length, 0);
  } finally { await f.close(); }
});

test("repeated reconnects and process restarts do not resend the same access notice", async () => {
  const f = fixture();
  try {
    f.transport.openError = denied();
    await f.controller.restore(); await Promise.all([f.controller.flush(), f.controller.flush()]);
    assert.equal(f.transport.notices.length, 1);
    await f.controller.restore(); await f.controller.flush();
    await f.restart(); await f.controller.restore(); await f.controller.flush();
    assert.equal(f.transport.notices.length, 1);
    assert.equal(f.core.outbox().filter((entry) => entry.kind === "access_notice").length, 1);
  } finally { await f.close(); }
});

test("permission loss during polling notifies once and recovery allows a later outage notice", async () => {
  const f = fixture();
  try {
    await f.controller.restore(); await f.controller.tick(); await f.controller.flush();
    f.transport.readError = new Error("private wrapper", { cause: Object.assign(new Error("private path"), { code: "EACCES" }) });
    await f.controller.tick(); await f.controller.flush();
    await f.controller.tick(); await f.controller.flush();
    assert.equal(f.transport.notices.length, 1);
    f.transport.readError = undefined;
    await f.controller.tick();
    assert.equal(f.controller.state.connected, true);
    f.transport.readError = denied();
    await f.controller.tick(); await f.controller.flush();
    assert.equal(f.transport.notices.length, 2);
  } finally { await f.close(); }
});

test("recovery cancels an unsent access notice", async () => {
  const f = fixture();
  try {
    f.transport.openError = denied();
    await f.controller.restore();
    assert.equal(f.core.outbox().find((entry) => entry.kind === "access_notice")?.status, "pending");
    f.transport.openError = undefined;
    await f.controller.restore(); await f.controller.tick(); await f.controller.flush();
    assert.equal(f.transport.notices.length, 0);
    assert.equal(f.core.outbox().find((entry) => entry.kind === "access_notice")?.status, "cancelled");
  } finally { await f.close(); }
});

test("a failed permission notice is not retried and remains visible locally after restart", async () => {
  const f = fixture();
  try {
    f.transport.openError = denied(); f.transport.sendError = new Error("private automation error");
    await f.controller.restore(); await f.controller.flush();
    assert.equal(f.transport.notices.length, 1);
    assert.equal(f.core.outbox().find((entry) => entry.kind === "access_notice")?.status, "delivery_unknown");
    assert.match(f.controller.state.message!, /权限提醒.*未能确认发出/);
    assert.doesNotMatch(f.controller.state.message!, /private/);
    await f.restart(); await f.controller.restore(); await f.controller.flush();
    assert.equal(f.transport.notices.length, 1);
    assert.match(f.controller.state.message!, /权限提醒.*未能确认发出/);
  } finally { await f.close(); }
});

test("unbinding cancels a pending notice and a fresh binding can receive its own notice", async () => {
  const f = fixture();
  try {
    f.transport.openError = denied();
    await f.controller.restore();
    assert.equal(f.core.outbox().find((entry) => entry.kind === "access_notice")?.status, "pending");
    await f.controller.disconnect(); await f.controller.flush();
    assert.equal(f.transport.notices.length, 0);
    assert.equal(f.core.outbox().find((entry) => entry.kind === "access_notice")?.status, "cancelled");
    f.bind(); await f.controller.restore(); await f.controller.flush();
    assert.equal(f.transport.notices.length, 1);
  } finally { await f.close(); }
});

test("an unpaired account cannot send a permission notice", async () => {
  const f = fixture(false);
  try {
    f.transport.openError = denied();
    await assert.rejects(f.controller.start(email, phone), { code: "IMESSAGE_ACCESS_DENIED" });
    await f.controller.flush();
    assert.equal(f.transport.notices.length, 0);
    assert.equal(f.core.outbox().length, 0);
  } finally { await f.close(); }
});

test("ambiguous database and schema errors are not reported as missing disk access", async () => {
  const f = fixture();
  try {
    for (const code of ["SQLITE_CANTOPEN", "ENOENT", "SQLITE_ERROR"]) {
      f.transport.openError = Object.assign(new Error("no such column: private"), { code });
      await f.controller.restore(); await f.controller.flush();
    }
    assert.equal(f.transport.notices.length, 0);
    assert.equal(f.core.outbox().filter((entry) => entry.kind === "access_notice").length, 0);
  } finally { await f.close(); }
});

for (const fail of [false, true]) {
  test("the send-only SDK uses a disposable database and cleans up after " + (fail ? "failure" : "success"), async (context) => {
    let path = "", sends = 0;
    context.mock.method(IMessageSDK.prototype, "send", async function(this: IMessageSDK, request: SendRequest) {
      sends++;
      path = Reflect.get(this, "databasePath") as string;
      assert.notEqual(path, getDefaultDatabasePath());
      assert.ok(existsSync(path));
      assert.deepEqual(request, { to: "iMessage;-;" + phone, text: "fixture notice" });
      if (fail) throw new Error("fixture send failed");
    });
    context.mock.method(IMessageSDK.prototype, "getMessages", async () => { throw new Error("Must not read Messages"); });
    context.mock.method(IMessageSDK.prototype, "listChats", async () => { throw new Error("Must not read chats"); });
    if (fail) await assert.rejects(sendIMessageNotice(phone, "fixture notice"), /fixture send failed/);
    else await sendIMessageNotice(phone, "fixture notice");
    assert.equal(sends, 1);
    assert.equal(existsSync(path), false);
  });
}
