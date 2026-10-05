import {
  RESPONSE,
  type Driver,
  type Principal,
  type Task,
  type Lease,
  type Statement,
  type Outbox,
  type Row,
  type Operation,
} from "./types.ts";
const stmt = (
  sql: string,
  ...params: (string | number | null)[]
): Statement => ({ sql, params });
export class TaskService {
  readonly driver: Driver;
  now: () => number;
  readonly leaseMs: number;
  constructor(
    driver: Driver,
    now: () => number = () => Date.now(),
    leaseMs = 30000,
  ) {
    this.driver = driver;
    this.now = now;
    this.leaseMs = leaseMs;
  }
  principal(p: Principal, op: Operation) {
    if (!p?.subject || !p.operations?.includes(op))
      throw new Error("forbidden");
  }
  row(rows: Row[]): Task {
    if (!rows[0]) throw new Error("operation_rejected");
    return rows[0] as unknown as Task;
  }
  async get(p: Principal, a: { id: string }) {
    this.principal(p, "get");
    const r = await this.driver.batch([
      stmt(
        "SELECT * FROM tasks WHERE id=? AND (owner=? OR destination=?)",
        a.id,
        p.subject,
        p.worker ?? "",
      ),
    ]);
    return this.row(r[0]);
  }
  async submit(p: Principal, a: { task_type: string; request_key: string }) {
    this.principal(p, "submit");
    if (
      a.task_type !== "connectivity_check" ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(a.request_key) ||
      p.destination !== "hermes" ||
      Object.keys(a).some((k) => !["task_type", "request_key"].includes(k))
    )
      throw new Error("invalid_request");
    const r = await this.driver.batch([
      stmt(
        "INSERT OR IGNORE INTO tasks(id,owner,destination,request_key,state,actor,at,mutation) VALUES(?,?,?,?,'queued',?,?,?)",
        crypto.randomUUID(),
        p.subject,
        p.destination,
        a.request_key,
        p.subject,
        this.now(),
        crypto.randomUUID(),
      ),
      stmt(
        "SELECT * FROM tasks WHERE owner=? AND request_key=?",
        p.subject,
        a.request_key,
      ),
    ]);
    return this.row(r[1]);
  }
  async claim(p: Principal, a: Record<string, never> = {}) {
    this.principal(p, "claim");
    if (p.worker !== "hermes" || Object.keys(a).length)
      throw new Error("forbidden");
    const clock = this.driver.nowSQL;
    const mutation = crypto.randomUUID();
    const r = await this.driver.batch([
      stmt(
        `UPDATE tasks SET state='waiting_approval',fence=fence+1,lease=NULL,actor=?,at=${clock},mutation=? WHERE destination=? AND state='running' AND lease<=${clock}`,
        p.subject,
        crypto.randomUUID(),
        p.worker,
      ),
      stmt(
        `UPDATE tasks SET state='running',execution_open=1,fence=fence+1,lease=${clock}+?,actor=?,at=${clock},mutation=? WHERE id=(SELECT id FROM tasks WHERE destination=? AND state='queued' ORDER BY at,rowid LIMIT 1) AND NOT EXISTS(SELECT 1 FROM tasks WHERE destination=? AND execution_open=1)`,
        this.leaseMs,
        p.subject,
        mutation,
        p.worker,
        p.worker,
      ),
      stmt("SELECT * FROM tasks WHERE mutation=?", mutation),
    ]);
    return r[2][0] ? this.row(r[2]) : null;
  }
  async heartbeat(p: Principal, a: Lease & { run_id?: string }) {
    this.principal(p, "heartbeat");
    const clock = this.driver.nowSQL;
    const mutation = crypto.randomUUID();
    const r = await this.driver.batch([
      stmt(
        `UPDATE tasks SET lease=${clock}+?,run_id=COALESCE(run_id,?),actor=?,at=${clock},mutation=? WHERE id=? AND destination=? AND fence=? AND state='running' AND lease>${clock} AND (? IS NULL OR run_id IS NULL OR run_id=?)`,
        this.leaseMs,
        a.run_id ?? null,
        p.subject,
        mutation,
        a.id,
        p.worker ?? "",
        a.fence,
        a.run_id ?? null,
        a.run_id ?? null,
      ),
      stmt("SELECT * FROM tasks WHERE mutation=?", mutation),
    ]);
    return this.row(r[1]);
  }
  async complete(
    p: Principal,
    a: Lease & { state: "succeeded" | "failed"; result: string },
  ) {
    this.principal(p, "complete");
    if (
      !["succeeded", "failed"].includes(a.state) ||
      (a.state === "succeeded"
        ? a.result !== RESPONSE
        : a.result !== "connectivity_check_failed")
    )
      throw new Error("invalid_result");
    const clock = this.driver.nowSQL;
    const r = await this.driver.batch([
      stmt(
        `UPDATE tasks SET state=?,result=?,lease=NULL,execution_open=0,actor=?,at=${clock},mutation=? WHERE id=? AND destination=? AND fence=? AND state='running' AND lease>${clock}`,
        a.state,
        a.result,
        p.subject,
        crypto.randomUUID(),
        a.id,
        p.worker ?? "",
        a.fence,
      ),
      stmt(
        "SELECT * FROM tasks WHERE id=? AND destination=? AND fence=? AND state=? AND result=?",
        a.id,
        p.worker ?? "",
        a.fence,
        a.state,
        a.result,
      ),
    ]);
    return this.row(r[1]);
  }
  async cancel(p: Principal, a: { id: string }) {
    this.principal(p, "cancel");
    const r = await this.driver.batch([
      stmt(
        "UPDATE tasks SET state='cancelled',fence=fence+1,lease=NULL,actor=?,at=?,mutation=? WHERE id=? AND owner=? AND state NOT IN ('succeeded','failed','cancelled')",
        p.subject,
        this.now(),
        crypto.randomUUID(),
        a.id,
        p.subject,
      ),
      stmt("SELECT * FROM tasks WHERE id=? AND owner=?", a.id, p.subject),
    ]);
    return this.row(r[1]);
  }
  async pending(p: Principal) {
    this.principal(p, "events");
    const r = await this.driver.batch([
      stmt(
        "SELECT * FROM outbox WHERE owner=? AND delivered=0 ORDER BY at,id",
        p.subject,
      ),
    ]);
    return r[0] as unknown as Outbox[];
  }
  async ack(p: Principal, id: string) {
    this.principal(p, "events");
    await this.driver.batch([
      stmt(
        "UPDATE outbox SET delivered=1 WHERE id=? AND owner=?",
        id,
        p.subject,
      ),
    ]);
  }
}
