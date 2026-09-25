# Agent connections
<!-- budget: 4096 bytes, hard -->

Account-owned external MCP servers and A2A agents, implemented as a native Cordis
plugin. Open **Agent connections → Add connection**, enter the service endpoint,
optionally add credentials, then **Discover capabilities**. MCP exposes tools,
resources and prompts; A2A exposes an agent card and tracked tasks. Tool calls,
task messages/replies and cancellation open **Review actions** before execution.
Sources: [service](code/index.mjs), [clients](code/protocols.mjs),
[React page](client/connections.jsx).

Each connection has private account settings. Bearer tokens and custom header JSON
use the settings credential store, never connection records. Discovered metadata,
call inputs/results and A2A task observations are appended to that account's
ledger. The assistant exposes four tools to discover, read, and propose calls;
remote results carry `trust: external`. No workspace snapshot is attached to an
external request. Source: [requirements](requirements/functional.md).

Supported transports: MCP Streamable HTTP with JSON/SSE replies and explicit
legacy HTTP+SSE; A2A JSON-RPC and HTTP+JSON selected from the agent card, with
SDK v0.3 compatibility. HTTP calls have finite timeouts. This plugin does not
launch stdio processes, implement OAuth consent, accept A2A push webhooks, or
provide gRPC. A2A task progress is retrieved with **Refresh task**; an
`input-required` task offers a reviewed reply within the existing task/context.
Source: [protocol implementation](code/protocols.mjs).

Run the real protocol smoke from the repository root:

```sh
node src/system/agent-connections/tests/smoke.mjs
```

For a GUI demonstration, start local deterministic protocol services:

```sh
QUOTAGENT_FIXTURE_PORT=8621 node src/system/agent-connections/tests/fixtures.mjs
```

Use `http://127.0.0.1:8621/mcp` for MCP or `http://127.0.0.1:8621` for A2A;
the test-only bearer token is `local-fixture-token`. Legacy MCP SSE is `/sse`.
These services run official SDK protocol handlers. They are labeled local
fixtures, calculate known values and ask a fixed delivery question; they do not
claim to be AI or contact real suppliers. The product backend must be on the
same machine as these loopback fixtures. Source: [fixture server](tests/fixtures.mjs).
