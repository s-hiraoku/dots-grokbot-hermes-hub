import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
const id = z.string().uuid();
const fence = z.number().int().positive();
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
// authenticate is an injected verified-identity boundary. Header names alone are never identity.
export function handler(hub, authenticate = async () => null) {
  return async (req, res) => {
    const principal = await authenticate(req);
    if (!principal) {
      res.writeHead(401);
      res.end();
      return;
    }
    if (req.url !== "/mcp" || req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }
    const server = new McpServer({ name: "agent-hub", version: "0.1.0" });
    for (const [name, schema] of Object.entries(schemas))
      server.registerTool(
        name,
        { description: `Agent Hub ${name}`, inputSchema: schema },
        async (a) => {
          try {
            const result = hub[name](principal, a);
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
            };
          } catch {
            return {
              isError: true,
              content: [{ type: "text", text: "Operation rejected" }],
            };
          }
        },
      );
    const transport = new StreamableHTTPServerTransport({
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
