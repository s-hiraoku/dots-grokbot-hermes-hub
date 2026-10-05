import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
export const tasks = sqliteTable(
  "tasks",
  {
    id: text().primaryKey(),
    owner: text().notNull(),
    destination: text().notNull(),
    request_key: text().notNull(),
    task_type: text().notNull().default("connectivity_check"),
    state: text().notNull(),
    execution_open: integer().notNull().default(0),
    fence: integer().notNull().default(0),
    lease: integer(),
    run_id: text(),
    result: text(),
    actor: text().notNull(),
    at: integer().notNull(),
    mutation: text().notNull(),
  },
  (t) => [
    uniqueIndex("request_idempotency").on(t.owner, t.request_key),
    uniqueIndex("single_execution")
      .on(t.destination)
      .where(sql`${t.execution_open}=1`),
    index("queue_order").on(t.destination, t.state, t.at),
    check(
      "valid_state",
      sql`${t.state} IN ('queued','running','waiting_approval','succeeded','failed','cancelled')`,
    ),
    check("fixed_task_type", sql`${t.task_type}='connectivity_check'`),
    check("valid_gate", sql`${t.execution_open} IN (0,1)`),
  ],
);
export const audit = sqliteTable("audit", {
  seq: integer().primaryKey({ autoIncrement: true }),
  task: text().notNull(),
  actor: text().notNull(),
  state: text().notNull(),
  fence: integer().notNull(),
  at: integer().notNull(),
});
export const outbox = sqliteTable("outbox", {
  id: text().primaryKey(),
  task: text().notNull(),
  owner: text().notNull(),
  event: text().notNull(),
  at: integer().notNull(),
  delivered: integer().notNull().default(0),
});
