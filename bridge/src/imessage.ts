import { randomBytes } from "node:crypto";
import { BridgeError, type BridgeCore, type ChannelEvent, type IMessageConfiguration } from "./core.js";
import { openIMessageSource, sendIMessageNotice, type IMessageSource, type MessageCursor } from "./imessage-source.js";
import { OutboxDispatcher } from "./delivery.js";
import { attachmentBytes } from "./outputs.js";
export type IMessageState = { status: string; connected: boolean; bound: boolean; email?: string; phone?: string;
  message?: string };
export class IMessageController {
  state: IMessageState = { status: "idle", connected: false, bound: false };
  private source?: IMessageSource;
  private configuration?: IMessageConfiguration;
  private cursor: MessageCursor = { rowId: 0, guid: "" };
  private deadline = 0;
  private startedAt = 0;
  private requestEcho?: { id: string; createdAt: number };
  private verificationText = "";
  private enabled = false;
  private accessDenied = false;
  private nextRestoreAt = 0;
  private ticking = false;
  private generation = 0;
  private dispatcher: OutboxDispatcher;
  constructor(private core: BridgeCore, private changed: () => void, private open: () => IMessageSource = openIMessageSource,
    private sendNotice: (phone: string, text: string) => Promise<void> = sendIMessageNotice) {
    this.dispatcher = new OutboxDispatcher(core, "imessage", (entry) =>
      entry.origin.accountId === this.configuration?.email && entry.origin.peerId === this.configuration?.phone &&
      (entry.kind === "access_notice" ? this.accessDenied && this.state.bound : this.enabled && this.state.connected && !!this.source),
      async (entry) => {
        if (entry.kind === "access_notice") await this.sendNotice(entry.origin.peerId, entry.text);
        else if (entry.attachment) {
          attachmentBytes(entry.attachment);
          await this.source!.send(entry.origin.peerId, "", entry.attachment.path);
        } else await this.source!.send(entry.origin.peerId, entry.text);
      });
  }
  private update(patch: Partial<IMessageState>): void { this.state = { ...this.state, ...patch }; this.changed(); }
  async start(email: string, phone: string): Promise<void> {
    email = email.trim().toLowerCase(); phone = phone.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || !/^\+[1-9]\d{7,14}$/.test(phone)) {
      throw new BridgeError("INVALID_INPUT", "请输入 Mac 的 iMessage 邮箱，以及包含国家区号的手机号（例如 +65…）。");
    }
    if (this.core.state().bindings.some((binding) => binding.kind === "imessage")) throw new BridgeError("INVALID_STATE", "请先解除已有 iMessage 绑定。");
    if (["preparing", "dispatching_verification", "awaiting_phone"].includes(this.state.status)) {
      throw new BridgeError("INVALID_STATE", "配对正在进行，请在手机回复 OK，或先取消本次配对。");
    }
    this.state = { status: "preparing", bound: false, connected: false, email, phone }; this.changed();
    const closing = this.close(), generation = this.generation;
    await closing;
    if (generation !== this.generation) return;
    this.configuration = { email, phone, chatId: "" };
    this.requestEcho = undefined; this.verificationText = "";
    try {
      const source = this.open(); this.source = source;
      this.cursor = source.tail();
      await source.read(this.cursor.rowId); // Validate the installed Messages schema without processing history.
      if (generation !== this.generation) return;
    } catch (error) {
      if (generation !== this.generation) return;
      await this.close();
      const failure = readFailure(error);
      this.update({ status: "error", message: failure.message.slice(failure.code.length + 2) });
      throw failure;
    }
    const source = this.source!;
    this.startedAt = Date.now();
    this.deadline = this.startedAt + 10 * 60_000;
    this.verificationText = "Chat Bridge 配对请求\n请确认本条消息的发件邮箱是 " + email +
      "。\n如果这是你刚在 Mac 上发起的请求，请在此对话回复 OK，启用 iMessage 通道。\n10 分钟内有效；不是本人操作请忽略。\n请求编号：" + randomBytes(6).toString("hex");
    this.update({ status: "dispatching_verification", message: "正在向手机发送配对请求…" });
    try {
      await source.send(phone, this.verificationText);
      if (source === this.source) this.update({ status: "awaiting_phone", message: "配对请求已提交。请在手机核对发件邮箱并回复 OK，收到回复后自动完成配对。" });
    } catch {
      if (source !== this.source) return;
      await this.close();
      const message = "配对请求的发送结果不确定，未自动重发。请确认 Mac 的“消息”已打开且可发送 iMessage，并检查自动化权限；在“消息”中核对后重新配对。";
      this.update({ status: "error", message });
      throw new BridgeError("SEND_UNCERTAIN", message);
    }
  }
  private checkExpiry(): void {
    if (Date.now() >= this.deadline) throw new BridgeError("PAIRING_EXPIRED", "配对已超过 10 分钟，请重新开始。");
  }
  async restore(): Promise<void> {
    if (!this.core.state().bindings.some((binding) => binding.kind === "imessage")) return;
    const closing = this.close(), generation = this.generation;
    await closing;
    if (generation !== this.generation) return;
    try {
      const configuration = this.core.iMessageConfiguration();
      if (!configuration || !this.core.isBound({ kind: "imessage", accountId: configuration.email, peerId: configuration.phone })) throw new Error("No confirmed binding");
      this.configuration = configuration;
      this.state = { status: "connecting", connected: false, bound: true, email: configuration.email, phone: configuration.phone };
      const cursor = JSON.parse(this.core.checkpoint("imessage", configuration.email)) as MessageCursor;
      if (!Number.isSafeInteger(cursor.rowId) || cursor.rowId < 0 || typeof cursor.guid !== "string") throw new Error("Invalid cursor");
      this.source = this.open(); this.cursor = cursor; this.enabled = true;
      this.changed();
    } catch (error) {
      const failure = readFailure(error);
      this.accessDenied = failure.code === "IMESSAGE_ACCESS_DENIED";
      if (this.accessDenied) this.nextRestoreAt = Date.now() + 5000;
      this.update({ status: "error", bound: true, connected: false, message: failure.message.slice(failure.code.length + 2) });
      if (this.accessDenied) this.core.setIMessageAccessDenied(true);
    }
  }
  async tick(): Promise<void> {
    if (this.ticking) return;
    if (!this.source && this.accessDenied && this.state.bound && Date.now() >= this.nextRestoreAt) {
      this.ticking = true;
      try { await this.restore(); }
      finally { this.ticking = false; }
    }
    if (!this.source || !this.configuration || (!this.enabled && this.state.status !== "awaiting_phone")) return;
    const source = this.source, configuration = this.configuration;
    this.ticking = true;
    try {
      if (!this.enabled) this.checkExpiry();
      if (!source.matches(this.cursor)) throw new BridgeError("CURSOR_CHANGED", "Messages 数据库或游标记录已改变。请解除绑定并重新配对，未重放历史。");
      const messages = await source.read(this.cursor.rowId);
      if (source !== this.source) return;
      if (this.enabled) { this.accessDenied = false; this.core.setIMessageAccessDenied(false); }
      let cursor = this.cursor;
      const events: ChannelEvent[] = [];
      for (const message of messages) {
        if (!Number.isSafeInteger(message.rowId) || message.rowId <= cursor.rowId || !message.id) throw new BridgeError("INVALID_CURSOR", "消息游标顺序异常，未推进。");
        if (message.service === "iMessage" && message.kind === "text" && !message.isSystem &&
            (!message.chatId || !message.participant)) throw new BridgeError("IDENTITY_PENDING", "Messages 正在同步消息身份，稍后重试；游标未推进。");
        cursor = { rowId: message.rowId, guid: message.id };
        if (message.service !== "iMessage" || message.isDowngraded || message.participant !== configuration.phone ||
            message.chatKind !== "dm" || message.kind !== "text" || message.isSystem || message.isAutoReply || message.reaction || message.retractedAt) continue;
        if (this.enabled) {
          if (message.isFromMe || message.chatId !== configuration.chatId) continue;
          const text = message.text ?? "";
          events.push({ origin: { kind: "imessage", accountId: configuration.email, peerId: configuration.phone, eventId: message.id }, text,
            rejection: message.hasAttachments || message.attachments.length ? "当前只支持文字，附件未执行。" :
              /^\/(pair|confirm)\s/.test(text) ? "此通道已经配对，请发送 /help 查看命令。" : undefined });
        } else {
          const createdAt = message.createdAt.getTime();
          if (!(createdAt >= this.startedAt && createdAt < this.deadline) || message.hasError || message.isForwarded ||
              message.hasAttachments || message.attachments.length || message.editedAt || message.recoveredAt) continue;
          if (message.text === this.verificationText) {
            if (!message.isFromMe) throw new BridgeError("ECHO_UNSAFE", "Mac 发出的配对请求被识别为来信，未启用转发。请检查邮箱与手机号的收发设置。");
            configuration.chatId = message.chatId!;
            this.requestEcho = { id: message.id, createdAt };
          }
          if (message.text?.trim().toUpperCase() === "OK" && this.requestEcho && message.chatId === configuration.chatId &&
              createdAt >= this.requestEcho.createdAt && (!message.replyToMessageId || message.replyToMessageId === this.requestEcho.id)) {
            if (message.isFromMe) throw new BridgeError("ECHO_UNSAFE", "手机回复被识别为本机发送，暂不能安全转发。请检查邮箱与手机号的收发设置。");
            this.core.activateIMessage(configuration, JSON.stringify(cursor));
            this.cursor = cursor;
            this.enabled = true;
            this.state = { status: "connecting", connected: false, bound: true, email: configuration.email, phone: configuration.phone }; this.changed();
          }
        }
      }
      if (this.enabled) {
        const prepared = await this.core.prepareEvents(events);
        if (source !== this.source || !this.enabled) return;
        this.core.ingestBatch("imessage", configuration.email, JSON.stringify(cursor), prepared);
        this.update({ status: "connected", connected: true, message: undefined });
      }
      this.cursor = cursor;
    } catch (error) {
      if (source !== this.source) return;
      const failure = readFailure(error);
      this.accessDenied = failure.code === "IMESSAGE_ACCESS_DENIED";
      this.update({ status: "error", connected: false, message: failure.message.slice(failure.code.length + 2) });
      if (this.accessDenied && this.state.bound) this.core.setIMessageAccessDenied(true);
    } finally { this.ticking = false; }
  }
  async flush(): Promise<void> {
    await this.dispatcher.drain();
    if (!this.accessDenied) return;
    const notice = this.core.outbox().findLast((entry) => entry.kind === "access_notice" && this.core.canReplyTo(entry.origin));
    if (notice?.status === "delivery_unknown" && !this.state.message?.includes("权限提醒未能确认发出")) {
      this.update({ message: (this.state.message ?? "") + " 权限提醒未能确认发出。请检查 Mac“消息”是否已打开及自动化权限；未自动重发。" });
    }
  }
  async disconnect(): Promise<void> {
    this.enabled = false;
    this.core.unbindChannel("imessage");
    await this.close();
    this.configuration = undefined;
    this.state = { status: "idle", connected: false, bound: false }; this.changed();
  }
  async close(): Promise<void> {
    this.generation++; this.enabled = false; this.accessDenied = false; this.state.connected = false;
    const source = this.source; this.source = undefined;
    await source?.close();
  }
}

