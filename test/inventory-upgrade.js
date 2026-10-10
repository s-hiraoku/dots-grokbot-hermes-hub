import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TaskService } from "../src/store.ts";
import { owner, worker, RESPONSE } from "./fixtures.js";
export const upgradeStatements = () =>
  readFileSync("drizzle/0006_shift_log_inventory.sql", "utf8")
    .split("--> statement-breakpoint")
    .map((sql) => ({ sql: sql.trim() }))
    .filter((s) => s.sql);
export async function verifyInventoryUpgrade(driver) {
  const h = new TaskService(driver);
  const p = { ...worker, runnerScope: "fixture-preserved-scope" };
  const task = await h.submit(
    { ...owner, resultReaders: [{ subject: "fixture-reader", notify: true }] },
    { task_type: "connectivity_check", request_key: "pre-upgrade-running" },
  );
  const run = await h.claim(p);
  await h.heartbeat(p, { ...run, run_id: "fixture-preserved-run" });
  const cancelled = await h.submit(owner, {
    task_type: "connectivity_check",
    request_key: "pre-upgrade-cancelled",
  });
  await h.cancel(owner, cancelled);
  await driver.batch([
    {
      sql: "INSERT INTO subscriptions(id,subject,task,url,secret_ref,revision,expires,active,verified_until,at,client_id) VALUES('fixture-sub','fixture-reader',?,'https://callback.example/fixture','fixture-ciphertext',1,9999999999999,1,0,1,'fixture-client')",
      params: [task.id],
    },
  ]);
  await h.authorization.setStopped(
    { kind: "subject", id: "fixture-stopped-subject" },
    true,
    0,
    "fixture-maintainer",
  );
  const tables = [
    "tasks",
    "task_access",
    "subscriptions",
    "audit",
    "outbox",
    "authorization_state",
    "authorization_audit",
  ];
  const snapshot = async () =>
    JSON.stringify(
      (
        await driver.batch(
          tables.map((name) => ({
            sql: `SELECT * FROM ${name} ORDER BY rowid`,
          })),
        )
      ).map((rows) =>
        rows.map((row) =>
          Object.fromEntries(
            Object.entries(row).sort(([a], [b]) => a.localeCompare(b)),
          ),
        ),
      ),
    );
  const before = await snapshot();
  // A failed migration must not leave half-rebuilt task state, lost triggers or indexes.
  await assert.rejects(
    driver.batch([
      ...upgradeStatements(),
      { sql: "SELECT * FROM fixture_nonexistent_table" },
    ]),
  );
  assert.equal(await snapshot(), before);
  await driver.batch(upgradeStatements());
  assert.equal(await snapshot(), before);
  const preserved = await h.get(p, task);
  assert.equal(preserved.run_id, "fixture-preserved-run");
  assert.equal(preserved.runner_scope, p.runnerScope);
  assert.equal(preserved.runner_subject, p.subject);
  assert.equal(preserved.fence, run.fence);
  assert.equal(preserved.execution_open, 1);
  const auditBefore = (await driver.batch([{ sql: "SELECT * FROM audit" }]))[0]
    .length;
  await h.complete(p, { ...run, state: "succeeded", result: RESPONSE });
  const rows = await driver.batch([
    { sql: "SELECT * FROM audit" },
    { sql: "SELECT * FROM outbox WHERE task=?", params: [task.id] },
  ]);
  assert.equal(rows[0].length, auditBefore + 1);
  assert.equal(rows[1].length, 1);
  assert.equal(
    await h.authorization.isActive("fixture-stopped-subject"),
    false,
  );
  const inventory = await h.submit(
    { ...owner, taskTypes: ["shift_log_inventory"] },
    { task_type: "shift_log_inventory", request_key: "post-upgrade-inventory" },
  );
  assert.equal(inventory.task_type, "shift_log_inventory");
}
