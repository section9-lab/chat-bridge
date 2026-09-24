import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RPCPeer } from "../src/rpc.js";
import { createService } from "../src/service.js";
import { agentIDs, type AgentAdapter } from "../src/core.js";
import { routingProviders } from "../src/routing.js";
import Database from "better-sqlite3";

const providers = ["vercel", "openrouter", "typesafe"];
const endpoints = {
  vercel: "https://ai-gateway.vercel.sh/typesafe/v1/systemone",
  openrouter: "https://openrouter.ai/api/alpha/decisions",
  typesafe: "https://api.typesafe.ai/v1/systemone",
};
const models = { vercel: "typesafe-ai/jev", openrouter: "typesafe/jev-1.13", typesafe: "jev-1.13.0" };
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "bridge-routing-providers-"));
  const ab = new PassThrough(), ba = new PassThrough(), secrets: Record<string, any> = {};
  const requests: { provider: string; body: any }[] = [], sends: any[] = [];
  let now = Date.parse("2026-09-20T00:00:00+08:00"), release: Promise<void> | undefined;
  let pick = (_provider: string, options: { id: string; label: string }[]) => options.find((item) => item.id === "continue")?.id ?? options[0]!.id;
  let transform = (answer: any) => answer;
  const handlers = Object.fromEntries(providers.flatMap((provider) => [
    ["native." + provider + ".credential.read", () => secrets[provider] ?? null],
    ["native." + provider + ".credential.write", (value: any) => { secrets[provider] = value.credential; return null; }],
    ["native." + provider + ".credential.remove", () => { delete secrets[provider]; return null; }],
  ]));
  const native = new RPCPeer(ba, ab, handlers);
  const adapters = Object.fromEntries(agentIDs.map((agent) => [agent, {
    probe: async () => ({ ready: true, reason: "Fixture" }),
    listProjects: async () => Array.from({ length: 10 }, (_, index) => ({ id: agent + "-project-" + index, name: "项目" + index, roots: [] })),
    listSessions: async () => [{ nativeId: agent + "-existing", title: "当前任务", projectId: null }],
    createSession: async (target: any) => ({ nativeId: agent + "-new", title: "New", projectId: target.projectId }),
    resumeSession: async (session: any) => session,
    sendTurn: async (session: any, text: string) => { sends.push({ agent, session, text }); return { turnId: "turn-" + sends.length, text: "done" }; },
  } satisfies AgentAdapter]));
  const service = createService(ab, ba, join(directory, "bridge.sqlite"), {
    codex: adapters.codex, claude: adapters.claude, agents: adapters, routingNow: () => now,
    fetchFn: async (url, init) => {
      const provider = providers.find((id) => endpoints[id as keyof typeof endpoints] === String(url));
      assert.ok(provider, "Only the selected provider's documented endpoint is allowed");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-" + provider);
      assert.equal(init?.redirect, "error");
      const body = JSON.parse(String(init?.body)); requests.push({ provider, body });
      const question = body.questions?.connection ? "connection" : "route";
      const options = Object.entries(body.questions[question].criteria as Record<string, string>).map(([id, label]) => ({ id, label }));
      assert.equal(body.model, models[provider as keyof typeof models]);
      const connection = options.some((option: any) => option.id === "ok");
      if (release && !connection) await release;
      const selected = connection ? "ok" : pick(provider, options);
      const probabilities = Object.fromEntries(options.map((option: any) => [option.id, option.id === selected ? 1 : 0]));
      const intent = selected === "continue" ? "current" : selected.startsWith("new_") ? "new" :
        selected.startsWith("resume_") ? "resume" : selected === "clarify" ? "clarify" : "navigate";
      return Response.json(transform({ answers: { [question]: { type: "choice", choice: selected, confidence: 1, probabilities },
        ...(body.questions.intent ? { intent: { type: "choice", choice: intent, confidence: 1, probabilities: { [intent]: 1 } } } : {}) } }));
    },
  });
  let sequence = 0;
  return { native, service, secrets, requests, sends, databasePath: join(directory, "bridge.sqlite"),
    pick(value: typeof pick) { pick = value; }, transform(value: typeof transform) { transform = value; },
    now(value: string) { now = Date.parse(value); }, gate(value: Promise<void>) { release = value; },
    async select(provider: string) { return native.call<any>("routing.configure", { provider }); },
    async save(provider: string) { return native.call<any>("routing.key.save", { provider, apiKey: "fixture-" + provider }); },
    async send(text: string) {
      const receipt = service.core.receive({ kind: "desktop", accountId: "local", peerId: "local", eventId: String(++sequence) }, text);
      if (receipt.jobId) await service.core.run(receipt.jobId);
      return receipt;
    },
    close() { service.close(); native.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test("each gateway accepts destination correction intent without sending a new task", async (t) => {
  for (const provider of providers) await t.test(provider, async () => {
    const f = fixture();
    try {
      f.service.core.setRoutingSettings({ mode: "off" }); // bootstrap an already-completed prior task before any provider is configured
      const original = await f.send("原任务");
      await f.select(provider); await f.save(provider);
      await f.native.call("routing.configure", { mode: "auto" });
      f.pick((_provider, options) => {
        const action = options.find(option => option.id === "correct_" + original.jobId);
        assert.ok(action); return action.id;
      });
      f.transform(response => {
        response.answers.intent = { type: "choice", choice: "correct", confidence: 1, probabilities: { correct: 1 } };
        return response;
      });
      const receipt = await f.send("刚才那条发错会话了");
      const job = f.service.core.state().jobs.find(job => job.id === receipt.jobId)!;
      assert.match(job.routeMessage ?? "", /已经完成/);
      assert.equal(f.sends.length, 1);
      const questions = f.requests.at(-1)!.body.questions;
      assert.ok(questions.intent.criteria.correct);
      assert.equal(questions.route.criteria["correct_" + original.jobId].operation, "correct_destination");
    } finally { f.close(); }
  });
});

test("clear recording follow-ups stay in the current session at the observed confidence", async (t) => {
  for (const provider of providers) await t.test(provider, async () => {
    const f = fixture();
    try {
      f.service.core.setRoutingSettings({ mode: "off" }); // bootstrap the current session before any provider is configured
      await f.send("按方案完成 Godot 卡牌游戏的战斗原型，并告诉我怎么试玩。");
      const selected = f.service.core.state().selection;
      await f.select(provider); await f.save(provider);
      await f.native.call("routing.configure", { mode: "auto" });
      f.transform((response) => {
        response.answers.route = { type: "choice", choice: "continue", confidence: 0.8,
          probabilities: { continue: 0.95, new_codex_none: 0.03, clarify: 0.02 } };
        response.answers.intent = { type: "choice", choice: "current", confidence: 0.8,
          probabilities: { current: 0.95, new: 0.03, clarify: 0.02 } };
        return response;
      });
      f.service.core.bindChannel("weixin", "bot", "owner");
      const text = "你玩一下，帮我录一个视频发给我，我看一下。";
      const receipt = f.service.core.receive({ kind: "weixin", accountId: "bot", peerId: "owner", eventId: "recording" }, text);
      await f.service.core.run(receipt.jobId!);
      const job = f.service.core.state().jobs.find((job) => job.id === receipt.jobId)!;
      assert.equal(job.status, "completed");
      assert.equal(job.sessionId, selected.sessionId);
      assert.deepEqual((job.routingDecision as any).intent, { choice: "current", confidence: 0.8, probability: 0.95 });
      assert.deepEqual(f.service.core.state().selection, selected);
      assert.equal(f.sends.length, 2);
      assert.equal(f.sends[1].session.nativeId, f.sends[0].session.nativeId);
      assert.equal(f.sends[1].text, text);
      const replies = f.service.core.outbox().filter((entry) => entry.jobId === job.id);
      assert.deepEqual(replies.map((entry) => entry.kind), ["receipt", "final"]);
      assert.match(replies[0]!.text, /^Codex > 无项目 > New\n已收到✅$/);
    } finally { f.close(); }
  });
});

test("an uncertain task still runs: continuing, or in a fresh session when new or elsewhere; only confirm and no-target ask", async (t) => {
  const cases = [
    { name: "uncertain relationship", intentProbability: 0.89, expect: "same" },
    { name: "uncertain destination", routeProbability: 0.89, expect: "same" },
    { name: "low intent confidence", intentConfidence: 0.79, expect: "same" },
    { name: "low route confidence", routeConfidence: 0.79, expect: "same" },
    { name: "new-task intent", intent: "new", expect: "fresh" },
    { name: "different destination", route: "new_claude_none", expect: "fresh" },
    { name: "no existing session", empty: true, expect: "ask" },
    { name: "confirmation mode", confirm: true, expect: "ask" },
  ];
  for (const value of cases) await t.test(value.name, async () => {
    const f = fixture();
    try {
      f.service.core.setRoutingSettings({ mode: "off" }); // bootstrap the current session before any provider is configured
      if (!value.empty) await f.send("完成卡牌游戏原型。");
      const selected = f.service.core.state().selection, sends = f.sends.length;
      await f.select("openrouter"); await f.save("openrouter");
      await f.native.call("routing.configure", { mode: value.confirm ? "confirm" : "auto" });
      f.transform((response) => {
        const route = value.route ?? "continue", intent = value.intent ?? "current";
        const routeProbability = value.routeProbability ?? 0.95, intentProbability = value.intentProbability ?? 0.95;
        response.answers.route = { type: "choice", choice: route, confidence: value.routeConfidence ?? 0.8,
          probabilities: { [route]: routeProbability, clarify: 1 - routeProbability } };
        response.answers.intent = { type: "choice", choice: intent, confidence: value.intentConfidence ?? 0.8,
          probabilities: { [intent]: intentProbability, clarify: 1 - intentProbability } };
        return response;
      });
      const receipt = await f.send("帮我录一个视频。");
      const status = f.service.core.state().jobs.find((job) => job.id === receipt.jobId)?.status;
      if (value.expect === "ask") {
        assert.equal(status, "awaiting_route");
        assert.equal(f.sends.length, sends);
        assert.deepEqual(f.service.core.state().selection, selected);
      } else {
        assert.equal(status, "completed");
        assert.equal(f.sends.length, sends + 1);
        // The fixture reuses one nativeId per agent, so compare the dispatched target instead.
        const target = f.service.core.state().jobs.find((job) => job.id === receipt.jobId)!.target;
        if (value.expect === "same") {
          assert.equal(target.sessionId, selected.sessionId);
          assert.deepEqual(f.service.core.state().selection, selected);
        } else {
          assert.notEqual(target.sessionId ?? null, selected.sessionId);
          assert.ok(target.creationKey, "a new conversation was reserved");
          assert.equal(target.projectId, null);
        }
      }
    } finally { f.close(); }
  });
});

test("routing providers retain separate keys and switching providers keeps the current mode", async () => {
  const f = fixture();
  try {
    assert.equal((await f.native.call<any>("routing.get")).provider, "vercel");
    const selection = f.service.core.state().selection;
    for (const provider of providers) {
      await f.select(provider); await f.save(provider);
      await f.native.call("routing.configure", { mode: "confirm" });
      assert.deepEqual(f.secrets[provider], { apiKey: "fixture-" + provider });
    }
    const state = await f.select("vercel");
    assert.equal(state.routing.mode, "confirm"); assert.equal(state.routing.configured, true);
    assert.deepEqual(f.service.core.state().selection, selection);
    assert.deepEqual(Object.keys(f.secrets).sort(), providers.toSorted());
    assert.equal(JSON.stringify(state).includes("fixture-"), false);
    await f.native.call("routing.key.remove", { provider: "vercel" });
    assert.equal(f.secrets.vercel, undefined); assert.ok(f.secrets.openrouter);
    await assert.rejects(f.native.call("routing.configure", { provider: "untrusted" }), { code: "INVALID_INPUT" });
    await assert.rejects(f.native.call("routing.key.save", { provider: "openrouter", apiKey: "fixture-openrouter" }), { code: "INVALID_STATE" });
  } finally { f.close(); }
});

test("every provider keeps working with the user's own key after the Vercel promotion date", async () => {
  const f = fixture();
  try {
    f.now("2026-10-01T00:00:00+08:00");
    for (const provider of providers) {
      await f.select(provider);
      const state = await f.save(provider);
      await f.native.call("routing.configure", { mode: "auto" });
      assert.equal(state.routing.configured, true);
      assert.equal("expired" in state.routing, false);
      assert.equal("trialEndsAt" in state.routing, false);
    }
    await f.select("vercel");
    await f.native.call("routing.configure", { mode: "auto" });
    await f.send("继续当前任务");
    assert.equal(f.requests.at(-1)!.provider, "vercel");
    assert.equal(f.sends.length, 1);
  } finally { f.close(); }
});

test("continuations use one OpenRouter decision and keep their native session", async () => {
  const f = fixture();
  try {
    await f.select("openrouter"); await f.save("openrouter");
    await f.native.call("routing.configure", { mode: "auto" });
    await f.send("继续当前任务"); await f.send("按第二种方案继续");
    assert.equal(f.sends.length, 2);
    assert.equal(f.sends[0].session.nativeId, f.sends[1].session.nativeId);
    assert.equal(f.requests.length, 3, "Connection test plus one call per continuation");
  } finally { f.close(); }
});

test("missing confidence or invalid options from OpenRouter cannot auto-dispatch", async (t) => {
  for (const invalid of [false, true]) await t.test(String(invalid), async () => {
    const f = fixture();
    try {
      await f.select("openrouter"); await f.save("openrouter");
      await f.native.call("routing.configure", { mode: "auto" });
      f.transform((answer) => { delete answer.answers.route.confidence; if (invalid) answer.answers.route.choice = "invented"; return answer; });
      await f.send("继续");
      assert.equal(f.sends.length, 0);
      assert.equal(f.service.core.state().jobs[0]?.status, "awaiting_route");
    } finally { f.close(); }
  });
});

test("missing semantic intent from the provider never falls back to a confident flat route", async () => {
  const f = fixture();
  try {
    await f.select("openrouter"); await f.save("openrouter");
    await f.native.call("routing.configure", { mode: "auto" });
    f.transform((answer) => { delete answer.answers.intent; return answer; });
    await f.send("这是一个新任务");
    assert.equal(f.sends.length, 0);
    assert.equal(f.service.core.state().jobs[0]?.status, "awaiting_route");
  } finally { f.close(); }
});

test("changing the routing provider while a decision is pending prevents stale dispatch", async () => {
  const f = fixture(); let release!: () => void;
  try {
    await f.select("openrouter"); await f.save("openrouter");
    await f.native.call("routing.configure", { mode: "auto" });
    f.gate(new Promise<void>((resolve) => { release = resolve; }));
    const pending = f.send("继续");
    for (let index = 0; index < 100 && f.requests.length < 2; index++) await new Promise((resolve) => setImmediate(resolve));
    await f.select("vercel"); release(); await pending;
    assert.equal(f.sends.length, 0);
    assert.equal(f.service.core.state().jobs[0]?.status, "awaiting_route");
  } finally { release?.(); f.close(); }
});

test("removed providers cannot be selected or receive credentials", async () => {
  const f = fixture();
  try {
    assert.deepEqual(Object.keys(routingProviders).sort(), providers.toSorted());
    await assert.rejects(f.select("jevforhood"), { code: "INVALID_INPUT" });
    await assert.rejects(f.save("jevforhood"), { code: "INVALID_STATE" });
    assert.equal(f.requests.length, 0);
  } finally { f.close(); }
});

test("a saved removed provider falls back to disabled routing while preserving preferences and conversation", async () => {
  const f = fixture();
  try {
    const selection = f.service.core.state().selection;
    const db = new Database(f.databasePath);
    db.prepare("INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run("routing", JSON.stringify({ provider: "jevforhood", mode: "auto", planning: "grok", implementation: "cursor", research: "default" }));
    db.close();
    const state = await f.native.call<any>("state.get");
    assert.equal(state.routing.provider, "vercel");
    assert.equal(state.routing.mode, "off");
    assert.equal(state.routing.planning, "grok");
    assert.deepEqual(state.selection, selection);
    assert.equal(f.requests.length, 0);
  } finally { f.close(); }
});
