import { D1Hub } from "../src/d1.ts";
import { fetchMCP } from "../src/mcp.ts";
import type { Principal } from "../src/types.ts";
const owner: Principal = {
  subject: "fixture-owner",
  destination: "hermes",
  operations: ["submit", "get", "cancel", "events"],
};
const worker: Principal = {
  subject: "fixture-worker",
  worker: "hermes",
  operations: ["get", "claim", "heartbeat", "complete"],
};
export default {
  fetch(request: Request, env: { DB: D1Database }) {
    return fetchMCP(new D1Hub(env.DB), request, async (req) =>
      req.headers.get("authorization") === "Bearer fixture-owner"
        ? owner
        : req.headers.get("authorization") === "Bearer fixture-worker"
          ? worker
          : null,
    );
  },
};
