# First Hermes connection contract

`HermesRuns.connect` accepts an explicitly approved loopback HTTP endpoint, a runtime-only standard API key, and a trusted `inspectIsolation` function. There is no default endpoint, Desktop backend fallback, credential file reader, startup command, profile creation, or daemon installation. The driver is not wired to a runnable real-worker entry point. Tests start only temporary localhost mock APIs.

The inspector must independently establish the exact endpoint, reviewed Hermes source commit, dedicated profile, effective tool count zero, disabled memory, isolated history, fixed model/provider resolution and disabled model fallback. Its evidence expires within five minutes. The driver has no built-in inspector because these facts have not been verified on a real isolated instance. A caller filling in booleans is not proof of those facts. Standard capabilities/toolset responses alone cannot establish all of them.

Connection and every create/get operation require fresh inspector evidence. The standard API must reject an unauthenticated capabilities request with 401, authenticate the runtime bearer key, advertise submission/status and durable retained idempotency, and list no enabled tools. Redirects are rejected; requests have finite timeouts and response-size limits. Evidence/capability failure blocks admission. The initial readiness expires within 30 seconds; reconnect/reverify before using a stale driver.

Tasks cannot configure tools, model, provider, endpoint, session, history or instructions. Create submits only fixed connectivity text plus `openai-codex` / `gpt-6.1-sol`. It omits session/history/previous-response identifiers so the standard API creates an independent run. A stable Hub key is sent as `Idempotency-Key`. Accepted IDs are journaled before polling. Completion requires exact fixed output and actual runtime model/provider match. Failed/cancelled/interrupted, unfamiliar status, response/model mismatch and lost responses require reconciliation; they do not establish that a remote execution stopped.

The mock HTTP roundtrip verifies requester submit → HTTP MCP → adapter → standard Runs create/get → Hub complete → requester MCP get. A separate mock HTTP test loses admission ACK, reopens the persistent receipt, reuses the same key and observes one admission. These are explicit result retrieval tests, not event-triggered Dots continuation or three-agent production integration.

## Approval and measurement before the first real request

1. Approve a new dedicated isolated Hermes profile and standard API listener at a specific loopback endpoint, without changing the existing profile/UI/cron. Specify runtime state/history directories separately from the public checkout.
2. Approve standard API authentication creation and runtime injection into this adapter only. Confirm key scope is the isolated API profile and document revocation; never copy Desktop authentication or publish the value.
3. Measure effective API agent tools as zero at the execution boundary, memory disabled, history isolated, fixed runtime model/provider, no fallback, exact source version, and durable idempotency/retention. Implement a trusted inspector tied to those measured facts; do not substitute empty request `tools` or a prompt promise.
4. Approve one fixed connectivity request to that API and its configured model provider: fixed text, no personal input, independent new session, concurrency one. Poll only its returned ID, and retrieve the Hub result explicitly with the authorized requester principal.
5. Separately approve production Hub hosting/private authentication and verified subject/scope mappings. Sites service credentials/identity compatibility remains unverified; absent that boundary, both production entry points stay 401.

Formal Events subscription/persistent delivery and Worker callback egress remain a separate decision described in [migration status](migration-plan.md). No live callback is needed for this first explicit-get roundtrip.

Source contract: the reviewed upstream commit's [standard API guide](https://github.com/NousResearch/hermes-agent/blob/f97608f178d1ffeca59860195ab7da295f7c8e5f/website/docs/user-guide/features/api-server.md) and implementation under `gateway/platforms/api_server*.py`. Successful mock evidence does not authorize real traffic.
