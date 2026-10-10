# MVP acceptance — local implementation versus live connection

Status: local fixed diagnostic contract implemented; live MVP NOT accepted. Hub/SQLite stay on Mac mini, Auth0 supplies identity, and existing model-agent MCP stays unchanged. This checklist does not authorize deployment or external calls.

| Gate | Evidence / remaining work |
|---|---|
| Fixed bidirectional contract | Mock SQLite/D1 and signed OAuth MCP tests cover both directions; ping/pong only. |
| Identities and permissions | Distinct verified clients plus allowed subjects; four `hub:ping_*` scopes only. Actual issuer, resource/audience, callbacks and client authentication method unconfirmed. Shared-human subject with distinct explicitly bound clients is supported and tested; exact verified issuer/subject/client selects one policy, never a union. Duplicate pairs and mixed bound/unbound legacy entries are rejected. |
| Configuration | `config/pilot.example.json` contains placeholders. `node scripts/pilot-preflight.mjs` rejects it. A valid offline schema still returns `ready:false`; it does not start a listener or authorize live use. |
| Local entrypoint | Existing loopback server defaults to denial; Auth0 verifier, peer registry, OAuth metadata and PingService still need explicit production wiring. Port availability and persistence/backup/retention need verification. |
| Public HTTPS | Dedicated relay/domain pending approval. Cloudflare is relay only, not Hub/DB hosting. Tailscale status failed to load preferences; no bypass. Both clients' external reachability untested. |
| OAuth/MCP compatibility | Existing OAuthResource accepts Auth0 standard tenant issuers and exact `/mcp` audience only; custom issuer domains or `/agent-hub/mcp` require code and tests. Proxy must route protected-resource metadata and preserve Authorization. Check exact callbacks, PKCE, client auth, audience/resource forwarding, consent scopes, SSE/reconnect and token expiry. |
| Grok wake | Real fixed-target transport absent. Confirm routine instruction, URL, secret handling, usage and cancellation. HTTP 200 is acceptance only. Account-shared connection is not exclusive Bot identity. |
| Dots reply | Explicit polling works in mocks; automatic reception and actual invocation unverified. No recurring polling configured. |
| Failure/stop | TTL, correlation, dedup, epoch gates, restart and one-attempt outbox verified. Sent bytes cannot be retracted. Unknown wake receipt parks without auto-retry. |
| Hermes / Claude | Separate candidate work NOT integrated or accepted; a direct collector is not evidence of actual Hermes execution. |
| Cost | Auth0 must remain USD 0 after trial. Account's post-trial entitlements need owner confirmation; no paid feature or upgrade fallback. Model/API/routine charges need independent approval. |

## Auth0 free-only operation plan

The user-selected ceiling is 1,000 M2M token acquisitions per account billing month, shared across consumers; it is not a claim that this account currently has that entitlement. The diagnostic Dots/Grok design uses user OAuth and requires no new M2M grant. Do not add M2M to solve callback problems.

If a separately approved adapter eventually needs M2M, use one on-demand token broker: reuse tokens only within their verified expiry minus safety margin; collapse simultaneous refreshes into one in-flight request; never mint on a polling tick; allow zero automatic token-request retries. Before each request atomically reserve from a durable account-wide monthly counter, counting failed/unknown attempts conservatively. Never reset a counter on restart; reset only at the verified billing boundary. External consumers and dashboard totals must be reconciled before claiming quota remains. Unknown entitlement, unresolved totals, exhausted quota or unavailable free features stops affected work and records a local notification for the owner. Do not silently upgrade or purchase overages.

This is an operating plan and schema constraint, not a implemented token broker or proof of provider quota enforcement. Notification delivery is itself unconnected; until an approved channel exists, report the stopped state in local status. Actual token acquisition, external dashboard reads, credential storage and monthly boundary configuration remain approval gates.

Preflight accepts no token, secret or webhook field and outputs generic diagnostics without echoing configuration. Keep filled operational files outside the public repo. Before live approval, present exact hostname, relay-visible data, Auth0 issuer/audience, four scopes, copied callbacks, runtime storage/launch method and independently approved provider costs.

## Identity policy migration

Each verifier pins one issuer and audience; issuer is validated before subject/client policy selection. Existing single-subject/client entries remain valid. To add another client for the same human, enroll an explicit separate entry with its own clientId and minimal operations. Duplicate pairs and any bound/unbound mixture for a repeated subject fail construction. Auth0 continues requiring client binding for every entry; missing or conflicting signed azp/client_id fails authentication. No token agent/role field supplies authority. Local subject stops apply to every client; durable client stops affect only that client, while peer traffic is blocked if either peer is stopped. Authorization edits still invalidate all old diagnostic epochs.

Legacy task ownership is subject-based and intentionally not migrated here. The pilot clients receive only diagnostic scopes and no legacy task permissions; diagnostic ownership and dedup are subject/client-based. The registry rejects shared-subject entries containing any non-diagnostic operation or worker/task routing metadata. Broader client isolation for legacy task types requires a separate reviewed change before granting those permissions.
