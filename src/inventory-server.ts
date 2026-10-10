import { pathToFileURL } from "node:url";
import { z } from "zod";
import { readRuntimeConfig } from "./runtime-config.ts";
import { startInventoryEntry } from "./inventory-entry.ts";

/** Manual process entry. Already acquired worker authorization arrives once on
 * stdin, never argv, environment, a task, a file lookup or an OAuth acquisition.
 */
export async function inventoryMain() {
  if (!process.env.HAB_INVENTORY_CONFIG)
    throw Error("inventory_config_required");
  const config = readRuntimeConfig(process.env.HAB_INVENTORY_CONFIG);
  let bytes = Buffer.alloc(0);
  const timeout = setTimeout(
    () => process.stdin.destroy(Error("inventory_input_timeout")),
    3000,
  );
  try {
    for await (const chunk of process.stdin) {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 17000) throw Error("inventory_input_rejected");
    }
  } finally {
    clearTimeout(timeout);
  }
  let authorization: string;
  try {
    authorization = z
      .object({
        authorization: z
          .string()
          .min(8)
          .max(16384)
          .regex(/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
      })
      .strict()
      .parse(JSON.parse(bytes.toString("utf8"))).authorization;
  } catch {
    throw Error("inventory_input_rejected");
  }
  bytes.fill(0);
  const entry = await startInventoryEntry(config, {
    workerAuthorization: async () => authorization,
  });
  const stop = () => {
    void entry.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await entry.closed;
  } finally {
    authorization = "";
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void inventoryMain().catch(() => {
    process.stderr.write("inventory_entry_failed_requires_review\n");
    process.exitCode = 1;
  });
}
