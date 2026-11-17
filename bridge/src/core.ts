import Database from "better-sqlite3";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { commandGuide, parseInput } from "./commands.js";
import { parseIntent, type Intent } from "./intent.js";
import { splitReply, taskNotice } from "./messages.js";
import { outputProject, snapshotOutputs, type OutputAttachment } from "./outputs.js";
import { attachmentLimit, importAttachments, type InputAttachment } from "./attachments.js";
import { menuLine } from "./routing-options.js";

export const agentIDs = ["codex", "claude", "pi", "hermes"] as const;
export const agentNames: Record<string, string> = { codex: "Codex", claude: "Claude Code", pi: "Pi", hermes: "Hermes Agent" };
// Plain Unicode, so phone channels without rich rendering (iMessage) still show who is answering.
export const agentEmoji: Record<string, string> = { codex: "🤖", claude: "✳️", pi: "π", hermes: "🕊️" };
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
export type Preferences = { defaultAgent: string; pinned: string[]; keepAlive: boolean; names: Record<string, string>; enabledAgents: string[] };
export type ConnectorPolicy = { accountId: string; allowedAgents: string[]; mode: "read-only" | "confirm-writes" | "allow-writes" };
export type Job = {
  id: string; origin: Origin; target: Target; text: string; status: string; workItemId?: string;
  createdAt: string; queuedAt?: string; error?: string; sessionId?: string; turnId?: string; externalControl?: boolean;
  routeMessage?: string; receiptRevision?: number; followsJobId?: string;
  attachments?: InputAttachment[];
};
export type Receipt = { jobId?: string; message?: string };
type Selection = Target & { sessionId: string | null; creationKey: string | null; version: number; engaged: boolean };
type Creation = { key: string; target: Target; status: string; sessionId?: string };
export type WorkItem = {
  id: string; title: string; status: "open" | "running" | "waiting" | "blocked" | "done" | "cancelled";
  target: Target; sessionId?: string; jobIds: string[]; createdAt: string; updatedAt: string;
  closedAt?: string; lastJobId?: string;
};
type Focus = { workItemId: string | null; version: number };
type TaskMenu = { entries: { id: string; title: string; status: string }[]; expiresAt: number;
  focusVersion: number; bindingEpoch?: number };
type Message = { id: string; sessionId: string; role: string; text: string; createdAt: string; source?: Origin["kind"];
  replyTo?: { id: string; text: string }; attachments?: InputAttachment[]; workItemId?: string };
type ChoiceMenu = { kind: "project" | "session"; entries: { id: string; name: string }[]; offset: number;
  version: number; bindingEpoch?: number; expiresAt: number };
