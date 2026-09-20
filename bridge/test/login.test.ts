import { test } from "node:test";
import assert from "node:assert/strict";
import { WeixinLogin } from "../src/weixin-login.js";

function fixture(responses: object[], now = () => Date.now()) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const login = new WeixinLogin(async (input, init) => { calls.push({ url: String(input), init });
    return Response.json(responses.shift() ?? { status: "wait" }); }, now);
  return { login, calls };
}
const qr = { qrcode: "qr-id", qrcode_img_content: "https://weixin.qq.com/qr/fixture" };
const confirmed = { status: "confirmed", bot_token: "private-bot-token", ilink_bot_id: "bot", ilink_user_id: "owner", baseurl: "https://ilinkai.weixin.qq.com" };

test("scan success waits for matching local confirmation and never exposes credentials in UI state", async () => {
  const { login } = fixture([qr, confirmed]);
  await login.start();
  assert.equal(login.state.status, "wait");
  assert.throws(() => login.confirm(login.state.attemptId!), /INVALID_STATE/);
  await login.poll();
  assert.equal(login.state.status, "awaiting_confirmation");
  assert.equal(login.state.ownerId, "owner");
  assert.ok(!JSON.stringify(login.state).includes("private-bot-token"));
  assert.throws(() => login.confirm("old-attempt"), /STALE/);
  assert.equal(login.confirm(login.state.attemptId!).token, "private-bot-token");
});
test("unknown owner or untrusted endpoint cannot become a confirmed binding", async () => {
  for (const response of [{ ...confirmed, ilink_user_id: undefined }, { ...confirmed, baseurl: "https://evil.test" }]) {
    const { login } = fixture([qr, response]);
    await login.start(); await assert.rejects(login.poll());
    assert.throws(() => login.confirm(login.state.attemptId!));
  }
});
test("cancel invalidates late QR responses", async () => {
  let release!: (response: Response) => void;
  const login = new WeixinLogin(() => new Promise((resolve) => { release = resolve; }));
  const starting = login.start();
  login.cancel(); release(Response.json(qr)); await starting;
  assert.equal(login.state.status, "idle");
  assert.equal(login.state.qrContent, undefined);
});
test("expired login cannot be locally confirmed", async () => {
  let now = 100;
  const { login } = fixture([qr, confirmed], () => now);
  await login.start(); await login.poll();
  now += 11 * 60_000;
  assert.throws(() => login.confirm(login.state.attemptId!), /EXPIRED/);
});
test("server verification code is scoped to the current login and omitted from state", async () => {
  const { login, calls } = fixture([qr, { status: "need_verifycode" }, confirmed]);
  await login.start(); await login.poll();
  assert.equal(login.state.status, "need_verifycode");
  assert.throws(() => login.verify("../bad"));
  login.verify("123456"); await login.poll();
  assert.equal(new URL(calls[2]!.url).searchParams.get("verify_code"), "123456");
  assert.ok(!JSON.stringify(login.state).includes("123456"));
  assert.equal(login.state.status, "awaiting_confirmation");
});
test("QR polling can follow only validated Tencent redirect hosts", async () => {
  const { login, calls } = fixture([qr, { status: "scaned_but_redirect", redirect_host: "alt.weixin.qq.com" }, confirmed]);
  await login.start(); await login.poll(); await login.poll();
  assert.equal(new URL(calls[2]!.url).origin, "https://alt.weixin.qq.com");
  const bad = fixture([qr, { status: "scaned_but_redirect", redirect_host: "evil.test" }]);
  await bad.login.start(); await assert.rejects(bad.login.poll());
});
