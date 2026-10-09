import { z } from "zod";
import type { Principal } from "./types.ts";
const operation = z.enum([
  "submit",
  "claim",
  "heartbeat",
  "complete",
  "get",
  "cancel",
  "events",
  "grants",
  "reconcile",
]);
const policySchema = z
  .array(
    z
      .object({
        subject: z.string().min(1).max(200),
        kind: z.enum(["user", "service"]),
        clientId: z.string().min(1).max(200).optional(),
        operations: z.array(operation).min(1),
        destination: z.literal("hermes").optional(),
        worker: z.literal("hermes").optional(),
        runnerScope: z.string().min(1).max(200).optional(),
        resultReaders: z
          .array(
            z
              .object({
                subject: z.string().min(1).max(200),
                notify: z.boolean(),
              })
              .strict(),
          )
          .max(8)
          .optional(),
      })
      .strict(),
  )
  .max(100);
const decode = (s: string) => {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw Error("invalid_token");
  return Uint8Array.from(
    atob(
      s
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(Math.ceil(s.length / 4) * 4, "="),
    ),
    (c) => c.charCodeAt(0),
  );
};
/** Resource-server verification only. Does not mint tokens or implement OAuth consent. */
export class PinnedJWTVerifier {
  #policy: z.infer<typeof policySchema>;
  #issuer: string;
  #audience: string;
  #kid: string;
  #key: CryptoKey;
  #active: (subject: string, kind: "user" | "service") => Promise<boolean>;
  #now: () => number;
  constructor(options: {
    issuer: string;
    audience: string;
    kid: string;
    key: CryptoKey;
    policy: unknown;
    requireClientId?: boolean;
    active: (subject: string, kind: "user" | "service") => Promise<boolean>;
    now?: () => number;
  }) {
    if (
      !options.issuer.startsWith("https://") ||
      !options.audience ||
      !options.kid ||
      options.key.type !== "public" ||
      options.key.algorithm.name !== "RSASSA-PKCS1-v1_5" ||
      !options.key.usages.includes("verify") ||
      (options.key.algorithm as RsaHashedKeyAlgorithm).hash.name !==
        "SHA-256" ||
      (options.key.algorithm as RsaHashedKeyAlgorithm).modulusLength < 2048
    )
      throw Error("invalid_verifier_policy");
    this.#policy = policySchema.parse(options.policy);
    if (options.requireClientId && this.#policy.some((p) => !p.clientId))
      throw Error("missing_client_binding");
    if (
      new Set(this.#policy.map((p) => p.subject)).size !== this.#policy.length
    )
      throw Error("duplicate_subject");
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
    this.#issuer = options.issuer;
    this.#audience = options.audience;
    this.#kid = options.kid;
    this.#key = options.key;
    this.#active = options.active;
    this.#now = options.now ?? Date.now;
  }
  async verify(authorization: string | undefined): Promise<Principal | null> {
    try {
      if (
        !authorization ||
        authorization.length > 16384 ||
        !authorization.startsWith("Bearer ")
      )
        return null;
      const pieces = authorization.slice(7).split(".");
      if (pieces.length !== 3) return null;
      const [head, body, sig] = pieces;
      const header = z
        .object({
          alg: z.literal("RS256"),
          kid: z.literal(this.#kid),
          typ: z.literal("JWT").optional(),
        })
        .strict()
        .parse(JSON.parse(new TextDecoder().decode(decode(head))));
      if (
        header.alg !== "RS256" ||
        !(await crypto.subtle.verify(
          "RSASSA-PKCS1-v1_5",
          this.#key,
          decode(sig),
          new TextEncoder().encode(`${head}.${body}`),
        ))
      )
        return null;
      const claims = z
        .object({
          iss: z.literal(this.#issuer),
          aud: z.union([z.string(), z.array(z.string())]),
          sub: z.string(),
          exp: z.number().int(),
          nbf: z.number().int().optional(),
          iat: z.number().int().optional(),
          scope: z.string(),
          azp: z.string().optional(),
          client_id: z.string().optional(),
        })
        .passthrough()
        .parse(JSON.parse(new TextDecoder().decode(decode(body))));
      const seconds = Math.floor(this.#now() / 1000);
      if (
        !(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(
          this.#audience,
        ) ||
        claims.exp <= seconds ||
        claims.exp > seconds + 3600 ||
        (claims.nbf ?? seconds) > seconds ||
        (claims.iat ?? seconds) > seconds
      )
        return null;
      const p = this.#policy.find((p) => p.subject === claims.sub);
      if (
        !p ||
        (p.clientId &&
          (!(claims.azp || claims.client_id) ||
            (claims.azp !== undefined && claims.azp !== p.clientId) ||
            (claims.client_id !== undefined &&
              claims.client_id !== p.clientId))) ||
        !(await this.#active(p.subject, p.kind)) ||
        claims.exp <= Math.floor(this.#now() / 1000)
      )
        return null;
      const scopes = new Set(claims.scope.split(" "));
      const operations = p.operations.filter((op) => scopes.has(`hub:${op}`));
      if (!operations.length) return null;
      // Subject-specific static policy, never claims.agent/reader/role or caller headers.
      return Object.freeze({
        subject: p.subject,
        ...(p.clientId ? { clientId: p.clientId } : {}),
        operations: Object.freeze(operations),
        ...(p.destination ? { destination: p.destination } : {}),
        ...(p.worker ? { worker: p.worker, runnerScope: p.runnerScope } : {}),
        ...(p.resultReaders
          ? {
              resultReaders: Object.freeze(
                p.resultReaders.map((r) => Object.freeze({ ...r })),
              ),
            }
          : {}),
      });
    } catch {
      return null;
    }
  }
}
export const denyAuthentication = async (): Promise<Principal | null> => null;
