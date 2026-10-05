# Dots · Grok Bot · Hermes Agent Hub

Local foundation for mediating requests, assignments, progress and results. Each agent retains its own decisions. No existing jobs, calendars, mail, memory, cron or agent configuration are changed.

## Reproduce

Node 24: `npm ci && npm run typecheck && npm run lint && npm test`.

Tests exercise a fixed requester → HTTP MCP → async task service → outbound adapter → mock independent Runs roundtrip with either SQLite or local Worker/D1. They also exercise lease renewal/failure, durable recovery, simultaneous claims, cancelled execution gating, transactional audit/outbox, and offline callback signatures/retries. Miniflare telemetry and Worker outbound access are disabled. `typecheck` checks the production TypeScript implementation and schema, not only declarations.

`node src/server.ts` starts a loopback Node HTTP MCP endpoint that returns 401 until a verified authentication boundary is implemented. `npm run build` produces the analogous Worker bundle in ignored `dist/`; its default verifier also denies all requests. Neither entry point mints credentials or provides an anonymous mode.

Only `connectivity_check` is accepted, with an idempotency key and no user text, agent name, shell command, URL or personal data. The fixed successful output is `Agent Hub connectivity check completed.` Hermes concurrency is one, including unresolved cancelled runs. Tests never contact a real agent or callback.

See [architecture and approval gates](docs/architecture.md) and [hosting and Events status](docs/migration-plan.md). This is locally validated code, not a deployed three-agent connection.
