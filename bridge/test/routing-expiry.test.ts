import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeCore, type AgentAdapter, type Origin, type TurnResult } from "../src/core.js";
import type { RouteAction } from "../src/routing.js";

const answer = (choice: string) => ({ choice, confidence: 1, probabilities: { [choice]: 1 } });
const TEN_MINUTES = 10 * 60_000;

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "bridge-expiry-"));
  let sequence = 0;
  const sends: { agent: string; text: string }[] = [];
  const adapters = Object.fromEntries(["codex", "claude"].map((agent) => [agent, {
    probe: async () => ({ ready: true, reason: "Fixture" }),
    listProjects: async () => [], listSessions: async () => [],
    createSession: async (target) => ({ nativeId: "session-" + ++sequence, projectId: target.projectId, title: "测试会话" }),
    resumeSession: async (session) => session,
    sendTurn: async (_session, text, id): Promise<TurnResult> => {
      sends.push({ agent, text });
      return { turnId: id, text: "完成", status: "completed" };
    },
  } satisfies AgentAdapter]));
  const core = new BridgeCore(join(directory, "bridge.sqlite"), adapters);
  core.bindChannel("weixin", "bot", "owner");
  core.setRoutingSettings({ mode: "auto" });
  core.routeDecision = async () => answer("continue");
  const origin = (): Origin => ({ kind: "weixin", eventId: "event-" + ++sequence, accountId: "bot", peerId: "owner" });
  async function send(text: string) { const r = core.receive(origin(), text); if (r.jobId) await core.run(r.jobId); return r; }
  const status = (id: string) => core.state().jobs.find((job) => job.id === id)?.status;
  return { core, sends, send, status,
    close() { core.close(); rmSync(directory, { recursive: true, force: true }); } };
}

// A question the user can no longer answer must not sit in the job list forever.
test("the sweeper retires a routing question once it has expired", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = fixture();
  try {
    f.core.routeDecision = async () => answer("clarify");
    const stuck = await f.send("你现在支持哪些 Agent");
    assert.equal(f.status(stuck.jobId!), "awaiting_route");

    f.core.sweepExpiredRoutes();
    assert.equal(f.status(stuck.jobId!), "awaiting_route", "still answerable before it expires");

    context.mock.timers.tick(TEN_MINUTES + 1_000);
    f.core.sweepExpiredRoutes();
    assert.equal(f.status(stuck.jobId!), "cancelled");
  } finally { f.close(); context.mock.timers.reset(); }
});

// The router kept being offered `answer_<expired job>` and picked it hours later.
test("an expired question is withdrawn from the router's candidate options", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = fixture();
  try {
    f.core.routeDecision = async () => answer("clarify");
    const stuck = await f.send("你现在支持哪些 Agent");
    assert.equal(f.status(stuck.jobId!), "awaiting_route");

    let offered: RouteAction[] = [];
    f.core.routeDecision = async (_context, actions) => { offered = actions; return answer("clarify"); };

    await f.send("当前支持什么 Agent");
    assert.ok(offered.some((action) => action.id === "answer_" + stuck.jobId),
      "while the question is open the router may treat a reply as its answer");

    context.mock.timers.tick(TEN_MINUTES + 1_000);
    await f.send("当前支持什么 Agent");
    assert.ok(!offered.some((action) => action.id.startsWith("answer_")),
      "an expired question must not be offered as something to answer");
  } finally { f.close(); context.mock.timers.reset(); }
});

// Defence in depth: even a confident model choice must not commit an expired question.
test("answering an expired question is refused instead of merging the message", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = fixture();
  try {
    f.core.routeDecision = async () => answer("clarify");
    const stuck = await f.send("你现在支持哪些 Agent");
    context.mock.timers.tick(TEN_MINUTES + 1_000);

    f.core.routeDecision = async () => answer("answer_" + stuck.jobId);
    await f.send("当前支持什么 Agent");

    assert.equal(f.core.state().jobs.find((job) => job.id === stuck.jobId)?.text, "你现在支持哪些 Agent",
      "the expired job keeps its own text rather than absorbing the new message");
    assert.deepEqual(f.sends, [], "nothing is dispatched to an agent");
  } finally { f.close(); context.mock.timers.reset(); }
});
