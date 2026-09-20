import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { BridgeCore } from "../src/core.js";
import { OutboxDispatcher } from "../src/delivery.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "bridge-onboarding-")), file = join(directory, "bridge.sqlite");
  const core = new BridgeCore(file, {});
  return { core, file, close() { core.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("each confirmed channel gets one usable command guide without creating an Agent task", () => {
  const f = fixture();
  try {
    const selection = f.core.state().selection;
    for (const kind of ["imessage", "weixin"] as const) {
      f.core.bindChannel(kind, "account", "owner");
      f.core.bindChannel(kind, "account", "owner");
      const entries = f.core.outbox().filter((entry) => entry.origin.kind === kind);
      assert.equal(entries.length, 1);
      const guide = entries[0]!;
      assert.equal(guide.kind, "onboarding");
      assert.equal(guide.status, "pending");
      assert.equal(guide.origin.peerId, "owner");
      assert.equal(f.core.canReplyTo(guide.origin), true);
      assert.ok(Buffer.byteLength(guide.text) <= 1800, "The guide should fit in one channel message.");
      for (const command of ["/status", "/agent", "/mode", "/projects", "/project none", "/sessions", "/sessions all", "/more", "/new", "/stop J", "/continue J", "/cancel J", "/approve A", "/deny A", "/help"]) {
        assert.ok(guide.text.includes(command), command);
      }
      assert.match(guide.text, /回复.*01.*02/);
      assert.doesNotMatch(guide.text, /\/project P|\/use S|\/more M/);
      assert.match(guide.text, /实际.*编号/);
      assert.ok(!/\/retry/.test(guide.text), "Do not teach commands that are not implemented.");
    }
    const origin = { kind: "desktop" as const, accountId: "local", peerId: "local", eventId: "help" };
    const help = f.core.receive(origin, "/help").message!;
    assert.match(help, /命令指南/);
    assert.ok(f.core.outbox()[0]!.text.endsWith(help));
    assert.equal(f.core.receive({ ...origin, eventId: "menu" }, "菜单").message, help);
    assert.deepEqual(f.core.state().selection, selection);
    assert.equal(f.core.state().jobs.length, 0);
    assert.equal(f.core.state().sessions.length, 0);
  } finally { f.close(); }
});

test("pending guides survive restart and submitted guides are not repeated", async () => {
  const f = fixture();
  try {
    f.core.bindChannel("weixin", "account", "owner");
    const guide = f.core.outbox()[0];
    assert.ok(guide);
    f.core.close();
    const restored = new BridgeCore(f.file, {});
    try {
      assert.deepEqual(restored.outbox(), [guide]);
      let sends = 0;
      const dispatcher = new OutboxDispatcher(restored, "weixin", () => true, async () => { sends++; });
      await Promise.all([dispatcher.drain(), dispatcher.drain()]);
      restored.bindChannel("weixin", "account", "owner");
      await dispatcher.drain();
      assert.equal(sends, 1);
      assert.equal(restored.outbox()[0]?.status, "submitted");
    } finally { restored.close(); }
    const restarted = new BridgeCore(f.file, {});
    try {
      restarted.bindChannel("weixin", "account", "owner");
      await new OutboxDispatcher(restarted, "weixin", () => true, async () => { assert.fail("Repeated guide"); }).drain();
      assert.equal(restarted.outbox().length, 1);
    } finally { restarted.close(); }
  } finally { f.close(); }
});

test("unbinding cancels the old guide and a new binding receives its own guide", () => {
  const f = fixture();
  try {
    f.core.bindChannel("weixin", "account", "owner");
    f.core.unbindChannel("weixin");
    f.core.bindChannel("weixin", "account", "owner");
    const [oldGuide, newGuide] = f.core.outbox();
    assert.equal(oldGuide?.status, "cancelled");
    assert.equal(newGuide?.status, "pending");
    assert.notEqual(oldGuide?.id, newGuide?.id);
    assert.equal(f.core.canReplyTo(oldGuide!.origin), false);
    assert.equal(f.core.canReplyTo(newGuide!.origin), true);
  } finally { f.close(); }
});

test("a guide persistence failure rolls back channel activation", () => {
  const f = fixture();
  try {
    const db = new Database(f.file);
    db.exec("CREATE TRIGGER disk_failure BEFORE INSERT ON records WHEN NEW.kind='outbox' BEGIN SELECT RAISE(ABORT, 'disk fixture failure'); END");
    db.close();
    assert.throws(() => f.core.bindChannel("weixin", "account", "owner"), /disk fixture/);
    assert.equal(f.core.isBound({ kind: "weixin", accountId: "account", peerId: "owner" }), false);
    assert.equal(f.core.outbox().length, 0);
  } finally { f.close(); }
});
