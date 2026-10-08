import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HermesRuns,
  HERMES_COMMIT,
  HERMES_MODEL,
  HERMES_PROVIDER,
} from "../src/hermes-runs.ts";
import { RESPONSE } from "../src/types.ts";
import { hermesFixture } from "./hermes-fixture.js";
const endpoint = "http://127.0.0.1:10001/";
const evidence = () => ({
  endpoint,
  scopeId: "fixture-isolated-scope",
  sourceCommit: HERMES_COMMIT,
  expiresAt: Date.now() + 60000,
  dedicatedProfile: true,
  credentialScopeIsolated: true,
  effectiveToolCount: 0,
  memoryDisabled: true,
  historyIsolated: true,
  modelProviderLocked: true,
  fallbackDisabled: true,
});
const cap = () => ({
  object: "hermes.api_server.capabilities",
  platform: "hermes-agent",
  auth: { type: "bearer", required: true },
  features: {
    run_submission: true,
    run_status: true,
    runs_idempotency: {
      supported: true,
      durable: true,
      retention_seconds: 86400,
    },
  },
});
const input = {
  idempotencyKey: "hub-00000000-0000-4000-8000-000000000001",
  replay: {
    deadline: Date.now() + 86400000,
    retentionMs: 86400000,
    contract: "hermes-fixed-connectivity-v1",
  },
  prompt: RESPONSE,
  tools: [],
};
function options(change = {}) {
  return {
    endpoint,
    scopeId: "fixture-isolated-scope",
    apiKey: "fixture-hermes",
    inspectIsolation: async () => evidence(),
    fetch: async (url, init) => {
      if (!init.headers.Authorization)
        return new Response(null, { status: 401 });
      if (url.pathname === "/v1/capabilities") return Response.json(cap());
      if (url.pathname === "/v1/toolsets") return Response.json([]);
      if (init.method === "POST")
        return Response.json(
          { run_id: "run_fixture", status: "started" },
          { status: 202 },
        );
      return Response.json({
        object: "hermes.run",
        run_id: "run_fixture",
        status: "completed",
        output: RESPONSE,
        runtime: { model: HERMES_MODEL, provider: HERMES_PROVIDER },
      });
    },
    ...change,
  };
}
test("Hermes mock HTTP replays stable admission and polls exact fixed output", async () => {
  const fixture = await hermesFixture();
  try {
    const runs = await HermesRuns.connect(fixture.options);
    const a = await runs.create(input);
    const b = await runs.create(input);
    assert.equal(a.id, b.id);
    assert.equal(fixture.state.calls, 1);
    assert.deepEqual(await runs.get(a.id), {
      id: a.id,
      state: "succeeded",
      text: RESPONSE,
    });
    assert.ok(fixture.state.requests.every((p) => p.startsWith("/v1/")));
  } finally {
    await fixture.close();
  }
});
for (const field of [
  "dedicatedProfile",
  "credentialScopeIsolated",
  "effectiveToolCount",
  "memoryDisabled",
  "historyIsolated",
  "modelProviderLocked",
  "fallbackDisabled",
  "sourceCommit",
  "endpoint",
  "expiresAt",
])
  test(`missing/invalid isolation ${field} prevents even capability network access`, async () => {
    let calls = 0;
    await assert.rejects(
      HermesRuns.connect(
        options({
          inspectIsolation: async () => ({ ...evidence(), [field]: null }),
          fetch: async () => {
            calls++;
            throw new Error("unexpected");
          },
        }),
      ),
      /isolation_unverified/,
    );
    assert.equal(calls, 0);
  });
for (const defect of [
  "no-auth",
  "wrong-key",
  "redirect",
  "no-durable",
  "no-status",
  "enabled-tools",
])
  test(`Hermes rejects ${defect} without admission`, async () => {
    let admitted = 0;
    const base = options();
    await assert.rejects(
      HermesRuns.connect(
        options({
          fetch: async (url, init) => {
            if (init.method === "POST") admitted++;
            if (defect === "no-auth" && !init.headers.Authorization)
              return Response.json(cap());
            if (defect === "wrong-key" && init.headers.Authorization)
              return new Response(null, { status: 401 });
            if (defect === "redirect" && init.headers.Authorization)
              return new Response(null, {
                status: 302,
                headers: { Location: "http://forbidden.example" },
              });
            if (
              url.pathname === "/v1/capabilities" &&
              init.headers.Authorization
            ) {
              const c = cap();
              if (defect === "no-durable")
                c.features.runs_idempotency.durable = false;
              if (defect === "no-status") c.features.run_status = false;
              return Response.json(c);
            }
            if (defect === "enabled-tools" && url.pathname === "/v1/toolsets")
              return Response.json([{ enabled: true, tools: ["shell"] }]);
            return base.fetch(url, init);
          },
        }),
      ),
    );
    assert.equal(admitted, 0);
  });
