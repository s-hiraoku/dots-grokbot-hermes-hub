import { test } from "node:test";
import assert from "node:assert/strict";
import { Hub } from "./fixtures.js";
import { pingSuite, routes, dots, grok, reply } from "./ping-suite.js";
import { PingService } from "../src/ping.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("SQLite fixed bidirectional diagnostic contract", async (t) => {
  const h = new Hub();
  try {
    await pingSuite(t, h);
  } finally {
    h.close();
  }
});
test("reopening retains request correlation, outbox attempted marker and reply idempotency", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-ping-fixture-")),
    path = join(dir, "fixture.sqlite");
  let h = new Hub(path);
  try {
    const service = new PingService(h, routes);
    const task = await service.submit(dots, {
      request_key: "restart",
      payload: "ping",
    });
    await h.driver.batch([
      { sql: "UPDATE diagnostic_outbox SET delivery='attempted'" },
    ]);
    h.close();
    h = new Hub(path);
    const reopened = new PingService(h, routes);
    assert.equal(
      await reopened.dispatchGrokWake({
        post: async () => {
          throw Error("must not retry crash");
        },
      }),
      false,
    );
    const response = await reopened.reply(grok, reply(task));
    h.close();
    h = new Hub(path);
    assert.deepEqual(
      await new PingService(h, routes).reply(grok, reply(task)),
      response,
    );
  } finally {
    h.close();
    rmSync(dir, { recursive: true });
  }
});

test("Auth0 fixture signed OAuth MCP roundtrip in both directions, without real webhook or Bot", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } =
    await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const { Auth0Verifier, ApprovedSubjects, OAuthResource } =
    await import("../src/oauth.ts");
  const { fetchMCP } = await import("../src/mcp-core.ts");
  const dots = {
    ...routes.dots,
    subject: "fixture-shared-human",
    operations: ["ping_submit", "ping_get", "ping_reply", "ping_pending"],
  };
  const grok = {
    ...routes.grok,
    subject: dots.subject,
    operations: [...dots.operations],
  };
  const h = new Hub(),
    service = new PingService(h, {
      dots: { subject: dots.subject, clientId: dots.clientId },
      grok: { subject: grok.subject, clientId: grok.clientId },
    }),
    clients = [];
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const resource = new OAuthResource({
    issuer: "https://fixture.jp.auth0.com/",
    resource: "https://hub.example/mcp",
    userScopes: [
      "hub:ping_submit",
      "hub:ping_get",
      "hub:ping_reply",
      "hub:ping_pending",
    ],
  });
  const verifier = new Auth0Verifier({
    resource,
    subjects: new ApprovedSubjects(
      [dots, grok].map((p) => ({ ...p, kind: "user" })),
      { enabled: true },
    ),
    fetch: async () =>
      Response.json({
        keys: [{ ...publicKey, kid: "fixture", alg: "RS256", use: "sig" }],
      }),
  });
  const token = async (p) => {
    const encode = (value) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const body = `${encode({ alg: "RS256", kid: "fixture" })}.${encode({ iss: resource.issuer, aud: resource.resource, sub: p.subject, azp: p.clientId, scope: p.operations.map((op) => `hub:${op}`).join(" "), exp: Math.floor(Date.now() / 1000) + 300 })}`;
    return `${body}.${Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(body))).toString("base64url")}`;
  };
  const call = async (client, name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError);
    return JSON.parse(result.content[0].text);
  };
  try {
    const unauth = await fetchMCP(
      h,
      new Request(resource.resource, { method: "POST" }),
      async () => null,
      undefined,
      resource,
      service,
    );
    assert.equal(unauth.status, 401);
    for (const p of [dots, grok]) {
      const client = new Client({ name: p.subject, version: "1" });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(resource.resource), {
          fetch: (url, init) =>
            fetchMCP(
              h,
              new Request(url, init),
              (r) =>
                verifier.verify(r.headers.get("authorization") ?? undefined),
              undefined,
              resource,
              service,
            ),
          requestInit: {
            headers: { Authorization: `Bearer ${await token(p)}` },
          },
        }),
      );
    }
    for (const [sender, recipient, key] of [
      [clients[0], clients[1], "dots-to-grok"],
      [clients[1], clients[0], "grok-to-dots"],
    ]) {
      const request = await call(sender, "ping_submit", {
        request_key: key,
        payload: "ping",
      });
      assert.equal(
        (await call(recipient, "ping_pending", {}))[0].id,
        request.id,
      );
      await call(recipient, "ping_reply", reply(request));
      const response = await call(sender, "ping_get", { id: request.id });
      assert.equal(response.reply.payload, "pong");
      const forbidden = await sender.callTool({ name: "claim", arguments: {} });
      assert.equal(forbidden.isError, true);
    }
  } finally {
    for (const client of clients) await client.close();
    h.close();
  }
});

test(
  "hung webhook is aborted within bounded wait and remains uncertain without replay",
  { timeout: 1000 },
  async () => {
    const h = new Hub(),
      service = new PingService(h, routes, { wakeTimeoutMs: 15 });
    let count = 0,
      signal;
    try {
      const task = await service.submit(dots, {
        request_key: "hung",
        payload: "ping",
      });
      const transport = {
        post: async (_body, s) => {
          count++;
          signal = s;
          return new Promise(() => {});
        },
      };
      assert.equal(await service.dispatchGrokWake(transport), true);
      assert.equal(signal.aborted, true);
      assert.equal(
        (
          await h.driver.batch([
            {
              sql: "SELECT delivery FROM diagnostic_outbox WHERE kind='requested'",
            },
          ])
        )[0][0].delivery,
        "uncertain",
      );
      assert.equal(await service.dispatchGrokWake(transport), false);
      assert.equal(count, 1);
      assert.equal((await service.get(dots, { id: task.id })).state, "pending");
    } finally {
      h.close();
    }
  },
);
test(
  "webhook wait uses remaining DB TTL even when local maximum is larger",
  { timeout: 1000 },
  async () => {
    let now = Date.now();
    const h = new Hub(":memory:", () => now),
      service = new PingService(h, routes, { wakeTimeoutMs: 3000 });
    try {
      const task = await service.submit(dots, {
        request_key: "ttl-wake",
        payload: "ping",
        ttl_ms: 1000,
      });
      await h.driver.batch([
        {
          sql:
            "UPDATE diagnostic_pings SET created=" +
            h.driver.nowSQL +
            "-980,expires=" +
            h.driver.nowSQL +
            "+20 WHERE id=?",
          params: [task.id],
        },
      ]);
      let signal;
      await service.dispatchGrokWake({
        post: async (_body, s) => {
          signal = s;
          return new Promise(() => {});
        },
      });
      assert.equal(signal.aborted, true);
      now += 21;
      assert.equal((await service.get(dots, { id: task.id })).state, "expired");
    } finally {
      h.close();
    }
  },
);
