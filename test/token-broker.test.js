import { test } from "node:test";
import assert from "node:assert/strict";
import { Hub } from "./fixtures.js";
import { TokenBroker } from "../src/token-broker.ts";
const p = {
  subject: "fixture-service",
  clientId: "fixture-client",
  operations: [],
};
const period = { id: "fixture-month", start: 0, end: 10000000, ceiling: 2 };
test("on demand cache, concurrent single flight, durable quota and instance fencing", async () => {
  const h = new Hub();
  let calls = 0,
    now = 1000;
  const acquire = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 10));
    return { access_token: "fixture-token", expires_in: 60 };
  };
  const a = new TokenBroker(
    h.authorization,
    p,
    period,
    acquire,
    undefined,
    () => now,
  );
  const b = new TokenBroker(
    h.authorization,
    p,
    period,
    acquire,
    undefined,
    () => now,
  );
  try {
    assert.equal(calls, 0);
    assert.deepEqual(await Promise.all([a.token(), a.token()]), [
      "fixture-token",
      "fixture-token",
    ]);
    assert.equal(calls, 1);
    assert.equal(await a.token(), "fixture-token");
    assert.equal(calls, 1);
    now += 31000;
    const results = await Promise.allSettled([a.token(), b.token()]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(calls, 2);
    now += 31000;
    await assert.rejects(a.token());
    await assert.rejects(b.token());
    assert.equal(calls, 2);
    const count = await h.driver.batch([
      { sql: "SELECT used FROM token_budget" },
    ]);
    assert.equal(count[0][0].used, 2);
  } finally {
    h.close();
  }
});
test("failed acquisition parks across instances, counts failed attempt and emits no retry", async () => {
  const h = new Hub();
  let calls = 0;
  const acquire = async () => {
    calls++;
    throw Error("secret provider detail");
  };
  try {
    const a = new TokenBroker(
      h.authorization,
      p,
      period,
      acquire,
      undefined,
      () => 1000,
    );
    await assert.rejects(a.token(), /token_acquisition_stopped/);
    const b = new TokenBroker(
      h.authorization,
      p,
      period,
      acquire,
      undefined,
      () => 1000,
    );
    await assert.rejects(b.token(), /budget_or_attempt_blocked/);
    assert.equal(calls, 1);
    assert.equal(
      (await h.driver.batch([{ sql: "SELECT used FROM token_budget" }]))[0][0]
        .used,
      1,
    );
  } finally {
    h.close();
  }
});
test("durable stop denies cached token and unknown billing period never acquires", async () => {
  const h = new Hub();
  let calls = 0;
  const acquire = async () => {
    calls++;
    return { access_token: "fixture-token", expires_in: 60 };
  };
  try {
    const a = new TokenBroker(
      h.authorization,
      p,
      period,
      acquire,
      undefined,
      () => 1000,
    );
    await a.token();
    await h.authorization.setStopped(
      { kind: "client", id: p.clientId },
      true,
      0,
      "fixture-maintainer",
    );
    await assert.rejects(a.token(), /authorization_rejected/);
    assert.equal(calls, 1);
  } finally {
    h.close();
  }
});

test("conflicting periods and stop during issuance fail closed without retry", async () => {
  const h = new Hub();
  let calls = 0;
  try {
    const a = new TokenBroker(
      h.authorization,
      p,
      period,
      async () => {
        calls++;
        await h.authorization.setStopped(
          { kind: "subject", id: p.subject },
          true,
          0,
          "fixture-maintainer",
        );
        return { access_token: "fixture-token", expires_in: 60 };
      },
      undefined,
      () => 1000,
    );
    await assert.rejects(a.token(), /token_acquisition_stopped/);
    assert.equal(calls, 1);
    await h.authorization.setStopped(
      { kind: "subject", id: p.subject },
      false,
      1,
      "fixture-maintainer",
    );
    const b = new TokenBroker(
      h.authorization,
      p,
      period,
      async () => {
        calls++;
        throw Error();
      },
      undefined,
      () => 1000,
    );
    await assert.rejects(b.token(), /budget_or_attempt_blocked/);
    const overlapping = new TokenBroker(
      h.authorization,
      p,
      { ...period, id: "different-id" },
      async () => {
        calls++;
        throw Error();
      },
      undefined,
      () => 1000,
    );
    await assert.rejects(overlapping.token(), /overlapping_billing_period/);
    assert.equal(calls, 1);
    const unknown = new TokenBroker(
      h.authorization,
      p,
      { ...period, id: "next", start: 10000000, end: 20000000 },
      async () => {
        calls++;
        throw Error();
      },
      undefined,
      () => 1000,
    );
    await assert.rejects(unknown.token(), /unverified_billing_period/);
    assert.equal(calls, 1);
  } finally {
    h.close();
  }
});
test("hung acquisition aborts and stays parked without reissue", async () => {
  const h = new Hub();
  let calls = 0,
    signal;
  try {
    const a = new TokenBroker(
      h.authorization,
      p,
      period,
      async (s) => {
        calls++;
        signal = s;
        return new Promise(() => {});
      },
      undefined,
      () => 1000,
    );
    await assert.rejects(a.token(), /token_acquisition_stopped/);
    assert.equal(signal.aborted, true);
    await assert.rejects(a.token(), /budget_or_attempt_blocked/);
    assert.equal(calls, 1);
  } finally {
    h.close();
  }
});

