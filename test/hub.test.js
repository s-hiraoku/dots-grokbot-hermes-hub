import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub, RESPONSE } from "../src/hub.js";
import { Adapter, MockRuns, drainOutbox } from "../src/adapter.js";
import { schemas, handler } from "../src/mcp.js";
const owner = {
  subject: "dummy-requester",
  destination: "hermes",
  operations: ["submit", "get", "cancel", "events"],
};
const worker = {
  subject: "dummy-worker",
  worker: "hermes",
  operations: ["claim", "get", "heartbeat", "complete"],
};
const submit = (h) =>
  h.submit(owner, { task_type: "connectivity_check", request_key: "check-1" });
const journal = () => ({
  value: null,
  load() {
    return this.value;
  },
  save(v) {
    this.value = structuredClone(v);
  },
  clear() {
    this.value = null;
  },
});
test("submit idempotency, fixed input, and authorization", () => {
  const h = new Hub();
  assert.equal(submit(h).id, submit(h).id);
  assert.throws(() => h.submit(null, {}));
  assert.throws(() =>
    h.submit(owner, {
      task_type: "connectivity_check",
      request_key: "k",
      prompt: "private",
    }),
  );
  assert.throws(() =>
    h.get({ ...owner, subject: "other" }, { id: submit(h).id }),
  );
  assert.throws(() => h.claim(owner));
  h.close();
});
test("single claim across connections, restart, lease expiry and fencing", () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-"));
  const path = join(dir, "test.db");
  let now = 100;
  const a = new Hub(path, () => now),
    b = new Hub(path, () => now);
  submit(a);
  const t = a.claim(worker);
  assert.equal(b.claim(worker), null);
  a.close();
  const c = new Hub(path, () => now);
  assert.equal(c.get(worker, { id: t.id }).fence, t.fence);
  now += 30001;
  assert.equal(b.claim(worker), null);
  assert.equal(c.get(worker, { id: t.id }).state, "waiting_approval");
  assert.throws(() =>
    c.complete(worker, { ...t, state: "succeeded", result: RESPONSE }),
  );
  b.close();
  c.close();
  rmSync(dir, { recursive: true });
});
test("cancel invalidates a running fence", () => {
  const h = new Hub();
  submit(h);
  const t = h.claim(worker);
  h.cancel(owner, t);
  assert.throws(() => h.heartbeat(worker, t));
  assert.equal(h.cancel(owner, t).state, "cancelled");
  h.close();
});
test("mock adapter roundtrip, result idempotency and durable outbox retries", async () => {
  const h = new Hub();
  const t = submit(h);
  const runs = new MockRuns();
  const a = new Adapter(h, worker, runs, journal());
  await a.once();
  assert.equal(h.get(owner, t).state, "succeeded");
  const done = h.get(owner, t);
  h.complete(worker, { ...done, result: RESPONSE });
  assert.equal(h.pending(owner).length, 1);
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
  assert.equal(h.pending(owner).length, 0);
  assert.equal(runs.calls, 1);
  h.close();
});
test("unknown run admission is reconciled using stable key after adapter restart", async () => {
  const h = new Hub();
  submit(h);
  const runs = new MockRuns();
  const create = runs.create.bind(runs);
  let first = true;
  runs.create = async (a) => {
    const r = await create(a);
    if (first) {
      first = false;
      throw new Error("lost response");
    }
    return r;
  };
  const j = journal();
  await assert.rejects(new Adapter(h, worker, runs, j).once());
  await new Adapter(h, worker, runs, j).once();
  assert.equal(runs.calls, 1);
  h.close();
});
test("unverified real runner fails before claim; free destinations rejected", async () => {
  const h = new Hub();
  const t = submit(h);
  await assert.rejects(
    new Adapter(h, worker, { toolIsolationVerified: false }, journal()).once(),
  );
  assert.equal(h.get(owner, t).state, "queued");
  for (const s of Object.values(schemas))
    assert.equal(
      s.safeParse({ agent: "hermes", url: "https://example.com" }).success,
      false,
    );
  h.close();
});
test("HTTP default rejects forged identity headers", async () => {
  let status;
  const res = {
    writeHead(s) {
      status = s;
    },
    end() {},
  };
  await handler(new Hub())(
    {
      headers: { "oai-authenticated-user-id": "dummy" },
      url: "/mcp",
      method: "POST",
    },
    res,
  );
  assert.equal(status, 401);
});
test("outbox and run journal survive actual database restart", async () => {
  const { Journal } = await import("../src/journal.js");
  const dir = mkdtempSync(join(tmpdir(), "hub-"));
  const path = join(dir, "hub.db"),
    jp = join(dir, "journal.db");
  const h = new Hub(path);
  submit(h);
  const t = h.claim(worker);
  h.complete(worker, {
    id: t.id,
    fence: t.fence,
    state: "succeeded",
    result: RESPONSE,
  });
  const j = new Journal(jp);
  j.save({ id: t.id, fence: t.fence, key: `hub-${t.id}` });
  j.close();
  h.close();
  const h2 = new Hub(path),
    j2 = new Journal(jp);
  assert.equal(h2.pending(owner).length, 1);
  await new Adapter(h2, worker, new MockRuns(), j2).once();
  assert.equal(j2.load(), null);
  j2.close();
  h2.close();
  rmSync(dir, { recursive: true });
});
