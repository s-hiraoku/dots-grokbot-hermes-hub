import assert from "node:assert/strict";
import { owner, worker, RESPONSE } from "./fixtures.js";
const requester = { ...owner, clientId: "requester-client" };
const other = { ...owner, clientId: "other-client" };
const operator = {
  ...requester,
  operations: [
    "submit",
    "get",
    "cancel",
    "events",
    "claim",
    "heartbeat",
    "complete",
    "grants",
    "reconcile",
  ],
  worker: "hermes",
};
const change = async (h, target, stopped = true) =>
  h.authorization.setStopped(
    target,
    stopped,
    await h.authorization.epoch(),
    "fixture-maintainer",
  );
const submit = (h, p = requester, key = "gate-fixture") =>
  h.submit(p, { task_type: "connectivity_check", request_key: key });
export async function authorizationSuite(t, h) {
  async function check(name, fn) {
    await h.driver.batch([
      { sql: "DELETE FROM tasks" },
      { sql: "DELETE FROM task_access" },
      { sql: "DELETE FROM audit" },
      { sql: "DELETE FROM outbox" },
      { sql: "DELETE FROM subscriptions" },
      { sql: "DELETE FROM deliveries" },
      { sql: "DELETE FROM authorization_audit" },
      { sql: "DELETE FROM authorization_state WHERE kind<>'global'" },
      {
        sql: "UPDATE authorization_state SET stopped=0,epoch=0 WHERE kind='global'",
      },
    ]);
    await t.test(name, fn);
  }
  for (const target of [
    { kind: "global", id: "*" },
    { kind: "subject", id: requester.subject },
    { kind: "client", id: requester.clientId },
  ]) {
    await check(
      `${target.kind} stop denies a previously authenticated principal at operation time`,
      async () => {
        const p = await h.authorization.bind(requester);
        const task = await submit(h, p);
        await change(h, target);
        await assert.rejects(h.get(p, task), /authorization_rejected/);
        await assert.rejects(
          submit(h, p, "after-stop"),
          /authorization_rejected/,
        );
        assert.equal(
          await h.authorization.isActive(p.subject, p.clientId),
          false,
        );
        if (target.kind === "client")
          assert.equal((await h.get(other, task)).id, task.id);
        const rows = await h.driver.batch([
          { sql: "SELECT * FROM authorization_audit" },
          { sql: "SELECT * FROM authorization_checks" },
        ]);
        assert.equal(rows[0].length, 1);
        assert.equal(rows[0][0].actor, "fixture-maintainer");
        assert.deepEqual(
          Object.keys(rows[0][0]).sort(),
          ["seq", "kind", "target", "stopped", "epoch", "actor", "at"].sort(),
        );
        assert.equal(rows[1].length, 0);
      },
    );
  }
  await check(
    "stop and restore invalidate old requests; fresh identity remains subject to enrollment outside the gate",
    async () => {
      const p = await h.authorization.bind(requester);
      await change(h, { kind: "subject", id: requester.subject });
      await change(h, { kind: "subject", id: requester.subject }, false);
      await assert.rejects(submit(h, p), /authorization_rejected/);
      await assert.rejects(h.authorization.bind(p), /authorization_rejected/);
      assert.equal(
        (await submit(h, await h.authorization.bind(requester))).state,
        "queued",
      );
    },
  );
  await check(
    "a competing stop before SQL application prevents every write in the task batch",
    async () => {
      const p = await h.authorization.bind(requester);
      const original = h.driver.batch.bind(h.driver);
      let injected = false;
      h.driver.batch = async (statements) => {
        if (
          !injected &&
          statements.some((s) =>
            s.sql.startsWith("INSERT OR IGNORE INTO tasks"),
          )
        ) {
          injected = true;
          await change(h, { kind: "subject", id: p.subject });
        }
        return original(statements);
      };
      try {
        await assert.rejects(
          submit(h, {
            ...p,
            resultReaders: [{ subject: "reader", notify: true }],
          }),
          /authorization_rejected/,
        );
      } finally {
        h.driver.batch = original;
      }
      assert.equal(injected, true);
      const rows = await original([
        { sql: "SELECT * FROM tasks" },
        { sql: "SELECT * FROM authorization_checks" },
        { sql: "SELECT * FROM task_access" },
        { sql: "SELECT * FROM audit" },
        { sql: "SELECT * FROM outbox" },
      ]);
      assert.equal(rows[2].length, 0);
      assert.equal(rows[3].length, 0);
      assert.equal(rows[4].length, 0);
      assert.equal(rows[0].length, 0);
      assert.equal(rows[1].length, 0);
    },
  );
  await check(
    "control compare-and-swap rejects a competing stale decision without partial changes",
    async () => {
      const epoch = await h.authorization.epoch();
      const outcomes = await Promise.allSettled([
        h.authorization.setStopped(
          { kind: "subject", id: requester.subject },
          true,
          epoch,
          "maintainer-a",
        ),
        h.authorization.setStopped(
          { kind: "client", id: requester.clientId },
          true,
          epoch,
          "maintainer-b",
        ),
      ]);
      assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
      const rows = await h.driver.batch([
        { sql: "SELECT * FROM authorization_state WHERE kind<>'global'" },
        { sql: "SELECT * FROM authorization_audit" },
        { sql: "SELECT * FROM authorization_control_checks" },
      ]);
      assert.equal(rows[0].length, 1);
      assert.equal(rows[1].length, 1);
      assert.equal(rows[2].length, 0);
    },
  );
  await check(
    "legacy missing client binding cannot bypass any client stop",
    async () => {
      await change(h, { kind: "client", id: "some-other-client" });
      await assert.rejects(submit(h, owner), /authorization_rejected/);
      assert.equal(await h.authorization.isActive(owner.subject), false);
      assert.equal((await submit(h, requester)).state, "queued");
    },
  );
  await check(
    "all task and internal event operations use the shared gate",
    async () => {
      const task = await submit(h, operator);
      const lease = await h.claim({ ...worker, clientId: "worker-client" });
      await change(h, { kind: "global", id: "*" });
      const calls = [
        () => h.get(operator, task),
        () => h.view(operator, task),
        () => submit(h, operator),
        () => h.claim(operator),
        () => h.heartbeat(operator, lease),
        () =>
          h.complete(operator, {
            ...lease,
            state: "succeeded",
            result: RESPONSE,
          }),
        () => h.cancel(operator, task),
        () => h.pending(operator),
        () => h.ack(operator, "event"),
        () => h.revokeReader(operator, { id: task.id, subject: "reader" }),
        () => h.reconciliationTask(operator, task.id),
        () => h.reconcile(operator, task, {}),
      ];
      for (const call of calls)
        await assert.rejects(call(), /authorization_rejected/);
      assert.equal(
        (
          await h.driver.batch([
            {
              sql: "SELECT execution_open FROM tasks WHERE id=?",
              params: [task.id],
            },
          ])
        )[0][0].execution_open,
        1,
      );
    },
  );
  await check(
    "missing global gate state denies rather than recreating enabled state",
    async () => {
      await h.driver.batch([
        { sql: "DELETE FROM authorization_state WHERE kind='global'" },
      ]);
      await assert.rejects(submit(h), /authorization_rejected/);
      assert.equal(
        await h.authorization.isActive(requester.subject, requester.clientId),
        false,
      );
      await assert.rejects(
        change(h, { kind: "global", id: "*" }, false),
        /authorization_unavailable/,
      );
    },
  );
}
