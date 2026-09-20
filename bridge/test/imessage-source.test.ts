import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openIMessageSource } from "../src/imessage-source.js";

const require = createRequire(import.meta.url);
const libraryFile = require.resolve("@photon-ai/imessage-kit").replace(/index.cjs$/, "index.js");
test("pinned iMessage sender has one dispatch attempt before the durable outbox decides recovery", () => {
  assert.ok(readFileSync(libraryFile, "utf8").includes("var RETRY_ATTEMPTS = 1;"), "Apply scripts/patch-imessage.mjs before building.");
});
test("the pinned SDK reads durable ROWID order even when iCloud inserts older dated messages", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-imessage-sdk-")), file = join(directory, "chat.db");
  const db = new Database(file);
  // Populate an isolated schema fixture for the actual installed SDK, never the user's Messages database.
  const library = readFileSync(libraryFile, "utf8");
  const fieldBlock = library.split("var MESSAGE_FIELDS = [")[1]!.split("];", 1)[0]!;
  const fields = [...new Set(Array.from(fieldBlock.matchAll(/"message\.([a-zA-Z_]+)/g), (match) => match[1]!))].filter((field) => field !== "ROWID");
  db.exec("CREATE TABLE message (" + [...fields, "handle_id", "other_handle"].map((field) => '"' + field + '"').join(",") + ");" +
    "CREATE TABLE handle (id TEXT); CREATE TABLE chat (guid TEXT, chat_identifier TEXT, style INTEGER);" +
    "CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER); CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);" +
    "CREATE TABLE attachment (guid,created_date,filename,uti,mime_type,transfer_state,is_outgoing,transfer_name,total_bytes,is_sticker,is_commsafety_sensitive,emoji_image_short_description,hide_attachment);");
  db.exec("INSERT INTO handle VALUES ('+6591234567'); INSERT INTO chat VALUES ('iMessage;-;+6591234567','+6591234567',45);");
  const insert = db.prepare("INSERT INTO message (guid,text,service,is_from_me,date,item_type,handle_id) VALUES (?,?, 'iMessage',0,?,0,1)");
  insert.run("m1", "first", 9_000_000_000); insert.run("m2", "older clock", 1_000_000_000);
  db.exec("INSERT INTO chat_message_join VALUES (1,1),(1,2)");
  let source: ReturnType<typeof openIMessageSource> | undefined;
  try {
    source = openIMessageSource(file);
    assert.deepEqual(source.tail(), { rowId: 2, guid: "m2" });
    assert.equal(source.matches({ rowId: 1, guid: "m1" }), true);
    assert.equal(source.matches({ rowId: 1, guid: "other-database" }), false);
    assert.deepEqual((await source.read(0)).map((message) => message.id), ["m1", "m2"]);
    assert.deepEqual((await source.read(1)).map((message) => message.id), ["m2"]);
    assert.throws(() => source!.read(-1));
  } finally { await source?.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});
