export const RESPONSE = "Agent Hub connectivity check completed.";
export type State =
  | "queued"
  | "running"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled";
export type Operation =
  "submit" | "claim" | "heartbeat" | "complete" | "get" | "cancel" | "events";
export interface Principal {
  subject: string;
  operations: readonly Operation[];
  destination?: "hermes";
  worker?: "hermes";
}
export interface Lease {
  id: string;
  fence: number;
}
export interface Task extends Lease {
  owner: string;
  destination: string;
  request_key: string;
  state: State;
  lease: number | null;
  run_id: string | null;
  result: string | null;
  execution_open: number;
  at: number;
}
export interface Receipt extends Lease {
  key: string;
  run_id: string | null;
  admitted_at: number;
  runner_scope?: string;
}
export interface Run {
  id: string;
  state: "running" | "succeeded" | "failed" | "cancelled";
  text?: string;
}
export interface Runs {
  readonly boundaryId?: string;
  readonly toolIsolationVerified: boolean;
  readonly durableIdempotency: boolean;
  readonly retentionMs: number;
  create(input: {
    idempotencyKey: string;
    prompt: string;
    tools: never[];
    signal?: AbortSignal;
  }): Promise<Run>;
  get(id: string, signal?: AbortSignal): Promise<Run>;
}
export interface JournalStore {
  load(): Receipt | null;
  save(entry: Receipt): void;
  clear(): void;
}
export interface HubClient {
  claim(p: Principal, a: Record<string, never>): Promise<Task | null>;
  get(p: Principal, a: { id: string }): Promise<Task>;
  heartbeat(p: Principal, a: Lease & { run_id?: string }): Promise<Task>;
  complete(
    p: Principal,
    a: Lease & { state: "succeeded" | "failed"; result: string },
  ): Promise<Task>;
}
export type SQLValue = string | number | null;
export interface Statement {
  sql: string;
  params?: SQLValue[];
}
export type Row = Record<string, SQLValue>;
export interface Driver {
  readonly nowSQL: string;
  batch(statements: Statement[]): Promise<Row[][]>;
}
export interface Outbox {
  id: string;
  task: string;
  owner: string;
  event: string;
  at: number;
  delivered: number;
}
