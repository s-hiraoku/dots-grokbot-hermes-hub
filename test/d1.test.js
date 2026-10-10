import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { D1Hub } from "../src/d1.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Adapter, MockRuns } from "../src/adapter.ts";
import { MCPHubClient } from "../src/client.ts";
import { owner, worker, submit, journal, finish } from "./fixtures.js";
import { SecretVault, SubscriptionService } from "../src/subscriptions.ts";
import { storeSuite } from "./store-suite.js";
const options = (path) =>
  convertV4MiniflareOptions({
    telemetry: { enabled: false },
    modules: true,
    scriptPath: path,
    compatibilityDate: "2026-08-01",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "local-hub-fixture" },
    outboundService: () => new Response(null, { status: 403 }),
  });
async function migrate(db) {
  for (const name of readdirSync("drizzle")
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    const statements = readFileSync(`drizzle/${name}`, "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
    await db.batch(statements.map((sql) => db.prepare(sql)));
  }
}
test("local Worker D1 contract, concurrent calls and HTTP adapter roundtrip", async (t) => {
  await build({
    entryPoints: ["test/worker-fixture.ts"],
    bundle: true,
    platform: "browser",
    format: "esm",
    outfile: "dist/fixture-worker.js",
    external: ["node:*"],
  });
  const mf = new Miniflare(options("dist/fixture-worker.js"));
  try {
    const db = await mf.getD1Database("DB");
    await migrate(db);
    const h = new D1Hub(db);
    await storeSuite(t, h);
    await t.test(
      "D1 persists subscription and fenced delivery state",
      async () => {
        await h.driver.batch([{ sql: "DELETE FROM tasks" }]);
        const reader = {
          subject: "d1-dots-fixture",
          operations: ["events", "get"],
        };
        const task = await h.submit(
          {
            ...owner,
            resultReaders: [{ subject: reader.subject, notify: true }],
          },
          { task_type: "connectivity_check", request_key: "d1-events" },
        );
        let delivered = 0;
        const vault = new SecretVault(
          await crypto.subtle.generateKey(
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"],
          ),
        );
        const service = () =>
          new SubscriptionService({
            hub: h,
            vault,
            identityActive: async () => true,
            transportFor: () => ({
              post: async (_url, _headers, body) => {
                const event = JSON.parse(body);
                if (event.type === "verification")
                  return {
                    status: 200,
                    body: JSON.stringify({ challenge: event.challenge }),
                  };
                delivered++;
                return { status: 204, body: "" };
              },
            }),
          });
        await service().subscribe(reader, {
          name: "task.terminal",
          arguments: { task_id: task.id },
          delivery: {
            mode: "webhook",
            url: "https://callback.example/d1-fixture",
            secret: `whsec_${Buffer.alloc(32, 4).toString("base64")}`,
          },
        });
        await finish(h, await h.claim(worker));
        await service().dispatchOne();
        await service().dispatchOne();
        assert.equal(delivered, 1);
        const rows = await h.driver.batch([
          {
            sql: "SELECT state,attempts FROM deliveries WHERE subscription IN(SELECT id FROM subscriptions WHERE task=?)",
            params: [task.id],
          },
        ]);
        assert.equal(rows[0][0].state, "delivered");
        assert.equal(rows[0][0].attempts, 1);
      },
    );
    for (const operation of ["heartbeat", "complete"])
      await t.test(
        `D1 ${operation} rejects expiry during driver delay`,
        async () => {
          await h.driver.batch([{ sql: "DELETE FROM tasks" }]);
          await submit(h, `delay-${operation}`);
          const task = await h.claim(worker);
          const original = h.driver.batch.bind(h.driver);
          h.driver.batch = async (statements) => {
            await original([
              {
                sql: `UPDATE tasks SET lease=${h.driver.nowSQL}-1 WHERE id=?`,
                params: [task.id],
              },
            ]);
            return original(statements);
          };
          try {
            await assert.rejects(
              operation === "heartbeat"
                ? h.heartbeat(worker, task)
                : finish(h, task),
            );
          } finally {
            h.driver.batch = original;
          }
          assert.equal((await h.get(worker, task)).state, "running");
        },
      );
    await h.driver.batch([{ sql: "DELETE FROM tasks" }]);
    const task = await submit(h, "worker-http");
    const client = new Client({ name: "fixture-worker", version: "1" });
    const transport = new StreamableHTTPClientTransport(
      new URL("http://localhost/mcp"),
      {
        fetch: (url, init) => mf.dispatchFetch(String(url), init),
        requestInit: { headers: { Authorization: "Bearer fixture-worker" } },
      },
    );
    try {
      await client.connect(transport);
      const runs = new MockRuns();
      await new Adapter(
        new MCPHubClient(client),
        worker,
        runs,
        journal(),
      ).run();
      assert.equal((await h.get(owner, task)).state, "succeeded");
      assert.equal(runs.calls, 1);
    } finally {
      await client.close();
    }
  } finally {
    await mf.dispose();
  }
});
test("production Worker denies forged headers by default", async () => {
  const mf = new Miniflare(options("dist/worker.js"));
  try {
    const r = await mf.dispatchFetch("http://localhost/mcp", {
      method: "POST",
      headers: { "oai-authenticated-user-id": "forged" },
      body: "{}",
    });
    assert.equal(r.status, 401);
  } finally {
    await mf.dispose();
  }
});
test("local D1 persists task state after emulator restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-d1-"));
  const config = { ...options("dist/worker.js"), resourcePersistencePath: dir };
  let mf = new Miniflare(config);
  try {
    let db = await mf.getD1Database("DB");
    await migrate(db);
    const task = await submit(new D1Hub(db));
    await mf.dispose();
    mf = new Miniflare(config);
    db = await mf.getD1Database("DB");
    assert.equal((await new D1Hub(db).get(owner, task)).state, "queued");
  } finally {
    await mf.dispose();
    rmSync(dir, { recursive: true });
  }
});
