import Database from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { commandGuide, parseInput } from "./commands.js";
import { splitReply, taskNotice } from "./messages.js";
import { defaultRoutingSettings, isConfidentLookup, isConfidentRoute, routingProviders, routeActions, type RouteAction, type RouteAnswer, type RoutingContext, type RoutingSettings } from "./routing.js";
import { outputProject, snapshotOutputs, type OutputAttachment } from "./outputs.js";
import { createProjectDirectory, projectName } from "./projects.js";
import { menuLine, renderTextMenu, textOptionIndex, type TextMenu, type TextOption, type TextView } from "./routing-options.js";
import { attachmentLimit, importAttachments, type InputAttachment } from "./attachments.js";

export const agentIDs = ["codex", "claude", "cursor", "grok", "opencode", "hermes"] as const;
export const agentNames: Record<string, string> = { codex: "Codex", claude: "Claude Code", cursor: "Cursor", grok: "Grok", opencode: "OpenCode", hermes: "Hermes Agent" };
export type AgentProbe = { ready: boolean; reason: string; installed?: boolean; version?: string; executionError?: string;
  status?: "checking" | "missing" | "needs_login" | "ready" | "error" };
export type Target = {
  agent: string; mode: string; projectId: string | null;
  sessionId?: string | null; creationKey?: string | null; version?: number; sessionTitle?: string;
};
export type NativeProject = { id: string; name: string; roots: string[] };
export type Project = NativeProject & { agent: string; shortId: string; managed?: boolean };
export type NativeSession = { nativeId: string; title: string; projectId: string | null; runtime?: string; cwd?: string; updatedAt?: number };
export type Session = NativeSession & { id: string; shortId: string; agent: string; mode: string; localProject?: string; shortTitle?: string };
export type NativeMessage = { id: string; role: string; text: string; createdAt: string };
export type Origin = {
  kind: "desktop" | "imessage" | "weixin";
  accountId: string; peerId: string; eventId: string; fromSelf?: boolean; bindingEpoch?: number;
};
export type Preferences = { defaultAgent: string; pinned: string[]; keepAlive: boolean; names: Record<string, string> };
export type Job = {
  id: string; origin: Origin; target: Target; text: string; status: string;
  createdAt: string; queuedAt?: string; error?: string; sessionId?: string; turnId?: string; externalControl?: boolean;
  routing?: { intent: number; version?: number; expiresAt?: number; options?: RouteAction[] };
  routingDecision?: { provider: string; choice: string; confidence: number; probability: number; margin: number;
    intent?: { choice: string; confidence: number; probability: number } };
  routeMessage?: string; receiptRevision?: number; followsJobId?: string;
  attachments?: InputAttachment[];
};
export type Receipt = { jobId?: string; message?: string };
type Selection = Target & { sessionId: string | null; creationKey: string | null; version: number; engaged: boolean };
type Creation = { key: string; target: Target; status: string; sessionId?: string };
type Message = { id: string; sessionId: string; role: string; text: string; createdAt: string; source?: Origin["kind"];
  replyTo?: { id: string; text: string }; attachments?: InputAttachment[] };
type ChoiceMenu = { kind: "project" | "session"; entries: { id: string; name: string }[]; offset: number;
  version: number; bindingEpoch?: number; expiresAt: number };
export type OutboxEntry = { id: string; jobId?: string; origin: Origin; text: string; status: string; kind?: string; error?: string; batchId?: string; attachment?: OutputAttachment };
export type ChannelEvent = { origin: Origin; text: string; sealedContext?: string; rejection?: string };
export type IMessageConfiguration = { email: string; phone: string; chatId: string };
export type ApprovalRequest = { kind: "command" | "fileChange" | "projectTrust"; detail: string; reason: string; cwd: string };
export type AssistantMessageUpdate = { id: string; text: string; completed: boolean };
export type TurnHooks = { queued?: () => void; started?: (turnId: string) => void; message?: (update: AssistantMessageUpdate) => void;
  approval?: (request: ApprovalRequest) => Promise<"accept" | "decline"> };
export type TurnResult = { turnId: string; text: string; status?: "completed" | "interrupted" | "failed" };
export type Approval = ApprovalRequest & { id: string; jobId: string; status: string; expiresAt: string };

export interface AgentAdapter {
  probe(): Promise<AgentProbe>;
  listProjects?(): Promise<NativeProject[]>;
  listSessions?(): Promise<NativeSession[]>;
  readHistory?(session: NativeSession): Promise<NativeMessage[]>;
  bindProject?(session: NativeSession, project: { root: string; name: string }, title: string,
    approval?: TurnHooks["approval"]): Promise<{ project: NativeProject; session: NativeSession; notice?: string }>;
  createSession(target: Target, creationKey: string): Promise<NativeSession>;
  resumeSession(session: NativeSession): Promise<NativeSession>;
  sendTurn(session: NativeSession, text: string, requestId: string, hooks?: TurnHooks): Promise<TurnResult>;
  stopTurn?(requestId: string): Promise<void>;
  releaseSession?(): void;
  close?(): void;
}

export class BridgeError extends Error {
  constructor(public readonly code: string, message: string) { super(code + ": " + message); }
}

export class BridgeCore {
  private db: Database.Database;
  private creations = new Map<string, Promise<Session>>();
  private catalogs = new Map<string, Promise<void>>();
  private navigationVersion = 0;
  private catalogMembers = new Map<string, { projects: Set<string>; sessions: Set<string> }>();
  private catalogErrors = new Set<string>();
  private routeCatalogAt = 0;
  private probes: Record<string, AgentProbe> = {};
  private probing = new Map<string, Promise<AgentProbe>>();
  private routeTail: Promise<void> = Promise.resolve();
  private agentTails = new Map<string, Promise<void>>();
  private runs = new Map<string, Promise<void>>();
  private batching = false;
  private closed = false;
  private approvalWaiters = new Map<string, { resolve(decision: "accept" | "decline"): void; timer: NodeJS.Timeout }>();
  private stopping = new Set<string>();
  private flushText = new Map<string, (deliver: boolean) => void>();
  onChange: () => void = () => {};
  routeDecision?: (context: RoutingContext, actions: RouteAction[]) => Promise<RouteAnswer>;

  constructor(private databasePath: string, private adapters: Record<string, AgentAdapter>) {
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new Database(databasePath);
    chmodSync(databasePath, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("foreign_keys = ON");
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version > 1) { this.db.close(); throw new BridgeError("VERSION_UNSUPPORTED", "数据库来自更新版本，未进行降级。"); }
    this.db.exec([
      "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
      "CREATE TABLE IF NOT EXISTS inbox (event_key TEXT PRIMARY KEY, receipt TEXT NOT NULL);",
      "CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id));",
      "CREATE TABLE IF NOT EXISTS bindings (kind TEXT NOT NULL, account TEXT NOT NULL, peer TEXT NOT NULL, PRIMARY KEY(kind,account,peer));",
      "PRAGMA user_version = 1;",
    ].join("\n"));
    if (!this.get<Preferences>("preferences")) {
      this.put("preferences", { defaultAgent: "codex", pinned: ["codex", "claude", "cursor"], keepAlive: false, names: {} });
      this.put("selection", this.fresh("codex"));
      this.put("intent", 0);
    }
    this.db.transaction(() => {
      for (const job of this.list<Job>("job")) {
        if (job.status === "preparing") {
          job.status = "accepted";
          this.record("job", job.id, job);
        }
        if (["dispatching", "queued", "running", "awaiting_approval", "stopping"].includes(job.status)) {
          job.status = "uncertain"; job.error = "上次进程中断，原操作可能已经执行。";
          this.record("job", job.id, job);
        }
      }
      for (const approval of this.list<Approval>("approval")) {
        if (approval.status === "pending") this.record("approval", approval.id, { ...approval, status: "expired" });
      }
      for (const creation of this.list<Creation>("creation")) {
        if (creation.status === "creating") { creation.status = "uncertain"; this.record("creation", creation.key, creation); }
      }
      for (const entry of this.outbox()) {
        if (entry.kind === "approval" && entry.status === "pending") this.record("outbox", entry.id, { ...entry, status: "cancelled" });
        if (entry.status === "dispatching") {
          this.record("outbox", entry.id, { ...entry, status: "delivery_unknown", error: "进程在提交期间中断，未自动重发。" });
        }
      }
    })();
  }

