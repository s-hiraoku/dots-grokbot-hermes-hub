import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Adapter, MockRuns, drainOutbox } from "../src/adapter.ts";
import { Journal } from "../src/journal.ts";
import { Hub, owner, worker, submit, journal, RESPONSE } from "./fixtures.js";
for (const [scope, boundary] of [
  ["runner-a", "runner-b"],
  ["runner-a", undefined],
  [undefined, "runner-b"],
]) {
  test(`runner scope mismatch (${scope}/${boundary}) rejects before claim and leaves admission available`, async () => {
    let now = 100;
    const h = new Hub(":memory:", () => now);
    const j = journal();
    const runs = new MockRuns();
    runs.boundaryId = boundary;
    const principal = { ...worker, runnerScope: scope };
    const claim = h.claim.bind(h);
    let claims = 0;
    h.claim = (...args) => {
      claims++;
      return claim(...args);
    };
    try {
      const task = await submit(h);
      await assert.rejects(
        new Adapter(h, principal, runs, j).once(),
        /runner_scope_mismatch/,
      );
      assert.equal(claims, 0);
      assert.equal(runs.calls, 0);
      assert.equal(j.load(), null);
      now += 60000;
      const untouched = await h.get(owner, task);
      assert.equal(untouched.state, "queued");
      assert.equal(untouched.execution_open, 0);
      assert.equal(untouched.run_id, null);
      runs.boundaryId = scope;
      await new Adapter(h, principal, runs, j).run();
      const completed = await h.get(owner, task);
      assert.equal(completed.state, "succeeded");
      assert.equal(completed.execution_open, 0);
      assert.equal(runs.calls, 1);
    } finally {
      h.close();
    }
  });
}
test("automatic heartbeat maintains lease over multiple simulated 30-second windows", async () => {
  let now = 100;
  const h = new Hub(":memory:", () => now),
    j = journal(),
    runs = new MockRuns();
  const task = await submit(h),
    create = runs.create.bind(runs);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  runs.create = async (a) => {
    await gate;
    return create(a);
  };
  const heartbeat = h.heartbeat.bind(h);
  let renewals = 0;
  h.heartbeat = async (p, a) => {
    if (renewals++) now += 10000;
    const result = await heartbeat(p, a);
    if (renewals >= 6) release();
    return result;
  };
  try {
    await new Adapter(h, worker, runs, j, {
      heartbeatMs: 10,
      now: () => now,
    }).run();
    assert.ok(now >= 40100);
    assert.ok(renewals >= 5);
    assert.equal((await h.get(owner, task)).state, "succeeded");
  } finally {
    h.close();
  }
});
test("polling known run preserves one admission until terminal confirmation", async () => {
  const h = new Hub(),
    j = journal(),
    task = await submit(h);
  let creates = 0,
    reads = 0;
  const runs = {
    toolIsolationVerified: true,
    durableIdempotency: true,
    retentionMs: 86400000,
    async create() {
      creates++;
      return { id: "known", state: "running" };
    },
    async get(id) {
      return {
        id,
        state: ++reads < 3 ? "running" : "succeeded",
        text: RESPONSE,
      };
    },
  };
  try {
    await new Adapter(h, worker, runs, j, { pollMs: 2 }).run();
    assert.equal(creates, 1);
    assert.equal(reads, 3);
    assert.equal((await h.get(owner, task)).state, "succeeded");
  } finally {
    h.close();
  }
});
test("renewal failure aborts local wait and retains unknown admission for reconciliation", async () => {
  const h = new Hub(),
    j = journal(),
    task = await submit(h);
  let aborted = false;
  const heartbeat = h.heartbeat.bind(h);
  let calls = 0;
  h.heartbeat = async (p, a) => {
    if (++calls > 1) throw new Error("connection lost");
    return heartbeat(p, a);
  };
  const runs = {
    toolIsolationVerified: true,
    durableIdempotency: true,
    retentionMs: 86400000,
    async create({ signal }) {
      return new Promise((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("local request aborted"));
          },
          { once: true },
        ),
      );
    },
    async get() {
      throw new Error("unexpected");
    },
  };
  try {
    await assert.rejects(
      new Adapter(h, worker, runs, j, { heartbeatMs: 5 }).run(),
    );
    assert.equal(aborted, true);
    assert.ok(j.load());
    assert.equal((await h.get(owner, task)).execution_open, 1);
    assert.equal(await h.claim(worker), null);
  } finally {
    h.close();
  }
});
test("cancelled known run stays gated until terminal; no guessed stop endpoint", async () => {
  const h = new Hub(),
    j = journal(),
    task = await submit(h);
  let terminal = false,
    reads = 0;
  const runs = {
    toolIsolationVerified: true,
    durableIdempotency: true,
    retentionMs: 86400000,
    async create() {
      return { id: "known", state: "running" };
    },
    async get(id) {
      reads++;
      return { id, state: terminal ? "cancelled" : "running" };
    },
  };
  try {
    const a = new Adapter(h, worker, runs, j);
    await a.once();
    await h.cancel(owner, task);
    await a.once();
    assert.equal(reads, 1);
    assert.ok(j.load());
    assert.equal(await h.claim(worker), null);
    terminal = true;
    await assert.rejects(a.once(), /gate_reconciliation/);
    assert.ok(j.load());
    assert.equal((await h.get(owner, task)).execution_open, 1);
  } finally {
    h.close();
  }
});
for (const known of [true, false])
  test(`persistent restart reconciles ${known ? "known active run by ID" : "unknown admission by stable key"}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-worker-")),
      hp = join(dir, "hub.db"),
      jp = join(dir, "journal.db");
    let h = new Hub(hp),
      j = new Journal(jp);
    const task = await submit(h),
      runs = new MockRuns(),
      create = runs.create.bind(runs);
    let first = true,
      reads = 0;
    runs.create = async (a) => {
      const r = await create(a);
      if (first) {
        first = false;
        if (!known) throw new Error("lost response");
        return { ...r, state: "running" };
      }
      return r;
    };
    const get = runs.get.bind(runs);
    runs.get = async (id) => {
      reads++;
      return get(id);
    };
    try {
      const a = new Adapter(h, worker, runs, j);
      if (known) await a.once();
      else await assert.rejects(a.once());
      h.close();
      j.close();
      h = new Hub(hp);
      j = new Journal(jp);
      await new Adapter(h, worker, runs, j).run();
      assert.equal(runs.calls, 1);
      assert.equal(reads, known ? 1 : 0);
      assert.equal((await h.get(owner, task)).state, "succeeded");
    } finally {
      h.close();
      j.close();
      rmSync(dir, { recursive: true });
    }
  });
test("unverified runner and expired idempotency horizon never admit work", async () => {
  const h = new Hub(),
    task = await submit(h),
    j = journal(),
    runs = new MockRuns();
  try {
    runs.toolIsolationVerified = false;
    await assert.rejects(new Adapter(h, worker, runs, j).once());
    assert.equal((await h.get(owner, task)).state, "queued");
    runs.toolIsolationVerified = true;
    const claimed = await h.claim(worker);
    j.save({
      id: task.id,
      fence: claimed.fence,
      key: `hub-${task.id}`,
      run_id: null,
      admitted_at: 1,
    });
    await assert.rejects(
      new Adapter(h, worker, runs, j).once(),
      /horizon_expired/,
    );
    assert.equal(runs.calls, 0);
  } finally {
    h.close();
  }
});
test("outbox lost acknowledgement retries with same event ID", async () => {
  const h = new Hub(),
    task = await submit(h);
  try {
    await new Adapter(h, worker, new MockRuns(), journal()).run();
    const received = new Set();
    let first = true;
    const sink = {
      async send(id) {
        received.add(id);
        if (first) {
          first = false;
          throw new Error("lost ack");
        }
      },
    };
    await assert.rejects(drainOutbox(h, owner, sink));
    await drainOutbox(h, owner, sink);
    assert.equal(received.size, 1);
    assert.equal((await h.pending(owner)).length, 0);
    assert.equal((await h.get(owner, task)).state, "succeeded");
  } finally {
    h.close();
  }
});
test("hung heartbeat reaches a finite deadline and preserves the execution receipt", async () => {
  const h = new Hub(),
    j = journal(),
    task = await submit(h);
  let calls = 0;
  const heartbeat = h.heartbeat.bind(h);
  h.heartbeat = async (p, a) => {
    if (++calls > 1) return new Promise(() => {});
    return heartbeat(p, a);
  };
  const runs = {
    toolIsolationVerified: true,
    durableIdempotency: true,
    retentionMs: 86400000,
    async create({ signal }) {
      return new Promise((_r, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        }),
      );
    },
    async get() {
      throw new Error("unexpected");
    },
  };
  try {
    await assert.rejects(
      new Adapter(h, worker, runs, j, {
        heartbeatMs: 10,
        renewalTimeoutMs: 5,
      }).run(),
      /reconciliation/,
    );
    assert.ok(j.load());
    assert.equal((await h.get(owner, task)).execution_open, 1);
  } finally {
    h.close();
  }
});
test("explicit local stop aborts waiting without inventing a remote stop operation", async () => {
  const h = new Hub(),
    j = journal(),
    task = await submit(h),
    controller = new AbortController();
  const runs = {
    toolIsolationVerified: true,
    durableIdempotency: true,
    retentionMs: 86400000,
    async create({ signal }) {
      return new Promise((_r, reject) =>
        signal.addEventListener(
          "abort",
          () => reject(new Error("local stopped")),
          { once: true },
        ),
      );
    },
    async get() {
      throw new Error("unexpected");
    },
  };
  try {
    const running = new Adapter(h, worker, runs, j).run(controller.signal);
    setTimeout(() => controller.abort(), 5);
    await assert.rejects(running, /worker_stopped/);
    assert.ok(j.load());
    assert.equal((await h.get(owner, task)).execution_open, 1);
  } finally {
    h.close();
  }
});
test("abort during first heartbeat prevents Runs admission and preserves receipt", async () => {
  const h = new Hub(),
    j = journal(),
    task = await submit(h),
    runs = new MockRuns(),
    controller = new AbortController();
  const heartbeat = h.heartbeat.bind(h);
  h.heartbeat = async (p, a) => {
    const result = await heartbeat(p, a);
    controller.abort();
    return result;
  };
  try {
    await assert.rejects(
      new Adapter(h, worker, runs, j).once(controller.signal),
      /worker_stopped/,
    );
    assert.equal(runs.calls, 0);
    assert.ok(j.load());
    assert.equal((await h.get(owner, task)).state, "running");
    assert.equal((await h.get(owner, task)).execution_open, 1);
  } finally {
    h.close();
  }
});
test("abort during final heartbeat prevents terminal commit and receipt clear", async () => {
  const h = new Hub(),
    j = journal(),
    task = await submit(h),
    runs = new MockRuns(),
    controller = new AbortController();
  const heartbeat = h.heartbeat.bind(h);
  let calls = 0;
  h.heartbeat = async (p, a) => {
    const result = await heartbeat(p, a);
    if (++calls === 2) controller.abort();
    return result;
  };
  try {
    await assert.rejects(
      new Adapter(h, worker, runs, j).once(controller.signal),
      /worker_stopped/,
    );
    assert.equal(runs.calls, 1);
    assert.equal(j.load().run_id, "mock-1");
    assert.equal((await h.get(owner, task)).state, "running");
  } finally {
    h.close();
  }
});
