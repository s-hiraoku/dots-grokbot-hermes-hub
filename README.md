# Dots · Grok Bot · Hermes Agent Hub

Local phase-one foundation for mediating requests, assignments, progress, and results. Each agent retains its own decisions. No existing jobs, calendars, mail, memory, cron, or agent configuration are changed.

## Reproduce

Requires Node 24. `npm ci && npm run check && npm run lint && npm run typecheck && npm test` exercises a dummy requester, outbound adapter, mock independent Runs service, persistent SQLite queue, and transactional outbox. `node src/server.js` starts a loopback HTTP MCP endpoint that returns 401 until a verified authentication boundary is implemented. It does not mint credentials or provide an anonymous mode.

Only `connectivity_check` is accepted, with an idempotency key and no user text, agent name, shell command, URL, or personal data. The fixed successful output is `Agent Hub connectivity check completed.` Concurrency is one for Hermes. No real agent is contacted by these tests.

See [architecture and approval gates](docs/architecture.md). This is an implementation foundation, not a production connection or deployment.

`typecheck` currently checks the public declaration contract only, not implementation JavaScript. The two-connection claim test is sequential; true simultaneous contention remains a validation gate. Long-running real execution, automatic heartbeat scheduling, remote stop confirmation, and approved gate release remain unimplemented.
