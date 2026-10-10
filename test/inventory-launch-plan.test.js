import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { InventoryLaunchPlan } from "../src/inventory-launch-plan.ts";
import { InventoryInspector } from "../src/inventory-inspector.ts";
import { LocalHermesKey } from "../src/local-hermes-key.ts";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const syntheticKey = "07".repeat(32);
const reviewed = () => ({
  manifestPath:
    "/reviewed/home/.hermes/profiles/hub-inventory-once/inventory-manifest.json",
  endpoint: "http://127.0.0.1:8645/",
  namespaceLabel: "reviewed-generation",
  profileRoot: "/reviewed/home/.hermes/profiles/hub-inventory-once",
  sourceRoot: "/reviewed/source",
  dependencyRoot: "/reviewed/dependencies",
  pythonIsolation: "isolated-no-site-v1",
  wrapperPath: "/reviewed/bridge/serve_inventory.py",
  pythonPath: "/reviewed/python",
  codeTrees: [
    { root: "/reviewed/source", sha256: "a".repeat(64) },
    { root: "/reviewed/bridge", sha256: "b".repeat(64) },
    { root: "/reviewed/python", sha256: "c".repeat(64), systemRuntime: true },
    {
      root: "/reviewed/dependencies",
      sha256: "d".repeat(64),
      fixedDependencies: true,
    },
  ],
  pythonSHA256: "e".repeat(64),
  wrapperSHA256: "f".repeat(64),
  configSHA256: "0".repeat(64),
  sourceCommit: "f97608f178d1ffeca59860195ab7da295f7c8e5f",
  storeRelativePath: "runs_idempotency.db",
});
const metadata = () => ({
  credential: { dev: 1, ino: 2, size: 65, mtimeMs: 100, ctimeMs: 100 },
  store: { dev: 1, ino: 3 },
  evidenceStore: { dev: 1, ino: 4 },
});

