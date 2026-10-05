import { createServer } from "node:http";
import assert from "node:assert/strict";
import { RESPONSE } from "../src/types.ts";
import {
  HERMES_MODEL,
  HERMES_PROVIDER,
  HERMES_COMMIT,
  PILOT_INPUT,
  PILOT_OUTPUT,
} from "../src/hermes-runs.ts";
export async function hermesFixture(pilot = false) {
  const state = { calls: 0, requests: [], runs: new Map() };
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer fixture-hermes") {
      res.writeHead(401);
      res.end();
      return;
    }
    state.requests.push(req.url);
    const send = (status, data) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (req.url === "/v1/capabilities")
      return send(200, {
        ...(pilot
          ? {
              pilot_policy: {
                fixed_input: PILOT_INPUT,
                effective_tools: 0,
                session_overrides: false,
                personal_context: false,
              },
            }
          : {}),
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
    if (!pilot && req.url === "/v1/toolsets")
      return send(200, [{ enabled: false, tools: ["shell"] }]);
    if (req.url === "/v1/runs" && req.method === "POST") {
      let text = "";
      for await (const chunk of req) text += chunk;
      const payload = JSON.parse(text);
      assert.deepEqual(
        payload,
        pilot
          ? { input: PILOT_INPUT }
          : {
              input: `Reply with exactly this text and nothing else: ${RESPONSE}`,
              model: HERMES_MODEL,
              provider: HERMES_PROVIDER,
            },
      );
      const key = req.headers["idempotency-key"];
      if (!state.runs.has(key)) {
        state.calls++;
        state.runs.set(key, `run_fixture${state.calls}`);
      }
      return send(202, { run_id: state.runs.get(key), status: "started" });
    }
    if (req.url.startsWith("/v1/runs/"))
      return send(200, {
        object: "hermes.run",
        run_id: req.url.split("/").at(-1),
        status: "completed",
        output: pilot ? PILOT_OUTPUT : RESPONSE,
        runtime: { provider: HERMES_PROVIDER, model: HERMES_MODEL },
      });
    send(404, {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/`;
  return {
    state,
    options: {
      endpoint,
      scopeId: "fixture-isolated-scope",
      apiKey: "fixture-hermes",
      inspectIsolation: async () => ({
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
      }),
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
