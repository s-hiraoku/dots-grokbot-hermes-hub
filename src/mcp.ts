import type { IncomingMessage, ServerResponse } from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { EventAPI } from "./subscriptions.ts";
import type { TaskService } from "./store.ts";
import type { Principal } from "./types.ts";
import { createMCP } from "./mcp-core.ts";
export * from "./mcp-core.ts";
export function handler(
  hub: TaskService,
  authenticate: (
    req: IncomingMessage,
  ) => Promise<Principal | null> = async () => null,
  events?: EventAPI,
) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const p = await authenticate(req);
    if (!p) {
      res.writeHead(401);
      res.end();
      return;
    }
    if (req.url !== "/mcp" || req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }
    const { toNodeHandler } = await import("@modelcontextprotocol/node");
    await toNodeHandler(createMcpHandler(() => createMCP(hub, p, events)))(
      req,
      res,
    );
  };
}
