import { z } from "zod";
import { schemas } from "./mcp-core.ts";
import { validMcpPath } from "./oauth.ts";
import { canonicalResult } from "./task-contract.ts";
import {
  RESPONSE,
  RUN_ID_PATTERN,
  type HubClient,
  type Principal,
  type Task,
  type Lease,
} from "./types.ts";

const task = z.object({
  id: z.string().uuid(),
  fence: z.number().int().nonnegative(),
  task_type: z.literal("connectivity_check").optional(),
  owner: z.string().min(1).max(200),
  destination: z.literal("hermes"),
  request_key: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  state: z.enum([
    "queued",
    "running",
    "waiting_approval",
    "succeeded",
    "failed",
    "cancelled",
  ]),
  lease: z.number().int().nullable(),
  run_id: z.string().regex(RUN_ID_PATTERN).nullable(),
  runner_scope: z.string().max(200).nullable(),
  runner_subject: z.string().max(200).nullable(),
  result: z.enum([RESPONSE, "connectivity_check_failed"]).nullable(),
  execution_open: z.union([z.literal(0), z.literal(1)]),
  at: z.number().int(),
});

export const INVENTORY_ONE_SHOT_KEY = "hab-inventory-one-shot-v1";
const inventoryTask = task.extend({
  task_type: z.literal("shift_log_inventory"),
  request_key: z.literal(INVENTORY_ONE_SHOT_KEY),
  result: z
    .string()
    .max(4096)
    .refine(
      (value) =>
        value === "shift_log_inventory_failed" ||
        canonicalResult("shift_log_inventory", value) === value,
    )
    .nullable(),
});
type ClientOptions = {
  endpoint: string;
  authorization: () => Promise<string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
};
/** Bounded shared transport. Contracts are selected only by fixed exported classes.
 * Principal arguments satisfy Adapter's local contract; never transmit agent/subject labels.
 * The server resolves authority solely from the supplied access token.
 */
class MCPTaskClient implements HubClient {
  #endpoint: string;
  #authorization: () => Promise<string>;
  #fetch: typeof fetch;
  #timeoutMs: number;
  #id = 0;
  #task: z.ZodType<Task>;
  protected constructor(
    options: ClientOptions,
    host: string,
    parser: z.ZodType<Task>,
  ) {
    const url = new URL(options.endpoint);
    if (
      url.protocol !== "http:" ||
      url.host !== host ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !validMcpPath(url.pathname) ||
      url.href !== options.endpoint
    )
      throw Error("worker_endpoint_rejected");
    this.#endpoint = options.endpoint;
    this.#task = parser;
    this.#authorization = options.authorization;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = z
      .number()
      .int()
      .min(1)
      .max(3000)
      .parse(options.timeoutMs ?? 2000);
  }
  protected async call(
    name: "submit" | "claim" | "get" | "heartbeat" | "complete",
    args: unknown,
  ): Promise<Task | null> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.#perform(name, args, controller.signal),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(Error());
          }, this.#timeoutMs);
        }),
      ]);
    } catch {
      throw Error("worker_mcp_rejected_requires_reconciliation");
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  async #perform(
    name: "submit" | "claim" | "get" | "heartbeat" | "complete",
    args: unknown,
    signal: AbortSignal,
  ): Promise<Task | null> {
    const input = schemas[name].parse(args);
    const authorization = await this.#authorization();
    if (
      signal.aborted ||
      !/^Bearer [A-Za-z0-9._~-]+$/.test(authorization) ||
      authorization.length > 16384
    )
      throw Error();
    const id = ++this.#id;
    const response = await this.#fetch(this.#endpoint, {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
        Accept: "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": name,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name,
          arguments: input,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    if (
      signal.aborted ||
      response.status !== 200 ||
      !response.body ||
      (response.url && response.url !== this.#endpoint)
    )
      throw Error();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 65536 || signal.aborted) throw Error();
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const envelope = z
      .object({
        jsonrpc: z.literal("2.0"),
        id: z.literal(id),
        result: z.object({
          isError: z.literal(false).optional(),
          content: z
            .array(z.object({ type: z.literal("text"), text: z.string() }))
            .length(1),
        }),
      })
      .strict()
      .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const value = JSON.parse(envelope.result.content[0].text);
    if (name === "claim" && value === null) return null;
    return this.#task.parse(value);
  }
  claim(p: Principal, args: Record<string, never>) {
    void p;
    return this.call("claim", args);
  }
  async get(p: Principal, args: { id: string }) {
    void p;
    return (await this.call("get", args))!;
  }
  async heartbeat(p: Principal, args: Lease & { run_id?: string }) {
    void p;
    return (await this.call("heartbeat", args))!;
  }
  async complete(
    p: Principal,
    args: Lease & { state: "succeeded" | "failed"; result: string },
  ) {
    void p;
    return (await this.call("complete", args))!;
  }
}

/** The ordinary client stays connectivity-only and bound to its original port. */
export class MCPWorkerClient extends MCPTaskClient {
  constructor(options: ClientOptions) {
    super(options, "127.0.0.1:8787", task);
  }
}

/** Dedicated one-shot inventory transport. No token issuance, discovery or retry. */
export class InventoryMCPClient extends MCPTaskClient {
  constructor(options: ClientOptions) {
    super(options, "127.0.0.1:8789", inventoryTask);
  }
  async submit(args: {
    task_type: "shift_log_inventory";
    request_key: typeof INVENTORY_ONE_SHOT_KEY;
  }) {
    z.object({
      task_type: z.literal("shift_log_inventory"),
      request_key: z.literal(INVENTORY_ONE_SHOT_KEY),
    })
      .strict()
      .parse(args);
    return (await this.call("submit", args))!;
  }
  async complete(
    p: Principal,
    args: Lease & { state: "succeeded" | "failed"; result: string },
  ) {
    if (
      args.result !== "shift_log_inventory_failed" &&
      canonicalResult("shift_log_inventory", args.result) !== args.result
    )
      throw Error("inventory_result_rejected");
    return super.complete(p, args);
  }
}
