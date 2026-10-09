# Fixed bidirectional ping/pong pilot

This local-only diagnostic is separate from Hermes tasks. It is not a production connection. `PingService` is opt-in; the existing Worker does not instantiate it or enable authentication. Missing authentication or peer configuration fails closed.

## Contract and authority

The four MCP operations are `ping_submit`, `ping_get`, `ping_reply`, and `ping_pending`. Each pilot client requires those four dedicated scopes; legacy task execution scopes are unnecessary. Two operator-configured subject/client pairs identify Dots and Grok. Clients must differ; subjects may match. Claims must come from verified authentication, not tool arguments. Connections shared by an account do not establish exclusive bot identity.

Only literal `ping` and `pong` are accepted. The server chooses the opposite peer. There is no shell, arbitrary message, destination URL, or personal-data field. Requests have server-generated IDs/correlation IDs, a 1–300 second TTL, and a sender-scoped request key. At most ten active requests per sender/client are allowed. This is an active-request limit, not historical retention or a complete rate limiter.

Replies require the original request ID as `in_reply_to`, the correlation ID, and the authenticated recipient. An atomic database update enforces expiry, current authorization epoch, both peers' stop gates, and reply idempotency. Stop/restore invalidates earlier diagnostic requests. All authorization edits conservatively invalidate pending diagnostics. State transitions have transactional audit and outbox records. Reply events never create new requests.

Dots-origin requests can be handed once to an injected, trusted Grok wake transport. No real transport is installed. HTTP 200 records acceptance, not completion: only authenticated correlated `pong` makes the request `replied`. An attempt marker is committed before sending. Failures, unknown acknowledgements, crashes, and timeouts are parked without automatic resend. This avoids duplicate routine invocation; it sacrifices automatic recovery. The transport gets an AbortSignal and a wait bounded by remaining TTL and at most three seconds. A future HTTP implementation must honor cancellation and forbid redirects/dynamic targets; abort cannot retract bytes already sent or guarantee provider cancellation.

Grok-origin requests are retrieved by Dots using explicit `ping_pending`, followed by `ping_reply`. Automatic Dots notification/reception is unverified and unimplemented. Neither direction polls or starts recurring jobs by default.

## Local verification

Run `npm ci`, `npm run lint`, `npm run typecheck`, and `npm test` with Node 24 or newer. SQLite and local D1 fixtures exercise both directions, expiry, correlation mismatch, scope/identity rejection, duplicate and concurrent requests/replies, durable stops, restart reconciliation, one-attempt wake delivery, HTTP 200 without completion, failed/lost acknowledgements, and bounded hung-transport waits. OAuth MCP tests use ephemeral mock signing keys and an in-process mocked issuer; no live provider is contacted.

## Proposed connection boundary

A minimal public HTTPS candidate is one Cloudflare Worker backed by D1, exposing a single authenticated `/mcp` endpoint for both clients. Its assigned hostname, ownership, account entitlement, and potential charges are not confirmed. No Worker is created or deployed. The current default-deny Worker requires reviewed identity verification and explicit pilot wiring before it could serve this contract. Publicly reachable ingress does not imply anonymous access.

An existing HTTPS reverse proxy could instead add a separate `/agent-hub/mcp` route, preserving its existing MCP route, only after confirming current serve/funnel configuration, path stripping, independent backend binding, and external reachability. A supplied hostname is not evidence of active public exposure. The installed Tailscale CLI could not load preferences during read-only status checks; current route configuration was not verified or changed. Do not reuse an unrelated service's authentication boundary or assume a private tailnet URL is reachable by Grok.

Before requesting live registration approval, confirm:

- Exact HTTPS endpoint, service owner, publicly reachable routing, and cost/usage limits; select one hosting route.
- Issuer and audience/resource, exact OAuth callbacks and client authentication methods copied from each registration, distinct client IDs, and allowed subjects. Request only the four diagnostic scopes.
- Exact existing Grok routine webhook URL, owner, fixed routine instruction, usage consequences, and a separately stored outbound bearer credential. The routine must fetch/check the request and reply through its authenticated MCP connection. Never put credentials in repository files or tool arguments.
- A backend-only fixed-target HTTP transport with cancellation, redirect rejection, secret storage, and explicit outbound authorization. The pilot does not expose a webhook URL argument.
- How Dots initiates/polls and whether automatic reception is required. Explicit polling is the implemented baseline; automatic reception needs a separately reviewed integration.

Creating credentials, changing scopes, publishing routes, contacting bots, deploying, or starting a persistent dispatcher requires separate approval. Existing Hermes settings and unrelated MCP services are untouched. An OpenAI-specific secure MCP tunnel is not assumed to provide a shared Grok ingress.
