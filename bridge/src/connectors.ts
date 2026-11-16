import { randomUUID } from "node:crypto";
import { BridgeError, agentIDs, type ConnectorPolicy } from "./core.js";

export type ConnectorCredential = { apiKey: string };
export type ConnectorCredentialStore = {
  read(): Promise<ConnectorCredential | null>;
  write(value: ConnectorCredential): Promise<void>;
  remove(): Promise<void>;
};
export type ConnectorDefinition = {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  authSchemes: string[];
};
export type ConnectedConnectorAccount = {
  id: string;
  connectorId: string;
  connectorSlug: string;
  connectorName: string;
  label?: string;
  status: "connecting" | "active" | "expired" | "revoked" | "error";
  createdAt?: string;
  lastUsedAt?: string;
  policy: ConnectorPolicy;
};
export type ConnectorProviderSummary = {
  configured: boolean;
  status: "unconfigured" | "ready" | "error";
  message?: string;
};
export type ConnectorStateSummary = {
  provider: ConnectorProviderSummary;
  connectedCount: number;
  attentionCount: number;
  availableByAgent: Record<string, number>;
  toolExecutionEnabled: boolean;
};

type JSONObject = Record<string, unknown>;
type FetchLike = typeof fetch;
type ConnectorPolicyStore = {
  userID(): string;
  policies(): ConnectorPolicy[];
  setPolicy(policy: ConnectorPolicy): void;
  removePolicy(accountId: string): void;
};

const endpoint = "https://backend.composio.dev/api/v3";
const object = (value: unknown): JSONObject => value && typeof value === "object" && !Array.isArray(value) ? value as JSONObject : {};
const string = (...values: unknown[]): string | undefined => values.find((value): value is string => typeof value === "string" && !!value.trim())?.trim();
const rows = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value;
  const root = object(value);
  for (const key of ["items", "data", "toolkits", "auth_configs", "connected_accounts"]) {
    if (Array.isArray(root[key])) return root[key] as unknown[];
  }
  return [];
};
const nextCursor = (value: unknown): string | undefined => string(object(value).next_cursor, object(value).nextCursor);

function normalizeToolkit(value: unknown): ConnectorDefinition | undefined {
  const item = object(value), meta = object(item.meta), auth = item.auth_schemes ?? item.authSchemes;
  const slug = string(item.slug, item.id, item.name)?.toLowerCase();
  const name = string(item.name, meta.display_name, meta.displayName, slug);
  if (!slug || !name) return;
  return { id: slug, slug, name, description: string(item.description, meta.description) ?? "连接此服务，让 Agent 在授权范围内使用相关工具。",
    category: string(item.category, meta.category) ?? "其他",
    authSchemes: Array.isArray(auth) ? auth.filter((entry): entry is string => typeof entry === "string") : [] };
}

function normalizeStatus(value: unknown): ConnectedConnectorAccount["status"] {
  switch (String(value ?? "").toUpperCase()) {
    case "ACTIVE": case "CONNECTED": return "active";
    case "INITIALIZING": case "INITIATED": case "CONNECTING": case "PENDING": return "connecting";
    case "EXPIRED": return "expired";
    case "REVOKED": case "DISABLED": return "revoked";
    default: return "error";
  }
}

export class ComposioConnectorController {
  private apiKey?: string;
  private provider: ConnectorProviderSummary = { configured: false, status: "unconfigured" };
  private accounts: ConnectedConnectorAccount[] = [];
  private restored = false;
  constructor(private credentials: ConnectorCredentialStore, private store: ConnectorPolicyStore,
    private fetchFn: FetchLike = fetch, private changed: () => void = () => {}) {}

  summary(): ConnectorStateSummary {
    const availableByAgent = Object.fromEntries(agentIDs.map((agent) => [agent,
      this.accounts.filter((account) => account.status === "active" && account.policy.allowedAgents.includes(agent)).length]));
    return { provider: this.provider, connectedCount: this.accounts.filter((account) => account.status === "active").length,
      attentionCount: this.accounts.filter((account) => !["active", "connecting"].includes(account.status)).length,
      availableByAgent, toolExecutionEnabled: false };
  }

  async restore(): Promise<void> {
    if (this.restored) return;
    this.restored = true;
    try {
      const credential = await this.credentials.read();
      if (!credential?.apiKey) return;
      this.apiKey = credential.apiKey;
      this.provider = { configured: true, status: "ready" };
    } catch {
      this.apiKey = undefined;
      this.provider = { configured: false, status: "error", message: "无法读取连接器凭据，请重新设置。" };
      this.changed(); return;
    }
    try { await this.listAccounts(); }
    catch {
      // Keep a successfully restored Key. A temporary catalog/account outage is recoverable and
      // must not force the person to paste the credential again.
      this.provider = { configured: true, status: "error", message: "连接器服务暂时不可用，请稍后刷新。" };
      this.changed();
    }
  }

