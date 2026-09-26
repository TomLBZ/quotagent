# Structured scope, terms and negotiation evidence
<!-- budget: 8192 bytes, hard -->

Executed 2026-09-26 against native Cordis plugins and real Ledger/QEP stores.
Decision: [ADR-0045](../../../design/adr/0045-explicit-scope-terms-and-negotiation.md).
Owner contract: [procurement](../../../../src/domain/procurement/requirements/scope-terms-negotiation.md).

| Command | Observed result |
|---|---|
| `node src/domain/procurement/tests/structured-scope.mjs` | 5 groups passed: publication validation, original/normalized units, additional/alternative lines, exact-cent refusal evidence, scope amendment, typed deviations and reviewed clarification cutoff. [Report](scope-native.json). |
| `node src/domain/procurement/tests/terms.mjs` | 4 groups passed: versioned defaults, both required/offered values, revision-bound human conflict decisions, independent signed PO retaining exceptions and real remount. [Report](terms-native.json). |
| `node src/domain/procurement/tests/negotiation.mjs` | 5 groups passed: explicit private policy/cost source; limits and human-only execution; private revision and separate submission; stale-review refusal; interruption between durable attempt and summary followed by remount. [Report](negotiation-native.json). |
| `node src/domain/procurement/tests/normalization-performance.mjs` | 200 real items ×5 real submitted quotations; five exact-unit normalization calls plus authorized comparison measured93.96ms on this host. Repeat output identical; zero new events. Fixture construction and QEP delivery excluded from timing. [Report](performance-native.json). |
| `node src/domain/procurement/tests/scope-terms-negotiation-browser.mjs` | GUI8 groups passed at isolated localhost8645, zero JS errors. Fresh accounts authored library, structured scope and typed deviation; supplier quote; contractor term decision; rejected floor attempt; exact approval creates private19/unit revision; separate submission; team source link requires explicit authorized switch and refuses counterparty membership. [Report](gui-local.json). |
| `node src/domain/procurement/tests/rfq-lifecycle.mjs` | 4 groups passed; actual286 ledger events, revision/broadcast/rebid/FAQ replay. Raw root `tmp/rfq-lifecycle-n5x19n`. Fixture rebid now explicitly offers required36-month warranty so new term gate is respected. |
| `node src/domain/procurement/tests/fulfillment.mjs` | 6 groups passed; actual470 ledger events, bilateral award, independent grant/signature, changes, acceptance/invoice matching, queued delivery and remount. Raw root `tmp/procurement-fulfillment-ExDPZw`. |
| `npm --prefix host run build -- --outDir /workspace/projects/quotagent/tmp/agent-experience/rfq-build` | Production Vite build108 modules passed. |

Raw browser requests/responses and twelve full-page screenshots are under
`tmp/product-evidence/procurement-scope/local`. Every business mutation came from
visible GUI controls; response capture was read-only. A first linked-workspace
harness attempt could not read a successful select response after full reload;
the corrected harness retains status and verifies selected team and exact record.
No application workaround bypassed access checks.

## Exact scope and retained gaps

FR-NORM-001/002/003 gain declared unit/measurement normalization; existing sourced
FX/tax comparison remains owned by commercial-workbench. FR-DEV-001 retains
technical/commercial/schedule/scope categories and optional money/day impacts;
unknown impact is not zero. FR-TERMS-001/002 and FR-NEGO-001/002 are covered by the
focused native and GUI checks. NFR-IDEM-002/NFR-PERF-001 have a measured local case,
not a universal throughput guarantee. Shared deadline/read/print hooks integrate
response-workbench without claiming that plugin's acceptance here.

Three compatible outcomes remain for the next bounded procurement slice: new
RFQs still permit unstructured publication (existing structured scopes validate
fully); public schedule is lead time plus binding mode rather than named binding
milestones; FAQ reuse retains human-reviewed prose/source references but lacks the
historical exact-version lookup and structured field publication lifecycle. They
are not waived as obsolete. Historical CLI-only signatures, SSR-only forms and
exact legacy payload key counts are superseded by the native GUI and owner-defined
QEP public projections; privacy, source binding and human approval remain required.
