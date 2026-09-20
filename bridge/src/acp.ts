import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable, Writable } from "node:stream";
import { mkdirSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { appVersion } from "./version.js";
import { agentNames, BridgeError, type AgentAdapter, type AgentProbe, type NativeMessage, type NativeProject,
  type NativeSession, type Target, type TurnHooks, type TurnResult } from "./core.js";

export const acpAgentIDs = ["cursor", "grok", "opencode", "hermes"] as const;
type AgentID = typeof acpAgentIDs[number];
type Installation = { installed: boolean; executablePath?: string; version?: string };
type Transport = { input: Readable; output: Writable; close(): void };
type Options = { id: AgentID; workspace: string; locate(): Promise<Installation>;
  connect?: (executable: string, args: string[], cwd: string) => Transport;
  authenticate?: () => Promise<boolean>; onAvailability?: () => void; onExecution?: (error: string | null) => void };
type Active = { jobId: string; session: NativeSession; hooks: TurnHooks; text: string; separator: boolean };

function environment(executable: string) {
  return { HOME: process.env.HOME, LANG: "en_US.UTF-8", NO_COLOR: "1", NO_OPEN_BROWSER: "1",
    PATH: dirname(executable) + ":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" };
}

function connect(executable: string, args: string[], cwd: string): Transport {
  const child = spawn(executable, args, { cwd, env: environment(executable), stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume();
  child.on("error", () => child.stdout.destroy(new Error("Runtime unavailable")));
  return { input: child.stdout, output: child.stdin, close() {
    child.stdin.end();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 2000);
      timer.unref(); child.once("exit", () => clearTimeout(timer));
    }
  } };
}

export class ACPRuntime implements AgentAdapter {
  private connection?: acp.ClientConnection;
  private transport?: Transport;
  private initializing?: Promise<void>;
  private installation: Installation = { installed: false };
  private capabilities: acp.AgentCapabilities = {};
  private active?: Active;
  private history?: { sessionId: string; messages: NativeMessage[] };
  private catalog: NativeSession[] = [];
  private loaded = new Set<string>();
  private executionError?: string;
  private closed = false;
  constructor(private options: Options) {}

  private async request<T = any>(method: string, params: unknown, timeout = 15_000): Promise<T> {
    const connection = this.connection;
    if (!connection || connection.signal.aborted) throw new BridgeError("AGENT_UNAVAILABLE", "Agent 连接已中断，将自动重连。");
    const timer = setTimeout(() => connection.close(new Error("Runtime timeout")), timeout);
    try { return await connection.agent.request<T>(method, params); }
    finally { clearTimeout(timer); }
  }

  private async initialize(): Promise<void> {
    if (this.closed) throw new BridgeError("AGENT_UNAVAILABLE", "本地服务已关闭。");
    if (this.initializing) return this.initializing;
    if (this.connection && !this.connection.signal.aborted) return;
    const initializing = (async () => {
      this.installation = await this.options.locate();
      const path = this.installation.executablePath;
      if (!path || !isAbsolute(path)) throw new BridgeError("AGENT_UNAVAILABLE", "未检测到 " + agentNames[this.options.id] + " 命令行程序。");
      if (this.closed) throw new BridgeError("AGENT_UNAVAILABLE", "本地服务已关闭。");
      mkdirSync(this.options.workspace, { recursive: true, mode: 0o700 });
      const args = this.options.id === "grok" ? ["agent", "--no-leader", "stdio"] : ["acp"];
      const transport = (this.options.connect ?? connect)(path, args, this.options.workspace);
      this.transport = transport;
      const stream = acp.ndJsonStream(Writable.toWeb(transport.output), Readable.toWeb(transport.input) as ReadableStream<Uint8Array>);
      // The SDK normalizes null to {}. Hermes uses null for a missing session or missing auth.
      stream.readable = stream.readable.pipeThrough(new TransformStream({ transform(message, controller) {
        if ("result" in message && message.result === null) {
          controller.enqueue({ jsonrpc: "2.0", id: message.id,
            error: { code: -32602, message: "Empty ACP result", data: { emptyACPResult: true } } });
        } else controller.enqueue(message);
      } }));
      // Agents own their tools. No generic filesystem or terminal RPC is exposed by the bridge.
      const connection = acp.client({ name: "chat-bridge" })
        .onNotification("session/update", ({ params }) => this.update(params))
        .onRequest("session/request_permission", ({ params }) => this.permission(params))
        .onRequest("cursor/ask_question", (params: unknown) => params, () => ({ outcome: { outcome: "cancelled" } }))
        .onRequest("cursor/create_plan", (params: unknown) => params, () => ({ outcome: { outcome: "cancelled" } }))
        .connect(stream);
      this.connection = connection;
      transport.input.on("error", () => connection.close());
      transport.output.on("error", () => connection.close());
      void connection.closed.then(() => {
        transport.close();
        if (this.connection !== connection) return;
        this.loaded.clear();
        if (!this.closed) this.options.onAvailability?.();
      });
      const result = await this.request<acp.InitializeResponse>("initialize", { protocolVersion: 1,
        clientInfo: { name: "chat-bridge", version: appVersion },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
      if (result.protocolVersion !== 1 || !result.agentCapabilities?.loadSession) {
        throw new BridgeError("AGENT_UNAVAILABLE", "当前 Agent 版本不支持所需的会话接口，请更新命令行程序。");
      }
      this.capabilities = result.agentCapabilities;
      this.installation.version = result.agentInfo?.version ?? this.installation.version;
    })();
    this.initializing = initializing;
    try { await initializing; }
    catch (error) { this.connection?.close(); throw error; }
    finally { this.initializing = undefined; }
  }

  private async authenticated(): Promise<boolean> {
    if (this.options.authenticate) return this.options.authenticate();
    const path = this.installation.executablePath!;
    const run = async (args: string[]) => (await promisify(execFile)(path, args,
      { env: environment(path), cwd: this.options.workspace, timeout: 8000, maxBuffer: 1024 * 1024 })).stdout;
    switch (this.options.id) {
      case "cursor": {
        const status = JSON.parse(await run(["status", "--format", "json"]));
        if (status.isAuthenticated !== true) return false;
        await this.request("authenticate", { methodId: "cursor_login" });
        return true;
      }
      case "grok": {
        const info = await this.request("_x.ai/auth/info", {});
        return !!info?.methodId && !info.userBlockedReason && !info.teamBlockedReasons?.length;
      }
      case "hermes":
        // This advertised terminal method checks existing credentials; it does not run setup.
        try { return (await this.request("authenticate", { methodId: "hermes-setup" })) != null; }
        catch (error) { if (((error as acp.RequestError).data as { emptyACPResult?: boolean })?.emptyACPResult === true) return false; throw error; }
      case "opencode":
        // Includes configured providers and any enabled models that need no login.
        return (await run(["models"])).split("\n").some((line) => /^[\w.-]+\/\S+$/.test(line.trim()));
    }
  }

  async probe(): Promise<AgentProbe> {
    try {
      await this.initialize();
      const ready = await this.authenticated();
      if (!ready && this.options.id === "grok" && !this.active) this.connection?.close();
      return { installed: true, version: this.installation.version, ready, status: ready ? "ready" : "needs_login",
        executionError: ready ? this.executionError : undefined,
        reason: ready ? agentNames[this.options.id] + " 已就绪，可直接使用。" : "请先在本机登录并配置 " + agentNames[this.options.id] + "，完成后会自动检测。" };
    } catch {
      return { installed: this.installation.installed, version: this.installation.version, ready: false,
        status: this.installation.executablePath ? "error" : "missing",
        reason: this.installation.executablePath ? "连接检查失败，请检查 " + agentNames[this.options.id] + " 的版本、登录和模型配置；稍后会自动重试。" :
          "请先安装 " + agentNames[this.options.id] + " 命令行程序，安装后会自动检测。" };
    }
  }

  async listProjects(): Promise<NativeProject[]> {
    const sessions = await this.listSessions();
    const roots = [...new Set(sessions.map((s) => s.projectId).filter((cwd): cwd is string => !!cwd))];
    return roots.map((cwd) => ({ id: cwd, name: basename(cwd), roots: [cwd] }));
  }

  async listSessions(): Promise<NativeSession[]> {
    await this.initialize();
    if (!this.capabilities.sessionCapabilities?.list) return this.catalog;
    const sessions: NativeSession[] = [], cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result: acp.ListSessionsResponse = await this.request("session/list", cursor ? { cursor } : {});
      if (!Array.isArray(result?.sessions)) throw new BridgeError("RUNTIME_REJECTED", "Agent 会话列表格式不兼容。");
      for (const item of result.sessions) {
        if (!item.sessionId || !isAbsolute(item.cwd)) continue;
        sessions.push({ nativeId: item.sessionId, title: item.title || agentNames[this.options.id] + " 会话", cwd: item.cwd,
          projectId: item.cwd === this.options.workspace ? null : item.cwd, runtime: this.options.id + "-acp",
          updatedAt: item.updatedAt ? Date.parse(item.updatedAt) / 1000 : undefined });
      }
      cursor = result.nextCursor ?? undefined;
      if (cursor && (cursors.has(cursor) || cursors.size >= 1000)) throw new BridgeError("RUNTIME_REJECTED", "Agent 会话分页无法完成。");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    this.catalog = sessions;
    return sessions;
  }

  async createSession(target: Target): Promise<NativeSession> {
    await this.initialize();
    const cwd = target.projectId ?? this.options.workspace;
    if (!isAbsolute(cwd) || !statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new BridgeError("TARGET_MISSING", "项目目录已不存在。");
    const result = await this.request<acp.NewSessionResponse>("session/new", { cwd, mcpServers: [] });
    if (!result?.sessionId) throw new BridgeError("SEND_UNCERTAIN", "未收到新会话编号，未自动重建。");
    this.loaded.add(result.sessionId);
    return { nativeId: result.sessionId, title: agentNames[this.options.id] + " 新会话", projectId: target.projectId,
      cwd, runtime: this.options.id + "-acp", updatedAt: Date.now() / 1000 };
  }

  private validate(session: NativeSession) {
    if (session.runtime !== this.options.id + "-acp" || !session.cwd || !isAbsolute(session.cwd)) {
      throw new BridgeError("TARGET_MISMATCH", "Agent 或会话目录核对失败。");
    }
    if (!statSync(session.cwd, { throwIfNoEntry: false })?.isDirectory()) throw new BridgeError("TARGET_MISSING", "原会话目录已不存在。");
  }

  async resumeSession(session: NativeSession): Promise<NativeSession> {
    this.validate(session);
    await this.initialize();
    if (!this.loaded.has(session.nativeId)) {
      // Never use session/resume: some agents create a new session when an ID is missing.
      const result = await this.load(session);
      if (!result || result.sessionId && result.sessionId !== session.nativeId) throw new BridgeError("TARGET_MISSING", "原会话无法恢复，未创建替代会话。请明确新建会话后再发送。");
      this.loaded.add(session.nativeId);
    }
    return session;
  }

  private async load(session: NativeSession): Promise<any> {
    try { return await this.request("session/load", { sessionId: session.nativeId, cwd: session.cwd, mcpServers: [] }); }
    catch (error) {
      if (((error as acp.RequestError).data as { emptyACPResult?: boolean })?.emptyACPResult === true) {
        throw new BridgeError("TARGET_MISSING", "原会话无法恢复，未创建替代会话。请明确新建会话后再发送。");
      }
      throw error;
    }
  }

  async readHistory(session: NativeSession): Promise<NativeMessage[]> {
    this.validate(session);
    await this.initialize();
    if (this.active || this.history) throw new BridgeError("SESSION_BUSY", "Agent 正在使用中，请稍后读取历史。");
    const history = { sessionId: session.nativeId, messages: [] as NativeMessage[] };
    this.history = history;
    try {
      const result = await this.load(session);
      if (!result) throw new BridgeError("TARGET_MISSING", "原会话无法读取，未创建替代会话。");
      this.loaded.add(session.nativeId);
      return history.messages.slice(-50);
    } finally { this.history = undefined; }
  }

  private update(params: acp.SessionNotification): void {
    const update = params.update;
    if (update.sessionUpdate === "tool_call" && this.active?.session.nativeId === params.sessionId) this.active.separator = true;
    if ((update.sessionUpdate !== "agent_message_chunk" && update.sessionUpdate !== "user_message_chunk") || update.content.type !== "text") return;
    const text = update.content.text;
    if (this.history?.sessionId === params.sessionId) {
      const role = update.sessionUpdate === "user_message_chunk" ? "user" : "assistant";
      const last = this.history.messages.at(-1);
      if (last?.role === role) last.text += text;
      else this.history.messages.push({ id: "acp-" + this.history.messages.length, role, text, createdAt: new Date().toISOString() });
    }
    const active = this.active;
    if (!active || active.session.nativeId !== params.sessionId || update.sessionUpdate !== "agent_message_chunk") return;
    active.text += (active.separator && active.text ? "\n\n" : "") + text;
    active.separator = false;
    active.hooks.message?.({ id: active.jobId, text: active.text, completed: false });
  }

  private async permission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const active = this.active;
    if (!active || active.session.nativeId !== params.sessionId) return { outcome: { outcome: "cancelled" } };
    const input = params.toolCall.rawInput === undefined ? "" : "\n" + JSON.stringify(params.toolCall.rawInput, null, 2).slice(0, 6000);
    const decision = await active.hooks.approval?.({ kind: params.toolCall.kind === "edit" ? "fileChange" : "command",
      detail: (params.toolCall.title ?? "Agent 请求执行工具") + input, reason: "Agent 请求单次工具授权。", cwd: active.session.cwd! }) ?? "decline";
    if (this.active !== active) return { outcome: { outcome: "cancelled" } };
    const option = params.options.find((option) => option.kind === (decision === "accept" ? "allow_once" : "reject_once"));
    return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
  }

  async sendTurn(session: NativeSession, text: string, jobId: string, hooks: TurnHooks = {}): Promise<TurnResult> {
    this.validate(session);
    if (this.active || !this.loaded.has(session.nativeId)) throw new BridgeError("AGENT_UNAVAILABLE", "Agent 会话尚未就绪。");
    const active: Active = { jobId, session, hooks, text: "", separator: false };
    this.active = active;
    try {
      const pending = this.request<acp.PromptResponse>("session/prompt", { sessionId: session.nativeId,
        prompt: [{ type: "text", text }] }, 30 * 60_000);
      hooks.started?.(jobId);
      const result = await pending;
      // Hermes currently reports upstream HTTP failures as assistant text with end_turn.
      const httpFailure = this.options.id === "hermes" && !result.usage?.outputTokens && /^HTTP [45]\d\d:/.test(active.text.trim());
      const status = result.stopReason === "cancelled" ? "interrupted" : result.stopReason === "end_turn" && !httpFailure ? "completed" : "failed";
      if (httpFailure || status === "completed") {
        this.executionError = httpFailure ? "模型服务拒绝了上次请求，请检查本机模型和账号配置后再发送。" : undefined;
        this.options.onExecution?.(this.executionError ?? null);
      }
      if (active.text) hooks.message?.({ id: jobId, text: active.text, completed: true });
      return { turnId: jobId, text: active.text, status };
    } catch {
      this.executionError = "上次模型请求未能确认完成，请检查本机模型配置与网络；原任务不会自动重发。";
      this.options.onExecution?.(this.executionError);
      throw new BridgeError("SEND_UNCERTAIN", "Agent 连接中断或执行未确认，请在原会话核对；未自动重发。");
    } finally { this.active = undefined; }
  }

  async stopTurn(jobId: string): Promise<void> {
    if (this.active?.jobId !== jobId) return;
    await this.connection!.agent.notify("session/cancel", { sessionId: this.active.session.nativeId });
  }

  close(): void {
    this.closed = true;
    this.connection?.close(); this.transport?.close(); this.loaded.clear();
  }
}
