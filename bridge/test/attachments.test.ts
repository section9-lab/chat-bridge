import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { closeSync, ftruncateSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RPCPeer } from "../src/rpc.js";
import { createService } from "../src/service.js";
import type { AgentAdapter, NativeMessage } from "../src/core.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "bridge-attachments-"));
  const input = new PassThrough(), output = new PassThrough(), native = new RPCPeer(output, input, {});
  const prompts: string[] = [], history: NativeMessage[] = [];
  const adapter: AgentAdapter = {
    probe: async () => ({ ready: true, reason: "" }),
    createSession: async () => ({ nativeId: "thread", title: "Files", projectId: null }),
    resumeSession: async session => session,
    readHistory: async () => history,
    sendTurn: async (_session, prompt, id, hooks) => {
      prompts.push(prompt); hooks?.started?.(id);
      history.push({ id: id + ":u", role: "user", text: prompt, createdAt: "1" },
        { id: id + ":a", role: "assistant", text: "文件已收到", createdAt: "2" });
      return { turnId: id, text: "文件已收到" };
    },
  };
  const service = createService(input, output, join(directory, "bridge.sqlite"), { codex: adapter });
  service.core.setRoutingSettings({ mode: "off" }); // attachments are not about routing; keep messages going straight to the current target
  return { directory, native, service, prompts,
    close() { native.close(); service.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("desktop files are copied, sent to the Agent, and retained with reply quotes after history refresh", async () => {
  const f = fixture();
  try {
    const source = join(f.directory, "设计 说明.txt"); writeFileSync(source, "选中时的内容");
    const [file] = await f.native.call<any[]>("attachments.import", { paths: [source] });
    assert.equal(file.name, "设计 说明.txt");
    assert.notEqual(file.path, source);
    writeFileSync(source, "后来改动的内容");
    assert.equal(readFileSync(file.path, "utf8"), "选中时的内容");
    const receipt = await f.native.call<any>("message.send", { text: "请查看文件", attachmentIds: [file.id], eventId: "files", selectionVersion: 0 });
    await f.service.core.run(receipt.jobId);
    assert.ok(f.prompts[0]?.includes(file.path));
    let messages = f.service.core.state().messages as any[];
    assert.equal(messages[0].text, "请查看文件");
    assert.equal(messages[0].attachments[0].id, file.id);
    assert.equal(messages[0].source, "desktop");
    assert.deepEqual(messages[1].replyTo, { id: messages[0].id, text: "请查看文件" });
    await f.service.core.loadHistory(f.service.core.state().selection.sessionId!);
    messages = (await f.native.call<any>("state.get")).messages;
    assert.equal(messages[0].text, "请查看文件", "Internal file paths must not replace the user's message after refresh");
    assert.equal(messages[0].attachments[0].id, file.id);
    assert.equal(messages[0].source, "desktop", "The message source must survive a history refresh");
    assert.deepEqual(messages[1].replyTo, { id: messages[0].id, text: "请查看文件" });
  } finally { f.close(); }
});

test("attachment-only messages work and an unknown attachment cannot be sent", async () => {
  const f = fixture();
  try {
    const source = join(f.directory, "note.txt"); writeFileSync(source, "hello");
    const [file] = await f.native.call<any[]>("attachments.import", { paths: [source] });
    await assert.rejects(f.native.call("message.send", { text: "hello", attachmentIds: ["missing"], eventId: "invalid", selectionVersion: 0 }), { code: "INVALID_ATTACHMENT" });
    assert.equal(f.service.core.state().jobs.length, 0);
    const request = { text: "", attachmentIds: [file.id], eventId: "only-file", selectionVersion: 0 };
    const receipt = await f.native.call<any>("message.send", request);
    await f.service.core.run(receipt.jobId);
    assert.equal(f.prompts.length, 1);
    assert.ok(f.prompts[0]?.includes(file.path));
    assert.equal((f.service.core.state().messages[0] as any).attachments[0].id, file.id);
  } finally { f.close(); }
});

test("file validation rejects folders, missing files, too many files, and files above 50 MiB", async () => {
  const f = fixture();
  try {
    const large = join(f.directory, "large.bin"), descriptor = openSync(large, "w");
    ftruncateSync(descriptor, 50 * 1024 * 1024 + 1); closeSync(descriptor);
    for (const paths of [[f.directory], [join(f.directory, "missing")], [large], Array(11).fill(large), ["relative.txt"]]) {
      await assert.rejects(f.native.call("attachments.import", { paths }), { code: "INVALID_ATTACHMENT" });
    }
    assert.equal(f.service.core.state().jobs.length, 0);
  } finally { f.close(); }
});

test("attachments survive stale target rejection and attached command text is treated as a task", async () => {
  const f = fixture();
  try {
    const source = join(f.directory, "note.txt"); writeFileSync(source, "hello");
    const [file] = await f.native.call<any[]>("attachments.import", { paths: [source] });
    await f.native.call("message.send", { text: "/new", eventId: "new", selectionVersion: 0 });
    await assert.rejects(f.native.call("message.send", { text: "查看文件", attachmentIds: [file.id], eventId: "stale", selectionVersion: 0 }), { code: "STALE_TARGET" });
    const receipt = await f.native.call<any>("message.send", { text: "/new", attachmentIds: [file.id], eventId: "with-file", selectionVersion: f.service.core.state().selection.version });
    assert.ok(receipt.jobId);
    await f.service.core.run(receipt.jobId);
    assert.ok(f.prompts[0]?.includes(file.path));
    assert.equal(f.service.core.state().jobs.length, 1);
  } finally { f.close(); }
});

test("a routing failure with an explicitly opened agent still delivers the attachment there", async () => {
  const f = fixture();
  try {
    const source = join(f.directory, "note.txt"); writeFileSync(source, "hello");
    const files = await f.native.call<any[]>("attachments.import", { paths: [source] });
    f.service.core.setRoutingSettings({ mode: "auto" });
    f.service.core.routeDecision = async () => { throw new Error("offline"); };
    await f.service.core.openAgent("codex");
    const origin = { kind: "desktop" as const, accountId: "local", peerId: "local", eventId: "route-file" };
    const receipt = f.service.core.receive(origin, "读取附件", undefined, files);
    await f.service.core.run(receipt.jobId!);
    const job = f.service.core.state().jobs[0]!;
    assert.equal(job.status, "completed");
    assert.ok(f.prompts[0]?.includes(files[0].path));
  } finally { f.close(); }
});

test("routing failure with no established target retains attachments until one is selected", async () => {
  const f = fixture();
  try {
    const source = join(f.directory, "note.txt"); writeFileSync(source, "hello");
    const files = await f.native.call<any[]>("attachments.import", { paths: [source] });
    f.service.core.setRoutingSettings({ mode: "auto" });
    f.service.core.routeDecision = async () => { throw new Error("offline"); };
    const origin = { kind: "desktop" as const, accountId: "local", peerId: "local", eventId: "route-file" };
    const receipt = f.service.core.receive(origin, "读取附件", undefined, files);
    await f.service.core.run(receipt.jobId!);
    const job = f.service.core.state().jobs[0]!;
    assert.equal(job.status, "awaiting_route");
    assert.equal(job.attachments?.[0]?.id, files[0].id);
    // Nothing is engaged yet, so no destination is guessed: only manual selection is offered, and the file is not lost.
    assert.deepEqual(job.routing!.options, []);
  } finally { f.close(); }
});

test("a routing clarification carries its new attachments into the original task", async () => {
  const f = fixture();
  try {
    const source = join(f.directory, "note.txt"); writeFileSync(source, "hello");
    const files = await f.native.call<any[]>("attachments.import", { paths: [source] });
    f.service.core.setRoutingSettings({ mode: "auto" });
    const answer = (choice: string) => ({ choice, confidence: 1, probabilities: { [choice]: 1 } });
    const origin = { kind: "desktop" as const, accountId: "local", peerId: "local", eventId: "original" };
    f.service.core.routeDecision = async () => answer("clarify");
    const original = f.service.core.receive(origin, "分析这份材料");
    await f.service.core.run(original.jobId!);
    f.service.core.routeDecision = async context => answer(context.text === "补充材料" ? "answer_" + original.jobId : "new_codex_none");
    const followup = f.service.core.receive({ ...origin, eventId: "followup" }, "补充材料", undefined, files);
    await f.service.core.run(followup.jobId!);
    assert.equal(f.prompts.length, 1);
    assert.ok(f.prompts[0]?.includes(files[0].path));
  } finally { f.close(); }
});

test("a non-sending route cannot silently consume attached files", async () => {
  const f = fixture();
  try {
    const source = join(f.directory, "note.txt"); writeFileSync(source, "hello");
    const files = await f.native.call<any[]>("attachments.import", { paths: [source] });
    f.service.core.setRoutingSettings({ mode: "auto" });
    f.service.core.routeDecision = async () => ({ choice: "list_status", confidence: 1, probabilities: { list_status: 1 } });
    const receipt = f.service.core.receive({ kind: "desktop", accountId: "local", peerId: "local", eventId: "files" }, "检查文件", undefined, files);
    await f.service.core.run(receipt.jobId!);
    assert.equal(f.service.core.state().jobs[0]?.status, "awaiting_route");
    assert.equal(f.prompts.length, 0);
  } finally { f.close(); }
});
