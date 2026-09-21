import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInput } from "../src/commands.js";

const parsed = (text: string) => {
  const result = parseInput(text);
  return result.kind === "command" ? result.name : result.kind;
};

test("questions about the bridge itself resolve to a local lookup", () => {
  for (const text of ["你现在支持哪些 Agent?", "你当前支持哪些 Agent？", "当前支持什么Agent?",
                      "支持哪些agent", "Agent 列表", "智能体有哪些"]) {
    assert.equal(parsed(text), "agent", text);
  }
  assert.equal(parsed("有哪些项目？"), "projects");
  assert.equal(parsed("项目列表"), "projects");
  assert.equal(parsed("当前有哪些会话"), "sessions");
  assert.equal(parsed("现在什么状态"), "status");
  assert.equal(parsed("菜单"), "help");
  assert.equal(parsed("怎么用"), "help");
});

// The whole-message anchor is what keeps real work out of the local path.
test("anything carrying a task keeps going to the router", () => {
  for (const text of ["帮我看看有哪些会话需要清理", "支持哪些 Agent 的项目比较好，帮我选一个",
                      "列一下有哪些项目，然后在第一个里面建会话", "你现在支持哪些 Agent，顺便把文档更新一下",
                      "当前状态下这个 bug 要怎么修"]) {
    assert.equal(parsed(text), "message", text);
  }
});

// The three phrasings that still came back as a menu after the first fix.
test("asking which agent, project or session is selected reads the status summary", () => {
  for (const text of ["现在用的是什么Agent？", "现在是哪个 Agent", "当前的会话名字叫什么？",
                      "现在是哪个会话", "现在处于哪个项目？", "当前项目叫什么", "现在什么状态"]) {
    assert.equal(parsed(text), "status", text);
  }
});

// Two questions in one message, both about the bridge.
test("a compound question is answered locally when every clause asks the same thing", () => {
  assert.equal(parsed("现在处于哪个项目？哪个Agent下面？"), "status");
  assert.equal(parsed("当前是哪个 Agent，哪个会话？"), "status");
});

test("a compound message mixing a question with work still goes to the router", () => {
  assert.equal(parsed("现在处于哪个项目？顺便把文档更新一下"), "message");
  assert.equal(parsed("当前是哪个 Agent，帮我把它换成 Claude"), "message");
});

// Listing the agents and naming the selected one are different questions.
test("listing agents is not confused with naming the current one", () => {
  assert.equal(parsed("当前支持什么Agent？"), "agent");
  assert.equal(parsed("现在用的是什么Agent？"), "status");
});

test("the // escape still sends the literal text", () => {
  const result = parseInput("//有哪些项目");
  assert.deepEqual(result, { kind: "message", text: "/有哪些项目" });
});

test("explicit slash commands are unaffected", () => {
  assert.equal(parsed("/status"), "status");
  assert.equal(parsed("/agent codex"), "agent");
});

// End to end: the exact message that used to come back as a numbered menu.
test("asking which agents exist answers with the list and creates no job", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { BridgeCore } = await import("../src/core.js");
  const directory = mkdtempSync(join(tmpdir(), "bridge-lookup-"));
  const adapters = Object.fromEntries(["codex", "claude"].map((agent) => [agent, {
    probe: async () => ({ ready: true, reason: "Fixture" }),
    listProjects: async () => [], listSessions: async () => [],
    createSession: async () => ({ nativeId: "s1", projectId: null, title: "会话" }),
    resumeSession: async (session: unknown) => session,
    sendTurn: async () => { throw new Error("a lookup must never reach an agent"); },
  }]));
  const core = new BridgeCore(join(directory, "bridge.sqlite"), adapters as never);
  core.bindChannel("weixin", "bot", "owner");
  core.setRoutingSettings({ mode: "auto" });
  core.routeDecision = async () => { throw new Error("a lookup must never reach the router"); };
  try {
    const result = core.receive({ kind: "weixin", eventId: "e1", accountId: "bot", peerId: "owner" },
      "你现在支持哪些Agent?");
    assert.equal(result.jobId, undefined, "no task is created");
    assert.match(result.message ?? "", /Codex/);
    assert.equal(core.state().jobs.length, 0);
  } finally { core.close(); rmSync(directory, { recursive: true, force: true }); }
});