test("reservation and acknowledgement DB waits cannot cross billing/expiry boundaries", async () => {
  for (const phase of ["reservation", "ack"]) {
    const h = new Hub();
    let now = 1000,
      calls = 0;
    const original = h.driver.batch.bind(h.driver);
    h.driver.batch = async (statements) => {
      const rows = await original(statements);
      if (
        phase === "reservation" &&
        statements.some((s) =>
          s.sql.startsWith("INSERT OR IGNORE INTO token_budget"),
        )
      )
        now = period.end;
      if (
        phase === "ack" &&
        statements.some((s) => s.sql.includes("RETURNING period"))
      )
        now += 31000;
      return rows;
    };
    try {
      const a = new TokenBroker(
        h.authorization,
        p,
        period,
        async () => {
          calls++;
          return { access_token: "fixture-token", expires_in: 60 };
        },
        undefined,
        () => now,
      );
      await assert.rejects(a.token(), /token_acquisition_stopped/);
      assert.equal(calls, phase === "reservation" ? 0 : 1);
      assert.equal(
        (await original([{ sql: "SELECT state,used FROM token_budget" }]))[0][0]
          .state,
        "parked",
      );
      await assert.rejects(a.token());
      assert.equal(calls, phase === "reservation" ? 0 : 1);
    } finally {
      h.close();
    }
  }
});

test("late failed ACK parks a competing instance permanently", async () => {
  const h = new Hub();
  let now = 1000,
    releaseA,
    releaseB,
    ackSeen;
  const ackReady = new Promise((r) => (ackSeen = r)),
    aPause = new Promise((r) => (releaseA = r)),
    bPause = new Promise((r) => (releaseB = r));
  const original = h.driver.batch.bind(h.driver);
  let intercepted = false;
  h.driver.batch = async (statements) => {
    const rows = await original(statements);
    if (
      !intercepted &&
      statements.some((s) => s.sql.includes("RETURNING period"))
    ) {
      intercepted = true;
      ackSeen();
      await aPause;
    }
    return rows;
  };
  try {
    const a = new TokenBroker(
      h.authorization,
      p,
      { ...period, ceiling: 3 },
      async () => ({ access_token: "fixture-a", expires_in: 60 }),
      undefined,
      () => now,
    );
    let bStarted;
    const start = new Promise((r) => (bStarted = r));
    const b = new TokenBroker(
      h.authorization,
      p,
      { ...period, ceiling: 3 },
      async () => {
        bStarted();
        await bPause;
        return { access_token: "fixture-b", expires_in: 60 };
      },
      undefined,
      () => now,
    );
    const first = a.token();
    await ackReady;
    const second = b.token();
    await start;
    now += 31000;
    releaseA();
    await assert.rejects(first, /token_acquisition_stopped/);
    releaseB();
    await assert.rejects(second, /token_acquisition_stopped/);
    assert.equal(
      (await original([{ sql: "SELECT state FROM token_budget" }]))[0][0].state,
      "parked",
    );
    await assert.rejects(b.token(), /budget_or_attempt_blocked/);
  } finally {
    h.close();
  }
});

test("sticky period stop blocks another instance's cached token", async () => {
  const h = new Hub();
  try {
    const a = new TokenBroker(
      h.authorization,
      p,
      period,
      async () => ({ access_token: "fixture-token", expires_in: 60 }),
      undefined,
      () => 1000,
    );
    await a.token();
    const b = new TokenBroker(
      h.authorization,
      p,
      period,
      async () => {
        throw Error();
      },
      undefined,
      () => 1000,
    );
    await assert.rejects(b.token(), /token_acquisition_stopped/);
    await assert.rejects(a.token(), /budget_or_attempt_blocked/);
  } finally {
    h.close();
  }
});

test("missing authoritative ledger denies cached token", async () => {
  const h = new Hub();
  let calls = 0;
  try {
    const a = new TokenBroker(
      h.authorization,
      p,
      period,
      async () => {
        calls++;
        return { access_token: "fixture-token", expires_in: 60 };
      },
      undefined,
      () => 1000,
    );
    await a.token();
    await h.driver.batch([{ sql: "DELETE FROM token_budget" }]);
    await assert.rejects(a.token(), /budget_or_attempt_blocked/);
    assert.equal(calls, 1);
  } finally {
    h.close();
  }
});
