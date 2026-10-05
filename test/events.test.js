import { test } from "node:test";
import assert from "node:assert/strict";
import { Webhook } from "standardwebhooks";
import { EventSender } from "../src/events.ts";
import {
  PinnedCallbackTransport,
  publicAddress,
} from "../src/callback-transport.ts";
const secret = Buffer.alloc(32, 1).toString("base64"); // Public test fixture, never a runtime credential.
const subscription = {
  id: "fixture-sub",
  subject: "fixture-owner",
  task_id: "fixture-task",
  url: "https://callback.example/hook",
  secret,
  expiresAt: Date.now() + 600000,
};
const event = {
  id: "fixture-event",
  task: "fixture-task",
  owner: "fixture-owner",
  event: "succeeded",
  at: Date.now(),
  delivered: 0,
};
const signatureHeaders = (h) => ({
  "webhook-id": h["webhook-id"],
  "webhook-timestamp": h["webhook-timestamp"],
  "webhook-signature": h["webhook-signature"],
});
test("verification and terminal events carry valid signatures and stable retry identity", async () => {
  const sent = [];
  let events = 0,
    now = Date.now();
  const sender = new EventSender({
    subscription,
    now: () => now,
    authorise: async () => true,
    wait: async () => {
      now += 1000;
    },
    transport: {
      async post(_url, headers, body) {
        new Webhook(secret).verify(body, signatureHeaders(headers));
        const data = JSON.parse(body);
        sent.push({ headers, data, body });
        if (data.type === "verification")
          return {
            status: 200,
            body: JSON.stringify({ challenge: data.challenge }),
          };
        events++;
        return { status: events === 1 ? 503 : 200, body: "" };
      },
    },
  });
  await sender.verify();
  await sender.send(event);
  assert.equal(sent.length, 3);
  assert.equal(sent[1].headers["webhook-id"], event.id);
  assert.equal(sent[2].headers["webhook-id"], event.id);
  assert.equal(sent[1].body, sent[2].body);
  assert.notEqual(
    sent[1].headers["webhook-timestamp"],
    sent[2].headers["webhook-timestamp"],
  );
  assert.deepEqual(sent[2].data.data, {
    task_id: event.task,
    state: "succeeded",
  });
  assert.throws(() =>
    new Webhook(secret).verify(
      sent[2].body + " ",
      signatureHeaders(sent[2].headers),
    ),
  );
});
test("failed challenge, owner mismatch, expiry and revoked access fail closed", async () => {
  let authorised = true;
  const sender = new EventSender({
    subscription,
    authorise: async () => authorised,
    transport: {
      async post() {
        return { status: 200, body: '{"challenge":"wrong"}' };
      },
    },
  });
  await assert.rejects(sender.verify());
  await assert.rejects(sender.send(event));
  authorised = false;
  await assert.rejects(sender.verify());
});
for (const status of [410, 413, 302, 401])
  test(`event delivery stops without retries on ${status}`, async () => {
    let calls = 0;
    const sender = new EventSender({
      subscription,
      authorise: async () => true,
      wait: async () => {},
      transport: {
        async post(_u, _h, body) {
          const d = JSON.parse(body);
          if (d.type === "verification")
            return {
              status: 200,
              body: JSON.stringify({ challenge: d.challenge }),
            };
          calls++;
          return { status, body: "" };
        },
      },
    });
    await sender.verify();
    await assert.rejects(sender.send(event));
    assert.equal(calls, 1);
  });
test("bounded retries retain stable ID and do not submit tasks", async () => {
  let calls = 0;
  const sender = new EventSender({
    subscription,
    authorise: async () => true,
    wait: async () => {},
    transport: {
      async post(_u, _h, body) {
        const d = JSON.parse(body);
        if (d.type === "verification")
          return {
            status: 200,
            body: JSON.stringify({ challenge: d.challenge }),
          };
        calls++;
        throw new Error("lost ack");
      },
    },
  });
  await sender.verify();
  await assert.rejects(sender.send(event), /retry_exhausted/);
  assert.equal(calls, 3);
});
test("pinned callback checks fresh DNS every attempt and blocks rebinding", async () => {
  let resolves = 0;
  const connected = [];
  const transport = new PinnedCallbackTransport([subscription.url], {
    resolve: async () => [
      { address: ++resolves === 1 ? "93.184.216.34" : "127.0.0.1", family: 4 },
    ],
    connect: async (req) => {
      connected.push(req);
      return { status: 200, body: "" };
    },
  });
  await transport.post(subscription.url, {}, "fixture");
  await assert.rejects(
    transport.post(subscription.url, {}, "fixture"),
    /nonpublic/,
  );
  assert.equal(connected.length, 1);
  assert.equal(connected[0].address, "93.184.216.34");
  assert.equal(connected[0].url.hostname, "callback.example");
});
test("callback allowlist rejects arbitrary destinations, credentials, redirect and nonpublic IPs", async () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "2001:db8::1",
  ])
    assert.equal(publicAddress(address), false);
  const transport = new PinnedCallbackTransport([subscription.url], {
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    connect: async () => ({ status: 302, body: "" }),
  });
  await assert.rejects(
    transport.post("https://arbitrary.example/hook", {}, ""),
  );
  await assert.rejects(transport.post(subscription.url, {}, ""), /redirect/);
});
test("verified callback loses permission on expiry/revocation and rejects foreign owners", async () => {
  let now = Date.now(),
    allowed = true;
  const sender = new EventSender({
    subscription,
    now: () => now,
    authorise: async () => allowed,
    transport: {
      async post(_u, _h, body) {
        const d = JSON.parse(body);
        return {
          status: 200,
          body: JSON.stringify({ challenge: d.challenge }),
        };
      },
    },
  });
  await sender.verify();
  await assert.rejects(sender.send({ ...event, owner: "other" }));
  allowed = false;
  await assert.rejects(sender.send(event));
  allowed = true;
  now = subscription.expiresAt;
  await assert.rejects(sender.send(event));
});
test("sender never retries callback transport policy rejections", async () => {
  let calls = 0;
  const transport = new PinnedCallbackTransport([subscription.url], {
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    connect: async (req) => {
      calls++;
      const d = JSON.parse(req.body);
      return d.type === "verification"
        ? { status: 200, body: JSON.stringify({ challenge: d.challenge }) }
        : { status: 302, body: "" };
    },
  });
  const sender = new EventSender({
    subscription,
    transport,
    authorise: async () => true,
    wait: async () => {
      throw new Error("retry forbidden");
    },
  });
  await sender.verify();
  await assert.rejects(sender.send(event), /redirect/);
  assert.equal(calls, 2);
});
