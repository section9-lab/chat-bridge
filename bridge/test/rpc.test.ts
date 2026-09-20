import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { RPCPeer, type Handler } from "../src/rpc.js";

function peers(handlers: Record<string, Handler>, timeout = 100) {
  const ab = new PassThrough(), ba = new PassThrough();
  const a = new RPCPeer(ba, ab, {}, timeout);
  const b = new RPCPeer(ab, ba, handlers, timeout);
  return { a, b, close() { a.close(); b.close(); } };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("RPC correlates out-of-order responses and Unicode payloads", async () => {
  let release!: () => void;
  const p = peers({ work: async (params) => {
    if (params === "slow") await new Promise<void>((resolve) => { release = resolve; });
    return params;
  } });
  try {
    const slow = p.a.call("work", "slow");
    await tick();
    assert.equal(await p.a.call("work", "中文 🌉"), "中文 🌉");
    release();
    assert.equal(await slow, "slow");
  } finally { p.close(); }
});

test("RPC rejects methods outside its explicit allowlist", async () => {
  const p = peers({});
  try { await assert.rejects(p.a.call("exec", { command: "anything" }), { code: "METHOD_NOT_FOUND" }); }
  finally { p.close(); }
});

test("RPC timeout is uncertain and never reissues the request", async () => {
  let calls = 0;
  const p = peers({ wait: () => { calls++; return new Promise(() => {}); } }, 20);
  try {
    await assert.rejects(p.a.call("wait"), { code: "TIMEOUT" });
    assert.equal(calls, 1);
  } finally { p.close(); }
});

test("closing RPC rejects every pending request", async () => {
  const p = peers({ wait: () => new Promise(() => {}) });
  const pending = p.a.call("wait");
  const rejection = assert.rejects(pending, { code: "CLOSED" });
  p.a.close();
  await rejection;
  p.close();
});

test("split UTF-8 frames are decoded only after newline", async () => {
  const input = new PassThrough(), output = new PassThrough();
  const values: unknown[] = [];
  const peer = new RPCPeer(input, output, { echo: (params) => { values.push(params); return params; } });
  const frame = Buffer.from(JSON.stringify({ protocolVersion: 1, requestId: "r1", method: "echo", params: "你" }) + "\n");
  const split = frame.indexOf(Buffer.from("你")) + 1;
  input.write(frame.subarray(0, split));
  assert.deepEqual(values, []);
  input.write(frame.subarray(split));
  await tick();
  assert.deepEqual(values, ["你"]);
  peer.close();
});

test("invalid or oversized input closes the transport before handling content", async () => {
  for (const invalid of [Buffer.from("{broken}\n"), Buffer.alloc(1024 * 1024 + 1, 65),
    Buffer.from(JSON.stringify({ protocolVersion: 99, requestId: "r", method: "echo" }) + "\n")]) {
    const input = new PassThrough(), output = new PassThrough();
    let closed = false, calls = 0;
    const peer = new RPCPeer(input, output, { echo: () => calls++ });
    peer.onClose = () => { closed = true; };
    input.write(invalid);
    await tick();
    assert.equal(closed, true);
    assert.equal(calls, 0);
    peer.close();
  }
});

test("RPC events do not become remote method calls", async () => {
  const p = peers({});
  let result: unknown;
  p.a.onEvent = (method, params) => { result = { method, params }; };
  p.b.event("state.changed", { count: 1 });
  await tick();
  assert.deepEqual(result, { method: "state.changed", params: { count: 1 } });
  p.close();
});
