import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RPCPeer } from "../src/rpc.js";
import { createService } from "../src/service.js";
import type { AgentAdapter } from "../src/core.js";
import { BridgeCore } from "../src/core.js";

const settle = async () => { for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "bridge-availability-"));
  const ab = new PassThrough(), ba = new PassThrough(), native = new RPCPeer(ba, ab, {});
  const state = { ready: false, broken: false, probes: 0, sends: 0, creates: 0 };
  const adapter: AgentAdapter = {
    probe: async () => {
      state.probes++;
      if (state.broken) throw new Error("private credential detail");
      return { installed: true, ready: state.ready, status: state.ready ? "ready" as const : "needs_login" as const,
        reason: state.ready ? "已就绪" : "请登录" };
    },
    createSession: async () => { state.creates++; return { nativeId: "native", title: "Test", projectId: null }; },
    resumeSession: async (session) => session,
    sendTurn: async () => { state.sends++; return { turnId: "turn", text: "完成" }; },
  };
  const service = createService(ab, ba, join(directory, "bridge.sqlite"), { codex: adapter, claude: adapter,
    agents: { cursor: adapter, grok: adapter, opencode: adapter, hermes: adapter } } as any);
  service.core.setRoutingSettings({ mode: "off" }); // availability recovery is not about routing; keep messages going straight to the current target
  const snapshots: any[] = [];
  native.onEvent = (method, snapshot) => { if (method === "state.changed") snapshots.push(snapshot); };
  return { native, service, adapter, state, snapshots,
    directory,
    close() { service.close(); native.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("startup and periodic probes publish login, recovery and failure without executing tasks", async (context) => {
  context.mock.timers.enable({ apis: ["setInterval"] });
  const f = fixture();
  try {
    f.service.start(); await settle();
    assert.equal(f.snapshots.at(-1)?.probes?.codex?.status, "needs_login");
    f.state.ready = true;
    context.mock.timers.tick(30_000); await settle();
    assert.equal(f.snapshots.at(-1)?.probes?.codex?.ready, true);
    assert.equal(f.snapshots.at(-1)?.probes?.claude?.ready, true);
    f.state.broken = true;
    context.mock.timers.tick(30_000); await settle();
    const snapshot = await f.native.call<any>("state.get");
    assert.equal(snapshot.probes.codex.status, "error");
    assert.equal(snapshot.probes.codex.ready, false);
    assert.doesNotMatch(JSON.stringify(snapshot.probes), /private credential/);
    assert.equal(f.state.creates, 0); assert.equal(f.state.sends, 0);
    f.service.close();
    const count = f.state.probes;
    context.mock.timers.tick(60_000); await settle();
    assert.equal(f.state.probes, count);
  } finally { f.close(); }
});

test("a known model failure remains visible after restart and a healthy login check until an explicit execution succeeds", async () => {
  const f = fixture();
  f.state.ready = true;
  try {
    assert.equal(typeof (f.service.core as any).recordAgentExecution, "function");
    (f.service.core as any).recordAgentExecution("hermes", "模型服务拒绝请求，请检查配置。");
    assert.match((await f.service.core.probeAgent("hermes")).executionError!, /模型服务/);
    f.service.close(); f.native.close();
    const reopened = new BridgeCore(join(f.directory, "bridge.sqlite"), { hermes: f.adapter });
    try {
      assert.match((await reopened.probeAgent("hermes")).executionError!, /模型服务/);
      (reopened as any).recordAgentExecution("hermes", null);
      assert.equal((await reopened.probeAgent("hermes")).executionError, undefined);
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test("concurrent probes share one runtime check and publish the result in service state", async () => {
  const f = fixture();
  let finish!: () => void, calls = 0;
  f.adapter.probe = async () => { calls++; await new Promise<void>((resolve) => { finish = resolve; }); return { ready: true, reason: "ready" }; };
  try {
    const first = f.native.call<any>("agent.probe", { agent: "codex" });
    const second = f.native.call<any>("agent.probe", { agent: "codex" });
    void first.catch(() => {}); void second.catch(() => {});
    await settle();
    assert.equal(calls, 1);
    finish();
    assert.equal((await first).ready, true); assert.equal((await second).ready, true);
    assert.equal((await f.native.call<any>("state.get")).probes.codex.ready, true);
  } finally { finish?.(); f.close(); }
});

test("a late positive probe cannot overwrite a connection failure during that check", async () => {
  const f = fixture();
  let finish!: () => void;
  f.adapter.probe = async () => { await new Promise<void>((resolve) => { finish = resolve; }); return { ready: true, reason: "ready" }; };
  try {
    const pending = f.service.core.probeAgent("codex");
    await settle();
    f.service.core.invalidateAgent("codex"); finish();
    assert.equal((await pending).ready, false);
    assert.equal(f.service.core.state().probes.codex?.ready, false);
  } finally { finish?.(); f.close(); }
});

test("both phone channels see detected availability and can use a recovered agent", async () => {
  const f = fixture();
  try {
    for (const kind of ["weixin", "imessage"] as const) {
      f.service.core.bindChannel(kind, "account", "owner");
      const origin = (eventId: string) => ({ kind, accountId: "account", peerId: "owner", eventId });
      const receive = async (eventId: string, text: string) => {
        const [event] = await f.service.core.prepareEvents([{ origin: origin(eventId), text }]);
        return f.service.core.receive(event!.origin, event!.text, event!.rejection);
      };
      f.state.ready = false;
      assert.match((await receive("before", "/agent")).message!, /Codex：待登录/);
      f.state.ready = true;
      assert.match((await receive("after", "/agent")).message!, /Codex：可用/);
      assert.match((await receive("status", "/status")).message!, /助手状态：可用/);
      const receipt = await receive("task", "你好");
      await f.service.core.run(receipt.jobId!);
      assert.equal(f.service.core.state().jobs[0]?.status, "completed");
    }
    assert.equal(f.state.sends, 2);
  } finally { f.close(); }
});

test("availability recovery preserves the selected agent and leaves previously held tasks unsent", async (context) => {
  context.mock.timers.enable({ apis: ["setInterval"] });
  const f = fixture();
  try {
    const job = f.service.core.receive({ kind: "desktop", accountId: "local", peerId: "local", eventId: "held" }, "task");
    await f.service.core.run(job.jobId!);
    const selection = f.service.core.state().selection;
    f.service.start(); await settle();
    f.state.ready = true;
    context.mock.timers.tick(30_000); await settle();
    assert.equal((await f.native.call<any>("state.get")).probes?.codex?.ready, true);
    assert.deepEqual(f.service.core.state().selection, selection);
    assert.equal(f.service.core.state().jobs[0]?.status, "waiting_agent");
    assert.equal(f.state.sends, 0);
  } finally { f.close(); }
});

test("all six agents can be selected and receive desktop or bound-channel messages", async () => {
  const f = fixture();
  f.state.ready = true;
  try {
    for (const agent of ["codex", "claude", "cursor", "grok", "opencode", "hermes"]) {
      assert.equal((await f.native.call<any>("agent.probe", { agent })).ready, true);
      await f.native.call("agent.open", { agent });
      const state = f.service.core.state();
      assert.equal(state.selection.agent, agent);
      await f.native.call("preferences.update", { defaultAgent: agent });
      for (const kind of ["desktop", "weixin", "imessage"] as const) {
        if (kind !== "desktop") f.service.core.bindChannel(kind, "account", "owner");
        const receipt = f.service.core.receive({ kind, accountId: kind === "desktop" ? "local" : "account",
          peerId: kind === "desktop" ? "local" : "owner", eventId: agent + kind }, "test " + agent);
        await f.service.core.run(receipt.jobId!);
        assert.equal(f.service.core.state().jobs[0]?.status, "completed");
      }
    }
    assert.equal(f.state.sends, 18);
  } finally { f.close(); }
});
