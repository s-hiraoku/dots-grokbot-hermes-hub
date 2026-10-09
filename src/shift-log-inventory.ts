import { lstat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { inventoryResult, inventoryLocations } from "./task-contract.ts";
// Operator-owned exact paths. No home, PATH search, recursive listing, file reads or execution.
const locations = [
  { path: "/Applications/Shift Log.app", parents: ["/Applications"] },
  { path: "/Applications/ShiftLog.app", parents: ["/Applications"] },
  { path: "/Applications/shift-log.app", parents: ["/Applications"] },
  {
    path: "/opt/homebrew/bin/shift-log",
    parents: ["/opt", "/opt/homebrew", "/opt/homebrew/bin"],
  },
  {
    path: "/usr/local/bin/shift-log",
    parents: ["/usr", "/usr/local", "/usr/local/bin"],
  },
] as const;
type MetadataFS = {
  lstat(
    path: string,
  ): Promise<Pick<Stats, "isSymbolicLink" | "isDirectory" | "isFile">>;
};
/** Fixed metadata-only inventory. Candidates never establish exact product identity. */
export async function collectShiftLogInventory(
  fs: MetadataFS = { lstat },
): Promise<string> {
  const evidence = [];
  for (const [index, target] of locations.entries()) {
    let observation:
      | "directory_candidate"
      | "file_candidate"
      | "symlink_candidate"
      | "missing"
      | "unavailable"
      | "other" = "unavailable";
    try {
      for (const parent of target.parents) {
        const info = await fs.lstat(parent);
        if (info.isSymbolicLink() || !info.isDirectory())
          throw Error("parent_not_safe");
      }
      const info = await fs.lstat(target.path);
      observation = info.isSymbolicLink()
        ? "symlink_candidate"
        : info.isDirectory()
          ? "directory_candidate"
          : info.isFile()
            ? "file_candidate"
            : "other";
    } catch (error) {
      // Do not include filesystem errors, paths, owners or system details in output.
      observation =
        error instanceof Error && "code" in error && error.code === "ENOENT"
          ? "missing"
          : "unavailable";
    }
    evidence.push({ location: inventoryLocations[index], observation });
  }
  return JSON.stringify(
    inventoryResult.parse({
      task_type: "shift_log_inventory",
      product: "shift-log",
      status: "unknown",
      reason: "product_identity_unconfirmed_limited_metadata_only",
      evidence,
    }),
  );
}
