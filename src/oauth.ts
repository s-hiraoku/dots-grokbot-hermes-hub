import { z } from "zod";
import { PinnedJWTVerifier, validatePolicyBindings } from "./auth.ts";
import type { Principal } from "./types.ts";

const scopes = [
  "hub:submit",
  "hub:get",
  "hub:cancel",
  "hub:events",
  "hub:ping_submit",
  "hub:ping_get",
  "hub:ping_reply",
  "hub:ping_pending",
] as const;
function httpsURL(value: string, allowPort = false) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (!allowPort && url.port)
  )
    throw Error("invalid_oauth_url");
  return url;
}
/** Canonical MCP path: no decoding, normalization, query or proxy prefix guessing. */
export function validMcpPath(path: string) {
  return (
    /^\/(?:[A-Za-z0-9_-]+\/)*mcp$/.test(path) &&
    !path.startsWith("/.well-known/") &&
    path.length <= 200
  );
}
/** Operator-selected Auth0 tenant only; never discovery from a JWT or caller URL. */
export class OAuthResource {
  readonly userScopes: readonly (typeof scopes)[number][];
  readonly issuer: string;
  readonly resource: string;
  readonly metadataURL: string;
  readonly mcpPath: string;
  readonly metadataPath: string;
  readonly jwksURL: string;
  constructor(options: {
    issuer: string;
    resource: string;
    userScopes?: readonly (typeof scopes)[number][];
  }) {
    this.userScopes = Object.freeze(
      z
        .array(z.enum(scopes))
        .min(1)
        .max(8)
        .parse(options.userScopes ?? scopes.slice(0, 4)),
    );
    const issuer = httpsURL(options.issuer);
    const resource = httpsURL(options.resource, true);
    if (
      issuer.pathname !== "/" ||
      options.issuer !== issuer.href ||
      !/^[a-z0-9-]+(?:\.[a-z0-9-]+)?\.auth0\.com$/.test(issuer.hostname) ||
      !validMcpPath(resource.pathname) ||
      options.resource !== resource.href
    )
      throw Error("invalid_oauth_resource");
    this.issuer = options.issuer;
    this.resource = options.resource;
    this.mcpPath = resource.pathname;
    this.metadataPath = `/.well-known/oauth-protected-resource${this.mcpPath}`;
    this.metadataURL = `${resource.origin}${this.metadataPath}`;
    this.jwksURL = `${issuer.origin}/.well-known/jwks.json`;
    Object.freeze(this);
  }
  metadata() {
    return {
      resource: this.resource,
      authorization_servers: [this.issuer],
      scopes_supported: [...this.userScopes],
      bearer_methods_supported: ["header"],
    };
  }
  challenge() {
    return `Bearer resource_metadata="${this.metadataURL}", scope="${this.userScopes.join(" ")}"`;
  }
  response(path: string, method: string): Response | undefined {
    if (
      ![
        this.metadataPath,
        ...(this.mcpPath === "/mcp"
          ? ["/.well-known/oauth-protected-resource"]
          : []),
      ].includes(path)
    )
      return;
    return new Response(
      method === "GET" ? JSON.stringify(this.metadata()) : null,
      {
        status: method === "GET" ? 200 : 405,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      },
    );
  }
}

const approval = z
  .object({
    subject: z.string().min(1).max(200),
    kind: z.enum(["user", "service"]),
    taskTypes: z
      .array(z.enum(["connectivity_check", "shift_log_inventory"]))
      .min(1)
      .max(2)
      .optional(),
    clientId: z.string().min(1).max(200),
    operations: z
      .array(
        z.enum([
          "submit",
          "get",
          "cancel",
          "events",
          "claim",
          "heartbeat",
          "complete",
          "grants",
          "reconcile",
          "ping_submit",
          "ping_get",
          "ping_reply",
          "ping_pending",
        ]),
      )
      .min(1),
    destination: z.literal("hermes").optional(),
    worker: z.literal("hermes").optional(),
    runnerScope: z.string().min(1).max(200).optional(),
    resultReaders: z
      .array(
        z
          .object({ subject: z.string().min(1).max(200), notify: z.boolean() })
          .strict(),
      )
      .max(8)
      .optional(),
  })
  .strict();
