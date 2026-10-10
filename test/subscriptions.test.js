import { test } from "node:test";
import assert from "node:assert/strict";
import { Webhook } from "standardwebhooks";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hub, owner, worker, RESPONSE } from "./fixtures.js";
import { SecretVault, SubscriptionService } from "../src/subscriptions.ts";
const observer = { subject: "dots-fixture", operations: ["events", "get"] };
const admin = { subject: "operator-fixture", operations: ["grants"] };
const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
const url = "https://callback.example/fixture";
const args = (id) => ({
  name: "task.terminal",
  arguments: { task_id: id },
  delivery: { mode: "webhook", url, secret },
  cursor: null,
  ttlMs: 60000,
});
const unsubscribe = (id) => ({
  name: "task.terminal",
  arguments: { task_id: id },
  delivery: { mode: "webhook", url },
});
async function fixture(path = ":memory:") {
  const h = new Hub(path);
  let now = Date.now();
  h.now = () => now;
  const vault = new SecretVault(
    await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]),
  );
  const received = [];
  const acceptedSecrets = [secret];
  let status = 200,
    verificationStatus = 200,
    active = true,
    verificationHook,
    deliveryHook;
  const transport = {
    post: async (_url, headers, body) => {
      let verified = false;
      for (const accepted of acceptedSecrets) {
        try {
          new Webhook(accepted).verify(body, headers);
          verified = true;
          break;
        } catch {}
      }
      assert.ok(verified);
      const event = JSON.parse(body);
      if (event.type === "verification") {
        await verificationHook?.();
        return {
          status: verificationStatus,
          body: JSON.stringify({ challenge: event.challenge }),
        };
      }
      received.push({ event, headers });
      await deliveryHook?.();
      return { status, body: "" };
    },
  };
  const serviceFor = (hub) =>
    new SubscriptionService({
      hub,
      vault,
      transportFor: (requested) => {
        assert.equal(requested, url);
        return transport;
      },
      identityActive: async () => active,
    });
  const service = serviceFor(h);
  const task = await h.submit(
    { ...owner, resultReaders: [{ subject: observer.subject, notify: true }] },
    { task_type: "connectivity_check", request_key: "fixture" },
  );
  const finish = async () => {
    const t = await h.claim(worker);
    return h.complete(worker, {
      id: t.id,
      fence: t.fence,
      state: "succeeded",
      result: RESPONSE,
    });
  };
  return {
    h,
    acceptSecret: (s) => acceptedSecrets.push(s),
    vault,
    task,
    service,
    serviceFor,
    received,
    finish,
    advance: (ms) => (now += ms),
    setStatus: (s) => (status = s),
    setVerificationStatus: (s) => (verificationStatus = s),
    revokeIdentity: () => (active = false),
    onVerification: (hook) => (verificationHook = hook),
    onDelivery: (hook) => (deliveryHook = hook),
  };
}
test("subscription challenge, encrypted storage, completion-before-subscribe and stable acknowledgement", async () => {
  const f = await fixture();
  try {
    await f.finish();
    const s = await f.service.subscribe(observer, args(f.task.id));
    const row = f.h.sqlite.db.prepare("SELECT * FROM subscriptions").get();
    assert.ok(!row.secret_ref.includes(secret));
    await assert.rejects(
      f.vault.open(
        row.secret_ref,
        JSON.stringify([row.id, "other", row.revision]),
      ),
    );
    assert.equal(s.cursor, null);
    assert.equal(await f.service.dispatchOne(), true);
    assert.equal(await f.service.dispatchOne(), false);
    assert.equal(f.received.length, 1);
    assert.deepEqual(f.received[0].event.data, {
      task_id: f.task.id,
      state: "succeeded",
    });
    assert.equal(
      f.h.sqlite.db.prepare("SELECT state FROM deliveries").get().state,
      "delivered",
    );
    assert.equal(
      f.h.sqlite.db.prepare("SELECT count(*) n FROM tasks").get().n,
      1,
    );
  } finally {
    f.h.close();
  }
});
test("unsubscribe during verification cannot be undone by stale challenge acknowledgement", async () => {
  const f = await fixture();
  try {
    f.onVerification(() =>
      f.service.unsubscribe(observer, unsubscribe(f.task.id)),
    );
    await assert.rejects(f.service.subscribe(observer, args(f.task.id)));
    assert.equal(
      f.h.sqlite.db.prepare("SELECT active FROM subscriptions").get().active,
      0,
    );
    await f.finish();
    assert.equal(await f.service.dispatchOne(), false);
  } finally {
    f.h.close();
  }
});
for (const revoke of ["grant", "identity", "expiry"])
  test(`delivery rechecks ${revoke} before outbound request`, async () => {
    const f = await fixture();
    try {
      await f.service.subscribe(observer, args(f.task.id));
      await f.finish();
      if (revoke === "grant")
        await f.h.revokeReader(admin, {
          id: f.task.id,
          subject: observer.subject,
        });
      if (revoke === "identity") f.revokeIdentity();
      if (revoke === "expiry") f.advance(60001);
      await f.service.dispatchOne();
      assert.equal(f.received.length, 0);
    } finally {
      f.h.close();
    }
  });
