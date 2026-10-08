import { test } from "node:test";
import assert from "node:assert/strict";
import { Hub, RESPONSE, journal } from "./fixtures.js";
import { PinnedJWTVerifier } from "../src/auth.ts";
import { fetchMCP } from "../src/mcp-core.ts";
import { SubscriptionService, SecretVault } from "../src/subscriptions.ts";
import { Adapter, MockRuns } from "../src/adapter.ts";
import { Webhook } from "standardwebhooks";
test("MCP 2026 authenticated submit, subscription, mock worker, signed callback and granted get", async () => {
  const h = new Hub();
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    false,
    ["sign", "verify"],
  );
  const policies = [
    {
      subject: "grok-fixture",
      kind: "user",
      destination: "hermes",
      operations: ["submit", "get", "events"],
      resultReaders: [{ subject: "dots-fixture", notify: true }],
    },
    { subject: "dots-fixture", kind: "user", operations: ["get", "events"] },
  ];
  const verifier = new PinnedJWTVerifier({
    issuer: "https://issuer.example",
    audience: "hub-fixture",
    kid: "fixture",
    key: keys.publicKey,
    active: async () => true,
    policy: policies,
  });
  const token = async (subject) => {
    const enc = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const body = `${enc({ alg: "RS256", kid: "fixture" })}.${enc({ iss: "https://issuer.example", aud: "hub-fixture", sub: subject, exp: Math.floor(Date.now() / 1000) + 300, scope: "hub:submit hub:get hub:events" })}`;
    return `${body}.${Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(body))).toString("base64url")}`;
  };
  const tokens = {
    "grok-fixture": await token("grok-fixture"),
    "dots-fixture": await token("dots-fixture"),
  };
  const secret = `whsec_${Buffer.alloc(32, 11).toString("base64")}`,
    url = "https://callback.example/fixture";
  let callbackResult,
    notifications = 0;
  const vault = new SecretVault(
    await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]),
  );
  const events = new SubscriptionService({
    hub: h,
    vault,
    identityActive: async () => true,
    transportFor: (requested) => {
      assert.equal(requested, url);
      return {
        post: async (_url, headers, body) => {
          new Webhook(secret).verify(body, headers);
          const event = JSON.parse(body);
          if (event.type === "verification")
            return {
              status: 200,
              body: JSON.stringify({ challenge: event.challenge }),
            };
          notifications++;
          callbackResult = await call("dots-fixture", "tools/call", {
            name: "get",
            arguments: { id: event.data.task_id },
          });
          return { status: 204, body: "" };
        },
      };
    },
  });
  async function call(subject, method, params = {}) {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": method,
      Authorization: `Bearer ${tokens[subject]}`,
    };
    if (method === "tools/call") headers["Mcp-Name"] = params.name;
    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    const response = await fetchMCP(
      h,
      request,
      (r) => verifier.verify(r.headers.get("authorization") ?? undefined),
      events,
    );
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.error, undefined);
    return method === "tools/call"
      ? JSON.parse(result.result.content[0].text)
      : result.result;
  }
  try {
    const discovered = await call("dots-fixture", "server/discover");
    assert.deepEqual(discovered.supportedVersions, ["2026-07-28"]);
    assert.deepEqual(discovered.capabilities.events, {});
    const listed = await call("dots-fixture", "events/list");
    assert.ok(listed.events[0].inputSchema);
    assert.ok(listed.events[0].payloadSchema);
    assert.deepEqual(listed.events[0].delivery, ["webhook"]);
    const task = await call("grok-fixture", "tools/call", {
      name: "submit",
      arguments: { task_type: "connectivity_check", request_key: "mock-grok" },
    });
    await call("dots-fixture", "events/subscribe", {
      name: "task.terminal",
      arguments: { task_id: task.id },
      delivery: { mode: "webhook", url, secret },
      cursor: null,
      ttlMs: 60000,
    });
    const runs = new MockRuns();
    runs.boundaryId = "mock-boundary";
    const worker = {
      subject: "worker-fixture",
      worker: "hermes",
      runnerScope: runs.boundaryId,
      operations: ["get", "claim", "heartbeat", "complete"],
    };
    await new Adapter(h, worker, runs, journal()).run();
    await events.dispatchOne();
    await events.dispatchOne();
    assert.equal(runs.calls, 1);
    assert.equal(notifications, 1);
    assert.deepEqual(Object.keys(callbackResult).sort(), [
      "at",
      "id",
      "result",
      "state",
    ]);
    assert.equal(callbackResult.result, RESPONSE);
    await call("dots-fixture", "events/unsubscribe", {
      name: "task.terminal",
      arguments: { task_id: task.id },
      delivery: { mode: "webhook", url },
    });
    const unauth = await fetchMCP(
      h,
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "oai-authenticated-user-id": "dots-fixture" },
        body: "{}",
      }),
    );
    assert.equal(unauth.status, 401);
  } finally {
    h.close();
  }
});
