import type { Readable, Writable } from "node:stream";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { agentIDs, BridgeCore, BridgeError, type AgentAdapter, type Preferences } from "./core.js";
import { RPCPeer, RPCError, type Handler } from "./rpc.js";
import { ChannelController } from "./channels.js";
import { CodexRuntime } from "./codex.js";
import { ClaudeRuntime } from "./claude.js";
import { ACPRuntime, acpAgentIDs } from "./acp.js";
import { PiRuntime, locatePi } from "./pi.js";
import { ComposioConnectorController } from "./connectors.js";

export function createService(input: Readable, output: Writable, databasePath: string,
  dependencies: { fetchFn?: typeof fetch; codex?: AgentAdapter; claude?: AgentAdapter; pi?: AgentAdapter;
    agents?: Partial<Record<typeof acpAgentIDs[number], AgentAdapter>> } = {}) {
  const handlers: Record<string, Handler> = {};
  const peer = new RPCPeer(input, output, handlers);
  // Projectless conversations live where each agent puts its own, not inside Chat Bridge.
  const codex = dependencies.codex ?? new CodexRuntime({
    workspace: join(dirname(databasePath), "Workspaces", "Default"),
    projectlessRoot: join(homedir(), "Documents", "Codex"),
    locate: () => peer.call("native.agent.probe", { agent: "codex" }),
    onAvailability: () => { if (!closed) core.invalidateAgent("codex"); },
  });
  const claude = dependencies.claude ?? new ClaudeRuntime({
    workspace: join(dirname(databasePath), "Workspaces", "Claude"),
    projectlessRoot: homedir(),
    locate: () => peer.call("native.agent.probe", { agent: "claude" }),
  });
  const pi = dependencies.pi ?? new PiRuntime({
    workspace: join(dirname(databasePath), "Workspaces", "Pi"),
    projectlessRoot: homedir(),
    locate: locatePi,
    onAvailability: () => { if (!closed) core.invalidateAgent("pi"); },
    onExecution: (error) => { if (!closed) core.recordAgentExecution("pi", error); },
  });
  const agents: Record<string, AgentAdapter> = { codex, claude, pi };
  for (const id of acpAgentIDs) agents[id] = dependencies.agents?.[id] ?? new ACPRuntime({ id,
    workspace: join(dirname(databasePath), "Workspaces", id),
    locate: () => peer.call("native.agent.probe", { agent: id }),
    onAvailability: () => { if (!closed) core.invalidateAgent(id); },
    onExecution: (error) => { if (!closed) core.recordAgentExecution(id, error); },
  });
  const core = new BridgeCore(databasePath, agents);
  const connectors = new ComposioConnectorController({
    read: () => peer.call("native.composio.credential.read", {}),
    write: async (credential) => { await peer.call("native.composio.credential.write", { credential }); },
    remove: async () => { await peer.call("native.composio.credential.remove", {}); },
  }, {
    userID: () => core.connectorUserID(), policies: () => core.connectorPolicies(),
    setPolicy: (policy) => core.setConnectorPolicy(policy), removePolicy: (accountId) => core.removeConnectorPolicy(accountId),
  }, dependencies.fetchFn, () => { if (!closed) peer.event("state.changed", snapshot()); });
  const channels = new ChannelController(core, {
    read: () => peer.call("native.weixin.credential.read", {}),
    write: async (credential) => { await peer.call("native.weixin.credential.write", { credential }); },
    remove: async () => { await peer.call("native.weixin.credential.remove", {}); },
  }, () => peer.event("state.changed", snapshot()), dependencies.fetchFn);
  let closed = false, started = false, timer: ReturnType<typeof setTimeout> | undefined;
  let probeTimer: ReturnType<typeof setInterval> | undefined;
  const running = new Set<string>();
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || Array.isArray(value) || typeof value !== "object") throw new BridgeError("INVALID_INPUT", "需要有效的参数对象。");
    return value as Record<string, unknown>;
  };
  const text = (value: unknown, max = 256 * 1024): string => {
    if (typeof value !== "string" || !value || Buffer.byteLength(value) > max) throw new BridgeError("INVALID_INPUT", "参数内容无效或过长。");
    return value;
  };
  function snapshot() {
    const state = core.state();
    const selected = state.sessions.find((session) => session.id === state.selection.sessionId);
    const sessions = state.sessions.filter((session) => session.id !== selected?.id).slice(-99);
    if (selected) sessions.push(selected);
    const snapshot = { ...state, connectors: connectors.summary(),
      historyPartial: true, channels: { weixin: channels.state },
      deliveries: core.outbox().filter((entry) => entry.origin.kind !== "desktop").slice(-100).reverse()
        .map(({ id, jobId, status, kind, error }) => ({ id, jobId, status, kind, error })),
      sessions: sessions.map((session) => ({ ...session, title: session.title.slice(0, 128) })),
      approvals: state.approvals.filter((approval) => approval.status === "pending").slice(0, 4),
      jobs: state.jobs.slice(0, 100).map(({ attachments, ...job }) => ({ ...job, text: job.text.slice(0, 1000) })),
      messages: [] as Array<(typeof state.messages)[number] & { truncated: boolean }>,
    };
    // Prioritize recent text while staying within the native IPC's 1 MiB frame limit.
    let budget = Math.min(512 * 1024, 900 * 1024 - Buffer.byteLength(JSON.stringify(snapshot)));
    for (const message of state.messages.slice(-50).reverse()) {
      if (budget < 256) break;
      let length = Math.min(message.text.length, 32_000);
      const summary = (size: number) => ({ ...message, text: message.text.slice(0, size).replace(/[\uD800-\uDBFF]$/, ""), truncated: size < message.text.length });
      if (Buffer.byteLength(JSON.stringify(summary(length))) > budget) {
        let low = 0, high = length;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (Buffer.byteLength(JSON.stringify(summary(middle))) <= budget) low = middle;
          else high = middle - 1;
        }
        length = low;
      }
      if (!length && message.text) break;
      const item = summary(length);
      budget -= Buffer.byteLength(JSON.stringify(item)); snapshot.messages.push(item);
    }
    snapshot.messages.reverse();
    return snapshot;
  }
  function register(method: string, handler: Handler) {
    handlers[method] = async (params) => {
      try { return await handler(params); }
      catch (error) {
        if (error instanceof BridgeError) throw new RPCError(error.code, error.message);
        throw error;
      }
    };
  }
  register("state.get", snapshot);
  register("connector.provider.get", async () => { await connectors.restore(); return connectors.status(); });
  register("connector.provider.key.save", (params) => connectors.save(object(params).apiKey));
  register("connector.provider.key.remove", () => connectors.remove());
  register("connector.catalog.list", (params) => connectors.catalog(object(params)));
  register("connector.accounts.list", async () => { await connectors.restore(); return connectors.listAccounts(); });
  register("connector.account.link", (params) => {
    const request = object(params); return connectors.link(request.connectorSlug, request.callbackURL);
  });
  register("connector.account.complete", () => connectors.complete());
  register("connector.account.disconnect", async (params) => {
    const request = object(params); await connectors.disconnect(request.accountId, request.revoke === true); return snapshot();
  });
  register("connector.policy.update", (params) => connectors.updatePolicy(params));
  register("catalog.get", async (params) => {
    const request = object(params), agent = text(request.agent, 36), offset = request.offset ?? 0;
    if (!agentIDs.includes(agent as typeof agentIDs[number]) || !Number.isSafeInteger(offset) || (offset as number) < 0 ||
        request.query !== undefined && (typeof request.query !== "string" || request.query.length > 100) ||
        request.projectId !== undefined && request.projectId !== null && typeof request.projectId !== "string") {
      throw new BridgeError("INVALID_INPUT", "无效的会话列表参数。");
    }
    if (request.refresh === true) await core.refreshCatalog(agent);
    const catalog = core.catalog(agent, request.projectId as string | null | undefined, request.query as string | undefined, offset as number);
    return { ...catalog, sessions: catalog.sessions.map((session) => ({ ...session, title: session.title.slice(0, 128) })) };
  });
  register("preferences.update", (params) => {
    const patch = object(params);
    if (Object.keys(patch).some((key) => !["defaultAgent", "pinned", "keepAlive", "names", "enabledAgents"].includes(key))) {
      throw new BridgeError("INVALID_INPUT", "存在不支持的配置项。");
    }
    core.setPreferences(patch as Partial<Preferences>);
    return snapshot();
  });
  register("agent.open", async (params) => { await core.openAgent(text(object(params).agent, 36)); return snapshot(); });
  register("agent.probe", (params) => {
    const agent = text(object(params).agent, 36);
    return core.probeAgent(agent);
  });
  register("attachments.import", (params) => core.importAttachments(object(params).paths));
  register("message.send", async (params) => {
    const request = object(params);
    if (!Number.isSafeInteger(request.selectionVersion)) throw new BridgeError("INVALID_INPUT", "缺少当前会话版本，请刷新后重试。");
    const origin = { kind: "desktop" as const, accountId: "local", peerId: "local", eventId: text(request.eventId, 64) };
    const attachments = core.attachments(request.attachmentIds);
    const input = attachments.length && typeof request.text === "string" && !request.text.trim() ?
      "附件：" + attachments.map(file => file.name).join("、") : text(request.text);
    if (request.selectionVersion !== core.state().selection.version) throw new BridgeError("STALE_TARGET", "当前目标已在其他入口改变。草稿已保留，请确认目标后再发送。");
    const [event] = attachments.length ? [] : await core.prepareEvents([{ origin, text: input }]);
    if (request.selectionVersion !== core.state().selection.version) {
      throw new BridgeError("STALE_TARGET", "当前目标已在其他入口改变。草稿已保留，请确认目标后再发送。");
    }
    const receipt = core.receive(origin, input, event?.rejection, attachments);
    if (receipt.jobId) launchJob(receipt.jobId);
    return receipt;
  });
  register("task.action", (params) => {
    const request = object(params), jobId = text(request.jobId, 64);
    if (!["continue", "cancel", "stop"].includes(String(request.action)) || !/^J[a-f0-9]{12}$/.test(jobId)) {
      throw new BridgeError("INVALID_INPUT", "任务操作无效。");
    }
    const receipt = core.receive({ kind: "desktop", accountId: "local", peerId: "local", eventId: text(request.eventId, 64) },
      "/" + request.action + " " + jobId);
    if (receipt.jobId) launchJob(receipt.jobId);
    return snapshot();
  });
  register("approval.action", (params) => {
    const request = object(params), approvalId = text(request.approvalId, 64);
    if (!["approve", "deny"].includes(String(request.action)) || !/^A[a-f0-9]{12}$/.test(approvalId)) {
      throw new BridgeError("INVALID_INPUT", "仅支持单次允许或拒绝有效审批。");
    }
    core.receive({ kind: "desktop", accountId: "local", peerId: "local", eventId: text(request.eventId, 64) },
      "/" + request.action + " " + approvalId);
    return snapshot();
  });
  register("channel.weixin.start", async () => { await channels.startLogin(); return snapshot(); });
  register("channel.weixin.cancel", async () => { await channels.cancelLogin(); return snapshot(); });
  register("channel.weixin.confirm", async (params) => { await channels.confirm(text(object(params).attemptId, 64)); return snapshot(); });
  register("channel.weixin.verify", async (params) => { await channels.verify(text(object(params).code, 16)); return snapshot(); });
  register("channel.weixin.reconnect", async () => { await channels.restore(); return snapshot(); });
  register("channel.weixin.disconnect", async () => { await channels.disconnect(); return snapshot(); });
  let historySelection: number | undefined;
  core.onChange = () => {
    if (closed) return;
    peer.event("state.changed", snapshot());
    const selection = core.state().selection;
    if (historySelection !== selection.version) {
      historySelection = selection.version;
      if (selection.sessionId) void core.loadHistory(selection.sessionId).catch(() => {
        if (!closed && core.state().selection.sessionId === selection.sessionId) peer.event("history.unavailable", {});
      });
    }
    void channels.flush().catch(() => { if (!closed) peer.event("service.error", {}); });
    if (started) runPending();
  };
  function launchJob(id: string) {
    if (closed || running.has(id)) return;
    running.add(id);
    void core.run(id).catch(() => { if (!closed) peer.event("service.error", {}); }).finally(() => running.delete(id));
  }
  function runPending() { for (const job of core.pendingJobs()) launchJob(job.id); }
  async function tick() {
    if (closed) return;
    await channels.tick();
    if (closed) return;
    runPending();
    timer = setTimeout(() => { void tick().catch(() => { if (!closed) peer.close(); }); }, 1000);
  }
  return { peer, core,
    start() {
      if (started || closed) return;
      started = true;
      void connectors.restore();
      void core.probeAgents();
      probeTimer = setInterval(() => { void core.probeAgents(); }, 30_000);
      runPending();
      void channels.restore().then(tick).catch(() => { if (!closed) peer.close(); });
    },
    close() { closed = true; clearTimeout(timer); clearInterval(probeTimer); channels.close(); core.close(); for (const agent of Object.values(agents)) agent.close?.(); peer.close(); }
  };
}
