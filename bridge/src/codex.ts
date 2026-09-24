import { execFile, spawn } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { BridgeError, ResumeRejectedError, type AgentAdapter, type AgentProbe, type NativeMessage, type NativeProject, type NativeSession, type Target, type TurnHooks, type TurnResult } from "./core.js";
import { CodexRPC, CodexRPCError, type CodexConnection } from "./codex-rpc.js";
import { AssistantText } from "./assistant-text.js";
import { appVersion } from "./version.js";

type Installation = { installed: boolean; version?: string; executablePath?: string };
type RuntimeOptions = {
  workspace: string;
  projectlessRoot?: string;
  locate(): Promise<Installation>;
  connect?: (executable: string, workspace: string) => CodexConnection;
  onAvailability?: () => void;
  globalStatePath?: string;
  openProject?: (executable: string, root: string) => Promise<void>;
};
type ActiveTurn = {
  jobId: string; threadId: string; turnId?: string; hooks: TurnHooks;
  events: Array<{ method: string; params: any }>; eventBytes: number; text: AssistantText;
  fileChanges: Map<string, string>; ready: Promise<void>; started(): void;
  executing: Promise<void>; began(): void;
  resolve(result: TurnResult): void; reject(error: Error): void; timer: NodeJS.Timeout; stopping: boolean; external: boolean;
};

