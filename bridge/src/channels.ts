import { BridgeError, type BridgeCore } from "./core.js";
import { WeixinLogin, type LoginState } from "./weixin-login.js";
import { WeixinTransport, validateBaseURL, type WeixinCredential } from "./weixin.js";
import { RPCError } from "./rpc.js";
export interface CredentialVault { read(): Promise<unknown>; write(value: unknown): Promise<void>; remove(): Promise<void> }
export class ChannelController {
  private status: LoginState = { status: "idle" };
  private login: WeixinLogin;
  private transport?: WeixinTransport;
  private controller = new AbortController();
  private mutations: Promise<void> = Promise.resolve();
  private ticking = false;
  private closed = false;
  private retryAt = 0;
  private failures = 0;
  get state() { return { ...this.status, bound: this.core.state().bindings.some((binding) => binding.kind === "weixin"), connected: this.transport?.connected === true }; }
  constructor(private core: BridgeCore, private vault: CredentialVault, private changed: () => void, private fetchFn?: typeof fetch) {
    this.login = new WeixinLogin(fetchFn);
  }
  private serialize(action: () => Promise<void>): Promise<void> {
    const next = this.mutations.then(async () => { if (!this.closed) await action(); });
    this.mutations = next.catch(() => {});
    return next;
  }
  startLogin(): Promise<void> {
    return this.serialize(async () => {
      if (this.state.bound) throw new BridgeError("INVALID_STATE", "请先解除已有微信绑定，再绑定新账号。");
      this.status = { status: "loading" }; this.changed();
      try { await this.login.start(); }
      finally { if (!this.closed) { this.status = this.login.state; this.changed(); } }
    });
  }
  cancelLogin(): Promise<void> {
    return this.serialize(async () => { this.login.cancel(); this.status = this.login.state; this.changed(); });
  }
  verify(code: string): Promise<void> {
    return this.serialize(async () => { this.login.verify(code); this.status = this.login.state; this.changed(); });
  }
  confirm(attempt: string): Promise<void> {
    return this.serialize(async () => {
      const credential = this.login.confirm(attempt);
      try { await this.vault.write(credential); }
      catch { throw new BridgeError("KEYCHAIN_FAILED", "钥匙串保存失败，账号未启用。请检查系统授权后重试。"); }
      if (this.closed) return;
      this.core.bindChannel("weixin", credential.accountId, credential.ownerId);
      this.login.cancel(); this.connect(credential);
    });
  }
  restore(): Promise<void> {
    return this.serialize(async () => {
      if (!this.state.bound) return;
      this.stopTransport();
      try {
        const value = await this.vault.read();
        if (this.closed) return;
        if (!value || typeof value !== "object") throw new Error("Missing credential");
        const credential = value as WeixinCredential;
        if ([credential.accountId, credential.ownerId, credential.token, credential.baseUrl, credential.contextKey].some((part) => typeof part !== "string" || !part || part.length > 16384) ||
            !this.core.isBound({ kind: "weixin", accountId: credential.accountId, peerId: credential.ownerId }) ||
            Buffer.from(credential.contextKey, "base64").length !== 32) throw new Error("Invalid credential");
        validateBaseURL(credential.baseUrl);
        this.connect(credential);
      } catch (error) {
        const code = error instanceof RPCError ? error.code : "";
        const message = code === "TIMEOUT" ? "读取钥匙串超时。请检查 macOS 的授权提示后重新连接，账号绑定已保留。" :
          /^KEYCHAIN_-?\d+$/.test(code) ? "macOS 拒绝读取钥匙串（状态码 " + code.slice(9) + "）。请检查系统授权后重新连接，账号绑定已保留。" :
          "无法读取匹配的微信钥匙串凭据，请重连或解除绑定后重新扫码。";
        this.status = { status: "error", message }; this.changed();
      }
    });
  }
  private connect(credential: WeixinCredential): void {
    this.stopTransport(); this.controller = new AbortController();
    this.transport = new WeixinTransport(this.core, credential, this.fetchFn);
    this.retryAt = 0; this.failures = 0;
    this.status = { status: "connecting", accountId: credential.accountId, ownerId: credential.ownerId }; this.changed();
  }
  async tick(): Promise<void> {
    if (this.closed || this.ticking || Date.now() < this.retryAt) return;
    this.ticking = true;
    const transport = this.transport;
    try {
      if (transport) {
        await transport.poll(this.controller.signal);
        if (this.closed || transport !== this.transport) return;
        this.failures = 0; this.retryAt = 0;
        this.status = { ...this.status, status: "connected", message: undefined }; this.changed();
        await transport.flush();
      } else if (["wait", "scaned"].includes(this.login.state.status)) {
        await this.login.poll();
        if (!this.closed && !this.transport) { this.status = this.login.state; this.changed(); }
      }
    } catch (error) {
      if (this.closed || transport !== this.transport) return;
      const code = error instanceof BridgeError ? error.code : "UNKNOWN";
      if (transport) {
        if (code === "CHANNEL_EXPIRED") this.stopTransport();
        this.retryAt = Date.now() + Math.min(60_000, 2000 * 2 ** Math.min(this.failures++, 5));
        const detail = error instanceof BridgeError && ["CHANNEL_PROTOCOL", "CHANNEL_NETWORK", "INVALID_ENDPOINT"].includes(code)
          ? error.message.slice(code.length + 2) : "微信连接中断，游标已保留，稍后自动重连。";
        this.status = { ...this.status, status: code === "CHANNEL_EXPIRED" ? "expired" : "error",
          message: code === "CHANNEL_EXPIRED" ? "微信凭据已失效，请解除绑定后重新扫码。" : detail };
      } else {
        this.login.cancel(); this.status = { status: code === "LOGIN_EXPIRED" ? "expired" : "error", message: "扫码未完成，请重新获取二维码。" };
      }
      this.changed();
    } finally { this.ticking = false; }
  }
  flush(): Promise<void> { return this.transport?.flush() ?? Promise.resolve(); }
  disconnect(): Promise<void> {
    return this.serialize(async () => {
      this.login.cancel(); this.stopTransport(); this.core.unbindChannel("weixin");
      this.status = { status: "idle" }; this.changed();
      try { await this.vault.remove(); }
      catch { throw new BridgeError("KEYCHAIN_FAILED", "通道已停止；钥匙串删除失败，请在“钥匙串访问”中删除 Chat Bridge 的微信凭据。"); }
    });
  }
  private stopTransport(): void { this.controller.abort(); this.transport?.stop(); this.transport = undefined; }
  close(): void { this.closed = true; this.login.cancel(); this.stopTransport(); }
}
