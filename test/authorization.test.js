import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fork } from "node:child_process";
import { once } from "node:events";
import { Hub, owner } from "./fixtures.js";
import { authorizationSuite } from "./authorization-suite.js";
import { DurableAuthorization } from "../src/authorization.ts";
import { fetchMCP } from "../src/mcp-core.ts";

test("SQLite durable authorization contract", async (t) => {
  const h = new Hub();
  try {
    await authorizationSuite(t, h);
  } finally {
    h.close();
  }
});
test(
  "stops and audit survive reopening; a second OS process cannot use its old authentication after restore",
  { timeout: 15000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-authz-fixture-"));
    const path = join(dir, "fixture.sqlite");
    let h = new Hub(path),
      child;
    try {
      child = fork(
        new URL("./authorization-process.js", import.meta.url),
        [path],
        { stdio: ["ignore", "ignore", "ignore", "ipc"] },
      );
      const [ready] = await once(child, "message");
      assert.equal(ready.ready, true);
      await h.authorization.setStopped(
        { kind: "subject", id: owner.subject },
        true,
        0,
        "fixture-maintainer",
      );
      h.close();
      h = new Hub(path);
      assert.equal(
        await h.authorization.isActive(owner.subject, "process-client"),
        false,
      );
      assert.equal(
        (
          await h.driver.batch([{ sql: "SELECT * FROM authorization_audit" }])
        )[0].length,
        1,
      );
      await h.authorization.setStopped(
        { kind: "subject", id: owner.subject },
        false,
        1,
        "fixture-maintainer",
      );
      const response = once(child, "message");
      child.send("continue");
      assert.equal((await response)[0].rejected, true);
      assert.equal(
        (await h.driver.batch([{ sql: "SELECT * FROM tasks" }]))[0].length,
        0,
      );
    } finally {
      child?.kill();
      h.close();
      rmSync(dir, { recursive: true });
    }
  },
);
test("database outage is a deny for notifications and authenticated HTTP admission", async () => {
  const driver = {
    nowSQL: "0",
    batch: async () => {
      throw Error("fixture-db-unavailable");
    },
  };
  const gate = new DurableAuthorization(driver);
  assert.equal(await gate.isActive(owner.subject), false);
  const response = await fetchMCP(
    { authorization: gate },
    new Request("https://hub.example/mcp", { method: "POST", body: "{}" }),
    async () => owner,
  );
  assert.equal(response.status, 401);
  await assert.rejects(gate.bind(owner), /fixture-db-unavailable/);
});
