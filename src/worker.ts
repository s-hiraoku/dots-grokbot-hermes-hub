import { D1Hub } from "./d1.ts";
import { fetchMCP } from "./mcp-core.ts";
export default {
  async fetch(request: Request, env: { DB: D1Database }): Promise<Response> {
    try {
      return await fetchMCP(new D1Hub(env.DB), request);
    } catch {
      return new Response(null, { status: 503 });
    }
  },
};
