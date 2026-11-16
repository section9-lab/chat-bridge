import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, basename } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { BridgeError, type AgentAdapter, type AgentProbe, type NativeMessage, type NativeProject,
  type NativeSession, type Target, type TurnHooks, type TurnResult } from "./core.js";

type Installation = { installed: boolean; executablePath?: string; version?: string };
type PiOptions = { workspace: string; projectlessRoot?: string; locate(): Promise<Installation>;
  onAvailability?: () => void; onExecution?: (error: string | null) => void };
type Pending = { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout };
type PiState = { sessionId?: string; sessionFile?: string; sessionName?: string; model?: unknown; cwd?: string };

const exec = promisify(execFile);

/** JSONL transport for one Pi RPC process. */
class PiRPC {
  private child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private pending = new Map<string, Pending>();
  private closed = false;
  onEvent?: (event: any) => void;
  onClose?: (error: Error) => void;

  constructor(executable: string, cwd: string, args: string[]) {
    this.child = spawn(process.execPath, [executable, "--mode", "rpc", ...args], {
      cwd, stdio: ["pipe", "pipe", "pipe"],
      env: { HOME: process.env.HOME, LANG: "en_US.UTF-8", NO_COLOR: "1", PATH: [
        dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin",
      ].join(":") },
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.consume(chunk));
    this.child.stderr.resume();
    this.child.on("error", (error) => this.shutdown(error));
    this.child.on("exit", (code, signal) => this.shutdown(new Error(`Pi 已退出（${signal ?? code ?? "unknown"}）`)));
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const end = this.buffer.indexOf("\n");
      if (end < 0) return;
      let line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let record: any;
      try { record = JSON.parse(line); } catch { continue; }
      if (record?.type === "response" && typeof record.id === "string") {
        const pending = this.pending.get(record.id);
        if (!pending) continue;
        this.pending.delete(record.id); clearTimeout(pending.timer);
        if (record.success === false) pending.reject(new BridgeError("RUNTIME_REJECTED", String(record.error ?? "Pi 拒绝了请求。")));
        else pending.resolve(record.data);
      } else {
        this.onEvent?.(record);
      }
    }
  }

  request(command: Record<string, unknown>, timeout = 30_000): Promise<any> {
    if (this.closed) return Promise.reject(new BridgeError("AGENT_UNAVAILABLE", "Pi 连接已关闭。"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError("AGENT_UNAVAILABLE", "Pi 请求超时。"));
      }, timeout);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, ...command }) + "\n");
    });
  }

  close(): void {
    if (this.closed) return;
    this.shutdown(new Error("Pi 连接已关闭。"));
    this.child.stdin.end();
    if (this.child.exitCode === null) {
      this.child.kill("SIGTERM");
      const timer = setTimeout(() => { if (this.child.exitCode === null) this.child.kill("SIGKILL"); }, 2000);
      timer.unref();
    }
  }

  private shutdown(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.onClose?.(error);
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block: any) => block?.type === "text" && typeof block.text === "string" ? [block.text] : []).join("");
}

function sessionRoot(): string {
  return join(homedir(), ".pi", "agent", "sessions");
}