  async save(apiKey: unknown): Promise<ConnectorProviderSummary> {
    if (typeof apiKey !== "string" || !apiKey || apiKey.length > 4096 || !/^[!-~]+$/.test(apiKey)) {
      throw new BridgeError("INVALID_INPUT", "请输入有效的 Composio API Key。");
    }
    await this.request("/toolkits?limit=1", { apiKey });
    await this.credentials.write({ apiKey });
    this.apiKey = apiKey;
    this.restored = true;
    this.provider = { configured: true, status: "ready" };
    try { await this.listAccounts(); }
    catch { this.provider = { configured: true, status: "error", message: "API Key 已保存，但暂时无法读取连接账号。" }; }
    this.changed();
    return this.provider;
  }

  async remove(): Promise<ConnectorProviderSummary> {
    await this.credentials.remove();
    this.apiKey = undefined;
    this.accounts = [];
    this.restored = true;
    this.provider = { configured: false, status: "unconfigured" };
    this.changed();
    return this.provider;
  }

  status(): ConnectorProviderSummary { return this.provider; }

  async catalog(input: { search?: unknown; cursor?: unknown; limit?: unknown }): Promise<{ items: ConnectorDefinition[]; nextCursor?: string }> {
    const key = await this.key();
    const search = input.search === undefined ? "" : typeof input.search === "string" && input.search.length <= 100 ? input.search : undefined;
    const cursor = input.cursor === undefined || input.cursor === null ? undefined : typeof input.cursor === "string" && input.cursor.length <= 512 ? input.cursor : undefined;
    const limit = input.limit === undefined ? 50 : Number.isSafeInteger(input.limit) && Number(input.limit) > 0 && Number(input.limit) <= 100 ? Number(input.limit) : undefined;
    if (search === undefined || cursor === undefined && input.cursor !== undefined && input.cursor !== null || limit === undefined) {
      throw new BridgeError("INVALID_INPUT", "连接器目录参数无效。");
    }
    const query = new URLSearchParams({ limit: String(limit) });
    if (search) query.set("search", search);
    if (cursor) query.set("cursor", cursor);
    const response = await this.request("/toolkits?" + query, { apiKey: key });
    return { items: rows(response).map(normalizeToolkit).filter((item): item is ConnectorDefinition => !!item),
      ...(nextCursor(response) ? { nextCursor: nextCursor(response) } : {}) };
  }

  async listAccounts(): Promise<ConnectedConnectorAccount[]> {
    const key = await this.key();
    const query = new URLSearchParams({ user_ids: this.store.userID(), limit: "100" });
    const all: unknown[] = [], seen = new Set<string>();
    let cursor: string | undefined;
    do {
      if (cursor) query.set("cursor", cursor);
      const response = await this.request("/connected_accounts?" + query, { apiKey: key });
      all.push(...rows(response));
      cursor = nextCursor(response);
      if (cursor && (seen.has(cursor) || seen.size >= 100)) throw new BridgeError("CONNECTOR_SERVICE", "账号列表分页异常，请稍后重试。");
      if (cursor) seen.add(cursor);
    } while (cursor);
    const policies = new Map(this.store.policies().map((policy) => [policy.accountId, policy]));
    this.accounts = all.flatMap((value): ConnectedConnectorAccount[] => {
      const item = object(value), toolkit = object(item.toolkit), id = string(item.id, item.nanoid);
      const slug = string(item.toolkit_slug, item.toolkitSlug, toolkit.slug)?.toLowerCase();
      if (!id || !slug) return [];
      const policy = policies.get(id) ?? { accountId: id, allowedAgents: [], mode: "confirm-writes" as const };
      return [{ id, connectorId: slug, connectorSlug: slug, connectorName: string(toolkit.name, item.toolkit_name, item.toolkitName, slug)!,
        ...(string(item.label, item.account_name, item.accountName, object(item.connection_data).email) ?
          { label: string(item.label, item.account_name, item.accountName, object(item.connection_data).email) } : {}),
        status: normalizeStatus(item.status), ...(string(item.created_at, item.createdAt) ? { createdAt: string(item.created_at, item.createdAt) } : {}),
        ...(string(item.last_used_at, item.lastUsedAt) ? { lastUsedAt: string(item.last_used_at, item.lastUsedAt) } : {}), policy }];
    });
    this.provider = { configured: true, status: "ready" };
    this.changed();
    return this.accounts;
  }

