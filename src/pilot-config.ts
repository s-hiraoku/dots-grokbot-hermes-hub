import { z } from "zod";
import { OAuthResource } from "./oauth.ts";
export const PILOT_SCOPES = [
  "hub:ping_submit",
  "hub:ping_get",
  "hub:ping_reply",
  "hub:ping_pending",
] as const;
const confirmed = z
  .string()
  .min(1)
  .max(200)
  .refine((v) => !/placeholder|replace|example|<|>/i.test(v));
const callback = z
  .string()
  .url()
  .refine((v) => {
    const u = new URL(v);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.hash &&
      !u.search &&
      !u.port &&
      !/example|placeholder|localhost|127\.0\.0\.1/.test(u.hostname)
    );
  });
const peer = z
  .object({
    subject: confirmed,
    clientId: confirmed,
    callback,
    clientAuthentication: z.enum([
      "none",
      "client_secret_post",
      "client_secret_basic",
    ]),
  })
  .strict();
const schema = z
  .object({
    mode: z.literal("offline_preflight"),
    hub: z
      .object({
        host: z.literal("127.0.0.1"),
        port: z.number().int().min(1024).max(65535),
        database: z.literal("runtime/hub.db"),
      })
      .strict(),
    oauth: z
      .object({
        issuer: z.string(),
        audience: z.string(),
        scopes: z.array(z.enum(PILOT_SCOPES)).length(4),
      })
      .strict(),
    peers: z.object({ dots: peer, grok: peer }).strict(),
    auth0Budget: z
      .object({
        monthlyUsd: z.literal(0),
        paidFeatures: z.literal(false),
        m2mMonthlyCeiling: z.literal(1000),
        exhaustion: z.literal("stop_and_notify"),
        tokenAcquisition: z.literal("on_demand"),
        expiryCache: z.literal(true),
        singleFlight: z.literal(true),
        maxRetries: z.literal(0),
      })
      .strict(),
  })
  .strict();
/** Pure validation only. No HTTP, token issuance, service startup, or secret input. */
export function preflightPilot(input: unknown) {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    return { ready: false as const, errors: ["invalid_or_unconfirmed_config"] };
  const config = parsed.data;
  try {
    if (
      /example|placeholder|replace|<|>/i.test(
        config.oauth.issuer + config.oauth.audience,
      )
    )
      throw Error();
    new OAuthResource({
      issuer: config.oauth.issuer,
      resource: config.oauth.audience,
      userScopes: config.oauth.scopes,
    });
    if (
      new Set(config.oauth.scopes).size !== 4 ||
      config.peers.dots.clientId === config.peers.grok.clientId
    )
      throw Error();
    return {
      ready: false as const,
      offlineValid: true as const,
      errors: ["live_registration_routing_and_budget_unverified"],
    };
  } catch {
    return {
      ready: false as const,
      errors: ["invalid_or_unconfirmed_identity_boundary"],
    };
  }
}
