import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RPCPeer } from "../bridge/dist/src/rpc.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const bundle = join(process.argv[2] ? resolve(process.argv[2]) : join(root, "dist/Chat Bridge.app"), "Contents");
const report = process.argv[3] ? resolve(process.argv[3]) : join(root, "dist/bundle-smoke.json");
const runtime = join(bundle, "Resources/runtime/node");
const entry = join(bundle, "Resources/service/dist/src/main.js");
const version = JSON.parse(await readFile(join(bundle, "Resources/service/package.json"), "utf8")).version;
const directory = await mkdtemp(join(tmpdir(), "chat-bridge-bundle-"));
let active;
let nativeMutations = 0;
let keychainReads = 0;
const checks = [];
async function start() {
  const child = spawn(runtime, [entry, "--data-dir", directory], { stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin", HOME: tmpdir() } });
  const completion = once(child, "exit");
  child.stderr.resume();
  const peer = new RPCPeer(child.stdout, child.stdin, {
    "native.agent.probe": () => ({ installed: true, ready: false, reason: "G0_NOT_VERIFIED" }),
    "native.agent.create": () => { nativeMutations++; throw new Error("Must not create"); },
    "native.agent.send": () => { nativeMutations++; throw new Error("Must not send"); },
    "native.weixin.credential.read": () => { keychainReads++; return null; },
  }, 5000);
  let announcedVersion;
  peer.onEvent = (method, params) => { if (method === "service.ready") announcedVersion = params.version; };
  active = { child, peer };
  return {
    peer,
    get announcedVersion() { return announcedVersion; },
    async stop() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      const [code] = await completion;
      clearTimeout(timer); peer.close();
      assert.equal(code, 0, "service should exit cleanly when parent closes stdin");
      active = undefined;
    },
  };
}
try {
  let service = await start();
  const initial = await service.peer.call("state.get");
  assert.equal(service.announcedVersion, version, "The running helper must report the packaged release version");
  checks.push({ id: "BUNDLE-09", passed: true, description: "The running helper announces the stamped release version." });
  assert.equal(initial.preferences.defaultAgent, "codex");
  assert.deepEqual(initial.preferences.pinned, ["codex", "claude", "cursor"]);
  assert.equal(initial.preferences.keepAlive, false);
  checks.push({ id: "BUNDLE-01", passed: true, description: "Bundled Node and native SQLite load; default preferences are correct." });
  await service.peer.call("preferences.update", { defaultAgent: "claude", pinned: ["claude", "cursor"], keepAlive: true });
  await assert.rejects(service.peer.call("agent.open", { agent: "codex" }), { code: "AGENT_UNAVAILABLE" });
  for (const agent of ["cursor", "grok", "opencode", "hermes"]) {
    await assert.rejects(service.peer.call("agent.open", { agent }), { code: "AGENT_UNAVAILABLE" });
  }
  await assert.rejects(service.peer.call("exec", {}), { code: "METHOD_NOT_FOUND" });
  assert.equal(nativeMutations, 0);
  checks.push({ id: "BUNDLE-02", passed: true, description: "All six adapters reject missing runtimes; unknown IPC methods are rejected without native mutation." });
  assert.equal(initial.channels.weixin.connected, false);
  assert.equal(initial.channels.imessage.connected, false);
  assert.equal(initial.channels.weixin.status, "idle");
  assert.equal(initial.channels.imessage.status, "idle");
  await assert.rejects(service.peer.call("channel.imessage.start", { email: "invalid", phone: "1234" }), { code: "INVALID_INPUT" });
  await assert.rejects(service.peer.call("channel.weixin.confirm", { attemptId: "not-scanned" }));
  assert.equal(keychainReads, 0);
  assert.ok((await readFile(join(bundle, "Resources/service/node_modules/@photon-ai/imessage-kit/dist/index.js"), "utf8")).includes("var RETRY_ATTEMPTS = 1;"));
  checks.push({ id: "BUNDLE-06", passed: true, description: "Packaged channel APIs stay dormant, reject invalid binding, and contain the single-attempt iMessage patch." });
  const help = await service.peer.call("message.send", { text: "/help", eventId: "fixture-help", selectionVersion: 1 });
  const menu = await service.peer.call("message.send", { text: "菜单", eventId: "fixture-menu", selectionVersion: 1 });
  assert.match(help.message, /命令指南/);
  assert.match(help.message, /\/status/);
  assert.equal(menu.message, help.message);
  assert.equal((await service.peer.call("state.get")).jobs.length, 0);
  assert.equal(nativeMutations, 0);
  checks.push({ id: "BUNDLE-08", passed: true, description: "Packaged /help and Chinese menu return the command guide without creating an Agent task." });
  const job = await service.peer.call("message.send", { text: "Fixture task", eventId: "fixture-task", selectionVersion: 1 });
  const cancelled = await service.peer.call("task.action", { action: "cancel", jobId: job.jobId, eventId: "fixture-cancel" });
  assert.equal(cancelled.jobs.find((item) => item.id === job.jobId)?.status, "cancelled");
  assert.equal(nativeMutations, 0);
  checks.push({ id: "BUNDLE-07", passed: true, description: "Packaged task controls cancel an unsent task without invoking a native Agent." });
  await service.stop();
  checks.push({ id: "BUNDLE-03", passed: true, description: "Helper exits after parent closes its inherited pipe." });
  service = await start();
  const restored = await service.peer.call("state.get");
  assert.equal(restored.preferences.defaultAgent, "claude");
  assert.deepEqual(restored.preferences.pinned, ["claude", "cursor"]);
  assert.equal(restored.preferences.keepAlive, true);
  assert.equal(restored.sessions.length, 0);
  await service.stop();
  checks.push({ id: "BUNDLE-04", passed: true, description: "Preferences survive a real process restart; no replacement session was created." });
  assert.equal((await stat(join(directory, "bridge.sqlite"))).mode & 0o777, 0o600);
  checks.push({ id: "BUNDLE-05", passed: true, description: "Database permissions are owner read/write only." });
  const hashes = {};
  for (const name of ["MacOS/ChatBridge", "Resources/runtime/node",
    "Resources/service/node_modules/better-sqlite3/build/Release/better_sqlite3.node"]) {
    hashes[name] = createHash("sha256").update(await readFile(join(bundle, name))).digest("hex");
  }
  const evidence = { version, timestamp: new Date().toISOString(), platform: process.platform, arch: process.arch,
    checks, hashes, scope: "Real bundled helper and SQLite; native Agent responses were fixtures with ready=false. No social account or desktop session was accessed." };
  await mkdir(dirname(report), { recursive: true });
  await writeFile(report, JSON.stringify(evidence, null, 2) + "\n");
  console.log("Bundle smoke: " + checks.length + "/" + checks.length + " passed.");
} finally {
  if (active) { active.peer.close(); active.child.kill("SIGTERM"); }
  await rm(directory, { recursive: true, force: true });
}
