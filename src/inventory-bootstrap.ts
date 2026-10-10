import { createServer } from "node:http";
import { z } from "zod";
import { OAuthResource } from "./oauth.ts";
import { inventoryHTTPBoundary } from "./inventory-http.ts";

const settings = z
  .object({
    version: z.literal(1),
    mode: z.literal("inventory-metadata"),
    enabled: z.literal(false),
    oauth: z.object({ issuer: z.string(), resource: z.string() }).strict(),
  })
  .strict();

/** Manually started metadata only. No task service/DB, verifier, worker, key,
 * credential input, model or promotion path. A different confirmed config and
 * separate process invocation are required for authenticated one-shot operation.
 */
export async function startInventoryBootstrap(
  input: unknown,
  dependencies: { lifetimeMs?: number } = {},
) {
  let oauth: OAuthResource;
  let lifetimeMs: number;
  try {
    const config = settings.parse(input);
    lifetimeMs = z
      .number()
      .int()
      .min(1000)
      .max(600000)
      .parse(dependencies.lifetimeMs ?? 600000);
    oauth = new OAuthResource({
      ...config.oauth,
      userScopes: ["hub:submit", "hub:get"],
    });
  } catch {
    throw Error("inventory_bootstrap_config_rejected");
  }
  const handle = inventoryHTTPBoundary(oauth, async (req, res) => {
    req.resume(); // Bodies are discarded, never parsed as tasks or credentials.
    const metadata = oauth.response(req.url ?? "/", req.method ?? "");
    if (metadata) {
      res.writeHead(metadata.status, Object.fromEntries(metadata.headers));
      res.end(await metadata.text());
      return;
    }
    res.writeHead(401, {
      "WWW-Authenticate": oauth.challenge(),
      "Cache-Control": "no-store",
    });
    res.end();
  });
  let stopping = false;
  const server = createServer(
    { requestTimeout: 5000, headersTimeout: 5000, keepAliveTimeout: 1000 },
    (req, res) => {
      if (stopping) {
        res.writeHead(403, { "Cache-Control": "no-store" });
        res.end();
        return;
      }
      void handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    },
  );
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let closure: Promise<void> | undefined;
  const close = () =>
    (closure ??= (async () => {
      stopping = true;
      clearTimeout(timer);
      const stopped = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
      server.closeIdleConnections();
      const force = setTimeout(() => server.closeAllConnections(), 3000);
      await stopped;
      clearTimeout(force);
      resolveClosed();
    })());
  const timer = setTimeout(() => {
    void close();
  }, lifetimeMs);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(8789, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch {
    clearTimeout(timer);
    throw Error("inventory_bootstrap_bind_failed");
  }
  return Object.freeze({
    endpoint: `http://127.0.0.1:8789${oauth.mcpPath}`,
    closed,
    close,
  });
}
