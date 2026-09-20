import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInput } from "../src/commands.js";

test("ordinary text and numeric replies remain unchanged", () => {
  for (const text of ["  帮我改一下\n不要执行", "2", "换一个项目看看"]) {
    assert.deepEqual(parseInput(text), { kind: "message", text });
  }
});

test("an explicit agent command changes routing without a model call", () => {
  assert.deepEqual(parseInput("/agent claude"), { kind: "command", name: "agent", argument: "claude" });
});

test("slash escaping forwards literal command text", () => {
  assert.deepEqual(parseInput("//agent claude"), { kind: "message", text: "/agent claude" });
});

test("malformed known commands cannot fall through to the agent", () => {
  assert.equal(parseInput("/agent claude extra").kind, "invalid");
  assert.equal(parseInput("/new extra").kind, "invalid");
});

test("menu alias and unknown agent slash commands are distinct", () => {
  assert.deepEqual(parseInput("菜单"), { kind: "command", name: "help", argument: "" });
  assert.deepEqual(parseInput("/review"), { kind: "message", text: "/review" });
});

test("project and pagination commands can be used without internal identifiers", () => {
  assert.deepEqual(parseInput("/project"), { kind: "command", name: "project", argument: "" });
  assert.deepEqual(parseInput("/more"), { kind: "command", name: "more", argument: "" });
});
