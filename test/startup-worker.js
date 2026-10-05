import { parentPort, workerData } from "node:worker_threads";
import { Hub } from "../src/sqlite.ts";
parentPort.postMessage("ready");
parentPort.once("message", () => {
  const hub = new Hub(workerData.path);
  hub.close();
  parentPort.postMessage("opened");
});
