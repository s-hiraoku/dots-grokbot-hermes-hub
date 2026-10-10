import { randomBytes, createHash } from "node:crypto";
export type KeyRecord = {
  fingerprint: string;
  purpose: "hermes-one-task";
  expiresAt: number;
  state: "issued" | "revoked" | "stop_failed";
};
type Boundary = { stop: () => Promise<void> };
/** Trusted local composition only. No default launcher, HTTP tool, env or credential writes. */
export class LocalHermesKey {
  #record?: KeyRecord;
  #child?: Boundary;
  #adapter?: Boundary;
  #timer?: ReturnType<typeof setTimeout>;
  #closing?: Promise<void>;
  #used = false;
  #provisioning = false;
  #resolveRegistered!: () => void;
  #registered = new Promise<void>((resolve) => {
    this.#resolveRegistered = resolve;
  });
  #cleanup?: () => Promise<void>;
  record(): Readonly<KeyRecord> | undefined {
    return this.#record ? Object.freeze({ ...this.#record }) : undefined;
  }
  async provision(options: {
    ttlMs: number;
    persist: (record: KeyRecord) => Promise<void>;
    launch: (apiKey: string, fingerprint: string) => Boundary;
    adapter: (apiKey: string, fingerprint: string) => Boundary;
    entropy?: (size: number) => Buffer;
    now?: () => number;
    report?: (reason: string) => void;
  }): Promise<void> {
    if (
      this.#used ||
      !Number.isInteger(options.ttlMs) ||
      options.ttlMs < 1 ||
      options.ttlMs > 120000
    )
      throw Error("provision_rejected");
    this.#used = true;
    this.#provisioning = true;
    let key = "";
    try {
      const now = options.now ?? Date.now,
        bytes = (options.entropy ?? randomBytes)(32);
      if (!Buffer.isBuffer(bytes) || bytes.length !== 32) throw Error();
      key = Buffer.from(bytes).toString("hex");
      bytes.fill(0);
      const fingerprint = createHash("sha256").update(key).digest("hex");
      this.#record = {
        fingerprint,
        purpose: "hermes-one-task",
        expiresAt: now() + options.ttlMs,
        state: "issued",
      };
      this.#cleanup = async () => {
        const stop = async (boundary: Boundary | undefined) => {
          if (!boundary) return true;
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([
              Promise.resolve()
                .then(() => boundary.stop())
                .then(
                  () => true,
                  () => false,
                ),
              new Promise<boolean>((resolve) => {
                timer = setTimeout(() => resolve(false), 1000);
              }),
            ]);
          } finally {
            if (timer) clearTimeout(timer);
          }
        };
        const results = await Promise.all([
          stop(this.#adapter),
          stop(this.#child),
        ]);
        this.#adapter = undefined;
        this.#child = undefined;
        const failed = results.includes(false);
        this.#record = {
          ...this.#record!,
          state: failed ? "stop_failed" : "revoked",
        };
        await options.persist({ ...this.#record });
        if (failed) {
          options.report?.("hermes_stop_failed");
          throw Error("hermes_stop_failed");
        }
      };
      await options.persist({ ...this.#record });
      const check = () => {
        if (now() >= this.#record!.expiresAt || this.#closing) throw Error();
      };
      check();
      this.#timer = setTimeout(
        () => {
          void this.close().catch(() =>
            options.report?.("hermes_cleanup_failed"),
          );
        },
        Math.max(1, this.#record.expiresAt - now()),
      );
      this.#child = options.launch(key, fingerprint);
      check();
      this.#adapter = options.adapter(key, fingerprint);
      check();
    } catch {
      this.#resolveRegistered();
      await this.close();
      throw Error("provision_failed");
    } finally {
      key = "";
      this.#provisioning = false;
      this.#resolveRegistered();
    }
  }
  async close(): Promise<void> {
    this.#used = true;
    if (this.#timer) clearTimeout(this.#timer);
    if (!this.#provisioning) this.#resolveRegistered();
    if (!this.#closing)
      this.#closing = (async () => {
        await this.#registered;
        await this.#cleanup?.();
      })();
    await this.#closing;
  }
}