function readFailure(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error;
  let cause = error;
  for (let depth = 0; depth < 5 && cause instanceof Error && cause.cause instanceof Error; depth++) cause = cause.cause;
  const code = cause instanceof Error ? (cause as NodeJS.ErrnoException).code : undefined;
  if (code === "EPERM" || code === "EACCES" || code === "SQLITE_AUTH" || code === "SQLITE_PERM") {
    return new BridgeError("IMESSAGE_ACCESS_DENIED", "系统拒绝读取 Messages（" + code + "）。请为当前版本的 Chat Bridge 开启完全磁盘访问。已绑定通道会自动重试；若权限已开启但仍未恢复，请完全退出并重新打开应用，并检查授权是否对应当前应用。");
  }
  if (code === "ENOENT") {
    return new BridgeError("IMESSAGE_DATABASE_MISSING", "未找到 Messages 数据库。请先打开 Mac 的“消息”并登录 iMessage，完成同步后重试。");
  }
  if (code === "SQLITE_ERROR" && cause instanceof Error && /no such (column|table)/i.test(cause.message)) {
    return new BridgeError("IMESSAGE_SCHEMA_UNSUPPORTED", "当前 Messages 数据库结构与此版本不兼容，需要更新适配；重复开启权限无法解决。");
  }
  if (code === "SQLITE_CANTOPEN") {
    return new BridgeError("IMESSAGE_DATABASE_UNAVAILABLE", "Messages 数据库无法打开（SQLITE_CANTOPEN）。请确认“消息”可正常使用，并在检查完全磁盘访问后重启 Chat Bridge。此错误尚不能确定是权限还是数据库文件问题。");
  }
  const diagnostic = code && /^(SQLITE_[A-Z_]+|ERR_[A-Z_]+|E[A-Z]+|DATABASE|CONFIG|PLATFORM)$/.test(code) ? code : "UNKNOWN";
  return new BridgeError("IMESSAGE_UNAVAILABLE", "Messages 读取检查失败（" + diagnostic + "）。请重启 Chat Bridge 后重试；若仍失败，请提供此诊断码。");
}