function connect(executable: string, workspace: string): CodexConnection {
  const child = spawn(executable, ["app-server", "--listen", "stdio://"], {
    cwd: workspace, stdio: ["pipe", "pipe", "pipe"],
    env: { HOME: process.env.HOME, PATH: dirname(executable) + ":/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8" },
  });
  child.stderr.resume(); // Never forward CLI logs, account data, or tool output into social replies.
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

export class CodexRuntime implements AgentAdapter {
  private rpc?: CodexRPC;
  private initializing?: Promise<void>;
  private active?: ActiveTurn;
  private installation: Installation = { installed: false };
  private closed = false;
  private loaded = new Set<string>();
  private external = new Set<string>();
  private projects: NativeProject[] = [];
  constructor(private options: RuntimeOptions) {}

  private async initialize(): Promise<void> {
    if (this.closed) throw new BridgeError("AGENT_UNAVAILABLE", "本地服务已关闭。");
    if (this.initializing) return this.initializing;
    if (this.rpc && !this.rpc.closed) return;
    this.initializing = (async () => {
      this.installation = await this.options.locate();
      const path = this.installation.executablePath;
      if (!path || !isAbsolute(path)) throw new BridgeError("AGENT_UNAVAILABLE", "未找到 Codex 应用内的官方运行时。");
      if (this.closed) throw new BridgeError("AGENT_UNAVAILABLE", "本地服务已关闭。");
      mkdirSync(this.options.workspace, { recursive: true, mode: 0o700 });
      const rpc = new CodexRPC((this.options.connect ?? connect)(path, this.options.workspace));
      this.rpc = rpc;
      rpc.onNotification = (method, params) => this.notification(method, params);
      rpc.onRequest = (method, params) => this.serverRequest(method, params);
      rpc.onClose = () => {
        if (this.rpc !== rpc) return;
        this.loaded.clear(); this.external.clear();
        const active = this.active;
        if (active) { clearTimeout(active.timer); active.started(); active.began(); active.reject(new BridgeError("SEND_UNCERTAIN", "Codex 连接中断，未重发任务。")); this.active = undefined; }
        this.options.onAvailability?.();
      };
      try {
        await rpc.call("initialize", { clientInfo: { name: "chat_bridge", title: "Chat Bridge", version: appVersion },
          capabilities: { experimentalApi: true } });
        rpc.notify("initialized");
      } catch (error) { rpc.close(); throw error; }
    })();
    try { await this.initializing; } finally { this.initializing = undefined; }
  }
  async probe(): Promise<AgentProbe> {
    try {
      await this.initialize();
      const account = await this.rpc!.call("account/read", { refreshToken: false });
      const ready = account?.account != null || account?.requiresOpenaiAuth === false;
      return { installed: this.installation.installed, version: this.installation.version, ready, status: ready ? "ready" : "needs_login",
        reason: ready ? "本机 Codex 已就绪，可选择已有项目与会话。" : "请先在本机 Codex 登录账号，完成后会自动检测。" };
    } catch { return { installed: this.installation.installed, version: this.installation.version, ready: false,
      status: this.installation.executablePath ? "error" : "missing",
      reason: this.installation.executablePath ? "Codex 运行时连接异常，将自动重新检测。" : "请先安装 Codex，安装后会自动检测。" }; }
  }
  private async pages(method: string, params: Record<string, unknown>): Promise<any[]> {
    await this.initialize();
    const rows: any[] = [], cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const response: any = await this.rpc!.call(method, { ...params, limit: 100, cursor });
      if (!Array.isArray(response?.data)) throw new BridgeError("RUNTIME_REJECTED", "原应用的列表格式不兼容。");
      rows.push(...response.data);
      cursor = response.nextCursor ?? null;
      if (cursor && (cursors.has(cursor) || cursors.size >= 1000)) throw new BridgeError("RUNTIME_REJECTED", "原应用的列表分页无法完成。");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return rows;
  }
  async listProjects(): Promise<NativeProject[]> {
    const rows = await this.pages("project/list", {});
    this.projects = rows.filter((p) => typeof p.id === "string" && typeof p.name === "string" && Array.isArray(p.roots))
      .map((p) => ({ id: p.id, name: p.name, roots: p.roots.map((r: any) => r.path).filter((path: unknown) => typeof path === "string" && isAbsolute(path)) }));
    return this.projects;
  }
  async listSessions(): Promise<NativeSession[]> {
    const rows = await this.pages("thread/list", { sortKey: "updated_at", sourceKinds: ["appServer", "cli", "vscode"], useStateDbOnly: true });
    const state = this.desktopState();
    return rows.filter((thread) => typeof thread.id === "string" && typeof thread.cwd === "string" && isAbsolute(thread.cwd))
      .map((thread) => {
        let projectId = thread.projectId ?? null;
        const assignment = state["thread-project-assignments"]?.[thread.id];
        if (!projectId && assignment?.projectKind === "local") {
          for (const mapping of Object.values(state["app-server-project-id-by-legacy-project-id-by-host"] ?? {}) as any[]) {
            const id = mapping[assignment.projectId];
            if (this.projects.some((p) => p.id === id)) { projectId = id; break; }
          }
        }
        if (!projectId && !assignment && !state["projectless-thread-ids"]?.includes(thread.id)) {
          projectId = this.projects.find((p) => p.roots.some((root) => {
            const path = relative(root, thread.cwd); return !path || !path.startsWith("..") && !isAbsolute(path);
          }))?.id ?? null;
        }
        return { nativeId: thread.id, title: thread.name || thread.preview?.slice(0, 160) || "Codex 会话", projectId,
          cwd: thread.cwd, runtime: "codex-app-server", updatedAt: thread.updatedAt };
      });
  }
  async readHistory(session: NativeSession): Promise<NativeMessage[]> {
    await this.initialize();
    const response = await this.rpc!.call("thread/read", { threadId: session.nativeId, includeTurns: false });
    if (response?.thread?.id !== session.nativeId) throw new BridgeError("TARGET_MISMATCH", "原会话核对失败。");
    const page = await this.rpc!.call("thread/turns/list", { threadId: session.nativeId, limit: 25, sortDirection: "desc", itemsView: "full" });
    const messages: NativeMessage[] = [];
    for (const turn of [...(page.data ?? [])].reverse()) {
      for (const item of turn.items ?? []) {
        const role = item.type === "userMessage" ? "user" : item.type === "agentMessage" ? "assistant" : null;
        const text = role === "user" ? (item.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") : item.text;
        if (role && typeof text === "string" && text) messages.push({ id: turn.id + ":" + item.id, role, text,
          createdAt: new Date((response.thread.updatedAt ?? 0) * 1000).toISOString() });
      }
    }
    return messages;
  }
  private desktopState(): any {
    try { return JSON.parse(readFileSync(this.options.globalStatePath ?? join(homedir(), ".codex", ".codex-global-state.json"), "utf8")) ?? {}; }
    catch { return {}; }
  }
  private desktopProjects(root: string): { id: string; nativeIds: string[] }[] {
    const state = this.desktopState();
    return Object.values(state["local-projects"] ?? {}).filter((project: any) => typeof project?.id === "string" &&
      Array.isArray(project.rootPaths) && project.rootPaths.includes(root)).map((project: any) => ({ id: project.id,
        nativeIds: [project.id, ...Object.values(state["app-server-project-id-by-legacy-project-id-by-host"] ?? {})
          .map((mapping: any) => mapping?.[project.id]).filter((id): id is string => typeof id === "string")] }));
  }
  private async registerProject(value: { root: string; name: string }, approval?: TurnHooks["approval"]) {
    if (!isAbsolute(value.root) || !statSync(value.root, { throwIfNoEntry: false })?.isDirectory()) throw new BridgeError("TARGET_MISSING", "项目目录不存在。");
    await this.initialize();
    let desktop = this.desktopProjects(value.root);
    let untrusted = false;
    if (!desktop.length) {
      try {
        const config = await this.rpc!.call("config/read", { includeLayers: false });
        if (config.config?.projects?.[value.root]?.trust_level !== "trusted") {
          untrusted = true;
          if (await approval?.({ kind: "projectTrust", cwd: value.root, reason: "将「" + value.name + "」添加到 Codex 项目列表，需要你确认信任该目录。",
            detail: "确认后，Codex 可以读取、修改和执行此目录中的文件，并加载项目配置。只保存此目录的信任设置，以后使用该目录无需重复确认。" }) === "accept") {
            if (this.closed) throw new BridgeError("CLOSED", "本地服务已停止。");
            await this.rpc!.call("config/value/write", { keyPath: "projects." + JSON.stringify(value.root) + ".trust_level", value: "trusted", mergeStrategy: "upsert" });
            const saved = await this.rpc!.call("config/read", { includeLayers: false });
            untrusted = saved.config?.projects?.[value.root]?.trust_level !== "trusted";
          }
        }
        if (!untrusted) {
          if (this.options.openProject) await this.options.openProject(this.installation.executablePath!, value.root);
          else await promisify(execFile)(this.installation.executablePath!, ["app", value.root], { timeout: 10_000, maxBuffer: 64 * 1024 });
          // The launcher exits before the desktop has persisted its project.
          for (let attempt = 0; attempt < 20 && !this.closed; attempt++) {
            desktop = this.desktopProjects(value.root);
            if (desktop.length) break;
            await delay(100);
          }
        }
      } catch { /* Keep the completed task and native association; report the missing desktop registration below. */ }
    }
    const projects = (await this.listProjects()).filter(project => project.roots.includes(value.root));
    let project = projects.find(project => desktop.some(saved => saved.nativeIds.includes(project.id))) ?? projects[0];
    if (!project) {
      const response = await this.rpc!.call("project/create", { name: value.name, roots: [{ path: value.root }],
        idempotencyKey: "chat-bridge-" + createHash("sha256").update(value.root).digest("hex") });
      const native = response?.project;
      if (!native?.id || !native.roots?.some((root: any) => root.path === value.root)) throw new BridgeError("TARGET_MISMATCH", "项目创建结果无法核对。");
      project = { id: native.id, name: native.name, roots: native.roots.map((root: any) => root.path) };
    }
    return { project, untrusted };
  }
  async bindProject(session: NativeSession, value: { root: string; name: string }, title: string,
    approval?: TurnHooks["approval"]): Promise<{ project: NativeProject; session: NativeSession; notice?: string }> {
    const { project, untrusted } = await this.registerProject(value, approval);
    const response = await this.rpc!.call("thread/metadata/update", { threadId: session.nativeId, projectId: project.id });
    if (response?.thread?.id !== session.nativeId || response.thread.projectId !== project.id) throw new BridgeError("TARGET_MISMATCH", "会话项目关联无法核对。");
    await this.rpc!.call("thread/name/set", { threadId: session.nativeId, name: title });
    const saved = this.desktopProjects(value.root).find(saved => saved.nativeIds.includes(project.id));
    const assignment = this.desktopState()["thread-project-assignments"]?.[session.nativeId];
    const notice = !saved ? untrusted ? "尚未信任此项目目录，未加入 Codex 侧栏。项目文件和当前会话已保留。" :
      "Codex 项目侧栏尚未添加这个文件夹，登记结果尚未确认：\n" + value.root :
      assignment?.projectKind === "local" && assignment.projectId === saved.id ? undefined :
        "项目已添加到 Codex；原会话尚未显示在项目下，请在 Codex 将该会话移入「" + project.name + "」。当前会话和上下文保留。";
    return { project, session: { ...session, projectId: project.id, title, cwd: response.thread.cwd ?? session.cwd }, ...(notice ? { notice } : {}) };
  }
  // Codex Desktop gives each projectless chat its own folder, ~/Documents/Codex/<date>/new-chat;
  // follow that instead of choosing a location of our own. Without projectlessRoot (tests) use workspace.
  private projectlessDirectory(): string {
    const root = this.options.projectlessRoot;
    if (!root) return this.options.workspace;
    const now = new Date(), day = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((part) => String(part).padStart(2, "0")).join("-");
    const parent = join(root, day);
    mkdirSync(parent, { recursive: true });
    for (let index = 1; ; index++) {
      const folder = join(parent, index === 1 ? "new-chat" : "new-chat-" + index);
      try { mkdirSync(folder); return realpathSync(folder); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || index >= 1000) throw error; }
    }
  }
  private policy(cwd = this.options.workspace) {
    return { cwd, approvalPolicy: "never", approvalsReviewer: "user", sandbox: "danger-full-access" };
  }
  async createSession(target: Target, _creationKey: string): Promise<NativeSession> {
    if (target.mode !== "code") throw new BridgeError("TARGET_MISMATCH", "当前仅支持 Codex Code 会话。");
    await this.initialize();
    let cwd = target.projectId ? this.options.workspace : this.projectlessDirectory();
    if (target.projectId) {
      const project = (await this.rpc!.call("project/read", { projectId: target.projectId })).project;
      cwd = project?.roots?.[0]?.path;
      if (project?.id !== target.projectId || typeof cwd !== "string" || !isAbsolute(cwd) || !statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
        throw new BridgeError("TARGET_MISSING", "项目目录已不存在，请重新选择项目。");
      }
    }
    const response = await this.rpc!.call("thread/start", { ...this.policy(cwd), projectId: target.projectId });
    if (typeof response?.thread?.id !== "string" || !response.thread.id || response.cwd !== cwd || (response.thread.projectId ?? null) !== target.projectId) {
      throw new BridgeError("SEND_UNCERTAIN", "新会话结果核对失败，未创建替代会话。");
    }
    this.loaded.add(response.thread.id);
    if (target.sessionTitle) await this.rpc!.call("thread/name/set", { threadId: response.thread.id, name: target.sessionTitle });
    return { nativeId: response.thread.id, projectId: target.projectId, cwd, title: target.sessionTitle ?? "Codex 新会话", runtime: "codex-app-server", updatedAt: Date.now() / 1000 };
  }
  async resumeSession(session: NativeSession): Promise<NativeSession> {
    if (session.runtime !== "codex-app-server") throw new BridgeError("TARGET_MISMATCH", "此会话不属于 Codex 运行时。");
    await this.initialize();
    if (this.loaded.has(session.nativeId) || this.external.has(session.nativeId)) return session;
    let response;
    let cwd = session.cwd ?? this.options.workspace;
    // The folder a conversation ran in can be moved or deleted (often by the agent itself). The
    // conversation still exists, so reopen it elsewhere rather than refusing to continue.
    if (!isAbsolute(cwd) || !statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
      cwd = this.options.projectlessRoot ? homedir() : this.options.workspace;
      mkdirSync(cwd, { recursive: true });
    }
    try { response = await this.rpc!.call("thread/resume", { ...this.policy(cwd), threadId: session.nativeId, excludeTurns: true }); }
    catch (error) {
      if (error instanceof CodexRPCError && error.busyThreadId === session.nativeId) {
        const original = await this.rpc!.call("thread/read", { threadId: session.nativeId, includeTurns: false });
        if (original?.thread?.id !== session.nativeId || original.thread.cwd !== cwd) throw new BridgeError("TARGET_MISMATCH", "原会话或工作目录核对失败。");
        try {
          const queue = await this.rpc!.call("thread/queue/list", { threadId: session.nativeId, limit: 1 });
          if (!Array.isArray(queue?.data)) throw new Error("Invalid queue response");
        } catch (error) {
          if (error instanceof BridgeError && error.code === "SEND_UNCERTAIN") throw error;
          throw new BridgeError("AGENT_UNAVAILABLE", "原会话正被 Codex 占用，且当前版本的原会话队列不可用。请检查 Codex 版本与运行状态后继续。");
        }
        this.external.add(session.nativeId); return session;
      }
      if (error instanceof BridgeError && error.code === "RUNTIME_REJECTED") throw new ResumeRejectedError("Codex 拒绝恢复原会话，请在本机检查运行时配置或连接状态后继续。");
      throw error;
    }
    if (response?.thread?.id !== session.nativeId || response.cwd !== cwd) throw new BridgeError("TARGET_MISMATCH", "恢复的会话或工作目录不一致。");
    this.loaded.add(session.nativeId); return { ...session, cwd };
  }
  async sendTurn(session: NativeSession, text: string, jobId: string, hooks: TurnHooks = {}): Promise<TurnResult> {
    // Core has already created/resumed the session. Register before any await so
    // an immediate /stop cannot overtake the outgoing turn.
    if (session.runtime !== "codex-app-server" || !this.loaded.has(session.nativeId) && !this.external.has(session.nativeId) || this.rpc?.closed !== false) {
      throw new BridgeError("AGENT_UNAVAILABLE", "原会话尚未恢复，任务未发送。");
    }
    if (this.active) throw new BridgeError("RUNTIME_REJECTED", "已有一个任务正在执行。");
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let began!: () => void;
    const executing = new Promise<void>((resolve) => { began = resolve; });
    let resolve!: (value: TurnResult) => void, reject!: (error: Error) => void;
    const completion = new Promise<TurnResult>((done, fail) => { resolve = done; reject = fail; });
    // Attach a rejection handler before awaiting turn/start; a pipe can close during that request.
    void completion.catch(() => {});
    const active: ActiveTurn = { jobId, threadId: session.nativeId, hooks, events: [], eventBytes: 0,
      text: new AssistantText(hooks), fileChanges: new Map(), ready, started, executing, began, resolve, reject, stopping: false,
      external: this.external.has(session.nativeId),
      timer: setTimeout(() => this.rpc?.close(), 30 * 60 * 1000) };
    this.active = active;
    try {
      if (active.external) {
        await this.sendQueuedTurn(active, text);
        return await completion;
      }
      const response = await this.rpc!.call("turn/start", { threadId: session.nativeId,
        input: [{ type: "text", text, text_elements: [] }], clientUserMessageId: jobId });
      if (typeof response?.turn?.id !== "string" || !response.turn.id) throw new BridgeError("SEND_UNCERTAIN", "运行时未返回任务 ID。");
      if (this.active !== active) return await completion;
      active.turnId = response.turn.id;
      hooks.started?.(active.turnId!); active.started();
      for (const event of active.events) this.notification(event.method, event.params);
      active.events = [];
      if (response.turn.status !== "inProgress") this.notification("turn/completed", { threadId: session.nativeId, turn: response.turn });
      return await completion;
    } finally {
      clearTimeout(active.timer); active.started(); active.began();
      if (this.active === active) this.active = undefined;
    }
  }
  private async sendQueuedTurn(active: ActiveTurn, text: string): Promise<void> {
    const rpc = this.rpc!;
    const baseline = await rpc.call("thread/turns/list", { threadId: active.threadId, limit: 1, sortDirection: "desc", itemsView: "summary" });
    const boundary = baseline?.data?.[0]?.id;
    const response = await rpc.call("thread/queue/add", { threadId: active.threadId,
      input: [{ type: "text", text, text_elements: [] }], clientUserMessageId: active.jobId });
    if (typeof response?.queuedSubmission?.id !== "string" || !response.queuedSubmission.id || response.queuedSubmission.clientUserMessageId !== active.jobId) {
      throw new BridgeError("SEND_UNCERTAIN", "原会话队列未返回有效确认，未自动重发。");
    }
    active.hooks.queued?.(); active.started();
    while (this.active === active) {
      let cursor: string | null = null, turn: any;
      const seen = new Set<string>();
      do {
        const page: any = await rpc.call("thread/turns/list", { threadId: active.threadId, limit: 25, cursor, sortDirection: "desc", itemsView: "summary" });
        if (!Array.isArray(page?.data)) throw new BridgeError("SEND_UNCERTAIN", "原会话历史无法核对，未自动重发。");
        turn = page.data.find((entry: any) => entry.items?.some((item: any) => item.type === "userMessage" && item.clientId === active.jobId));
        if (turn || page.data.some((entry: any) => entry.id === boundary)) break;
        cursor = page.nextCursor ?? null;
        if (cursor && (seen.has(cursor) || seen.size >= 1000)) throw new BridgeError("SEND_UNCERTAIN", "原会话历史分页无法完成。");
        if (cursor) seen.add(cursor);
      } while (cursor);
      if (this.active !== active) return;
      if (turn) {
        if (typeof turn.id !== "string" || !turn.id || active.turnId && active.turnId !== turn.id) throw new BridgeError("SEND_UNCERTAIN", "原会话执行记录不一致，未自动重发。");
        if (!active.turnId) { active.turnId = turn.id; active.hooks.started?.(turn.id); active.began(); }
        // Another process projects an unfinished turn as interrupted until its end is persisted.
        const completed = typeof turn.completedAt === "number" && ["completed", "interrupted", "failed"].includes(turn.status);
        if (completed) {
          this.notification("turn/completed", { threadId: active.threadId, turn });
          return;
        }
        for (const [index, item] of turn.items.entries()) {
          if (item.type === "agentMessage" && typeof item.id === "string" && typeof item.text === "string") {
            active.text.update(item.id, item.text, index < turn.items.length - 1);
          }
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    }
  }
  private notification(method: string, params: any): void {
    const active = this.active;
    if (!active || params.threadId !== active.threadId || !["turn/started", "turn/completed", "item/completed", "item/started", "item/agentMessage/delta"].includes(method)) return;
    if (!active.turnId) {
      active.eventBytes += Buffer.byteLength(JSON.stringify(params));
      if (active.events.length >= 512 || active.eventBytes > 4 * 1024 * 1024) { this.rpc?.close(); return; }
      active.events.push({ method, params }); return;
    }
    if ((params.turnId ?? params.turn?.id) !== active.turnId) return;
    if (method === "turn/started") { active.began(); return; }
    if (method === "item/agentMessage/delta" && typeof params.itemId === "string" && typeof params.delta === "string") active.text.append(params.itemId, params.delta);
    if (params.item) this.item(active, params.item, method === "item/completed");
    if (method !== "turn/completed") return;
    for (const item of params.turn.items ?? []) this.item(active, item, true);
    const status = params.turn.status;
    if (!["completed", "interrupted", "failed"].includes(status)) { this.rpc?.close(); return; }
    if (!active.text.text) active.text.update("empty-result", status === "interrupted" ? "任务已停止。" : status === "failed" ? "Codex 执行失败，请在本机检查登录、额度或网络。" : "任务已完成，没有文本回复。", true);
    active.text.finish();
    active.resolve({ turnId: active.turnId, status, text: active.text.text });
    clearTimeout(active.timer); active.began(); this.active = undefined;
  }
  private item(active: ActiveTurn, item: any, completed: boolean): void {
    if (item.type === "agentMessage" && typeof item.id === "string" && typeof item.text === "string" && (completed || !active.text.has(item.id))) {
      active.text.update(item.id, item.text, completed);
    }
    if (item.type === "fileChange" && Array.isArray(item.changes)) {
      const detail = item.changes.map((change: any) => String(change.path ?? "") + "\n" + String(change.diff ?? "")).join("\n\n");
      active.fileChanges.set(item.id, detail.length <= 16_000 ? detail : "");
    }
  }
  private async serverRequest(method: string, params: any): Promise<unknown> {
    const active = this.active;
    if (method === "item/permissions/requestApproval") return { permissions: {}, scope: "turn" };
    if (!["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(method)) throw new Error("Unsupported request");
    if (!active || params.threadId !== active.threadId) return { decision: "decline" };
    await active.ready;
    if (this.active !== active || params.turnId !== active.turnId || active.stopping || !active.hooks.approval) return { decision: "decline" };
    const kind = method === "item/commandExecution/requestApproval" ? "command" : "fileChange";
    const detail = kind === "command" ? params.command : active.fileChanges.get(params.itemId);
    if (typeof detail !== "string" || !detail || detail.length > 16_000 || typeof params.reason === "string" && params.reason.length > 2000) return { decision: "decline" };
    const decision = await active.hooks.approval({ kind, detail, reason: typeof params.reason === "string" ? params.reason : "需要你的确认。",
      cwd: typeof params.cwd === "string" ? params.cwd.slice(0, 1024) : this.options.workspace });
    return { decision: this.active === active && !active.stopping && decision === "accept" ? "accept" : "decline" };
  }
  async stopTurn(jobId: string): Promise<void> {
    const active = this.active;
    if (!active || active.jobId !== jobId) throw new BridgeError("INVALID_STATE", "任务已结束或不属于当前运行时。");
    if (active.external) throw new BridgeError("EXTERNAL_CONTROL", "此任务在 Codex 原会话中执行，请在那里停止或移除排队消息。");
    active.stopping = true;
    await active.ready;
    const timer = setTimeout(() => this.rpc?.close(), 15_000);
    try {
      await active.executing;
      if (this.active === active && active.turnId) await this.rpc!.call("turn/interrupt", { threadId: active.threadId, turnId: active.turnId });
    } finally { clearTimeout(timer); }
  }
  close(): void { this.closed = true; this.rpc?.close(); }
  releaseSession(): void {
    if (this.active) return;
    const rpc = this.rpc;
    this.rpc = undefined;
    rpc?.close();
    this.loaded.clear(); this.external.clear();
  }
}
