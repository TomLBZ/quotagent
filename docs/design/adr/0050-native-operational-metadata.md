# ADR-0050 Native operational metadata and scoped timelines
<!-- budget: 4096 bytes -->
Status: accepted

## Problem
The current host has separate provider, plugin, evidence and workflow views. Historical requirements also promise an operations summary and event timeline. Recreating old middleware files would obscure the actual native services.

## Decision
`system/observability` owns a GUI and periodic derived metadata snapshot from current services and ledger projections. Administrators see operational counts and coverage, never account bodies or cost models. Account event timelines contain only metadata from the current account and explicit team memberships; admin role does not confer cross-party timeline access. WebUI owns generic query windows, while observability authorizes and shapes rows. Snapshots are not model-visible facts and are not copied into model context. Any future model access must introduce a ledger-backed captured input.

## Consequences
Actual unavailable services/realms remain visible and totals declare coverage. Periodic snapshot writes are disposable derived output; ledger history is unchanged. Source reads still scan materialized projections, and metadata is a view of observed events rather than an uptime or delivery guarantee. The source whitelist is maintained with the owning runtime components.

## Alternatives rejected
| Alternative | Reason |
| --- | --- |
| Export whole account records to admin | Leaks private domain data unnecessary for operations. |
| Keep old SSR snapshot daemon | Reports a runtime that the product does not use. |
| Return zero when a source fails | Confuses unavailable data with a healthy empty workload. |

## Revisit conditions
Add disposable metric-source declarations when third-party plugins need richer operational metrics; keep private values out of aggregate metadata and preserve explicit source coverage.
