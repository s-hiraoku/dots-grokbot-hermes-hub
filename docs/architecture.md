# Scope and boundaries

Dots handles personal context, consultation, important-mail decisions, mark-read after notification, and schedule summaries. Grok retains its existing connpass job and future Calendar/browser/long-task work. Hermes handles development experiments, MCP, and Skills. These roles are design context only: this version routes the single harmless task to Hermes using server-side principal policy. Results never submit new tasks.

## Contracts

The SDK-backed stateless HTTP `POST /mcp` exposes submit, claim, heartbeat, complete, get, cancel. Strict schemas reject extra fields. `submit` accepts `{task_type: "connectivity_check", request_key}`. `claim` accepts `{}`. `get` and `cancel` take `{id}`. `heartbeat` takes `{id,fence,run_id?}`. `complete` takes `{id,fence,state,result}`, with only fixed success/failure values. Tool errors are generic. No caller supplies a destination or trusted agent identity.

A trusted authentication verifier must supply `{subject,operations,destination? ,worker?}`. The default verifier returns no identity. Request headers, including Sites identity headers, are not trusted on an arbitrary transport. A future Sites adapter must verify the hosting boundary and map its authenticated identity to policy. A service credential must not masquerade as a user. No public/no-auth fallback exists.

## Queue and recovery

SQLite uses BEGIN IMMEDIATE transactions; D1 migration must preserve equivalent atomic SQL and cross-request concurrency semantics before deployment. This synchronous SQLite implementation is not a D1 adapter. Claim increments a fencing token and grants a 30-second lease. A second database connection cannot claim active work. Expired running work becomes waiting_approval with a new fence; automatic resubmission is prohibited. Cancel also increments the fence and retains an open execution slot for claimed work until reviewed remote reconciliation; it cannot admit another task merely because the local status is cancelled. Final status, audit entry, and outbox entry commit together. Request keys are scoped to the submitting principal; output event IDs remain stable across retries. Heartbeats persist a run ID and reject conflicting IDs.

The adapter accepts an injected Hub client and verified run service; it has no arbitrary HTTP endpoint configuration or shell execution. Journal must be persistent (`Journal`), written before run admission. An unknown admission response is reconciled by the same Runs idempotency key; a known run is read by ID. Operators must resolve expired leases before more work is admitted. This first version has no approval-resolution API: waiting_approval requires a reviewed implementation, not ad-hoc database edits. Cancel fences Hub completion but cannot stop an already accepted remote run until cancellation semantics are connected. An open slot stays blocked after cancellation; no release API is provided yet.

## Events

The transactional outbox is tested with an injected sink, including a lost acknowledgement and duplicate delivery. Delivery is at least once; receiver deduplication is required. The sink receives only task ID and terminal state. It cannot cause task submission.

Actual ChatGPT MCP Events are intentionally not advertised or registered. The [official contract](https://developers.openai.com/plugins/build/mcp-events) requires events/list, events/subscribe, events/unsubscribe, verified callbacks, durable principal-scoped subscriptions, Standard Webhooks signatures, endpoint validation at connection time, and bounded retry rules. These remain a separate integration gate; an outbox alone is not MCP Events support. No caller-controlled webhook forwarding is implemented.

## Hermes source verification

The local checkout matched commit `f97608f178d1ffeca59860195ab7da295f7c8e5f`. The document exists at `website/docs/user-guide/features/api-server.md` (the earlier `docs/...` locator was incomplete). It documents independent Runs, API-key authentication, and scoped durable idempotency with finite retention. `gateway/platforms/api_server_runs.py` implements /v1/runs, scoped Idempotency-Key admission/replay, and independent run IDs. `gateway/platforms/api_server.py` lists /v1/capabilities and /v1/toolsets. Agent creation selects platform toolsets from configuration; the API toolset regression test explicitly includes terminal by default. Passing `tools: []` to our mock is not evidence that the real Runs API enforces the same restriction.

A listener at the previously reported port was not confirmed during this run. No auth files/values were read, no API call was sent, and no existing profile was modified. The real runner is blocked until tool exclusion, memory/session isolation, actual bind address and authentication are verified. The `toolIsolationVerified` interface is a test seam, not a security attestation for arbitrary production runners.

## Required approvals and next steps

1. Approve an isolated Hermes configuration and its exact tool policy (zero shell, filesystem, browser, MCP, delegation, cron, personal memory), independent Runs sessions, loopback endpoint, identity scope, and fixed connectivity payload. Validate actual effective tool lists and negative execution tests before enabling a real adapter. Keep the existing desktop profile unchanged.
2. Approve a private Sites target and D1 database, including any costs. Implement a D1 storage adapter and prove atomic claim/fencing with the hosted runtime. Verify user and worker/service identities remain distinct, including OAI-Sites-Authorization interoperability.
3. Approve issuance/storage of minimal credentials separately: requester submit/get/cancel/events; worker claim/get/heartbeat/complete. No new persistent credential or OAuth token has been issued.
4. Approve outbound Mac-to-Hub traffic, fixed target URL, fixed task data, and any automatic background worker. Current adapter tests run manually and locally.
5. Approve plugin registration and fixed verified event destinations after callback/signature/subscription security tests. Then perform a real fixed-payload roundtrip for each intended principal, revocation, restart, stale completion, notification retry, and cancellation checks.

SDK choice: official Tier-1 TypeScript SDK, registry version 1.32.0, pinned in package-lock.json. [Official SDK catalog](https://modelcontextprotocol.io/docs/2026-07-28/sdk). SQL core and trusted-principal policy are separate from transport for later hosting migration.

See [hosting migration plan](migration-plan.md) for the runtime boundary, one-store D1 design, and MCP Events prerequisites.
