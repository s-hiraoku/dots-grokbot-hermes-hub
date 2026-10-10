import { PinnedJWTVerifier } from "../src/auth.ts";
import { OAuthResource } from "../src/oauth.ts";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { verifyInventoryUpgrade } from "./inventory-upgrade.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Hub, journal } from "./fixtures.js";
import {
  inventorySuite,
  inventoryOwner,
  inventoryWorker,
  MockInventoryRuns,
  fakeMetadata,
} from "./inventory-suite.js";
import { collectShiftLogInventory } from "../src/shift-log-inventory.ts";
import { canonicalResult, inventoryLocations } from "../src/task-contract.ts";
import { schemas, fetchMCP } from "../src/mcp-core.ts";
import { Adapter } from "../src/adapter.ts";
import { MCPHubClient } from "../src/client.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

test("SQLite inventory task contract", async (t) => {
  const h = new Hub();
  try {
    await inventorySuite(t, h);
  } finally {
    h.close();
  }
});
test("fixed inventory reads only bounded metadata, never marks an ambiguous match installed", async () => {
  const reads = [];
  const result = JSON.parse(
    await collectShiftLogInventory({
      lstat: async (path) => {
        reads.push(path);
        return fakeMetadata.lstat(path);
      },
    }),
  );
  assert.equal(result.status, "unknown");
  assert.equal(result.evidence.length, 5);
  assert.equal(reads.length, 14);
  assert.ok(
    reads.every((path) => /^\/(Applications|opt|usr)(\/|$)/.test(path)),
  );
  assert.ok(!JSON.stringify(result).includes("/"));
});
test("symlink parents stop probing; leaf symlinks are not followed or interpreted as installed", async () => {
  const reads = [];
  const result = JSON.parse(
    await collectShiftLogInventory({
      lstat: async (path) => {
        reads.push(path);
        return {
          isSymbolicLink: () =>
            path === "/opt/homebrew" || path.endsWith(".app"),
          isDirectory: () => true,
          isFile: () => false,
        };
      },
    }),
  );
  assert.ok(
    !reads.includes("/opt/homebrew/bin") &&
      !reads.includes("/opt/homebrew/bin/shift-log"),
  );
  assert.equal(result.evidence[3].observation, "unavailable");
  assert.equal(result.evidence[0].observation, "symlink_candidate");
  assert.equal(result.status, "unknown");
});
test("missing and denied metadata yield unknown with no error/path leakage", async () => {
  const result = JSON.parse(
    await collectShiftLogInventory({
      lstat: async (path) => {
        throw Object.assign(Error("secret fixture diagnostic"), {
          code: path === "/Applications" ? "ENOENT" : "EACCES",
        });
      },
    }),
  );
  assert.equal(result.evidence[0].observation, "missing");
  assert.equal(result.evidence[3].observation, "unavailable");
  assert.equal(result.status, "unknown");
  assert.ok(!JSON.stringify(result).includes("secret"));
});
test("task input/result reject shell, paths, prose, duplicate evidence and unsafe extra fields", async () => {
  for (const extra of [
    { path: "/tmp" },
    { shell: "whoami" },
    { prompt: "inspect secrets" },
    { taskTypes: ["shift_log_inventory"] },
  ])
    assert.equal(
      schemas.submit.safeParse({
        task_type: "shift_log_inventory",
        request_key: "fixed",
        ...extra,
      }).success,
      false,
    );
  const valid = JSON.parse(await collectShiftLogInventory(fakeMetadata));
  for (const invalid of [
    { ...valid, note: "free text" },
    { ...valid, evidence: valid.evidence.map((e) => ({ ...e, path: "/tmp" })) },
    {
      ...valid,
      evidence: valid.evidence.map((e) => ({
        ...e,
        location: inventoryLocations[0],
      })),
    },
  ])
    assert.equal(
      canonicalResult("shift_log_inventory", JSON.stringify(invalid)),
      undefined,
    );
});
test("authenticated mock Dots submit → worker inventory → Dots get returns bounded evidence without events", async () => {
  const h = new Hub();
  const dots = new Client({ name: "dots-fixture", version: "1" });
  const hermes = new Client({ name: "hermes-fixture", version: "1" });
  const localWorker = {
    ...inventoryWorker,
    runnerScope: "inventory-fixture-scope",
  };
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
  const verifier = new PinnedJWTVerifier({
    issuer: "https://issuer.example/",
    audience: "https://hub.example/mcp",
    kid: "fixture",
    key: keys.publicKey,
    requireClientId: true,
    active: async () => true,
    policy: [
      { ...inventoryOwner, kind: "user", clientId: "dots-client-fixture" },
      { ...localWorker, kind: "service", clientId: "worker-client-fixture" },
    ],
  });
  const token = async (p, clientId) => {
    const encode = (value) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const body = `${encode({ alg: "RS256", kid: "fixture" })}.${encode({ iss: "https://issuer.example/", aud: "https://hub.example/mcp", sub: p.subject, azp: clientId, exp: Math.floor(Date.now() / 1000) + 300, scope: p.operations.map((op) => `hub:${op}`).join(" ") })}`;
    return `${body}.${Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(body))).toString("base64url")}`;
  };
  const connect = async (client, accessToken) =>
    client.connect(
      new StreamableHTTPClientTransport(new URL("https://hub.example/mcp"), {
        fetch: (url, init) =>
          fetchMCP(h, new Request(url, init), (req) =>
            verifier.verify(req.headers.get("authorization") ?? undefined),
          ),
        requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
      }),
    );
  try {
    assert.equal(
      (
        await fetchMCP(
          h,
          new Request("https://hub.example/mcp", { method: "POST" }),
        )
      ).status,
      401,
    );
    await connect(dots, await token(inventoryOwner, "dots-client-fixture"));
    await connect(hermes, await token(localWorker, "worker-client-fixture"));
    const call = await dots.callTool({
      name: "submit",
      arguments: {
        task_type: "shift_log_inventory",
        request_key: "dots-inventory",
      },
    });
    assert.ok(!call.isError);
    const task = JSON.parse(call.content[0].text);
    const runs = new MockInventoryRuns();
    runs.boundaryId = localWorker.runnerScope;
    await new Adapter(
      new MCPHubClient(hermes),
      localWorker,
      runs,
      journal(),
    ).run();
    const response = await dots.callTool({
      name: "get",
      arguments: { id: task.id },
    });
    const result = JSON.parse(response.content[0].text);
    assert.equal(result.state, "succeeded");
    assert.equal(JSON.parse(result.result).status, "unknown");
  } finally {
    await dots.close();
    await hermes.close();
    h.close();
  }
});

