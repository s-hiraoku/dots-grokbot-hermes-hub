import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { LocalHermesKey } from "../src/local-hermes-key.ts";
const setup = () => {
  let stopped = 0;
  const records = [],
    seen = [];
  return {
    records,
    seen,
    count: () => stopped,
    options: {
      ttlMs: 120000,
      entropy: () => Buffer.alloc(32, 7),
      persist: async (r) => records.push(r),
      launch: (k, f) => {
        seen.push({ k, f });
        return {
          stop: async () => {
            stopped++;
          },
        };
      },
      adapter: (k, f) => {
        seen.push({ k, f });
        return {
          stop: async () => {
            stopped++;
          },
        };
      },
    },
  };
};
test("mock key routes only to trusted child and adapter, metadata contains no bearer", async () => {
  const f = setup(),
    p = new LocalHermesKey();
  await p.provision(f.options);
  assert.equal(f.seen[0].k.length, 64);
  assert.deepEqual(f.seen[0], f.seen[1]);
  assert.equal(
    f.records[0].fingerprint,
    createHash("sha256").update(f.seen[0].k).digest("hex"),
  );
  assert.equal(JSON.stringify(f.records).includes(f.seen[0].k), false);
  await p.close();
  await p.close();
  assert.equal(f.count(), 2);
  assert.equal(p.record().state, "revoked");
  await assert.rejects(p.provision(f.options));
});
test("mock expiry stops both boundaries without persistent launch", async () => {
  const f = setup(),
    p = new LocalHermesKey();
  await p.provision({ ...f.options, ttlMs: 10 });
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(f.count(), 2);
  assert.equal(p.record().state, "revoked");
});
test("adapter failure cleans child and reports no secret detail", async () => {
  const f = setup(),
    p = new LocalHermesKey();
  await assert.rejects(
    p.provision({
      ...f.options,
      adapter: () => {
        throw Error("fixture secret");
      },
    }),
    /provision_failed/,
  );
  assert.equal(f.count(), 1);
  assert.equal(p.record().state, "revoked");
});
test("failed stop is explicitly uncertain, not falsely revoked", async () => {
  const f = setup(),
    p = new LocalHermesKey();
  await p.provision({
    ...f.options,
    launch: () => ({
      stop: async () => {
        throw Error();
      },
    }),
  });
  await assert.rejects(p.close(), /hermes_stop_failed/);
  assert.equal(p.record().state, "stop_failed");
});
test("hung adapter does not prevent bounded child stop", async () => {
  const f = setup(),
    p = new LocalHermesKey();
  await p.provision({
    ...f.options,
    adapter: () => ({ stop: () => new Promise(() => {}) }),
  });
  await assert.rejects(p.close(), /hermes_stop_failed/);
  assert.equal(f.count(), 1);
  assert.equal(p.record().state, "stop_failed");
});
test("reentrant factory close includes late boundary failure", async () => {
  const f = setup(),
    p = new LocalHermesKey();
  let closing;
  await assert.rejects(
    p.provision({
      ...f.options,
      launch: () => {
        closing = p.close();
        closing.catch(() => {});
        return {
          stop: async () => {
            throw Error();
          },
        };
      },
    }),
    /hermes_stop_failed/,
  );
  await assert.rejects(closing);
  assert.equal(p.record().state, "stop_failed");
});
test("close before provision rejects before entropy or persistence", async () => {
  const f = setup(),
    p = new LocalHermesKey();
  await p.close();
  await assert.rejects(
    p.provision({
      ...f.options,
      entropy: () => {
        throw Error("must not execute");
      },
    }),
    /provision_rejected/,
  );
  assert.equal(f.records.length, 0);
});
