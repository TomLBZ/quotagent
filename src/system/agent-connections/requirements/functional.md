# External agent and tool connections
<!-- budget: 16384 bytes, hard -->

Implementation: [Cordis service](../code/index.mjs),
[protocol adapters](../code/protocols.mjs), [UI](../client/connections.jsx).

## User behavior and ownership

- Any signed-in account can create multiple named MCP/A2A connections, edit the
  endpoint, disable/enable, discover capabilities, and remove its own connection.
  Removed connections keep their previous audit history; no active session,
  settings schema or assistant registration survives plugin disposal.
- Each connection registers a settings schema with `scope: account` and
  `ownerId`. Bearer tokens and optional JSON authentication headers are password
  fields in the shared settings service. Neither administrators nor another
  account inherit them. Endpoint URLs cannot embed credentials or common secret
  query parameters. Outbound redirects are rejected. An A2A card advertising a
  different origin requires a separately configured connection.
- MCP discovery records tools and JSON input schemas, resources, URI templates
  and prompt arguments. The UI provides forms for primitive tool arguments and
  JSON for complex schemas. Resource reads and prompt retrieval return actual
  server content. All tool calls require the shared action review.
- A2A discovery records the real agent card. Send, reply and cancel use the shared
  action review. Get-task reads status/history/artifacts for tasks owned by this
  account. An input-required status surfaces the agent's question, generates a
  notification and offers a reply carrying the same remote task/context IDs.
  Task refresh is manual; no background polling or push subscription is claimed.
- Every remote result is marked external and is ledger-backed before the
  assistant receives it. Generic tools are labeled `read` or `proposal` for the
  shared agent runtime policy. Inputs are explicit; the adapter does not receive
  or attach procurement snapshots, costs or other account data automatically.
- Failed transports/refusals and MCP `isError` results fail actions. A2A failed or
  rejected task responses fail the call; input-required is a valid interrupted
  task. Interrupted/ambiguous effectful calls are marked uncertain. There is no
  automatic replay of a possibly completed effect; shared action approval is
  idempotent. Changing the reviewed endpoint/protocol/transport/card path requires
  a new review.

## Protocol decisions, researched 2026-09-25

The current official MCP TypeScript line is v2, implementing revision
2026-07-28. This plugin uses `@modelcontextprotocol/client@2.1.0` with explicit
automatic version negotiation, since the SDK's default remains legacy.
Streamable HTTP supports JSON and request-scoped SSE responses; explicitly
selected legacy SSE uses the SDK's legacy transport. Local process stdio is a
separate infrastructure concern and is not exposed as a remote user connection.
Sources: [official SDK](https://github.com/modelcontextprotocol/typescript-sdk),
[MCP transport specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports),
[SDK v2 reference](https://ts.sdk.modelcontextprotocol.io/v2/).

The official A2A JavaScript SDK `@a2a-js/sdk@1.2.1` implements A2A1.0.0 and offers
v0.3 compatibility. The adapter enables that compatibility and card-selects
JSON-RPC or HTTP+JSON; it does not offer gRPC. New messages use
`returnImmediately: true`, then user-triggered task queries retrieve progress.
Agent-card discovery defaults to `/.well-known/agent-card.json`, with a custom
path option. OAuth consent, extended authenticated agent cards and push
notification registration are not implemented. Static bearer/header credentials
support services that accept them. Sources:
[A2A1.0 specification](https://a2a-protocol.org/v1.0.0/specification/),
[official JS SDK](https://github.com/a2aproject/a2a-js),
[client factory](https://github.com/a2aproject/a2a-js/blob/main/src/client/factory.ts).

## Runtime contract

Injects `web`, `store`, `accounts`, `settings`, `actions`, `notifications`; provides
`connections`. Assistant registration is deferred through `ctx.inject`.
All routes, navigation, handlers, tools, dynamic schemas and HTTP clients have
Cordis-owned disposers. Source: [service](../code/index.mjs).

| Interface | Behavior |
|---|---|
| `GET /connections` | Own nondeleted connections and stored discovery |
| `POST /connections` | Create; optional credentials sent to settings only |
| `GET /connections/:id` | Own connection, recent calls and tasks |
| `POST /connections/:id` | Edit/enable/disable |
| `DELETE /connections/:id` | Close session, retire record/schema |
| `POST /connections/:id/discover` | Refresh real MCP catalog or A2A card |
| `POST /connections/:id/invoke` | `{operation,input}`; reads return results, effects return pending approval |
| `connections.invoke` action kind | Revalidate destination, execute exact reviewed payload |

Operations: MCP `tool{name,arguments}`, `resource{uri}`, `prompt{name,arguments}`;
A2A `send{message,taskId?}`, `query{taskId}`, `cancel{taskId}`. Task IDs exposed to
the UI are local account-owned IDs; opaque remote IDs stay in task records and
protocol payloads, so remote IDs containing `/` work with the host router.

Additive record events use the existing workspace record envelope, retaining
the complete new record. No kernel/QEP event semantics are changed:

| Collection | Events (all prefixed `connections/`) |
|---|---|
| `agent-connections` | `created`, `updated`, `deleted`, `discovered`, `discovery-failed` |
| `connection-calls` | `call-started`, `call-completed`, `call-failed` |
| `connection-tasks` | `task-observed` |

Shared action and notification events are owned by those plugins. Secret header
values are redacted if echoed in remote responses/errors. Source:
[settings](../../settings/code/index.mjs), [ledger adapter](../../workspace-store/code/index.mjs).

## Executable evidence

`node src/system/agent-connections/tests/smoke.mjs` uses real Cordis, the existing
Python ledger and official SDK servers over loopback HTTP. It checks discovery,
MCP2026 streamed SSE responses, legacy SSE, real tool/resource/prompt results,
preapproval nonexecution, duplicate approval, tool errors, A2A card/send/query,
input-required continuation, artifacts and cancellation, private credentials,
notification creation, restoration and plugin disposal. It is protocol evidence,
not a claim of interoperability with every hosted provider. Source:
[smoke](../tests/smoke.mjs), [fixtures](../tests/fixtures.mjs).
