import assert from "node:assert/strict";
import { owner, worker, submit, finish, RESPONSE } from "./fixtures.js";
export async function storeSuite(t, h) {
  const reset = () =>
    h.driver.batch([
      { sql: "DELETE FROM tasks" },
      { sql: "DELETE FROM audit" },
      { sql: "DELETE FROM outbox" },
    ]);
  const check = async (name, fn) => {
    await reset();
    await t.test(name, fn);
  };
  await check(
    "fixed requests, idempotency and principal isolation",
    async () => {
      const a = await submit(h);
      assert.equal((await submit(h)).id, a.id);
      await assert.rejects(h.submit(null, {}));
      await assert.rejects(
        h.submit(owner, {
          task_type: "connectivity_check",
          request_key: "k",
          prompt: "private",
        }),
      );
      await assert.rejects(h.get({ ...owner, subject: "other" }, { id: a.id }));
      await assert.rejects(h.claim(owner));
    },
  );
  await check(
    "cancel requires explicit operation and ownership; submit routing is independent",
    async () => {
      const task = await submit(h);
      await assert.rejects(h.cancel(worker, task));
      await assert.rejects(
        h.cancel({ ...owner, subject: "other-owner" }, task),
      );
      const cancelled = await h.cancel(
        { subject: owner.subject, operations: ["cancel"] },
        task,
      );
      assert.equal(cancelled.state, "cancelled");
    },
  );
  await check(
    "simultaneous claim attempts yield exactly one winner",
    async () => {
      await submit(h);
      await submit(h, "second");
      const claims = await Promise.all(
        Array.from({ length: 12 }, () => h.claim(worker, {})),
      );
      assert.equal(claims.filter(Boolean).length, 1);
    },
  );
  await check("expiry quarantine and stale fences fail closed", async () => {
    await submit(h);
    const task = await h.claim(worker);
    await h.driver.batch([
      { sql: "UPDATE tasks SET lease=0 WHERE id=?", params: [task.id] },
    ]);
    assert.equal(await h.claim(worker), null);
    assert.equal((await h.get(worker, task)).state, "waiting_approval");
    await assert.rejects(finish(h, task));
  });
  await check(
    "cancelled running task holds gate, queued cancel does not",
    async () => {
      const first = await submit(h);
      const active = await h.claim(worker);
      const next = await submit(h, "next");
      await h.cancel(owner, first);
      assert.equal(await h.claim(worker), null);
      await assert.rejects(h.heartbeat(worker, active));
      assert.equal((await h.get(owner, next)).state, "queued");
      await h.cancel(owner, next);
      assert.equal((await h.get(owner, next)).execution_open, 0);
    },
  );
  await check("atomic terminal audit and outbox are idempotent", async () => {
    await submit(h);
    const task = await h.claim(worker);
    await finish(h, task);
    const before = await h.driver.batch([
      { sql: "SELECT * FROM audit" },
      { sql: "SELECT * FROM outbox" },
    ]);
    await finish(h, task);
    const after = await h.driver.batch([
      { sql: "SELECT * FROM audit" },
      { sql: "SELECT * FROM outbox" },
    ]);
    assert.deepEqual(after, before);
    assert.equal(after[1].length, 1);
    await h.ack({ ...owner, subject: "other" }, after[1][0].id);
    assert.equal((await h.pending(owner)).length, 1);
    await h.ack(owner, after[1][0].id);
    assert.equal((await h.pending(owner)).length, 0);
  });
  await check("failed batches roll back task, audit and outbox", async () => {
    const task = await submit(h);
    await assert.rejects(
      h.driver.batch([
        {
          sql: "UPDATE tasks SET state='cancelled',actor='fixture',mutation='rollback' WHERE id=?",
          params: [task.id],
        },
        { sql: "INSERT INTO missing_table VALUES(1)" },
      ]),
    );
    assert.equal((await h.get(owner, task)).state, "queued");
    assert.equal((await h.pending(owner)).length, 0);
    const audit = await h.driver.batch([{ sql: "SELECT * FROM audit" }]);
    assert.equal(audit[0].length, 1);
  });
  await check(
    "complete/cancel race leaves one authorized terminal outcome",
    async () => {
      const task = await submit(h);
      const claimed = await h.claim(worker);
      await Promise.allSettled([finish(h, claimed), h.cancel(owner, task)]);
      const end = await h.get(owner, task);
      assert.ok(["succeeded", "cancelled"].includes(end.state));
      assert.equal((await h.pending(owner)).length, 1);
      if (end.state === "cancelled") assert.equal(end.execution_open, 1);
    },
  );
  await check(
    "run binding conflict and result tampering rejected",
    async () => {
      await submit(h);
      const task = await h.claim(worker);
      await h.heartbeat(worker, {
        id: task.id,
        fence: task.fence,
        run_id: "known",
      });
      await assert.rejects(
        h.heartbeat(worker, {
          id: task.id,
          fence: task.fence,
          run_id: "other",
        }),
      );
      await assert.rejects(
        h.complete(worker, {
          id: task.id,
          fence: task.fence,
          state: "succeeded",
          result: "untrusted",
        }),
      );
      assert.equal((await h.get(worker, task)).run_id, "known");
      assert.equal(RESPONSE, (await finish(h, task)).result);
    },
  );
}
