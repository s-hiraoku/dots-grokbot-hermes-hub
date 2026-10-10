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
    runner_scope: text(),
    runner_subject: text(),
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
export const taskAccess = sqliteTable(
  "task_access",
  {
    id: text().primaryKey(),
    task: text().notNull(),
    subject: text().notNull(),
    notify: integer().notNull(),
    actor: text().notNull(),
    at: integer().notNull(),
  },
  (t) => [
    uniqueIndex("task_reader").on(t.task, t.subject),
    check("notify_boolean", sql`${t.notify} IN (0,1)`),
  ],
);
export const accessAudit = sqliteTable("access_audit", {
  seq: integer().primaryKey({ autoIncrement: true }),
  task: text().notNull(),
  subject: text().notNull(),
  actor: text().notNull(),
  action: text().notNull(),
  at: integer().notNull(),
});
export const subscriptions = sqliteTable("subscriptions", {
  id: text().primaryKey(),
  subject: text().notNull(),
  task: text().notNull(),
  url: text().notNull(),
  secret_ref: text().notNull(),
  previous_secret_ref: text(),
  rotation_until: integer().notNull().default(0),
  revision: integer().notNull(),
  expires: integer().notNull(),
  active: integer().notNull().default(0),
  verified_until: integer().notNull().default(0),
  at: integer().notNull(),
});
export const deliveries = sqliteTable(
  "deliveries",
  {
    id: text().primaryKey(),
    subscription: text().notNull(),
    event: text().notNull(),
    state: text().notNull(),
    fence: integer().notNull().default(0),
    lease: integer(),
    attempts: integer().notNull().default(0),
    retry_at: integer().notNull().default(0),
    revision: integer().notNull(),
    at: integer().notNull(),
  },
  (t) => [
    uniqueIndex("subscription_event").on(t.subscription, t.event),
    check(
      "delivery_state",
      sql`${t.state} IN ('pending','running','delivered','dead')`,
    ),
  ],
);
