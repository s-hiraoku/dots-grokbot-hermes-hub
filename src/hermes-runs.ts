import { z } from "zod";
import {
  RESPONSE,
  RUN_ID_PATTERN,
  type Run,
  type Runs,
  type ReplayContract,
} from "./types.ts";
export const HERMES_MODEL = "gpt-6.1-sol";
export const HERMES_PROVIDER = "openai-codex";
export const HERMES_COMMIT = "f97608f178d1ffeca59860195ab7da295f7c8e5f";
const runId = z
  .string()
  .regex(RUN_ID_PATTERN)
  .regex(/^run_[a-zA-Z0-9_-]+$/);
const evidenceSchema = z
  .object({
    endpoint: z.string(),
    scopeId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    sourceCommit: z.literal(HERMES_COMMIT),
    expiresAt: z.number().int(),
    dedicatedProfile: z.literal(true),
    credentialScopeIsolated: z.literal(true),
    effectiveToolCount: z.literal(0),
    memoryDisabled: z.literal(true),
    historyIsolated: z.literal(true),
    modelProviderLocked: z.literal(true),
    fallbackDisabled: z.literal(true),
  })
  .strict();
export type IsolationEvidence = z.infer<typeof evidenceSchema>;
export interface HermesOptions {
  // Supplied by a trusted operator boundary, never a task or MCP argument.
  endpoint: string;
  scopeId: string;
  apiKey: string;
  inspectIsolation: () => Promise<IsolationEvidence | null>;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}
