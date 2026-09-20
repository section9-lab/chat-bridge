import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeCore, type AgentAdapter, type Origin, type TurnHooks, type TurnResult } from "../src/core.js";

const answer = (choice: string) => ({ choice, confidence: 1, probabilities: { [choice]: 1 } });
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(check: () => boolean) { for (let i = 0; i < 100 && !check(); i++) await settle(); }
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "bridge-lifecycle-"));
  let sequence = 0;
  const sends: { agent: string; text: string; session: string }[] = [], stops: string[] = [];
  const releases = new Map<string, () => void>();
  const held = new Set<string>();
  const adapters = Object.fromEntries(["codex", "claude"].map((agent) => [agent, {
    probe: async () => ({ ready: true, reason: "Fixture" }),
    listProjects: async () => [], listSessions: async () => [],
    createSession: async (target) => ({ nativeId: "session-" + ++sequence, projectId: target.projectId, title: "测试会话" }),
    resumeSession: async (session) => session,
    sendTurn: async (session, text, id, hooks?: TurnHooks): Promise<TurnResult> => {
      sends.push({ agent, text, session: session.nativeId }); hooks?.started?.(id);
      if (held.has(agent)) await new Promise<void>((resolve) => releases.set(id, resolve));
      return { turnId: id, text: "完成", status: stops.includes(id) ? "interrupted" : "completed" };
    },
    stopTurn: async (id) => { stops.push(id); releases.get(id)?.(); },
  } satisfies AgentAdapter]));
  const core = new BridgeCore(join(directory, "bridge.sqlite"), adapters);
  core.bindChannel("weixin", "bot", "owner"); core.bindChannel("imessage", "mail", "phone");
  core.setRoutingSettings({ mode: "auto" }); core.routeDecision = async () => answer("continue");
  const origin = (kind: Origin["kind"]): Origin => ({ kind, eventId: "event-" + ++sequence,
    accountId: kind === "desktop" ? "local" : kind === "weixin" ? "bot" : "mail",
    peerId: kind === "desktop" ? "local" : kind === "weixin" ? "owner" : "phone" });
  const receive = (text: string, kind: Origin["kind"] = "weixin") => core.receive(origin(kind), text);
  async function send(text: string, kind: Origin["kind"] = "weixin") { const r = receive(text, kind); if (r.jobId) await core.run(r.jobId); return r; }
  return { core, sends, stops, held, releases, origin, receive, send,
    close() { for (const release of releases.values()) release(); core.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("an independent request does not merge into an unanswered clarification", async () => {
  const f = fixture();
  try {
    f.core.routeDecision = async () => answer("clarify");
    const old = await f.send("继续卡牌项目");
    f.core.routeDecision = async () => answer("new_claude_none");
    const next = await f.send("先不管这个，另开 Claude 会话写请假邮件");
    assert.notEqual(next.jobId, old.jobId);
    assert.equal(f.core.state().jobs.find((j) => j.id === old.jobId)?.text, "继续卡牌项目");
    assert.equal(f.core.state().jobs.find((j) => j.id === old.jobId)?.status, "awaiting_route");
    assert.deepEqual(f.sends.map((s) => [s.agent, s.text]), [["claude", "先不管这个，另开 Claude 会话写请假邮件"]]);
  } finally { f.close(); }
});

test("a desktop request cannot be consumed as a reply to a WeChat clarification", async () => {
  const f = fixture();
  try {
    f.core.routeDecision = async () => answer("clarify"); const old = await f.send("修改商城");
    f.core.routeDecision = async (_context, actions) => {
      assert.ok(!actions.some((a) => a.id === "answer_" + old.jobId)); return answer("new_claude_none");
    };
    const next = await f.send("新建 Claude 会话写邮件", "desktop");
    assert.notEqual(next.jobId, old.jobId);
    assert.equal(f.core.state().jobs.find((j) => j.id === next.jobId)?.origin.kind, "desktop");
    assert.equal(f.sends.length, 1);
  } finally { f.close(); }
});

test("semantic clarification retains the old task and its delivery origin", async () => {
  const f = fixture();
  try {
    f.core.routeDecision = async () => answer("clarify"); const old = await f.send("给商城出方案");
    f.core.routeDecision = async (context, actions) => {
      const reply = actions.find((a) => a.id === "answer_" + old.jobId);
      return answer(reply && !context.text.includes("给商城出方案") ? reply.id : "new_claude_none");
    };
    await f.send("用 Claude 处理这个问题");
    assert.equal(f.sends.length, 1); assert.match(f.sends[0]!.text, /给商城出方案[\s\S]*用 Claude/);
    assert.equal(f.core.state().jobs.find((j) => j.id === old.jobId)?.status, "completed");
    assert.ok(f.core.outbox().filter((e) => e.kind === "final").every((e) => e.origin.kind === "weixin"));
  } finally { f.close(); }
});

test("browsing another agent preserves and can resolve an older clarification", async () => {
  const f = fixture();
  try {
    await f.core.openAgent("codex");
    f.core.routeDecision = async () => ({ choice: "continue", confidence: 0.5, probabilities: { continue: 0.5, new_claude_none: 0.5 } });
    const old = await f.send("继续游戏");
    await f.core.openAgent("claude");
    assert.equal(f.core.state().jobs.find((j) => j.id === old.jobId)?.status, "awaiting_route");
    f.core.resolveRouting(old.jobId!, 1, f.origin("weixin")); await f.core.run(old.jobId!);
    assert.equal(f.sends[0]?.agent, "codex");
    assert.equal(f.core.state().selection.agent, "claude");
  } finally { f.close(); }
});

test("browsing while an inference is pending cannot invalidate or retarget its job", async () => {
  const f = fixture(); let release!: () => void, entered = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    f.core.routeDecision = async () => { entered = true; await gate; return answer("continue"); };
    const old = f.receive("继续游戏"); const run = f.core.run(old.jobId!); await until(() => entered);
    await f.core.openAgent("claude"); release(); await run;
    assert.equal(f.sends[0]?.agent, "codex"); assert.equal(f.core.state().selection.agent, "claude");
  } finally { release(); f.close(); }
});

test("independent agents execute without waiting for a long task", async () => {
  const f = fixture(); let run: Promise<void> | undefined, next: Promise<void> | undefined;
  try {
    f.held.add("codex");
    f.core.routeDecision = async (context) => answer(context.text.includes("邮件") ? "new_claude_none" : "continue");
    const first = f.receive("开发游戏"); run = f.core.run(first.jobId!); await until(() => f.sends.length === 1);
    const second = f.receive("Claude 写邮件", "imessage"); next = f.core.run(second.jobId!); await until(() => f.sends.length === 2);
    assert.equal(f.sends[1]?.agent, "claude");
    assert.ok(f.core.outbox().some((e) => e.jobId === second.jobId && e.kind === "receipt"));
    assert.equal(f.core.state().jobs.find((j) => j.id === first.jobId)?.status, "running");
  } finally { for (const release of f.releases.values()) release(); await Promise.all([run, next]); f.close(); }
});

test("an unresolved route in another channel does not block an independent task", async () => {
  const f = fixture();
  try {
    f.core.routeDecision = async () => answer("clarify"); await f.send("继续之前的项目");
    f.core.routeDecision = async () => answer("new_claude_none"); await f.send("新开 Claude 写邮件", "imessage");
    assert.equal(f.sends[0]?.agent, "claude");
  } finally { f.close(); }
});

test("same-agent turns remain ordered and receive a readable queued receipt", async () => {
  const f = fixture(); let run: Promise<void> | undefined, next: Promise<void> | undefined;
  try {
    f.held.add("codex");
    const first = f.receive("先做游戏"); run = f.core.run(first.jobId!); await until(() => f.sends.length === 1);
    const second = f.receive("然后测试游戏"); next = f.core.run(second.jobId!);
    await until(() => f.core.outbox().some((e) => e.jobId === second.jobId && e.kind === "receipt"));
    assert.equal(f.sends.length, 1);
    const receipt = f.core.outbox().find((e) => e.jobId === second.jobId && e.kind === "receipt");
    assert.match(receipt?.text ?? "", /Codex.*测试会话.*已收到.*等/s);
    f.held.clear(); for (const release of f.releases.values()) release(); await Promise.all([run, next]);
    assert.equal(f.sends[0]?.session, f.sends[1]?.session);
  } finally { f.held.clear(); for (const release of f.releases.values()) release(); await Promise.all([run, next]); f.close(); }
});

test("natural-language stop interrupts the running task without entering its execution queue", async () => {
  const f = fixture(); let run: Promise<void> | undefined, stopRun: Promise<void> | undefined;
  try {
    f.held.add("codex"); const first = f.receive("开发游戏"); run = f.core.run(first.jobId!); await until(() => f.sends.length === 1);
    f.core.routeDecision = async (_context, actions) => {
      const stop = actions.find((a) => a.id === "stop_" + first.jobId);
      return answer(stop?.id ?? "continue");
    };
    const stop = f.receive("停止刚才的任务"); stopRun = f.core.run(stop.jobId!); await until(() => f.stops.length > 0);
    assert.deepEqual(f.stops, [first.jobId]); assert.equal(f.sends.length, 1);
    await Promise.all([run, stopRun]);
    assert.equal(f.core.state().jobs.find((j) => j.id === first.jobId)?.status, "interrupted");
  } finally { f.held.clear(); for (const release of f.releases.values()) release(); await Promise.all([run, stopRun]); f.close(); }
});

test("two explicit new sessions queued on one agent never share a creation reservation", async () => {
  const f = fixture(); const runs: Promise<void>[] = [];
  try {
    f.held.add("codex"); const first = f.receive("开发游戏"); runs.push(f.core.run(first.jobId!)); await until(() => f.sends.length === 1);
    f.core.routeDecision = async () => answer("new_codex_none");
    const second = f.receive("新建会话写邮件"); runs.push(f.core.run(second.jobId!));
    const third = f.receive("再新建会话写诗"); runs.push(f.core.run(third.jobId!));
    await until(() => f.core.state().jobs.filter((j) => j.status === "accepted").length === 2);
    f.held.clear(); for (const release of f.releases.values()) release(); await Promise.all(runs);
    assert.equal(new Set(f.sends.map((s) => s.session)).size, 3);
  } finally { f.held.clear(); for (const release of f.releases.values()) release(); await Promise.all(runs); f.close(); }
});

test("cancelling a queued task leaves the running task alone", async () => {
  const f = fixture(); const runs: Promise<void>[] = [];
  try {
    f.held.add("codex"); const first = f.receive("开发游戏"); runs.push(f.core.run(first.jobId!)); await until(() => f.sends.length === 1);
    const second = f.receive("测试游戏"); runs.push(f.core.run(second.jobId!));
    await until(() => f.core.state().jobs.find((j) => j.id === second.jobId)?.status === "accepted");
    f.core.routeDecision = async () => answer("cancel_" + second.jobId);
    await f.send("取消后面排队的测试，前面的继续");
    assert.equal(f.core.state().jobs.find((j) => j.id === second.jobId)?.status, "cancelled");
    assert.equal(f.core.state().jobs.find((j) => j.id === first.jobId)?.status, "running");
    assert.equal(f.stops.length, 0);
    f.held.clear(); for (const release of f.releases.values()) release(); await Promise.all(runs);
    assert.equal(f.sends.length, 1);
  } finally { f.held.clear(); for (const release of f.releases.values()) release(); await Promise.all(runs); f.close(); }
});

test("control candidates cannot stop a task from a different bound channel", async () => {
  const f = fixture(); let run: Promise<void> | undefined;
  try {
    f.held.add("codex"); const first = f.receive("开发游戏"); run = f.core.run(first.jobId!); await until(() => f.sends.length === 1);
    f.core.routeDecision = async (_context, actions) => { assert.ok(!actions.some((a) => a.id === "stop_" + first.jobId)); return answer("clarify"); };
    await f.send("停止任务", "imessage"); assert.equal(f.stops.length, 0);
  } finally { f.held.clear(); for (const release of f.releases.values()) release(); await run; f.close(); }
});
