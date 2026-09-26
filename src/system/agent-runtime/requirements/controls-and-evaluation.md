# Native provider controls, context and evaluation
<!-- budget: 8192 bytes, hard -->

Owner: agent-runtime native provider/assistant children; agent-workflows shares context and provider services. ADR-0038 defines additive receipts and admission/replay semantics. Existing controls, usage and pinned workspace behavior from `871ee88` remain required. Status: native and isolated GUI acceptance recorded in `docs/work/evidence/g6-auditable-runtime.md`; public rollout remains the root release task.

| Retained requirement | Native acceptance |
|---|---|
| FR-RUNTIME-003/007/008 | Bounded realm diagnostic timeline, disposable prefix subscriptions/deduplication, aggregate admission/circuit/run numbers without source bodies. Read views do not write records. |
| FR-RUNTIME-004 | Integer-micro-unit cost reservations and rolling window/run limits; actual usage vs reservation and known vs unknown price are explicit. Oversized request and depleted-window refusals have different next actions. |
| FR-RUNTIME-005 | Consecutive failures open an account/connection circuit; cooldown gives one bounded probe; outcome and retry time are visible. |
| FR-RUNTIME-006 | Host/account concurrency, bounded queue, explicit admission/queue timeout, bounded eligible HTTP retry, abortable waits and injectable monotonic decision clock. |
| FR-RUNTIME-009 | Explicit account request identity deduplicates in-flight and durable results. Failure replays as failure, payload conflict rejects, interrupted ambiguous request does not auto-resend. |
| FR-AGENTRT-006, SUPPLEMENT-028 | Declared group/history/memory/item/payload limits. Ledger receipt distinguishes omitted count/bytes, empty source, degraded assembly and next action; no broken tool transcript from truncation. |
| FR-AGENTRT-002 | Preserve reviewed human policy memory and own/pinned workspace reconstruction; do not revive contradictory session-never-persist mechanics. |
| FR-EVAL-001/002 | Native recorded-run assertion scenarios and deterministic offline assertion replay. Historical S1–S4 remain explicitly synthetic and source-labelled; fresh model execution never labelled deterministic. |
| FR-EVAL-003, SUPPLEMENT-034 | Source-linked baseline counts, durations, interventions and costs from actual events; unknown business observations remain unknown, no invented wins. |
| FR-EVAL-004 | Append-only counterexample proposals require explicit human activation and have no deletion/overwrite endpoint. |
| FR-EVAL-005 | Owned by G2 commercial-workbench history: supplier/item/currency observations, distribution, quoted lead mean and deviation counts; no ranking. Source `src/domain/commercial-workbench/code/service.mjs`. |
| GOAL-20260926-01..04/08 | Preserve native pause/stop/resume/steer and token charts. Add typed reason, context and budget facts without hiding existing controls. |
| CURRENT-022, SUPPLEMENT-034, NFR-PERF-004 | Public experience release check and observed baseline evidence; historical numerical performance assumptions are not declared passed without measurement. |

Source modules: `code/provider-controls.mjs` (native child/service), `code/provider-policy.mjs` (pure arithmetic/state helpers), `code/context.mjs` (auditable assembly), `code/product-evaluation.mjs` (native child), existing provider/usage/conversation integration. UI owned here extends AI usage with runtime and evaluation panels; native configuration uses existing settings schema components. Host and WebUI core remain generic and unchanged.

Settings must name currency, tariff provenance/date and actual provider/model binding. Missing usage/pricing is unknown. Cost is an explicit estimate, not an invoice. No provider credentials enter trace/cost/evaluation metadata. Scope is account-owned model activity; current party workspace remains pinned on saved runs across reload and navigation switches.

Executable checks: loopback actual HTTP provider checks plus real Cordis/store restart; existing usage/controls checks; workflow workspace pinning/cancellation; read-only deterministic recorded-run assertions and human counterexample approval; native GUI configuration→model run→typed receipt/context omissions→cost coverage/evaluation. Commands and observed results are in the linked evidence. Historical tasks without a saved role cannot resume; role changes require stopping and starting a new task. Prior transcripts must match both saved role and workspace, with exclusions ledger-recorded. Safe GUI links contain only run/case/RFQ IDs and tab keys.

Exact provider boundary evidence follows ADR-0043: new requests declare
`json-key-sorted/v1`; each actual attempt records `agent/model-dispatched` with
call/run/attempt, SHA256 and UTF-8 byte count before reusing that exact wire string.
`node src/system/agent-runtime/tests/dispatch.mjs` verifies actual HTTP bytes against
ledger reconstruction. Older calls remain boundary-unmeasured.
