# Functional requirements grouped by plugin
<!-- budget: 24576 bytes, hard -->

Source: definition rows in `docs/work/functional-requirements*.md` and each plugin's
`requirements/README.md`; inspected 2026-09-25. Ownership coverage is **166/166**,
with zero missing, undefined or multiply assigned historical IDs. This inventory
records responsibility; the [runtime contract](runtime-contract.md) defines current
product behavior and acceptance, independently of older completion statuses.

## New product requirements

| User requirement | Sole functional owner | Acceptance |
|---|---|---|
| Agent helps both sides read, extract, compare, negotiate and remember preferences | system/agent-runtime | Runtime contract 3 |
| Reusable modern framework UI and accessible navigation | system/webui | FR-UX-005, Runtime contract 6 |
| Real Cordis composition and effects | system/runtime | FR-USREQ-003, Inspect host/product.mjs, unload lifecycle |
| Persistent account type; separate server administration | system/accounts | Runtime contract 1 |
| Natural-language themes/widgets, actual generated utility code, skills, market and promotion | system/plugin-studio | Runtime contract 4–5; ADR-0028; generated-utility-live.json |
| Complete quotation process and differentiated user experience | domain/procurement | Runtime contract 2, 7 |
| Account facts and model context reconstructible from ledger; public QEP exchange | system/workspace-store | Replay and public workflow evidence |
| Stable background refresh | system/webui | Plugin workspace contract; focus and mounted cards preserved |
| Unique extension lineage and installed marketplace state | system/plugin-studio | Plugin workspace contract; active personal/global selection and idempotent installs |
| Complete native and repository plugin inventory | system/plugin-manager | Plugin workspace contract; actual fibers and clear repository-only status |
| Persisted credentials, preferences and editable configuration | system/settings | Plugin workspace contract; masked credentials, inherited defaults and account overrides |
| Immutable account uploads and downloads | system/file-store | Plugin workspace contract; retained provenance and account ownership |
| Source review, mapping and private draft import | domain/ingestion | Plugin workspace contract; contractor RFQ and supplier quote from real files |
| Traditional format parsers and optional AI extraction | domain/ingestion-engines | Plugin workspace contract; email/Excel/CSV/document fixtures and real model |
| Public experience evaluation | system/eval | Independent evaluation evidence |
| Recoverability, documentation, individual commit/push batches | system/repo-gate | Ignored state/handover; versioned specs and git refs |

The first AI level assists the customer's quotation work through account context,
real model calls and domain tools. The second creates personal capabilities: runtime
UI extensions, executable pure JavaScript utilities and reusable assistant skills.
Both have explicit plugin owners. Sources: [agent runtime](../../src/system/agent-runtime/code/product.mjs),
[domain tools](../../src/domain/procurement/code/index.mjs), and
[studio](../../src/system/plugin-studio/code/product.mjs).

## Current product integration groups

The current [host](../../host/product.mjs) combines capabilities into the following
product plugins. Historical providers listed below retain the detailed requirement
ownership in the following table; listing a family here does not mount its old code
or assert that every advanced historical behavior has been reimplemented.

