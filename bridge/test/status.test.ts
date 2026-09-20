import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { BridgeCore, type AgentAdapter, type Job } from "../src/core.js";

const desktop = (eventId: string) => ({ kind: "desktop" as const, accountId: "local", peerId: "local", eventId });
const remote = (eventId: string, kind: "imessage" | "weixin") => ({ kind, accountId: "account", peerId: "owner", eventId });

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "bridge-status-"));
  const path = join(directory, "bridge.sqlite");
  let sends = 0;
  const adapter: AgentAdapter = {
    probe: async () => ({ ready: true, reason: "" }),
    listProjects: async () => [{ id: "project", name: "chat-bridge", roots: [directory] }],
    listSessions: async () => [
      { nativeId: "current", title: "分析调研任务", projectId: "project" },
      { nativeId: "previous", title: "连接测试", projectId: null },
    ],
    createSession: async () => { throw new Error("Status must not create a session"); },
    resumeSession: async (session) => session,
    sendTurn: async () => { sends++; throw new Error("transport closed after dispatch"); },
  };
  const core = new BridgeCore(path, { codex: adapter, claude: adapter });
  await core.refreshCatalog("codex");
  const select = (nativeId: string) => core.receive(desktop("select-" + nativeId),
    "/use " + core.state().sessions.find((session) => session.nativeId === nativeId)!.shortId);
  return { core, adapter, select, get sends() { return sends; },
    updateJob(job: Job) {
      const db = new Database(path);
      try { db.prepare("UPDATE records SET data=? WHERE kind='job' AND id=?").run(JSON.stringify(job), job.id); }
      finally { db.close(); }
    },
    close() { core.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test("status labels the current target without exposing internal session codes", async () => {
  const f = await fixture();
  try {
    f.select("current");
    const before = f.core.state();
    assert.equal(f.core.receive(desktop("status"), "/status").message,
      "当前助手：Codex\n当前项目：chat-bridge\n当前会话：分析调研任务\n助手状态：可用\n\n没有待处理的桥接任务。");
    assert.deepEqual(f.core.state(), before);
    assert.equal(f.sends, 0);
  } finally { f.close(); }
});

test("status explains an uncertain task in its own session and persists the same reply for both channels", async () => {
  const f = await fixture();
  try {
    f.select("previous");
    const receipt = f.core.receive(desktop("task"), "检查消息连接");
    await f.core.run(receipt.jobId!);
    const job = f.core.state().jobs[0]!;
    assert.equal(job.status, "uncertain");
    f.updateJob({ ...job, error: "上次进程中断，原操作可能已经执行。" });
    f.select("current");
    const before = f.core.state();
    for (const kind of ["imessage", "weixin"] as const) {
      f.core.bindChannel(kind, "account", "owner");
      const reply = f.core.receive(remote("status", kind), "/status").message!;
      assert.match(reply, /^当前助手：Codex\n当前项目：chat-bridge\n当前会话：分析调研任务/);
      assert.match(reply, /未结束的桥接任务（共 1 项）：/);
      assert.match(reply, /1\. 执行结果待确认/);
      assert.match(reply, /所属助手：Codex\n所属项目：无项目\n所属会话：连接测试/);
      assert.match(reply, /请求：检查消息连接/);
      assert.match(reply, /说明：上次进程中断，原操作可能已经执行。/);
      assert.match(reply, /请在电脑上的 Codex 中打开该会话核对执行结果/);
      assert.match(reply, /原操作可能已经执行，未自动重发/);
      assert.doesNotMatch(reply, /uncertain|\b[JS][a-f0-9]{12}\b|\/retry|\/continue|\/cancel/);
      assert.equal(f.core.outbox().find((entry) => entry.kind === "receipt" && entry.origin.kind === kind)?.text, reply);
    }
    assert.deepEqual(f.core.state().selection, before.selection);
    assert.deepEqual(f.core.state().jobs, before.jobs);
    assert.equal(f.sends, 1);
  } finally { f.close(); }
});

test("status describes a new projectless conversation without claiming the assistant is idle", async () => {
  const f = await fixture();
  try {
    f.core.receive(desktop("claude"), "/agent claude");
    assert.equal(f.core.receive(desktop("status"), "/status").message,
      "当前助手：Claude Code\n当前项目：无项目\n当前会话：尚未选择，发送消息会新建会话\n助手状态：检测中\n\n没有待处理的桥接任务。");
  } finally { f.close(); }
});

test("status shows every pending phase in Chinese and excludes finished tasks", async () => {
  const f = await fixture();
  try {
    f.select("current");
    f.core.receive(desktop("task"), "检查状态");
    const job = f.core.state().jobs[0]!;
    for (const [status, label] of [
      ["accepted", "已接收，等待执行"], ["preparing", "正在连接会话"], ["dispatching", "正在发送给助手"],
      ["running", "正在执行"], ["awaiting_approval", "等待你的审批"], ["stopping", "正在停止，等待确认"],
      ["waiting_agent", "助手暂不可用，任务尚未发送"], ["awaiting_confirmation", "等待你确认后继续"],
    ]) {
      f.updateJob({ ...job, status: status! });
      const reply = f.core.receive(desktop("status-" + status), "/status").message!;
      assert.ok(reply.includes("1. " + label), reply);
      assert.match(reply, /所属会话：分析调研任务/);
      assert.ok(!reply.includes(status!), reply);
    }
    for (const status of ["completed", "cancelled", "interrupted", "failed"]) {
      f.updateJob({ ...job, status });
      assert.match(f.core.receive(desktop("status-" + status), "/status").message!, /没有待处理的桥接任务。/);
    }
  } finally { f.close(); }
});

test("status reports when older pending tasks are omitted", async () => {
  const f = await fixture();
  try {
    f.select("current");
    for (let i = 1; i <= 6; i++) f.core.receive(desktop("task-" + i), "请求" + i);
    const reply = f.core.receive(desktop("status"), "/status").message!;
    assert.match(reply, /未结束的桥接任务（共 6 项，显示最近 5 项）：/);
    assert.doesNotMatch(reply, /请求：请求1/);
    for (let i = 2; i <= 6; i++) assert.ok(reply.includes("请求：请求" + i));
  } finally { f.close(); }
});

test("status keeps recovery commands usable in the task's own channel", async () => {
  const f = await fixture();
  try {
    f.core.bindChannel("imessage", "account", "owner");
    f.core.bindChannel("weixin", "account", "owner");
    f.select("current");
    f.core.receive(remote("task", "imessage"), "等待恢复");
    const job = f.core.state().jobs[0]!;
    f.updateJob({ ...job, status: "waiting_agent", error: "请启动 Codex。任务未发送。" });
    const reply = f.core.receive(remote("status", "imessage"), "/status").message!;
    assert.ok(reply.includes("继续：/continue " + job.id));
    assert.ok(reply.includes("取消：/cancel " + job.id));
    assert.doesNotMatch(reply, /\/stop/);
    const otherChannel = f.core.receive(remote("status", "weixin"), "/status").message!;
    assert.doesNotMatch(otherChannel, /\/continue|\/cancel|\/stop/);
    assert.match(otherChannel, /所属会话：分析调研任务/);
    const local = f.core.receive(desktop("status"), "/status").message!;
    assert.ok(local.includes("继续：/continue " + job.id));
    assert.equal(f.sends, 0);
  } finally { f.close(); }
});

test("status offers the exact stop command only when the running assistant supports it", async () => {
  const f = await fixture();
  try {
    f.select("current");
    f.core.receive(desktop("task"), "正在处理");
    const job = f.core.state().jobs[0]!;
    f.updateJob({ ...job, status: "running" });
    assert.doesNotMatch(f.core.receive(desktop("unsupported"), "/status").message!, /\/stop/);
    let stops = 0;
    f.adapter.stopTurn = async () => { stops++; };
    const reply = f.core.receive(desktop("status"), "/status").message!;
    assert.ok(reply.includes("停止：/stop " + job.id));
    assert.doesNotMatch(reply, /\/continue|\/cancel/);
    assert.equal(stops, 0);
    assert.equal(f.core.state().jobs[0]?.status, "running");
  } finally { f.close(); }
});

test("status keeps multiline requests on a short labeled line", async () => {
  const f = await fixture();
  try {
    f.select("current");
    f.core.receive(desktop("task"), "第一行\n  第二行\t" + "长".repeat(200));
    const reply = f.core.receive(desktop("status"), "/status").message!;
    assert.match(reply, /请求：第一行 第二行 长+…(?:\n|$)/);
    assert.ok(reply.length < 400);
  } finally { f.close(); }
});
