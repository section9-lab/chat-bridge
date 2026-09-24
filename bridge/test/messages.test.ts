import { test } from "node:test";
import assert from "node:assert/strict";
import { Actions, Button, Card, CardText } from "chat";
import { plainText, renderCard, splitReply } from "../src/messages.js";
import { sealContext, openContext } from "../src/secrets.js";

test("a shared card keeps command actions in text-only channels", () => {
  const card = Card({ title: "任务等待", children: [CardText("正文未发送"), Actions([
    Button({ id: "continue", label: "继续", value: "/continue J1" }),
    Button({ id: "cancel", label: "取消", value: "/cancel J1" }),
  ])] });
  const text = renderCard(card);
  assert.match(text, /任务等待/);
  assert.match(text, /正文未发送/);
  assert.match(text, /继续：\/continue J1/);
  assert.match(text, /取消：\/cancel J1/);
});

test("long replies keep grapheme clusters and exact content within the byte budget", () => {
  const text = "中文👨‍👩‍👧‍👦e\u0301\n".repeat(600);
  const chunks = splitReply(text);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(""), text);
  for (const part of chunks) assert.ok(Buffer.byteLength(part) <= 1800);
  const boundaries = new Set(Array.from(new Intl.Segmenter().segment(text), (part) => part.index));
  let offset = 0;
  for (const part of chunks) { assert.ok(boundaries.has(offset)); offset += part.length; }
});

test("encrypted context is authenticated and scoped to the exact account and owner", () => {
  const key = Buffer.alloc(32, 13).toString("base64");
  const encrypted = sealContext("private-context-token", key, "bot:owner");
  assert.ok(!encrypted.includes("private-context-token"));
  assert.equal(openContext(encrypted, key, "bot:owner"), "private-context-token");
  assert.throws(() => openContext(encrypted, key, "bot:stranger"));
  assert.throws(() => openContext(encrypted.slice(0, -4) + "AAAA", key, "bot:owner"));
  assert.throws(() => sealContext("secret", "invalid-key", "bot:owner"));
});

test("iMessage text drops Markdown syntax but keeps its content", () => {
  const reply = "刚检查过：**ChatBridge 下原来的 `ember-expedition` 目录已不存在**。\n\n## 现在位于\n\n```text\n/Users/jackwang/Documents/GitHub/ember-expedition\n```\n\n详见 [说明](https://example.com/doc)，路径 `a/**b**`。";
  assert.equal(plainText(reply), "刚检查过：ChatBridge 下原来的 ember-expedition 目录已不存在。\n\n现在位于\n\n/Users/jackwang/Documents/GitHub/ember-expedition\n\n详见 说明（https://example.com/doc），路径 a/b。");
  assert.equal(plainText("1. 第一步\n- 列表项\n普通文字 2*3=6"), "1. 第一步\n- 列表项\n普通文字 2*3=6");
});
