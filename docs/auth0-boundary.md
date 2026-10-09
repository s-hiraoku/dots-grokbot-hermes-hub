# Auth0 resource-server boundary (offline implementation)

This unit adds resource discovery and Auth0 access-token validation. It does not
create an Auth0 account, register an OAuth client, issue credentials, enable the
runnable server, connect a plugin/Tunnel, or perform browser login. The existing
Node server and Worker still deny every request until an operator explicitly
provides an authenticator. Only tests opt into fixture authentication.

## Configuration and wiring

Use a reviewed, exact standard Auth0 tenant issuer, including the final slash.
Custom-domain issuers are deliberately unsupported in this unit. The resource
identifier must be a canonical HTTPS URL ending in `/mcp`, without credentials,
port, query or fragment. It is the audience, not an instruction to deploy a
public server. Real resource/Tunnel rewriting compatibility is still untested.

```ts
const resource = new OAuthResource({
  issuer: "https://example-tenant.jp.auth0.com/",
  resource: "https://hub.example/mcp",
});
const subjects = new ApprovedSubjects([
  {
    subject: "auth0|operator-approved-example",
    kind: "user",
    clientId: "operator-approved-chatgpt-client",
    destination: "hermes",
    operations: ["submit", "get", "cancel", "events"],
  },
], { enabled: true, stoppedSubjects: [] });
const verifier = new Auth0Verifier({ resource, subjects });
// Node: handler(hub, req => verifier.verify(req.headers.authorization), events, resource)
// Portable: fetchMCP(hub, req, r => verifier.verify(r.headers.get("authorization") ?? undefined), events, resource)
```

Every value above is a dummy. No first-caller enrollment is supported. Default
`ApprovedSubjects` is disabled; startup must deliberately load an approved policy
and persisted stop state. Do not embed real subjects, configuration, tokens or
logs in the public repository. The owning operator must keep the configuration
private and persist a disable before restarting. `stop(subject)` and `stopAll()`
block subsequent authentication in the current process, including verification
already awaiting signature/JWKS work. They do not undo an admitted mutation or
cancel a running task. This unit does not implement the durable operator UI,
Auth0 revocation-event synchronization or cross-process configuration reload.
Those are required before reporting production revocation as complete.

For event delivery, wire `identityActive` to the same live subject gate and enforce
per-subscription authorization. Disabling a user must stop future notifications,
not only new HTTP calls. No callback destinations or live event sender are enabled
by this unit.

## OAuth contract

- Public GET endpoints `/.well-known/oauth-protected-resource/mcp` and
  `/.well-known/oauth-protected-resource` return fixed operator-selected resource,
  issuer and user scopes. Host headers and tool arguments cannot change them.
- Missing/invalid authentication produces HTTP 401 with a `WWW-Authenticate`
  resource-metadata challenge. Tools declare OAuth scopes in `_meta.securitySchemes`.
- Authorization-server discovery, consent, PKCE and token issuance belong to Auth0;
  the Hub does not run an authorization server or proxy its endpoints.
- For the first connection, choose a predefined public OAuth client with S256
  PKCE and token endpoint authentication `none`. That means no client secret at
  the token endpoint, not anonymous access to the Hub.
- Enable Auth0 resource parameter compatibility and issuer authorization-response
  support. Copy the exact redirect URI from ChatGPT's MCP management page.
- Select standard Auth0 JWT access tokens with RS256. The stricter existing
  verifier accepts `typ: JWT` or an absent `typ`; RFC9068 `at+jwt` is not supported
  by this unit. ID tokens, opaque tokens, JWE and other algorithms are rejected.
- Validate signature, exact issuer, audience membership, expiry/not-before,
  client binding and approved subject on every request. `azp` or `client_id` must
  match the subject's approved client; if both occur, both must match.
- Signed scopes only narrow operator-assigned permissions. Caller `agent`, role,
  destination, reader and JWT URL headers cannot grant authority. Human policies
  cannot claim, heartbeat, complete, reconcile or administer grants.

## Key lifecycle

JWKS is fetched only from `https://<configured-auth0-host>/.well-known/jwks.json`.
No JWT `jku`, `x5u`, embedded key, discovery URL or tool argument selects a network
address. Redirects are rejected, requests have a three-second abort timeout,
response size is bounded to 64 KiB, and key count to 20. Keys must be unique-kid
RS256 RSA verification keys of at least 2048 bits, with no private key material.

Keys are cached for five minutes. Unknown-kid refreshes are throttled to at most
one per 30 seconds and concurrent requests share a fetch. This bounds malicious
misses, at the cost of a short possible deny window during rotation. Removed or
replaced keys are rejected after refresh, including in-flight verification.
Expired caches never fall back to stale keys after a fetch failure. Key revocation
is not instantly visible before refresh; incident response also uses the local
stop gate. JWT access tokens have a maximum remaining lifetime of one hour under
the existing verifier; initially configure a shorter lifetime such as 15 minutes.
Refresh-token revocation alone is not proof of immediate API access revocation.

## Verification and remaining activation work

Mock tests cover fixed discovery/401, client/issuer/audience/subject rejection,
rotation, cache expiry/fetch failure, concurrency/throttle, malformed/oversized
JWKS, SSRF header rejection, asynchronous expiry/removal/stop, and an authenticated
fixed-task submit/mock/get roundtrip. Test-only RSA keys exist only in memory and
are not live credentials. All JWKS replies are injected mock responses.

Still required: actual tenant/client/subject enrollment, real issuer metadata,
resource/audience compatibility over Tunnel, PKCE redirect/login verification,
durable stop-state and revocation synchronization, audit-retention procedures,
and notification revocation wiring. An OAuth user subject identifies the
connected human account, not a unique dot such as Stallone.

Official references:

- [OpenAI MCP authentication](https://developers.openai.com/plugins/build/auth)
- [Auth0 MCP authorization](https://auth0.com/ai/docs/mcp/get-started/authorization-for-your-mcp-server)
- [Auth0 JWKS](https://auth0.com/docs/secure/tokens/json-web-tokens/json-web-key-sets)
- [Auth0 token practices](https://auth0.com/docs/secure/tokens/token-best-practices)


## Local durable denial boundary

The local follow-up [durable stop gate](durable-stop-gate.md) now supplies shared
DB global/subject/client stops and per-operation epoch fencing, automatically used
by the HTTP handlers and TaskService. `ApprovedSubjects` still supplies explicit
static enrollment and its local live gate; enabling that registry cannot bypass a
persisted stop. Deployment, operator access, revocation synchronization and real
client interoperability remain unconfigured. Notification `identityActive` is
still an additional required callback; its success cannot bypass the DB gate.
