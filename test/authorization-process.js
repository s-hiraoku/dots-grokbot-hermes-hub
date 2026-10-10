import process from "node:process";
import { Hub } from "../src/sqlite.ts";
import { owner } from "./fixtures.js";
const h = new Hub(process.argv[2]);
const p = await h.authorization.bind({ ...owner, clientId: "process-client" });
process.send({ ready: true });
process.once("message", async () => {
  try {
    await h.submit(p, {
      task_type: "connectivity_check",
      request_key: "old-process-request",
    });
    process.send({ rejected: false });
  } catch (error) {
    process.send({
      rejected: error.message.includes("authorization_rejected"),
    });
  } finally {
    h.close();
    process.disconnect();
  }
});