const capabilities = z.object({
  object: z.literal("hermes.api_server.capabilities"),
  platform: z.literal("hermes-agent"),
  auth: z.object({ type: z.literal("bearer"), required: z.literal(true) }),
  features: z.object({
    run_submission: z.literal(true),
    run_status: z.literal(true),
    runs_idempotency: z.object({
      supported: z.literal(true),
      durable: z.literal(true),
      retention_seconds: z.number().int().positive().max(604800),
    }),
  }),
});
/** No default URL, credential, profile attestation, or Desktop fallback. */
export class HermesRuns implements Runs {
  #options: HermesOptions;
  #endpoint: URL;
  #verifiedUntil = 0;
  #retention = 0;
  private constructor(options: HermesOptions) {
    this.#options = { ...options };
    this.#endpoint = new URL(options.endpoint);
    if (
      this.#endpoint.protocol !== "http:" ||
      this.#endpoint.hostname !== "127.0.0.1" ||
      !this.#endpoint.port ||
      this.#endpoint.pathname !== "/" ||
      this.#endpoint.search ||
      this.#endpoint.hash ||
      this.#endpoint.username ||
      this.#endpoint.password ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(options.scopeId ?? "") ||
      !options.apiKey ||
      /[\r\n]/.test(options.apiKey) ||
      (options.timeoutMs ?? 5000) > 10000 ||
      (options.timeoutMs ?? 5000) < 1
    )
      throw new Error("hermes_configuration_rejected");
  }
  static async connect(options: HermesOptions) {
    const runs = new HermesRuns(options);
    await runs.verify();
    return runs;
  }
  readonly admissionContract = "hermes-fixed-connectivity-v1";
  get boundaryId() {
    return `${this.#endpoint.href}|${this.#options.scopeId}`;
  }
  get toolIsolationVerified() {
    return this.#verifiedUntil > this.now();
  }
  get durableIdempotency() {
    return this.toolIsolationVerified && this.#retention > 0;
  }
  get retentionMs() {
    return this.#retention;
  }
  private now() {
    return (this.#options.now ?? Date.now)();
  }
  private async request(
    path: string,
    method = "GET",
    body?: object,
    key?: string,
    signal?: AbortSignal,
    authenticated = true,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    const response = await (this.#options.fetch ?? fetch)(
      new URL(path, this.#endpoint),
      {
        method,
        redirect: "manual",
        signal: AbortSignal.any([
          AbortSignal.timeout(this.#options.timeoutMs ?? 5000),
          ...(signal ? [signal] : []),
        ]),
        headers: {
          ...(authenticated
            ? { Authorization: `Bearer ${this.#options.apiKey}` }
            : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(key ? { "Idempotency-Key": key } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    if (!authenticated) {
      await response.body?.cancel();
      if (response.status !== 401)
        throw new Error("hermes_auth_boundary_unverified");
      return null;
    }
    if (!response.ok || (method === "POST" && response.status !== 202)) {
      await response.body?.cancel();
      throw new Error(`hermes_http_${response.status}`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("hermes_response_missing");
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 32768) throw new Error("hermes_response_too_large");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error("hermes_invalid_json");
    }
  }
  private async verify(signal?: AbortSignal) {
    this.#verifiedUntil = 0;
    const evidence = evidenceSchema.safeParse(
      await this.#options.inspectIsolation(),
    );
    const now = this.now();
    if (
      !evidence.success ||
      evidence.data.endpoint !== this.#endpoint.href ||
      evidence.data.scopeId !== this.#options.scopeId ||
      evidence.data.expiresAt <= now ||
      evidence.data.expiresAt > now + 300000
    )
      throw new Error("hermes_isolation_unverified");
    await this.request(
      "/v1/capabilities",
      "GET",
      undefined,
      undefined,
      signal,
      false,
    );
    const cap = capabilities.safeParse(
      await this.request(
        "/v1/capabilities",
        "GET",
        undefined,
        undefined,
        signal,
      ),
    );
    if (!cap.success) throw new Error("hermes_capabilities_unverified");
    // Inventory corroborates external effective-tool inspection, but cannot replace it.
    const toolsets = z
      .array(z.object({ enabled: z.boolean(), tools: z.array(z.string()) }))
      .safeParse(
        await this.request("/v1/toolsets", "GET", undefined, undefined, signal),
      );
    if (
      !toolsets.success ||
      toolsets.data.some((t) => t.enabled && t.tools.length)
    )
      throw new Error("hermes_tools_enabled");
    if (this.now() >= evidence.data.expiresAt)
      throw new Error("hermes_isolation_expired");
    const retention =
      cap.data.features.runs_idempotency.retention_seconds * 1000;
    if (this.#retention && retention !== this.#retention)
      throw new Error("hermes_retention_changed");
    this.#retention = retention;
    this.#verifiedUntil = Math.min(evidence.data.expiresAt, this.now() + 30000);
  }
  async create(input: {
    idempotencyKey: string;
    prompt: string;
    tools: never[];
    signal?: AbortSignal;
    replay?: ReplayContract;
  }): Promise<Run> {
    if (
      input.prompt !== RESPONSE ||
      input.tools.length ||
      Object.keys(input).some(
        (k) =>
          !["idempotencyKey", "prompt", "tools", "signal", "replay"].includes(
            k,
          ),
      ) ||
      !/^hub-[0-9a-f-]{36}$/.test(input.idempotencyKey)
    )
      throw new Error("hermes_input_rejected");
    const replay = input.replay ? { ...input.replay } : undefined;
    if (
      !replay ||
      replay.contract !== this.admissionContract ||
      !Number.isFinite(replay.deadline) ||
      !Number.isFinite(replay.retentionMs) ||
      replay.retentionMs <= 0
    )
      throw new Error("hermes_replay_contract_unverified");
    await this.verify(input.signal);
    // Recheck the original persisted contract after all asynchronous preflight, immediately before POST.
    if (replay.retentionMs !== this.#retention)
      throw new Error("hermes_replay_contract_changed");
    if (this.now() >= replay.deadline)
      throw new Error("idempotency_horizon_expired");
    const accepted = z
      .object({
        run_id: runId,
        status: z.enum([
          "started",
          "queued",
          "running",
          "waiting_for_approval",
          "completed",
          "failed",
          "cancelled",
          "interrupted",
        ]),
      })
      .safeParse(
        await this.request(
          "/v1/runs",
          "POST",
          {
            input: `Reply with exactly this text and nothing else: ${RESPONSE}`,
            model: HERMES_MODEL,
            provider: HERMES_PROVIDER,
          },
          input.idempotencyKey,
          input.signal,
        ),
      );
    if (!accepted.success)
      throw new Error("hermes_admission_requires_reconciliation");
    // Persist ID first; even a replayed terminal admission must be polled by ID.
    return { id: accepted.data.run_id, state: "running" };
  }
  async get(id: string, signal?: AbortSignal): Promise<Run> {
    if (!runId.safeParse(id).success) throw new Error("hermes_run_id_rejected");
    await this.verify(signal);
    const result = z
      .object({
        object: z.literal("hermes.run"),
        run_id: runId,
        status: z.string(),
        output: z.string().optional(),
        runtime: z
          .object({ model: z.string(), provider: z.string() })
          .optional(),
      })
      .safeParse(
        await this.request(
          `/v1/runs/${id}`,
          "GET",
          undefined,
          undefined,
          signal,
        ),
      );
    if (!result.success || result.data.run_id !== id)
      throw new Error("hermes_status_requires_reconciliation");
    const run = result.data;
    if (["queued", "running", "waiting_for_approval"].includes(run.status))
      return { id, state: "running" };
    if (
      run.status !== "completed" ||
      run.output !== RESPONSE ||
      run.runtime?.model !== HERMES_MODEL ||
      run.runtime.provider !== HERMES_PROVIDER
    )
      throw new Error("hermes_terminal_requires_reconciliation");
    return { id, state: "succeeded", text: RESPONSE };
  }
}
