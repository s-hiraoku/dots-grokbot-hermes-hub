import { parentPort, workerData } from "node:worker_threads";
import { Hub } from "../src/sqlite.ts";
const h = new Hub(workerData.path);
parentPort.postMessage("ready");
parentPort.once("message", async () => {
  try {
    parentPort.postMessage(await h.claim(workerData.principal, {}));
  } finally {
    h.close();
  }
});
