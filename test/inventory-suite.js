import assert from "node:assert/strict";
import { owner, worker, journal } from "./fixtures.js";
import { Adapter, MockRuns } from "../src/adapter.ts";
import { INVENTORY_REQUEST, canonicalResult } from "../src/task-contract.ts";
import { collectShiftLogInventory } from "../src/shift-log-inventory.ts";
export const inventoryOwner = { ...owner, taskTypes: ["shift_log_inventory"] };
export const inventoryWorker = {
  ...worker,
  taskTypes: ["shift_log_inventory"],
};
export const fakeMetadata = {
  lstat: async (path) => ({
    isSymbolicLink: () => false,
    isDirectory: () => !path.endsWith("shift-log"),
    isFile: () => path.endsWith("shift-log"),
  }),
};
export class MockInventoryRuns extends MockRuns {
  supportedTaskTypes = ["shift_log_inventory"];
  admissionContract = "mock-inventory-v1";
  async create(a) {
    assert.equal(a.prompt, INVENTORY_REQUEST);
    assert.deepEqual(a.tools, []);
    const old = this.byKey.get(a.idempotencyKey);
    if (old) return old;
    const run = {
      id: `mock-inventory-${++this.calls}`,
      state: "succeeded",
      text: await collectShiftLogInventory(fakeMetadata),
    };
    this.byKey.set(a.idempotencyKey, run);
    return run;
  }
}
export async function inventorySuite(t, h) {
  await h.driver.batch([{ sql: "DELETE FROM tasks" }]);
  const submit = (key) =>
    h.submit(inventoryOwner, {
      task_type: "shift_log_inventory",
      request_key: key,
    });
  await t.test(
    "explicit task policy and worker allowlist keep existing connectivity worker isolated",
    async () => {
      await assert.rejects(
        h.submit(owner, {
          task_type: "shift_log_inventory",
          request_key: "deny",
        }),
      );
      const task = await submit("inventory-fixed");
      assert.equal(await h.claim(worker), null);
      const unsupported = new MockRuns();
      await assert.rejects(
        new Adapter(h, inventoryWorker, unsupported, journal()).run(),
        /runner_task_type_unverified/,
      );
      assert.equal((await h.get(inventoryOwner, task)).state, "queued");
      const runs = new MockInventoryRuns();
      await new Adapter(h, inventoryWorker, runs, journal()).run();
      const result = await h.get(inventoryOwner, task);
      assert.equal(result.state, "succeeded");
      assert.equal(JSON.parse(result.result).status, "unknown");
      assert.equal(
        canonicalResult("shift_log_inventory", result.result),
        result.result,
      );
      assert.equal((await submit("inventory-fixed")).id, task.id);
      assert.equal(runs.calls, 1);
      await assert.rejects(
        h.submit(
          { ...owner, taskTypes: ["connectivity_check"] },
          { task_type: "connectivity_check", request_key: "inventory-fixed" },
        ),
        /idempotency_task_type_conflict/,
      );
      assert.equal(
        (await h.pending(owner)).some((e) => e.task === task.id),
        true,
      );
    },
  );
  await t.test(
    "wrong task result and free-form installed assertions never complete inventory",
    async () => {
      const task = await submit("inventory-reject");
      const lease = await h.claim(inventoryWorker);
      for (const result of [
        "Agent Hub connectivity check completed.",
        '{"status":"installed"}',
        await collectShiftLogInventory(fakeMetadata).then((text) =>
          text.replace('"unknown"', '"installed"'),
        ),
      ]) {
        await assert.rejects(
          h.complete(inventoryWorker, { ...lease, state: "succeeded", result }),
        );
      }
      await h.complete(inventoryWorker, {
        ...lease,
        state: "failed",
        result: "shift_log_inventory_failed",
      });
      assert.equal((await h.get(inventoryOwner, task)).state, "failed");
    },
  );
}
