import { test } from "node:test";
import assert from "node:assert/strict";
import { Hub, owner, worker, RESPONSE, journal } from "./fixtures.js";
import { Adapter, MockRuns } from "../src/adapter.ts";
import { workerLoop } from "../src/worker-loop.ts";
const observer = { subject: "dots-observer", operations: ["get", "events"] };
const admin = {
  subject: "fixture-operator",
  operations: ["grants", "reconcile"],
};
test("atomic result grants, minimal observer view, revocation and submit replay", async () => {
  const h = new Hub();
  try {
    const requester = {
      ...owner,
      resultReaders: [{ subject: observer.subject, notify: true }],
    };
    const t = await h.submit(requester, {
      task_type: "connectivity_check",
      request_key: "grant",
    });
    assert.equal(await h.canNotify(observer.subject, t.id), true);
    assert.deepEqual(Object.keys(await h.view(observer, t)).sort(), [
      "at",
      "id",
      "result",
      "state",
    ]);
    await h.revokeReader(admin, { id: t.id, subject: observer.subject });
    await assert.rejects(h.get(observer, t));
    await h.submit(requester, {
      task_type: "connectivity_check",
      request_key: "grant",
    });
    assert.equal(await h.canNotify(observer.subject, t.id), false);
    assert.equal(
      h.sqlite.db.prepare("SELECT count(*) n FROM access_audit").get().n,
      2,
    );
  } finally {
    h.close();
  }
});
test("reconciliation requires known original scope and exact successful run proof", async () => {
  let now = 1000;
  const h = new Hub(":memory:", () => now);
  const scoped = { ...worker, runnerScope: "fixed-runner" };
  try {
    await h.submit(owner, {
      task_type: "connectivity_check",
      request_key: "reconcile",
    });
    const t = await h.claim(scoped);
    await h.heartbeat(scoped, { ...t, run_id: "known" });
    now += 31000;
    await h.claim(scoped);
    const parked = await h.get(scoped, t);
    const runs = {
      boundaryId: "fixed-runner",
      toolIsolationVerified: true,
      durableIdempotency: true,
      get: async () => ({ id: "known", state: "running" }),
    };
    await assert.rejects(h.reconcile(admin, parked, runs));
    runs.get = async () => ({ id: "known", state: "cancelled" });
    await assert.rejects(h.reconcile(admin, parked, runs));
    runs.get = async () => ({
      id: "other",
      state: "succeeded",
      text: RESPONSE,
    });
    await assert.rejects(h.reconcile(admin, parked, runs));
    runs.get = async () => ({
      id: "known",
      state: "succeeded",
      text: RESPONSE,
    });
    await assert.rejects(
      h.reconcile(admin, parked, { ...runs, boundaryId: "wrong" }),
    );
    const done = await h.reconcile(admin, parked, runs);
    assert.equal(done.execution_open, 0);
    assert.equal(done.state, "succeeded");
    assert.equal(done.fence, parked.fence + 1);
    assert.equal(
      h.sqlite.db.prepare("SELECT count(*) n FROM outbox").get().n,
      1,
    );
  } finally {
    h.close();
  }
});
test("explicit bounded worker loop drains two tasks without result-triggered admission", async () => {
  const h = new Hub();
  try {
    await h.submit(owner, {
      task_type: "connectivity_check",
      request_key: "one",
    });
    await h.submit(owner, {
      task_type: "connectivity_check",
      request_key: "two",
    });
    const runs = new MockRuns(),
      receipt = journal();
    const cycles = await workerLoop({
      adapter: async () => new Adapter(h, worker, runs, receipt),
      signal: new AbortController().signal,
      maxCycles: 3,
      wait: async () => {},
    });
    assert.equal(cycles, 3);
    assert.equal(runs.calls, 2);
    assert.equal(receipt.load(), null);
    assert.equal(
      h.sqlite.db.prepare("SELECT count(*) n FROM tasks").get().n,
      2,
    );
  } finally {
    h.close();
  }
});
test("a second worker identity or scope cannot inspect or finish the first admission", async () => {
  const h = new Hub();
  try {
    await h.submit(owner, {
      task_type: "connectivity_check",
      request_key: "worker-isolation",
    });
    const first = { ...worker, runnerScope: "scope-one" };
    const t = await h.claim(first);
    for (const other of [
      { ...first, subject: "other-worker" },
      { ...first, runnerScope: "scope-two" },
    ]) {
      await assert.rejects(h.get(other, t));
      await assert.rejects(h.heartbeat(other, t));
      await assert.rejects(
        h.complete(other, { ...t, state: "succeeded", result: RESPONSE }),
      );
    }
    assert.equal((await h.get(first, t)).state, "running");
  } finally {
    h.close();
  }
});

test("worker granted observer access still receives minimal projection for another runner", async () => {
  const h = new Hub();
  try {
    const reader = {
      ...worker,
      subject: "other-worker",
      runnerScope: "other-scope",
    };
    await h.submit(
      { ...owner, resultReaders: [{ subject: reader.subject, notify: true }] },
      { task_type: "connectivity_check", request_key: "worker-observer" },
    );
    const first = { ...worker, runnerScope: "first-scope" },
      task = await h.claim(first);
    assert.deepEqual(Object.keys(await h.view(reader, task)).sort(), [
      "at",
      "id",
      "result",
      "state",
    ]);
    await assert.rejects(h.heartbeat(reader, task));
    await assert.rejects(
      h.complete(reader, { ...task, state: "succeeded", result: RESPONSE }),
    );
  } finally {
    h.close();
  }
});
