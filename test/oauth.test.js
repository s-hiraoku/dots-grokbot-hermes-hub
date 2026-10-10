import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  OAuthResource,
  ApprovedSubjects,
  Auth0Verifier,
} from "../src/oauth.ts";
import { fetchMCP } from "../src/mcp-core.ts";
import { handler } from "../src/mcp.ts";
import { Hub } from "./fixtures.js";
import { Adapter, MockRuns } from "../src/adapter.ts";
import { worker, journal, RESPONSE } from "./fixtures.js";
const resource = () =>
  new OAuthResource({
    issuer: "https://fixture.us.auth0.com/",
    resource: "https://hub.example/mcp",
  });
const policy = [
  {
    subject: "fixture-user",
    kind: "user",
    clientId: "fixture-chatgpt",
    operations: ["submit", "get"],
    destination: "hermes",
  },
];
const enc = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
async function fixture(entries = policy) {
  let now = 2000000;
  const keys = [];
  for (const kid of ["old", "new"]) {
    const pair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    keys.push({
      kid,
      pair,
      jwk: {
        ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
        kid,
        alg: "RS256",
        use: "sig",
      },
    });
  }
  const subjects = new ApprovedSubjects(entries, { enabled: true });
  const calls = [];
  let response = () => Response.json({ keys: [keys[0].jwk] });
  const verifier = new Auth0Verifier({
    resource: resource(),
    subjects,
    now: () => now,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return response();
    },
  });
  const sign = async (claims = {}, head = {}, index = 0) => {
    const key = keys[index];
    const text = `${enc({ alg: "RS256", kid: key.kid, ...head })}.${enc({ iss: resource().issuer, aud: resource().resource, sub: "fixture-user", exp: Math.floor(now / 1000) + 600, azp: "fixture-chatgpt", scope: "hub:submit hub:get", ...claims })}`;
    const sig = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key.pair.privateKey,
      new TextEncoder().encode(text),
    );
    return `Bearer ${text}.${Buffer.from(sig).toString("base64url")}`;
  };
  return {
    verifier,
    subjects,
    keys,
    calls,
    sign,
    advance: (ms) => (now += ms),
    respond: (f) => (response = f),
  };
}
test("only explicit Auth0 tenant and canonical HTTPS resource can configure discovery", () => {
  for (const issuer of [
    "http://fixture.us.auth0.com/",
    "https://127.0.0.1/",
    "https://auth0.com.evil.example/",
    "https://fixture.us.auth0.com/path",
    "https://fixture.us.auth0.com/?x=1",
    "https://fixture.us.auth0.com",
    "https://user@fixture.us.auth0.com/",
  ])
    assert.throws(
      () => new OAuthResource({ issuer, resource: "https://hub.example/mcp" }),
    );
  assert.throws(
    () =>
      new OAuthResource({
        issuer: resource().issuer,
        resource: "https://hub.example/mcp?x=1",
      }),
  );
  assert.equal(
    resource().jwksURL,
    "https://fixture.us.auth0.com/.well-known/jwks.json",
  );
  assert.ok(Object.isFrozen(resource()));
});
test("approved enrollment requires client binding and forbids user worker authority", () => {
  assert.equal(
    new ApprovedSubjects(policy).isActive("fixture-user", "user"),
    false,
  );
  assert.equal(
    new ApprovedSubjects(policy, {
      enabled: true,
      stoppedSubjects: ["fixture-user"],
    }).isActive("fixture-user", "user"),
    false,
  );
  assert.throws(
    () => new ApprovedSubjects([{ ...policy[0], clientId: undefined }]),
  );
  assert.throws(() => new ApprovedSubjects([...policy, ...policy]));
  assert.throws(
    () => new ApprovedSubjects([{ ...policy[0], operations: ["claim"] }]),
  );
  assert.throws(
    () =>
      new ApprovedSubjects([
        { ...policy[0], kind: "service", worker: "hermes" },
      ]),
  );
});
test("Auth0 verifier validates signed client and static scope policy; forged authorization claims confer no rights", async () => {
  const f = await fixture();
  const p = await f.verifier.verify(
    await f.sign({
      agent: "hermes",
      role: "admin",
      scope: "hub:submit hub:claim",
    }),
  );
  assert.deepEqual(p.operations, ["submit"]);
  assert.equal(p.worker, undefined);
  for (const claims of [
    { iss: "https://wrong.us.auth0.com/" },
    { aud: "other" },
    { sub: "unknown" },
    { azp: "other" },
    { azp: undefined },
    { client_id: "other" },
    { exp: 2000 },
    { nbf: 9000 },
    { scope: "hub:claim" },
  ])
    assert.equal(await f.verifier.verify(await f.sign(claims)), null);
  assert.ok(
    await f.verifier.verify(
      await f.sign({ azp: undefined, client_id: "fixture-chatgpt" }),
    ),
  );
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, resource().jwksURL);
  assert.equal(f.calls[0].init.redirect, "error");
});
test("JWT URL headers never trigger network and cache refresh is bounded", async () => {
  const f = await fixture();
  for (const head of [
    { jku: "https://attacker.example/jwks" },
    { x5u: "https://127.0.0.1/" },
    { alg: "none" },
  ])
    assert.equal(await f.verifier.verify(await f.sign({}, head)), null);
  assert.equal(f.calls.length, 0);
  await f.verifier.verify(await f.sign());
  for (let n = 0; n < 20; n++)
    assert.equal(
      await f.verifier.verify(await f.sign({}, { kid: `unknown-${n}` })),
      null,
    );
  assert.equal(f.calls.length, 1);
});
test("key rotation admits new key, removes old key, and coalesces parallel fetches", async () => {
  const f = await fixture();
  assert.ok(await f.verifier.verify(await f.sign()));
  f.advance(30001);
  f.respond(() => Response.json({ keys: [f.keys[1].jwk] }));
  const token = await f.sign({}, {}, 1);
  const results = await Promise.all(
    Array.from({ length: 10 }, () => f.verifier.verify(token)),
  );
  assert.ok(results.every(Boolean));
  assert.equal(f.calls.length, 2);
  assert.equal(await f.verifier.verify(await f.sign()), null);
});
test("cache expiry or failed refresh never accepts stale keys", async () => {
  const f = await fixture();
  const token = await f.sign();
  assert.ok(await f.verifier.verify(token));
  f.advance(300001);
  f.respond(() => new Response(null, { status: 503 }));
  assert.equal(await f.verifier.verify(token), null);
  assert.equal(await f.verifier.verify(token), null);
  assert.equal(f.calls.length, 2);
});
for (const defect of [
  "oversize",
  "duplicate",
  "redirect",
  "private-key",
  "bad-alg",
  "weak",
  "malformed",
])
  test(`invalid JWKS fails closed: ${defect}`, async () => {
    const f = await fixture();
    f.respond(() => {
      if (defect === "oversize") return new Response(" ".repeat(65537));
      if (defect === "redirect")
        return new Response(null, {
          status: 302,
          headers: { Location: "https://attacker.example/" },
        });
      if (defect === "malformed") return Response.json({ keys: [] });
      const key = { ...f.keys[0].jwk };
      if (defect === "private-key") key.d = "secret";
      if (defect === "bad-alg") key.alg = "HS256";
      if (defect === "weak") key.n = "AQAB";
      return Response.json({
        keys: defect === "duplicate" ? [key, key] : [key],
      });
    });
    assert.equal(await f.verifier.verify(await f.sign()), null);
  });
