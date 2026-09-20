import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { BridgeCore, type AgentAdapter } from "../src/core.js";
import { attachmentBytes, snapshotOutputs } from "../src/outputs.js";

function fixture(nativeBinding = false) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "bridge-outputs-"))), workspace = join(dir, "workspace"), project = join(workspace, "ember");
  mkdirSync(project, { recursive: true }); writeFileSync(join(project, "project.godot"), '[application]\nconfig/name="余烬远征"');
  let text = "", bindings = 0;
  const sends: any[] = [];
  const adapter: AgentAdapter = {
    probe: async () => ({ ready: true, reason: "Fixture" }), listProjects: async () => [],
    listSessions: async () => [{ nativeId: "native", title: "原始的很长的创建项目需求".repeat(10), projectId: null, cwd: workspace }],
    createSession: async target => ({ nativeId: "native", title: "Codex 新会话", projectId: target.projectId, cwd: workspace }),
    resumeSession: async session => session,
    sendTurn: async (session, prompt, id, hooks) => { sends.push({ session, prompt }); hooks?.started?.(id); return { turnId: id, text }; },
  };
  if (nativeBinding) Object.assign(adapter, { bindProject: async (session: any, value: any, title: string) => {
    bindings++; return { project: { id: "native-project", name: value.name, roots: [value.root] }, session: { ...session, projectId: "native-project", title } };
  } });
  const core = new BridgeCore(join(dir, "bridge.sqlite"), { codex: adapter }); core.bindChannel("weixin", "bot", "owner");
  let sequence = 0;
  const send = async (prompt: string) => { const receipt = core.receive({ kind: "weixin", accountId: "bot", peerId: "owner", eventId: String(++sequence) }, prompt);
    await core.run(receipt.jobId!); return receipt; };
  return { core, adapter, dir, workspace, project, sends, send, text: (value: string) => { text = value; }, bindings: () => bindings,
    close() { core.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("a completed project result binds the original native session and uses a short title", async () => {
  const f = fixture(true);
  try {
    f.text(`项目已创建：[项目文件夹](<${f.project}>)`); const created = await f.send("创建一个卡牌游戏项目");
    const selected = f.core.state().selection, session = f.core.state().sessions.find(s => s.id === selected.sessionId)!;
    assert.equal(f.bindings(), 1); assert.equal(session.projectId, "native-project"); assert.equal(session.nativeId, "native");
    assert.equal(selected.projectId, "native-project"); assert.ok(session.title.length <= 48);
    assert.equal(f.core.state().projects[0]?.name, "余烬远征");
    assert.match(f.core.state().jobs.find(j => j.id === created.jobId)!.routeMessage!, /Codex > 余烬远征.*项目已就绪/);
    f.text("继续完成"); await f.send("继续测试这个游戏");
    assert.equal(f.sends[1].session.nativeId, "native"); assert.equal(f.sends[1].session.projectId, "native-project");
    assert.ok(f.core.outbox().some(e => e.kind === "receipt" && /Codex > 余烬远征/.test(e.text)));
  } finally { f.close(); }
});

test("a local project association survives catalog refresh without moving the native session", async () => {
  const f = fixture();
  try {
    f.text(`已经创建 [项目](<${f.project}>)`); await f.send("创建游戏");
    const before = f.core.state().selection;
    assert.equal(before.projectId, f.project);
    await f.core.refreshCatalog("codex");
    const session = f.core.state().sessions.find(s => s.id === before.sessionId)!;
    assert.equal(session.projectId, f.project); assert.equal(session.cwd, f.workspace);
    assert.ok(session.title.length <= 48);
    f.text("完成"); await f.send("继续这个项目"); assert.equal(f.sends[1].session.nativeId, "native");
  } finally { f.close(); }
});

test("an incomplete desktop registration is reported without losing the completed task or original session", async () => {
  const f = fixture(true);
  try {
    const bind = f.adapter.bindProject!;
    const notice = "Codex 项目侧栏尚未添加这个文件夹：" + f.project;
    f.adapter.bindProject = async (...args) => ({ ...await bind(...args), notice });
    f.text(`[项目](<${f.project}>)`);
    const result = await f.send("创建卡牌游戏");
    const job = f.core.state().jobs.find(j => j.id === result.jobId)!;
    assert.equal(job.status, "completed");
    assert.equal(f.core.state().sessions.find(s => s.id === job.sessionId)?.nativeId, "native");
    assert.ok(job.routeMessage?.includes(notice));
    const message = f.core.outbox().find(e => e.jobId === result.jobId && e.kind === "status" && e.text.includes(notice))!;
    assert.ok(message.text.includes(notice));
    assert.doesNotMatch(message.text, /项目已就绪/);
    f.text("完成"); await f.send("继续测试");
    assert.equal(f.sends[1].session.nativeId, "native");
  } finally { f.close(); }
});

test("folder trust is approved from the originating chat in plain language without creating another task", async () => {
  const f = fixture(true); let run: Promise<unknown> | undefined, decision: string | undefined;
  try {
    const bind = f.adapter.bindProject!;
    (f.adapter as any).bindProject = async (session: any, project: any, title: string, approval: any) => {
      decision = await approval({ kind: "projectTrust", cwd: project.root, reason: "将余烬远征添加到 Codex", detail: "允许读取、修改和执行此目录。" });
      return bind(session, project, title);
    };
    f.text(`[项目](<${f.project}>)`); run = f.send("创建游戏");
    for (let i = 0; i < 100 && !f.core.state().approvals.some(a => a.status === "pending"); i++) await new Promise(resolve => setImmediate(resolve));
    const notice = f.core.outbox().find(e => e.kind === "approval");
    assert.match(notice?.text ?? "", /信任此项目/);
    assert.doesNotMatch(notice!.text, /\/approve|J[a-f0-9]{12}/);
    assert.equal(decision, undefined);
    f.core.bindChannel("imessage", "mail", "other-owner");
    f.core.receive({ kind: "imessage", accountId: "mail", peerId: "other-owner", eventId: "wrong-channel" }, "信任此项目");
    assert.equal(decision, undefined);
    assert.equal(f.core.state().approvals[0]!.status, "pending", "Another bound channel cannot grant this consent");
    const reply = await f.send("信任此项目"); await run;
    assert.equal(reply.jobId, undefined); assert.equal(decision, "accept");
    assert.equal(f.core.state().jobs.length, 1); assert.equal(f.core.state().jobs[0]!.status, "completed");
    assert.equal(f.sends.length, 1);
    const duplicate = await f.send("信任此项目");
    assert.equal(duplicate.jobId, undefined); assert.equal(f.core.state().jobs.length, 1);
  } finally { f.close(); await run; }
});

test("unrelated, missing or ambiguous directories cannot silently become the project", async () => {
  const f = fixture(true);
  try {
    const second = join(f.workspace, "other"); mkdirSync(second); writeFileSync(join(second, "package.json"), '{}');
    f.text(`[一个项目](${f.project}) [另一个项目](${second})`); await f.send("比较两个目录");
    assert.equal(f.bindings(), 0); assert.equal(f.core.state().selection.projectId, null);
    f.text(`[不存在](${join(f.workspace, "missing")})`); await f.send("检查目录"); assert.equal(f.bindings(), 0);
  } finally { f.close(); }
});

test("generated video and document links become durable attachments without duplicating sends", async () => {
  const f = fixture();
  try {
    const video = join(f.project, "试玩 视频.mp4"), report = join(f.project, "报告.pdf");
    writeFileSync(video, "fixture-video"); writeFileSync(report, "fixture-pdf");
    f.text(`![试玩](<${video}>)\n[报告](${encodeURI(report)})\n[再次查看](<${video}>)`);
    const receipt = await f.send("录制视频并把报告发给我");
    const files = f.core.outbox().filter(e => e.kind === "attachment") as any[];
    assert.equal(files.length, 2); assert.deepEqual(files.map(e => e.attachment.name), ["试玩 视频.mp4", "报告.pdf"]);
    assert.equal(basename(files[0].attachment.path), "试玩 视频.mp4", "iMessage displays the name of the actual file");
    assert.equal(files[0].origin.kind, "weixin"); assert.equal(files[0].jobId, receipt.jobId);
    writeFileSync(video, "changed after completion");
    assert.equal(readFileSync(files[0].attachment.path, "utf8"), "fixture-video");
    await f.core.run(receipt.jobId!); assert.equal(f.core.outbox().filter(e => e.kind === "attachment").length, 2);
    assert.equal(f.sends.length, 1);
  } finally { f.close(); }
});

test("attachment collection excludes outside files, symlink escapes and source-code references", async () => {
  const f = fixture();
  try {
    const outside = join(f.dir, "private.pdf"), linked = join(f.project, "escape.pdf"), source = join(f.project, "main.ts");
    writeFileSync(outside, "private"); symlinkSync(outside, linked); writeFileSync(source, "code");
    f.text(`[outside](${outside}) [escape](${linked}) [source](${source}:12) [remote](https://example.com/file.pdf)`);
    await f.send("检查项目"); assert.equal(f.core.outbox().filter(e => e.kind === "attachment").length, 0);
  } finally { f.close(); }
});

test("project binding during a follow-up inference keeps the same session executable", async () => {
  const f = fixture(true);
  let finish!: () => void, route!: () => void, deciding = false;
  const finished = new Promise<void>(resolve => { finish = resolve; }), decided = new Promise<void>(resolve => { route = resolve; });
  const original = f.adapter.sendTurn;
  f.adapter.sendTurn = async (...args) => { const result = await original(...args); await finished; return result; };
  try {
    f.text(`[项目](<${f.project}>)`);
    const first = f.send("创建游戏");
    while (!f.sends.length) await new Promise(resolve => setImmediate(resolve));
    f.core.setRoutingSettings({ mode: "auto" });
    f.core.routeDecision = async () => { deciding = true; await decided; return { choice: "continue", confidence: 1, probabilities: { continue: 1 } }; };
    const next = f.send("接着测试");
    while (!deciding) await new Promise(resolve => setImmediate(resolve));
    finish(); await first; route(); await next;
    assert.equal(f.sends.length, 2);
    assert.equal(f.sends[1].session.projectId, "native-project");
    assert.equal(f.sends[1].session.nativeId, f.sends[0].session.nativeId);
  } finally { finish(); route(); f.close(); }
});

test("a changed attachment snapshot is rejected before external transmission", () => {
  const f = fixture();
  try {
    const source = join(f.project, "成果.pdf"); writeFileSync(source, "original");
    const attachment = snapshotOutputs(`[报告](${source})`, f.workspace, join(f.dir, "Outgoing")).files[0]!;
    writeFileSync(attachment.path, "tampered");
    assert.throws(() => attachmentBytes(attachment), /校验失败/);
  } finally { f.close(); }
});
