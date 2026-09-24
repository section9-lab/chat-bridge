import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeCore, type AgentAdapter, type TurnResult } from "../src/core.js";

const remote = { kind: "weixin" as const, accountId: "bot", peerId: "owner", eventId: "task" };
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "bridge-stream-")), path = join(directory, "bridge.sqlite");
  let hooks: any, resolve!: (value: TurnResult) => void, reject!: (error: Error) => void;
  const adapter: AgentAdapter = {
    probe: async () => ({ ready: true, reason: "" }),
    createSession: async () => ({ nativeId: "thread", projectId: null, title: "Test" }),
    resumeSession: async (session) => session,
    sendTurn: async (_session, _text, _id, events) => {
      hooks = events; hooks.started("native-turn");
      return new Promise((done, fail) => { resolve = done; reject = fail; });
    }
  };
  const core = new BridgeCore(path, { codex: adapter, claude: adapter }); core.bindChannel("weixin", "bot", "owner");
  return { core, adapter, path,
    update(id: string, text: string, completed = false) { hooks.message?.({ id, text, completed }); },
    finish(status: TurnResult["status"] = "completed") { resolve({ turnId: "native-turn", text: "完成", status }); },
    fail() { reject(new Error("pipe closed")); },
    close() { core.close(); rmSync(directory, { recursive: true, force: true }); }
  };
}

test("public text updates one bubble before completion and sends completed segments once in order", async () => {
  const f = fixture();
  try {
    const job = f.core.receive(remote, "task"); const run = f.core.run(job.jobId!); await settle();
    let changes = 0; f.core.onChange = () => { changes++; };
    f.update("progress", "检查");
    for (let i = 0; i < 100; i++) f.update("progress", "检查 " + i);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(f.core.state().messages.filter((message) => message.role === "assistant").length, 1);
    assert.equal(f.core.state().messages.at(-1)?.text, "检查 99");
    assert.ok(changes <= 3, "token bursts are coalesced instead of writing/publishing once per token");
    assert.equal(f.core.outbox().filter((entry) => entry.kind === "assistant").length, 0);
    f.update("progress", "检查完毕", true); f.update("progress", "检查完毕", true);
    assert.deepEqual(f.core.outbox().filter((entry) => entry.kind === "assistant").map((entry) => entry.text), ["🤖 Codex\n检查完毕"]);
    f.update("answer", "完成", true); f.finish(); await run;
    assert.deepEqual(f.core.state().messages.map((message) => message.text), ["task", "检查完毕", "完成"]);
    assert.deepEqual(f.core.outbox().filter((entry) => ["assistant", "final"].includes(entry.kind!)).map((entry) => entry.text), ["🤖 Codex\n检查完毕", "🤖 Codex\n完成"]);
  } finally { f.close(); }
});

test("switching Agent cannot redirect streamed text or its delivery origin", async () => {
  const f = fixture();
  try {
    const job = f.core.receive(remote, "task"); const run = f.core.run(job.jobId!); await settle();
    const sessionId = f.core.state().selection.sessionId;
    f.core.receive({ kind: "desktop", accountId: "local", peerId: "local", eventId: "switch" }, "/agent claude");
    f.update("answer", "完成", true); f.finish(); await run;
    assert.equal(f.core.state().messages.length, 0);
    const reply = f.core.outbox().find((entry) => entry.kind === "assistant");
    assert.equal(reply?.origin.peerId, "owner"); assert.equal(reply?.jobId, job.jobId);
    assert.equal(f.core.state().jobs[0]?.sessionId, sessionId);
  } finally { f.close(); }
});

test("interruption retains partial text and reports status without duplicating the answer", async () => {
  const f = fixture();
  try {
    const job = f.core.receive(remote, "task"); const run = f.core.run(job.jobId!); await settle();
    f.update("partial", "已经检查第一部分"); f.finish("interrupted"); await run;
    assert.deepEqual(f.core.state().messages.map((message) => message.text), ["task", "已经检查第一部分"]);
    assert.equal(f.core.state().jobs[0]?.status, "interrupted");
    assert.equal(f.core.outbox().filter((entry) => entry.kind === "assistant").length, 1);
    assert.equal(f.core.outbox().filter((entry) => entry.kind === "status").length, 1);
  } finally { f.close(); }
});

test("transport failure and shutdown preserve partial text without replaying it after restart", async () => {
  for (const shutdown of [false, true]) {
    const f = fixture();
    try {
      const job = f.core.receive(remote, "task"); const run = f.core.run(job.jobId!); await settle();
      f.update("partial", "尚未完成的正文");
      if (shutdown) { f.core.close(); f.finish(); } else f.fail();
      await run;
      const restored = new BridgeCore(f.path, { codex: f.adapter });
      try {
        assert.equal(restored.state().messages.at(-1)?.text, "尚未完成的正文");
        assert.equal(restored.state().jobs[0]?.status, "uncertain");
        assert.equal(restored.outbox().filter((entry) => entry.kind === "assistant").length, shutdown ? 0 : 1);
      } finally { restored.close(); }
    } finally { f.close(); }
  }
});

test("streamed and final replies quote their own request, including after restart", async () => {
  const f = fixture();
  try {
    const first = f.core.receive(remote, "第一条问题");
    const run = f.core.run(first.jobId!); await settle();
    f.core.receive({ ...remote, eventId: "second" }, "第二条问题");
    f.update("progress", "第一条的进度", true); f.finish(); await run;
    const reply = f.core.state().messages.find(message => message.role === "assistant") as any;
    assert.deepEqual(reply.replyTo, { id: first.jobId + ":user", text: "第一条问题" });
    f.core.close();
    const restored = new BridgeCore(f.path, { codex: f.adapter });
    try {
      assert.deepEqual((restored.state().messages.at(-1) as any).replyTo, reply.replyTo);
    } finally { restored.close(); }
  } finally { f.close(); }
});

test("native history restores reply quotes and leaves an orphan answer unquoted", async () => {
  const f = fixture();
  try {
    const receipt = f.core.receive(remote, "当前问题");
    const run = f.core.run(receipt.jobId!); await settle(); f.finish(); await run;
    f.adapter.readHistory = async () => [
      { id: "orphan", role: "assistant", text: "较早的回答", createdAt: "1" },
      { id: "u1", role: "user", text: "历史问题", createdAt: "2" },
      { id: "a1", role: "assistant", text: "历史回答", createdAt: "3" },
      { id: "a2", role: "assistant", text: "补充回答", createdAt: "4" },
    ];
    await f.core.loadHistory(f.core.state().selection.sessionId!);
    const messages = f.core.state().messages as any[];
    assert.equal(messages[0].replyTo, undefined);
    for (const message of messages.slice(2)) assert.deepEqual(message.replyTo, { id: messages[1].id, text: "历史问题" });
  } finally { f.close(); }
});
