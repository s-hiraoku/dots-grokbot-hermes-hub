import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { TaskService } from "./store.ts";
import type { Principal } from "./types.ts";
const id = z.string().uuid(),
  fence = z.number().int().positive();
export const schemas = {
  submit: z
    .object({
      task_type: z.literal("connectivity_check"),
      request_key: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    })
    .strict(),
  claim: z.object({}).strict(),
  get: z.object({ id }).strict(),
  cancel: z.object({ id }).strict(),
  heartbeat: z
    .object({
      id,
      fence,
      run_id: z
        .string()
        .regex(/^[a-zA-Z0-9_-]{1,100}$/)
        .optional(),
    })
    .strict(),
  complete: z
    .object({
      id,
      fence,
      state: z.enum(["succeeded", "failed"]),
      result: z.enum([
        "Agent Hub connectivity check completed.",
        "connectivity_check_failed",
      ]),
    })
    .strict(),
};
export function createMCP(hub: TaskService, p: Principal) {
  const server = new McpServer({ name: "agent-hub", version: "0.2.0" });
  const invoke = async (name: string, args: unknown) => {
    switch (name) {
      case "submit":
        return hub.submit(p, schemas.submit.parse(args));
      case "claim":
        return hub.claim(p, schemas.claim.parse(args));
      case "get":
        return hub.get(p, schemas.get.parse(args));
      case "cancel":
        return hub.cancel(p, schemas.cancel.parse(args));
      case "heartbeat":
        return hub.heartbeat(p, schemas.heartbeat.parse(args));
      case "complete":
        return hub.complete(p, schemas.complete.parse(args));
      default:
        throw new Error("unknown_tool");
    }
  };
  for (const [name, schema] of Object.entries(schemas))
    server.registerTool(
      name,
      { description: `Agent Hub ${name}`, inputSchema: schema },
      async (args: unknown) => {
        try {
          const result = await invoke(name, args);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
          };
        } catch {
          return {
            isError: true,
            content: [{ type: "text" as const, text: "Operation rejected" }],
          };
        }
      },
    );
  return server;
}
export function handler(
  hub: TaskService,
  authenticate: (
    req: IncomingMessage,
  ) => Promise<Principal | null> = async () => null,
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
    const server = createMCP(hub, p),
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  };
}
export async function fetchMCP(
  hub: TaskService,
  request: Request,
  authenticate: (req: Request) => Promise<Principal | null> = async () => null,
): Promise<Response> {
  const p = await authenticate(request);
  if (!p) return new Response(null, { status: 401 });
  if (new URL(request.url).pathname !== "/mcp" || request.method !== "POST")
    return new Response(null, { status: 405 });
  const server = createMCP(hub, p),
    transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    await transport.close();
    await server.close();
  }
}
