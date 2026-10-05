export type State =
  | "queued"
  | "running"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled";
export type Operation =
  "submit" | "claim" | "heartbeat" | "complete" | "get" | "cancel" | "events";
/** Only a trusted identity verifier constructs this value. */
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
export interface Run {
  id: string;
  state: "running" | "succeeded" | "failed";
  text?: string;
}
export interface IsolatedRuns {
  readonly toolIsolationVerified: boolean;
  create(input: {
    idempotencyKey: string;
    prompt: "Agent Hub connectivity check completed.";
    tools: readonly never[];
  }): Promise<Run>;
  get(id: string): Promise<Run>;
}
