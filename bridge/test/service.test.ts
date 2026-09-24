import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RPCPeer } from "../src/rpc.js";
import { createService } from "../src/service.js";
import type { Message } from "@photon-ai/imessage-kit";
import type { AgentAdapter } from "../src/core.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "chat-bridge-service-"));
  const ab = new PassThrough(), ba = new PassThrough();
  let nativeMutations = 0;
  const native = new RPCPeer(ba, ab, {
    "native.agent.probe": () => ({ installed: true, ready: false, reason: "G0_NOT_VERIFIED" }),
    "native.agent.create": () => { nativeMutations++; return {}; },
    "native.agent.send": () => { nativeMutations++; return {}; },
  });
  const service = createService(ab, ba, join(directory, "bridge.sqlite"));
  service.core.setRoutingSettings({ mode: "off" }); // these tests are not about routing; keep messages going straight to the current target
  return { native, service, mutations: () => nativeMutations,
    close() { native.close(); service.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("local service persists display settings through its IPC API", async () => {
  const f = fixture();
  try {
    await f.native.call("preferences.update", { pinned: ["claude", "cursor"], keepAlive: true });
    const state = await f.native.call<{ preferences: { pinned: string[]; keepAlive: boolean } }>("state.get");
    assert.deepEqual(state.preferences.pinned, ["claude", "cursor"]);
    assert.equal(state.preferences.keepAlive, true);
  } finally { f.close(); }
});

test("enabled agents are validated, saved through IPC and published with the state", async () => {
  const f = fixture();
  try {
    const initial = await f.native.call<{ preferences: { enabledAgents: string[] } }>("state.get");
    assert.deepEqual(initial.preferences.enabledAgents, ["codex", "claude", "cursor", "grok", "opencode", "hermes"]);
    for (const enabledAgents of [[], ["codex", "codex"], ["codex", "unknown"]]) {
      await assert.rejects(f.native.call("preferences.update", { enabledAgents }), { code: "INVALID_INPUT" });
    }
    const state = await f.native.call<{ preferences: { enabledAgents: string[]; defaultAgent: string } }>("preferences.update", { enabledAgents: ["cursor", "claude"] });
    assert.deepEqual(state.preferences.enabledAgents, ["claude", "cursor"]);
    assert.equal(state.preferences.defaultAgent, "claude");
    assert.deepEqual((await f.native.call<typeof state>("state.get")).preferences.enabledAgents, ["claude", "cursor"]);
  } finally { f.close(); }
});

test("IPC publishes growing Markdown beyond 1000 characters and bounds large history snapshots", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-stream-ipc-"));
  const ab = new PassThrough(), ba = new PassThrough(), native = new RPCPeer(ba, ab, {});
  let hooks: any, done!: (value: any) => void;
  const adapter: AgentAdapter = {
    probe: async () => ({ ready: true, reason: "" }),
    createSession: async () => ({ nativeId: "test", title: "Test", projectId: null }), resumeSession: async (session) => session,
    sendTurn: async (_session, _text, _id, events) => { hooks = events; hooks.started("turn"); return new Promise((resolve) => { done = resolve; }); }
  };
  const service = createService(ab, ba, join(directory, "bridge.sqlite"), { codex: adapter });
  service.core.setRoutingSettings({ mode: "off" }); // streaming/truncation is not about routing; keep messages going straight to the current target
  const snapshots: any[] = []; native.onEvent = (method, state) => { if (method === "state.changed") snapshots.push(state); };
  try {
    const job = service.core.receive({ kind: "desktop", accountId: "local", peerId: "local", eventId: "task" }, "task");
    const run = service.core.run(job.jobId!); await new Promise((resolve) => setImmediate(resolve));
    const body = "## 进度\n\n" + "已经检查。".repeat(500);
    hooks.message?.({ id: "progress", text: body, completed: false });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(snapshots.at(-1)?.messages.at(-1)?.text, body);
    assert.equal(snapshots.at(-1)?.messages.at(-1)?.truncated, false);
    for (let i = 0; i < 50; i++) hooks.message?.({ id: "long-" + i, text: "\u0001中文🙂".repeat(6000), completed: true });
    const state = await native.call<any>("state.get");
    assert.ok(Buffer.byteLength(JSON.stringify(state)) < 950 * 1024);
    assert.ok(state.messages.some((message: any) => message.truncated));
    done({ turnId: "turn", text: "done" }); await run;
  } finally { native.close(); service.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("desktop open and send cannot bypass unverified native adapter", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.native.call("agent.open", { agent: "codex" }), { code: "AGENT_UNAVAILABLE" });
    const receipt = await f.native.call<{ jobId: string }>("message.send", { text: "你好", eventId: "event", selectionVersion: 0 });
    await f.service.core.run(receipt.jobId);
    assert.equal(f.service.core.state().jobs[0]?.status, "waiting_agent");
    assert.equal(f.mutations(), 0);
  } finally { f.close(); }
});

test("IPC has no arbitrary shell, social identity, or unknown preference entry point", async () => {
  const f = fixture();
  try {
    for (const method of ["exec", "channel.bind", "channel.receive", "toString", "constructor"]) {
      await assert.rejects(f.native.call(method, {}), { code: "METHOD_NOT_FOUND" });
    }
    await assert.rejects(f.native.call("preferences.update", { executablePath: "/tmp/untrusted" }), { code: "INVALID_INPUT" });
    await assert.rejects(f.native.call("message.send", { text: 42 }), { code: "INVALID_INPUT" });
  } finally { f.close(); }
});

test("a stale desktop composer cannot send into a newly selected agent", async () => {
  const f = fixture();
  try {
    const version = f.service.core.state().selection.version;
    await f.native.call("message.send", { text: "/agent claude", eventId: "switch", selectionVersion: version });
    await assert.rejects(f.native.call("message.send",
      { text: "intended for the old composer", eventId: "stale", selectionVersion: version }), { code: "STALE_TARGET" });
    assert.equal(f.service.core.state().jobs.length, 0);
    assert.equal(f.service.core.state().selection.agent, "claude");
    await assert.rejects(f.native.call("message.send", { text: "missing version", eventId: "missing" }), { code: "INVALID_INPUT" });
  } finally { f.close(); }
});

test("channel state and cancellation are available without authorizing a social sender", async () => {
  const f = fixture();
  try {
    const state = await f.native.call<{ channels: { weixin: { status: string; connected: boolean }; imessage: { status: string; connected: boolean } } }>("state.get");
    assert.equal(state.channels?.weixin.status, "idle");
    assert.equal(state.channels.weixin.connected, false);
    assert.equal(state.channels.imessage?.status, "idle");
    await assert.rejects(f.native.call("channel.imessage.start", { email: "invalid", phone: "1234" }), { code: "INVALID_INPUT" });
    await f.native.call("channel.weixin.cancel", {});
    assert.equal(f.service.core.state().bindings.length, 0);
    await assert.rejects(f.native.call("channel.weixin.confirm", { attemptId: "not-scanned" }));
    assert.equal(f.service.core.state().bindings.length, 0);
  } finally { f.close(); }
});

test("task controls target a saved job without depending on the current composer", async () => {
  const f = fixture();
  try {
    const receipt = f.service.core.receive({ kind: "desktop", accountId: "local", peerId: "local", eventId: "task" }, "task");
    await f.service.core.run(receipt.jobId!);
    await f.native.call("task.action", { action: "cancel", jobId: receipt.jobId, eventId: "cancel-job" });
    assert.equal(f.service.core.state().jobs[0]?.status, "cancelled");
    await assert.rejects(f.native.call("task.action", { action: "exec", jobId: receipt.jobId, eventId: "bad" }), { code: "INVALID_INPUT" });
  } finally { f.close(); }
});

test("a long-polling WeChat request cannot stall iMessage task scheduling", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-independent-channels-"));
  const ab = new PassThrough(), ba = new PassThrough();
  const phone = "+6591234567", email = "bridge@example.com", chatId = "iMessage;-;" + phone;
  const native = new RPCPeer(ba, ab, {
    "native.agent.probe": () => ({ ready: false, reason: "G0_NOT_VERIFIED" }),
    "native.weixin.credential.read": () => ({ accountId: "bot", ownerId: "owner", token: "fixture",
      baseUrl: "https://ilinkai.weixin.qq.com", contextKey: Buffer.alloc(32, 4).toString("base64") }),
  });
  const service = createService(ab, ba, join(directory, "bridge.sqlite"), {
    fetchFn: (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }),
    iMessageSource: () => ({ tail: () => ({ rowId: 0, guid: "" }), matches: () => true,
      read: async (after) => after ? [] : [{ rowId: 1, id: "phone-task", text: "task", service: "iMessage", participant: phone,
        chatKind: "dm", chatId, kind: "text", isFromMe: false, attachments: [] } as unknown as Message],
      send: async () => {}, close: async () => {}, }),
  });
  service.core.setRoutingSettings({ mode: "off" }); // channel scheduling is not about routing; keep messages going straight to the current target
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    service.core.bindChannel("weixin", "bot", "owner");
    service.core.activateIMessage({ email, phone, chatId }, JSON.stringify({ rowId: 0, guid: "" }));
    const scheduled = new Promise<boolean>((resolve) => {
      native.onEvent = (method, value) => {
        if (method === "state.changed" && (value as { jobs?: { status: string }[] }).jobs?.some((job) => job.status === "waiting_agent")) resolve(true);
      };
      timer = setTimeout(() => resolve(false), 1000);
    });
    service.start();
    assert.equal(await scheduled, true, "The job must advance while getupdates is still awaiting a response.");
  } finally { clearTimeout(timer); service.close(); native.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("Codex service uses its managed runtime instead of claiming native desktop control", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-service-runtime-"));
  const ab = new PassThrough(), ba = new PassThrough();
  const native = new RPCPeer(ba, ab, { "native.agent.probe": () => ({ installed: true, ready: false, reason: "Desktop unavailable" }) });
  const sends: string[] = [];
  const service = createService(ab, ba, join(directory, "bridge.sqlite"), {
    codex: {
      probe: async () => ({ ready: true, reason: "Official runtime" }),
      createSession: async () => ({ nativeId: "managed-thread", title: "Managed", projectId: null, runtime: "codex-app-server" }),
      resumeSession: async (session: any) => session,
      sendTurn: async (session: any) => { sends.push(session.nativeId); return { turnId: "native-turn", text: "real adapter result" }; }
    }
  } as any);
  try {
    assert.equal((await native.call<{ready:boolean}>("agent.probe", { agent:"codex" })).ready, true);
    await native.call("agent.open", { agent:"codex" });
    const state = service.core.state();
    const receipt = await native.call<{jobId:string}>("message.send", {text:"hello",eventId:"runtime-task",selectionVersion:state.selection.version});
    await service.core.run(receipt.jobId);
    assert.equal(service.core.state().jobs[0]?.status, "completed");
    assert.deepEqual(sends, ["managed-thread"]);
    await assert.rejects(native.call("approval.action", { action:"acceptForSession", approvalId:"A123456789abc",eventId:"invalid" }), {code:"INVALID_INPUT"});
  } finally { native.close(); service.close(); rmSync(directory,{recursive:true,force:true}); }
});

