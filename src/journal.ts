import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { RUN_ID_PATTERN, type Receipt, type JournalStore } from "./types.ts";
const receiptSchema = z
  .object({
    id: z.string().uuid(),
    fence: z.number().int().positive(),
    key: z.string().regex(/^hub-[a-zA-Z0-9-]+$/),
    run_id: z.string().regex(RUN_ID_PATTERN).nullable(),
    replay: z
      .object({
        deadline: z.number().finite().nonnegative(),
        retentionMs: z.number().finite().positive(),
        contract: z.string().min(1).max(100),
      })
      .strict()
      .optional(),
    runner_scope: z.string().max(200).optional(),
    admitted_at: z.number().finite().nonnegative(),
  })
  .strict();
export class Journal implements JournalStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS journal(id INTEGER PRIMARY KEY CHECK(id=1),entry TEXT NOT NULL)",
    );
  }
  load(): Receipt | null {
    const r = this.db.prepare("SELECT entry FROM journal WHERE id=1").get();
    return r ? receiptSchema.parse(JSON.parse(String(r.entry))) : null;
  }
  save(entry: Receipt) {
    const valid = receiptSchema.parse(entry);
    this.db
      .prepare(
        "INSERT INTO journal VALUES(1,?) ON CONFLICT(id) DO UPDATE SET entry=excluded.entry",
      )
      .run(JSON.stringify(valid));
  }
  clear() {
    this.db.exec("DELETE FROM journal WHERE id=1");
  }
  close() {
    this.db.close();
  }
}