  private get<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : undefined;
  }
  private changed(): void {
    if (this.batching || this.closed) return;
    for (const [id, waiter] of this.approvalWaiters) {
      const approval = this.find<Approval>("approval", id);
      if (approval?.status === "pending") continue;
      this.approvalWaiters.delete(id); clearTimeout(waiter.timer);
      for (const entry of this.outbox()) {
        if (entry.batchId === id && entry.status === "pending") this.record("outbox", entry.id, { ...entry, status: "cancelled" });
      }
      waiter.resolve(approval?.status === "approved" ? "accept" : "decline");
    }
    for (const job of this.list<Job>("job")) {
      if (job.status !== "stopping" || this.stopping.has(job.id)) continue;
      this.stopping.add(job.id);
      void this.adapters[job.target.agent]?.stopTurn?.(job.id).catch((error) => {
        if (this.closed) return;
        const current = this.find<Job>("job", job.id);
        if (error instanceof BridgeError && error.code === "EXTERNAL_CONTROL" && current && ["dispatching", "queued", "running", "stopping"].includes(current.status)) {
          this.saveWaitingJob({ ...current, status: current.turnId ? "running" : "queued", externalControl: true,
            error: "此任务在 Codex 原会话中执行，请在那里停止或移除排队消息。" });
          this.changed(); return;
        }
        if (current?.status !== "stopping") return;
        this.saveWaitingJob({ ...job, status: "uncertain", error: "未确认任务已停止，请检查原会话；未重发。" });
        this.changed();
      }).finally(() => this.stopping.delete(job.id));
    }
    this.onChange();
  }
  private put(key: string, value: unknown): void {
    this.db.prepare("INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value));
  }
  private record(kind: string, id: string, data: unknown): void {
    this.db.prepare("INSERT INTO records VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data").run(kind, id, JSON.stringify(data));
  }
  private find<T>(kind: string, id: string): T | undefined {
    const row = this.db.prepare("SELECT data FROM records WHERE kind=? AND id=?").get(kind, id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as T : undefined;
  }
  private list<T>(kind: string): T[] {
    return (this.db.prepare("SELECT data FROM records WHERE kind=? ORDER BY rowid").all(kind) as { data: string }[]).map((row) => JSON.parse(row.data) as T);
  }
  private fresh(agent: string, mode = "code"): Selection {
    return { agent, mode, projectId: null, sessionId: null, creationKey: null, version: 0, engaged: false };
  }
  private activeKey(target: Target): string { return "active:" + target.agent + ":" + target.mode; }
  private selection(): Selection { return this.get<Selection>("selection")!; }
  private executable(agent: string): void {
    if (!agentIDs.includes(agent as typeof agentIDs[number])) throw new BridgeError("COMING_SOON", "此 Agent 尚未接入。");
    if (!this.adapters[agent]) throw new BridgeError("AGENT_UNAVAILABLE", "未找到已验证的桌面接入。");
  }
  private select(target: Target, engaged = true): void {
    const selection: Selection = { ...target, sessionId: target.sessionId ?? null, creationKey: target.creationKey ?? null,
      version: this.selection().version + 1, engaged };
    this.put("selection", selection);
    this.put(this.activeKey(selection), selection);
    this.put("active-project:" + selection.agent + ":" + (selection.projectId ?? "none"), selection);
  }
  private reserve(target: Target, forceNew = false): Target {
    if (target.sessionId || target.creationKey) return target;
    const active = this.get<Target>(this.activeKey(target));
    const creationKey = !forceNew && active && !active.sessionId && active.projectId === target.projectId ? active.creationKey : null;
    const reserved = { ...target, creationKey: creationKey ?? randomUUID() };
    if (!this.find<Creation>("creation", reserved.creationKey)) {
      this.record("creation", reserved.creationKey, { key: reserved.creationKey, target: reserved, status: "reserved" });
    }
    this.put(this.activeKey(target), reserved);
    return reserved;
  }

  state() {
    const selection = this.selection();
    return {
      preferences: this.get<Preferences>("preferences")!, probes: { ...this.probes },
      selection, projects: this.list<Project>("project"), sessions: this.list<Session>("session"), jobs: this.list<Job>("job").slice(-100).reverse(),
      messages: this.list<Message>("message").filter((m) => m.sessionId === selection.sessionId),
      approvals: this.list<Approval>("approval").slice(-100).reverse(),
      bindings: this.db.prepare("SELECT kind FROM bindings").all() as { kind: string }[],
    };
  }

  routingSettings(): RoutingSettings {
    const settings = { ...defaultRoutingSettings, ...this.get<Partial<RoutingSettings>>("routing") };
    return Object.hasOwn(routingProviders, settings.provider) ? settings : { ...settings, provider: "vercel", mode: "off" };
  }
  // True once any routing preference has ever been persisted — lets the service tell a genuinely
  // fresh install apart from one that explicitly chose "off", without changing the bare data-layer default.
  routingConfiguredOnce(): boolean {
    return this.get<Partial<RoutingSettings>>("routing") !== undefined;
  }
  setRoutingSettings(patch: Partial<RoutingSettings>): void {
    if (Object.keys(patch).some((key) => !["provider", "mode", "planning", "implementation", "research"].includes(key))) {
      throw new BridgeError("INVALID_INPUT", "存在不支持的路由配置。");
    }
    const settings = { ...this.routingSettings(), ...patch };
    if (!Object.hasOwn(routingProviders, settings.provider) || !["off", "confirm", "auto"].includes(settings.mode) || [settings.planning, settings.implementation, settings.research]
      .some((agent) => agent !== "default" && !agentIDs.includes(agent as typeof agentIDs[number]))) {
      throw new BridgeError("INVALID_INPUT", "请选择有效的路由方式和 Agent。");
    }
    this.put("routing", settings); this.changed();
  }
  // Whether ordinary messages enter the Jev routing pipeline at all ("off" sends everything
  // straight to the current target with no menu, no Jev call — an explicit user opt-out).
  private smartRoutingEnabled(): boolean {
    return this.routingSettings().mode !== "off";
  }

  async probeAgent(agent: string): Promise<AgentProbe> {
    this.executable(agent);
    if (this.closed) throw new BridgeError("CLOSED", "本地服务已停止。");
    const pending = this.probing.get(agent);
    if (pending) return pending;
    const previous = this.probes[agent];
    const check = (async () => {
      let result: AgentProbe;
      try {
        const value = await this.adapters[agent]!.probe();
        result = { ...value, installed: value.installed ?? value.ready,
          executionError: value.executionError ?? this.get<Record<string, string>>("agentExecutionErrors")?.[agent],
          status: value.ready ? "ready" : value.status ?? (value.installed === false ? "missing" : "error") };
      } catch {
        result = { installed: this.probes[agent]?.installed ?? false, ready: false, status: "error",
          reason: "连接检查失败，将自动重试。请检查本机安装和登录。" };
      }
      if (result.ready && this.probes[agent] !== previous && this.probes[agent]?.status === "error") return this.probes[agent]!;
      if (!this.closed && JSON.stringify(this.probes[agent]) !== JSON.stringify(result)) {
        this.probes[agent] = result; this.changed();
      }
      return result;
    })();
    this.probing.set(agent, check);
    try { return await check; } finally { this.probing.delete(agent); }
  }

  async probeAgents(): Promise<void> {
    await Promise.allSettled(Object.keys(this.adapters).map((agent) => this.probeAgent(agent)));
  }

  recordAgentExecution(agent: string, error: string | null): void {
    if (this.closed) return;
    const errors = this.get<Record<string, string>>("agentExecutionErrors") ?? {};
    if (errors[agent] === (error ?? undefined)) return;
    if (error) errors[agent] = error;
    else delete errors[agent];
    this.put("agentExecutionErrors", errors);
    if (this.probes[agent]) this.probes[agent] = { ...this.probes[agent], executionError: error ?? undefined };
    this.changed();
  }

  invalidateAgent(agent: string): void {
    if (this.closed) return;
    this.probes[agent] = { ...this.probes[agent], ready: false, status: "error",
      reason: "运行时连接中断，将自动重新检测；已提交任务未自动重发。" };
    this.changed();
  }

  private availabilityLabel(agent: string): string {
    const probe = this.probes[agent];
    if (probe?.ready && probe.executionError) return "执行异常";
    return ({ checking: "检测中", missing: "未安装", needs_login: "待登录", ready: "可用", error: "连接异常" })[probe?.status ?? "checking"];
  }

  async refreshCatalog(agent: string): Promise<void> {
    this.executable(agent);
    const adapter = this.adapters[agent]!;
    if (!adapter.listProjects || !adapter.listSessions) return;
    const pending = this.catalogs.get(agent);
    if (pending) return pending;
    const refresh = (async () => {
      const probe = await this.probeAgent(agent);
      if (!probe.ready) throw new BridgeError("AGENT_UNAVAILABLE", probe.reason);
      const projects = await adapter.listProjects!();
      const sessions = await adapter.listSessions!();
      if (this.closed) return;
      this.db.transaction(() => {
        for (const project of projects) {
          const key = agent + ":" + project.id;
          const previous = this.find<Project>("project", key);
          this.record("project", key, { ...project, agent, shortId: previous?.shortId ?? "P" + randomUUID().replaceAll("-", "").slice(0, 12) });
        }
        const existing = new Map(this.list<Session>("session").filter((s) => s.agent === agent).map((s) => [s.nativeId, s]));
        for (const native of sessions) {
          const previous = existing.get(native.nativeId);
          const session: Session = { ...native, id: previous?.id ?? randomUUID(),
            shortId: previous?.shortId ?? "S" + randomUUID().replaceAll("-", "").slice(0, 12), agent, mode: "code" };
          if (previous?.localProject && !native.projectId) {
            session.localProject = previous.localProject; session.projectId = previous.localProject;
          }
          if (previous?.shortTitle) { session.title = previous.shortTitle; session.shortTitle = previous.shortTitle; }
          this.record("session", session.id, session);
          existing.set(native.nativeId, session);
        }
      })();
      this.catalogMembers.set(agent, { projects: new Set([...projects.map((project) => project.id),
        ...this.list<Project>("project").filter(project => project.agent === agent && project.managed).map(project => project.id)]),
        sessions: new Set(sessions.map((session) => session.nativeId)) });
      this.changed();
    })();
    this.catalogs.set(agent, refresh);
    try { await refresh; this.catalogErrors.delete(agent); }
    catch (error) { this.catalogErrors.add(agent); throw error; }
    finally { this.catalogs.delete(agent); }
  }

  async prepareEvents(events: ChannelEvent[]): Promise<ChannelEvent[]> {
    let agent = this.selection().agent;
    const prepared: ChannelEvent[] = [];
    for (const event of events) {
      if (event.origin.kind !== "desktop" && (!this.isBound(event.origin) || event.origin.fromSelf)) { prepared.push(event); continue; }
      const parsed = parseInput(event.text);
      if (!event.rejection && parsed.kind === "message" && !event.text.startsWith("//")) {
        const code = /^(M[0-9a-f]{6})-(\d+)$/i.exec(parsed.text.trim());
        const menus = this.textMenus(event.origin).filter(menu => !code || menu.id.toLowerCase() === code[1]!.toLowerCase());
        const agents = new Set<string>();
        for (const menu of menus) {
          const index = textOptionIndex(code?.[2] ?? parsed.text.trim(), menu.entries), entry = index === undefined ? undefined : menu.entries[index];
          if (entry?.kind === "view" && entry.view.stage === "agents") await this.probeAgents();
          const candidate = entry?.kind === "view" ? entry.view.scope?.agent : entry?.kind === "action" ? entry.action.target?.agent : undefined;
          if (candidate) agents.add(candidate);
        }
        for (const candidate of agents) {
          try { await this.refreshCatalog(candidate); }
          catch { /* Keep the original request and let the local picker explain the unavailable catalog. */ }
        }
      }
      if (!event.rejection && parsed.kind === "command") {
        if (parsed.name === "agent" && !parsed.argument) await this.probeAgents();
        if (parsed.name === "status" && this.adapters[agent]) await this.probeAgent(agent);
        if (parsed.name === "agent" && this.adapters[parsed.argument]) {
          agent = parsed.argument;
          await this.probeAgent(agent);
        }
      }
      if (!event.rejection && parsed.kind === "command" && (["projects", "sessions"].includes(parsed.name) || parsed.name === "project" && !parsed.argument)) {
        try { await this.refreshCatalog(agent); }
        catch { prepared.push({ ...event, rejection: "无法读取原应用的项目与会话，请检查该 Agent 的安装和登录后重试。当前目标保持不变。" }); continue; }
      }
      prepared.push(event);
    }
    return prepared;
  }

  async loadHistory(sessionId: string): Promise<void> {
    const session = this.find<Session>("session", sessionId);
    const reader = session && this.adapters[session.agent]?.readHistory;
    if (!session || !reader) return;
    const busy = () => this.list<Job>("job").some((job) => (job.sessionId === sessionId || job.target.sessionId === sessionId) &&
      ["accepted", "preparing", "dispatching", "queued", "running", "awaiting_approval", "stopping"].includes(job.status));
    if (busy()) return;
    const messages = await reader.call(this.adapters[session.agent], session);
    if (this.closed || busy()) return;
    this.db.transaction(() => {
      for (const message of this.list<Message>("message").filter((m) => m.sessionId === sessionId)) {
        this.db.prepare("DELETE FROM records WHERE kind='message' AND id=?").run(message.id);
      }
      let replyTo: Message["replyTo"];
      const jobs = this.list<Job>("job").filter(job => job.sessionId === sessionId);
      for (const message of messages) {
        const id = "native:" + sessionId + ":" + message.id;
        const job = message.role === "user" ? jobs.find(job => this.prompt(job) === message.text) : undefined;
        const item: Message = { ...message, id, sessionId, ...(job ? { text: job.text, attachments: job.attachments } : {}) };
        if (item.role === "user") replyTo = this.quote(item.id, item.text);
        else if (item.role === "assistant") item.replyTo = replyTo;
        this.record("message", id, item);
      }
    })();
    this.changed();
  }

  importAttachments(paths: unknown): InputAttachment[] {
    try {
      const files = importAttachments(join(dirname(this.databasePath), "Attachments"), paths);
      this.db.transaction(() => { for (const file of files) this.record("attachment", file.id, file); })();
      return files;
    } catch (error) {
      throw new BridgeError("INVALID_ATTACHMENT", error instanceof Error && !("code" in error) ? error.message : "无法读取所选文件，请检查权限或重新选择。");
    }
  }
  attachments(ids: unknown): InputAttachment[] {
    if (ids === undefined) return [];
    if (!Array.isArray(ids) || ids.length > attachmentLimit || ids.some(id => typeof id !== "string")) {
      throw new BridgeError("INVALID_ATTACHMENT", "每条消息最多附加 10 个文件。");
    }
    return [...new Set<string>(ids)].map(id => {
      const file = this.find<InputAttachment>("attachment", id);
      if (!file) throw new BridgeError("INVALID_ATTACHMENT", "附件已不可用，请重新选择。");
      return file;
    });
  }
  private quote(id: string, text: string): NonNullable<Message["replyTo"]> {
    return { id, text: text.replace(/\s+/gu, " ").trim().slice(0, 240).replace(/[\uD800-\uDBFF]$/, "") };
  }
  private prompt(job: Job): string {
    const text = job.text;
    return job.attachments?.length ? text + "\n\n用户附加的文件（本机副本，请按任务需要读取）：\n" +
      job.attachments.map(file => JSON.stringify({ name: file.name, path: file.path })).join("\n") : text;
  }

  catalog(agent: string, projectId?: string | null, query = "", offset = 0) {
    const sessions = this.list<Session>("session").filter((session) => session.agent === agent &&
      (projectId === undefined || session.projectId === projectId) && session.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return { projects: this.list<Project>("project").filter((project) => project.agent === agent),
      sessions: sessions.slice(offset, offset + 50), nextOffset: offset + 50 < sessions.length ? offset + 50 : null };
  }

  private menuKey(origin: Origin): string { return JSON.stringify([origin.kind, origin.accountId, origin.peerId]); }
  private clearMenu(origin: Origin): void {
    this.db.prepare("DELETE FROM records WHERE kind='choice-menu' AND id=?").run(this.menuKey(origin));
  }
  private currentMenu(origin: Origin): ChoiceMenu | undefined {
    const menu = this.find<ChoiceMenu>("choice-menu", this.menuKey(origin));
    if (menu && (menu.expiresAt <= Date.now() || menu.version !== this.selection().version || menu.bindingEpoch !== origin.bindingEpoch)) {
      throw new BridgeError("STALE_MENU", "列表已过期或当前目标已改变，请重新发送 /project 或 /sessions。");
    }
    return menu;
  }
  private menu(kind: ChoiceMenu["kind"], entries: ChoiceMenu["entries"], origin: Origin, offset = 0, expiresAt = Date.now() + 10 * 60_000): string {
    this.record("choice-menu", this.menuKey(origin), { kind, entries, offset, expiresAt,
      version: this.selection().version, bindingEpoch: origin.bindingEpoch } satisfies ChoiceMenu);
    const page = entries.slice(offset, offset + 8).map((entry, index) => String(offset + index + 1).padStart(2, "0") + " " +
      (entry.name.replaceAll(/\s+/g, " ").trim().slice(0, 100) || (kind === "project" ? "未命名项目" : "未命名会话")));
    if (offset + 8 < entries.length) page.push("下一页：/more");
    return "请回复编号进行选择：\n" + page.join("\n");
  }
  private chooseNumber(argument: string, origin: Origin): string | Receipt | undefined {
    const menu = this.currentMenu(origin);
    if (!menu) return;
    const index = Number(argument) - 1;
    if (!Number.isSafeInteger(index) || index < 0 || index >= Math.min(menu.entries.length, menu.offset + 8)) {
      throw new BridgeError("INVALID_INPUT", "编号不在已显示的列表中，请回复列表里的编号。");
    }
    const response = this.command(menu.kind === "project" ? "project" : "use", menu.entries[index]!.id, origin);
    return menu.kind === "project" ? this.command("sessions", "", origin) : response;
  }

  setPreferences(patch: Partial<Preferences>): void {
    const preferences = { ...this.get<Preferences>("preferences")!, ...patch };
    this.executable(preferences.defaultAgent);
    if (!Array.isArray(preferences.pinned) || preferences.pinned.length > 3 ||
        new Set(preferences.pinned).size !== preferences.pinned.length ||
        preferences.pinned.some((id) => !agentIDs.includes(id as typeof agentIDs[number]))) {
      throw new BridgeError("INVALID_INPUT", "最多固定三个不同的 Agent。");
    }
    if (typeof preferences.keepAlive !== "boolean") throw new BridgeError("INVALID_INPUT", "保活设置必须为布尔值。");
    if (!preferences.names || Array.isArray(preferences.names) || typeof preferences.names !== "object" ||
        Object.entries(preferences.names).some(([key, value]) => !agentIDs.includes(key as typeof agentIDs[number]) || typeof value !== "string" || !value.trim() || value.length > 36)) {
      throw new BridgeError("INVALID_INPUT", "Agent 名称必须为 1–36 个字符。");
    }
    this.db.transaction(() => {
      this.put("preferences", preferences);
      const selected = this.selection();
      if (!selected.engaged && selected.agent !== preferences.defaultAgent) {
        this.put("selection", { ...this.fresh(preferences.defaultAgent), version: selected.version + 1 });
      }
    })();
    this.changed();
  }

  bindChannel(kind: string, account: string, peer: string): void {
    if ((kind !== "imessage" && kind !== "weixin") || !account || !peer) throw new BridgeError("INVALID_INPUT", "无效的绑定身份。");
    this.db.transaction(() => {
      const result = this.db.prepare("INSERT OR IGNORE INTO bindings VALUES (?,?,?)").run(kind, account, peer);
      if (!result.changes) return;
      const epoch = (this.get<number>("binding-epoch:" + kind) ?? 0) + 1;
      this.put("binding-epoch:" + kind, epoch);
      const id = "onboarding:" + kind + ":" + epoch;
      this.enqueueReply(id, { kind, accountId: account, peerId: peer, eventId: id, bindingEpoch: epoch },
        "配置完成，已绑定此账号。\n\n" + commandGuide, "onboarding");
    })();
  }

  receive(origin: Origin, text: string, rejection?: string, attachments: InputAttachment[] = []): Receipt {
    if (origin.kind !== "desktop") {
      if (!this.db.prepare("SELECT 1 FROM bindings WHERE kind=? AND account=? AND peer=?").get(origin.kind, origin.accountId, origin.peerId)) {
        throw new BridgeError("UNAUTHORIZED", "消息来源尚未绑定。");
      }
      if (origin.fromSelf) throw new BridgeError("ECHO", "忽略本机发出的消息。");
      origin = { ...origin, bindingEpoch: this.get<number>("binding-epoch:" + origin.kind) ?? 0 };
    } else if (origin.accountId !== "local" || origin.peerId !== "local") {
      throw new BridgeError("UNAUTHORIZED", "无效的本机身份。");
    }
    if (!origin.eventId || typeof text !== "string" || (!rejection && !text.trim()) || Buffer.byteLength(text) > 256 * 1024) {
      throw new BridgeError("INVALID_INPUT", "消息不能为空，且不能超过 256 KiB。");
    }
    const key = JSON.stringify([origin.kind, origin.accountId, origin.peerId, origin.eventId]);
    const previous = this.db.prepare("SELECT receipt FROM inbox WHERE event_key=?").get(key) as { receipt: string } | undefined;
    if (previous) return JSON.parse(previous.receipt) as Receipt;
    const receipt = this.db.transaction(() => {
      const parsed = attachments.length ? { kind: "message" as const, text } : parseInput(text);
      let result: Receipt;
      if (rejection) result = { message: rejection };
      else if (parsed.kind === "invalid") result = { message: parsed.message };
      else if (parsed.kind === "command") {
        const command = this.command(parsed.name, parsed.argument, origin);
        result = typeof command === "string" ? { message: command } : command;
      }
      else {
        const choice = attachments.length ? undefined : this.answerProjectTrust(parsed.text.trim(), origin) ?? this.answerCorrection(parsed.text.trim(), origin) ??
          this.answerTextOptions(parsed.text.trim(), origin) ?? this.answerRouting(parsed.text.trim(), origin) ??
          (/^\d+$/.test(parsed.text.trim()) ? this.chooseNumber(parsed.text.trim(), origin) : undefined);
        if (choice !== undefined) result = typeof choice === "string" ? { message: choice } : choice;
        else {
          this.clearMenu(origin);
          const outstanding = this.list<Job>("job").filter((job) => !["completed", "cancelled", "interrupted", "failed"].includes(job.status));
          if (outstanding.length >= 100) {
            result = { message: "未接受：待执行任务已达到 100 个，请先处理已有任务。" };
          } else {
            const routing = this.smartRoutingEnabled() && !text.startsWith("//");
            const target = routing ? { ...this.selection() } : this.reserve(this.selection());
            if (!routing) this.put("selection", { ...target, engaged: true });
            const id = "J" + randomUUID().replaceAll("-", "").slice(0, 12);
            const job: Job = { id, origin, target, text: parsed.text, status: routing ? "routing" : "accepted", createdAt: new Date().toISOString(),
              ...(attachments.length ? { attachments } : {}),
              ...(routing ? { routing: { intent: this.get<number>("intent") ?? 0 } } : {}) };
            this.record("job", id, job);
            result = { jobId: id };
          }
        }
      }
      this.db.prepare("INSERT INTO inbox VALUES (?,?)").run(key, JSON.stringify(result));
      if (origin.kind !== "desktop" && result.message) {
        const id = "receipt:" + createHash("sha256").update(key).digest("hex");
        this.enqueueReply(id, origin, result.message, "receipt", result.jobId);
      }
      return result;
    })();
    this.changed();
    return receipt;
  }

  private resolvedTarget(target: Target): Target {
    const creation = target.creationKey ? this.find<Creation>("creation", target.creationKey) : undefined;
    const resolved = creation?.status === "confirmed" ? { ...target, sessionId: creation.sessionId, creationKey: null } : target;
    const session = resolved.sessionId ? this.find<Session>("session", resolved.sessionId) : undefined;
    // A project created by this same session can finish while its follow-up is being routed.
    if (!resolved.projectId && session?.projectId && session.agent === resolved.agent && session.mode === resolved.mode &&
        this.find<Project>("project", session.agent + ":" + session.projectId)?.managed) return { ...resolved, projectId: session.projectId };
    return resolved;
  }
  private routingContext(text: string, target: Target = this.selection(), origin?: Origin, jobId?: string): RoutingContext {
    const current = this.resolvedTarget(target);
    const tasks = this.list<Job>("job").filter(job => job.id !== jobId && origin &&
      (origin.kind === "desktop" || this.menuKey(job.origin) === this.menuKey(origin)));
    const activeTasks = tasks.filter(job => !["completed", "cancelled", "interrupted", "failed"].includes(job.status)).slice(-12);
    const recentTasks = tasks.filter(job => ["completed", "interrupted", "failed"].includes(job.status) && job.sessionId).slice(-3);
    return { text, current, settings: this.routingSettings(), defaultAgent: this.get<Preferences>("preferences")!.defaultAgent,
      projects: this.list<Project>("project").filter((project) => this.catalogMembers.get(project.agent)?.projects.has(project.id)),
      sessions: this.list<Session>("session").filter((session) => session.id === current.sessionId || this.catalogMembers.get(session.agent)?.sessions.has(session.nativeId)),
      probes: { ...this.probes }, active: Object.fromEntries(agentIDs.map((agent) => [agent,
        this.get<Target>("active:" + agent + ":code") ?? this.fresh(agent)])),
      activeProjects: Object.fromEntries(this.list<Project>("project").flatMap(project => {
        const key = project.agent + ":" + project.id, target = this.get<Target>("active-project:" + key);
        return target ? [[key, target]] : [];
      })),
      tasks: [...activeTasks, ...recentTasks].map((job) => ({
          id: job.id, text: job.text.slice(0, 500), status: job.status, target: this.resolvedTarget(job.target), question: job.error,
          canAnswer: this.menuKey(job.origin) === this.menuKey(origin!) && this.routeIsOpen(job),
          canStop: Boolean(this.adapters[job.target.agent]?.stopTurn) })),
      history: this.list<Message>("message").filter((message) => message.sessionId === current.sessionId).slice(-6)
        .map(({ role, text }) => ({ role, text: text.slice(0, 1000) })) };
  }
  private targetName(target: Target, session?: Session): string {
    const agent = this.displayAgent(target.agent);
    const project = target.projectId ? this.list<Project>("project").find((project) =>
      project.agent === target.agent && project.id === target.projectId)?.name ?? "已绑定项目" : "无项目";
    session ??= target.sessionId ? this.find<Session>("session", target.sessionId) : undefined;
    return [agent, project, session?.title || "新会话"].map(value => menuLine(value)).join(" > ");
  }
  private displayAgent(agent: string): string {
    return menuLine(this.get<Preferences>("preferences")?.names[agent] || (agent === "claude" ? "Claude" : agentNames[agent]) || agent);
  }
  private routeLabel(action: RouteAction): string {
    if (!action.target) return menuLine(action.label, 160);
    const verb = action.kind === "select" ? "只切换到：" : action.kind === "control" ? "任务操作：" :
      action.id === "continue" ? "继续：" : action.target.sessionId ? "恢复会话并发送：" : "新建会话并发送：";
    const label = verb + this.targetName(this.resolvedTarget(action.target));
    // "select" only moves the target; every other kind sends the original message there. The two
    // read alike once truncated to the same target name, so spell out the behavioral difference.
    return action.kind === "select" ? label + "（这条消息不会发送）" : label;
  }
  private textMenus(origin: Origin): TextMenu[] {
    return this.list<TextMenu>("text-menu").filter(menu => menu.active && this.menuKey(menu.origin) === this.menuKey(origin));
  }
  // A routing question the user can no longer answer must also stop being offered to the router.
  private routeIsOpen(job: Job): boolean {
    return job.status === "awaiting_route" && (job.routing?.expiresAt ?? 0) > Date.now();
  }
  sweepExpiredRoutes(): void {
    for (const job of this.list<Job>("job")) {
      if (job.status !== "awaiting_route" || this.routeIsOpen(job)) continue;
      this.closeTextMenus(job.id);
      this.record("job", job.id, { ...job, status: "cancelled", error: "目标选择已过期，任务未发送。" });
    }
  }
  private closeTextMenus(jobId: string): void {
    for (const menu of this.list<TextMenu>("text-menu")) {
      if (menu.jobId === jobId && menu.active) this.record("text-menu", menu.id, { ...menu, active: false });
    }
  }
  private openTextMenu(job: Job | undefined, origin: Origin, view: TextView, prefix = "", focus = false): string {
    for (const menu of this.textMenus(origin)) {
      if (menu.jobId === job?.id) this.record("text-menu", menu.id, { ...menu, active: false });
    }
    const entries: TextOption[] = [], mode = view.mode ?? "send", scope = view.scope ?? { agent: this.selection().agent };
    const actionOption = (action: RouteAction, label = this.routeLabel(action), aliases?: string[]): TextOption => ({ kind: "action", action, label,
      aliases: aliases ?? (action.kind === "send" ? action.id === "continue" ? ["继续", "继续原会话"] :
        action.target?.sessionId ? ["恢复会话"] : ["新建", "新建会话", "另开一个"] : []) });
    const next = (label: string, target: TextView, aliases?: string[]): TextOption => ({ kind: "view", label, view: target, aliases });
    const projects = this.list<Project>("project").filter(project => project.agent === scope.agent &&
      (!this.catalogMembers.has(project.agent) || this.catalogMembers.get(project.agent)!.projects.has(project.id)));
    const pending = job?.status === "awaiting_route";
    let header: string;
    if (view.stage === "tasks") {
      header = "你要处理哪条消息？请选择消息：";
      const tasks = this.list<Job>("job").filter(task => this.menuKey(task.origin) === this.menuKey(origin) &&
        (origin.kind === "desktop" || this.canReplyTo(task.origin)) &&
        !["completed", "cancelled", "failed", "interrupted"].includes(task.status));
      const offset = view.offset ?? 0;
      for (const task of tasks.slice(offset, offset + 6)) {
        entries.push({ kind: "task", jobId: task.id, label: menuLine(task.text, 50) + "（" + this.targetName(this.resolvedTarget(task.target)) + "）" });
      }
      if (offset + 6 < tasks.length) entries.push(next("下一页", { ...view, offset: offset + 6 }));
      if (offset) entries.push(next("上一页", { ...view, offset: Math.max(0, offset - 6) }));
    } else if (view.stage === "route") {
      header = (job?.error ?? "请选择这条消息的处理方式。") + "\n原消息已保留，尚未发送：\n“" + menuLine(job?.text ?? "", 100) + "”";
      for (const action of job?.routing?.options ?? []) entries.push(actionOption(action));
      entries.push(next("手动选择目标", { stage: "agents", mode: job?.routingDecision?.intent?.choice === "navigate" ? "select" : "send" }, ["选择其他目标", "都不是", "手动选择其他目标"]));
      if (!job?.routingDecision?.intent) entries.push(next("只切换目标，不发送原消息", { stage: "agents", mode: "select" }));
      entries.push({ kind: "retry", label: "重新尝试智能判断", aliases: ["重新判断", "重试智能判断"] });
    } else if (view.stage === "correction") {
      header = "这条消息" + (job?.status === "completed" ? "已经完成" : "已经发送，执行状态请核对") + "：\n" +
        this.targetName(this.resolvedTarget(job!.target), job?.sessionId ? this.find<Session>("session", job.sessionId) : undefined) + "\n不会因更正目标而重复发送原消息。";
      if (job && ["dispatching", "running", "queued", "awaiting_approval"].includes(job.status) && !job.externalControl && this.adapters[job.target.agent]?.stopTurn) {
        entries.push(actionOption({ id: "stop_" + job.id, kind: "control", command: "stop", jobId: job.id, label: "请求停止这条任务" }, "请求停止这条任务"));
      }
      if (job?.externalControl) header += "\n停止或移除排队消息需要在 Codex 原会话中处理。";
      entries.push(next("为后续消息选择其他目标", { stage: "agents", mode: "select" }));
      entries.push({ kind: "status", label: "查看任务状态" });
    } else if (view.stage === "agents") {
      header = "选择 Agent：";
      for (const agent of agentIDs) if (this.adapters[agent]) {
        entries.push(next(this.displayAgent(agent) + "（" + this.availabilityLabel(agent) + "）", { stage: "projects", mode, scope: { agent } },
          [...new Set([this.displayAgent(agent), agentNames[agent]!, agent])]));
      }
      if (pending) entries.push(next("返回上一步", { stage: "route" }, ["返回", "上一步"]));
    } else if (view.stage === "projects") {
      header = this.displayAgent(scope.agent) + "\n选择项目：";
      const offset = view.offset ?? 0;
      for (const project of projects.slice(offset, offset + 6)) entries.push(next(menuLine(project.name),
        { stage: "sessions", mode, scope: { agent: project.agent, projectId: project.id } }));
      if (offset + 6 < projects.length) entries.push(next("下一页", { ...view, offset: offset + 6 }));
      if (offset) entries.push(next("上一页", { ...view, offset: Math.max(0, offset - 6) }));
      entries.push(next("无项目 · 直接对话", { stage: "sessions", mode, scope: { agent: scope.agent, projectId: null } }, ["无项目", "直接对话"]));
      entries.push(next("返回上一步", { stage: "agents", mode }, ["返回", "上一步"]));
    } else {
      const project = scope.projectId === undefined ? "全部会话" : scope.projectId === null ? "无项目" : projects.find(project => project.id === scope.projectId)?.name ?? "项目已不可用";
      header = this.displayAgent(scope.agent) + " > " + menuLine(project) + "\n" + (mode === "send" ? "把原消息发送到：" : "选择会话：");
      const sessions = this.list<Session>("session").filter(session => session.agent === scope.agent &&
        (scope.projectId === undefined || session.projectId === scope.projectId) &&
        (!this.catalogMembers.has(session.agent) || this.catalogMembers.get(session.agent)!.sessions.has(session.nativeId)))
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      const offset = view.offset ?? 0;
      for (const session of sessions.slice(offset, offset + 6)) {
        const action: RouteAction = { id: (mode === "send" ? "resume_" : "select_") + session.shortId, kind: mode === "send" ? "send" : "select",
          target: { agent: session.agent, mode: session.mode, projectId: session.projectId, sessionId: session.id }, label: session.title };
        entries.push(actionOption(action, (mode === "send" ? "继续会话：" : "选择会话：") + this.targetName(action.target!), [menuLine(session.title)]));
      }
      if (offset + 6 < sessions.length) entries.push(next("下一页", { ...view, offset: offset + 6 }));
      if (offset) entries.push(next("上一页", { ...view, offset: Math.max(0, offset - 6) }));
      if (!sessions.length) header += "\n暂无已有会话。";
      if (scope.projectId !== undefined && (scope.projectId === null || projects.some(project => project.id === scope.projectId))) {
        const target = { agent: scope.agent, mode: "code", projectId: scope.projectId, sessionId: null, creationKey: null };
        entries.push(actionOption({ id: "manual_new", kind: mode === "send" ? "send" : "select", target, label: "新建会话" },
          "新建会话：" + this.targetName(target), ["新建会话", "新建", "另开一个"]));
      }
      entries.push(next("返回上一步", { stage: "projects", mode, scope: { agent: scope.agent } }, ["返回", "上一步"]));
    }
    entries.push(pending ? { kind: "cancel", label: "取消这条消息", aliases: ["取消", "算了"] } :
      { kind: "dismiss", label: "结束选择", aliases: ["取消", "结束"] });
    const menu: TextMenu = { id: "M" + randomUUID().replaceAll("-", "").slice(0, 6), jobId: job?.id, origin, view, entries,
      header: (prefix ? prefix + "\n\n" : "") + header, version: this.selection().version, expiresAt: Date.now() + 10 * 60_000, active: true };
    this.record("text-menu", menu.id, menu);
    if (focus) this.put("text-focus:" + this.menuKey(origin), menu.id);
    return renderTextMenu(menu);
  }
  private correctionMenu(job: Job, origin: Origin): string {
    if (["routing", "accepted", "preparing", "waiting_agent", "awaiting_confirmation", "awaiting_route"].includes(job.status)) {
      job.status = "awaiting_route"; job.error = "可以为这条消息重新选择目标。";
      job.routing = { intent: this.get<number>("intent") ?? 0, version: this.selection().version, expiresAt: Date.now() + 10 * 60_000, options: [] };
      this.record("job", job.id, job);
      return this.openTextMenu(job, origin, { stage: "route" }, "", true);
    }
    return this.openTextMenu(job, origin, { stage: "correction", mode: "select" }, "", true);
  }
  private answerCorrection(text: string, origin: Origin): Receipt | undefined {
    if (!["选错了", "不是这个会话", "换一个会话"].includes(text)) return;
    const jobs = this.list<Job>("job").filter(job => this.menuKey(job.origin) === this.menuKey(origin) &&
      (origin.kind === "desktop" || this.canReplyTo(job.origin)) && !["cancelled", "failed", "interrupted"].includes(job.status) &&
      (job.status !== "completed" || job.sessionId));
    const pending = jobs.filter(job => job.status !== "completed");
    if (pending.length > 1) return { message: this.openTextMenu(undefined, origin, { stage: "tasks" }, "", true) };
    const job = pending[0] ?? jobs.at(-1);
    return { message: job ? this.correctionMenu(job, origin) : "当前没有可更正的任务。请直接说明你想使用的 Agent、项目或会话。" };
  }
  private answerTextOptions(text: string, origin: Origin): Receipt | undefined {
    const code = /^(M[0-9a-f]{6})-(\d+)$/i.exec(text);
    if (!code && /^\d+$/.test(text) && this.find("choice-menu", this.menuKey(origin))) return;
    const menus = this.textMenus(origin);
    const focused = menus.find(menu => menu.id === this.get<string>("text-focus:" + this.menuKey(origin)));
    let menu = code ? this.find<TextMenu>("text-menu", "M" + code[1]!.slice(1).toLowerCase()) : focused;
    if (!menu && !code) {
      if (menus.length > 1 && menus.some(item => textOptionIndex(text, item.entries) !== undefined)) {
        return { message: this.openTextMenu(undefined, origin, { stage: "tasks" }, "", true) };
      }
      if (menus.length === 1) menu = menus[0];
    }
    if (!menu) return code ? { message: "这组选项已经失效，请使用当前消息中的选项。" } : undefined;
    if (this.menuKey(menu.origin) !== this.menuKey(origin) || menu.origin.bindingEpoch !== origin.bindingEpoch) {
      return { message: "这组选项不属于当前绑定的对话，未执行任何操作。" };
    }
    const job = menu.jobId ? this.find<Job>("job", menu.jobId) : undefined;
    const index = textOptionIndex(code?.[2] ?? text, menu.entries);
    if (index === undefined && menu.entries.some(entry => [entry.label, ...(entry.aliases ?? [])].includes(text))) {
      return { message: "这个文字对应多个选项，请回复具体编号。\n\n" + renderTextMenu(menu) };
    }
    if (index === undefined && !code && menu.view.stage === "route" && this.smartRoutingEnabled()) return;
    if (index === undefined && !code && job?.status === "completed" && menu.view.stage !== "correction") {
      this.record("text-menu", menu.id, { ...menu, active: false }); return;
    }
    if (!menu.active) return { message: "这组选项已被处理或替换，未重复执行。请使用最新选项。" };
    if (menu.expiresAt <= Date.now() || menu.version !== this.selection().version) {
      return { message: this.openTextMenu(job, origin, menu.view, "选项已过期或当前目标已改变。原消息保留，请按新列表重新选择。", true) };
    }
    const entry = index === undefined ? undefined : menu.entries[index];
    if (!entry) return { message: "没有匹配到这个选项，尚未执行。\n\n" + renderTextMenu(menu) };
    if (entry.kind === "view") return { message: this.openTextMenu(job, origin, entry.view, "", true) };
    if (entry.kind === "task") {
      const task = this.find<Job>("job", entry.jobId);
      if (!task) return { message: "这条消息已不可用，请重新选择。" };
      this.record("text-menu", menu.id, { ...menu, active: false });
      return { message: task.status === "awaiting_route" ? this.openTextMenu(task, origin, { stage: "route" }, "", true) : this.correctionMenu(task, origin) };
    }
    if (entry.kind === "status") return { message: this.command("status", "", origin) as string };
    if (entry.kind === "dismiss") {
      this.record("text-menu", menu.id, { ...menu, active: false }); return { message: "已结束选择，当前目标保持不变。" };
    }
    if (!job) return { message: "原消息已经不可用，未执行任何操作。" };
    this.authorizeAction(origin, job);
    if (entry.kind === "cancel" || entry.kind === "retry") {
      if (job.status !== "awaiting_route") return { message: this.correctionMenu(job, origin) };
      this.closeTextMenus(job.id);
      if (entry.kind === "cancel") {
        job.status = "cancelled"; job.error = "已取消，原消息未发送。"; this.record("job", job.id, job);
        return { message: job.error };
      }
      job.status = "routing"; job.target = { ...this.selection() }; delete job.error;
      job.routing = { intent: this.get<number>("intent") ?? 0 }; this.record("job", job.id, job);
      return { jobId: job.id };
    }
    if (entry.kind !== "action") return;
    const action = entry.action;
    if (action.kind === "send" && job.status !== "awaiting_route") return { message: this.correctionMenu(job, origin) };
    if (action.target) {
      const target = action.target, member = this.catalogMembers.get(target.agent);
      const session = target.sessionId ? this.find<Session>("session", target.sessionId) : undefined;
      if ((target.projectId || target.sessionId) && this.catalogErrors.has(target.agent)) {
        return { message: this.openTextMenu(job, origin, menu.view, "该 Agent 的项目与会话目录暂不可用，原消息尚未发送。请稍后重新选择。", true) };
      }
      if (this.probes[target.agent]?.ready === false || this.probes[target.agent]?.executionError ||
          target.projectId && member && !member.projects.has(target.projectId) ||
          session && member && !member.sessions.has(session.nativeId)) {
        return { message: this.openTextMenu(job, origin, menu.view, "该目标暂不可用，原消息尚未发送。请重新选择或返回上一步。", true) };
      }
    }
    this.closeTextMenus(job.id);
    // A correction after dispatch changes only future navigation, never the original execution record.
    const navigation = job.status !== "awaiting_route";
    const applying: Job = navigation ? { id: "J" + randomUUID().replaceAll("-", "").slice(0, 12), origin,
      target: { ...this.selection() }, text, status: "accepted", createdAt: new Date().toISOString() } : job;
    if (!navigation && action.kind === "send" && job.routeMessage) {
      applying.receiptRevision = (job.receiptRevision ?? 0) + 1;
      for (const entry of this.outbox()) if (entry.jobId === job.id && entry.kind === "receipt" && entry.status === "pending") {
        this.record("outbox", entry.id, { ...entry, status: "cancelled" });
      }
    }
    applying.target.version = this.selection().version;
    this.applyRoute(applying, action);
    return { jobId: applying.id };
  }
  private routingQuestion(options: RouteAction[]): string {
    return options.length === 1 ? "请确认这条消息的处理方式。" : "这条消息应该如何处理？";
  }
  private waitForRoute(job: Job, message: string, options: RouteAction[]): void {
    this.clearMenu(job.origin);
    job.status = "awaiting_route";
    job.routing = { intent: this.get<number>("intent") ?? 0, version: this.selection().version,
      expiresAt: Date.now() + 10 * 60_000, options: options.slice(0, 2) };
    job.error = message;
    this.record("job", job.id, job);
    const text = this.openTextMenu(job, job.origin, { stage: "route" });
    if (job.origin.kind !== "desktop") this.enqueueReply(job.id + ":route:" + randomUUID(), job.origin, text, "status", job.id);
    this.changed();
  }
  private async routeJob(job: Job): Promise<void> {
    if (!job.routing || job.origin.kind !== "desktop" && !this.canReplyTo(job.origin)) return;
    let actions = routeActions(this.routingContext(job.text, job.target, job.origin, job.id));
    const valid = () => !this.closed && this.find<Job>("job", job.id)?.status === "routing" &&
      (job.origin.kind === "desktop" || this.canReplyTo(job.origin));
    const fallback = () => {
      const context = this.routingContext(job.text, job.target, job.origin, job.id);
      return context.current.sessionId || context.current.creationKey || (context.current as Selection).engaged ?
        [routeActions(context)[0]!] : [];
    };
    try {
      if (job.routing.intent !== (this.get<number>("intent") ?? 0)) throw new BridgeError("STALE_TARGET", "等待期间当前目标已改变，请重新选择本次任务的目标。");
      if (!this.routeDecision || !this.smartRoutingEnabled()) throw new BridgeError("ROUTER_UNAVAILABLE", "智能路由已关闭，请为已接收的任务选择目标。");
      if (Date.now() - Date.parse(job.queuedAt ?? job.createdAt) > 24 * 60 * 60_000) throw new BridgeError("STALE_TARGET", "任务已等待超过 24 小时，请确认目标后继续。");
      if (Date.now() - this.routeCatalogAt > 30_000) {
        await this.probeAgents();
        await Promise.allSettled(agentIDs.filter((agent) => this.probes[agent]?.ready).map((agent) => this.refreshCatalog(agent)));
        this.routeCatalogAt = Date.now();
      }
      if (!valid()) return;
      if (job.routing.intent !== (this.get<number>("intent") ?? 0)) throw new BridgeError("STALE_TARGET", "等待期间当前目标已改变，请重新选择本次任务的目标。");
      let context = this.routingContext(job.text, job.target, job.origin, job.id);
      actions = routeActions(context);
      let answer = await this.routeDecision(context, actions);
      if (!valid()) return;
      let chosen = actions.find((action) => action.id === answer.choice);
      if (chosen?.kind === "lookup" && chosen.scope && isConfidentRoute(answer)) {
        context = { ...context, lookupScope: chosen.scope };
        actions = routeActions(context);
        answer = await this.routeDecision(context, actions);
        if (!valid()) return;
        chosen = actions.find(action => action.id === answer.choice);
      }
      if (chosen?.target && chosen.kind !== "control") await this.probeAgent(chosen.target.agent);
      if (!valid()) return;
      if (job.routing.intent !== (this.get<number>("intent") ?? 0) ||
          JSON.stringify(context.settings) !== JSON.stringify(this.routingSettings())) {
        throw new BridgeError("STALE_TARGET", "判断期间当前目标或设置已改变，请重新选择本次任务的目标。");
      }
      if (chosen?.target && chosen.kind !== "control" && (!this.probes[chosen.target.agent]?.ready || this.probes[chosen.target.agent]?.executionError)) {
        throw new BridgeError("AGENT_UNAVAILABLE", "目标 Agent 暂不可用，任务尚未发送。请检查连接或选择其他目标。");
      }
      const canContinue = context.current.sessionId || context.current.creationKey || (context.current as Selection).engaged;
      const ranked = actions.filter((action) => !["clarify", "lookup", "answer"].includes(action.kind) &&
        (action.id !== "continue" || canContinue) && (answer.probabilities[action.id] ?? 0) > 0)
        .sort((a, b) => (answer.probabilities[b.id] ?? 0) - (answer.probabilities[a.id] ?? 0));
      const scores = Object.values(answer.probabilities).sort((a, b) => b - a);
      job.routingDecision = { provider: context.settings.provider, choice: answer.choice, confidence: answer.confidence,
        probability: answer.probabilities[answer.choice] ?? 0, margin: (scores[0] ?? 0) - (scores[1] ?? 0),
        ...(answer.intent ? { intent: { choice: answer.intent.choice, confidence: answer.intent.confidence,
          probability: answer.intent.probabilities[answer.intent.choice] ?? 0 } } : {}) };
      const continueAction = actions.find((action) => action.id === "continue");
      const sameDestination = (a?: Target, b?: Target) => Boolean(a && b) && a!.agent === b!.agent && a!.mode === b!.mode &&
        (a!.projectId ?? null) === (b!.projectId ?? null) && (a!.sessionId ?? null) === (b!.sessionId ?? null);
      const confirmMode = context.settings.mode === "confirm";
      const navigating = answer.intent?.choice === "navigate";
      const leading = ranked[0];
      let resolved: RouteAction | undefined;
      // The top two candidates agreeing on one place is not a destination question: only whether
      // to send. Navigation switches there without sending; anything else continues there.
      if (!confirmMode && canContinue && continueAction && ranked.length > 1 &&
          ranked.slice(0, 2).every((action) => action.id === "continue" || (action.kind === "select" && sameDestination(action.target, continueAction.target)))) {
        resolved = navigating ? ranked.slice(0, 2).find((action) => action.kind === "select") ?? continueAction : continueAction;
      }
      // A lookup clears a low bar because a wrong list is cheap — but not when the task intent says
      // this is work: answering it with a list leaves the actual question unanswered.
      const taskIntent = ["current", "new", "resume"].includes(answer.intent?.choice ?? "");
      if (!resolved && !confirmMode && chosen && chosen.kind !== "clarify" && chosen.kind !== "lookup" &&
          (chosen.kind === "list" ? isConfidentLookup(answer) && !taskIntent : isConfidentRoute(answer, Boolean(context.current.sessionId)))) {
        resolved = chosen;
      }
      // A task is carried out even without a confident destination: stay in the current
      // conversation when that is the leading guess, otherwise start a fresh projectless one on
      // the leading agent. Navigation, project creation, confirm mode and an explicit clarify
      // (e.g. a named agent that is unavailable, or a cross-agent handoff) still ask.
      const clarifying = chosen?.kind === "clarify" || answer.intent?.choice === "clarify";
      if (!resolved && !confirmMode && !navigating && !clarifying && leading?.kind === "send") {
        resolved = leading.id === "continue" && answer.intent?.choice !== "new" ? leading :
          actions.find((action) => action.id === "new_" + leading.target!.agent + "_none") ?? leading;
      }
      // The flat choice can wobble (e.g. toward a status lookup) while the task intent says this is
      // work: current work continues the conversation, a new purpose gets a fresh projectless one.
      if (!resolved && !confirmMode && !navigating && !clarifying) {
        if (answer.intent?.choice === "current" && canContinue && continueAction) resolved = continueAction;
        else if (answer.intent?.choice === "new") resolved = actions.find((action) => action.id === "new_" + context.current.agent + "_none");
      }
      if (!resolved) {
        const options = ranked.length ? ranked : fallback();
        this.waitForRoute(job, chosen?.kind === "clarify" ? "这条消息希望交给哪个 Agent、项目或会话处理？" : this.routingQuestion(options), options);
        return;
      }
      chosen = resolved;
      if (job.attachments?.length && !["send", "answer"].includes(chosen.kind)) {
        throw new BridgeError("INVALID_ROUTE", "这条消息带有附件，请选择接收文件的目标。原消息和附件已保留。");
      }
      this.db.transaction(() => this.applyRoute(job, chosen))();
      this.changed();
    } catch (error) {
      if (!valid()) return;
      const options = fallback();
      // Jev is unavailable (not configured, network, quota, rejected key, …): an already-engaged
      // target was chosen accurately before, so continuing it needs no re-confirmation. Only a
      // message with no established destination yet is genuinely ambiguous without Jev's judgment.
      if (options.length === 1 && options[0]!.id === "continue") {
        this.db.transaction(() => this.applyRoute(job, options[0]!))();
        this.changed();
        return;
      }
      this.waitForRoute(job, error instanceof BridgeError ? error.message.replace(/^[A-Z_]+: /, "") : "路由暂不可用，任务未发送。", options);
    }
  }
  private applyRoute(job: Job, action: RouteAction): void {
    if (action.kind === "correct") {
      const original = this.find<Job>("job", action.jobId!);
      if (!original || original.status === "cancelled") throw new BridgeError("TARGET_MISSING", "原任务已不可用，请重新说明要更正的消息。");
      this.authorizeAction(job.origin, original);
      job.routeMessage = this.correctionMenu(original, job.origin); job.status = "completed";
      delete job.routing; delete job.error; this.record("job", job.id, job);
      if (job.origin.kind !== "desktop") this.enqueueReply(job.id + ":correction", job.origin, job.routeMessage, "status", job.id);
      return;
    }
    if (action.kind === "answer") {
      const original = this.find<Job>("job", action.jobId!);
      if (!original || original.status !== "awaiting_route" || this.menuKey(original.origin) !== this.menuKey(job.origin)) {
        throw new BridgeError("INVALID_STATE", "原问题已处理，请重新说明要处理的任务。");
      }
      if (!this.routeIsOpen(original)) throw new BridgeError("STALE_MENU", "原问题的目标选择已过期，请重新说明要处理的任务。");
      const text = original.text + "\n\n路由询问：" + original.error + "\n补充目标信息：" + job.text;
      if (Buffer.byteLength(text) > 256 * 1024) throw new BridgeError("INVALID_INPUT", "补充内容过长，请缩短后重试。");
      const attachments = [...new Map([...(original.attachments ?? []), ...(job.attachments ?? [])].map(file => [file.id, file])).values()];
      if (attachments.length > attachmentLimit) throw new BridgeError("INVALID_ATTACHMENT", "补充后的附件超过 10 个，请分成不同任务发送。");
      this.record("job", original.id, { ...original, text, status: "routing", error: undefined,
        ...(attachments.length ? { attachments } : {}),
        routing: { intent: this.get<number>("intent") ?? 0 } });
      job.status = "completed"; job.followsJobId = original.id; delete job.routing; delete job.error;
      this.record("job", job.id, job); return;
    }
    if (action.kind === "control") {
      const original = this.find<Job>("job", action.jobId!);
      if (!original) throw new BridgeError("TARGET_MISSING", "原任务不存在。");
      this.authorizeAction(job.origin, original);
      try {
        const result = this.command(action.command!, original.id, job.origin);
        if (typeof result !== "string" && result.jobId) job.followsJobId = result.jobId;
        const message = typeof result === "string" ? result : result.message ?? "已恢复任务。";
        job.routeMessage = message.replaceAll(original.id, this.targetName(original.target)); job.status = "completed";
      } catch (error) {
        if (!(error instanceof BridgeError)) throw error;
        job.status = "failed"; job.routeMessage = error.message.replace(/^[A-Z_]+: /, "");
      }
      delete job.routing; delete job.error; this.record("job", job.id, job);
      if (job.origin.kind !== "desktop") this.enqueueReply(job.id + ":control", job.origin, job.routeMessage!, "status", job.id);
      return;
    }
    if (action.target) {
      const target = this.resolvedTarget(action.target);
      this.executable(target.agent);
      if (target.sessionId) {
        const session = this.find<Session>("session", target.sessionId);
        if (!session || session.agent !== target.agent || session.mode !== target.mode || session.projectId !== target.projectId) {
          throw new BridgeError("TARGET_MISSING", "原会话已经改变，请重新选择。");
        }
      } else if (target.projectId && !this.list<Project>("project").some((project) => project.agent === target.agent && project.id === target.projectId)) {
        throw new BridgeError("TARGET_MISSING", "项目已经改变，请重新选择。");
      }
      const current = this.selection();
      const visible = current.version === job.target.version;
      const switching = ["agent", "mode", "projectId", "sessionId", "creationKey"].some((key) =>
        (current[key as keyof Target] ?? null) !== (target[key as keyof Target] ?? null));
      if (switching) {
        const intent = this.get<number>("intent") ?? 0;
        this.put("intent", intent + 1);
        // Later natural-language messages follow this committed route; manual changes never rebase them.
        for (const pending of this.list<Job>("job")) {
          if (pending.status === "routing" && pending.routing?.intent === intent && pending.id !== job.id) {
            this.record("job", pending.id, { ...pending, routing: { intent: intent + 1 } });
          }
        }
        if (visible) this.select(target);
      }
      if (action.kind === "select" && visible && !switching && !current.engaged) this.select(target);
      if (action.kind === "send") {
        job.target = this.reserve({ ...target, version: visible ? this.selection().version : target.version });
        if (visible) this.put("selection", { ...job.target, sessionId: job.target.sessionId ?? null, creationKey: job.target.creationKey ?? null, engaged: true });
        for (const pending of this.list<Job>("job")) {
          if (pending.id !== job.id && pending.status === "routing" && pending.routing?.intent === (this.get<number>("intent") ?? 0)) {
            this.record("job", pending.id, { ...pending, target: { ...job.target } });
          }
        }
      }
    }
    // A status reply describes the other tasks; this message is answered by it, not still pending.
    if (action.kind === "list") this.record("job", job.id, { ...job, status: "completed" });
    const message = action.kind === "list" ? action.command === "status" ? this.command("status", "", job.origin) :
      action.command === "help" ? this.command("help", "", job.origin) :
      // Agents are a short fixed list; the informative form (with the reason each one is
      // unavailable) beats a bare picker here, matching what /agent alone has always shown.
      action.command === "agent" ? this.command("agent", "", job.origin) :
      this.openTextMenu({ ...job, status: "completed" }, job.origin, { stage: action.command === "project" ? "projects" : "sessions",
        mode: "select", scope: action.scope ?? { agent: this.selection().agent } }, "", true) :
      action.kind === "select" ? this.targetName(action.target!) + (action.target?.sessionId ? "\n已切换✅" : "\n下一条消息将在这里开始。") : action.label;
    delete job.routing; delete job.error;
    job.status = action.kind === "send" ? "accepted" : "completed";
    if (action.kind !== "send") {
      job.routeMessage = typeof message === "string" ? message : message.message;
      if (job.routeMessage && job.origin.kind !== "desktop") this.enqueueReply(job.id + ":target", job.origin, job.routeMessage, "status", job.id);
    }
    this.record("job", job.id, job);
  }
  resolveRouting(jobId: string, index: number, origin: Origin): Receipt {
    const job = this.find<Job>("job", jobId);
    if (!job || job.status !== "awaiting_route" || !job.routing?.options) throw new BridgeError("INVALID_STATE", "该任务当前不需要选择目标。");
    this.authorizeAction(origin, job);
    if (!Number.isSafeInteger(index) || index < 1 || index > job.routing.options.length + 1) throw new BridgeError("INVALID_INPUT", "请选择本次显示的编号。");
    const receipt = this.db.transaction(() => {
      if (index === job.routing!.options!.length + 1) {
        this.closeTextMenus(job.id);
        job.status = "cancelled"; job.error = "已取消，任务未发送。"; this.record("job", job.id, job);
        return { message: "已取消，任务未发送。" };
      }
      if ((job.routing!.expiresAt ?? 0) <= Date.now()) {
        throw new BridgeError("STALE_MENU", "目标选择已过期。请补充目标信息或重试路由，原始任务仍已保留。");
      }
      if (job.origin.kind !== "desktop" && !this.canReplyTo(job.origin)) throw new BridgeError("UNAUTHORIZED", "原消息通道已经解除绑定。");
      this.closeTextMenus(job.id);
      this.applyRoute(job, job.routing!.options![index - 1]!);
      return { jobId: job.id };
    })();
    this.changed(); return receipt;
  }
  private answerRouting(text: string, origin: Origin): Receipt | undefined {
    if (this.textMenus(origin).length) return;
    if (/^\d+$/.test(text) && this.find("choice-menu", this.menuKey(origin))) return;
    const jobs = this.list<Job>("job").filter((job) => job.status === "awaiting_route" &&
      this.menuKey(job.origin) === this.menuKey(origin));
    if (jobs.length > 1 && (/^\d+$/.test(text) || ["取消", "算了"].includes(text))) {
      return { message: this.openTextMenu(undefined, origin, { stage: "tasks" }, "", true) };
    }
    const job = jobs[0];
    if (!job) return;
    if (/^\d+$/.test(text)) return this.resolveRouting(job.id, Number(text), origin);
    if (["取消", "算了"].includes(text)) return this.resolveRouting(job.id, job.routing!.options!.length + 1, origin);
    return;
  }
  private answerProjectTrust(text: string, origin: Origin): Receipt | undefined {
    if (!["信任此项目", "不信任此项目"].includes(text)) return;
    const pending = this.list<Approval>("approval").filter(approval => {
      const job = this.find<Job>("job", approval.jobId);
      return approval.kind === "projectTrust" && approval.status === "pending" && job && this.menuKey(job.origin) === this.menuKey(origin);
    });
    if (pending.length !== 1) return { message: "当前对话没有唯一的待确认项目，未更改目录信任设置。" };
    const result = this.command(text === "信任此项目" ? "approve" : "deny", pending[0]!.id, origin);
    return typeof result === "string" ? { message: result } : result;
  }
  private cancelRoutingQuestions(): void {
    for (const job of this.list<Job>("job")) {
      if (job.status !== "awaiting_route") continue;
      job.error = "当前目标已改变，原消息已保留，尚未发送。请重新选择这条消息的目标。";
      if (job.routing) job.routing.expiresAt = 0;
      this.record("job", job.id, job);
    }
  }

  private command(name: string, argument: string, origin: Origin): string | Receipt {
    const selected = this.selection();
    if (name === "help") return commandGuide;
    if (name === "approve" || name === "deny") {
      const approval = this.find<Approval>("approval", argument);
      const job = approval && this.find<Job>("job", approval.jobId);
      if (!approval || !job) throw new BridgeError("TARGET_MISSING", "审批不存在。");
      this.authorizeAction(origin, job);
      if (approval.status !== "pending" || Date.parse(approval.expiresAt) <= Date.now() || !this.approvalWaiters.has(approval.id)) {
        throw new BridgeError("INVALID_STATE", "审批已经结束或过期，未重复授权。");
      }
      this.record("approval", approval.id, { ...approval, status: name === "approve" ? "approved" : "denied" });
      if (job.status === "awaiting_approval" && !this.list<Approval>("approval").some((a) => a.jobId === job.id && a.status === "pending")) {
        this.record("job", job.id, { ...job, status: "running" });
      }
      if (approval.kind === "projectTrust") return name === "approve" ? "已收到授权，正在将此项目加入 Codex。" : "未更改目录信任设置，项目文件和会话保留。";
      return approval.id + (name === "approve" ? " 已单次允许。" : " 已拒绝。");
    }
    if (name === "stop") {
      const candidates = this.list<Job>("job").filter((job) => ["dispatching", "queued", "running", "awaiting_approval", "stopping"].includes(job.status) &&
        (argument ? job.id === argument : job.sessionId === selected.sessionId));
      if (candidates.length !== 1) throw new BridgeError("INVALID_STATE", "请使用 /stop J… 指定一个正在执行的任务。");
      const job = candidates[0]!; this.authorizeAction(origin, job);
      if (job.externalControl) throw new BridgeError("EXTERNAL_CONTROL", "此任务在 Codex 原会话中执行，请在那里停止或移除排队消息。");
      if (!this.adapters[job.target.agent]?.stopTurn) throw new BridgeError("AGENT_UNAVAILABLE", "该 Agent 尚不支持停止。");
      this.record("job", job.id, { ...job, status: "stopping" }); this.expireApprovals(job.id);
      return job.id + " 已请求停止，等待运行时确认。";
    }
    if (name === "continue" || name === "cancel") {
      const job = this.find<Job>("job", argument);
      if (!job) throw new BridgeError("TARGET_MISSING", "此任务不存在。");
      this.authorizeAction(origin, job);
      // Retrying an uncertain task could send it twice, but closing its record cannot: without this
      // the task is stuck forever and still counts against the intake limit.
      if (["dispatching", "queued", "running", "awaiting_approval", "stopping"].includes(job.status) ||
          (job.status === "uncertain" && name === "continue")) {
        throw new BridgeError("SEND_UNCERTAIN", "该任务可能已经发送，请先在原 Agent 核对；没有重试或取消原操作。");
      }
      if (name === "cancel") {
        if (job.status === "cancelled") return job.id + " 已取消。";
        const unconfirmed = job.status === "uncertain";
        if (!unconfirmed && !["accepted", "preparing", "waiting_agent", "awaiting_confirmation", "routing", "awaiting_route"].includes(job.status)) {
          throw new BridgeError("INVALID_STATE", "此任务已结束。");
        }
        job.status = "cancelled";
        job.error = unconfirmed ? "已关闭；原操作可能已在 Agent 中执行过，正文不会重新发送。" : "已取消，正文不会发送给 Agent。";
        this.record("job", job.id, job);
        return job.id + " 已取消。";
      }
      if (!["waiting_agent", "awaiting_confirmation", "awaiting_route"].includes(job.status)) {
        throw new BridgeError("INVALID_STATE", "此任务不处于等待继续状态。");
      }
      job.status = job.routing ? "routing" : "accepted";
      if (job.routing) job.routing = { intent: this.get<number>("intent") ?? 0 };
      job.queuedAt = new Date().toISOString(); delete job.error;
      this.record("job", job.id, job);
      return { jobId: job.id, message: job.id + " 已继续，保持原 Agent 和会话。" };
    }
    if (name === "status") {
      const labels: Record<string, string> = {
        routing: "正在判断目标", awaiting_route: "等待选择目标，任务尚未发送",
        accepted: "已接收，等待执行", preparing: "正在连接会话", dispatching: "正在发送给助手",
        queued: "已加入原会话队列，等待执行",
        running: "正在执行", awaiting_approval: "等待你的审批", stopping: "正在停止，等待确认",
        waiting_agent: "助手暂不可用，任务尚未发送", awaiting_confirmation: "等待你确认后继续", uncertain: "执行结果待确认",
      };
      const summary = (text: string, limit = 100) => {
        const line = text.replaceAll(/\s+/g, " ").trim();
        return line.length > limit ? line.slice(0, limit) + "…" : line;
      };
      const projects = this.list<Project>("project");
      const projectName = (target: Target) => target.projectId ? summary(projects.find((p) => p.agent === target.agent && p.id === target.projectId)?.name ?? "项目名称暂不可用") : "无项目";
      const sessionName = (id: string | null | undefined) => id ? summary(this.find<Session>("session", id)?.title ?? "会话名称暂不可用") : "尚未选择，发送消息会新建会话";
      const jobs = this.list<Job>("job").filter((job) => Object.hasOwn(labels, job.status));
      const current = "当前助手：" + (agentNames[selected.agent] ?? selected.agent) + "\n当前项目：" + projectName(selected) + "\n当前会话：" + sessionName(selected.sessionId) +
        "\n助手状态：" + this.availabilityLabel(selected.agent) + (this.probes[selected.agent]?.ready === false ? "\n" + this.probes[selected.agent]!.reason :
          this.probes[selected.agent]?.executionError ? "\n" + this.probes[selected.agent]!.executionError : "");
      if (!jobs.length) return current + "\n\n没有待处理的桥接任务。";
      return current + "\n\n未结束的桥接任务（共 " + jobs.length + " 项" + (jobs.length > 5 ? "，显示最近 5 项" : "") + "）：\n" +
        jobs.slice(-5).map((job, index) => {
          const agent = agentNames[job.target.agent] ?? job.target.agent;
          const sessionId = job.sessionId ?? job.target.sessionId;
          const canAct = origin.kind === "desktop" || origin.kind === job.origin.kind && origin.accountId === job.origin.accountId &&
            origin.peerId === job.origin.peerId && this.canReplyTo(job.origin);
          const actions: string[] = [];
          if (canAct) {
            if (["waiting_agent", "awaiting_confirmation", "awaiting_route"].includes(job.status)) actions.push("继续：/continue " + job.id);
            if (["accepted", "preparing", "waiting_agent", "awaiting_confirmation", "routing", "awaiting_route"].includes(job.status)) actions.push("取消：/cancel " + job.id);
            if (!job.externalControl && ["dispatching", "running", "awaiting_approval"].includes(job.status) && this.adapters[job.target.agent]?.stopTurn) actions.push("停止：/stop " + job.id);
          }
          return (index + 1) + ". " + labels[job.status] + "\n所属助手：" + agent + "\n所属项目：" + projectName(job.target) +
            "\n所属会话：" + (sessionId ? sessionName(sessionId) : "新会话尚未确认") + "\n请求：" + summary(job.text, 60) +
            (job.error ? "\n说明：" + summary(job.error, 200) : "") +
            (job.externalControl ? "\n停止与审批请在 Codex 原会话中处理。" : "") +
            (job.status === "uncertain" ? "\n原操作可能已经执行，未自动重发。请在电脑上的 " + agent + " 中" + (sessionId ? "打开该会话" : "检查最近的会话") + "核对执行结果。" : "") +
            (actions.length ? "\n" + actions.join("\n") : "");
        }).join("\n\n");
    }
    if (name === "agent" && !argument) return agentIDs.map((id) => agentNames[id] + "：" + this.availabilityLabel(id) +
      (this.probes[id]?.ready === false ? "\n" + this.probes[id]!.reason : this.probes[id]?.executionError ? "\n" + this.probes[id]!.executionError : "") +
      "\n切换：/agent " + id).join("\n\n");
    if (name === "agent") {
      this.executable(argument);
      this.navigationVersion++;
      this.clearMenu(origin);
      if (argument !== selected.agent) {
        this.cancelRoutingQuestions();
        this.put("intent", (this.get<number>("intent") ?? 0) + 1);
        this.select(this.get<Target>("active:" + argument + ":code") ?? this.fresh(argument));
      }
      return "当前 Agent：" + argument;
    }
    if (name === "new" || (name === "project" && argument === "none")) {
      this.cancelRoutingQuestions();
      this.clearMenu(origin);
      const target = { ...selected, sessionId: null, creationKey: null, projectId: name === "project" ? null : selected.projectId };
      this.put("intent", (this.get<number>("intent") ?? 0) + 1);
      this.select(target);
      return "下一条普通消息会新建会话。";
    }
    if (name === "projects" || name === "project" && !argument) {
      const projects = this.list<Project>("project").filter((p) => p.agent === selected.agent);
      return projects.length ? this.menu("project", [...projects.map((p) => ({ id: p.shortId, name: p.name })),
        { id: "none", name: "无项目" }], origin) : this.command("sessions", "all", origin);
    }
    if (name === "project") {
      const project = this.list<Project>("project").find((p) => p.shortId === argument && p.agent === selected.agent);
      if (!project) throw new BridgeError("TARGET_MISSING", "此项目不存在，请使用 /projects 查看当前 Agent 的项目。");
      this.cancelRoutingQuestions();
      this.clearMenu(origin);
      this.put("intent", (this.get<number>("intent") ?? 0) + 1);
      this.select({ ...selected, projectId: project.id, sessionId: null, creationKey: null });
      return "当前项目：" + project.name + "\n发送 /sessions 选择已有会话，或直接发消息新建会话。";
    }
    if (name === "sessions") {
      if (argument && argument !== "all") return "用法：/sessions 或 /sessions all";
      const sessions = this.list<Session>("session").filter((s) => s.agent === selected.agent && s.mode === selected.mode &&
        (argument === "all" || s.projectId === selected.projectId));
      sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      if (sessions.length) return this.menu("session", sessions.map((s) => ({ id: s.shortId, name: s.title })), origin);
      this.clearMenu(origin);
      return argument === "all" ? "当前 Agent 暂无会话，直接发送消息即可新建会话。" : "当前项目暂无会话。发送 /sessions all 查看全部，或直接发消息新建会话。";
    }
    if (name === "more") {
      const menu = this.currentMenu(origin);
      if (!menu || argument) throw new BridgeError("STALE_MENU", "请重新发送 /project 或 /sessions 获取列表，再发送 /more 翻页。");
      if (menu.offset + 8 >= menu.entries.length) return "已经是最后一页。";
      return this.menu(menu.kind, menu.entries, origin, menu.offset + 8, menu.expiresAt);
    }
    if (name === "use") {
      const session = this.list<Session>("session").find((s) => s.shortId === argument);
      if (!session) throw new BridgeError("TARGET_MISSING", "此会话 ID 不存在。");
      this.navigationVersion++;
      this.clearMenu(origin);
      if (selected.sessionId !== session.id || selected.agent !== session.agent || selected.mode !== session.mode || selected.projectId !== session.projectId) {
        this.cancelRoutingQuestions();
        this.put("intent", (this.get<number>("intent") ?? 0) + 1);
        this.select({ agent: session.agent, mode: session.mode, projectId: session.projectId, sessionId: session.id });
      }
      return "当前会话：" + session.title.replaceAll(/\s+/g, " ").slice(0, 100);
    }
    if (name === "mode" && (!argument || argument === "code")) return "当前模式：Code。其他模式需分别完成桌面接入验证。";
    return "此操作尚未通过桌面接入验证；当前目标保持不变。";
  }

  async openAgent(agent: string): Promise<void> {
    this.executable(agent);
    const navigation = ++this.navigationVersion;
    const selected = this.selection();
    if (selected.agent === agent && selected.sessionId) {
      // Reopening the visible conversation is a refresh, not a new routing intent.
      if (this.adapters[agent]?.listSessions) await this.refreshCatalog(agent);
      else await this.ensureSession(selected);
      await this.loadHistory(selected.sessionId);
      this.changed();
      return;
    }
    if (this.adapters[agent]?.listSessions) {
      const target = this.get<Target>("active:" + agent + ":code") ?? this.fresh(agent);
      await this.refreshCatalog(agent);
      if (this.navigationVersion === navigation) {
        this.select(target);
        this.changed();
        if (target.sessionId) await this.loadHistory(target.sessionId);
      }
      return;
    }
    const target = this.db.transaction(() => {
      const existing = this.get<Target>("active:" + agent + ":code") ?? this.fresh(agent);
      const reserved = this.reserve(existing);
      const current = this.selection();
      if (current.agent === agent && !current.sessionId && current.projectId === reserved.projectId) {
        this.put("selection", { ...current, creationKey: reserved.creationKey ?? null });
      }
      return reserved;
    })();
    const session = await this.ensureSession(target);
    if (this.navigationVersion === navigation) {
      this.select({ ...target, sessionId: session.id, creationKey: null });
    }
    this.changed();
  }

  private async ensureSession(target: Target): Promise<Session> {
    this.executable(target.agent);
    const adapter = this.adapters[target.agent]!;
    const probe = await this.probeAgent(target.agent);
    if (this.closed) throw new BridgeError("CLOSED", "本地服务已停止。");
    if (!probe.ready) throw new BridgeError("AGENT_UNAVAILABLE", probe.reason);
    if (target.sessionId) {
      const session = this.find<Session>("session", target.sessionId);
      if (!session) throw new BridgeError("TARGET_MISSING", "已绑定的会话不在数据库中。");
      const resumed = await adapter.resumeSession(session);
      if (this.closed) throw new BridgeError("CLOSED", "本地服务已停止。");
      if (resumed.nativeId !== session.nativeId || resumed.projectId !== session.projectId) throw new BridgeError("TARGET_MISMATCH", "原生会话核对不一致。");
      return session;
    }
    const key = target.creationKey!;
    const pending = this.creations.get(key);
    if (pending) return pending;
    const creation = this.find<Creation>("creation", key)!;
    if (creation.status === "confirmed") {
      return this.ensureSession({ ...target, sessionId: creation.sessionId });
    }
    if (creation.status === "uncertain" || creation.status === "creating") throw new BridgeError("SEND_UNCERTAIN", "上次会话创建结果不确定，不能自动重建。");
    const promise = (async () => {
      this.record("creation", key, { ...creation, status: "creating" });
      try {
        const native = await adapter.createSession(target, key);
        if (this.closed) throw new BridgeError("CLOSED", "本地服务已停止。");
        if (!native.nativeId || native.projectId !== target.projectId) throw new BridgeError("TARGET_MISMATCH", "新会话项目与请求不一致。");
        const session: Session = { ...native, id: randomUUID(), shortId: "S" + randomUUID().replaceAll("-", "").slice(0, 12), agent: target.agent, mode: target.mode };
        this.db.transaction(() => {
          this.record("session", session.id, session);
          this.record("creation", key, { ...creation, status: "confirmed", sessionId: session.id });
          const active = this.get<Target>(this.activeKey(target));
          if (active?.creationKey === key) this.put(this.activeKey(target), { ...target, sessionId: session.id, creationKey: null });
          if (this.selection().creationKey === key) this.select({ ...target, sessionId: session.id, creationKey: null });
        })();
        return session;
      } catch (error) {
        if (!this.closed) this.record("creation", key, { ...creation, status: "uncertain" });
        throw error;
      }
    })();
    this.creations.set(key, promise);
    try { return await promise; } finally { this.creations.delete(key); }
  }

  run(jobId: string): Promise<void> {
    const running = this.runs.get(jobId);
    if (running) return running;
    const routed = this.routeTail.then(async () => {
      if (this.closed) return;
      const job = this.find<Job>("job", jobId);
      if (job?.status === "routing") await this.routeJob(job);
      return this.closed ? undefined : this.find<Job>("job", jobId);
    });
    this.routeTail = routed.then(() => {}, () => {});
    const next = routed.then(async (job) => {
      if (!job || this.closed) return;
      if (job.followsJobId) { await this.run(job.followsJobId); return; }
      if (job.status !== "accepted") return;
      const prior = this.agentTails.get(job.target.agent);
      if (prior && job.origin.kind !== "desktop") {
        job.routeMessage = this.targetName(this.resolvedTarget(job.target)) + "\n已收到✅\n等待前一个任务完成。";
        this.record("job", job.id, job);
        this.enqueueReply(job.id + ":receipt" + (job.receiptRevision ? ":" + job.receiptRevision : ""), job.origin, job.routeMessage, "receipt", job.id); this.changed();
      }
      const execution = (prior ?? Promise.resolve()).then(() => {
        if (this.find<Job>("job", jobId)?.target.agent === job.target.agent) return this.runJob(jobId);
      });
      const tail = execution.catch(() => {});
      this.agentTails.set(job.target.agent, tail);
      try { await execution; } finally { if (this.agentTails.get(job.target.agent) === tail) this.agentTails.delete(job.target.agent); }
    }).finally(() => this.runs.delete(jobId)).then(async () => {
      // A local correction can accept the same task while its previous preparation is still unwinding.
      if (!this.closed && ["accepted", "routing"].includes(this.find<Job>("job", jobId)?.status ?? "")) await this.run(jobId);
    });
    this.runs.set(jobId, next); return next;
  }
  private async runJob(jobId: string): Promise<void> {
    if (this.closed) return;
    const job = this.find<Job>("job", jobId);
    if (!job || job.status !== "accepted") return;
    if (Date.now() - Date.parse(job.queuedAt ?? job.createdAt) > 24 * 60 * 60 * 1000) {
      job.status = "awaiting_confirmation"; job.error = "排队超过 24 小时，需要确认后继续。";
      this.saveWaitingJob(job); this.changed(); return;
    }
    let dispatched = false;
    const messages = new Map<string, AssistantMessageUpdate>();
    const pending = new Map<string, Message & { completed: boolean }>();
    let timer: NodeJS.Timeout | undefined, acceptingText = true;
    const flush = (deliver = true) => {
      clearTimeout(timer); timer = undefined;
      if (!this.db.open || !pending.size) return;
      this.db.transaction(() => {
        for (const { completed, ...message } of pending.values()) {
          this.record("message", message.id, message);
          if (completed && deliver && job.origin.kind !== "desktop") this.enqueueReply(message.id, job.origin, message.text, "assistant", job.id);
        }
      })();
      pending.clear(); this.changed();
    };
    const update = (value: AssistantMessageUpdate) => {
      if (this.closed || !acceptingText || !value.text || messages.get(value.id)?.completed) return;
      const previous = messages.get(value.id);
      if (previous?.text === value.text && previous.completed === value.completed) return;
      messages.set(value.id, value);
      const id = job.id + ":assistant:" + value.id;
      pending.set(id, { id, sessionId: job.sessionId!, role: "assistant", text: value.text,
        replyTo: this.quote(job.id + ":user", job.text),
        createdAt: pending.get(id)?.createdAt ?? this.find<Message>("message", id)?.createdAt ?? new Date().toISOString(), completed: value.completed });
      if (value.completed) flush();
      else timer ??= setTimeout(flush, 100);
    };
    const finishText = () => {
      for (const message of messages.values()) if (!message.completed) update({ ...message, completed: true });
      flush();
    };
    this.flushText.set(jobId, flush);
    try {
      job.status = "preparing";
      this.record("job", job.id, job);
      if (job.newProject) await this.prepareProject(job);
      if (this.closed || this.find<Job>("job", job.id)?.status !== "preparing") return;
      let session = await this.ensureSession(job.target);
      if (this.closed) return;
      if (this.find<Job>("job", job.id)?.status !== "preparing") return;
      job.sessionId = session.id; job.status = "dispatching";
      job.routeMessage = this.targetName(job.target, session) + "\n已收到✅";
      this.db.transaction(() => {
        this.record("job", job.id, job);
        if (job.origin.kind !== "desktop") this.enqueueReply(job.id + ":receipt" + (job.receiptRevision ? ":" + job.receiptRevision : ""), job.origin, job.routeMessage!, "receipt", job.id);
      })();
      this.changed();
      dispatched = true;
      const prompt = this.prompt(job);
      const result = await this.adapters[job.target.agent]!.sendTurn(session, prompt, job.id, {
        queued: () => {
          if (this.closed) return;
          job.externalControl = true;
          this.record("job", job.id, { ...job, status: "queued" });
          if (job.origin.kind !== "desktop") this.enqueueReply(job.id + ":queued", job.origin,
            "已加入 Codex 原会话队列，等待执行。停止与审批请在 Codex 原会话中处理。", "status", job.id);
          this.changed();
        },
        started: (turnId) => {
          if (this.closed) return;
          const current = this.find<Job>("job", job.id)!;
          this.record("job", job.id, { ...current, turnId, status: current.status === "stopping" ? "stopping" : "running" });
          this.record("message", job.id + ":user", { id: job.id + ":user", sessionId: session.id, role: "user", text: job.text,
            attachments: job.attachments, createdAt: new Date().toISOString() });
          this.changed();
        },
        message: update,
        approval: (request) => this.requestApproval(job.id, request),
      });
      if (this.closed) return;
      if (!result.turnId || typeof result.text !== "string") throw new BridgeError("SEND_UNCERTAIN", "未收到有效的原生完成结果。");
      if (!result.status || result.status === "completed") session = await this.collectOutputs(job, session, result.text);
      if (this.closed) return;
      finishText();
      this.db.transaction(() => {
        job.status = result.status ?? "completed"; job.turnId = result.turnId;
        if (job.status === "failed") job.error = "Agent 执行失败；未自动重试。";
        if (job.status === "interrupted") job.error = "运行时已确认任务停止。";
        this.record("job", job.id, job);
        this.expireApprovals(job.id);
        for (const [role, text] of [["user", job.text], ...(messages.size ? [] : [["assistant", result.text]])]) {
          const id = job.id + ":" + role;
          this.record("message", id, { id, sessionId: session.id, role, text, createdAt: new Date().toISOString(),
            ...(role === "user" ? { attachments: job.attachments } : { replyTo: this.quote(job.id + ":user", job.text) }) });
        }
        if (!messages.size) this.enqueueReply(job.id, job.origin, (job.error ? job.id + " · " + job.error + "\n" : "") + result.text, "final", job.id);
        else if (job.error && job.origin.kind !== "desktop") this.enqueueReply(job.id + ":status", job.origin, job.error, "status", job.id);
      })();
    } catch (error) {
      if (this.closed) return;
      const current = this.find<Job>("job", job.id);
      if (current?.status === "cancelled" || !dispatched && current?.status !== "preparing") return;
      finishText();
      job.turnId = this.find<Job>("job", job.id)?.turnId;
      this.expireApprovals(job.id);
      const code = error instanceof BridgeError ? error.code : (error instanceof Error && error.message === "TARGET_MISSING" ? "TARGET_MISSING" : "UNKNOWN");
      job.status = dispatched || code === "SEND_UNCERTAIN" || code === "UNKNOWN" ? "uncertain" : code === "AGENT_UNAVAILABLE" ? "waiting_agent" : "failed";
      job.error = code === "AGENT_UNAVAILABLE" && error instanceof BridgeError ? error.message.replace(/^AGENT_UNAVAILABLE: /, "") + " 任务未发送。" : code === "TARGET_MISSING" ? (error instanceof BridgeError ? error.message.replace(/^TARGET_MISSING: /, "") : "原会话不存在。") + " 任务未发送。" : "操作状态待确认，未自动重试。";
      this.saveWaitingJob(job);
    } finally {
      acceptingText = false; flush(false); this.flushText.delete(jobId);
      this.adapters[job.target.agent]?.releaseSession?.();
      if (!this.closed && this.adapters[job.target.agent]) void this.probeAgent(job.target.agent);
    }
    this.changed();
  }
  private async collectOutputs(job: Job, session: Session, text: string): Promise<Session> {
    let current = session;
    if (!session.projectId) {
      try {
        const project = outputProject(text, session.cwd);
        if (project) {
          const title = (project.name + " · " + job.text.replaceAll(/\s+/g, " ").slice(0, 22)).slice(0, 48);
          const binder = this.adapters[session.agent]?.bindProject;
          const bound = binder ? await binder.call(this.adapters[session.agent], session, project, title, request => this.requestApproval(job.id, request)) : {
            notice: undefined,
            project: { id: project.root, name: project.name, roots: [project.root] }, session: { ...session, projectId: project.root, title } };
          if (this.closed) return current;
          if (bound.session.nativeId !== session.nativeId || bound.session.projectId !== bound.project.id || !bound.project.roots.includes(project.root)) {
            throw new Error("Project binding mismatch");
          }
          current = { ...session, ...bound.session, shortTitle: title, ...(!binder ? { localProject: bound.project.id } : {}) };
          this.db.transaction(() => {
            const key = session.agent + ":" + bound.project.id;
            const previous = this.find<Project>("project", key);
            this.record("project", key, { ...bound.project, agent: session.agent, shortId: previous?.shortId ?? "P" + randomUUID().replaceAll("-", "").slice(0, 12), managed: true });
            this.record("session", session.id, current);
            this.catalogMembers.get(session.agent)?.projects.add(bound.project.id);
            const matches = (target: Target) => target.agent === session.agent && this.resolvedTarget(target).sessionId === session.id;
            const update = (target: Target) => ({ ...target, projectId: bound.project.id, sessionId: session.id, creationKey: null });
            if (matches(this.selection())) this.select(update(this.selection()));
            const active = this.get<Target>(this.activeKey(session));
            if (active && matches(active)) this.put(this.activeKey(session), update(active));
            for (const queued of this.list<Job>("job")) {
              if (["accepted", "routing", "awaiting_route"].includes(queued.status) && matches(queued.target)) {
                queued.target = update(queued.target);
                if (queued.routing?.options) queued.routing.options = queued.routing.options.map(option => option.target && matches(option.target) ? { ...option, target: update(option.target) } : option);
                this.record("job", queued.id, queued);
              }
            }
            job.target = update(job.target);
            job.routeMessage = this.targetName(job.target, current) + (bound.notice ? "｜项目已关联\n" + bound.notice : "｜项目已就绪");
          })();
          if (job.origin.kind !== "desktop") this.enqueueReply(job.id + ":project", job.origin, job.routeMessage!, "status", job.id);
        }
      } catch {
        if (!this.closed && job.origin.kind !== "desktop") this.enqueueReply(job.id + ":project-error", job.origin,
          "任务已执行，但项目关联未能同步。当前会话保留，可以继续对话。", "status", job.id);
      }
    }
    if (this.closed || job.origin.kind === "desktop") return current;
    try {
      const outputs = snapshotOutputs(text, current.cwd, join(dirname(this.databasePath), "Outgoing"));
      for (const attachment of outputs.files) this.enqueueAttachment(job.id + ":attachment:" + attachment.sha256, job.origin, attachment, job.id);
      if (outputs.warnings.length) this.enqueueReply(job.id + ":output-warning", job.origin, outputs.warnings.join("\n"), "status", job.id);
    } catch { this.enqueueReply(job.id + ":output-error", job.origin, "任务已执行，但成果附件无法读取。文字答案和会话已保留。", "status", job.id); }
    return current;
  }
  private authorizeAction(origin: Origin, job: Job): void {
    if (origin.kind === "desktop") return;
    if (origin.kind !== job.origin.kind || origin.accountId !== job.origin.accountId || origin.peerId !== job.origin.peerId || !this.canReplyTo(job.origin)) {
      throw new BridgeError("UNAUTHORIZED", "只能在发起任务的通道或本机操作此任务。");
    }
  }
  private requestApproval(jobId: string, request: ApprovalRequest): Promise<"accept" | "decline"> {
    if (this.closed) return Promise.resolve("decline");
    const job = this.find<Job>("job", jobId);
    if (!job || !["running", "awaiting_approval"].includes(job.status) ||
        job.origin.kind !== "desktop" && !this.canReplyTo(job.origin) || this.approvalWaiters.size >= 4) return Promise.resolve("decline");
    const id = "A" + randomUUID().replaceAll("-", "").slice(0, 12);
    const approval: Approval = { ...request, id, jobId, status: "pending", expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() };
    const promise = new Promise<"accept" | "decline">((resolve) => {
      const timer = setTimeout(() => {
        if (this.closed) return;
        const current = this.find<Approval>("approval", id);
        if (current?.status === "pending") {
          this.record("approval", id, { ...current, status: "expired" });
          const currentJob = this.find<Job>("job", jobId)!;
          if (currentJob.status === "awaiting_approval" && !this.list<Approval>("approval").some((a) => a.jobId === jobId && a.status === "pending")) {
            this.record("job", jobId, { ...currentJob, status: "running" });
          }
          this.changed();
        }
      }, 10 * 60 * 1000);
      this.approvalWaiters.set(id, { resolve, timer });
    });
    this.db.transaction(() => {
      this.record("approval", id, approval);
      this.record("job", jobId, { ...job, status: "awaiting_approval" });
      if (job.origin.kind !== "desktop") this.enqueueReply(id, job.origin,
        request.kind === "projectTrust" ? request.reason + "\n目录：" + request.cwd + "\n" + request.detail +
          "\n回复“信任此项目”继续，或“不信任此项目”保留现状。确认在 10 分钟内有效。" :
          job.id + " · 需要单次确认（10 分钟内有效）\n" + request.reason + "\n目录：" + request.cwd + "\n" + request.detail +
          "\n允许：/approve " + id + "\n拒绝：/deny " + id, "approval", jobId);
    })();
    this.changed(); return promise;
  }
  private expireApprovals(jobId: string): void {
    for (const approval of this.list<Approval>("approval")) {
      if (approval.jobId === jobId && approval.status === "pending") this.record("approval", approval.id, { ...approval, status: "expired" });
    }
  }
  outbox(): OutboxEntry[] { return this.list<OutboxEntry>("outbox"); }
  // Exposed for callers (tests, the desktop app) that need to address a specific pending menu
  // directly; the rendered text no longer prints this code, since it is meaningless to a reader.
  activeMenuId(origin: Origin): string | undefined {
    return this.textMenus(origin).at(-1)?.id;
  }
  enqueueAttachment(id: string, origin: Origin, attachment: OutputAttachment, jobId: string): void {
    if (this.find("outbox", id)) return;
    this.record("outbox", id, { id, jobId, origin, attachment, text: "附件：" + attachment.name, kind: "attachment", batchId: id, status: "pending" });
  }
  private saveWaitingJob(job: Job): void {
    this.db.transaction(() => {
      this.record("job", job.id, job);
      if (job.origin.kind !== "desktop") this.enqueueReply(job.id + ":status:" + randomUUID(), job.origin,
        taskNotice(job.id, job.error ?? "操作已停止。", ["waiting_agent", "awaiting_confirmation"].includes(job.status)), "status", job.id);
    })();
  }
  /** An agent's reply as delivered to a phone channel: the answering agent comes first. */
  private signed(agent: string, text: string): string {
    return (agentEmoji[agent] ? agentEmoji[agent] + " " : "") + this.displayAgent(agent) + "\n" + text;
  }
  enqueueReply(id: string, origin: Origin, text: string, kind: string, jobId?: string): void {
    if (origin.kind !== "desktop") origin = { ...origin,
      bindingEpoch: origin.bindingEpoch ?? (jobId ? 0 : this.get<number>("binding-epoch:" + origin.kind) ?? 0) };
    const parts = splitReply(text);
    this.db.transaction(() => {
      parts.forEach((part, index) => {
        const partId = id + ":" + index;
        if (this.find("outbox", partId)) return;
        this.record("outbox", partId, { id: partId, jobId, origin, kind, batchId: id, status: "pending",
          text: parts.length > 1 ? "(" + (index + 1) + "/" + parts.length + ")\n" + part : part });
      });
    })();
  }
  ingestBatch(kind: string, account: string, cursor: string, events: ChannelEvent[]): Receipt[] {
    if (!["imessage", "weixin"].includes(kind) || !account || typeof cursor !== "string") {
      throw new BridgeError("INVALID_INPUT", "无效的消息批次。");
    }
    this.batching = true;
    let receipts: Receipt[];
    try {
      receipts = this.db.transaction(() => {
        const results: Receipt[] = [];
        for (const event of events) {
          if (event.origin.kind !== kind || event.origin.accountId !== account) throw new BridgeError("INVALID_INPUT", "消息批次身份不一致。");
          if (!this.isBound(event.origin) || event.origin.fromSelf) continue;
          if (event.sealedContext) this.put("context:" + JSON.stringify([kind, account, event.origin.peerId]), event.sealedContext);
          try { results.push(this.receive(event.origin, event.text, event.rejection)); }
          catch (error) {
            if (!(error instanceof BridgeError) || ["UNAUTHORIZED", "ECHO"].includes(error.code)) throw error;
            results.push(this.receive(event.origin, "", error.message));
          }
        }
        this.put("cursor:" + JSON.stringify([kind, account]), cursor);
        return results;
      })();
    } finally { this.batching = false; }
    this.changed();
    return receipts;
  }
  checkpoint(kind: string, account: string): string { return this.get<string>("cursor:" + JSON.stringify([kind, account])) ?? ""; }
  context(kind: string, account: string, peer: string): string | undefined { return this.get<string>("context:" + JSON.stringify([kind, account, peer])); }
  unbindChannel(kind: string): void {
    this.db.transaction(() => {
      this.put("binding-epoch:" + kind, (this.get<number>("binding-epoch:" + kind) ?? 0) + 1);
      this.db.prepare("DELETE FROM bindings WHERE kind=?").run(kind);
      for (const job of this.list<Job>("job")) {
        if (job.origin.kind === kind) this.expireApprovals(job.id);
        if (job.origin.kind === kind && ["accepted", "preparing", "waiting_agent", "awaiting_confirmation", "routing", "awaiting_route"].includes(job.status)) {
          this.record("job", job.id, { ...job, status: "cancelled", error: "通道已解除绑定，任务未发送。" });
        }
      }
      for (const entry of this.outbox()) {
        if (entry.origin.kind === kind && entry.status === "pending") this.record("outbox", entry.id, { ...entry, status: "cancelled" });
      }
    })();
    this.changed();
  }
  isBound(origin: Pick<Origin, "kind" | "accountId" | "peerId">): boolean {
    return !!this.db.prepare("SELECT 1 FROM bindings WHERE kind=? AND account=? AND peer=?").get(origin.kind, origin.accountId, origin.peerId);
  }
  canReplyTo(origin: Origin): boolean {
    return this.isBound(origin) && origin.bindingEpoch !== undefined && origin.bindingEpoch === this.get<number>("binding-epoch:" + origin.kind);
  }
  markDelivery(id: string, status: string, error?: string): void {
    const entry = this.find<OutboxEntry>("outbox", id);
    const allowed: Record<string, string[]> = { pending: ["dispatching", "cancelled"], dispatching: ["submitted", "delivery_unknown", "rejected"] };
    if (!entry || !allowed[entry.status]?.includes(status)) throw new BridgeError("INVALID_STATE", "回复状态不可转换，未重发。");
    this.record("outbox", id, { ...entry, status, error });
    this.changed();
  }
  pendingJobs(): Job[] {
    return this.list<Job>("job").filter((job) => ["routing", "accepted"].includes(job.status));
  }
  iMessageConfiguration(): IMessageConfiguration | undefined { return this.get<IMessageConfiguration>("imessage:configuration"); }
  setIMessageAccessDenied(denied: boolean): void {
    const key = "imessage:access-notice", current = this.get<{ id: string; origin: Origin }>(key);
    if (!denied) {
      if (!current) return;
      this.db.transaction(() => {
        for (const entry of this.outbox()) {
          if (entry.batchId === current.id && entry.status === "pending") this.record("outbox", entry.id, { ...entry, status: "cancelled" });
        }
        this.put(key, null);
      })();
    } else {
      const configuration = this.iMessageConfiguration();
      if (!configuration || current && this.canReplyTo(current.origin)) return;
      const id = "imessage:access:" + randomUUID();
      const origin: Origin = { kind: "imessage", accountId: configuration.email, peerId: configuration.phone, eventId: id,
        bindingEpoch: this.get<number>("binding-epoch:imessage") ?? 0 };
      if (!this.canReplyTo(origin)) return;
      this.db.transaction(() => {
        this.enqueueReply(id, origin, "电脑未获得完全磁盘访问权限，暂时无法读取 iMessage 消息，也无法通过此通道查看项目或会话。\n请在电脑「系统设置 → 隐私与安全 → 完全磁盘访问」中开启 Chat Bridge。开启后会自动重连；若仍未恢复，请退出并重新打开应用。无需重新配对。", "access_notice");
        this.put(key, { id, origin });
      })();
    }
    this.changed();
  }
  activateIMessage(configuration: IMessageConfiguration, cursor: string): void {
    this.db.transaction(() => {
      this.bindChannel("imessage", configuration.email, configuration.phone);
      this.put("imessage:configuration", configuration);
      this.put("cursor:" + JSON.stringify(["imessage", configuration.email]), cursor);
    })();
    this.changed();
  }
  close(): void {
    this.closed = true;
    for (const flush of this.flushText.values()) flush(false);
    for (const waiter of this.approvalWaiters.values()) { clearTimeout(waiter.timer); waiter.resolve("decline"); }
    this.approvalWaiters.clear();
    if (this.db.open) this.db.close();
  }
}
