# Hosting migration preparation (not implemented)

## Current readiness

The local foundation proves the six task operations, strict fixed-payload schemas, server-supplied principal policy, persistent state, lease fencing, and mock-run/outbox recovery. Its tests do not establish production authentication, D1 consistency, effective Hermes tool restrictions, subscription security, or hosted HTTP compatibility. A separate review is checking the existing implementation; do not merge or deploy on the strength of this document.

The current runtime cannot be copied directly to a Worker-style Site: `node:sqlite`, local filesystem journals, `node:http` request/response transport, and synchronous transaction callbacks are Node-specific. The MCP callback currently assumes a synchronous Hub result. The real outbound Hub client and real Hermes Runs client are also absent; the adapter consumes injected test interfaces.

## Single authoritative task store

Refactor the six operation contracts and authorization rules into an async service that delegates complete atomic operations to one storage implementation. Keep request validation and authorization shared. Inject either SQLite storage for local development or D1 storage for a hosted instance. Do not add a second queue, mirror SQLite into D1, or dual-write task states. The Mac journal is only a recovery receipt containing task ID, fence, idempotency key, and run ID; the Hub database remains authoritative.

A generic `transaction(async callback)` shim is insufficient. The [D1 binding API](https://developers.cloudflare.com/d1/worker-api/d1-database/) provides prepared statements and a transactional `batch` whose ordered statements roll back together on failure. Build each operation as a static batch with SQL predicates, rather than reading state in JavaScript and later writing it. Await results in MCP tool callbacks. Do not attempt to carry BEGIN IMMEDIATE across separate remote awaits.

Proposed database constraints and execution rules:

- Preserve unique `(owner,request_key)` and stable event IDs. Persist immutable task type/destination and a canonical request fingerprint before extending the allowlisted task types.
- Add a unique partial index on destination for `running` and `waiting_approval`; this enforces the single unresolved execution slot in the database itself.
- Claim performs expiry quarantine, then one conditional `UPDATE ... RETURNING` of the oldest queued row only when no unresolved row exists. Fence increment and lease issuance belong to that update. Never return a successful claim from a preliminary SELECT.
- Heartbeat and completion predicate on task ID, verified worker assignment, current fence, current state, and nonexpired lease. Derive time at the server. Result replay must be authorized against immutable assignment and its successful completion fence.
- Cancel predicates on submitting principal, increments the fence, and records the transition. It must not release the execution slot for new admission while a remote run may still execute: a reviewed cancellation/reconciliation state model is needed before real workers.
- Record audit and outbox from the actual changed rows in the same batch, with an operation correlation ID or a tested database trigger design. A zero-row stale update must produce neither a false audit transition nor a notification. Do not use connection-scoped `changes()` across independent requests.
- Final read and response must be tied to the same operation; review D1 read-replication/session guarantees before allowing replica reads in authorization, claim, or completion.

Before calling this a D1 adapter, execute the shared operation suite against a local Worker/D1 emulator with concurrent claim attempts, forced batch rollback, completion/cancel races, lease-boundary timing, repeated result replay, restart, and outbox failure. Cloud D1 validation remains a separate approved step. The pinned SDK's Fetch/Worker transport must also be checked against the actual Sites runtime; use a Fetch request/response bridge or a compatible SDK transport rather than exposing Node HTTP objects.

## Real worker recovery gaps

`website/docs/user-guide/features/api-server.md` in the verified Hermes commit documents GET capabilities/toolsets, scoped Runs, and an Idempotency-Key retention period of 24 hours after last status update. Unknown-admission replay must not occur after the verified retention horizon: the worker needs a persisted admission timestamp/deadline and must quarantine uncertain work beyond that deadline. It also needs run-status normalization, durable leases during polling, safe journal permissions, revocation behavior, stop acknowledgement/reconciliation, and verified zero-tool execution. A test runner's `toolIsolationVerified` boolean is not a production trust boundary.

The real port, capabilities, auth behavior, and effective tool restriction remain unverified here. The separate read-only Hermes investigation should resolve these before implementation chooses an isolated runner configuration.

## Formal MCP Events

The existing outbox is an internal delivery foundation; it must not advertise Events support until the [official MCP Events contract](https://developers.openai.com/plugins/build/mcp-events) is implemented and tested.

Use the same authoritative D1 database for subscriptions and per-subscription delivery receipts. Preserve the original terminal event once, and create delivery receipts keyed by event ID and subscription ID; receipts track delivery only and never duplicate task states. Stop delivery on revoked principal access, unsubscribe, or expiry. An event cannot submit a task or resume an execution.

Needed protocol and security work:

1. Authenticated server discovery, events/list, events/subscribe, events/unsubscribe; strict terminal-state payloads containing only task ID and state. Expose an owner/task filter rather than caller-selected routing identities.
2. Principal-scoped deterministic subscription identity, requested lifetime handling, durable cursor/replay semantics, and per-delivery authorization rechecks.
3. A trusted configured destination allowlist plus HTTPS and address validation at each connection; block private/local addresses, prevent DNS-rebinding gaps, and forbid redirects. Validate verification traffic as strictly as event traffic. Until that boundary is proven, reject subscriptions instead of forwarding.
4. Fresh, single-use callback challenges and constant-time response comparison before subscription activation. Store signing secrets only in an approved secret store; never in logs or public source.
5. Standard Webhooks signatures over exact serialized bytes, stable event IDs, fresh timestamps on retries, bounded attempts/backoff, and response-specific termination (410/413). Receiver idempotency remains necessary.
6. Tests for forged identity, cross-owner subscription lookup, verification failure, duplicate subscribe, expiry/revocation, unsubscribe races, DNS/redirect rejection, signature checks, retry loss, and delivery restart.

No Site, D1 resource, credential, callback secret, subscription, plugin, or background worker has been created by this preparation. Schema and adapter implementation should follow the independent review's state-model findings first.
