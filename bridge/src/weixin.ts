import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { WeixinProtocolClient, type GetUpdatesResp, type MessageItem } from "chat-adapter-weixin";
import { BridgeError, type BridgeCore, type ChannelEvent } from "./core.js";
import { OutboxDispatcher } from "./delivery.js";
import { openContext, sealContext } from "./secrets.js";
import { attachmentBytes, type OutputAttachment } from "./outputs.js";
import { appVersion } from "./version.js";
export type WeixinCredential = { accountId: string; ownerId: string; token: string; baseUrl: string; contextKey: string };
function messageID(value: unknown): string {
  const id = typeof value === "string" ? value : Number.isSafeInteger(value) ? String(value) : "";
  if (!/^[1-9][0-9]{0,19}$/.test(id) || BigInt(id) > 18446744073709551615n) {
    throw new BridgeError("CHANNEL_PROTOCOL", "消息 ID 无法安全识别，游标未推进。");
  }
  return id;
}
export function validateBaseURL(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || !(url.hostname === "ilinkai.weixin.qq.com" || url.hostname.endsWith(".weixin.qq.com")) ||
      url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) {
    throw new BridgeError("INVALID_ENDPOINT", "微信返回的服务地址未通过校验。");
  }
  return url.origin;
}
export function createWeixinClient(credential?: Pick<WeixinCredential, "baseUrl" | "token">, fetchFn: typeof fetch = fetch): WeixinProtocolClient {
  const baseUrl = validateBaseURL(credential?.baseUrl ?? "https://ilinkai.weixin.qq.com");
  return new WeixinProtocolClient({ baseUrl, token: credential?.token, channelVersion: appVersion, fetchFn: async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== baseUrl) throw new BridgeError("INVALID_ENDPOINT", "服务地址不一致。");
    let request = { ...init, redirect: "error" as const };
    // v0.1.4 still uses GET here. The pinned Tencent client uses POST, preserving bot_type.
    if (url.pathname === "/ilink/bot/get_bot_qrcode") {
      const headers = new Headers(init?.headers);
      headers.delete("Authorization"); headers.delete("Content-Length");
      headers.set("Content-Type", "application/json"); headers.set("AuthorizationType", "ilink_bot_token");
      headers.set("X-WECHAT-UIN", Buffer.from(String(randomBytes(4).readUInt32BE())).toString("base64"));
      request = { ...request, method: "POST", headers, body: JSON.stringify({ local_token_list: [] }) };
    }
    // The upstream getUpdates swallows AbortError into an empty success response.
    // Preserve cancellation/timeout as a transport failure so it cannot prove connectivity.
    const response = await fetchFn(url.toString(), request).catch((error: unknown) => {
      const cause = error instanceof Error && error.cause && typeof error.cause === "object" ? (error.cause as { code?: string }).code : "";
      const reason = cause && ["ENOTFOUND", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"].includes(cause) ? cause :
        error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name) ? "TIMEOUT" : "NETWORK";
      throw new BridgeError("CHANNEL_NETWORK", "微信请求未完成（" + reason + "），尚未确认连接。");
    });
    if (!response.ok) throw new BridgeError("CHANNEL_NETWORK", "微信请求失败（HTTP " + response.status + "），请稍后重连。");
    const reader = response.body?.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        for (;;) {
          const { value, done } = await reader.read().catch(() => {
            throw new BridgeError("CHANNEL_NETWORK", "微信响应中断，尚未确认连接。");
          });
          if (done) break;
          size += value.byteLength;
          if (size > 4 * 1024 * 1024) throw new BridgeError("CHANNEL_PROTOCOL", "微信响应过大，游标未推进。");
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
    }
    let body = Buffer.concat(chunks).toString("utf8");
    if (url.pathname === "/ilink/bot/getupdates") {
      try {
        // Node 24 supplies the original numeric token before JSON number rounding.
        // Convert IDs to strings before the upstream library's ordinary JSON.parse.
        const parsed = JSON.parse(body, (key: string, value: unknown, context?: { source?: string }) =>
          key === "message_id" && typeof value === "number" ? context?.source ?? (Number.isSafeInteger(value) ? String(value) : null) : value);
        body = JSON.stringify(parsed);
      } catch (error) {
        if (error instanceof BridgeError) throw error;
        throw new BridgeError("CHANNEL_PROTOCOL", "微信响应不是有效 JSON，游标未推进。");
      }
    }
    const headers = new Headers(response.headers); headers.delete("Content-Length"); headers.delete("Content-Encoding");
    return new Response(body, { status: response.status, headers });
  } });
}
export class WeixinTransport {
  private client: WeixinProtocolClient;
  private dispatcher: OutboxDispatcher;
  private active = true;
  connected = false;
  constructor(private core: BridgeCore, private credential: WeixinCredential, private fetchFn: typeof fetch = fetch) {
    this.client = createWeixinClient(credential, fetchFn);
    this.dispatcher = new OutboxDispatcher(core, "weixin", (entry) => this.active && this.connected &&
      entry.origin.accountId === credential.accountId && entry.origin.peerId === credential.ownerId && !!this.context(), async (entry) => {
      const item: MessageItem = entry.attachment ? await this.upload(entry.attachment) : { type: 1, text_item: { text: entry.text } };
      if (!this.active) throw new BridgeError("CHANNEL_CLOSED", "微信通道已关闭，附件未提交。");
      await this.client.sendMessage({ msg: { from_user_id: "", to_user_id: credential.ownerId,
        client_id: createHash("sha256").update(entry.id).digest("hex"), message_type: 2, message_state: 2,
        context_token: this.context(), item_list: [item] } });
    });
  }
  private async upload(attachment: OutputAttachment): Promise<MessageItem> {
    const bytes = attachmentBytes(attachment), key = randomBytes(16), filekey = randomBytes(16).toString("hex");
    const cipher = createCipheriv("aes-128-ecb", key, null), encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
    const result = await this.client.getUploadUrl({ filekey, media_type: { image: 1, video: 2, file: 3 }[attachment.type],
      to_user_id: this.credential.ownerId, rawsize: bytes.length, rawfilemd5: createHash("md5").update(bytes).digest("hex"),
      filesize: encrypted.length, no_need_thumb: true, aeskey: key.toString("hex") });
    if (!result.upload_full_url && !result.upload_param) throw new BridgeError("CHANNEL_PROTOCOL", "微信未返回附件上传地址。");
    const url = new URL(result.upload_full_url || "https://novac2c.cdn.weixin.qq.com/c2c/upload?" +
      new URLSearchParams({ encrypted_query_param: result.upload_param!, filekey }));
    if (url.protocol !== "https:" || !url.hostname.endsWith(".cdn.weixin.qq.com") || url.username || url.password || url.port) {
      throw new BridgeError("INVALID_ENDPOINT", "微信附件上传地址未通过校验。");
    }
    const response = await this.fetchFn(url.toString(), { method: "POST", redirect: "error", signal: AbortSignal.timeout(30000),
      headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array(encrypted) });
    const parameter = response.headers.get("x-encrypted-param");
    await response.body?.cancel();
    if (!response.ok || !parameter || parameter.length > 16384) throw new BridgeError("CHANNEL_NETWORK", "微信附件上传未完成。");
    const media = { encrypt_query_param: parameter, aes_key: Buffer.from(key.toString("hex"), "ascii").toString("base64"), encrypt_type: 1 };
    if (attachment.type === "image") return { type: 2, image_item: { media, mid_size: encrypted.length } };
    if (attachment.type === "video") return { type: 5, video_item: { media, video_size: encrypted.length } };
    return { type: 4, file_item: { media, file_name: attachment.name, len: String(bytes.length) } };
  }
  private scope(): string { return JSON.stringify(["weixin", this.credential.accountId, this.credential.ownerId]); }
  private context(): string | undefined {
    const sealed = this.core.context("weixin", this.credential.accountId, this.credential.ownerId);
    return sealed ? openContext(sealed, this.credential.contextKey, this.scope()) : undefined;
  }
  async poll(signal: AbortSignal): Promise<void> {
    try {
      const response: GetUpdatesResp = await this.client.getUpdates({ getUpdatesBuf: this.core.checkpoint("weixin", this.credential.accountId), signal });
      if (!this.active || signal.aborted) return;
      if (response.ret === -14 || response.errcode === -14) throw new BridgeError("CHANNEL_EXPIRED", "微信凭据失效，请重新扫码。");
      if (!response || (response.ret === undefined && response.msgs === undefined && response.get_updates_buf === undefined) ||
          (response.ret !== undefined && response.ret !== 0) || (response.errcode !== undefined && response.errcode !== 0) ||
          (response.msgs !== undefined && !Array.isArray(response.msgs))) {
        const code = (value: unknown) => Number.isSafeInteger(value) ? String(value) : "缺失";
        throw new BridgeError("CHANNEL_PROTOCOL", "微信响应异常（ret=" + code(response?.ret) + "，errcode=" + code(response?.errcode) + "），游标未推进。");
      }
      const events: ChannelEvent[] = [];
      for (const message of response.msgs ?? []) {
        if (!message || message.message_type !== 1 || message.message_state !== 2 || message.group_id ||
            message.from_user_id !== this.credential.ownerId || (message.to_user_id && message.to_user_id !== this.credential.accountId)) continue;
        const eventId = messageID(message.message_id);
        const items = Array.isArray(message.item_list) ? message.item_list : [];
        const supported = items.length > 0 && items.every((item) => item?.type === 1 && typeof item.text_item?.text === "string");
        const token = typeof message.context_token === "string" && message.context_token.length <= 16384 ? message.context_token : undefined;
        events.push({ origin: { kind: "weixin", accountId: this.credential.accountId, peerId: this.credential.ownerId,
          eventId }, text: supported ? items.map((item) => item.text_item!.text).join("\n") : "",
          rejection: supported ? undefined : "当前只支持文字，附件和语音未执行。请发送文字消息。",
          sealedContext: token ? sealContext(token, this.credential.contextKey, this.scope()) : undefined });
      }
      const cursor = response.get_updates_buf;
      if (cursor !== undefined && (typeof cursor !== "string" || cursor.length > 65536)) throw new BridgeError("CHANNEL_PROTOCOL", "微信游标无效。");
      const prepared = await this.core.prepareEvents(events);
      if (!this.active || signal.aborted) return;
      this.core.ingestBatch("weixin", this.credential.accountId, cursor || this.core.checkpoint("weixin", this.credential.accountId), prepared);
      this.connected = true;
    } catch (error) {
      this.connected = false;
      if (error instanceof BridgeError) throw error;
      throw new BridgeError("CHANNEL_NETWORK", "微信连接中断，正在等待重连。");
    }
  }
  flush(): Promise<void> { return this.dispatcher.drain(); }
  stop(): void { this.active = false; this.connected = false; }
}
