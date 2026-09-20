import { IMessageSDK, getDefaultDatabasePath, type Message, type MessageQuery } from "@photon-ai/imessage-kit";
import Database from "better-sqlite3";
import { createRequire } from "node:module";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeError } from "./core.js";
export type MessageCursor = { rowId: number; guid: string };
export interface IMessageSource {
  tail(): MessageCursor;
  matches(cursor: MessageCursor): boolean;
  read(after: number): Promise<readonly Message[]>;
  send(phone: string, text: string, attachment?: string): Promise<void>;
  close(): Promise<void>;
}
export function openIMessageSource(databasePath = getDefaultDatabasePath()): IMessageSource {
  assertSenderPatched();
  const identity = statSync(databasePath);
  // Preserve a filesystem permission error before SQLite reduces it to SQLITE_CANTOPEN.
  closeSync(openSync(databasePath, "r"));
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  const sdk = new IMessageSDK({ databasePath, debug: false, maxConcurrentSends: 1, sendTimeout: 15000 });
  return {
    tail() {
      const row = database.prepare("SELECT ROWID AS rowId,guid FROM message ORDER BY ROWID DESC LIMIT 1").get() as MessageCursor | undefined;
      return row ?? { rowId: 0, guid: "" };
    },
    matches(cursor) {
      const current = statSync(databasePath);
      if (current.ino !== identity.ino || current.dev !== identity.dev) return false;
      if (cursor.rowId === 0) return cursor.guid === "";
      return (database.prepare("SELECT guid FROM message WHERE ROWID=?").get(cursor.rowId) as { guid: string } | undefined)?.guid === cursor.guid;
    },
    read(after) {
      if (!Number.isSafeInteger(after) || after < 0) throw new BridgeError("INVALID_CURSOR", "iMessage 游标无效。");
      // These internal query keys are pinned to v3.0.0 and exercised against a real SQLite fixture.
      const query: MessageQuery & { sinceRowId: number; orderByRowIdAsc: boolean } = { sinceRowId: after, orderByRowIdAsc: true, limit: 100 };
      return sdk.getMessages(query);
    },
    send: (phone, text, attachment) => sdk.send({ to: "iMessage;-;" + phone,
      ...(text ? { text } : {}), ...(attachment ? { attachments: [attachment] } : {}) }),
    async close() { await sdk.close(); if (database.open) database.close(); },
  };
}

export async function sendIMessageNotice(phone: string, text: string): Promise<void> {
  assertSenderPatched();
  // The pinned SDK eagerly opens SQLite, but sending never queries it. Keep the protected Messages database untouched.
  const directory = mkdtempSync(join(tmpdir(), "chat-bridge-imessage-send-")), databasePath = join(directory, "empty.sqlite");
  let sdk: IMessageSDK | undefined;
  try {
    new Database(databasePath).close();
    sdk = new IMessageSDK({ databasePath, debug: false, maxConcurrentSends: 1, sendTimeout: 15000 });
    await sdk.send({ to: "iMessage;-;" + phone, text });
  } finally {
    try { await sdk?.close(); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  }
}

function assertSenderPatched(): void {
  const library = createRequire(import.meta.url).resolve("@photon-ai/imessage-kit").replace(/index.cjs$/, "index.js");
  if (!readFileSync(library, "utf8").includes("var RETRY_ATTEMPTS = 1; // Chat Bridge: durable outbox owns retries.")) {
    throw new BridgeError("INVALID_BUILD", "iMessage 发送保护补丁缺失，请重新构建应用。");
  }
}
