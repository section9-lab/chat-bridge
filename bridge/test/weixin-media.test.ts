import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createDecipheriv } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeCore } from "../src/core.js";
import { WeixinTransport } from "../src/weixin.js";

for (const type of ["video", "image", "file"] as const) test("WeChat uploads encrypted " + type + " and sends its media item once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-weixin-media-"));
  const core = new BridgeCore(join(dir, "bridge.sqlite"), {}); core.bindChannel("weixin", "bot", "owner");
  let upload: any, uploaded: Buffer | undefined;
  const sent: any[] = [];
  const transport = new WeixinTransport(core, { accountId: "bot", ownerId: "owner", token: "fixture-token", baseUrl: "https://ilinkai.weixin.qq.com", contextKey: Buffer.alloc(32, 1).toString("base64") },
    async (input, init) => {
      const url = String(input);
      if (url.includes("/c2c/upload")) {
        assert.equal(new Headers(init?.headers).get("Authorization"), null);
        assert.equal(init?.redirect, "error"); uploaded = Buffer.from(init!.body as Uint8Array);
        return new Response("", { headers: { "x-encrypted-param": "download-fixture" } });
      }
      const body = JSON.parse(String(init?.body));
      if (url.endsWith("getuploadurl")) { upload = body; return Response.json({ ret: 0, upload_param: "upload-fixture" }); }
      if (url.endsWith("sendmessage")) sent.push(body.msg);
      return Response.json(url.endsWith("getupdates") ? { ret: 0, get_updates_buf: "cursor", msgs: [{ message_id: 1, message_type: 1, message_state: 2,
        from_user_id: "owner", to_user_id: "bot", context_token: "fixture-context", item_list: [{ type: 1, text_item: { text: "发成果" } }] }] } : { ret: 0 });
    });
  try {
    await transport.poll(new AbortController().signal);
    const job = core.state().jobs[0]!, bytes = Buffer.from("fixture media bytes"), path = join(dir, "成果.bin"); writeFileSync(path, bytes);
    core.enqueueAttachment("media", job.origin, { path, name: "成果.bin", size: bytes.length, type, sha256: createHash("sha256").update(bytes).digest("hex") }, job.id);
    await transport.flush(); await transport.flush();
    assert.ok(uploaded, "The media bytes must reach the CDN before sending a media item");
    assert.equal(upload.rawfilemd5, createHash("md5").update(bytes).digest("hex"));
    const decipher = createDecipheriv("aes-128-ecb", Buffer.from(upload.aeskey, "hex"), null);
    assert.deepEqual(Buffer.concat([decipher.update(uploaded), decipher.final()]), bytes);
    const media = sent.flatMap(msg => msg.item_list).filter(item => item.type !== 1);
    assert.equal(media.length, 1); assert.equal(media[0].type, { image: 2, file: 4, video: 5 }[type]);
    assert.equal(core.outbox().find(e => e.id === "media")?.status, "submitted");
  } finally { transport.stop(); core.close(); rmSync(dir, { recursive: true, force: true }); }
});
