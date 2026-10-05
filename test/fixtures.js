import { Hub } from "../src/sqlite.ts";
import { RESPONSE } from "../src/types.ts";
export { Hub, RESPONSE };
export const owner = {
  subject: "fixture-owner",
  destination: "hermes",
  operations: ["submit", "get", "cancel", "events"],
};
export const worker = {
  subject: "fixture-worker",
  worker: "hermes",
  operations: ["claim", "get", "heartbeat", "complete"],
};
export const submit = (h, key = "check-1") =>
  h.submit(owner, { task_type: "connectivity_check", request_key: key });
export const finish = (h, t) =>
  h.complete(worker, {
    id: t.id,
    fence: t.fence,
    state: "succeeded",
    result: RESPONSE,
  });
export const journal = () => ({
  entry: null,
  load() {
    return this.entry;
  },
  save(e) {
    this.entry = structuredClone(e);
  },
  clear() {
    this.entry = null;
  },
});
export const delay = (ms) => new Promise((r) => setTimeout(r, ms));
