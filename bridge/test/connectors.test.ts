import { test } from "node:test";
import assert from "node:assert/strict";
import { ComposioConnectorController, type ConnectorCredential } from "../src/connectors.js";
import type { ConnectorPolicy } from "../src/core.js";

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
function fixture(fetchFn: typeof fetch, initial: ConnectorCredential | null = null) {
  let credential = initial;
  const policies = new Map<string, ConnectorPolicy>();
  const controller = new ComposioConnectorController({
    async read() { return credential; }, async write(value) { credential = value; }, async remove() { credential = null; }
  }, { userID: () => "cb_fixture", policies: () => [...policies.values()], setPolicy: (value) => { policies.set(value.accountId, value); },
    removePolicy: (id) => { policies.delete(id); } }, fetchFn);
  return { controller, credential: () => credential, policies };
}

test("Composio key is verified before it is stored", async () => {
  const calls: string[] = [];
  const mock = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(url));
    assert.equal(new Headers(init?.headers).get("x-api-key"), "cmp_test");
    return response({ items: [{ slug: "github", name: "GitHub" }] });
  }) as typeof fetch;
  const value = fixture(mock);
  await value.controller.save("cmp_test");
  assert.deepEqual(value.credential(), { apiKey: "cmp_test" });
  assert.equal(value.controller.summary().provider.status, "ready");
  assert.match(calls[0]!, /\/toolkits\?limit=1$/);
});

test("invalid Composio key is never stored", async () => {
  const value = fixture((async () => response({ message: "unauthorized" }, 401)) as typeof fetch);
  await assert.rejects(value.controller.save("bad-key"), { code: "CONNECTOR_AUTH" });
  assert.equal(value.credential(), null);
});

test("catalog and accounts tolerate the documented paged response", async () => {
  const mock = (async (url: string | URL | Request) => {
    const path = String(url);
    if (path.includes("/toolkits?")) return response({ items: [{ slug: "github", name: "GitHub", description: "Code", category: "Developer" }], next_cursor: "next" });
    if (path.includes("/connected_accounts?")) return response({ items: [{ id: "ca_1", status: "ACTIVE", toolkit: { slug: "github", name: "GitHub" },
      connection_data: { email: "work@example.com" } }] });
    throw new Error("unexpected URL " + path);
  }) as typeof fetch;
  const value = fixture(mock, { apiKey: "cmp_test" });
  const catalog = await value.controller.catalog({ search: "git" });
  assert.equal(catalog.items[0]?.slug, "github");
  assert.equal(catalog.nextCursor, "next");
  const accounts = await value.controller.listAccounts();
  assert.equal(accounts[0]?.label, "work@example.com");
  assert.deepEqual(accounts[0]?.policy.allowedAgents, []);
});

test("link reuses an auth config and returns only an HTTPS redirect", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const mock = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url); requests.push({ url: path, init });
    if (path.includes("/auth_configs?")) return response({ items: [{ id: "ac_1" }] });
    if (path.endsWith("/connected_accounts/link")) return response({ id: "attempt_1", redirect_url: "https://connect.composio.dev/session" });
    throw new Error("unexpected URL " + path);
  }) as typeof fetch;
  const value = fixture(mock, { apiKey: "cmp_test" });
  const result = await value.controller.link("github", "chatbridge-connectors://complete");
  assert.equal(result.attemptId, "attempt_1");
  assert.equal(result.redirectURL, "https://connect.composio.dev/session");
  const linkRequest = requests.find((request) => request.url.endsWith("/connected_accounts/link"));
  const body = JSON.parse(String(linkRequest?.init?.body));
  assert.deepEqual(body, { auth_config_id: "ac_1", user_id: "cb_fixture", callback_url: "chatbridge-connectors://complete" });
});

test("connector policies reject unknown agents and persist valid access", async () => {
  const mock = (async () => response({ items: [{ id: "ca_1", status: "ACTIVE", toolkit: { slug: "github", name: "GitHub" } }] })) as typeof fetch;
  const value = fixture(mock, { apiKey: "cmp_test" });
  await value.controller.listAccounts();
  assert.throws(() => value.controller.updatePolicy({ accountId: "ca_1", allowedAgents: ["unknown"], mode: "read-only" }), { code: "INVALID_INPUT" });
  const policy = value.controller.updatePolicy({ accountId: "ca_1", allowedAgents: ["codex", "claude"], mode: "confirm-writes" });
  assert.deepEqual(value.policies.get("ca_1"), policy);
  assert.equal(value.controller.summary().availableByAgent.codex, 1);
});

test("disconnect does not retry and clears the local policy", async () => {
  let deletes = 0;
  const mock = (async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "DELETE") { deletes++; return response({ success: true }); }
    return response({ items: [{ id: "ca_1", status: "ACTIVE", toolkit: { slug: "github", name: "GitHub" } }] });
  }) as typeof fetch;
  const value = fixture(mock, { apiKey: "cmp_test" });
  await value.controller.listAccounts();
  value.controller.updatePolicy({ accountId: "ca_1", allowedAgents: ["codex"], mode: "confirm-writes" });
  await value.controller.disconnect("ca_1", true);
  assert.equal(deletes, 1);
  assert.equal(value.policies.has("ca_1"), false);
});
