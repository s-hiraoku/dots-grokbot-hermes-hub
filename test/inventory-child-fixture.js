// Harmless isolated child for integration tests. No model, filesystem collector,
// external request or inherited authentication; only synthetic API_SERVER_KEY.
import { createServer } from "node:http";
import { writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import process from "node:process";
const profile = dirname(process.cwd());
const manifest = JSON.parse(
  readFileSync(join(profile, "inventory-manifest.json"), "utf8"),
);
const db = new DatabaseSync(manifest.runStorePath);
db.exec("CREATE TABLE fixture_runs(key TEXT PRIMARY KEY,id TEXT NOT NULL)");
const output = JSON.stringify({
  task_type: "shift_log_inventory",
  product: "shift-log",
  status: "unknown",
  reason: "product_identity_unconfirmed_limited_metadata_only",
  evidence: [
    "applications-spaced",
    "applications-camel",
    "applications-kebab",
    "homebrew-command",
    "local-command",
  ].map((location) => ({ location, observation: "missing" })),
});
const server = createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.API_SERVER_KEY}`) {
    res.writeHead(401);
    res.end();
    return;
  }
  let body = "";
  for await (const part of req) body += part;
  let response,
    status = 200;
  if (req.url === "/v1/capabilities")
    response = {
      object: "hermes.api_server.capabilities",
      platform: "hermes-agent",
      auth: { type: "bearer", required: true },
      inventory_policy: {
        contract: "hermes-agent-inventory-v1",
        fixed_input: "hub:shift-log-inventory:v1",
        effective_tool_names: ["hub_shift_log_inventory"],
        collector: "fixed-lstat-v1",
        session_overrides: false,
        personal_context: false,
        max_iterations: 3,
        max_tokens: 256,
        run_budget_seconds: 60,
        max_concurrent_runs: 1,
      },
      features: {
        run_submission: true,
        run_status: true,
        runs_idempotency: {
          supported: true,
          durable: true,
          retention_seconds: 86400,
        },
      },
    };
  else if (
    req.url === "/v1/runs" &&
    req.method === "POST" &&
    body === JSON.stringify({ input: "hub:shift-log-inventory:v1" })
  ) {
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || !/^hub-[0-9a-f-]{36}$/.test(key)) {
      res.writeHead(400);
      res.end();
      return;
    }
    db.prepare("INSERT OR IGNORE INTO fixture_runs VALUES(?,?)").run(
      key,
      "run_fixture",
    );
    response = { run_id: "run_fixture", status: "started" };
    status = 202;
  } else if (
    req.url === "/v1/runs/run_fixture" &&
    db.prepare("SELECT id FROM fixture_runs").get()
  )
    response = {
      object: "hermes.run",
      run_id: "run_fixture",
      status: "completed",
      output,
      runtime: { model: "gpt-6.1-sol", provider: "openai-codex" },
    };
  else {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(response));
});
server.listen(8645, "127.0.0.1", () =>
  writeFileSync(join(profile, "inventory.pid"), String(process.pid), {
    mode: 0o600,
  }),
);
process.once("SIGTERM", () => {
  server.closeAllConnections();
  server.close(() => {
    db.close();
    process.exit(0);
  });
});
