import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CodexRuntime } from "../bridge/dist/src/codex.js";
import { ClaudeRuntime } from "../bridge/dist/src/claude.js";

const [agent, executable] = process.argv.slice(2);
assert.ok(["codex", "claude"].includes(agent) && executable?.startsWith("/"));
const workspace = await mkdtemp(join(tmpdir(), "chat-bridge-stream-"));
const Runtime = agent === "codex" ? CodexRuntime : ClaudeRuntime;
const runtime = new Runtime({ workspace, locate: async () => ({ installed: true, executablePath: executable }) });
const report = { agent, timestamp: new Date().toISOString(), passed: false, partialUpdates: 0, completedMessages: 0,
  scope: "Real authenticated local runtime in a new isolated session. No existing session or social channel used; prompt forbids tools, network and file changes." };
const timeout = setTimeout(() => runtime.close(), 120_000);
try {
  assert.equal((await runtime.probe()).ready, true, "Existing runtime login must be ready");
  const session = await runtime.createSession({ agent, mode: "code", projectId: null }, randomUUID());
  const completed = new Set(), text = new Map();
  let settled = false;
  const result = await runtime.sendTurn(session,
    "这是 Chat Bridge 正文流测试。不要调用任何工具，不读取文件，不访问网络，不执行命令。请先给一句用户可见的进度说明，再输出约 180 字中文，解释如何整理读书笔记；包含 Markdown 标题、两项列表，最后一行写 STREAM_OK。", randomUUID(), {
      message(update) {
        assert.equal(settled, false, "Text arrives before the turn promise resolves");
        assert.equal(completed.has(update.id), false, "Completed messages are not replayed");
        text.set(update.id, update.text);
        if (update.completed) { completed.add(update.id); report.completedMessages++; }
        else report.partialUpdates++;
      },
      approval: async () => "decline"
    });
  settled = true;
  assert.equal(result.status, "completed");
  assert.ok(report.partialUpdates > 0, "Real incremental text events must be observed");
  assert.ok(report.completedMessages > 0);
  assert.ok([...text.values()].join("\n").includes("STREAM_OK"));
  report.passed = true;
} catch (error) {
  report.error = String(error.message).slice(0, 500); process.exitCode = 1;
} finally {
  clearTimeout(timeout); runtime.close();
  await writeFile(new URL(`../docs/verification/streaming-${agent}-runtime-2026-09-19.json`, import.meta.url), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
}
