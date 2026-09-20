import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexRuntime } from "../src/codex.js";
import type { TurnHooks } from "../src/core.js";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "codex-queue-"));
  const input = new PassThrough(), output = new PassThrough(), sent: any[] = [];
  let history: any[] = [], prefix: any[] = [], queued = false, polls = 0, loseReply = false, mismatch = false;
  let pollObserved: (() => void) | undefined;
  let buffer = "";
  output.on("data", (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); sent.push(message);
      if (!message.id) continue;
      const reply = (result: unknown) => input.write(JSON.stringify({ id: message.id, result }) + "\n");
      if (message.method === "thread/resume") {
        input.write(JSON.stringify({ id: message.id, error: { code: -32600, message: "thread original already has an active writer" } }) + "\n");
      } else if (message.method === "thread/read") reply({ thread: { id: mismatch ? "another" : "original", cwd: directory } });
      else if (message.method === "thread/queue/list") reply({ data: [], nextCursor: null });
      else if (message.method === "thread/queue/add") {
        queued = true;
        if (loseReply) input.end();
        else reply({ queuedSubmission: { id: "queued-1", input: message.params.input, clientUserMessageId: message.params.clientUserMessageId } });
      } else if (message.method === "thread/turns/list") {
        if (queued) polls++;
        reply({ data: queued ? prefix.length && !message.params.cursor ? prefix : history : [{ id: "old-turn", items: [], status: "completed", completedAt: 1 }],
          nextCursor: queued && prefix.length && !message.params.cursor ? "next-page" : null });
        if (queued) { pollObserved?.(); pollObserved = undefined; }
      } else reply({});
    }
  });
  const runtime = new CodexRuntime({ workspace: directory,
    locate: async () => ({ installed: true, executablePath: "/fixture/codex" }),
    connect: () => ({ input, output, close() { input.end(); } }) });
  const session = { nativeId: "original", title: "Desktop session", projectId: null, cwd: directory, runtime: "codex-app-server" };
  return { runtime, session, sent, get polls() { return polls; }, setHistory(value: any[]) { history = value; },
    setPrefix(value: any[]) { prefix = value; }, nextPoll: () => new Promise<void>((resolve) => { pollObserved = resolve; }),
    loseReply() { loseReply = true; }, mismatch() { mismatch = true; },
    close() { runtime.close(); input.destroy(); output.destroy(); rmSync(directory, { recursive: true, force: true }); } };
}
const user = (clientId = "J1") => ({ id: "user", type: "userMessage", clientId, content: [{ type: "text", text: "continue" }] });
const assistant = (id: string, text: string) => ({ id, type: "agentMessage", text });

test("a desktop-owned Codex session receives one queued message and returns only its matching reply", async () => {
  const f = fixture();
  try {
    f.setHistory([
      { id: "unrelated", status: "completed", completedAt: 3, items: [user("other"), assistant("other", "unrelated reply")] },
      { id: "matched", status: "completed", completedAt: 2, items: [user(), assistant("answer", "same session reply")] }
    ]);
    await f.runtime.resumeSession(f.session);
    const updates: any[] = [], starts: string[] = [];
    let queued = 0;
    const result = await f.runtime.sendTurn(f.session, "continue", "J1", {
      queued: () => queued++, started: (id: string) => starts.push(id), message: (message: any) => updates.push(message)
    } as TurnHooks);
    assert.equal(queued, 1);
    assert.deepEqual(starts, ["matched"]);
    assert.equal(result.text, "same session reply");
    assert.equal(result.status, "completed");
    const submissions = f.sent.filter((m) => m.method === "thread/queue/add");
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0].params.threadId, "original");
    assert.equal(submissions[0].params.clientUserMessageId, "J1");
    assert.equal(submissions[0].params.input[0].text, "continue");
    assert.equal(f.sent.some((m) => ["thread/start", "turn/start", "thread/queue/start"].includes(m.method)), false);
    assert.equal(updates.filter((m) => m.completed).length, 1);
  } finally { f.close(); }
});

test("persisted interrupted status without completedAt is still live and public text is reconciled without duplicates", async () => {
  const f = fixture();
  let running: Promise<unknown> | undefined;
  try {
    await f.runtime.resumeSession(f.session);
    f.setHistory([{ id: "matched", status: "interrupted", completedAt: null, items: [user(), assistant("progress", "checking")] }]);
    const updates: any[] = [], starts: string[] = []; let finished = false;
    running = f.runtime.sendTurn(f.session, "continue", "J1", {
      started: (id) => starts.push(id), message: (value) => updates.push(value)
    }).then((result) => { finished = true; return result; });
    void running.catch(() => {});
    await settle();
    assert.ok(f.polls > 0);
    assert.equal(finished, false, "another process's history projection is not completion evidence");
    assert.deepEqual(updates, [{ id: "progress", text: "checking", completed: false }]);
    const next = f.nextPoll();
    f.setHistory([{ id: "matched", status: "interrupted", completedAt: null, items: [user(), assistant("progress", "checking more")] }]);
    await next; await settle();
    assert.equal(updates.at(-1)?.text, "checking more");
    assert.equal(finished, false);
    f.setHistory([{ id: "matched", status: "completed", completedAt: 3, items: [user(), assistant("progress", "checked"),
      { id: "private", type: "reasoning", text: "hidden" }, { id: "tool", type: "commandExecution", text: "hidden" }, assistant("answer", "done") ] }]);
    const result = await running as any;
    assert.equal(result.status, "completed");
    assert.deepEqual(starts, ["matched"]);
    assert.deepEqual(updates.filter((m) => m.completed), [
      { id: "progress", text: "checked", completed: true }, { id: "answer", text: "done", completed: true }
    ]);
    assert.equal(updates.some((m) => m.text.includes("hidden")), false);
  } finally { f.close(); await running?.catch(() => {}); }
});

test("queued replies beyond the latest history page are found by client ID", async () => {
  const f = fixture();
  try {
    await f.runtime.resumeSession(f.session);
    f.setPrefix(Array.from({ length: 25 }, (_, index) => ({ id: "foreign-" + index, items: [user("foreign-" + index)] })));
    f.setHistory([{ id: "matched", status: "completed", completedAt: 2, items: [user(), assistant("answer", "matched")] }]);
    const result = await f.runtime.sendTurn(f.session, "continue", "J1");
    assert.equal(result.text, "matched");
    assert.ok(f.sent.some((m) => m.method === "thread/turns/list" && m.params.cursor === "next-page"));
  } finally { f.close(); }
});

test("ambiguous queue acceptance is never retried or replaced with a new session", async () => {
  const f = fixture();
  try {
    await f.runtime.resumeSession(f.session); f.loseReply();
    await assert.rejects(f.runtime.sendTurn(f.session, "continue", "J1"), /SEND_UNCERTAIN/);
    assert.equal(f.sent.filter((m) => m.method === "thread/queue/add").length, 1);
    assert.equal(f.sent.some((m) => ["thread/start", "turn/start"].includes(m.method)), false);
  } finally { f.close(); }
});

test("a busy session is verified again before queueing into the desktop-owned thread", async () => {
  const f = fixture();
  try {
    f.mismatch();
    await assert.rejects(f.runtime.resumeSession(f.session), /TARGET_MISMATCH/);
    assert.equal(f.sent.some((m) => m.method === "thread/queue/add"), false);
  } finally { f.close(); }
});
