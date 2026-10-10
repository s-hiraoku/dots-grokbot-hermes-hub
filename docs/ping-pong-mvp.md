# Fixed bidirectional ping/pong pilot

This local-only diagnostic is separate from Hermes tasks. It is not a production connection. `PingService` is opt-in; the existing Worker does not instantiate it or enable authentication. Missing authentication or peer configuration fails closed.

## Contract and authority

The four MCP operations are `ping_submit`, `ping_get`, `ping_reply`, and `ping_pending`. Each pilot client requires those four dedicated scopes; legacy task execution scopes are unnecessary. Two operator-configured subject/client pairs identify Dots and Grok. Clients must differ; the PingService contract permits subjects to match, but the current upstream authorization registry is subject-unique. Offline preflight rejects shared subjects until that registry is extended and tested. Claims must come from verified authentication, not tool arguments. Connections shared by an account do not establish exclusive bot identity.

Only literal `ping` and `pong` are accepted. The server chooses the opposite peer. There is no shell, arbitrary message, destination URL, or personal-data field. Requests have server-generated IDs/correlation IDs, a 1–300 second TTL, and a sender-scoped request key. At most ten active requests per sender/client are allowed. This is an active-request limit, not historical retention or a complete rate limiter.

Replies require the original request ID as `in_reply_to`, the correlation ID, and the authenticated recipient. An atomic database update enforces expiry, current authorization epoch, both peers' stop gates, and reply idempotency. Stop/restore invalidates earlier diagnostic requests. All authorization edits conservatively invalidate pending diagnostics. State transitions have transactional audit and outbox records. Reply events never create new requests.

Dots-origin requests can be handed once to an injected, trusted Grok wake transport. No real transport is installed. HTTP 200 records acceptance, not completion: only authenticated correlated `pong` makes the request `replied`. An attempt marker is committed before sending. Failures, unknown acknowledgements, crashes, and timeouts are parked without automatic resend. This avoids duplicate routine invocation; it sacrifices automatic recovery. The transport gets an AbortSignal and a wait bounded by remaining TTL and at most three seconds. A future HTTP implementation must honor cancellation and forbid redirects/dynamic targets; abort cannot retract bytes already sent or guarantee provider cancellation.

Grok-origin requests are retrieved by Dots using explicit `ping_pending`, followed by `ping_reply`. Automatic Dots notification/reception is unverified and unimplemented. Neither direction polls or starts recurring jobs by default.

## Local verification

Run `npm ci`, `npm run lint`, `npm run typecheck`, and `npm test` with Node 24 or newer. SQLite and local D1 fixtures exercise both directions, expiry, correlation mismatch, scope/identity rejection, duplicate and concurrent requests/replies, durable stops, restart reconciliation, one-attempt wake delivery, HTTP 200 without completion, failed/lost acknowledgements, and bounded hung-transport waits. OAuth MCP tests use ephemeral mock signing keys and an in-process mocked issuer; no live provider is contacted.

## Proposed connection boundary

Hub and its SQLite database must remain on the Mac mini. Cloudflare Workers/D1 hosting is excluded. Auth0 remains the cloud identity provider. The minimal proposed ingress is a dedicated Cloudflare named Tunnel/public hostname, for example `https://agent-hub.example.com/mcp`, forwarding only to a loopback Hub on the Mac. The hostname is illustrative, not allocated. `cloudflared` initiates an outbound connection; no router inbound port is needed. Cloudflare terminates HTTPS and relays request/response traffic, including authorization headers, so provider processing and tunnel credentials need explicit approval. The existing Node entrypoint binds `127.0.0.1:8787` and stores `runtime/hub.db`; port availability and authenticated pilot wiring remain unverified. Its default handler rejects unauthenticated access. Do not start or publish that default entrypoint as a working pilot.

Use a dedicated hostname and exact `/mcp` route, fail closed for every unmatched route, and preserve the existing model-agent endpoint unchanged. Auth0 bearer verification stays in Hub with exact issuer, audience, subject/client allowlists and four diagnostic scopes. Do not add a Cloudflare interactive login or service-token gate unless both MCP clients demonstrably support it; that would be an additional credential boundary. OAuth/protected-resource metadata routing must be explicitly mapped consistently with the external URL; do not expose administration, DB, logs, filesystem or other local ports. DB storage remains local, while diagnostic traffic crosses the relay. Request bodies and Authorization headers must not be recorded in proxy logs.

Cloudflare Tunnel is documented as available on all plans; Zero Trust has a free plan, but this account's entitlement, domain cost and any paid extras are unconfirmed. No subscription or zero-cost guarantee is made. A stable named tunnel requires a suitable domain and owner-approved routing/connector setup. Quick Tunnels are excluded: their hostname changes, no uptime guarantee is provided, and SSE is unsupported. Actual Dots/Grok OAuth, streaming and reconnect compatibility must still be tested under a separate live-call approval.

Tailscale Funnel is a possible alternative only after an owner-provided non-secret route snapshot proves isolation. Both the installed CLI and app-bundle CLI returned `Failed to load preferences` for read-only serve/funnel status; no configuration was obtained. This is the observed failure, not proof of a missing account or daemon. No alternate privilege, preference-file access, credential access or configuration mutation was attempted. A supplied tailnet hostname does not prove public Funnel reachability. Do not add `/agent-hub/mcp` to an unknown shared listener: public exposure boundaries and existing routes must first be verified. Official Funnel documentation states that a listener port configured for Funnel is completely public, so a new path is not a separate exposure boundary. A separate supported listener port could be evaluated only after checking existing use and client compatibility. An OpenAI-specific tunnel is not assumed reachable by Grok.

Official references: [Tunnel architecture](https://developers.cloudflare.com/tunnel/), [published hostname setup](https://developers.cloudflare.com/tunnel/get-started/), [Quick Tunnel limits](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/), [Zero Trust pricing](https://www.cloudflare.com/plans/zero-trust-services/), and [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel).

The one owner question needed to choose the next route is: **Do you already own a domain managed in Cloudflare that may be used for a dedicated Hub subdomain?** Do not request secret values. A yes enables a concrete hostname/routing approval proposal; a no requires choosing a domain or confirming existing Tailscale isolation first.

Before requesting live registration approval, confirm:

- Exact HTTPS endpoint, service owner, publicly reachable routing, and cost/usage limits; select one hosting route.
- Issuer and audience/resource, exact OAuth callbacks and client authentication methods copied from each registration, distinct client IDs, and allowed subjects. Request only the four diagnostic scopes.
- Exact existing Grok routine webhook URL, owner, fixed routine instruction, usage consequences, and a separately stored outbound bearer credential. The routine must fetch/check the request and reply through its authenticated MCP connection. Never put credentials in repository files or tool arguments.
- A backend-only fixed-target HTTP transport with cancellation, redirect rejection, secret storage, and explicit outbound authorization. The pilot does not expose a webhook URL argument.
- How Dots initiates/polls and whether automatic reception is required. Explicit polling is the implemented baseline; automatic reception needs a separately reviewed integration.

Creating credentials, changing scopes, publishing routes, contacting bots, deploying, or starting a persistent dispatcher requires separate approval. Existing Hermes settings and unrelated MCP services are untouched. An OpenAI-specific secure MCP tunnel is not assumed to provide a shared Grok ingress.
