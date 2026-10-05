import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Hub, RESPONSE } from "../src/hub.js";
import { handler } from "../src/mcp.js";
test("official MCP client HTTP initialization/discovery and fixed roundtrip", async () => {
  const hub = new Hub();
  const owner = {
    subject: "dummy-owner",
    operations: ["submit", "get", "cancel"],
    destination: "hermes",
  };
  const worker = {
    subject: "dummy-worker",
    worker: "hermes",
    operations: ["get", "claim", "heartbeat", "complete"],
  };
  // Fixture-only verifier; the runnable server does not contain this dummy credential mapping.
  const handle = handler(hub, async (req) =>
    req.headers.authorization === "Bearer fixture-requester"
      ? owner
      : req.headers.authorization === "Bearer fixture-worker"
        ? worker
        : null,
  );
  const server = createServer((req, res) =>
    handle(req, res).catch(() => {
      res.writeHead(500);
      res.end();
    }),
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  const a = new Client({ name: "fixture", version: "1" }),
    b = new Client({ name: "fixture-worker", version: "1" });
  const call = async (client, name, args) => {
    const r = await client.callTool({ name, arguments: args });
    assert.ok(!r.isError);
    return JSON.parse(r.content[0].text);
  };
  try {
    await a.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: "Bearer fixture-requester" } },
      }),
    );
    await b.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: "Bearer fixture-worker" } },
      }),
    );
    assert.equal((await a.listTools()).tools.length, 6);
    const t = await call(a, "submit", {
      task_type: "connectivity_check",
      request_key: "http-1",
    });
    assert.equal(
      (await a.callTool({ name: "claim", arguments: {} })).isError,
      true,
    );
    const claimed = await call(b, "claim", {});
    await call(b, "heartbeat", {
      id: t.id,
      fence: claimed.fence,
      run_id: "mock-1",
    });
    await call(b, "complete", {
      id: t.id,
      fence: claimed.fence,
      state: "succeeded",
      result: RESPONSE,
    });
    assert.equal((await call(a, "get", { id: t.id })).state, "succeeded");
    assert.equal(
      (
        await a.callTool({
          name: "submit",
          arguments: {
            task_type: "connectivity_check",
            request_key: "http-2",
            agent: "hermes",
          },
        })
      ).isError,
      true,
    );
  } finally {
    await a.close();
    await b.close();
    await new Promise((r) => server.close(r));
    hub.close();
  }
});
