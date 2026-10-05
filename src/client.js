// Wrap an already connected, authenticated official MCP client.
// The transport/credential/URL is configured by trusted code, never task input.
export class MCPHubClient {
  constructor(client) {
    this.client = client;
  }
  async call(name, args) {
    const response = await this.client.callTool({ name, arguments: args });
    if (response.isError) throw new Error("hub_operation_rejected");
    return JSON.parse(response.content[0].text);
  }
  claim(_principal, args) {
    return this.call("claim", args);
  }
  get(_principal, args) {
    return this.call("get", args);
  }
  heartbeat(_principal, args) {
    return this.call("heartbeat", args);
  }
  complete(_principal, args) {
    return this.call("complete", args);
  }
}
