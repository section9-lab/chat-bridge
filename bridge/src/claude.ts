import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import * as sdk from "@anthropic-ai/claude-agent-sdk";
import { BridgeError, type AgentAdapter, type AgentProbe, type NativeMessage, type NativeProject, type NativeSession, type Target, type TurnHooks, type TurnResult } from "./core.js";
import { AssistantText } from "./assistant-text.js";
import { appVersion } from "./version.js";

type Installation = { installed: boolean; executablePath?: string; version?: string };
type RuntimeOptions = {
  workspace: string;
  projectlessRoot?: string;
  locate(): Promise<Installation>;
  authenticate?: (executable: string) => Promise<boolean>;
  api?: Pick<typeof sdk, "listSessions" | "getSessionInfo" | "getSessionMessages" | "query">;
};
type Active = { jobId: string; query?: sdk.Query; stopping: boolean; ready: Promise<void>; started(): void };

export class ClaudeRuntime implements AgentAdapter {
  private api: NonNullable<RuntimeOptions["api"]>;
  private catalog?: sdk.SDKSessionInfo[];
  private fresh = new Set<string>();
  private active?: Active;
  private closed = false;
  constructor(private options: RuntimeOptions) { this.api = options.api ?? sdk; }

  private environment(executable: string) {
    return { HOME: process.env.HOME, LANG: "en_US.UTF-8", PATH: dirname(executable) + ":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      CLAUDE_AGENT_SDK_CLIENT_APP: "chat-bridge/" + appVersion };
  }
  async probe(): Promise<AgentProbe> {
    const installation = await this.options.locate();
    const path = installation.executablePath;
    let ready = false;
    let status: AgentProbe["status"] = "missing";
    if (path && isAbsolute(path) && !this.closed) {
      try {
        if (this.options.authenticate) ready = await this.options.authenticate(path);
        else {
          const result = await promisify(execFile)(path, ["auth", "status"], { env: this.environment(path), timeout: 8000, maxBuffer: 64 * 1024 })
            .catch((error) => { if (error.code === 1 && error.stdout) return { stdout: error.stdout }; throw error; });
          ready = JSON.parse(result.stdout).loggedIn === true;
        }
        status = ready ? "ready" : "needs_login";
      } catch { status = "error"; /* Do not expose account or credential details. */ }
    }
    return { installed: installation.installed, version: installation.version, ready, status,
      reason: ready ? "Claude Code 已就绪，可选择已有项目与会话。" : status === "missing" ? "请先安装 Claude Code 命令行程序，安装后会自动检测。" :
        status === "needs_login" ? "请先登录 Claude Code，完成后会自动检测。" : "Claude Code 连接检查失败，将自动重新检测。" };
  }
  // Claude Code has no separate projectless location: a conversation outside any project simply
  // runs in the home directory. The legacy bridge workspace also still counts as projectless.
  private projectless(cwd?: string): boolean {
    return cwd === this.options.workspace || (!!this.options.projectlessRoot && cwd === this.options.projectlessRoot);
  }
  private native(info: sdk.SDKSessionInfo): NativeSession {
    return { nativeId: info.sessionId, title: info.customTitle || info.summary || "Claude Code 会话",
      cwd: info.cwd, projectId: this.projectless(info.cwd) ? null : info.cwd ?? null,
      runtime: "claude-code", updatedAt: info.lastModified / 1000 };
  }
  async listProjects(): Promise<NativeProject[]> {
    this.catalog = await this.api.listSessions();
    const roots = [...new Set(this.catalog.map((session) => session.cwd).filter((cwd): cwd is string => !!cwd && isAbsolute(cwd) && !this.projectless(cwd)))];
    return roots.map((root) => ({ id: root, name: basename(root), roots: [root] }));
  }
  async listSessions(): Promise<NativeSession[]> {
    const sessions = this.catalog ?? await this.api.listSessions();
    return sessions.filter((session) => session.cwd && isAbsolute(session.cwd)).map((session) => this.native(session));
  }
  async readHistory(session: NativeSession): Promise<NativeMessage[]> {
    const messages = await this.api.getSessionMessages(session.nativeId, { dir: session.cwd });
    return messages.filter((message) => ["user", "assistant"].includes(message.type) && !message.parent_tool_use_id).flatMap((message) => {
      const content = (message.message as { content?: unknown })?.content;
      const text = typeof content === "string" ? content : Array.isArray(content) ?
        content.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n") : "";
      return text ? [{ id: message.uuid, role: message.type, text, createdAt: new Date((session.updatedAt ?? 0) * 1000).toISOString() }] : [];
    }).slice(-50);
  }
  async createSession(target: Target, creationKey: string): Promise<NativeSession> {
    if (target.mode !== "code") throw new BridgeError("TARGET_MISMATCH", "当前仅支持 Claude Code 会话。");
    const cwd = target.projectId ?? this.options.projectlessRoot ?? this.options.workspace;
    if (!target.projectId && !this.options.projectlessRoot) mkdirSync(cwd, { recursive: true, mode: 0o700 });
    if (!isAbsolute(cwd) || !statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new BridgeError("TARGET_MISSING", "项目目录已不存在。");
    this.fresh.add(creationKey);
    return { nativeId: creationKey, title: target.sessionTitle ?? "Claude Code 新会话", projectId: target.projectId, cwd, runtime: "claude-code", updatedAt: Date.now() / 1000 };
  }
  async resumeSession(session: NativeSession): Promise<NativeSession> {
    if (session.runtime !== "claude-code" || !session.cwd) throw new BridgeError("TARGET_MISMATCH", "此会话不属于 Claude Code。");
    const info = await this.api.getSessionInfo(session.nativeId, { dir: session.cwd });
    if (!info && this.fresh.has(session.nativeId)) return session;
    if (!info) throw new BridgeError("TARGET_MISSING", "原 Claude Code 会话不存在。");
    if (!info.cwd || !statSync(session.cwd, { throwIfNoEntry: false })?.isDirectory()) throw new BridgeError("TARGET_MISSING", "原会话目录已不存在。");
    if (info.sessionId !== session.nativeId || realpathSync(info.cwd) !== realpathSync(session.cwd)) throw new BridgeError("TARGET_MISMATCH", "会话或工作目录核对失败。");
    return session;
  }
  async sendTurn(session: NativeSession, text: string, jobId: string, hooks: TurnHooks = {}): Promise<TurnResult> {
    if (this.closed || this.active) throw new BridgeError("AGENT_UNAVAILABLE", "Claude Code 运行时当前不可用。");
    let started!: () => void;
    const active: Active = { jobId, stopping: false, ready: new Promise<void>((resolve) => { started = resolve; }), started: () => started() };
    this.active = active;
    let finishInput!: () => void;
    const inputFinished = new Promise<void>((resolve) => { finishInput = resolve; });
    const timeout = setTimeout(() => active.query?.close(), 30 * 60 * 1000);
    const output = new AssistantText(hooks), seen = new Set<string>();
    let messageId: string | undefined, blockIndex: number | undefined;
    let blocks = new Map<number, string>();
    const publish = (completed = false) => {
      if (messageId) output.update(messageId, [...blocks.values()].filter(Boolean).join("\n\n"), completed);
    };
    const begin = (id: string) => {
      if (messageId === id) return;
      publish(true); messageId = id; blocks = new Map(); blockIndex = undefined;
    };
    try {
      const installation = await this.options.locate();
      const executable = installation.executablePath;
      if (!executable || !isAbsolute(executable)) throw new BridgeError("AGENT_UNAVAILABLE", "未找到 Claude Code 可执行文件。");
      const isNew = this.fresh.has(session.nativeId);
      const prompt = (async function* (): AsyncGenerator<sdk.SDKUserMessage> {
        yield { type: "user", session_id: session.nativeId, uuid: randomUUID(), parent_tool_use_id: null, message: { role: "user", content: text } };
        await inputFinished;
      })();
      active.query = this.api.query({ prompt, options: {
        cwd: session.cwd, pathToClaudeCodeExecutable: executable, env: this.environment(executable),
        ...(isNew ? { sessionId: session.nativeId, ...(session.title !== "Claude Code 新会话" ? { title: session.title } : {}) } : { resume: session.nativeId }),
        permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
        settingSources: ["user", "project", "local"], includePartialMessages: true,
        canUseTool: async (tool, input, context) => {
          const detail = JSON.stringify(input, null, 2);
          if (active.stopping || context.signal.aborted || !hooks.approval || detail.length > 16_000) return { behavior: "deny", message: "此操作未获得单次授权。" };
          const decision = await hooks.approval({ kind: ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool) ? "fileChange" : "command",
            detail: tool + "\n" + detail, reason: context.title ?? "Claude Code 请求执行此操作。", cwd: session.cwd! });
          return decision === "accept" && !active.stopping && !context.signal.aborted ? { behavior: "allow", updatedInput: input } :
            { behavior: "deny", message: "用户拒绝了此操作。" };
        }
      } });
      for await (const message of active.query) {
        if ("parent_tool_use_id" in message && message.parent_tool_use_id) continue;
        if (message.session_id !== session.nativeId) throw new BridgeError("TARGET_MISMATCH", "Claude Code 返回了其他会话，已停止且未重发。");
        if (message.type === "system" && message.subtype === "init") {
          this.fresh.delete(session.nativeId);
          hooks.started?.(jobId); active.started();
        }
        if (message.type === "stream_event") {
          const event = message.event;
          if (event.type === "message_start") begin(event.message.id);
          else if (event.type === "content_block_start") {
            blockIndex = event.index;
            if (event.content_block.type === "text") { blocks.set(event.index, event.content_block.text); publish(); }
          } else if (event.type === "content_block_delta" && event.delta.type === "text_delta" && blocks.has(event.index)) {
            blocks.set(event.index, blocks.get(event.index)! + event.delta.text); publish();
          } else if (event.type === "content_block_stop") blockIndex = undefined;
          else if (event.type === "message_stop") publish(true);
        }
        if (message.type === "assistant" && !seen.has(message.uuid)) {
          seen.add(message.uuid);
          const content = message.message.content;
          if (content.some((block) => block.type === "text")) {
            begin(message.message.id);
            // SDK emits a completed assistant block before its content_block_stop.
            // Its full text replaces the deltas already shown for that block.
            if (content.length === 1 && content[0]?.type === "text") {
              blocks.set(blockIndex ?? Math.max(-1, ...blocks.keys()) + 1, content[0].text);
            } else {
              blocks.clear();
              content.forEach((block, index) => { if (block.type === "text") blocks.set(index, block.text); });
            }
            publish();
          }
        }
        if (message.type === "result") {
          publish(true);
          const result = active.stopping ? "任务已停止。" : message.subtype === "success" ? message.result || "任务已完成，没有文本回复。" : "Claude Code 执行失败，请检查原会话中的错误信息。";
          if (!output.text || !active.stopping && !message.is_error && message.subtype === "success" && message.result &&
              message.result !== output.lastText && message.result !== output.text) output.update("result:" + jobId, result, true);
          return { turnId: jobId, status: active.stopping ? "interrupted" : message.is_error ? "failed" : "completed",
            text: result };
        }
      }
      throw new BridgeError("SEND_UNCERTAIN", "Claude Code 未返回完成结果，请检查原会话；未重发。");
    } finally {
      clearTimeout(timeout); finishInput(); active.started(); active.query?.close();
      if (this.active === active) this.active = undefined;
    }
  }
  async stopTurn(jobId: string): Promise<void> {
    const active = this.active;
    if (!active || active.jobId !== jobId) throw new BridgeError("INVALID_STATE", "此任务已结束。");
    active.stopping = true;
    await active.ready;
    if (this.active === active) await active.query?.interrupt();
  }
  close(): void { this.closed = true; this.active?.query?.close(); }
}
