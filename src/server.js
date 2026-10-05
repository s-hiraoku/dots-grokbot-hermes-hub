import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { Hub } from "./hub.js";
import { handler } from "./mcp.js";
mkdirSync("runtime", { recursive: true, mode: 0o700 });
const hub = new Hub("runtime/hub.db");
// No token creation, environment fallback, or trusted-header bypass.
const handle = handler(hub);
createServer((req, res) =>
  handle(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }),
).listen(8787, "127.0.0.1");
