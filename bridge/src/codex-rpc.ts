import type { Readable, Writable } from "node:stream";
import { BridgeError } from "./core.js";

type Packet = { id?: string | number; method?: string; params?: any; result?: any; error?: unknown };
export type CodexConnection = { input: Readable; output: Writable; close(): void };

export class CodexRPCError extends BridgeError {
  readonly busyThreadId?: string;
  constructor(error: any) {
    super("RUNTIME_REJECTED", "Codex 拒绝了该操作，请在本机检查运行时状态。");
    if (error?.code === -32600 && typeof error.message === "string") {
      this.busyThreadId = /^thread ([\w-]+) already has an active writer$/.exec(error.message)?.[1];
    }
  }
}

// App Server uses JSON-RPC envelopes without our native IPC's protocolVersion field.
export class CodexRPC {
  private sequence = 0;
  private buffer = "";
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  closed = false;
  onNotification: (method: string, params: any) => void = () => {};
  onRequest: (method: string, params: any) => Promise<unknown> = async () => { throw new Error("Unsupported"); };
  onClose: () => void = () => {};

  constructor(private connection: CodexConnection) {
    connection.input.setEncoding("utf8");
    connection.input.on("data", (chunk: string) => {
      if (this.closed) return;
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024) { this.close(); return; }
      let newline: number;
      while (!this.closed && (newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
        try {
          const packet = JSON.parse(line) as Packet;
          if (!packet || typeof packet !== "object" || Array.isArray(packet)) throw new Error("Invalid frame");
          this.receive(packet);
        } catch { this.close(); }
      }
    });
    connection.input.on("end", () => this.close());
    connection.input.on("error", () => this.close());
    connection.output.on("error", () => this.close());
  }
  private receive(packet: Packet): void {
    if (packet.method) {
      if (packet.id !== undefined) {
        void this.onRequest(packet.method, packet.params ?? {}).then((result) => {
          if (!this.closed) this.write({ id: packet.id, result });
        }, () => {
          if (!this.closed) this.write({ id: packet.id, error: { code: -32601, message: "This client does not support this request." } });
        }).catch(() => this.close());
      } else this.onNotification(packet.method, packet.params ?? {});
      return;
    }
    if (typeof packet.id !== "number") return;
    const pending = this.pending.get(packet.id);
    if (!pending) return;
    this.pending.delete(packet.id); clearTimeout(pending.timer);
    if (packet.error) pending.reject(new CodexRPCError(packet.error));
    else if (Object.hasOwn(packet, "result")) pending.resolve(packet.result);
    else { pending.reject(new BridgeError("SEND_UNCERTAIN", "运行时响应无效。")); this.close(); }
  }
  private write(packet: Packet): void {
    if (this.closed) throw new BridgeError("SEND_UNCERTAIN", "Codex 连接已断开，未自动重发。");
    const data = JSON.stringify(packet) + "\n";
    if (this.connection.output.writableLength + Buffer.byteLength(data) > 8 * 1024 * 1024) {
      this.close(); throw new BridgeError("SEND_UNCERTAIN", "Codex 连接拥塞，未自动重发。");
    }
    this.connection.output.write(data);
  }
  call<T = any>(method: string, params: unknown, timeout = 15_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => this.close(), timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  notify(method: string): void { this.write({ method }); }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.buffer = "";
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer); pending.reject(new BridgeError("SEND_UNCERTAIN", "Codex 连接中断，原操作可能已执行，未自动重发。"));
    }
    this.pending.clear(); this.connection.close(); this.onClose();
  }
}
