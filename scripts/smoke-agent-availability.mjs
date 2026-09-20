import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { ACPRuntime, acpAgentIDs } from "../bridge/dist/src/acp.js";
import { CodexRuntime } from "../bridge/dist/src/codex.js";
import { ClaudeRuntime } from "../bridge/dist/src/claude.js";

const [agent, executable, action] = process.argv.slice(2);
assert.ok(["codex", "claude", ...acpAgentIDs].includes(agent) && executable && isAbsolute(executable));
assert.ok(!action || action === "--send");
const workspace = await mkdtemp(join(tmpdir(), "chat-bridge-availability-"));
const options = { id: agent, workspace, locate: async () => ({ installed: true, executablePath: executable }) };
const Runtime = agent === "codex" ? CodexRuntime : agent === "claude" ? ClaudeRuntime : ACPRuntime;
const runtime = new Runtime(options);
const report = { agent, timestamp: new Date().toISOString(), passed: false, probe: null, sends: 0, streamedUpdates: 0,
  scope: "Isolated local runtime. Existing sessions and social channels are not used. Test prompts forbid tools and file changes." };
const timeout = setTimeout(() => runtime.close(), 120_000);
try {
  report.probe = await runtime.probe();
  if (action === "--send") {
    assert.equal(report.probe.ready, true);
    const session = await runtime.createSession({ agent, mode: "code", projectId: null }, randomUUID());
    const hooks = { message: (update) => { if (!update.completed) report.streamedUpdates++; }, approval: async () => "decline" };
    const first = await runtime.sendTurn(await runtime.resumeSession(session),
      "这是 Chat Bridge 连通性测试。不要调用工具，不读取文件，不访问网络，不执行命令。请记住校验词 CB_CHECK_7321，只回复这个校验词。", randomUUID(), hooks);
    report.sends++;
    report.firstTurn = { status: first.status, matched: first.text.includes("CB_CHECK_7321") };
    assert.equal(first.status, "completed"); assert.ok(first.text.includes("CB_CHECK_7321"));
    const resumed = await runtime.resumeSession(session);
    assert.equal(resumed.nativeId, session.nativeId);
    const second = await runtime.sendTurn(resumed, "继续连通性测试，不调用任何工具。上一条用户消息要求你记住的校验词是什么？只回复该校验词。", randomUUID(), hooks);
    report.sends++;
    assert.equal(second.status, "completed"); assert.ok(second.text.includes("CB_CHECK_7321"));
    assert.ok(report.streamedUpdates > 0);
    report.sameSessionVerified = true;
  }
  report.passed = true;
} catch (error) {
  report.error = { name: error.constructor.name, code: error.code ?? "CHECK_FAILED" };
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  report.finalProbe = await runtime.probe();
  runtime.close();
  await writeFile(new URL(`../docs/verification/availability-${agent}-runtime-2026-09-20.json`, import.meta.url), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
}
