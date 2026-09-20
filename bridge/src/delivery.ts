import type { BridgeCore, OutboxEntry } from "./core.js";
export class OutboxDispatcher {
  private pending?: Promise<void>;
  private requested = false;
  constructor(private core: BridgeCore, private kind: string, private ready: (entry: OutboxEntry) => boolean,
    private send: (entry: OutboxEntry) => Promise<void>) {}
  drain(): Promise<void> {
    this.requested = true;
    this.pending ??= Promise.resolve().then(async () => {
      do {
        this.requested = false;
        for (const entry of this.core.outbox()) {
          if (entry.origin.kind !== this.kind || entry.status !== "pending") continue;
          const interrupted = entry.batchId && this.core.outbox().some((prior) => prior.batchId === entry.batchId &&
            ["delivery_unknown", "rejected", "cancelled"].includes(prior.status));
          if (!this.core.canReplyTo(entry.origin) || interrupted) {
            this.core.markDelivery(entry.id, "cancelled", "原通道绑定已失效，或此前分段的发送状态不确定。"); continue;
          }
          if (!this.ready(entry)) continue;
          // This durable transition precedes the non-idempotent external side effect.
          this.core.markDelivery(entry.id, "dispatching");
          try {
            await this.send(entry);
            this.core.markDelivery(entry.id, "submitted");
          } catch {
            this.core.markDelivery(entry.id, "delivery_unknown", "提交结果不确定，请在消息应用核对；未自动重发。");
          }
        }
      } while (this.requested);
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
}