/** Explicit enrollment only. Stop flags are local live state, independent of token validity. */
export class ApprovedSubjects {
  #policy: z.infer<typeof approval>[];
  #stopped = new Set<string>();
  #enabled: boolean;
  constructor(
    policy: unknown,
    options: { enabled: boolean; stoppedSubjects?: string[] } = {
      enabled: false,
    },
  ) {
    const settings = z
      .object({
        enabled: z.boolean(),
        stoppedSubjects: z
          .array(z.string().min(1).max(200))
          .max(100)
          .optional(),
      })
      .strict()
      .parse(options);
    this.#enabled = settings.enabled;
    this.#stopped = new Set(settings.stoppedSubjects ?? []);
    this.#policy = z.array(approval).max(100).parse(policy);
    validatePolicyBindings(this.#policy);
    for (const p of this.#policy) {
      if (
        p.kind === "user" &&
        p.operations.some((op) =>
          ["claim", "heartbeat", "complete", "grants", "reconcile"].includes(
            op,
          ),
        )
      )
        throw Error("invalid_user_authority");
      if (
        p.worker &&
        (p.kind !== "service" ||
          p.destination ||
          p.operations.includes("submit") ||
          !p.runnerScope)
      )
        throw Error("invalid_worker_authority");
    }
  }
  policy() {
    return structuredClone(this.#policy);
  }
  isActive(subject: string, kind: "user" | "service", clientId?: string) {
    return (
      this.#enabled &&
      !this.#stopped.has(subject) &&
      this.#policy.some(
        (p) =>
          p.subject === subject &&
          p.kind === kind &&
          (clientId === undefined || p.clientId === clientId),
      )
    );
  }
  stop(subject: string) {
    this.#stopped.add(subject);
  }
  stopAll() {
    this.#enabled = false;
  }
}

const jwk = z
  .object({
    kty: z.literal("RSA"),
    kid: z.string().min(1).max(200),
    n: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .max(1400),
    e: z.literal("AQAB"),
    alg: z.literal("RS256"),
    use: z.literal("sig").optional(),
    key_ops: z.array(z.literal("verify")).optional(),
  })
  .passthrough();
const header = z
  .object({
    alg: z.literal("RS256"),
    kid: z.string().min(1).max(200),
    typ: z.literal("JWT").optional(),
  })
  .strict();

/** Bounded cache with no stale-key fallback. Fetches exactly one configured HTTPS URL. */
export class Auth0Verifier {
  #keys = new Map<string, CryptoKey>();
  #expires = 0;
  #nextRefresh = 0;
  #loading?: Promise<void>;
  #fetch: typeof fetch;
  #now: () => number;
  readonly resource: OAuthResource;
  readonly subjects: ApprovedSubjects;
  constructor(options: {
    resource: OAuthResource;
    subjects: ApprovedSubjects;
    fetch?: typeof fetch;
    now?: () => number;
  }) {
    this.resource = options.resource;
    this.subjects = options.subjects;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
  }
  async #refresh() {
    if (this.#loading) return this.#loading;
    if (this.#now() < this.#nextRefresh) throw Error("jwks_refresh_throttled");
    this.#nextRefresh = this.#now() + 30000;
    this.#loading = (async () => {
      const response = await this.#fetch(this.resource.jwksURL, {
        redirect: "error",
        signal: AbortSignal.timeout(3000),
        headers: { Accept: "application/json" },
      });
      if (
        !response.ok ||
        (response.url && response.url !== this.resource.jwksURL) ||
        !response.body
      )
        throw Error("jwks_fetch_rejected");
      const reader = response.body.getReader();
      let length = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > 65536) throw Error("jwks_too_large");
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
      const data = z
        .object({ keys: z.array(jwk).min(1).max(20) })
        .parse(JSON.parse(new TextDecoder().decode(bytes)));
      const keys = new Map<string, CryptoKey>();
      for (const value of data.keys) {
        if (keys.has(value.kid) || "d" in value || "p" in value || "q" in value)
          throw Error("invalid_jwks");
        const key = await crypto.subtle.importKey(
          "jwk",
          { kty: value.kty, n: value.n, e: value.e, alg: value.alg },
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"],
        );
        if ((key.algorithm as RsaHashedKeyAlgorithm).modulusLength < 2048)
          throw Error("weak_jwks_key");
        keys.set(value.kid, key);
      }
      this.#keys = keys;
      this.#expires = this.#now() + 300000;
    })();
    try {
      await this.#loading;
    } finally {
      this.#loading = undefined;
    }
  }
  async verify(authorization: string | undefined): Promise<Principal | null> {
    try {
      if (!authorization?.startsWith("Bearer ") || authorization.length > 16384)
        return null;
      const parts = authorization.slice(7).split(".");
      if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p)))
        return null;
      const h = header.parse(
        JSON.parse(
          new TextDecoder().decode(
            Uint8Array.from(
              atob(parts[0].replace(/-/g, "+").replace(/_/g, "/")),
              (c) => c.charCodeAt(0),
            ),
          ),
        ),
      );
      if (this.#now() >= this.#expires || !this.#keys.has(h.kid))
        await this.#refresh();
      const key = this.#keys.get(h.kid);
      if (!key || this.#now() >= this.#expires) return null;
      const verifier = new PinnedJWTVerifier({
        issuer: this.resource.issuer,
        audience: this.resource.resource,
        kid: h.kid,
        key,
        requireClientId: true,
        policy: this.subjects.policy(),
        now: this.#now,
        active: async (subject, kind, clientId) =>
          this.subjects.isActive(subject, kind, clientId),
      });
      const principal = await verifier.verify(authorization);
      // Recheck the local stop gate after all asynchronous signature work.
      if (
        !principal ||
        this.#now() >= this.#expires ||
        this.#keys.get(h.kid) !== key ||
        !this.subjects
          .policy()
          .some(
            (p) =>
              p.subject === principal.subject &&
              p.clientId === principal.clientId &&
              this.subjects.isActive(p.subject, p.kind, p.clientId),
          )
      )
        return null;
      return principal;
    } catch {
      return null;
    }
  }
}