| Current product owner | Historical capability families grouped into its product experience | Current implementation boundary |
|---|---|---|
| domain/procurement | RFQ/intake, quotes/pricing/costs, compare, clarify/negotiation, commitments/change, export | Structured drafts and shared workflow, private supplier costs, comparisons, messages, orders/changes and CSV; advanced capacity/sourcing/term-library engines retain historical ownership |
| system/agent-runtime | Context, memory, harness and client decision assistance | Real provider, tool loop, explicit preference memory, pasted-text extraction, business drafts and contextual advice |
| system/plugin-studio | User plugins, market and personal evolution | Themes/reference widgets, model-authored pure utility functions, on-demand workflow skills, install/unload/publish/global promotion; no arbitrary system-code mutation |
| system/accounts | Client identity and server administration | One client role, separate admin accounts, current-account settings and functional capability permissions |
| system/workspace-store | Ledger/QEP, projections and cross-account delivery | Existing Python kernels, account record replay and explicit public record exchange |
| system/webui | GUI, reusable controls and client navigation | Generic React shell/registry and HTTP transport; feature pages remain owned by their plugins |
| system/settings | Plugin configuration and preferences | Schema-owned UI, persisted defaults/overrides, private credentials; actual consumers include provider, assistant, WebUI and ingestion |
| system/plugin-manager | Runtime discovery and lifecycle | Actual native/child fibers, repository-only inventory and managed enable/disable |
| system/file-store | File IO | Account-owned immutable uploads, downloads and ledger metadata |
| domain/ingestion | Intake and editable drafts | File source preview, column mapping and private procurement draft import |
| domain/ingestion-engines | Email/table/document intake and information extraction | Individual email/Excel/CSV/document parsers and optional actual model extraction |

Launcher/composition belongs to system/runtime. Evaluation and repository-operation
requirements remain owned by system/eval and system/repo-gate. Historical mail,
retention, capacity and similar specialized plugins are not automatically part of
the new product host; their previous checks are not current product evidence.

## Existing requirements (all owned)

