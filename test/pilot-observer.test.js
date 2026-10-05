import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

test("default observer requests numeric listeners and parses fixed read-only probe output", async () => {
  const calls = [];
  const original = childProcess.execFile;
  childProcess.execFile = (file, args, opts, callback) => {
    calls.push({ file, args, opts });
    const stdout = file.endsWith("lsof")
      ? "p12345\nf8\nn127.0.0.1:8643\n"
      : file.endsWith("git")
        ? "f97608f178d1ffeca59860195ab7da295f7c8e5f\n"
        : args.includes("uid=")
          ? "501\n"
          : args.includes("lstart=")
            ? "Mon Oct 5 10:00:00 2026\n"
            : "/approved/python /approved/serve-fixed.py\n";
    callback(null, { stdout, stderr: "" });
  };
  syncBuiltinESMExports();
  try {
    const { observePilot } = await import("../src/pilot-inspector.ts");
    const observed = await observePilot(12345, "/approved/source");
    assert.deepEqual(observed.listeners, ["127.0.0.1:8643"]);
    assert.equal(observed.uid, 501);
    assert.equal(observed.startedAt, Date.parse("2026-10-05T10:00:00Z"));
    assert.equal(observed.command, "/approved/python /approved/serve-fixed.py");
    assert.equal(
      observed.sourceCommit,
      "f97608f178d1ffeca59860195ab7da295f7c8e5f",
    );
    assert.deepEqual(calls.find((c) => c.file.endsWith("lsof")).args, [
      "-n",
      "-P",
      "-a",
      "-p",
      "12345",
      "-iTCP",
      "-sTCP:LISTEN",
      "-Fn",
    ]);
    assert.equal(calls.length, 5);
    for (const { opts } of calls) {
      assert.equal(opts.timeout, 1500);
      assert.equal(opts.env.LC_ALL, "C");
      assert.equal(opts.env.TZ, "UTC");
      assert.equal(opts.env.GIT_CONFIG_NOSYSTEM, "1");
    }
  } finally {
    childProcess.execFile = original;
    syncBuiltinESMExports();
  }
});
