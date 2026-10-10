import { test } from "node:test";
import assert from "node:assert/strict";
import { PinnedJWTVerifier } from "../src/auth.ts";
const enc = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
async function fixture(options = {}) {
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    false,
    ["sign", "verify"],
  );
  let now = 2000000,
    active = true;
  const verifier = new PinnedJWTVerifier({
    issuer: "https://issuer.example",
    audience: "hub-fixture",
    kid: "fixture",
    key: keys.publicKey,
    now: () => now,
    active: async () => active,
    policy: [
      {
        subject: "dots-fixture",
        kind: "user",
        destination: "hermes",
        operations: ["submit", "get", "events"],
      },
    ],
    ...options,
  });
  const sign = async (claims = {}, header = {}) => {
    const body = `${enc({ alg: "RS256", kid: "fixture", ...header })}.${enc({ iss: "https://issuer.example", aud: "hub-fixture", sub: "dots-fixture", exp: 2100, scope: "hub:submit hub:get", ...claims })}`;
    const sig = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keys.privateKey,
      new TextEncoder().encode(body),
    );
    return `Bearer ${body}.${Buffer.from(sig).toString("base64url")}`;
  };
  return {
    verifier,
    sign,
    revoke: () => (active = false),
    advance: () => (now = 2100000),
  };
}
test("pinned JWT verification selects static subject policy and scope intersection", async () => {
  const f = await fixture();
  const p = await f.verifier.verify(
    await f.sign({
      agent: "hermes",
      reader: "attacker",
      scope: "hub:submit hub:claim",
    }),
  );
  assert.equal(p.subject, "dots-fixture");
  assert.equal(p.worker, undefined);
  assert.deepEqual(p.operations, ["submit"]);
  assert.ok(Object.isFrozen(p));
});
test("wrong issuer audience algorithm kid signature expiry and unmapped identities fail closed", async () => {
  const f = await fixture();
  for (const claims of [
    { iss: "https://wrong.example" },
    { aud: "other" },
    { sub: "unknown" },
    { exp: 2000 },
    { nbf: 2001 },
    { scope: "hub:claim" },
  ])
    assert.equal(await f.verifier.verify(await f.sign(claims)), null);
  for (const header of [
    { alg: "none" },
    { kid: "other" },
    { jku: "https://attacker.example" },
  ])
    assert.equal(await f.verifier.verify(await f.sign({}, header)), null);
  const token = await f.sign();
  assert.equal(await f.verifier.verify(token.slice(0, -8) + "AAAAAAAA"), null);
  assert.equal(await f.verifier.verify(undefined), null);
  f.revoke();
  assert.equal(await f.verifier.verify(token), null);
});
test("revocation and expiry are checked on every verification", async () => {
  const f = await fixture();
  const token = await f.sign();
  assert.ok(await f.verifier.verify(token));
  f.advance();
  assert.equal(await f.verifier.verify(token), null);
});

test("same subject policies select exact verified client and never union privileges", async () => {
  const seen = [];
  const f = await fixture({
    requireClientId: true,
    active: async (...args) => {
      seen.push(args);
      return true;
    },
    policy: [
      {
        subject: "dots-fixture",
        kind: "user",
        clientId: "dots-client",
        operations: ["ping_submit", "ping_get"],
      },
      {
        subject: "dots-fixture",
        kind: "user",
        clientId: "grok-client",
        operations: ["ping_reply", "ping_pending"],
      },
    ],
  });
  for (const [client, ops] of [
    ["dots-client", ["ping_submit", "ping_get"]],
    ["grok-client", ["ping_reply", "ping_pending"]],
  ]) {
    const p = await f.verifier.verify(
      await f.sign({
        azp: client,
        scope:
          "hub:ping_submit hub:ping_get hub:ping_reply hub:ping_pending hub:claim",
        agent: "hermes",
      }),
    );
    assert.deepEqual(p.operations, ops);
    assert.equal(p.clientId, client);
    assert.equal(p.worker, undefined);
  }
  assert.deepEqual(
    seen.map((x) => x[2]),
    ["dots-client", "grok-client"],
  );
  for (const claims of [
    { azp: "unknown" },
    { azp: undefined },
    { azp: "dots-client", client_id: "grok-client" },
    { azp: "grok-client", scope: "hub:ping_submit" },
    { azp: "dots-client", iss: "https://other.example" },
  ])
    assert.equal(await f.verifier.verify(await f.sign(claims)), null);
});
test("legacy policy migration rejects missing-client ambiguity and duplicate pairs", async () => {
  const base = { subject: "dots-fixture", kind: "user", operations: ["get"] };
  for (const policy of [
    [
      { ...base, clientId: "dots" },
      { ...base, clientId: "grok" },
    ],
    [base, { ...base, clientId: "new" }],
    [{ ...base, clientId: "new" }, base],
    [
      { ...base, clientId: "new" },
      { ...base, clientId: "new" },
    ],
  ]) {
    await assert.rejects(fixture({ policy }));
    await assert.rejects(fixture({ policy, requireClientId: true }));
  }
});
