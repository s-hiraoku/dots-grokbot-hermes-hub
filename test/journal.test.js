import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "../src/journal.ts";
import { schemas } from "../src/mcp.ts";
test("maximum Hermes run ID survives receipt reopen and MCP heartbeat validation; invalid save preserves prior receipt", () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-journal-limit-"));
  const path = join(dir, "receipt.db");
  let j = new Journal(path);
  const id = randomUUID();
  const receipt = {
    id,
    fence: 1,
    key: `hub-${id}`,
    run_id: `run_${"a".repeat(120)}`,
    admitted_at: Date.now(),
  };
  try {
    schemas.heartbeat.parse({ id, fence: 1, run_id: receipt.run_id });
    j.save(receipt);
    j.close();
    j = new Journal(path);
    assert.deepEqual(j.load(), receipt);
    assert.throws(() => j.save({ ...receipt, run_id: `${receipt.run_id}a` }));
    assert.throws(() => j.save({ ...receipt, fence: 0 }));
    assert.deepEqual(j.load(), receipt);
  } finally {
    j.close();
    rmSync(dir, { recursive: true });
  }
});
