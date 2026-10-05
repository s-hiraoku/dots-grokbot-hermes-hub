import { test, mock } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { connectHTTPS } from "../src/callback-transport.ts";
for (const status of [410, 413, 301, 302, 307, 308])
  test(`oversized ${status} body retains permanent HTTP status`, async () => {
    let destroyed = false;
    const res = new EventEmitter();
    res.statusCode = status;
    res.destroy = () => {
      destroyed = true;
    };
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.destroy = (error) => req.emit("error", error);
    req.end = () => {
      Promise.resolve().then(() => {
        callback(res);
        if (!destroyed) {
          res.emit("data", Buffer.alloc(20000));
          res.emit("end");
        }
        req.emit("close");
      });
    };
    let callback;
    const replacement = mock.method(https, "request", (_url, _options, cb) => {
      callback = cb;
      return req;
    });
    syncBuiltinESMExports();
    try {
      assert.deepEqual(
        await connectHTTPS({
          url: new URL("https://callback.example/hook"),
          address: "8.8.8.8",
          family: 4,
          headers: {},
          body: "fixture",
        }),
        { status, body: "" },
      );
      assert.equal(destroyed, true);
    } finally {
      replacement.mock.restore();
      syncBuiltinESMExports();
    }
  });
