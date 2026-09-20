import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeCore } from "../src/core.js";
import { WeixinTransport, createWeixinClient, validateBaseURL, type WeixinCredential } from "../src/weixin.js";

const credential: WeixinCredential = { accountId: "bot", ownerId: "owner", token: "secret-bot-token",
  baseUrl: "https://ilinkai.weixin.qq.com", contextKey: Buffer.alloc(32, 7).toString("base64") };
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "bridge-weixin-")), file = join(directory, "bridge.sqlite");
  const core = new BridgeCore(file, {}); core.bindChannel("weixin", "bot", "owner");
  return { core, file, close() { core.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const message = (overrides = {}) => ({ message_id: 12, message_type: 1, message_state: 2,
  from_user_id: "owner", to_user_id: "bot", context_token: "secret-context", item_list: [{ type: 1, text_item: { text: "/status" } }], ...overrides });

test("real library protocol persists owner messages then replies with encrypted context", async () => {
  const f = fixture(), calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input); calls.push({ url, init });
    return Response.json(url.endsWith("getupdates") ? { ret: 0, get_updates_buf: "next-cursor", msgs: [message()] } : { ret: 0 });
  };
  try {
    const transport = new WeixinTransport(f.core, credential, fetchFn);
    await transport.poll(new AbortController().signal); await transport.flush();
    assert.equal(f.core.checkpoint("weixin", "bot"), "next-cursor");
    assert.equal(calls.length, 3);
    assert.equal(calls[0]?.init?.redirect, "error");
    assert.equal(new Headers(calls[1]?.init?.headers).get("Authorization"), "Bearer secret-bot-token");
    const body = JSON.parse(String(calls[1]?.init?.body));
    assert.equal(body.msg.to_user_id, "owner");
    assert.equal(body.msg.context_token, "secret-context");
    assert.equal(body.msg.message_type, 2);
    assert.equal(f.core.outbox()[0]?.status, "submitted");
    assert.ok(!readFileSync(f.file).includes(Buffer.from("secret-context")));
    assert.ok(!readFileSync(f.file + "-wal").includes(Buffer.from("secret-context")));
    await transport.poll(new AbortController().signal); await transport.flush();
    assert.equal(calls.filter((call) => call.url.endsWith("sendmessage")).length, 2);
    assert.equal(JSON.parse(String(calls[3]?.init?.body)).get_updates_buf, "next-cursor");
  } finally { f.close(); }
});
test("strangers, groups, bot echoes and incomplete events never reach the queue", async () => {
  const f = fixture();
  try {
    const previousOutbox = f.core.outbox();
    const messages = [message({ from_user_id: "stranger", message_id: 1.5 }), message({ group_id: "group" }), message({ message_type: 2 }), message({ message_state: 1 })];
    const transport = new WeixinTransport(f.core, credential, async () => Response.json({ ret: 0, msgs: messages, get_updates_buf: "seen" }));
    await transport.poll(new AbortController().signal);
    assert.deepEqual(f.core.outbox(), previousOutbox);
    assert.equal(f.core.context("weixin", "bot", "owner"), undefined);
    assert.equal(f.core.checkpoint("weixin", "bot"), "seen");
  } finally { f.close(); }
});
test("invalid native IDs and API failures never advance the cursor", async () => {
  const f = fixture();
  try {
    for (const response of [{ ret: 0, msgs: [message({ message_id: -1 })], get_updates_buf: "lost" },
      { ret: 0, msgs: [message({ message_id: "18446744073709551616" })], get_updates_buf: "lost" },
      { ret: 0, msgs: [message({ message_id: 1.5 })], get_updates_buf: "lost" },
      { ret: -14, errmsg: "secret-token", get_updates_buf: "lost" }, { status: "wait" }]) {
      const transport = new WeixinTransport(f.core, credential, async () => Response.json(response));
      await assert.rejects(transport.poll(new AbortController().signal), (error: Error) => !error.message.includes("secret-token"));
      assert.equal(f.core.checkpoint("weixin", "bot"), "");
    }
  } finally { f.close(); }
});
test("QR request uses the pinned Tencent POST contract without an Authorization token", async () => {
  let request: RequestInit | undefined;
  const client = createWeixinClient(undefined, async (input, init) => {
    assert.equal(String(input), "https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3");
    request = init; return Response.json({ qrcode: "id", qrcode_img_content: "https://qr.example/id" });
  });
  await client.fetchQRCode();
  assert.equal(request?.method, "POST");
  assert.deepEqual(JSON.parse(String(request?.body)), { local_token_list: [] });
  assert.equal(new Headers(request?.headers).get("Authorization"), null);
});
test("credential endpoints cannot redirect tokens outside Tencent HTTPS hosts", () => {
  assert.equal(validateBaseURL("https://ilinkai.weixin.qq.com/"), "https://ilinkai.weixin.qq.com");
  for (const url of ["http://ilinkai.weixin.qq.com", "https://weixin.qq.com.evil.test", "https://user@ilinkai.weixin.qq.com", "https://ilinkai.weixin.qq.com:444", "https://ilinkai.weixin.qq.com/path"]) {
    assert.throws(() => validateBaseURL(url));
  }
});
test("a timeout converted by the library cannot be mistaken for a connected channel", async () => {
  const f = fixture();
  try {
    const transport = new WeixinTransport(f.core, credential, async () => { throw new DOMException("Timed out", "AbortError"); });
    await assert.rejects(transport.poll(new AbortController().signal));
    assert.equal(transport.connected, false);
    assert.equal(f.core.checkpoint("weixin", "bot"), "");
  } finally { f.close(); }
});

test("uint64 WeChat message IDs remain distinct through the real library parser", async () => {
  const f = fixture();
  const ids = ["9007199254740992", "9007199254740993", "18446744073709551615"];
  const raw = JSON.stringify({ ret:0, get_updates_buf:"uint64-cursor", msgs:ids.map((id)=>message({message_id:'RAW_'+id})) })
    .replace(/"RAW_(\d+)"/g, '$1');
  try {
    const transport = new WeixinTransport(f.core,credential,async()=>new Response(raw));
    await transport.poll(new AbortController().signal);
    assert.deepEqual(f.core.outbox().filter((entry)=>entry.kind==="receipt").map((entry)=>entry.origin.eventId),ids);
    assert.equal(f.core.checkpoint('weixin','bot'),'uint64-cursor');
    await transport.poll(new AbortController().signal);
    assert.equal(f.core.outbox().filter((entry)=>entry.kind==="receipt").length,3);
  } finally {f.close();}
});

test("string message IDs are normalized without rewriting message text", async()=>{
  const f=fixture();
  try {
    const text='Keep this literal: "message_id":9007199254740993';
    const transport=new WeixinTransport(f.core,credential,async()=>Response.json({ret:0,get_updates_buf:'string-id',msgs:[message({message_id:'18446744073709551615',item_list:[{type:1,text_item:{text}}]})]}));
    await transport.poll(new AbortController().signal);
    assert.equal(f.core.state().jobs[0]?.text,text);
    assert.equal(f.core.state().jobs[0]?.origin.eventId,'18446744073709551615');
  }finally {f.close();}
});
