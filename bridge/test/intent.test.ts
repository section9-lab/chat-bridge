import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIntent } from "../src/intent.js";

test("natural task phrases are recognized without slash commands", () => {
  assert.deepEqual(parseIntent("任务"), { kind: "task-list" });
  assert.deepEqual(parseIntent("看看任务"), { kind: "task-list" });
  assert.deepEqual(parseIntent("进度"), { kind: "task-list" });
  assert.deepEqual(parseIntent("新任务"), { kind: "new-task" });
  assert.deepEqual(parseIntent("新任务：写请假邮件"), { kind: "new-task", text: "写请假邮件" });
  assert.deepEqual(parseIntent("新任务 写请假邮件"), { kind: "new-task", text: "写请假邮件" });
  assert.deepEqual(parseIntent("继续登录 bug"), { kind: "switch-task", query: "登录 bug" });
  assert.deepEqual(parseIntent("回到写请假邮件"), { kind: "switch-task", query: "写请假邮件" });
  assert.deepEqual(parseIntent("停一下"), { kind: "stop" });
  assert.deepEqual(parseIntent("同意"), { kind: "approval", decision: "approve" });
  assert.deepEqual(parseIntent("拒绝"), { kind: "approval", decision: "deny" });
});

test("ordinary task text is not mistaken for a command", () => {
  assert.equal(parseIntent("帮我修登录 bug"), undefined);
  assert.equal(parseIntent("继续"), undefined);
  assert.equal(parseIntent("2"), undefined);
  assert.equal(parseIntent("可以帮我看看这个吗"), undefined);
});

test("target phrases only match known agents", () => {
  assert.deepEqual(parseIntent("换成 Claude"), { kind: "target-agent", agent: "claude" });
  assert.deepEqual(parseIntent("用 Cursor"), { kind: "target-agent", agent: "cursor" });
  assert.equal(parseIntent("用一下这个"), undefined);
});
