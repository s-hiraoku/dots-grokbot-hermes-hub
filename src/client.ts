import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Principal, Lease, Task, HubClient } from "./types.ts";
export class MCPHubClient implements HubClient {
  readonly client: Client;
  constructor(client: Client) {
    this.client = client;
  }
  private async call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const response = CallToolResultSchema.parse(
      await this.client.callTool({ name, arguments: args }),
    );
    if (response.isError) throw new Error("hub_operation_rejected");
    const content = response.content[0];
    if (content?.type !== "text") throw new Error("invalid_hub_response");
    return JSON.parse(content.text) as unknown;
  }
  async claim(_p: Principal, a: Record<string, never>) {
    return (await this.call("claim", a)) as Task | null;
  }
  async get(_p: Principal, a: { id: string }) {
    return (await this.call("get", a)) as Task;
  }
  async heartbeat(_p: Principal, a: Lease & { run_id?: string }) {
    return (await this.call("heartbeat", { ...a })) as Task;
  }
  async complete(
    _p: Principal,
    a: Lease & { state: "succeeded" | "failed"; result: string },
  ) {
    return (await this.call("complete", { ...a })) as Task;
  }
}
