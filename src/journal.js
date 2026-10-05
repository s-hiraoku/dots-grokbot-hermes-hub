import { DatabaseSync } from "node:sqlite";
export class Journal {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS journal(id INTEGER PRIMARY KEY CHECK(id=1), entry TEXT NOT NULL)",
    );
  }
  load() {
    const r = this.db.prepare("SELECT entry FROM journal WHERE id=1").get();
    return r ? JSON.parse(r.entry) : null;
  }
  save(entry) {
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
