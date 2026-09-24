import { test } from "node:test";
import assert from "node:assert/strict";
import { agentIDs } from "../src/core.js";
import { defaultRoutingSettings, JevGateway, routeActions, routingRequestTimeoutMs, type RoutingContext } from "../src/routing.js";

function context(): RoutingContext {
  const current = { agent: "codex", mode: "code", projectId: null, sessionId: null };
  return {
    text: "你现在支持哪些 Agent?", current, defaultAgent: "codex",
    settings: { ...defaultRoutingSettings, provider: "openrouter", mode: "auto" },
    active: { codex: current }, probes: Object.fromEntries(agentIDs.map(agent => [agent, { ready: true, reason: "Fixture" }])),
    projects: [], sessions: [], history: [], tasks: [],
  };
}

function gateway(fetchFn: typeof fetch) {
  return new JevGateway({ read: async () => ({ apiKey: "fixture-key" }), write: async () => {}, remove: async () => {} }, fetchFn, Date.now, "openrouter");
}

test("routing requests get a budget sized for the catalog they carry", async () => {
  let signal: AbortSignal | undefined;
  const target = gateway(async (_url, init) => { signal = init?.signal ?? undefined; throw new DOMException("Timed out", "TimeoutError"); });
  await target.restore();
  await assert.rejects(target.choose(context(), routeActions(context())), (error: any) =>
    error.code === "ROUTER_UNAVAILABLE" && error.message === "ROUTER_UNAVAILABLE: OpenRouter 在 20 秒内没有返回路由结果；请稍后重试。");
  assert.equal(routingRequestTimeoutMs, 20_000);
  assert.ok(signal instanceof AbortSignal, "The request must still carry an abort signal");
});

test("a dropped connection is reported separately from a timeout", async () => {
  const target = gateway(async () => { throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }); });
  await target.restore();
  await assert.rejects(target.choose(context(), routeActions(context())), (error: any) =>
    error.code === "ROUTER_UNAVAILABLE" && error.message === "ROUTER_UNAVAILABLE: OpenRouter 连接失败或返回无效结果；请稍后重试。");
});
