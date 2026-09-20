import { BridgeError, type AssistantMessageUpdate, type TurnHooks } from "./core.js";

// Only adapters' explicit public-text events enter this collector.
export class AssistantText {
  private messages = new Map<string, AssistantMessageUpdate>();
  private bytes = 0;
  constructor(private hooks: TurnHooks) {}
  get text(): string { return [...this.messages.values()].map((message) => message.text).filter(Boolean).join("\n\n"); }
  get lastText(): string { return [...this.messages.values()].filter((message) => message.text).at(-1)?.text ?? ""; }
  has(id: string): boolean { return this.messages.has(id); }
  update(id: string, text: string, completed = false): void {
    const previous = this.messages.get(id);
    if (!id || previous?.completed || previous?.text === text && previous.completed === completed) return;
    const bytes = this.bytes + Buffer.byteLength(text) - Buffer.byteLength(previous?.text ?? "");
    if (bytes > 1024 * 1024 || !previous && this.messages.size >= 512) throw new BridgeError("SEND_UNCERTAIN", "正文超过接收上限，请在原会话中查看。未自动重试。");
    this.bytes = bytes;
    const message = { id, text, completed }; this.messages.set(id, message);
    if (text) this.hooks.message?.(message);
  }
  append(id: string, delta: string): void { this.update(id, (this.messages.get(id)?.text ?? "") + delta); }
  finish(): void {
    for (const message of this.messages.values()) this.update(message.id, message.text, true);
  }
}
