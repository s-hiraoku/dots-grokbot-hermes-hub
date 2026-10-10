import type { IncomingMessage, ServerResponse } from "node:http";
import type { OAuthResource } from "./oauth.ts";

/** Exact operator-configured authorities only; forwarded headers confer no trust.
 * Shared by metadata-only bootstrap and authenticated one-shot entry.
 */
export function inventoryHTTPBoundary(
  oauth: OAuthResource,
  next: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
) {
  const resource = new URL(oauth.resource);
  const hosts = new Set(["127.0.0.1:8789", resource.host]);
  return async (req: IncomingMessage, res: ServerResponse) => {
    const duplicate = ["host", "authorization", "origin"].some(
      (name) =>
        req.rawHeaders.filter(
          (_v, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === name,
        ).length > 1,
    );
    if (
      duplicate ||
      !req.headers.host ||
      !hosts.has(req.headers.host) ||
      (req.headers.origin !== undefined &&
        req.headers.origin !== resource.origin)
    ) {
      res.writeHead(403, { "Cache-Control": "no-store" });
      res.end();
      return;
    }
    await next(req, res);
  };
}
