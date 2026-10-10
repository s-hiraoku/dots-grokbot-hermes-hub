import {
  mkdtemp,
  mkdir,
  writeFile,
  lstat,
  realpath,
  rm,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import process from "node:process";
import {
  InventoryInspector,
  measureCodeTree,
} from "../src/inventory-inspector.ts";
import { HERMES_COMMIT } from "../src/hermes-runs.ts";
export async function inventoryPolicyFixture(endpoint) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hub-inspector-")));
  const profileRoot = join(root, "profile"),
    sourceRoot = join(root, "source"),
    wrapperPath = join(sourceRoot, "reviewed-guard.py");
  await mkdir(profileRoot, { mode: 0o700 });
  await mkdir(sourceRoot, { mode: 0o700 });
  // Non-executable public dummy policy/files; process observation is injected, never launched.
  const guard = "fixture reviewed guard";
  const config = "fixture reviewed nonsecret config";
  await writeFile(wrapperPath, guard, { mode: 0o600 });
  await writeFile(join(profileRoot, "config.yaml"), config, { mode: 0o600 });
  await writeFile(join(profileRoot, "credential.scope"), "a".repeat(64), {
    mode: 0o600,
  });
  await writeFile(
    join(profileRoot, "runs_idempotency.db"),
    "fixture store identity only",
    { mode: 0o600 },
  );
  await writeFile(join(profileRoot, "inventory.pid"), "12345\n", {
    mode: 0o600,
  });
  await writeFile(
    join(profileRoot, "inventory-evidence.sqlite"),
    "fixture evidence identity",
    { mode: 0o600 },
  );
  const evidenceStore = await lstat(
    join(profileRoot, "inventory-evidence.sqlite"),
  );
  const pythonPath = join(sourceRoot, "python");
  const python = "fixture interpreter";
  await writeFile(pythonPath, python, { mode: 0o600 });
  await writeFile(join(sourceRoot, "agent.py"), "fixture reviewed agent", {
    mode: 0o600,
  });
  await chmod(wrapperPath, 0o400);
  await chmod(pythonPath, 0o400);
  await chmod(join(sourceRoot, "agent.py"), 0o400);
  await chmod(sourceRoot, 0o500);
  const key = await lstat(join(profileRoot, "credential.scope"));
  const store = await lstat(join(profileRoot, "runs_idempotency.db"));
  const sha = (text) => createHash("sha256").update(text).digest("hex");
  const policy = {
    manifestPath: join(profileRoot, "inventory-manifest.json"),
    manifestSHA256: "0".repeat(64),
    credentialSHA256: sha("a".repeat(64)),
    endpoint,
    namespaceLabel: "fixture-pilot-generation",
    profileRoot,
    sourceRoot,
    wrapperPath,
    pythonPath,
    pythonSHA256: sha(python),
    codeTrees: [
      {
        root: sourceRoot,
        sha256: await measureCodeTree(sourceRoot),
      },
    ],
    wrapperSHA256: sha(guard),
    configSHA256: sha(config),
    sourceCommit: HERMES_COMMIT,
    credential: {
      dev: key.dev,
      ino: key.ino,
      size: key.size,
      mtimeMs: key.mtimeMs,
      ctimeMs: key.ctimeMs,
    },
    storeRelativePath: "runs_idempotency.db",
    store: { dev: store.dev, ino: store.ino },
    evidenceStore: { dev: evidenceStore.dev, ino: evidenceStore.ino },
  };
  const manifest = {
    contract: "hermes-agent-inventory-v1",
    endpoint,
    profileRoot,
    sourceRoot,
    wrapperPath,
    pythonPath,
    model: "gpt-6.1-sol",
    provider: "openai-codex",
    tools: ["hub_shift_log_inventory"],
    maxIterations: 3,
    maxTokens: 256,
    runBudgetSeconds: 60,
    concurrency: 1,
    evidencePath: join(profileRoot, "inventory-evidence.sqlite"),
    runStorePath: join(profileRoot, "runs_idempotency.db"),
    memory: false,
    history: false,
    fallback: false,
    startup: "manual-one-shot",
    maxTasks: 1,
    apiKeyDigest: "a".repeat(64),
    sourceCommit: policy.sourceCommit,
    codeTrees: policy.codeTrees,
  };
  const manifestBytes = JSON.stringify(manifest);
  policy.manifestSHA256 = sha(manifestBytes);
  await writeFile(policy.manifestPath, manifestBytes, { mode: 0o600 });
  const startedAt = Math.ceil(Date.now() / 1000) * 1000 + 1000;
  let now = startedAt + 1000;
  const observation = {
    pid: 12345,
    uid: process.getuid(),
    startedAt,
    command: `${policy.pythonPath} -I ${wrapperPath}`,
    listeners: [`127.0.0.1:${new URL(endpoint).port}`],
    sourceCommit: HERMES_COMMIT,
  };
  const options = {
    probe: async () => structuredClone(observation),
    now: () => now,
  };
  const inspector = new InventoryInspector(policy, options);
  return {
    root,
    policy,
    manifest,
    observation,
    options,
    inspector,
    now: options.now,
    advance: (ms) => {
      now += ms;
    },
    cleanup: async () => {
      await chmod(sourceRoot, 0o700);
      await rm(root, { recursive: true, force: true });
    },
  };
}