test("SQLite legacy upgrade preserves running tasks, ACLs, notifications, stops and triggers; failure rolls back", async () => {
  const db = new DatabaseSync(":memory:");
  db.function("hub_now", () => Date.now());
  const driver = {
    nowSQL: "hub_now()",
    batch: async (statements) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const rows = statements.map((s) =>
          db.prepare(s.sql).all(...(s.params ?? [])),
        );
        db.exec("COMMIT");
        return rows;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  try {
    for (const name of readdirSync("drizzle")
      .filter((n) => n.endsWith(".sql") && n < "0006")
      .sort())
      db.exec(readFileSync(`drizzle/${name}`, "utf8"));
    await verifyInventoryUpgrade(driver);
  } finally {
    db.close();
  }
});

test("MVP discovery advertises only submit/get scopes and rejects worker scopes as user metadata", () => {
  const options = {
    issuer: "https://fixture.jp.auth0.com/",
    resource: "https://hub.example/mcp",
  };
  const resource = new OAuthResource({
    ...options,
    userScopes: ["hub:submit", "hub:get"],
  });
  assert.deepEqual(resource.metadata().scopes_supported, [
    "hub:submit",
    "hub:get",
  ]);
  assert.ok(resource.challenge().includes('scope="hub:submit hub:get"'));
  assert.throws(
    () => new OAuthResource({ ...options, userScopes: ["hub:claim"] }),
  );
});
