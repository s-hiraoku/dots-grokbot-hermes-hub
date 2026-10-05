import { RESPONSE } from "./hub.js";
function heartbeatPayload(entry) {
  return {
    id: entry.id,
    fence: entry.fence,
    ...(entry.run_id ? { run_id: entry.run_id } : {}),
  };
}
// Outbound-only core; client and run service are configured by trusted code, never task data.
export class Adapter {
  constructor(hub, principal, runs, journal) {
    Object.assign(this, { hub, principal, runs, journal });
  }
  async once() {
    if (!this.runs.toolIsolationVerified)
      throw new Error("tool_isolation_unverified");
    // A durable journal is committed before admission. Stable idempotency keys reconcile unknown outcomes.
    let entry = this.journal.load();
    if (!entry) {
      const task = await this.hub.claim(this.principal, {});
      if (!task) return null;
      entry = {
        id: task.id,
        fence: task.fence,
        key: `hub-${task.id}`,
        run_id: task.run_id,
      };
      this.journal.save(entry);
    }
    const task = await this.hub.get(this.principal, { id: entry.id });
    if (["succeeded", "failed", "cancelled"].includes(task.state)) {
      this.journal.clear();
      return task.id;
    }
    if (task.state !== "running" || task.fence !== entry.fence)
      throw new Error("reconciliation_requires_approval");
    await this.hub.heartbeat(this.principal, heartbeatPayload(entry));
    const run = entry.run_id
      ? await this.runs.get(entry.run_id)
      : await this.runs.create({
          idempotencyKey: entry.key,
          prompt: RESPONSE,
          tools: [],
        });
    entry.run_id = run.id;
    this.journal.save(entry);
    await this.hub.heartbeat(this.principal, heartbeatPayload(entry));
    if (run.state === "running") return task.id;
    const success = run.state === "succeeded" && run.text === RESPONSE;
    await this.hub.complete(this.principal, {
      id: entry.id,
      fence: entry.fence,
      state: success ? "succeeded" : "failed",
      result: success ? RESPONSE : "connectivity_check_failed",
    });
    this.journal.clear();
    return task.id;
  }
}
export class MockRuns {
  toolIsolationVerified = true;
  constructor() {
    this.byKey = new Map();
    this.calls = 0;
  }
  async create(a) {
    if (a.tools.length || a.prompt !== RESPONSE) throw new Error("unsafe");
    if (this.byKey.has(a.idempotencyKey))
      return this.byKey.get(a.idempotencyKey);
    this.calls++;
    const r = { id: `mock-${this.calls}`, state: "succeeded", text: RESPONSE };
    this.byKey.set(a.idempotencyKey, r);
    return r;
  }
  async get(id) {
    return [...this.byKey.values()].find((r) => r.id === id);
  }
}
// Exactly-once effects require the receiving sink to deduplicate this stable event ID.
export async function drainOutbox(hub, p, sink) {
  for (const event of hub.pending(p)) {
    await sink.send(event.id, { task_id: event.task, state: event.event });
    hub.ack(p, event.id);
  }
}