test("stop gates reject still-valid tokens without a network call or automatic re-enrollment", async () => {
  const f = await fixture();
  const token = await f.sign();
  assert.ok(await f.verifier.verify(token));
  const snapshot = f.subjects.policy();
  snapshot[0].subject = "attacker";
  f.subjects.stop("fixture-user");
  assert.equal(await f.verifier.verify(token), null);
  assert.equal(await f.verifier.verify(await f.sign()), null);
  assert.equal(f.calls.length, 1);
  const second = await fixture();
  second.subjects.stopAll();
  assert.equal(await second.verifier.verify(await second.sign()), null);
});
test("portable MCP exposes fixed public metadata and challenges before any unauthenticated mutation", async () => {
  const h = new Hub();
  try {
    const f = await fixture();
    const auth = (req) =>
      f.verifier.verify(req.headers.get("authorization") ?? undefined);
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const reply = await fetchMCP(
        h,
        new Request(`https://spoof.example${path}`, {
          headers: { Host: "attacker.example" },
        }),
        auth,
        undefined,
        resource(),
      );
      assert.equal(reply.status, 200);
      assert.deepEqual(await reply.json(), resource().metadata());
    }
    const denied = await fetchMCP(
      h,
      new Request("https://hub.example/mcp", { method: "POST" }),
      auth,
      undefined,
      resource(),
    );
    assert.equal(denied.status, 401);
    assert.equal(
      denied.headers.get("www-authenticate"),
      resource().challenge(),
    );
    assert.equal(f.calls.length, 0);
    const token = await f.sign();
    const invoke = () =>
      fetchMCP(
        h,
        new Request("https://hub.example/mcp", {
          method: "POST",
          headers: {
            Authorization: token,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              clientInfo: { name: "fixture", version: "1" },
            },
          }),
        }),
        auth,
        undefined,
        resource(),
      );
    assert.equal((await invoke()).status, 200);
    f.subjects.stopAll();
    assert.equal((await invoke()).status, 401);
  } finally {
    h.close();
  }
});
test("Node MCP discovery and challenge use operator configuration, not Host headers", async () => {
  const h = new Hub();
  const handle = handler(h, undefined, undefined, resource());
  const server = createServer((req, res) => {
    void handle(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const metadata = await globalThis.fetch(
      `${base}/.well-known/oauth-protected-resource/mcp`,
      { headers: { Host: "attacker.example" } },
    );
    assert.deepEqual(await metadata.json(), resource().metadata());
    const denied = await globalThis.fetch(`${base}/mcp`, { method: "POST" });
    assert.equal(denied.status, 401);
    assert.equal(
      denied.headers.get("www-authenticate"),
      resource().challenge(),
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    h.close();
  }
});
for (const transition of ["expiry", "removal", "stop"])
  test(`asynchronous verification rechecks gates after ${transition}`, async () => {
    const f = await fixture();
    const old = await f.sign();
    assert.ok(await f.verifier.verify(old));
    const original = crypto.subtle.verify.bind(crypto.subtle);
    let crossed = false;
    const patched = mock.method(crypto.subtle, "verify", async (...args) => {
      const result = await original(...args);
      if (!crossed) {
        crossed = true;
        if (transition === "expiry") f.advance(300001);
        if (transition === "stop") f.subjects.stopAll();
        if (transition === "removal") {
          f.advance(30001);
          f.respond(() => Response.json({ keys: [f.keys[1].jwk] }));
          assert.ok(await f.verifier.verify(await f.sign({}, {}, 1)));
        }
      }
      return result;
    });
    try {
      assert.equal(await f.verifier.verify(old), null);
    } finally {
      patched.mock.restore();
    }
  });
test("authenticated MCP fixed submit/mock/get roundtrip and immediate stop deny new calls", async () => {
  const h = new Hub();
  const f = await fixture();
  const token = await f.sign();
  const auth = (request) =>
    f.verifier.verify(request.headers.get("authorization") ?? undefined);
  async function call(method, params = {}, bearer = token) {
    const reply = await fetchMCP(
      h,
      new Request("https://hub.example/mcp", {
        method: "POST",
        headers: {
          Authorization: bearer,
          "Content-Type": "application/json",
          Accept: "application/json",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": method,
          ...(params.name ? { "Mcp-Name": params.name } : {}),
        },
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
      }),
      auth,
      undefined,
      resource(),
    );
    return reply;
  }
  try {
    const listed = await (await call("tools/list")).json();
    assert.deepEqual(
      listed.result.tools.find((t) => t.name === "submit")._meta
        .securitySchemes,
      [{ type: "oauth2", scopes: ["hub:submit"] }],
    );
    const args = {
      name: "submit",
      arguments: {
        task_type: "connectivity_check",
        request_key: "oauth-fixture",
      },
    };
    assert.equal(
      (await call("tools/call", args, await f.sign({ azp: "wrong" }))).status,
      401,
    );
    const task = JSON.parse(
      (await (await call("tools/call", args)).json()).result.content[0].text,
    );
    const runs = new MockRuns();
    await new Adapter(h, worker, runs, journal()).run();
    const result = JSON.parse(
      (
        await (
          await call("tools/call", { name: "get", arguments: { id: task.id } })
        ).json()
      ).result.content[0].text,
    );
    assert.equal(result.result, RESPONSE);
    assert.equal(runs.calls, 1);
    f.subjects.stop("fixture-user");
    assert.equal((await call("tools/call", args)).status, 401);
  } finally {
    h.close();
  }
});

test("Auth0 same human different clients isolates scopes and subject-wide stop", async () => {
  const entries = [
    { ...policy[0], operations: ["ping_submit", "ping_get"] },
    {
      ...policy[0],
      clientId: "fixture-grok",
      operations: ["ping_reply", "ping_pending"],
    },
  ];
  for (const p of entries) delete p.destination;
  const f = await fixture(entries);
  const scope = "hub:ping_submit hub:ping_get hub:ping_reply hub:ping_pending";
  for (const [azp, expected] of [
    ["fixture-chatgpt", ["ping_submit", "ping_get"]],
    ["fixture-grok", ["ping_reply", "ping_pending"]],
  ]) {
    const p = await f.verifier.verify(await f.sign({ azp, scope }));
    assert.deepEqual(p.operations, expected);
    assert.equal(p.clientId, azp);
  }
  assert.equal(
    await f.verifier.verify(await f.sign({ azp: "unregistered", scope })),
    null,
  );
  assert.equal(
    await f.verifier.verify(
      await f.sign({
        azp: "fixture-chatgpt",
        client_id: "fixture-grok",
        scope,
      }),
    ),
    null,
  );
  f.subjects.stop("fixture-user");
  for (const azp of ["fixture-chatgpt", "fixture-grok"])
    assert.equal(await f.verifier.verify(await f.sign({ azp, scope })), null);
  assert.throws(
    () =>
      new ApprovedSubjects(
        [{ ...entries[0], clientId: undefined }, entries[1]],
        { enabled: true },
      ),
  );
});

test("shared-human migration cannot grant subject-owned legacy task permissions", () => {
  assert.throws(
    () =>
      new ApprovedSubjects(
        [
          policy[0],
          { ...policy[0], clientId: "fixture-grok", operations: ["ping_get"] },
        ],
        { enabled: true },
      ),
    /shared_subject_requires_diagnostic_policy/,
  );
});

test("shared-subject diagnostic policy rejects latent worker and task metadata", () => {
  const a = {
    subject: "fixture-human",
    kind: "service",
    clientId: "dots",
    operations: ["ping_get"],
  };
  for (const extra of [
    { worker: "hermes", runnerScope: "fixture" },
    { runnerScope: "fixture" },
    { destination: "hermes" },
    { taskTypes: ["connectivity_check"] },
    { resultReaders: [] },
  ])
    assert.throws(
      () =>
        new ApprovedSubjects(
          [
            { ...a, ...extra },
            { ...a, clientId: "grok" },
          ],
          { enabled: true },
        ),
      /shared_subject_requires_diagnostic_policy/,
    );
});
