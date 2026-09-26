# ADR-0031 Controllable agent work and plugin-owned presentation
<!-- budget: 8192 bytes, hard -->
Status: accepted

## Problem

The synchronous assistant has no durable in-progress state or user controls, while
the workroom already supports supervision. Flat navigation hides the primary agent
interaction among setup tools. Provider ledgers contain usage but users cannot
inspect it. Sources: `product-assistant.mjs`, WebUI `core.jsx`, `product-ai.mjs` and
the user enhancement objective 2026-09-26.

## Decision

The native assistant owns durable conversation runs with pause, stop, resume and
steering. Model calls are abortable; completed tool effects survive interruption.
An uncertain interrupted tool is surfaced instead of silently repeated. All added
guidance and checkpoints append through existing workspace record semantics;
exact events/acceptance belong to the assistant's `requirements/controls.md`.
The ledger envelope and QEP semantics remain unchanged.

The provider usage child adds `agent/model-usage`: normalized actual token counts,
call identity, timestamps and terminal status. Historical provider events remain
readable without migration. Unknown consumption remains unknown. Account views
and administrator aggregation contain usage metadata, not conversation content.

Native workspace-styles and user-guide plugins own layouts, grouping, first-use
guides and role documentation. Generic WebUI slots and reversible presentation
contributions expose these capabilities without importing business logic. Account
settings persist styles; guide state is account/role scoped. The assistant plugin
owns the primary conversation page. Only one conversation composer is mounted in
the chosen presentation.

## Consequences

Users can supervise work and retain progress after a reload; owners remain visible
as disposable plugins. Durable checkpoints add writes and require explicit handling
of uncertain tool execution. A provider may still charge for an aborted request;
unreported usage is not estimated. Additional documentation consolidation must
preserve each compatible business requirement and its implementation evidence.

## Alternatives rejected

| Option | Reason |
|---|---|
| Only abort the browser request | Server work could continue without visible control |
| Restart the whole conversation on resume | Repeats draft effects and discards progress |
| Bake role navigation into WebUI | Couples the generic shell to business plugins |
| Estimate missing tokens as zero | Misrepresents actual provider reporting |

## Revisit conditions

Review checkpoint execution when tools gain provider-specific idempotency receipts,
or the provider supports resumable streamed responses. Revisit presentation APIs
when new plugins need capabilities that cannot fit generic reversible contributions.
