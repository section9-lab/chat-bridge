import { randomBytes, randomUUID } from "node:crypto";
import { BridgeError } from "./core.js";
import { createWeixinClient, validateBaseURL, type WeixinCredential } from "./weixin.js";
export type LoginState = { status: string; attemptId?: string; qrContent?: string; ownerId?: string; accountId?: string; message?: string };
export class WeixinLogin {
  state: LoginState = { status: "idle" };
  private controller = new AbortController();
  private deadline = 0;
  private qr = "";
  private credential?: WeixinCredential;
  private verification?: string;
  private client?: ReturnType<typeof createWeixinClient>;
  constructor(private fetchFn: typeof fetch = fetch, private now: () => number = Date.now) {}
  private makeClient(baseUrl = "https://ilinkai.weixin.qq.com") {
    const signal = this.controller.signal;
    return createWeixinClient({ baseUrl, token: "" }, (input, init) => {
      const url = new URL(String(input));
      if (this.verification && url.pathname.endsWith("get_qrcode_status")) url.searchParams.set("verify_code", this.verification);
      return this.fetchFn(url.toString(), { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal });
    });
  }
  async start(): Promise<void> {
    this.cancel();
    this.controller = new AbortController();
    const attemptId = randomUUID();
    this.state = { status: "loading", attemptId };
    this.deadline = this.now() + 10 * 60_000;
    this.client = this.makeClient();
    try {
      const qr = await this.client.fetchQRCode();
      if (this.state.attemptId !== attemptId) return;
      if (!qr || typeof qr.qrcode !== "string" || !qr.qrcode || qr.qrcode.length > 4096 ||
          typeof qr.qrcode_img_content !== "string" || !qr.qrcode_img_content || qr.qrcode_img_content.length > 4096) {
        throw new BridgeError("CHANNEL_PROTOCOL", "微信没有返回有效的二维码。");
      }
      this.qr = qr.qrcode;
      this.state = { status: "wait", attemptId, qrContent: qr.qrcode_img_content };
    } catch {
      if (this.state.attemptId !== attemptId) return;
      this.state = { status: "error", message: "无法获取微信二维码，请检查网络后重试。" };
      throw new BridgeError("CHANNEL_NETWORK", this.state.message!);
    }
  }
  async poll(): Promise<void> {
    if (!["wait", "scaned"].includes(this.state.status) || !this.client) return;
    this.checkExpiry();
    const attemptId = this.state.attemptId;
    const result = await this.client.pollQRStatus(this.qr);
    if (this.state.attemptId !== attemptId) return;
    this.checkExpiry();
    // The community client's narrow type does not yet include all Tencent QR states.
    const status = String(result.status);
    if (status === "confirmed") {
      const valid = (value: unknown): value is string => typeof value === "string" && !!value && value.length <= 16384 && !/[\r\n\0]/.test(value);
      if (!valid(result.bot_token) || !valid(result.ilink_bot_id) || !valid(result.ilink_user_id) || !valid(result.baseurl)) {
        this.state = { status: "error", message: "扫码身份不完整，未绑定账号。" };
        throw new BridgeError("CHANNEL_PROTOCOL", this.state.message!);
      }
      const baseUrl = validateBaseURL(result.baseurl);
      this.credential = { accountId: result.ilink_bot_id, ownerId: result.ilink_user_id, token: result.bot_token,
        baseUrl, contextKey: randomBytes(32).toString("base64") };
      this.verification = undefined;
      this.state = { status: "awaiting_confirmation", attemptId, accountId: result.ilink_bot_id, ownerId: result.ilink_user_id };
    } else if (status === "scaned_but_redirect") {
      if (!result.redirect_host) throw new BridgeError("CHANNEL_PROTOCOL", "扫码重定向缺少服务地址。");
      const baseUrl = validateBaseURL(result.redirect_host.includes("://") ? result.redirect_host : "https://" + result.redirect_host);
      this.client = this.makeClient(baseUrl);
    } else if (["wait", "scaned", "need_verifycode"].includes(status)) {
      this.state = { ...this.state, status };
    } else {
      this.credential = undefined;
      this.state = { status: status === "expired" ? "expired" : "error",
        message: status === "expired" ? "二维码已过期，请重新获取。" : "微信要求重新扫码，账号尚未绑定。" };
    }
  }
  cancel(): void {
    this.controller.abort(); this.credential = undefined; this.verification = undefined; this.qr = "";
    this.state = { status: "idle" };
  }
  verify(code: string): void {
    if (this.state.status !== "need_verifycode" || !/^[A-Za-z0-9]{4,16}$/.test(code)) {
      throw new BridgeError("INVALID_INPUT", "请输入微信显示的 4–16 位验证码。");
    }
    this.checkExpiry(); this.verification = code; this.state = { ...this.state, status: "wait" };
  }
  private checkExpiry(): void {
    if (this.now() >= this.deadline) {
      this.credential = undefined; this.state = { status: "expired", message: "扫码确认已过期，请重新获取二维码。" };
      throw new BridgeError("LOGIN_EXPIRED", this.state.message!);
    }
  }
  confirm(attempt: string): WeixinCredential {
    this.checkExpiry();
    if (attempt !== this.state.attemptId) throw new BridgeError("STALE_LOGIN", "扫码状态已改变，请重新核对账号。");
    if (this.state.status !== "awaiting_confirmation" || !this.credential) throw new BridgeError("INVALID_STATE", "请先完成微信扫码。");
    return { ...this.credential };
  }
}