test("durable retries preserve event ID and finite total budget across service recreation", async () => {
  const f = await fixture();
  try {
    await f.service.subscribe(observer, args(f.task.id));
    await f.finish();
    f.setStatus(503);
    for (let i = 0; i < 7; i++) {
      await f.serviceFor(f.h).dispatchOne();
      f.advance(60000);
    }
    assert.equal(f.received.length, 1); // TTL expiry stops further attempts.
    assert.equal(
      f.h.sqlite.db.prepare("SELECT attempts FROM deliveries").get().attempts,
      1,
    );
  } finally {
    f.h.close();
  }
});
test("five transient failures become dead without creating new tasks", async () => {
  const f = await fixture();
  try {
    await f.service.subscribe(observer, {
      ...args(f.task.id),
      ttlMs: 86400000,
    });
    await f.finish();
    f.setStatus(503);
    for (let i = 0; i < 7; i++) {
      await f.serviceFor(f.h).dispatchOne();
      f.advance(60000);
    }
    assert.equal(f.received.length, 5);
    assert.equal(new Set(f.received.map((r) => r.event.eventId)).size, 1);
    assert.equal(
      f.h.sqlite.db.prepare("SELECT state FROM deliveries").get().state,
      "dead",
    );
    assert.equal(
      f.h.sqlite.db.prepare("SELECT count(*) n FROM tasks").get().n,
      1,
    );
  } finally {
    f.h.close();
  }
});
test("permanent rejection is not retried", async () => {
  const f = await fixture();
  try {
    await f.service.subscribe(observer, args(f.task.id));
    await f.finish();
    f.setStatus(410);
    await f.service.dispatchOne();
    f.advance(5000);
    await f.service.dispatchOne();
    assert.equal(f.received.length, 1);
    assert.equal(
      f.h.sqlite.db.prepare("SELECT state FROM deliveries").get().state,
      "dead",
    );
  } finally {
    f.h.close();
  }
});
test("grant loss during acknowledgement cannot commit delivered state", async () => {
  const f = await fixture();
  try {
    await f.service.subscribe(observer, args(f.task.id));
    await f.finish();
    f.onDelivery(() =>
      f.h.revokeReader(admin, { id: f.task.id, subject: observer.subject }),
    );
    await f.service.dispatchOne();
    assert.equal(
      f.h.sqlite.db.prepare("SELECT state FROM deliveries").get().state,
      "running",
    );
  } finally {
    f.h.close();
  }
});
test("database reopening preserves successful delivery and encrypted secret", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-events-fixture-"));
  const f = await fixture(join(dir, "hub.db"));
  let reopened;
  try {
    await f.service.subscribe(observer, args(f.task.id));
    await f.finish();
    await f.service.dispatchOne();
    f.h.close();
    reopened = new Hub(join(dir, "hub.db"));
    await f.serviceFor(reopened).dispatchOne();
    assert.equal(f.received.length, 1);
  } finally {
    reopened?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("a delivery attempt cannot acknowledge after its lease expires", async () => {
  const f = await fixture();
  try {
    await f.service.subscribe(observer, {
      ...args(f.task.id),
      ttlMs: 86400000,
    });
    await f.finish();
    f.onDelivery(() => f.advance(31000));
    await f.service.dispatchOne();
    assert.equal(
      f.h.sqlite.db.prepare("SELECT state FROM deliveries").get().state,
      "running",
    );
    f.onDelivery(undefined);
    await f.service.dispatchOne();
    assert.equal(
      f.h.sqlite.db.prepare("SELECT state FROM deliveries").get().state,
      "delivered",
    );
    assert.equal(f.received.length, 2);
    assert.equal(f.received[0].event.eventId, f.received[1].event.eventId);
  } finally {
    f.h.close();
  }
});

for (const status of [410, 413, 302, 401])
  test(`verification permanent ${status} stops the durable attempt`, async () => {
    const f = await fixture();
    try {
      await f.service.subscribe(observer, args(f.task.id));
      await f.finish();
      f.setVerificationStatus(status);
      await f.service.dispatchOne();
      f.advance(5000);
      await f.service.dispatchOne();
      assert.equal(f.received.length, 0);
      assert.equal(
        f.h.sqlite.db.prepare("SELECT attempts FROM deliveries").get().attempts,
        1,
      );
      assert.equal(
        f.h.sqlite.db.prepare("SELECT state FROM deliveries").get().state,
        "dead",
      );
    } finally {
      f.h.close();
    }
  });
test("refresh during delivery fences every old-attempt write and recovers after lease expiry", async () => {
  const f = await fixture();
  try {
    await f.service.subscribe(observer, {
      ...args(f.task.id),
      ttlMs: 86400000,
    });
    await f.finish();
    f.onDelivery(() =>
      f.service.subscribe(observer, { ...args(f.task.id), ttlMs: 86400000 }),
    );
    await f.service.dispatchOne();
    assert.equal(
      f.h.sqlite.db.prepare("SELECT state FROM deliveries").get().state,
      "running",
    );
    f.onDelivery(undefined);
    f.advance(31000);
    await f.service.dispatchOne();
    assert.equal(
      f.h.sqlite.db.prepare("SELECT state FROM deliveries").get().state,
      "delivered",
    );
    assert.equal(f.received.length, 2);
    assert.equal(f.received[0].event.eventId, f.received[1].event.eventId);
  } finally {
    f.h.close();
  }
});

test("replacement callback secrets are dual-signed only during a bounded rotation window", async () => {
  const f = await fixture();
  const next = `whsec_${Buffer.alloc(32, 9).toString("base64")}`;
  try {
    await f.service.subscribe(observer, {
      ...args(f.task.id),
      ttlMs: 86400000,
    });
    f.acceptSecret(next);
    await f.service.subscribe(observer, {
      ...args(f.task.id),
      ttlMs: 86400000,
      delivery: { mode: "webhook", url, secret: next },
    });
    const stored = f.h.sqlite.db.prepare("SELECT * FROM subscriptions").get();
    assert.ok(stored.previous_secret_ref);
    assert.ok(!stored.previous_secret_ref.includes(secret));
    f.advance(1000);
    await f.service.subscribe(observer, {
      ...args(f.task.id),
      ttlMs: 86400000,
      delivery: { mode: "webhook", url, secret: next },
    });
    assert.equal(
      f.h.sqlite.db.prepare("SELECT rotation_until FROM subscriptions").get()
        .rotation_until,
      stored.rotation_until,
    );
    await f.finish();
    f.setStatus(503);
    await f.service.dispatchOne();
    const first = f.received[0];
    new Webhook(secret).verify(JSON.stringify(first.event), first.headers);
    new Webhook(next).verify(JSON.stringify(first.event), first.headers);
    f.advance(31000);
    f.setStatus(200);
    await f.service.dispatchOne();
    const second = f.received[1];
    new Webhook(next).verify(JSON.stringify(second.event), second.headers);
    assert.throws(() =>
      new Webhook(secret).verify(JSON.stringify(second.event), second.headers),
    );
  } finally {
    f.h.close();
  }
});
test("concurrent rotations use compare-and-swap on the exact previous subscription revision", async () => {
  const f = await fixture(),
    b = `whsec_${Buffer.alloc(32, 12).toString("base64")}`,
    c = `whsec_${Buffer.alloc(32, 13).toString("base64")}`;
  try {
    await f.service.subscribe(observer, {
      ...args(f.task.id),
      ttlMs: 86400000,
    });
    f.acceptSecret(b);
    f.acceptSecret(c);
    const open = f.vault.open.bind(f.vault);
    let entered = 0,
      release;
    const barrier = new Promise((resolve) => (release = resolve));
    f.vault.open = async (...input) => {
      const value = await open(...input);
      if (value === secret) {
        entered++;
        if (entered === 2) release();
        await barrier;
      }
      return value;
    };
    const outcomes = await Promise.allSettled(
      [b, c].map((next) =>
        f.service.subscribe(observer, {
          ...args(f.task.id),
          ttlMs: 86400000,
          delivery: { mode: "webhook", url, secret: next },
        }),
      ),
    );
    assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((r) => r.status === "rejected").length, 1);
    f.vault.open = open;
    const row = f.h.sqlite.db.prepare("SELECT * FROM subscriptions").get(),
      aad = JSON.stringify([row.id, row.subject, row.revision]);
    assert.equal(row.revision, 2);
    assert.ok([b, c].includes(await open(row.secret_ref, aad)));
    assert.equal(await open(row.previous_secret_ref, aad), secret);
  } finally {
    f.h.close();
  }
});
test("same-key refresh reuses verification only within the original bounded cache lifetime", async (t) => {
  const f = await fixture();
  t.mock.method(Date, "now", () => f.h.now());
  let challenges = 0;
  try {
    f.onVerification(() => challenges++);
    await f.service.subscribe(observer, {
      ...args(f.task.id),
      ttlMs: 86400000,
    });
    const first = f.h.sqlite.db
      .prepare("SELECT verified_until FROM subscriptions")
      .get().verified_until;
    f.advance(1000);
    await f.service.subscribe(observer, {
      ...args(f.task.id),
      ttlMs: 86400000,
    });
    assert.equal(challenges, 1);
    assert.equal(
      f.h.sqlite.db.prepare("SELECT verified_until FROM subscriptions").get()
        .verified_until,
      first,
    );
    f.advance(300000);
    await f.service.subscribe(observer, {
      ...args(f.task.id),
      ttlMs: 86400000,
    });
    assert.equal(challenges, 2);
    assert.ok(
      f.h.sqlite.db.prepare("SELECT verified_until FROM subscriptions").get()
        .verified_until > first,
    );
  } finally {
    f.h.close();
  }
});
