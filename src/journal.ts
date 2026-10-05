import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Receipt, JournalStore } from "./types.ts";
const receiptSchema = z
  .object({
    id: z.string().uuid(),
    fence: z.number().int().positive(),
    key: z.string().regex(/^hub-[a-zA-Z0-9-]+$/),
    run_id: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,100}$/)
      .nullable(),
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
    this.db
      .prepare(
        "INSERT INTO journal VALUES(1,?) ON CONFLICT(id) DO UPDATE SET entry=excluded.entry",
      )
      .run(JSON.stringify(entry));
  }
  clear() {
    this.db.exec("DELETE FROM journal WHERE id=1");
  }
  close() {
    this.db.close();
  }
}
