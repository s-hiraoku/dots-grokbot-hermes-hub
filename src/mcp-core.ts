import { taskTypes, canonicalResult } from "./task-contract.ts";
import {
  McpServer,
  ProtocolError,
  createMcpHandler,
  type ServerCapabilities,
} from "@modelcontextprotocol/server";
import type { EventAPI } from "./subscriptions.ts";
import { z } from "zod";
import type { TaskService } from "./store.ts";
import type { OAuthResource } from "./oauth.ts";
import {
  RUN_ID_PATTERN,
  CallbackEndpointError,
  type Principal,
} from "./types.ts";
const id = z.string().uuid(),
  fence = z.number().int().positive();
export const schemas = {
  submit: z
    .object({
      task_type: z.enum(taskTypes),
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
      run_id: z.string().regex(RUN_ID_PATTERN).optional(),
    })
    .strict(),
  complete: z
    .object({
      id,
      fence,
      state: z.enum(["succeeded", "failed"]),
      result: z
        .string()
        .max(4096)
        .refine(
          (value) =>
            value === "connectivity_check_failed" ||
            value === "shift_log_inventory_failed" ||
            taskTypes.some(
              (type) => canonicalResult(type, value) !== undefined,
            ),
        ),
    })
    .strict(),
};
export function createMCP(hub: TaskService, p: Principal, events?: EventAPI) {
  const server = new McpServer({ name: "agent-hub", version: "0.2.0" });
  const invoke = async (name: string, args: unknown) => {
    switch (name) {
      case "submit":
        return hub.submit(p, schemas.submit.parse(args));
      case "claim":
        return hub.claim(p, schemas.claim.parse(args));
      case "get":
        return hub.view(p, schemas.get.parse(args));
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
      {
        description: `Agent Hub ${name}`,
        inputSchema: schema,
        _meta: {
          securitySchemes: [{ type: "oauth2", scopes: [`hub:${name}`] }],
        },
      },
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
  if (events) {
    const eventCall = async (
      work: () => Promise<unknown>,
    ): Promise<Record<string, unknown>> => {
      try {
        return (await work()) as Record<string, unknown>;
      } catch (error) {
        if (error instanceof CallbackEndpointError)
          throw new ProtocolError(-32015, "CallbackEndpointError", {
            reason: error.reason,
          });
        throw new ProtocolError(-32602, "Operation rejected");
      }
    };
    server.server.registerCapabilities({ events: {} } as ServerCapabilities);
    const request = z.object({}).passthrough();
    server.server.setRequestHandler(
      "events/list",
      { params: z.object({}).strict() },
      async () => eventCall(() => events.list(p)),
    );
    server.server.setRequestHandler(
      "events/subscribe",
      { params: request },
      async (args) => eventCall(() => events.subscribe(p, args)),
    );
    server.server.setRequestHandler(
      "events/unsubscribe",
      { params: request },
      async (args) => eventCall(() => events.unsubscribe(p, args)),
    );
  }
  return server;
}
export async function fetchMCP(
  hub: TaskService,
  request: Request,
  authenticate: (req: Request) => Promise<Principal | null> = async () => null,
  events?: EventAPI,
  oauth?: OAuthResource,
): Promise<Response> {
  const metadata = oauth?.response(
    new URL(request.url).pathname,
    request.method,
  );
  if (metadata) return metadata;
  let p: Principal | null = null;
  try {
    const verified = await authenticate(request);
    if (verified) p = await hub.authorization.bind(verified);
  } catch {
    /* Authentication or authoritative DB failure denies admission. */
  }
  if (!p)
    return new Response(null, {
      status: 401,
      headers: oauth
        ? { "WWW-Authenticate": oauth.challenge(), "Cache-Control": "no-store" }
        : {},
    });
  if (new URL(request.url).pathname !== "/mcp" || request.method !== "POST")
    return new Response(null, { status: 405 });
  return createMcpHandler(() => createMCP(hub, p, events)).fetch(request);
}
