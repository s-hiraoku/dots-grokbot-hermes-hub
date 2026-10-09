import { z } from "zod";
import { RESPONSE } from "./types.ts";
export const taskTypes = ["connectivity_check", "shift_log_inventory"] as const;
export type TaskType = (typeof taskTypes)[number];
export const INVENTORY_REQUEST = "hub:shift-log-inventory:v1";
export const inventoryLocations = [
  "applications-spaced",
  "applications-camel",
  "applications-kebab",
  "homebrew-command",
  "local-command",
] as const;
export const inventoryResult = z
  .object({
    task_type: z.literal("shift_log_inventory"),
    product: z.literal("shift-log"),
    status: z.literal("unknown"),
    reason: z.literal("product_identity_unconfirmed_limited_metadata_only"),
    evidence: z
      .array(
        z
          .object({
            location: z.enum(inventoryLocations),
            observation: z.enum([
              "directory_candidate",
              "file_candidate",
              "symlink_candidate",
              "missing",
              "unavailable",
              "other",
            ]),
          })
          .strict(),
      )
      .length(inventoryLocations.length),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.evidence.map((e) => e.location)).size ===
      inventoryLocations.length,
  );
export function taskRequest(type: TaskType) {
  return type === "connectivity_check" ? RESPONSE : INVENTORY_REQUEST;
}
export function canonicalResult(
  type: TaskType,
  text: string,
): string | undefined {
  if (type === "connectivity_check")
    return text === RESPONSE ? RESPONSE : undefined;
  if (type !== "shift_log_inventory" || text.length > 4096) return;
  try {
    const parsed = inventoryResult.parse(JSON.parse(text));
    parsed.evidence.sort(
      (a, b) =>
        inventoryLocations.indexOf(a.location) -
        inventoryLocations.indexOf(b.location),
    );
    return JSON.stringify(parsed);
  } catch {
    return;
  }
}
export const taskFailure = (type: TaskType) =>
  type === "connectivity_check"
    ? "connectivity_check_failed"
    : "shift_log_inventory_failed";
