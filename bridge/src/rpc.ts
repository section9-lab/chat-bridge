import type { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";

export class RPCError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}
export type Handler = (params: unknown) => unknown | Promise<unknown>;

export class RPCPeer {
  onEvent: (method: string, params: unknown) => void = () => {};
  onClose: () => void = () => {};
  private buffer = Buffer.alloc(0);
  private closed = false;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly maxBytes = 1024 * 1024;
  constructor(private input: Readable, private output: Writable, private handlers: Record<string, Handler>, private timeout = 15_000) {
    input.on("data", this.read);
    input.on("end", this.close);
    input.on("error", this.close);
    output.on("error", this.close);
  }
  call<T>(method: string, params: unknown = {}): Promise<T> {
    if (this.closed) return Promise.reject(new RPCError("CLOSED", "本地连接已关闭。"));
    return new Promise<T>((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new RPCError("TIMEOUT", "操作超时，执行结果可能不确定；未自动重试。"));
      }, this.timeout);
      this.pending.set(requestId, { resolve: (value) => resolve(value as T), reject, timer });
      this.write({ protocolVersion: 1, requestId, method, params });
    });
  }
  event(method: string, params: unknown): void { this.write({ protocolVersion: 1, event: true, method, params }); }
  private write(value: unknown): void {
    if (this.closed) return;
    const line = Buffer.from(JSON.stringify(value) + "\n");
    if (line.length - 1 > this.maxBytes || this.output.writableLength > this.maxBytes * 4) { this.close(); return; }
    try { this.output.write(line); } catch { this.close(); }
  }
  private read = (chunk: Buffer): void => {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let newline: number;
    while (!this.closed && (newline = this.buffer.indexOf(10)) !== -1) {
      if (newline > this.maxBytes) { this.close(); return; }
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(line);
        this.frame(JSON.parse(text) as Record<string, unknown>);
      } catch { this.close(); }
    }
    if (this.buffer.length > this.maxBytes) this.close();
  };
  private frame(frame: Record<string, unknown>): void {
    if (!frame || Array.isArray(frame) || frame.protocolVersion !== 1) { this.close(); return; }
    if (frame.event === true && typeof frame.method === "string" && !frame.requestId) {
      this.onEvent(frame.method, frame.params); return;
    }
    if (typeof frame.requestId !== "string" || !frame.requestId || frame.requestId.length > 64) { this.close(); return; }
    const requestId = frame.requestId;
    if (typeof frame.method === "string") {
      const handler = Object.hasOwn(this.handlers, frame.method) ? this.handlers[frame.method] : undefined;
      Promise.resolve().then(() => {
        if (!handler) throw new RPCError("METHOD_NOT_FOUND", "未允许的本地操作。");
        return handler(frame.params);
      }).then((result) => this.write({ protocolVersion: 1, requestId, result: result ?? null }),
        (error: unknown) => this.write({ protocolVersion: 1, requestId, error: error instanceof RPCError ?
          { code: error.code, message: error.message } : { code: "INTERNAL", message: "本地操作失败。" } }));
      return;
    }
    if (Object.hasOwn(frame, "result") === Object.hasOwn(frame, "error")) { this.close(); return; }
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    if (frame.error) {
      const error = frame.error as Record<string, unknown>;
      pending.reject(new RPCError(typeof error.code === "string" ? error.code : "INTERNAL",
        typeof error.message === "string" ? error.message : "本地操作失败。"));
    } else pending.resolve(frame.result);
  }
  close = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.input.off("data", this.read);
    this.input.off("end", this.close);
    this.input.off("error", this.close);
    this.output.off("error", this.close);
    this.buffer = Buffer.alloc(0);
    for (const value of this.pending.values()) { clearTimeout(value.timer); value.reject(new RPCError("CLOSED", "本地连接已关闭。")); }
    this.pending.clear();
    this.onClose();
  };
}
