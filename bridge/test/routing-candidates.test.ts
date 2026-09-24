import { test } from "node:test";
import assert from "node:assert/strict";
import { agentIDs } from "../src/core.js";
import { defaultRoutingSettings, routeActions, type RoutingContext } from "../src/routing.js";

const current = { agent: "codex", mode: "code", projectId: "project-0", sessionId: "session-0" };
function context(text: string, sessions: RoutingContext["sessions"] = []): RoutingContext {
  return { text, current, defaultAgent: "codex",
    settings: { ...defaultRoutingSettings, provider: "openrouter", mode: "auto" },
    active: { codex: current },
    probes: Object.fromEntries(agentIDs.map(agent => [agent, { ready: true, reason: "Fixture" }])),
    projects: [], sessions, history: [], tasks: [] };
}

// Chinese titles have no delimiters, so the old word split left one token that never matched and
// the forty-session cut fell back to timestamp order.
test("a Chinese session title is ranked by what the message actually mentions", () => {
  const sessions = Array.from({ length: 60 }, (_, index) => ({
    id: "session-" + index, nativeId: "native-" + index, shortId: "S" + index,
    agent: "codex", mode: "code", projectId: null,
    title: index === 59 ? "余烬远征战斗原型" : "无关会话" + index,
    updatedAt: 1_790_000_000 + index * -1,
  }));
  const ids = routeActions(context("继续余烬远征的战斗原型", sessions)).map((action) => action.id);
  assert.ok(ids.includes("select_S59"), "the session the message names survives the cap");
});

test("the current agent does not get a second copy of the same lookup", () => {
  const ids = routeActions(context("随便问点什么")).map((action) => action.id);
  const duplicated = ids.filter((id) => id === "list_projects_codex" || id === "list_sessions_codex");
  assert.deepEqual(duplicated, [], "codex is already covered by list_projects / list_sessions");
  assert.ok(ids.includes("list_projects") && ids.includes("list_sessions"));
  assert.ok(ids.includes("list_projects_claude"), "other agents still get their own lookup");
});

test("disabled agents are never candidates, not even to continue the current conversation", () => {
  const sessions = ["codex", "claude"].map((agent, index) => ({ id: "session-" + agent, nativeId: "native-" + agent, shortId: "S" + index,
    agent, mode: "code", projectId: null, title: agent + " 会话" }));
  const projects = [{ id: "shop", name: "商城", roots: [], agent: "cursor", shortId: "P1" }];
  const targets = (actions: ReturnType<typeof routeActions>) =>
    [...new Set(actions.flatMap((action) => [action.target?.agent, action.scope?.agent]).filter(Boolean))].sort();
  const enabled = routeActions({ ...context("继续", sessions), projects, enabledAgents: ["codex", "grok"] });
  assert.deepEqual(targets(enabled), ["codex", "grok"]);
  assert.ok(enabled.some((action) => action.id === "continue"));
  const disabled = routeActions({ ...context("继续", sessions), projects, enabledAgents: ["claude"] });
  assert.deepEqual(targets(disabled), ["claude"]);
  assert.equal(disabled.some((action) => action.id === "continue" || action.id === "list_projects"), false);
});

test("every candidate id is unique", () => {
  const sessions = Array.from({ length: 30 }, (_, index) => ({
    id: "session-" + index, nativeId: "native-" + index, shortId: "S" + index,
    agent: "codex", mode: "code", projectId: null, title: "会话" + index, updatedAt: 1_790_000_000 + index,
  }));
  const ids = routeActions(context("继续", sessions)).map((action) => action.id);
  assert.equal(new Set(ids).size, ids.length);
});