test("offline plan emits exact Python manifest, scope hashes and unmodified reviewed pins", () => {
  const pins = reviewed();
  const plan = new InventoryLaunchPlan(pins, sha(syntheticKey));
  const artifacts = plan.artifacts();
  const manifest = JSON.parse(artifacts.manifestBytes);
  assert.equal(artifacts.manifestSHA256, sha(artifacts.manifestBytes));
  assert.equal(artifacts.scopeSHA256, sha(artifacts.scopeBytes));
  assert.equal(manifest.apiKeyDigest, sha(syntheticKey));
  assert.equal(manifest.maxTasks, 1);
  assert.equal(manifest.concurrency, 1);
  assert.deepEqual(manifest.tools, ["hub_shift_log_inventory"]);
  assert.equal(manifest.memory, false);
  assert.equal(manifest.fallback, false);
  assert.deepEqual(manifest.codeTrees, pins.codeTrees);
  assert.equal(JSON.stringify(artifacts).includes(syntheticKey), false);
  const policy = plan.policy(metadata());
  assert.equal(policy.manifestSHA256, artifacts.manifestSHA256);
  assert.equal(policy.credentialSHA256, artifacts.scopeSHA256);
  assert.deepEqual(policy.credential, metadata().credential);
  assert.ok(new InventoryInspector(policy).scopeId.startsWith("inventory-"));
  const python = spawnSync(
    "python3",
    [
      "-I",
      "-S",
      "-c",
      "import json,sys,importlib.util; from pathlib import Path; spec=importlib.util.spec_from_file_location('launch_contract', Path.cwd()/'hermes_bridge/serve_inventory.py'); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module); validate_manifest=module.validate_manifest; x=json.load(sys.stdin); validate_manifest(x['manifest'], profile=Path(x['profile']), wrapper=Path(x['wrapper']), python=Path(x['python']), credential_digest=x['fingerprint']); print('manifest-contract-ok')",
    ],
    {
      input: JSON.stringify({
        manifest,
        profile: pins.profileRoot,
        wrapper: pins.wrapperPath,
        python: pins.pythonPath,
        fingerprint: sha(syntheticKey),
      }),
      encoding: "utf8",
      timeout: 5000,
    },
  );
  assert.equal(python.status, 0, python.stderr);
  assert.equal(python.stdout.trim(), "manifest-contract-ok");
});
test("runtime envelope binds only matching key and approved exact executable, args and environment", () => {
  const plan = new InventoryLaunchPlan(reviewed(), sha(syntheticKey));
  const launch = plan.launch(syntheticKey);
  assert.equal(launch.executable, reviewed().pythonPath);
  assert.deepEqual(launch.args, ["-I", "-S", reviewed().wrapperPath]);
  assert.equal(JSON.stringify(launch.args).includes(syntheticKey), false);
  assert.deepEqual(
    Object.keys(launch.env).sort(),
    [
      "API_SERVER_KEY",
      "HUB_INVENTORY_MANIFEST_SHA256",
      "PATH",
      "PYTHONDONTWRITEBYTECODE",
    ].sort(),
  );
  assert.equal(launch.env.API_SERVER_KEY, syntheticKey);
  assert.equal(
    launch.env.HUB_INVENTORY_MANIFEST_SHA256,
    plan.artifacts().manifestSHA256,
  );
  for (const key of ["08".repeat(32), "short", syntheticKey + "\n"])
    assert.throws(
      () => plan.launch(key),
      /inventory_runtime_key_binding_rejected/,
    );
});
test("plan denies endpoint, closure, import, path and caller-injected model/tool/secret widening", () => {
  for (const mutate of [
    (p) => (p.endpoint = "http://127.0.0.1:9120/"),
    (p) => (p.endpoint = "https://remote.example/"),
    (p) => (p.profileRoot = "/reviewed/broad-desktop"),
    (p) => (p.manifestPath = "/other/manifest.json"),
    (p) => (p.storeRelativePath = "other.db"),
    (p) => (p.wrapperPath = "/reviewed/bridge/other.py"),
    (p) => (p.codeTrees = p.codeTrees.slice(0, 2)),
    (p) => (p.pythonIsolation = "isolated"),
    (p) => (p.dependencyRoot = "/reviewed/source/site-packages"),
    (p) => (p.apiKey = syntheticKey),
    (p) => (p.model = "unapproved"),
    (p) => (p.tools = ["shell"]),
  ]) {
    const pins = reviewed();
    mutate(pins);
    assert.throws(() => new InventoryLaunchPlan(pins, sha(syntheticKey)), {
      message: "inventory_launch_plan_rejected",
    });
  }
  assert.throws(() => new InventoryLaunchPlan(reviewed(), "not-a-digest"));
});
test("runtime metadata rejects drift and namespace changes on replacement; source mutation cannot refresh pins", () => {
  const pins = reviewed();
  const plan = new InventoryLaunchPlan(pins, sha(syntheticKey));
  const before = plan.artifacts().manifestSHA256;
  pins.codeTrees[0].sha256 = "9".repeat(64);
  assert.equal(plan.artifacts().manifestSHA256, before);
  const policy = plan.policy(metadata());
  policy.codeTrees[0].sha256 = "8".repeat(64);
  assert.equal(plan.policy(metadata()).codeTrees[0].sha256, "a".repeat(64));
  const replacement = metadata();
  replacement.store.ino++;
  assert.notEqual(
    new InventoryInspector(plan.policy(metadata())).scopeId,
    new InventoryInspector(plan.policy(replacement)).scopeId,
  );
  for (const mutate of [
    (m) => (m.credential.size = 64),
    (m) => (m.credential.apiKey = syntheticKey),
    (m) => delete m.evidenceStore,
    (m) => (m.store.ino = -1),
  ]) {
    const m = metadata();
    mutate(m);
    assert.throws(() => plan.policy(m), /inventory_runtime_metadata_rejected/);
  }
});
test("existing key lifecycle composes asynchronous nonsecret preparation before trusted launch and adapter", async () => {
  const provisioner = new LocalHermesKey();
  const order = [];
  const records = [];
  let plan;
  let policy;
  let stopped = 0;
  await provisioner.provision({
    ttlMs: 120000,
    entropy: () => Buffer.alloc(32, 7),
    persist: async (record) => {
      if (record.state === "issued") {
        plan = new InventoryLaunchPlan(reviewed(), record.fingerprint);
        // Stand-in for future private artifact persistence + stat, never actual writes.
        policy = plan.policy(metadata());
        order.push("prepared");
      }
      records.push(record);
    },
    launch: (key) => {
      assert.equal(
        plan.launch(key).env.HUB_INVENTORY_MANIFEST_SHA256,
        policy.manifestSHA256,
      );
      order.push("launch");
      return {
        stop: async () => {
          stopped++;
        },
      };
    },
    adapter: (key, fingerprint) => {
      assert.equal(sha(key), fingerprint);
      assert.equal(plan.launch(key).env.API_SERVER_KEY, key);
      order.push("adapter");
      return {
        stop: async () => {
          stopped++;
        },
      };
    },
  });
  assert.deepEqual(order, ["prepared", "launch", "adapter"]);
  await provisioner.close();
  assert.equal(stopped, 2);
  assert.equal(records[1].state, "revoked");
  assert.equal(JSON.stringify(records).includes(syntheticKey), false);
});