test("native catalog IPC and slash commands select original sessions without creating or sending", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-catalog-ipc-"));
  const ab = new PassThrough(), ba = new PassThrough();
  const native = new RPCPeer(ba, ab, {});
  let mutations = 0, listings = 0;
  const adapter = {
    probe: async () => ({ ready: true, reason: "ready" }),
    listProjects: async () => { listings++; return [{ id: "project", name: "Original project", roots: [directory] }]; },
    listSessions: async () => Array.from({ length: 105 }, (_, index) => ({ nativeId: "original-" + index, title: "Session " + index, projectId: "project", updatedAt: 105 - index })),
    readHistory: async () => [{ id: "native-message", role: "assistant", text: "Existing history", createdAt: "2026-09-19T00:00:00Z" }],
    createSession: async () => { mutations++; throw new Error("Do not create while browsing"); },
    resumeSession: async () => { mutations++; throw new Error("Do not resume while browsing"); },
    sendTurn: async () => { mutations++; throw new Error("Do not send while browsing"); }
  };
  const service = createService(ab, ba, join(directory, "bridge.sqlite"), { codex: adapter, claude: adapter } as any);
  try {
    const menu = await native.call<any>("catalog.get", { agent: "codex", refresh: true });
    assert.equal(menu.sessions.length, 50); assert.equal(menu.nextOffset, 50);
    assert.equal((await native.call<any>("catalog.get", { agent: "codex", offset: 100 })).sessions.length, 5);
    await native.call("agent.open", { agent: "codex" });
    const selection = service.core.state().selection;
    const receipt = await native.call<any>("message.send", { text: "/projects", eventId: "list", selectionVersion: selection.version });
    assert.match(receipt.message, /Original project/);
    assert.ok(listings >= 2);
    await native.call("message.send", { text: "/use " + menu.sessions[0].shortId, eventId: "choose", selectionVersion: selection.version });
    await new Promise((resolve) => setImmediate(resolve));
    const state = await native.call<any>("state.get");
    assert.equal(state.messages[0].text, "Existing history");
    assert.ok(state.sessions.some((session: any) => session.id === state.selection.sessionId));
    assert.equal(mutations, 0);
    await assert.rejects(native.call("catalog.get", { agent: "codex", offset: -1 }), { code: "INVALID_INPUT" });
  } finally { native.close(); service.close(); rmSync(directory, { recursive: true, force: true }); }
});
