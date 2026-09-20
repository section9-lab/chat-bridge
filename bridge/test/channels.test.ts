import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeCore } from "../src/core.js";
import { ChannelController, type CredentialVault } from "../src/channels.js";
import { RPCError } from "../src/rpc.js";

const secret = { accountId: "bot", ownerId: "owner", token: "secret", baseUrl: "https://ilinkai.weixin.qq.com", contextKey: Buffer.alloc(32, 1).toString("base64") };
const qr = { qrcode: "qr", qrcode_img_content: "fixture QR content" };
const scanned = { status: "confirmed", bot_token: "secret", ilink_bot_id: "bot", ilink_user_id: "owner", baseurl: secret.baseUrl };
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "bridge-channels-")), core = new BridgeCore(join(directory, "bridge.sqlite"), {});
  const memory = { saved: undefined as unknown, saves: 0, reads: 0, readError: undefined as Error | undefined, failWrite: false, requests: 0, replies: [qr, scanned] as object[], sent: [] as { to_user_id: string; context_token: string; item_list: { text_item: { text: string } }[] }[] };
  const vault: CredentialVault = { read: async () => { memory.reads++; if (memory.readError) throw memory.readError; return memory.saved; },
    write: async (value) => { if (memory.failWrite) throw new Error("access denied"); memory.saves++; memory.saved = value; },
    remove: async () => { memory.saved = undefined; } };
  const channels = new ChannelController(core, vault, () => {}, async (input, init) => { memory.requests++;
    if (String(input).endsWith("sendmessage")) { memory.sent.push(JSON.parse(String(init?.body)).msg); return Response.json({ ret: 0 }); }
    return Response.json(memory.replies.shift() ?? { ret: 0, msgs: [], get_updates_buf: "c" }); });
  return { core, channels, memory, close() { channels.close(); core.close(); rmSync(directory, { recursive: true, force: true }); } };
}
test("QR confirmation saves to the vault before authorizing any channel message", async () => {
  const f = fixture();
  try {
    await f.channels.startLogin(); await f.channels.tick();
    assert.equal(f.channels.state.status, "awaiting_confirmation");
    assert.equal(f.memory.saves, 0); assert.equal(f.core.state().bindings.length, 0);
    assert.equal(f.core.outbox().length, 0);
    f.memory.failWrite = true;
    await assert.rejects(f.channels.confirm(f.channels.state.attemptId!));
    assert.equal(f.core.state().bindings.length, 0);
    assert.equal(f.core.outbox().length, 0);
    f.memory.failWrite = false;
    await f.channels.confirm(f.channels.state.attemptId!);
    assert.equal(f.memory.saves, 1);
    assert.equal(f.core.isBound({ kind: "weixin", accountId: "bot", peerId: "owner" }), true);
    assert.equal(f.channels.state.status, "connecting");
    assert.equal(f.core.outbox().filter((entry) => entry.kind === "onboarding").length, 1);
    assert.ok(!JSON.stringify(f.channels.state).includes('"token"'));
    await f.channels.tick();
    assert.equal(f.channels.state.status, "connected");
  } finally { f.close(); }
});
test("WeChat sends the queued guide when the owner supplies context and never repeats it on reconnect", async () => {
  const f = fixture();
  try {
    await f.channels.startLogin(); await f.channels.tick(); await f.channels.confirm(f.channels.state.attemptId!);
    await f.channels.tick(); await f.channels.flush();
    assert.equal(f.memory.sent.length, 0);
    assert.equal(f.core.outbox()[0]?.status, "pending");
    const message = { message_id: "1", message_type: 1, message_state: 2, from_user_id: "owner", to_user_id: "bot",
      context_token: "owner-context", item_list: [{ type: 1, text_item: { text: "/status" } }] };
    f.memory.replies.push({ ret: 0, msgs: [{ ...message, from_user_id: "stranger" }] });
    await f.channels.tick();
    assert.equal(f.memory.sent.length, 0);
    f.memory.replies.push({ ret: 0, msgs: [message] });
    await f.channels.tick();
    assert.equal(f.memory.sent.length, 2);
    assert.match(f.memory.sent[0]!.item_list[0]!.text_item.text, /命令指南/);
    assert.ok(f.memory.sent.every((message) => message.to_user_id === "owner" && message.context_token === "owner-context"));
    await f.channels.restore(); await f.channels.tick(); await f.channels.flush();
    assert.equal(f.memory.sent.length, 2);
  } finally { f.close(); }
});
test("fresh startup does not read Keychain or contact WeChat", async () => {
  const f = fixture();
  try {
    await f.channels.restore(); await f.channels.tick();
    assert.equal(f.memory.reads, 0); assert.equal(f.memory.requests, 0);
    assert.equal(f.channels.state.status, "idle");
  } finally { f.close(); }
});
test("only the previously confirmed owner can be restored from Keychain", async () => {
  const f = fixture();
  try {
    f.core.bindChannel("weixin", "bot", "owner"); f.memory.saved = { ...secret, ownerId: "stranger" };
    await f.channels.restore(); await f.channels.tick();
    assert.equal(f.memory.requests, 0);
    assert.equal(f.channels.state.status, "error");
    f.memory.saved = secret; f.memory.replies = [{ ret: 0, msgs: [] }];
    await f.channels.restore(); await f.channels.tick();
    assert.equal(f.channels.state.status, "connected");
  } finally { f.close(); }
});
test("Keychain restore errors preserve the binding and expose only a safe recovery reason", async () => {
  const f = fixture();
  try {
    f.core.bindChannel("weixin", "bot", "owner"); f.memory.saved = secret;
    f.memory.readError = new RPCError("TIMEOUT", "private diagnostic content");
    await f.channels.restore();
    assert.match(f.channels.state.message!, /超时/);
    assert.equal(f.channels.state.bound, true);
    assert.equal(f.channels.state.connected, false);
    assert.equal(f.memory.requests, 0);
    f.memory.readError = new RPCError("KEYCHAIN_-25293", "private diagnostic content");
    await f.channels.restore();
    assert.match(f.channels.state.message!, /-25293/);
    assert.match(f.channels.state.message!, /绑定已保留/);
    assert.ok(!f.channels.state.message!.includes("private"));
  } finally { f.close(); }
});
test("disconnect revokes queued jobs, removes credentials and stops polling", async () => {
  const f = fixture();
  try {
    await f.channels.startLogin(); await f.channels.tick(); await f.channels.confirm(f.channels.state.attemptId!);
    f.core.receive({ kind: "weixin", accountId: "bot", peerId: "owner", eventId: "work" }, "hello");
    await f.channels.disconnect(); const requests = f.memory.requests; await f.channels.tick();
    assert.equal(f.memory.saved, undefined);
    assert.equal(f.memory.requests, requests);
    assert.equal(f.core.state().jobs[0]?.status, "cancelled");
    assert.equal(f.channels.state.status, "idle");
  } finally { f.close(); }
});
test("expired WeChat credentials require user reconnection instead of hot retry", async () => {
  const f = fixture();
  try {
    f.core.bindChannel("weixin", "bot", "owner"); f.memory.saved = secret;
    f.memory.replies = [{ ret: -14 }];
    await f.channels.restore(); await f.channels.tick(); const requests = f.memory.requests;
    await f.channels.tick();
    assert.equal(f.memory.requests, requests);
    assert.equal(f.channels.state.status, "expired");
  } finally { f.close(); }
});

test("a protocol failure preserves a safe diagnostic code without returning server secrets", async () => {
  const f = fixture();
  try {
    f.core.bindChannel("weixin", "bot", "owner"); f.memory.saved = secret;
    f.memory.replies = [{ ret: -2, errcode: 40001, errmsg: "private-token-value" }];
    await f.channels.restore(); await f.channels.tick();
    assert.match(f.channels.state.message!, /40001/);
    assert.ok(!f.channels.state.message!.includes("private-token-value"));
    assert.equal(f.channels.state.connected, false);
  } finally { f.close(); }
});