export type OutboxEntry = { id: string; jobId?: string; origin: Origin; text: string; status: string; kind?: string; error?: string; batchId?: string; attachment?: OutputAttachment };
export type ChannelEvent = { origin: Origin; text: string; sealedContext?: string; rejection?: string };
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
// The runtime refused to reopen a conversation (as opposed to it being busy with another writer,
// which resolves by waiting). Nothing was sent, so the task may run in a fresh conversation.
export class ResumeRejectedError extends BridgeError {
  constructor(message: string) { super("AGENT_UNAVAILABLE", message); }
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
  private agentTails = new Map<string, Promise<void>>();
  private runs = new Map<string, Promise<void>>();
  private batching = false;
  private closed = false;
  private approvalWaiters = new Map<string, { resolve(decision: "accept" | "decline"): void; timer: NodeJS.Timeout }>();
  private stopping = new Set<string>();
  private flushText = new Map<string, (deliver: boolean) => void>();
  onChange: () => void = () => {};

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
      this.put("preferences", { defaultAgent: "codex", pinned: ["codex", "claude", "pi"], keepAlive: false, names: {}, enabledAgents: [...agentIDs] });
      this.put("selection", this.fresh("codex"));
    }
    this.db.transaction(() => {
      const knownAgents = new Set<string>(agentIDs);
      const storedPreferences = this.get<Preferences>("preferences");
      if (storedPreferences) {
        const storedEnabled = Array.isArray(storedPreferences.enabledAgents) ? storedPreferences.enabledAgents : [...agentIDs];
        const hadRemovedAgent = storedEnabled.some((id) => !knownAgents.has(id));
        const enabledAgents = hadRemovedAgent ? [...agentIDs] : [...new Set(storedEnabled.filter((id) => knownAgents.has(id)))];
        if (!enabledAgents.length) enabledAgents.push(...agentIDs);
        const defaultAgent = knownAgents.has(storedPreferences.defaultAgent) ? storedPreferences.defaultAgent : enabledAgents[0]!;
        const pinned = storedPreferences.pinned.filter((id) => knownAgents.has(id));
        if (hadRemovedAgent) for (const id of ["codex", "claude", "pi"]) if (pinned.length < 3 && !pinned.includes(id)) pinned.push(id);
        if (JSON.stringify(enabledAgents) !== JSON.stringify(storedPreferences.enabledAgents) ||
            defaultAgent !== storedPreferences.defaultAgent || JSON.stringify(pinned) !== JSON.stringify(storedPreferences.pinned)) {
          this.put("preferences", { ...storedPreferences, enabledAgents, defaultAgent, pinned });
        }
      }
      const storedSelection = this.get<Selection>("selection");
      if (storedSelection && !knownAgents.has(storedSelection.agent)) {
        this.put("selection", this.fresh(storedPreferences?.defaultAgent && knownAgents.has(storedPreferences.defaultAgent)
          ? storedPreferences.defaultAgent : agentIDs[0]!));
      }
      for (const job of this.list<Job>("job")) {
        if (!knownAgents.has(job.target.agent) && !["completed", "cancelled", "failed", "interrupted"].includes(job.status)) {
          this.record("job", job.id, { ...job, status: "cancelled", error: "此任务使用的 Agent 已移除，任务未发送。" });
        }
      }
      for (const item of this.list<WorkItem>("work-item")) {
        if (!knownAgents.has(item.target.agent) && item.status !== "cancelled") {
          this.record("work-item", item.id, { ...item, status: "cancelled", closedAt: new Date().toISOString() });
        }
      }
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
      let focus = this.get<Focus>("task-focus");
      for (const job of this.list<Job>("job")) {
        if (["routing", "awaiting_route"].includes(job.status)) {
          job.status = "awaiting_confirmation";
          job.error = "升级后不再使用模型路由，请重新发送或选择目标。";
          this.record("job", job.id, job);
        }
        if (job.workItemId) continue;
        const now = new Date().toISOString();
        const item: WorkItem = { id: "K" + randomUUID().replaceAll("-", "").slice(0, 12),
          title: job.text.replaceAll(/\s+/g, " ").trim().slice(0, 60) || "历史任务",
          status: job.status === "completed" ? "done" : job.status === "cancelled" ? "cancelled" :
            ["failed", "waiting_agent", "uncertain"].includes(job.status) ? "blocked" : "running",
          target: job.target, ...(job.sessionId ? { sessionId: job.sessionId } : {}), jobIds: [job.id],
          createdAt: job.createdAt, updatedAt: now, lastJobId: job.id };
        this.record("work-item", item.id, item);
        job.workItemId = item.id;
        this.record("job", job.id, job);
        if (!focus?.workItemId) focus = { workItemId: item.id, version: (focus?.version ?? 0) + 1 };
      }
      if (focus) this.put("task-focus", focus);
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

  private focusState(): Focus {
    const stored = this.get<Focus>("task-focus") ?? { workItemId: null, version: 0 };
    if (!stored.workItemId) return stored;
    const item = this.find<WorkItem>("work-item", stored.workItemId);
    return item && item.status !== "cancelled" ? stored : { workItemId: null, version: stored.version };
  }
  private setFocus(workItemId: string | null): void {
    this.put("task-focus", { workItemId, version: this.focusState().version + 1 } satisfies Focus);
  }
  private workItem(id: string | null | undefined): WorkItem | undefined {
    return id ? this.find<WorkItem>("work-item", id) : undefined;
  }
  private activateWorkItem(item: WorkItem): void {
    this.setFocus(item.id);
    this.select({ ...item.target, sessionId: item.sessionId ?? item.target.sessionId ?? null,
      creationKey: item.sessionId ? null : item.target.creationKey ?? null });
  }
  private createWorkItem(text: string, target: Target): WorkItem {
    const now = new Date().toISOString();
    const item: WorkItem = { id: "K" + randomUUID().replaceAll("-", "").slice(0, 12),
      title: text.replaceAll(/\s+/g, " ").trim().slice(0, 60) || "新任务", status: "open",
      target: this.reserve({ ...target, sessionId: target.sessionId ?? null, creationKey: target.creationKey ?? null }),
      jobIds: [], createdAt: now, updatedAt: now };
    this.record("work-item", item.id, item);
    this.setFocus(item.id);
    return item;
  }
  private appendJob(item: WorkItem, text: string, origin: Origin, attachments: InputAttachment[] = []): Job {
    const id = "J" + randomUUID().replaceAll("-", "").slice(0, 12);
    const job: Job = { id, origin, text, status: "accepted", workItemId: item.id, createdAt: new Date().toISOString(),
      target: { ...item.target, sessionId: item.sessionId ?? item.target.sessionId ?? null,
        creationKey: item.sessionId ? null : item.target.creationKey ?? null },
      ...(attachments.length ? { attachments } : {}) };
    this.record("job", id, job);
    item.jobIds.push(id);
    item.lastJobId = id;
    item.status = "running";
    item.updatedAt = job.createdAt;
    this.record("work-item", item.id, item);
    return job;
  }
  private syncWorkItem(job: Job): void {
    const item = this.workItem(job.workItemId);
    if (!item) return;
    if (job.sessionId) item.sessionId = job.sessionId;
    item.target = { ...job.target, sessionId: item.sessionId ?? item.target.sessionId ?? null,
      creationKey: item.sessionId ? null : job.target.creationKey ?? item.target.creationKey ?? null };
    item.status = this.workItemStatus(item);
    item.updatedAt = new Date().toISOString();
    if (item.status === "done" || item.status === "cancelled") item.closedAt ??= item.updatedAt;
    else delete item.closedAt;
    this.record("work-item", item.id, item);
  }
  private workItemStatus(item: WorkItem): WorkItem["status"] {
    const jobs = item.jobIds.map((id) => this.find<Job>("job", id)).filter((job): job is Job => Boolean(job));
    if (!jobs.length) return "open";
    if (jobs.some((job) => job.status === "awaiting_approval")) return "waiting";
    if (jobs.some((job) => ["accepted", "preparing", "dispatching", "queued", "running", "stopping"].includes(job.status))) return "running";
    const latest = jobs.at(-1)!;
    if (["failed", "waiting_agent", "uncertain"].includes(latest.status)) return "blocked";
    if (jobs.every((job) => job.status === "cancelled")) return "cancelled";
    return "done";
  }
  private taskMenuKey(origin: Origin): string { return "task-menu:" + this.menuKey(origin); }
  private clearTaskMenu(origin: Origin): void {
    this.db.prepare("DELETE FROM records WHERE kind='task-menu' AND id=?").run(this.menuKey(origin));
  }
  private showTaskMenu(origin: Origin, note?: string): string {
    const items = this.list<WorkItem>("work-item").filter((item) => item.status !== "cancelled");
    if (!items.length) return (note ? note + "\n\n" : "") + "现在还没有任务。直接发消息就会开始一个。";
    const current = this.focusState().workItemId;
    const ordered = [...items].sort((a, b) => Number(b.id === current) - Number(a.id === current) ||
      b.updatedAt.localeCompare(a.updatedAt));
    const shown = ordered.slice(0, 8);
    this.record("task-menu", this.menuKey(origin), { entries: shown.map((item) => ({ id: item.id, title: item.title, status: item.status })),
      expiresAt: Date.now() + 10 * 60_000, focusVersion: this.focusState().version, bindingEpoch: origin.bindingEpoch } satisfies TaskMenu);
    const labels: Record<WorkItem["status"], string> = { open: "待开始", running: "进行中", waiting: "等待你处理",
      blocked: "受阻", done: "已完成", cancelled: "已取消" };
    return (note ? note + "\n\n" : "") + "现在有 " + items.length + " 个任务：\n" +
      shown.map((item, index) => (index + 1) + ". " + item.title + "（" + labels[item.status] + (item.id === current ? "，当前" : "") + "）").join("\n") +
      "\n\n回复编号切换；回复“新任务”开始新的。";
  }
  private answerTaskMenu(text: string, origin: Origin): string | undefined {
    if (!/^\d+$/.test(text.trim())) return;
    const menu = this.find<TaskMenu>("task-menu", this.menuKey(origin));
    if (!menu) return;
    if (menu.expiresAt <= Date.now() || menu.bindingEpoch !== origin.bindingEpoch || menu.focusVersion !== this.focusState().version) {
      this.clearTaskMenu(origin);
      return "任务列表已过期，请回复“任务”重新查看。";
    }
    const index = Number(text.trim()) - 1, entry = menu.entries[index];
    if (!Number.isSafeInteger(index) || !entry) return "请回复列表里的编号。";
    const item = this.workItem(entry.id);
    this.clearTaskMenu(origin);
    if (!item || item.status === "cancelled") return "这个任务已经不可用，请回复“任务”重新查看。";
    this.activateWorkItem(item);
    return "已切换到「" + item.title + "」。";
  }
  private handleIntent(intent: Intent, origin: Origin, original: string): Receipt {
    if (intent.kind === "task-list") return { message: this.showTaskMenu(origin) };
    if (intent.kind === "new-task") {
      this.clearTaskMenu(origin);
      this.setFocus(null);
      this.select({ ...this.selection(), sessionId: null, creationKey: null });
      if (intent.text) {
        const blocked = this.blockedAgent(origin, this.selection().agent);
        if (blocked) return { message: blocked };
        const item = this.createWorkItem(intent.text, this.selection());
        return { jobId: this.appendJob(item, intent.text, origin).id };
      }
      return { message: "好，下一条消息创建新任务。\n当前默认目标：" + this.targetName(this.selection()) + "\n直接发消息即可；想换目标可以说“换成 Claude”或“换个项目”。" };
    }
    if (intent.kind === "switch-task") {
      const query = intent.query.toLocaleLowerCase();
      const matches = this.list<WorkItem>("work-item").filter((item) => item.status !== "cancelled" &&
        (item.id.toLocaleLowerCase() === query || item.title.toLocaleLowerCase().includes(query)));
      if (matches.length === 1) {
        this.clearTaskMenu(origin);
        this.activateWorkItem(matches[0]!);
        return { message: "已切换到「" + matches[0]!.title + "」。" };
      }
      if (matches.length > 1) return { message: this.showTaskMenu(origin, "有多个任务匹配，请选择：") };
      // "继续测试这个游戏" is ordinary follow-up text, not a failed task title lookup.
      const item = this.workItem(this.focusState().workItemId) ?? this.createWorkItem(original, this.selection());
      return { jobId: this.appendJob(item, original, origin).id };
    }
    if (intent.kind === "stop" || intent.kind === "cancel") {
      const item = this.workItem(this.focusState().workItemId);
      if (!item) return { message: "当前没有任务。" };
      const active = item.jobIds.map((id) => this.find<Job>("job", id)).filter((job): job is Job => job !== undefined &&
        ["accepted", "preparing", "dispatching", "queued", "running", "awaiting_approval", "stopping"].includes(job.status));
      if (active.length !== 1) return { message: active.length ? "当前任务有多个执行轮次，请用 /stop 或 /cancel 指定任务编号。" : "当前任务没有正在执行的操作。" };
      const result = this.command(intent.kind, active[0]!.id, origin);
      return typeof result === "string" ? { message: result } : result;
    }
    if (intent.kind === "approval") {
      const focused = this.workItem(this.focusState().workItemId);
      const focusedIds = new Set(focused?.jobIds ?? []);
      const pending = this.list<Approval>("approval").filter((approval) => approval.status === "pending" &&
        (focusedIds.size ? focusedIds.has(approval.jobId) : true));
      if (pending.length !== 1) return { message: pending.length ? "当前有多个待审批操作，请用 /approve 或 /deny 指定编号。" : "当前没有待审批的操作。" };
      const result = this.command(intent.decision, pending[0]!.id, origin);
      return typeof result === "string" ? { message: result } : result;
    }
    if (intent.kind === "target-agent") {
      const result = this.command("agent", intent.agent, origin);
      return typeof result === "string" ? { message: result } : result;
    }
    if (intent.kind === "project-menu") {
      const result = this.command("project", "", origin);
      return typeof result === "string" ? { message: result } : result;
    }
    if (intent.kind === "session-menu") {
      const result = this.command("sessions", "", origin);
      return typeof result === "string" ? { message: result } : result;
    }
    return { message: "没有识别这个操作。" };
  }
  // Stores saved before the agent picker existed have no list: every agent stays enabled.
  private preferences(): Preferences {
    const stored = this.get<Preferences>("preferences")!;
    return { ...stored, enabledAgents: Array.isArray(stored.enabledAgents) && stored.enabledAgents.length ? stored.enabledAgents : [...agentIDs] };
  }
  connectorUserID(): string {
    let id = this.get<string>("connectorUserID");
    if (!id) { id = "cb_" + randomUUID().replaceAll("-", ""); this.put("connectorUserID", id); }
    return id;
  }
  connectorPolicies(): ConnectorPolicy[] { return this.list<ConnectorPolicy>("connectorPolicy"); }
  setConnectorPolicy(policy: ConnectorPolicy): void { this.record("connectorPolicy", policy.accountId, policy); this.changed(); }
  removeConnectorPolicy(accountId: string): void {
    this.db.prepare("DELETE FROM records WHERE kind=? AND id=?").run("connectorPolicy", accountId); this.changed();
  }
  private agentEnabled(agent: string): boolean { return this.preferences().enabledAgents.includes(agent); }
  // Phone channels only reach enabled agents; the Mac app may still use any agent it explicitly selects.
  private blockedAgent(origin: Pick<Origin, "kind">, agent: string): string | undefined {
    return origin.kind === "desktop" || this.agentEnabled(agent) ? undefined : this.disabledNotice(agent);
  }
  private disabledNotice(agent: string): string { return this.displayAgent(agent) + " 未在 Chat Bridge 中启用，可在设置里开启。"; }
  private guide(): string {
    const enabled = this.preferences().enabledAgents;
    return commandGuide.split("\n").filter((line) => !/^\/agent \S+ — /.test(line) || enabled.includes(line.split(" ")[1]!)).join("\n");
  }
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
      preferences: this.preferences(), probes: { ...this.probes },
      selection, projects: this.list<Project>("project"), sessions: this.list<Session>("session"), jobs: this.list<Job>("job").slice(-100).reverse(),
      workItems: this.list<WorkItem>("work-item").slice(-100).reverse(), focus: this.focusState(),
      messages: this.list<Message>("message").filter((m) => m.sessionId === selection.sessionId),
      approvals: this.list<Approval>("approval").slice(-100).reverse(),
      bindings: this.db.prepare("SELECT kind FROM bindings").all() as { kind: string }[],
    };
  }

  // Role preferences never route to a disabled agent; they fall back to the default agent instead.
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
      if (!event.rejection && parsed.kind === "command") {
        if (parsed.name === "agent" && !parsed.argument) await this.probeAgents();
        if (parsed.name === "status" && this.adapters[agent]) await this.probeAgent(agent);
        if (parsed.name === "agent" && this.adapters[parsed.argument] && !this.blockedAgent(event.origin, parsed.argument)) {
          agent = parsed.argument;
          await this.probeAgent(agent);
        }
      }
      if (!event.rejection && parsed.kind === "command" && (["projects", "sessions"].includes(parsed.name) || parsed.name === "project" && !parsed.argument) &&
          !this.blockedAgent(event.origin, agent)) {
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
        const item: Message = { ...message, id, sessionId, ...(job ? { text: job.text, attachments: job.attachments, source: job.origin.kind } : {}) };
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
    const preferences = { ...this.preferences(), ...patch };
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
    if (!Array.isArray(preferences.enabledAgents) || !preferences.enabledAgents.length ||
        new Set(preferences.enabledAgents).size !== preferences.enabledAgents.length ||
        preferences.enabledAgents.some((id) => !agentIDs.includes(id as typeof agentIDs[number]))) {
      throw new BridgeError("INVALID_INPUT", "请至少启用一个有效的 Agent，且不能重复。");
    }
    preferences.enabledAgents = agentIDs.filter((id) => preferences.enabledAgents.includes(id));
    if (!preferences.enabledAgents.includes(preferences.defaultAgent)) {
      preferences.defaultAgent = preferences.enabledAgents[0]!;
      this.executable(preferences.defaultAgent);
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
        "配置完成，已绑定此账号。\n\n" + this.guide(), "onboarding");
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
        const raw = parsed.text.trim();
        const choice = attachments.length ? undefined : this.answerProjectTrust(raw, origin) ??
          this.answerTaskMenu(raw, origin) ?? (/^\d+$/.test(raw) ? this.chooseNumber(raw, origin) : undefined);
        if (choice !== undefined) result = typeof choice === "string" ? { message: choice } : choice;
        else {
          this.clearMenu(origin);
          const outstanding = this.list<Job>("job").filter((job) => !["completed", "cancelled", "interrupted", "failed"].includes(job.status));
          const focused = this.workItem(this.focusState().workItemId);
          if (outstanding.length >= 100) {
            result = { message: "未接受：待执行任务已达到 100 个，请先处理已有任务。" };
          } else {
            const intent = attachments.length || text.startsWith("//") ? undefined : parseIntent(parsed.text);
            if (intent) result = this.handleIntent(intent, origin, parsed.text);
            else {
              const blocked = this.blockedAgent(origin, focused?.target.agent ?? this.selection().agent);
              if (blocked) result = { message: blocked };
              else {
                const item = focused ?? this.createWorkItem(parsed.text, this.selection());
                if (!focused) this.activateWorkItem(item);
                result = { jobId: this.appendJob(item, parsed.text, origin, attachments).id };
              }
            }
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
  private command(name: string, argument: string, origin: Origin): string | Receipt {
    const selected = this.selection();
    if (name === "help") return this.guide();
    if (name === "tasks") return this.showTaskMenu(origin);
    const browsing = ["new", "projects", "project", "sessions", "more"].includes(name) && this.blockedAgent(origin, selected.agent);
    if (browsing) return browsing;
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
      if (!["waiting_agent", "awaiting_confirmation"].includes(job.status)) {
        throw new BridgeError("INVALID_STATE", "此任务不处于等待继续状态。");
      }
      const blocked = this.blockedAgent(job.origin, job.target.agent);
      if (blocked && origin.kind === "desktop") throw new BridgeError("AGENT_DISABLED", blocked);
      if (blocked) return blocked;
      job.status = "accepted";
      job.queuedAt = new Date().toISOString(); delete job.error;
      this.record("job", job.id, job);
      return { jobId: job.id, message: job.id + " 已继续，保持原 Agent 和会话。" };
    }
    if (name === "status") {
      const labels: Record<string, string> = {
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
            if (["waiting_agent", "awaiting_confirmation"].includes(job.status)) actions.push("继续：/continue " + job.id);
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
    if (name === "agent" && !argument) return this.preferences().enabledAgents.map((id) => agentNames[id] + "：" + this.availabilityLabel(id) +
      (this.probes[id]?.ready === false ? "\n" + this.probes[id]!.reason : this.probes[id]?.executionError ? "\n" + this.probes[id]!.executionError : "") +
      "\n切换：/agent " + id).join("\n\n");
    if (name === "agent") {
      this.executable(argument);
      const blocked = this.blockedAgent(origin, argument);
      if (blocked) return blocked;
      this.navigationVersion++;
      this.clearMenu(origin);
      if (argument !== selected.agent) {
        this.setFocus(null);
        this.select(this.get<Target>("active:" + argument + ":code") ?? this.fresh(argument));
      }
      return "当前 Agent：" + argument;
    }
    if (name === "new" || (name === "project" && argument === "none")) {
      this.clearMenu(origin);
      const target = { ...selected, sessionId: null, creationKey: null, projectId: name === "project" ? null : selected.projectId };
      this.setFocus(null);
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
      this.clearMenu(origin);
      this.setFocus(null);
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
      const blocked = this.blockedAgent(origin, session.agent);
      if (blocked) return blocked;
      this.navigationVersion++;
      this.clearMenu(origin);
      if (selected.sessionId !== session.id || selected.agent !== session.agent || selected.mode !== session.mode || selected.projectId !== session.projectId) {
        this.setFocus(null);
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
    if (selected.agent !== agent) this.setFocus(null);
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
      if (resumed.cwd && resumed.cwd !== session.cwd) {
        const moved = { ...session, cwd: resumed.cwd };
        this.record("session", session.id, moved);
        return moved;
      }
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
    const next = Promise.resolve(this.closed ? undefined : this.find<Job>("job", jobId)).then(async (job) => {
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
    const adapter = this.adapters[job.target.agent];
    if (!adapter) {
      job.status = "cancelled"; job.error = "目标 Agent 已不可用，任务未发送。";
      this.saveWaitingJob(job); this.syncWorkItem(job); this.changed(); return;
    }
    const blocked = this.blockedAgent(job.origin, job.target.agent);
    if (blocked) {
      job.status = "cancelled"; job.error = blocked + "任务未发送。";
      this.saveWaitingJob(job); this.changed(); return;
    }
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
          if (completed && deliver && job.origin.kind !== "desktop") this.enqueueReply(message.id, job.origin, this.signed(job.target.agent, message.text), "assistant", job.id);
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
      let session: Session, replaced = "";
      const previousCwd = job.target.sessionId ? this.find<Session>("session", job.target.sessionId)?.cwd : undefined;
      try { session = await this.ensureSession(job.target); }
      catch (error) {
        // Nothing has been sent yet. When the original conversation is gone or cannot be reopened,
        // or the project folder a new one needs is gone, run the task in a fresh conversation on
        // the same agent — in the same project if it is still usable, otherwise without a project.
        const previous = job.target.sessionId;
        const missing = error instanceof BridgeError && error.code === "TARGET_MISSING";
        const reason = previous ? error instanceof ResumeRejectedError ? "原会话暂时无法打开" : missing ? "原会话已不存在" : "" :
          missing && job.target.projectId ? "原项目目录已不存在" : "";
        if (!reason || !this.probes[job.target.agent]?.ready || this.closed) throw error;
        const failedKey = job.target.creationKey;
        const start = async (projectId: string | null) => {
          job.target = this.reserve({ ...job.target, projectId, sessionId: null, creationKey: null }, true);
          const selection = this.selection();
          if (selection.agent === job.target.agent && (previous ? selection.sessionId === previous : selection.creationKey === failedKey)) {
            this.put("selection", { ...selection, projectId, sessionId: null, creationKey: job.target.creationKey ?? null, engaged: true });
          }
          this.record("job", job.id, job);
          return this.ensureSession(job.target);
        };
        let where = "无项目会话";
        if (previous && job.target.projectId) {
          try { session = await start(job.target.projectId); where = "新会话"; }
          catch (retry) { if (!(retry instanceof BridgeError && retry.code === "TARGET_MISSING") || this.closed) throw retry; session = await start(null); }
        } else session = await start(null);
        replaced = "\n" + reason + "，已改在" + where + "中执行。";
      }
      if (this.closed) return;
      if (this.find<Job>("job", job.id)?.status !== "preparing") return;
      job.sessionId = session.id; job.status = "dispatching";
      const relocated = !replaced && previousCwd && session.cwd && session.cwd !== previousCwd;
      job.routeMessage = this.targetName(job.target, session) + replaced +
        (relocated ? "\n原工作目录已不存在（可能已被移动或删除），已在原会话中继续，临时工作目录：" + session.cwd : "") + "\n已收到✅";
      this.db.transaction(() => {
        this.record("job", job.id, job);
        this.syncWorkItem(job);
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
            attachments: job.attachments, source: job.origin.kind, workItemId: job.workItemId, createdAt: new Date().toISOString() });
          this.changed();
        },
        message: update,
        approval: (request) => this.requestApproval(job.id, request),
      });
      if (this.closed) return;
      if (!result.turnId || typeof result.text !== "string") throw new BridgeError("SEND_UNCERTAIN", "未收到有效的原生完成结果。");
      if (!result.status || result.status === "completed") session = await this.collectOutputs(job, session, result.text);
      if (this.closed) return;
      this.syncWorkItem(job);
      finishText();
      this.db.transaction(() => {
        job.status = result.status ?? "completed"; job.turnId = result.turnId;
        if (job.status === "failed") job.error = "Agent 执行失败；未自动重试。";
        if (job.status === "interrupted") job.error = "运行时已确认任务停止。";
        this.record("job", job.id, job);
        this.expireApprovals(job.id);
        for (const [role, text] of [["user", job.text], ...(messages.size ? [] : [["assistant", result.text]])]) {
          const id = job.id + ":" + role;
          this.record("message", id, { id, sessionId: session.id, role, text, createdAt: new Date().toISOString(), workItemId: job.workItemId,
            ...(role === "user" ? { attachments: job.attachments, source: job.origin.kind } : { replyTo: this.quote(job.id + ":user", job.text) }) });
        }
        if (!messages.size) this.enqueueReply(job.id, job.origin, this.signed(job.target.agent, (job.error ? job.id + " · " + job.error + "\n" : "") + result.text), "final", job.id);
        else if (job.error && job.origin.kind !== "desktop") this.enqueueReply(job.id + ":status", job.origin, job.error, "status", job.id);
        this.syncWorkItem(job);
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
      this.syncWorkItem(job);
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
              if (queued.status === "accepted" && matches(queued.target)) {
                queued.target = update(queued.target);
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
  enqueueAttachment(id: string, origin: Origin, attachment: OutputAttachment, jobId: string): void {
    if (this.find("outbox", id)) return;
    this.record("outbox", id, { id, jobId, origin, attachment, text: "附件：" + attachment.name, kind: "attachment", batchId: id, status: "pending" });
  }
  private saveWaitingJob(job: Job): void {
    this.db.transaction(() => {
      this.record("job", job.id, job);
      this.syncWorkItem(job);
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
    if (kind !== "weixin" || !account || typeof cursor !== "string") {
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
        if (job.origin.kind === kind && ["accepted", "preparing", "waiting_agent", "awaiting_confirmation"].includes(job.status)) {
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
    return this.list<Job>("job").filter((job) => job.status === "accepted");
  }
  close(): void {
    this.closed = true;
    for (const flush of this.flushText.values()) flush(false);
    for (const waiter of this.approvalWaiters.values()) { clearTimeout(waiter.timer); waiter.resolve("decline"); }
    this.approvalWaiters.clear();
    if (this.db.open) this.db.close();
  }
}