  async link(connectorSlug: unknown, callbackURL: unknown): Promise<{ attemptId: string; redirectURL: string; expiresAt: string }> {
    const key = await this.key();
    if (typeof connectorSlug !== "string" || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(connectorSlug)) {
      throw new BridgeError("INVALID_INPUT", "连接器标识无效。");
    }
    if (callbackURL !== "chatbridge-connectors://complete") throw new BridgeError("INVALID_INPUT", "认证回调地址无效。");
    const configs = await this.request("/auth_configs?" + new URLSearchParams({ toolkit_slug: connectorSlug, limit: "100" }), { apiKey: key });
    const availableConfigs = rows(configs).filter((entry) => object(entry).is_disabled !== true && object(entry).isDisabled !== true)
      .map((entry) => string(object(entry).id, object(entry).nanoid)).filter((id): id is string => !!id);
    if (availableConfigs.length > 1 || nextCursor(configs)) {
      throw new BridgeError("CONNECTOR_CONFIG_AMBIGUOUS", "此服务有多个认证配置，请先在 Composio 控制台保留一个可用配置，再重试。");
    }
    let authConfigId = availableConfigs[0];
    if (!authConfigId) {
      const created = await this.request("/auth_configs", { apiKey: key, method: "POST", body: {
        toolkit: { slug: connectorSlug }, auth_config: { type: "use_composio_managed_auth", name: "Chat Bridge · " + connectorSlug }
      } });
      authConfigId = string(object(created).id, object(created).nanoid, object(object(created).auth_config).id);
    }
    if (!authConfigId) throw new BridgeError("CONNECTOR_UNAVAILABLE", "此连接器没有可用的认证配置。");
    const linked = await this.request("/connected_accounts/link", { apiKey: key, method: "POST", body: {
      auth_config_id: authConfigId, user_id: this.store.userID(), callback_url: callbackURL
    } });
    const redirectURL = string(object(linked).redirect_url, object(linked).redirectUrl);
    let parsed: URL;
    try { parsed = new URL(redirectURL ?? ""); }
    catch { throw new BridgeError("CONNECTOR_UNAVAILABLE", "连接服务未返回有效的认证地址。"); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) {
      throw new BridgeError("CONNECTOR_UNAVAILABLE", "连接服务未返回安全的认证地址。");
    }
    return { attemptId: string(object(linked).id, object(linked).connected_account_id, object(linked).connectedAccountId) ?? randomUUID(),
      redirectURL: parsed.href, expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() };
  }

  async complete(): Promise<ConnectedConnectorAccount[]> { return this.listAccounts(); }

  async disconnect(accountId: unknown, revoke = false): Promise<void> {
    const key = await this.key();
    if (typeof accountId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(accountId)) throw new BridgeError("INVALID_INPUT", "连接账号无效。");
    await this.request("/connected_accounts/" + encodeURIComponent(accountId) + (revoke ? "?revoke_on_delete=true" : ""), { apiKey: key, method: "DELETE" });
    this.store.removePolicy(accountId);
    this.accounts = this.accounts.filter((account) => account.id !== accountId);
    this.changed();
  }

  updatePolicy(value: unknown): ConnectorPolicy {
    const input = object(value), accountId = string(input.accountId);
    const allowedAgents = Array.isArray(input.allowedAgents) ? input.allowedAgents.filter((agent): agent is string => typeof agent === "string") : [];
    const mode = input.mode;
    if (!accountId || !this.accounts.some((account) => account.id === accountId) || allowedAgents.some((agent) => !agentIDs.includes(agent as typeof agentIDs[number])) ||
        !["read-only", "confirm-writes", "allow-writes"].includes(String(mode))) {
      throw new BridgeError("INVALID_INPUT", "连接器访问策略无效。");
    }
    const policy: ConnectorPolicy = { accountId, allowedAgents: [...new Set(allowedAgents)], mode: mode as ConnectorPolicy["mode"] };
    this.store.setPolicy(policy);
    const account = this.accounts.find((entry) => entry.id === accountId);
    if (account) account.policy = policy;
    this.changed();
    return policy;
  }

  private async key(): Promise<string> {
    if (!this.restored) await this.restore();
    if (!this.apiKey) throw new BridgeError("CONNECTOR_NOT_CONFIGURED", "请先设置 Composio API Key。");
    return this.apiKey;
  }

  private async request(path: string, options: { apiKey: string; method?: string; body?: unknown }): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchFn(endpoint + path, { method: options.method ?? "GET", headers: {
        "x-api-key": options.apiKey, "accept": "application/json", ...(options.body ? { "content-type": "application/json" } : {})
      }, redirect: "error", signal: AbortSignal.timeout(12_000), ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
    } catch { throw new BridgeError("CONNECTOR_NETWORK", "无法连接 Composio，请检查网络后重试。"); }
    const payload = await response.json().catch(() => ({})) as unknown;
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new BridgeError("CONNECTOR_AUTH", "Composio API Key 无效或权限不足。");
      if (response.status === 429) throw new BridgeError("CONNECTOR_RATE_LIMIT", "连接器服务请求过多，请稍后重试。");
      throw new BridgeError("CONNECTOR_SERVICE", "连接器服务拒绝请求或此认证方式需要在 Composio 控制台配置，请检查服务设置后重试。");
    }
    return payload;
  }
}
