import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TaskService } from "./store.ts";
import type { Driver, Statement, Row } from "./types.ts";
export class SQLiteDriver implements Driver {
  readonly db: DatabaseSync;
  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
    // Refuse an unknown legacy schema instead of modifying or discarding its records.
    if (
      this.db
        .prepare("SELECT name FROM sqlite_master WHERE name='tasks'")
        .get() &&
      !this.db
        .prepare("SELECT name FROM sqlite_master WHERE name='hub_migrations'")
        .get()
    ) {
      this.db.close();
      throw new Error("legacy_schema_requires_reviewed_migration");
    }
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS hub_migrations(id TEXT PRIMARY KEY)",
    );
    const root = fileURLToPath(new URL("../drizzle/", import.meta.url));
    for (const name of readdirSync(root)
      .filter((n) => n.endsWith(".sql"))
      .sort()) {
      if (this.db.prepare("SELECT id FROM hub_migrations WHERE id=?").get(name))
        continue;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(readFileSync(`${root}/${name}`, "utf8"));
        this.db.prepare("INSERT INTO hub_migrations VALUES(?)").run(name);
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    }
  }
  async batch(statements: Statement[]): Promise<Row[][]> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = statements.map(
        (s) => this.db.prepare(s.sql).all(...(s.params ?? [])) as Row[],
      );
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  close() {
    this.db.close();
  }
}
export class Hub extends TaskService {
  readonly sqlite: SQLiteDriver;
  constructor(path = ":memory:", now = () => Date.now(), leaseMs = 30000) {
    const sqlite = new SQLiteDriver(path);
    super(sqlite, now, leaseMs);
    this.sqlite = sqlite;
  }
  close() {
    this.sqlite.close();
  }
}
