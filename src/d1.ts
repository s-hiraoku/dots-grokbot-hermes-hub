import { TaskService } from "./store.ts";
import type { Driver, Statement, Row } from "./types.ts";
export class D1Driver implements Driver {
  readonly nowSQL = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
  readonly db: D1Database;
  constructor(db: D1Database) {
    this.db = db;
  }
  async batch(statements: Statement[]): Promise<Row[][]> {
    // Use primary-constrained sessions for authorization/state reads, never an arbitrary replica.
    const session = this.db.withSession("first-primary");
    const result = await session.batch(
      statements.map((s) => session.prepare(s.sql).bind(...(s.params ?? []))),
    );
    return result.map((r) => r.results as Row[]);
  }
}
export class D1Hub extends TaskService {
  constructor(db: D1Database, now = () => Date.now(), leaseMs = 30000) {
    super(new D1Driver(db), now, leaseMs);
  }
}