test("task fields cannot override fixed model/session/tools/destination; run ID cannot escape path", async () => {
  const runs = await HermesRuns.connect(options());
  for (const extra of [
    { prompt: "arbitrary" },
    { tools: ["shell"] },
    { model: "other" },
    { session_id: "existing" },
    { endpoint: "http://other.example" },
    { provider: "other" },
  ])
    await assert.rejects(runs.create({ ...input, ...extra }), /input_rejected/);
  await assert.rejects(runs.get("../capabilities"), /run_id_rejected/);
});
for (const status of ["failed", "cancelled", "interrupted", "unknown"])
  test(`${status} cannot clear execution gate as confirmed completion`, async () => {
    const base = options();
    const runs = await HermesRuns.connect(
      options({
        fetch: async (url, init) =>
          url.pathname.includes("/v1/runs/")
            ? Response.json({
                object: "hermes.run",
                run_id: "run_fixture",
                status,
              })
            : base.fetch(url, init),
      }),
    );
    await assert.rejects(
      runs.get("run_fixture"),
      /terminal_requires_reconciliation/,
    );
  });
test("capability changes and expired effective isolation block subsequent admission", async () => {
  const base = options();
  let valid = true;
  const runs = await HermesRuns.connect(
    options({ inspectIsolation: async () => (valid ? evidence() : null) }),
  );
  valid = false;
  assert.equal(runs.toolIsolationVerified, true);
  await assert.rejects(runs.create(input), /isolation_unverified/);
  assert.equal(runs.toolIsolationVerified, false);
  let changedCapability = false;
  const changed = await HermesRuns.connect(
    options({
      fetch: async (url, init) => {
        if (
          changedCapability &&
          init.headers.Authorization &&
          url.pathname === "/v1/capabilities"
        ) {
          const changedCap = cap();
          changedCap.features.runs_idempotency.durable = false;
          return Response.json(changedCap);
        }
        return base.fetch(url, init);
      },
    }),
  );
  changedCapability = true;
  await assert.rejects(changed.create(input), /capabilities_unverified/);
  assert.equal(changed.durableIdempotency, false);
});
test("completed output or actual model/provider mismatch requires reconciliation", async () => {
  const base = options();
  for (const change of [
    { output: "other" },
    { runtime: { provider: "other", model: HERMES_MODEL } },
    { runtime: { provider: HERMES_PROVIDER, model: "fallback" } },
  ]) {
    const runs = await HermesRuns.connect(
      options({
        fetch: async (url, init) =>
          url.pathname.includes("/v1/runs/")
            ? Response.json({
                object: "hermes.run",
                run_id: "run_fixture",
                status: "completed",
                output: RESPONSE,
                runtime: { provider: HERMES_PROVIDER, model: HERMES_MODEL },
                ...change,
              })
            : base.fetch(url, init),
      }),
    );
    await assert.rejects(
      runs.get("run_fixture"),
      /terminal_requires_reconciliation/,
    );
  }
});
test("unknown HTTP admission survives journal reopen and replays the same key", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Hub, owner, worker, submit } = await import("./fixtures.js");
  const { Journal } = await import("../src/journal.ts");
  const { Adapter } = await import("../src/adapter.ts");
  const dir = mkdtempSync(join(tmpdir(), "hub-hermes-recovery-"));
  const hub = new Hub(join(dir, "hub.db"));
  let receipt = new Journal(join(dir, "receipt.db"));
  const fixture = await hermesFixture();
  let lost = false;
  try {
    const task = await submit(hub);
    const runs = await HermesRuns.connect({
      ...fixture.options,
      fetch: async (url, init) => {
        const response = await globalThis.fetch(url, init);
        if (init.method === "POST" && !lost) {
          lost = true;
          await response.body.cancel();
          throw new Error("fixture_ack_lost");
        }
        return response;
      },
    });
    await assert.rejects(
      new Adapter(
        hub,
        { ...worker, runnerScope: runs.boundaryId },
        runs,
        receipt,
      ).once(),
      /fixture_ack_lost/,
    );
    const key = receipt.load().key;
    assert.equal(receipt.load().run_id, null);
    assert.equal(fixture.state.calls, 1);
    receipt.close();
    receipt = new Journal(join(dir, "receipt.db"));
    assert.equal(receipt.load().key, key);
    await new Adapter(
      hub,
      { ...worker, runnerScope: runs.boundaryId },
      await HermesRuns.connect(fixture.options),
      receipt,
    ).run();
    assert.equal((await hub.get(owner, task)).result, RESPONSE);
    assert.equal(fixture.state.calls, 1);
    assert.equal(receipt.load(), null);
  } finally {
    receipt.close();
    hub.close();
    await fixture.close();
    rmSync(dir, { recursive: true });
  }
});
test("Hermes transport refuses omitted/non-loopback endpoints and missing keys without fallback", async () => {
  for (const change of [
    { endpoint: "http://localhost:10001/" },
    { endpoint: "https://example.com/" },
    { endpoint: "http://127.0.0.1:10001/api/" },
    { apiKey: "" },
  ])
    await assert.rejects(
      HermesRuns.connect(options(change)),
      /configuration_rejected/,
    );
});
test("changed idempotency retention rejects replay before POST", async () => {
  let changed = false,
    admissions = 0;
  const base = options();
  const runs = await HermesRuns.connect(
    options({
      fetch: async (url, init) => {
        if (init.method === "POST") admissions++;
        if (
          changed &&
          init.headers.Authorization &&
          url.pathname === "/v1/capabilities"
        ) {
          const c = cap();
          c.features.runs_idempotency.retention_seconds = 60;
          return Response.json(c);
        }
        return base.fetch(url, init);
      },
    }),
  );
  changed = true;
  await assert.rejects(runs.create(input), /retention_changed/);
  assert.equal(admissions, 0);
});
test("persisted admission scope mismatch rejects recovery before another claim/create", async () => {
  const { Hub, worker, submit, journal } = await import("./fixtures.js");
  const { Adapter } = await import("../src/adapter.ts");
  const h = new Hub();
  const receipt = journal();
  const runs = await HermesRuns.connect(options());
  try {
    await submit(h);
    const task = await h.claim(worker);
    receipt.save({
      id: task.id,
      fence: task.fence,
      key: `hub-${task.id}`,
      run_id: null,
      admitted_at: Date.now(),
      runner_scope: "different-endpoint-or-credential-scope",
    });
    await assert.rejects(
      new Adapter(
        h,
        { ...worker, runnerScope: runs.boundaryId },
        runs,
        receipt,
      ).once(),
      /runner_scope_requires_reconciliation/,
    );
    assert.equal((await h.get(worker, task)).execution_open, 1);
    assert.ok(receipt.load());
  } finally {
    h.close();
  }
});
for (const mode of [
  "longer-retention-after-reconnect",
  "expiry-during-preflight",
])
  test(`persistent unknown admission never replays after original deadline: ${mode}`, async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Hub, worker, submit } = await import("./fixtures.js");
    const { Journal } = await import("../src/journal.ts");
    const { Adapter } = await import("../src/adapter.ts");
    const dir = mkdtempSync(join(tmpdir(), "hub-replay-deadline-"));
    let now = Date.now();
    let retention = 1,
      cross = false,
      calls = 0,
      lose = true;
    const admitted = new Map();
    const h = new Hub(join(dir, "hub.db"), () => now);
    let receipt = new Journal(join(dir, "receipt.db"));
    const config = options({
      now: () => now,
      inspectIsolation: async () => ({ ...evidence(), expiresAt: now + 60000 }),
      fetch: async (url, init) => {
        if (!init.headers.Authorization)
          return new Response(null, { status: 401 });
        if (url.pathname === "/v1/capabilities") {
          const c = cap();
          c.features.runs_idempotency.retention_seconds = retention;
          return Response.json(c);
        }
        if (url.pathname === "/v1/toolsets") {
          if (cross) {
            now += 1001;
            cross = false;
          }
          return Response.json([]);
        }
        if (init.method === "POST") {
          const key = init.headers["Idempotency-Key"];
          if (!admitted.has(key) || admitted.get(key).expiry <= now) {
            calls++;
            admitted.set(key, {
              id: `run_fixture${calls}`,
              expiry: now + 1000,
            });
          }
          if (lose) {
            lose = false;
            throw new Error("fixture_ack_lost");
          }
          return Response.json(
            { run_id: admitted.get(key).id, status: "started" },
            { status: 202 },
          );
        }
        throw new Error("unexpected_poll");
      },
    });
    try {
      await submit(h);
      const first = await HermesRuns.connect(config);
      await assert.rejects(
        new Adapter(
          h,
          { ...worker, runnerScope: first.boundaryId },
          first,
          receipt,
          { now: () => now },
        ).once(),
        /fixture_ack_lost/,
      );
      const saved = receipt.load();
      assert.equal(calls, 1);
      assert.equal(saved.replay.retentionMs, 1000);
      assert.equal(saved.replay.deadline, saved.admitted_at + 1000);
      receipt.close();
      receipt = new Journal(join(dir, "receipt.db"));
      if (mode === "longer-retention-after-reconnect") {
        now += 1001;
        retention = 5;
      }
      const reconnected = await HermesRuns.connect(config);
      if (mode === "expiry-during-preflight") cross = true;
      await assert.rejects(
        new Adapter(
          h,
          { ...worker, runnerScope: reconnected.boundaryId },
          reconnected,
          receipt,
          { now: () => now },
        ).once(),
        /replay_contract_requires_reconciliation|idempotency_horizon_expired/,
      );
      assert.equal(calls, 1);
      assert.equal(receipt.load().run_id, null);
      assert.deepEqual(receipt.load().replay, saved.replay);
      const persisted = await h.get(
        { ...worker, runnerScope: first.boundaryId },
        saved,
      );
      assert.equal(persisted.state, "running");
      assert.equal(persisted.execution_open, 1);
    } finally {
      receipt.close();
      h.close();
      rmSync(dir, { recursive: true });
    }
  });
