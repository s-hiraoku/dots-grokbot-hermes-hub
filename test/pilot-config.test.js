import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { preflightPilot } from "../src/pilot-config.ts";
const template = () =>
  JSON.parse(
    readFileSync(
      new URL("../config/pilot.example.json", import.meta.url),
      "utf8",
    ),
  );
const fixture = () => {
  const c = template();
  c.oauth.issuer = "https://fixture-tenant.auth0.com/";
  c.oauth.audience = "https://hub.fixture.invalid/mcp";
  for (const side of ["dots", "grok"])
    c.peers[side] = {
      subject: "fixture-owner",
      clientId: "fixture-" + side,
      callback: "https://" + side + ".fixture.invalid/callback",
      clientAuthentication: "none",
    };
  return c;
};
test("template is rejected and offline validation never authorizes live startup", () => {
  assert.equal(preflightPilot(template()).offlineValid, undefined);
  assert.deepEqual(preflightPilot(fixture()), {
    ready: false,
    offlineValid: true,
    errors: ["live_registration_routing_and_budget_unverified"],
  });
});
test("scopes, peer separation, audience, loopback and free-only budget fail closed", () => {
  for (const mutate of [
    (c) => c.oauth.scopes.fill("hub:ping_get"),
    (c) => (c.oauth.scopes[0] = "hub:claim"),
    (c) => (c.peers.grok.clientId = c.peers.dots.clientId),
    (c) => (c.oauth.audience += "/"),
    (c) => (c.hub.host = "0.0.0.0"),
    (c) => (c.auth0Budget.monthlyUsd = 1),
    (c) => (c.auth0Budget.maxRetries = 1),
    (c) => (c.auth0Budget.singleFlight = false),
    (c) => (c.peers.dots.callback = "http://dots.fixture.invalid/callback"),
    (c) => (c.oauth.secret = "forbidden"),
  ]) {
    const c = fixture();
    mutate(c);
    assert.equal(preflightPilot(c).offlineValid, undefined);
  }
});
