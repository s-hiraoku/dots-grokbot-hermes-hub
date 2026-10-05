import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { Hub, owner, worker, submit, finish } from "./fixtures.js";
import { storeSuite } from "./store-suite.js";
test("SQLite shared store contract", async (t) => {
  const h = new Hub();
  try {
    await storeSuite(t, h);
  } finally {
    h.close();
  }
});
test("independent worker threads really contend for one SQLite claim", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-claim-")),
    path = join(dir, "hub.db"),
    h = new Hub(path);
  await submit(h);
  const ready = [];
  const workers = Array.from(
    { length: 4 },
    () =>
      new Worker(new URL("./claim-worker.js", import.meta.url), {
        workerData: { path, principal: worker },
      }),
  );
  try {
    await Promise.all(
      workers.map(
        (w) =>
          new Promise((resolve, reject) => {
            w.once("message", resolve);
            w.once("error", reject);
          }),
      ),
    );
    const results = workers.map(
      (w) =>
        new Promise((resolve, reject) => {
          w.once("message", resolve);
          w.once("error", reject);
        }),
    );
    for (const w of workers) w.postMessage("go");
    ready.push(...(await Promise.all(results)));
    assert.equal(ready.filter(Boolean).length, 1);
  } finally {
    await Promise.all(workers.map((w) => w.terminate()));
    h.close();
    rmSync(dir, { recursive: true });
  }
});
test("SQLite terminal state and outbox persist across reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-restart-")),
    path = join(dir, "hub.db");
  let h = new Hub(path);
  const task = await submit(h);
  const claim = await h.claim(worker);
  await finish(h, claim);
  h.close();
  h = new Hub(path);
  assert.equal((await h.get(owner, task)).state, "succeeded");
  assert.equal((await h.pending(owner)).length, 1);
  h.close();
  rmSync(dir, { recursive: true });
});
test("untracked legacy task database is preserved and refused", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const dir = mkdtempSync(join(tmpdir(), "hub-legacy-")),
    path = join(dir, "hub.db");
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE tasks(id TEXT PRIMARY KEY); INSERT INTO tasks VALUES('fixture-legacy')",
  );
  db.close();
  try {
    assert.throws(() => new Hub(path), /legacy_schema/);
    const check = new DatabaseSync(path);
    assert.equal(
      check.prepare("SELECT id FROM tasks").get().id,
      "fixture-legacy",
    );
    check.close();
  } finally {
    rmSync(dir, { recursive: true });
  }
});