| Owning plugin | Existing requirement identifiers |
|---|---|
| domain/advice | FR-ADV-001, FR-USREQ-012 |
| domain/authority-band | FR-AUTH-001 |
| domain/bid-heuristics | FR-VIZ-001 |
| domain/capacity | FR-CAP-001, FR-CAP-002 |
| domain/change | FR-CHANGE-001, FR-CHANGE-002 |
| domain/clarify | FR-CLARIFY-001, FR-CLARIFY-002, FR-CLARIFY-003 |
| domain/commitments | FR-AWARD-001, FR-AWARD-002, FR-AWARD-003 |
| domain/compare | FR-COMPARE-001, FR-COMPARE-002, FR-COMPARE-003 |
| domain/costmodel | FR-COST-001, FR-COST-002, FR-COST-003 |
| domain/deviation | FR-DEV-001, FR-DEV-002 |
| domain/export | FR-COMPARE-004, FR-UX-003 |
| domain/faq | FR-CLARIFY-004 |
| domain/gate-timeline | FR-GATE-001, FR-GATE-002 |
| domain/guard | FR-GUARD-001, FR-GUARD-002, FR-GUARD-003, FR-GUARD-004, FR-GUARD-005 |
| domain/intake | FR-INTAKE-001, FR-INTAKE-002, FR-INTAKE-003 |
| domain/negotiation | FR-NEGO-001, FR-NEGO-002 |
| domain/price-history | FR-PRICE-003 |
| domain/pricing | FR-PRICE-001, FR-PRICE-002 |
| domain/quote-prepare | FR-QUOTE-001 |
| domain/quotes | FR-NORM-004, FR-RFQ-006 |
| domain/rfq | FR-RFQ-001, FR-RFQ-002, FR-RFQ-003, FR-RFQ-004, FR-RFQ-005 |
| domain/rfq-deadline | FR-RFQ-008 |
| domain/sourcing | FR-RFQ-007 |
| domain/supplier-scorecard | FR-EVAL-005 |
| domain/sync | FR-QEP-007 |
| domain/terms | FR-TERMS-001, FR-TERMS-002 |
| system/admin | FR-ADMIN-001, FR-ADMIN-002, FR-ADMIN-003, FR-ADMIN-004, FR-ADMIN-005, FR-ADMIN-006, FR-ADMIN-007, FR-ADMIN-008, FR-ADMIN-009, FR-ADMIN-010 |
| system/agent-runtime | FR-AGENTRT-002, FR-AGENTRT-006, FR-AGENTRT-007 |
| system/approval | FR-APPROVE-001, FR-APPROVE-002, FR-APPROVE-003, FR-UX-001 |
| system/audit-hook | FR-RUNTIME-003 |
| system/budget-guard | FR-RUNTIME-004 |
| system/canary | FR-EVOLVE-005 |
| system/circuit-breaker | FR-RUNTIME-005 |
| system/config | FR-CONFIG-001, FR-CONFIG-002, FR-USREQ-009 |
| system/eval | FR-EVAL-001, FR-EVAL-002, FR-EVAL-003, FR-EVAL-004 |
| system/evidence | FR-EVIDENCE-001, FR-EVIDENCE-002, FR-EVIDENCE-003, FR-EVIDENCE-005, FR-EVIDENCE-006 |
| system/evolution | FR-EVOLVE-001, FR-EVOLVE-002, FR-EVOLVE-003, FR-EVOLVE-004, FR-EVOLVE-006, FR-EVOLVE-007, FR-USREQ-010 |
| system/governor | FR-RUNTIME-006 |
| system/idempotency-guard | FR-RUNTIME-009 |
| system/kernel | FR-EVT-001, FR-EVT-002, FR-EVT-003, FR-INTEG-001, FR-LEDGER-001, FR-LEDGER-002, FR-LEDGER-003, FR-LEDGER-004, FR-PLUGIN-004, FR-QEP-001, FR-QEP-002, FR-QEP-003, FR-QEP-004, FR-QEP-005, FR-QEP-006, FR-QEP-008 |
| system/kernel-bridge | FR-INTEG-004 |
| system/mail | FR-INTEG-003, FR-MAIL-001, FR-MAIL-002 |
| system/market | FR-MARKET-001, FR-MARKET-002, FR-MARKET-003, FR-MARKET-004, FR-MARKET-005, FR-MARKET-006, FR-USREQ-008 |
| system/norm | FR-NORM-001, FR-NORM-002, FR-NORM-003 |
| system/observability | FR-RUNTIME-007 |
| system/ops-view | FR-UX-004 |
| system/projection | FR-RFQ-009, FR-UX-002 |
| system/relay | FR-INTEG-002 |
| system/repo-gate | FR-USREQ-007 |
| system/retention | FR-EVIDENCE-004 |
| system/runtime | FR-USREQ-003, FR-PLUGIN-001, FR-PLUGIN-002, FR-PLUGIN-003, FR-RUNTIME-001, FR-RUNTIME-002 |
| system/storage | FR-STORAGE-001, FR-STORAGE-004, FR-STORAGE-006 |
| system/timeline | FR-RUNTIME-008 |
| system/ui-feedback | FR-UIFB-001, FR-USREQ-006 |
| system/user-plugin-manager | FR-USERPLUG-001, FR-USERPLUG-002, FR-USERPLUG-003, FR-USERPLUG-004, FR-USERPLUG-005, FR-USERPLUG-006, FR-USERPLUG-007, FR-USERPLUG-008, FR-USERPLUG-009, FR-USERPLUG-010, FR-USERPLUG-011, FR-USERPLUG-012 |
| system/webui | FR-UX-005, FR-PLUGIN-005, FR-USREQ-001, FR-USREQ-002, FR-USREQ-004, FR-USREQ-005, FR-USREQ-011, FR-UXWEB-001, FR-UXWEB-002 |

The definition-row audit reads 73 IDs from
[`functional-requirements.md`](../work/functional-requirements.md), 47 from
[`functional-requirements-archive.md`](../work/functional-requirements-archive.md), and
46 from [`functional-requirements-archive-b.md`](../work/functional-requirements-archive-b.md).
All **166 distinct historical IDs** have exactly one owner above; no assignment
references an undefined ID. This count is not a passed-acceptance count.

The current product supersedes the client elevation/all-side-switch semantics of FR-ADMIN-002 and FR-ADMIN-003 with a separate administrator account (ADR-0027). Historical source documents describe earlier implementations; this inventory preserves ownership without treating old completed checks as current product proof.