function readSession(file: string): NativeSession | undefined {
  try {
    const raw = readFileSync(file, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    if (!lines.length) return undefined;
    const header = JSON.parse(lines[0]!);
    if (header?.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string" || !isAbsolute(header.cwd)) return undefined;
    let name: string | undefined;
    for (let index = lines.length - 1; index >= 0; index--) {
      try {
        const entry = JSON.parse(lines[index]!);
        if (entry?.type === "session_info" && typeof entry.name === "string") { name = entry.name; break; }
      } catch { /* Ignore a partial final line while Pi is writing. */ }
    }
    const stamp = typeof header.timestamp === "string" ? header.timestamp.slice(0, 10) : "";
    return { nativeId: file, title: name || (basename(header.cwd) + (stamp ? " · " + stamp : "")),
      projectId: header.cwd, cwd: header.cwd, runtime: "pi-rpc",
      updatedAt: statSync(file).mtimeMs / 1000 };
  } catch { return undefined; }
}

export class PiRuntime implements AgentAdapter {
  private installation: Installation = { installed: false };
  private clients = new Map<string, PiRPC>();
  private active = new Map<string, PiRPC>();
  private stopping = new Set<string>();
  private closed = false;
  constructor(private options: PiOptions) {}

  private cli(): string {
    if (!this.installation.executablePath) throw new BridgeError("AGENT_UNAVAILABLE", "未检测到 Pi 命令行程序。");
    return this.installation.executablePath;
  }

  private cwd(target: Target): string {
    const project = target.projectId;
    if (project && isAbsolute(project) && existsSync(project)) return project;
    return this.options.projectlessRoot ?? this.options.workspace;
  }

  private client(session: NativeSession): PiRPC {
    const cwd = session.cwd && isAbsolute(session.cwd) ? session.cwd : this.options.workspace;
    const cached = this.clients.get(session.nativeId);
    if (cached) return cached;
    if (!isAbsolute(session.nativeId) || !existsSync(session.nativeId)) throw new BridgeError("TARGET_MISSING", "Pi 会话文件不存在。");
    const client = new PiRPC(this.cli(), cwd, ["--session", session.nativeId]);
    client.onClose = () => {
      this.clients.delete(session.nativeId);
      if (!this.closed) this.options.onAvailability?.();
    };
    this.clients.set(session.nativeId, client);
    return client;
  }

  async probe(): Promise<AgentProbe> {
    try {
      this.installation = await this.options.locate();
      if (!this.installation.executablePath) return { installed: false, ready: false, status: "missing",
        reason: "请先安装 Pi 命令行程序，安装后会自动检测。" };
      await exec(process.execPath, [this.installation.executablePath, "--version"], { timeout: 8000 });
      return { installed: true, version: this.installation.version, ready: true, status: "ready",
        reason: "Pi 已就绪，可直接使用本机模型和会话。" };
    } catch {
      return { installed: this.installation.installed, version: this.installation.version, ready: false,
        status: this.installation.executablePath ? "error" : "missing",
        reason: this.installation.executablePath ? "Pi 连接检查失败，请检查本机安装、登录和模型配置。" : "请先安装 Pi 命令行程序，安装后会自动检测。" };
    }
  }

  async listProjects(): Promise<NativeProject[]> {
    const sessions = await this.listSessions();
    return [...new Set(sessions.map((session) => session.projectId).filter((cwd): cwd is string => Boolean(cwd)))]
      .map((cwd) => ({ id: cwd, name: basename(cwd), roots: [cwd] }));
  }

  async listSessions(): Promise<NativeSession[]> {
    const root = sessionRoot();
    if (!existsSync(root)) return [];
    const files: string[] = [];
    for (const directory of readdirSync(root, { withFileTypes: true })) {
      if (!directory.isDirectory()) continue;
      for (const file of readdirSync(join(root, directory.name), { withFileTypes: true })) {
        if (file.isFile() && file.name.endsWith(".jsonl")) files.push(join(root, directory.name, file.name));
      }
    }
    return files.map(readSession).filter((session): session is NativeSession => Boolean(session))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, 200);
  }

  async createSession(target: Target, creationKey: string): Promise<NativeSession> {
    mkdirSync(this.options.workspace, { recursive: true, mode: 0o700 });
    const cwd = this.cwd(target);
    const name = "Chat Bridge " + creationKey.slice(0, 8);
    const client = new PiRPC(this.cli(), cwd, ["--name", name]);
    client.onClose = () => {
      this.clients.delete(name);
      if (!this.closed) this.options.onAvailability?.();
    };
    try {
      const state: PiState = await client.request({ type: "get_state" });
      if (!state.sessionFile || !isAbsolute(state.sessionFile)) throw new BridgeError("RUNTIME_REJECTED", "Pi 未返回会话文件。");
      client.onClose = () => {
        if (state.sessionFile) this.clients.delete(state.sessionFile);
        if (!this.closed) this.options.onAvailability?.();
      };
      this.clients.set(state.sessionFile, client);
      return { nativeId: state.sessionFile, title: target.sessionTitle ?? name, projectId: target.projectId,
        cwd, runtime: "pi-rpc" };
    } catch (error) { client.close(); throw error; }
  }

  async resumeSession(session: NativeSession): Promise<NativeSession> {
    const client = this.client(session);
    const state: PiState = await client.request({ type: "get_state" });
    if (state.sessionFile && state.sessionFile !== session.nativeId) throw new BridgeError("TARGET_MISMATCH", "Pi 会话文件不一致。");
    return session;
  }

  async readHistory(session: NativeSession): Promise<NativeMessage[]> {
    const client = this.client(session);
    const data: any = await client.request({ type: "get_messages" });
    return (data?.messages ?? []).flatMap((message: any, index: number) => {
      if (message?.role !== "user" && message?.role !== "assistant") return [];
      const text = textOf(message.content);
      if (!text.trim()) return [];
      return [{ id: String(index), role: message.role, text,
        createdAt: new Date(Number(message.timestamp ?? Date.now())).toISOString() }];
    });
  }

  async sendTurn(session: NativeSession, text: string, requestId: string, hooks: TurnHooks = {}): Promise<TurnResult> {
    const client = this.client(session);
    let accumulated = "", final = "", started = false;
    const result = new Promise<TurnResult>((resolve, reject) => {
      client.onEvent = (event: any) => {
        if (event?.type === "agent_start" && !started) { started = true; hooks.started?.(requestId); }
        if (event?.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
          accumulated += String(event.assistantMessageEvent.delta ?? "");
          hooks.message?.({ id: requestId, text: accumulated, completed: false });
        }
        if (event?.type === "message_end" && event.message?.role === "assistant") final = textOf(event.message.content);
        if (event?.type === "agent_settled") {
          const output = final || accumulated;
          hooks.message?.({ id: requestId, text: output, completed: true });
          resolve({ turnId: requestId, text: output, ...(event.aborted || this.stopping.has(requestId) ? { status: "interrupted" as const } : {}) });
        }
      };
      client.onClose = (error) => {
        this.clients.delete(session.nativeId);
        if (!this.closed) { hooks.message?.({ id: requestId, text: accumulated, completed: true }); reject(error); }
      };
    });
    this.active.set(requestId, client);
    try {
      const response: any = await client.request({ type: "prompt", message: text }, 60_000);
      if (response?.disposition === "handled") {
        if (!started) hooks.started?.(requestId);
        return { turnId: requestId, text: "" };
      }
      return await result;
    } catch (error) {
      throw error instanceof BridgeError ? error : new BridgeError("SEND_UNCERTAIN", "Pi 请求未确认完成，未自动重发。");
    } finally {
      this.active.delete(requestId); this.stopping.delete(requestId);
    }
  }

  async stopTurn(requestId: string): Promise<void> {
    const client = this.active.get(requestId);
    if (!client) return;
    this.stopping.add(requestId);
    await client.request({ type: "abort" }, 10_000).catch(() => {});
  }

  releaseSession(): void { /* Pi processes are kept for fast follow-ups. */ }

  close(): void {
    this.closed = true;
    for (const client of this.clients.values()) client.close();
    this.clients.clear(); this.active.clear();
  }
}

/** Locate the user's installed Pi coding-agent CLI without requiring a shell PATH. */
export async function locatePi(): Promise<Installation> {
  const candidates = [
    process.env.PI_CLI,
    join(homedir(), ".pi", "agent", "npm", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
    join(homedir(), ".npm-global", "lib", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
    join("/opt/homebrew", "lib", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
    join("/usr/local", "lib", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
  ].filter((path): path is string => Boolean(path));
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    let executable = candidate;
    try { executable = realpathSync(candidate); } catch { /* Keep the candidate. */ }
    let version: string | undefined;
    try {
      const root = join(dirname(executable), "..", "..");
      version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
    } catch { /* Version is optional. */ }
    return { installed: true, executablePath: executable, version };
  }
  return { installed: false };
}
