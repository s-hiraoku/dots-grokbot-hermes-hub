import type { PingService } from "./ping.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { EventAPI } from "./subscriptions.ts";
import type { TaskService } from "./store.ts";
import type { Principal } from "./types.ts";
import { createMCP } from "./mcp-core.ts";
import type { OAuthResource } from "./oauth.ts";
export * from "./mcp-core.ts";
export function handler(
  hub: TaskService,
  authenticate: (
    req: IncomingMessage,
  ) => Promise<Principal | null> = async () => null,
  events?: EventAPI,
  oauth?: OAuthResource,
  ping?: PingService,
) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const metadata = oauth?.response(path, req.method ?? "");
    if (metadata) {
      res.writeHead(metadata.status, Object.fromEntries(metadata.headers));
      res.end(await metadata.text());
      return;
    }
    let p: Principal | null = null;
    try {
      const verified = await authenticate(req);
      if (verified) p = await hub.authorization.bind(verified);
    } catch {
      /* Authentication or authoritative DB failure denies admission. */
    }
    if (!p) {
      res.writeHead(
        401,
        oauth
          ? {
              "WWW-Authenticate": oauth.challenge(),
              "Cache-Control": "no-store",
            }
          : {},
      );
      res.end();
      return;
    }
    if (req.url !== "/mcp" || req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }
    const { toNodeHandler } = await import("@modelcontextprotocol/node");
    await toNodeHandler(
      createMcpHandler(() => createMCP(hub, p, events, ping)),
    )(req, res);
  };
}
