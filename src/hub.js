import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
export const RESPONSE = "Agent Hub connectivity check completed.";
export class Hub {
  constructor(path = ":memory:", now = () => Date.now()) {
    this.db = new DatabaseSync(path);
    this.now = now;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, owner TEXT NOT NULL, destination TEXT NOT NULL, request_key TEXT NOT NULL, state TEXT NOT NULL, execution_open INTEGER NOT NULL DEFAULT 0, fence INTEGER NOT NULL DEFAULT 0, lease INTEGER, run_id TEXT, result TEXT, UNIQUE(owner, request_key));
      CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY, task TEXT, actor TEXT, state TEXT, at INTEGER);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY, task TEXT, owner TEXT, event TEXT, delivered INTEGER NOT NULL DEFAULT 0);
    `);
    // Preserve safety when opening a phase-one database from before execution gating.
    if (
      !this.db
        .prepare("PRAGMA table_info(tasks)")
        .all()
        .some((c) => c.name === "execution_open")
    ) {
      this.db.exec(
        "ALTER TABLE tasks ADD COLUMN execution_open INTEGER NOT NULL DEFAULT 0",
      );
      this.db.exec(
        "UPDATE tasks SET execution_open=1 WHERE state IN ('running','waiting_approval') OR (state='cancelled' AND fence>1)",
      );
    }
  }
  tx(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  principal(p, operation) {
    if (!p || !p.subject || !p.operations?.includes(operation))
      throw new Error("forbidden");
  }
  record(t, p) {
    this.db
      .prepare("INSERT INTO audit(task,actor,state,at) VALUES(?,?,?,?)")
      .run(t.id, p.subject, t.state, this.now());
    if (["succeeded", "failed", "cancelled"].includes(t.state))
      this.db
        .prepare(
          "INSERT OR IGNORE INTO outbox(id,task,owner,event) VALUES(?,?,?,?)",
        )
        .run(`${t.id}:${t.state}`, t.id, t.owner, t.state);
    return t;
  }
  raw(id) {
    const t = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id);
    if (!t) throw new Error("not_found");
    return t;
  }
  get(p, { id }) {
    this.principal(p, "get");
    const t = this.raw(id);
    if (t.owner !== p.subject && t.destination !== p.worker)
      throw new Error("forbidden");
    return t;
  }
  submit(p, a) {
    this.principal(p, "submit");
    if (
      a.task_type !== "connectivity_check" ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(a.request_key) ||
      Object.keys(a).some((k) => !["task_type", "request_key"].includes(k)) ||
      p.destination !== "hermes"
    )
      throw new Error("invalid_request");
    return this.tx(() => {
      const old = this.db
        .prepare("SELECT * FROM tasks WHERE owner=? AND request_key=?")
        .get(p.subject, a.request_key);
      if (old) return old;
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO tasks(id,owner,destination,request_key,state) VALUES(?,?,?,?,'queued')",
        )
        .run(id, p.subject, p.destination, a.request_key);
      return this.record(this.raw(id), p);
    });
  }
  claim(p, a = {}) {
    this.principal(p, "claim");
    if (p.worker !== "hermes" || Object.keys(a).length)
      throw new Error("forbidden");
    return this.tx(() => {
      // Expired work requires run reconciliation; it must never be blindly rerun.
      for (const t of this.db
        .prepare("SELECT * FROM tasks WHERE state='running' AND lease<=?")
        .all(this.now())) {
        this.db
          .prepare(
            "UPDATE tasks SET state='waiting_approval',fence=fence+1,lease=NULL WHERE id=?",
          )
          .run(t.id);
        this.record(this.raw(t.id), p);
      }
      if (
        this.db
          .prepare(
            "SELECT id FROM tasks WHERE destination=? AND execution_open=1",
          )
          .get(p.worker)
      )
        return null;
      const t = this.db
        .prepare(
          "SELECT * FROM tasks WHERE destination=? AND state='queued' ORDER BY rowid LIMIT 1",
        )
        .get(p.worker);
      if (!t) return null;
      this.db
        .prepare(
          "UPDATE tasks SET state='running',execution_open=1,fence=fence+1,lease=? WHERE id=?",
        )
        .run(this.now() + 30000, t.id);
      return this.record(this.raw(t.id), p);
    });
  }
  worker(p, a, op, fn) {
    this.principal(p, op);
    return this.tx(() => {
      const t = this.raw(a.id);
      if (
        t.destination !== p.worker ||
        t.fence !== a.fence ||
        t.state !== "running" ||
        t.lease <= this.now()
      )
        throw new Error("stale_lease");
      return fn(t);
    });
  }
  heartbeat(p, a) {
    return this.worker(p, a, "heartbeat", (t) => {
      if (a.run_id && t.run_id && a.run_id !== t.run_id)
        throw new Error("run_conflict");
      this.db
        .prepare(
          "UPDATE tasks SET lease=?,run_id=COALESCE(run_id,?) WHERE id=?",
        )
        .run(this.now() + 30000, a.run_id ?? null, t.id);
      return this.raw(t.id);
    });
  }
  complete(p, a) {
    this.principal(p, "complete");
    const old = this.raw(a.id);
    if (
      old.destination === p.worker &&
      old.fence === a.fence &&
      old.state === a.state &&
      old.result === a.result &&
      ["succeeded", "failed"].includes(old.state)
    )
      return old;
    return this.worker(p, a, "complete", (t) => {
      if (
        !["succeeded", "failed"].includes(a.state) ||
        (a.state === "succeeded"
          ? a.result !== RESPONSE
          : a.result !== "connectivity_check_failed")
      )
        throw new Error("invalid_result");
      this.db
        .prepare(
          "UPDATE tasks SET state=?,result=?,lease=NULL,execution_open=0 WHERE id=?",
        )
        .run(a.state, a.result, t.id);
      return this.record(this.raw(t.id), p);
    });
  }
  cancel(p, a) {
    this.principal(p, "cancel");
    return this.tx(() => {
      const t = this.raw(a.id);
      if (t.owner !== p.subject) throw new Error("forbidden");
      if (["succeeded", "failed", "cancelled"].includes(t.state)) return t;
      this.db
        .prepare(
          "UPDATE tasks SET state='cancelled',fence=fence+1,lease=NULL WHERE id=?",
        )
        .run(t.id);
      return this.record(this.raw(t.id), p);
    });
  }
  pending(p) {
    this.principal(p, "events");
    return this.db
      .prepare("SELECT * FROM outbox WHERE owner=? AND delivered=0")
      .all(p.subject);
  }
  ack(p, id) {
    this.principal(p, "events");
    this.db
      .prepare("UPDATE outbox SET delivered=1 WHERE id=? AND owner=?")
      .run(id, p.subject);
  }
  close() {
    this.db.close();
  }
}
