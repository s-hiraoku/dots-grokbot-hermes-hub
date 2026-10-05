import { createHash } from "node:crypto";
import { lstat, readFile, realpath, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { IsolationEvidence } from "./hermes-runs.ts";
const exec = promisify(execFile);
const digest = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
// Hash every regular file, including ignored archives/custom-loader formats.
// Code roots must be reviewed immutable trees without secrets or runtime data.
// The approved roots must cover the entire reviewed Python import/runtime closure.
export async function measureCodeTree(root: string, before = Infinity) {
  const entries: string[][] = [];
  let count = 0,
    total = 0;
  async function walk(path: string, relative: string) {
    const stat = await lstat(path);
    if (
      ++count > 100000 ||
      stat.isSymbolicLink() ||
      (stat.uid !== 0 && stat.uid !== process.getuid?.()) ||
      stat.mode & 0o222 ||
      stat.ctimeMs > before ||
      (await realpath(path)) !== path
    )
      throw new Error("pilot_code_integrity_rejected");
    if (stat.isDirectory()) {
      entries.push([relative, "directory"]);
      for (const name of (await readdir(path)).sort()) {
        if (name === ".git") continue; // Git metadata must never be part of the import closure.
        if (
          (name.startsWith(".env") && name !== ".env.example") ||
          ["secrets", "runtime", "logs"].includes(name)
        )
          throw new Error("pilot_code_root_contains_private_data");
        const child = join(path, name),
          sub = relative ? `${relative}/${name}` : name;
        await walk(child, sub);
      }
      const after = await lstat(path);
      if (after.ctimeMs !== stat.ctimeMs || after.ino !== stat.ino)
        throw new Error("pilot_code_integrity_rejected");
    } else if (stat.isFile()) {
      total += stat.size;
      if (total > 536870912 || stat.size > 67108864)
        throw new Error("pilot_code_integrity_rejected");
      const bytes = await readFile(path);
      const after = await lstat(path);
      if (after.ctimeMs !== stat.ctimeMs || after.ino !== stat.ino)
        throw new Error("pilot_code_integrity_rejected");
      entries.push([relative, digest(bytes)]);
    } else throw new Error("pilot_code_integrity_rejected");
  }
  await walk(root, "");
  return digest(JSON.stringify(entries));
}
const identity = z
  .object({
    dev: z.number().int().nonnegative(),
    ino: z.number().int().nonnegative(),
  })
  .strict();
const policySchema = z
  .object({
    endpoint: z.string(),
    namespaceLabel: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    profileRoot: z.string(),
    sourceRoot: z.string(),
    wrapperPath: z.string(),
    pythonPath: z.string(),
    codeTrees: z
      .array(
        z
          .object({
            root: z.string(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .min(1),
    pythonSHA256: z.string().regex(/^[a-f0-9]{64}$/),
    wrapperSHA256: z.string().regex(/^[a-f0-9]{64}$/),
    configSHA256: z.string().regex(/^[a-f0-9]{64}$/),
    sourceCommit: z.literal("f97608f178d1ffeca59860195ab7da295f7c8e5f"),
    credential: identity
      .extend({
        size: z.number().int().positive(),
        mtimeMs: z.number(),
        ctimeMs: z.number(),
      })
      .strict(),
    storeRelativePath: z.string(),
    store: identity,
  })
  .strict();
export type PilotPolicy = z.infer<typeof policySchema>;
export interface PilotProcess {
  pid: number;
  uid: number;
  startedAt: number;
  command: string;
  listeners: string[];
  sourceCommit: string;
}
export type ProcessProbe = (
  pid: number,
  sourceRoot: string,
) => Promise<PilotProcess>;
// Fixed read-only executables, no shell, no credential/config contents in process arguments.
export const observePilot: ProcessProbe = async (pid, sourceRoot) => {
  const opts = {
    timeout: 1500,
    maxBuffer: 32768,
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LC_ALL: "C",
      TZ: "UTC",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  };
  const [uid, start, args, sockets, commit] = await Promise.all([
    exec("/bin/ps", ["-p", String(pid), "-o", "uid="], opts),
    exec("/bin/ps", ["-p", String(pid), "-o", "lstart="], opts),
    exec("/bin/ps", ["-p", String(pid), "-o", "args="], opts),
    exec(
      "/usr/sbin/lsof",
      ["-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"],
      opts,
    ),
    exec(
      "/usr/bin/git",
      [
        "-c",
        "core.fsmonitor=false",
        "--no-optional-locks",
        "-C",
        sourceRoot,
        "rev-parse",
        "HEAD",
      ],
      opts,
    ),
  ]);
  return {
    pid,
    uid: Number(uid.stdout.trim()),
    startedAt: Date.parse(`${start.stdout.trim()} UTC`),
    command: args.stdout.trim(),
    listeners: sockets.stdout
      .split("\n")
      .filter((l) => l.startsWith("n"))
      .map((l) => l.slice(1)),
    sourceCommit: commit.stdout.trim(),
  };
};
/** Read-only local inspector. Approved hashes must refer to independently reviewed safe code/config. */
export class PilotInspector {
  #policy: PilotPolicy;
  #probe: ProcessProbe;
  #now: () => number;
  readonly endpoint: string;
  readonly scopeId: string;
  constructor(
    policy: PilotPolicy,
    options: { probe?: ProcessProbe; now?: () => number } = {},
  ) {
    this.#policy = policySchema.parse(structuredClone(policy));
    const url = new URL(policy.endpoint);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      throw new Error("pilot_policy_rejected");
    for (const path of [
      policy.profileRoot,
      policy.sourceRoot,
      policy.wrapperPath,
      policy.pythonPath,
    ])
      if (resolve(path) !== path) throw new Error("pilot_policy_rejected");
    if (
      resolve(policy.profileRoot, policy.storeRelativePath) !==
        join(policy.profileRoot, policy.storeRelativePath) ||
      resolve(policy.profileRoot, policy.storeRelativePath) ===
        policy.profileRoot ||
      !resolve(policy.profileRoot, policy.storeRelativePath).startsWith(
        `${policy.profileRoot}/`,
      )
    )
      throw new Error("pilot_policy_rejected");
    if (
      !policy.codeTrees.some((tree) => tree.root === policy.sourceRoot) ||
      !policy.codeTrees.some((tree) =>
        policy.pythonPath.startsWith(`${tree.root}/`),
      ) ||
      policy.codeTrees.some((tree) => resolve(tree.root) !== tree.root)
    )
      throw new Error("pilot_policy_rejected");
    this.endpoint = url.href;
    this.scopeId = `pilot-${digest(JSON.stringify({ ...this.#policy, endpoint: this.endpoint }))}`;
    this.#probe = options.probe ?? observePilot;
    this.#now = options.now ?? Date.now;
  }
  private async owned(path: string, directory = false, secret = false) {
    const stat = await lstat(path);
    if (
      stat.isSymbolicLink() ||
      (!directory && !stat.isFile()) ||
      (directory && !stat.isDirectory()) ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o022 ||
      (secret && stat.mode & 0o077) ||
      (await realpath(path)) !== path
    )
      throw new Error("pilot_file_boundary_rejected");
    return stat;
  }
  private async pinnedFile(path: string, sha: string) {
    const before = await this.owned(path);
    if (before.size > 1048576) throw new Error("pilot_file_boundary_rejected");
    const bytes = await readFile(path);
    const after = await this.owned(path);
    if (
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      before.ctimeMs !== after.ctimeMs ||
      digest(bytes) !== sha
    )
      throw new Error("pilot_integrity_rejected");
    return after;
  }
  private async snapshot() {
    const p = this.#policy;
    await this.owned(p.profileRoot, true, true);
    await this.owned(p.sourceRoot, true);
    const [wrapper, config, key, store, pidfile] = await Promise.all([
      this.pinnedFile(p.wrapperPath, p.wrapperSHA256),
      this.pinnedFile(join(p.profileRoot, "config.yaml"), p.configSHA256),
      this.owned(join(p.profileRoot, ".env"), false, true),
      this.owned(join(p.profileRoot, p.storeRelativePath)),
      this.owned(join(p.profileRoot, "pilot.pid")),
    ]);
    // Credential metadata only: never open/read the key file.
    for (const field of ["dev", "ino", "size", "mtimeMs", "ctimeMs"] as const)
      if (key[field] !== p.credential[field])
        throw new Error("pilot_credential_scope_changed");
    if (store.dev !== p.store.dev || store.ino !== p.store.ino)
      throw new Error("pilot_store_scope_changed");
    if (pidfile.size > 32) throw new Error("pilot_pid_rejected");
    const pidText = (
      await readFile(join(p.profileRoot, "pilot.pid"), "utf8")
    ).trim();
    if (!/^[1-9][0-9]{0,9}$/.test(pidText))
      throw new Error("pilot_pid_rejected");
    const pid = Number(pidText);
    const observed = await this.#probe(pid, p.sourceRoot);
    const url = new URL(this.endpoint);
    if (
      observed.pid !== pid ||
      observed.uid !== process.getuid?.() ||
      !Number.isFinite(observed.startedAt) ||
      observed.startedAt > this.#now() ||
      observed.command !== `${p.pythonPath} ${p.wrapperPath}` ||
      observed.sourceCommit !== p.sourceCommit ||
      observed.listeners.length !== 1 ||
      observed.listeners[0] !== `127.0.0.1:${url.port}`
    )
      throw new Error("pilot_process_boundary_rejected");
    const python = await this.pinnedFile(p.pythonPath, p.pythonSHA256);
    for (const tree of p.codeTrees)
      if (
        (await measureCodeTree(tree.root, observed.startedAt)) !== tree.sha256
      )
        throw new Error("pilot_code_integrity_rejected");
    // ps has one-second precision. Files must predate the process's earliest start instant.
    if (
      Math.max(wrapper.ctimeMs, config.ctimeMs, key.ctimeMs, python.ctimeMs) >
      observed.startedAt
    )
      throw new Error("pilot_startup_integrity_unverified");
    return {
      pid,
      start: observed.startedAt,
      command: observed.command,
      key: JSON.stringify(p.credential),
      store: JSON.stringify(p.store),
    };
  }
  async inspect(): Promise<IsolationEvidence | null> {
    try {
      const first = await this.snapshot();
      const second = await this.snapshot();
      if (JSON.stringify(first) !== JSON.stringify(second)) return null;
      return {
        endpoint: this.endpoint,
        scopeId: this.scopeId,
        sourceCommit: this.#policy.sourceCommit,
        expiresAt: this.#now() + 30000,
        dedicatedProfile: true,
        credentialScopeIsolated: true,
        effectiveToolCount: 0,
        memoryDisabled: true,
        historyIsolated: true,
        modelProviderLocked: true,
        fallbackDisabled: true,
      };
    } catch {
      return null;
    }
  }
}
