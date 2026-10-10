// Test-only preload: fail before any forbidden bootstrap side effect and record
// aggregate counters. No credentials, request bodies or runtime values are logged.
import sqlite from "node:sqlite";
import crypto from "node:crypto";
import childProcess from "node:child_process";
import process from "node:process";
import { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const counts = { sqlite: 0, randomBytes: 0, spawn: 0, outboundFetch: 0 };
const refuse = (name) => () => {
  counts[name]++;
  throw Error("bootstrap_forbidden_effect");
};
sqlite.DatabaseSync = new Proxy(sqlite.DatabaseSync, {
  construct: refuse("sqlite"),
});
crypto.randomBytes = refuse("randomBytes");
childProcess.spawn = refuse("spawn");
syncBuiltinESMExports();
globalThis.fetch = refuse("outboundFetch");
process.once("exit", () =>
  writeFileSync(
    process.env.HAB_BOOTSTRAP_TEST_RECEIPT,
    JSON.stringify(counts),
    { mode: 0o600 },
  ),
);
