import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { Hub } from "./sqlite.ts";
import { handler } from "./mcp.ts";
mkdirSync("runtime", { recursive: true, mode: 0o700 });
const hub = new Hub("runtime/hub.db"),
  handle = handler(hub);
createServer((req, res) => {
  void handle(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
}).listen(8787, "127.0.0.1");
