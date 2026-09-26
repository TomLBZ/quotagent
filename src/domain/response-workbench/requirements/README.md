# Response workbench
<!-- budget: 8192 bytes, hard -->

Native owner `domain/response-workbench`; decision [ADR-0049](../../../../docs/design/adr/0049-response-promises-and-read-evidence.md).

| Retained clause | Executable acceptance |
|---|---|
| FR-RFQ-005/007/008 | Explicit quote/clarification deadlines and supplier response promises; owner coverage names only invited parties and counts only current submitted quotes. Supplier sees only self. Fixed `asOf` yields identical read-only output. GUI promise/reminder becomes a frozen human review, exact approved payload transfers via QEP. Local due/overdue notifications deduplicate and stop on unload; no automatic external message. Missing deadline remains unknown. |
| SUPPLEMENT-022 | Opening a received business object discloses and records signed-in reader, source version, first/last time/count; 60-second repeat opens do not append or send. Receipt travels only to original business counterparty through QEP; it does not acknowledge contractual obligations. Reload retains results and sender sees receipt/delivery distinction. |
| SUPPLEMENT-006 | GUI print views for RFQ/quote/order/change preserve visible line IDs, published/revision basis and ledger sequence/hash anchors. Public quotation print omits private cost/notes; printable output is escaped and clearly a record copy, never a new commitment. |
| SUPPLEMENT-034 | [Recorded business measures](business-measures.md): sourced quotation cycle, structural completeness, human intervention and equal-window baseline; unknown denominators and configured-rate estimate labels remain explicit. |
| SUPPLEMENT-023 | Bounded week/date report includes source-linked publication/received quote/order amounts by currency, matched approval waiting time, overdue nonresponders and explicit unknowns; CSV/TXT/print share one calculation and reading writes no events. |

Native checks: `node src/domain/response-workbench/tests/native.mjs` with actual Cordis,
Ledger and QEP; two roles plus unrelated account, selected party authorization,
current/stale responses, review mutation refusal, restart and complete disposal.
GUI: `BASE_URL=http://127.0.0.1:8648/quotagent/ node src/domain/response-workbench/tests/browser.mjs`
creates/publishes a request, opens it as supplier, reviews a promise and reminder,
verifies buyer coverage/receipt, prints and exports a sourced week report. Executed native and GUI reports are retained in [the evidence record](../../../../docs/work/evidence/response-workbench-2026-09-26/README.md); public integration acceptance remains separate.

Historical source IDs map to the frozen requirements audit. Original clauses came
from `functional-requirements.md` FR-RFQ-008; archive FR-RFQ-005; archive-b FR-RFQ-007;
WebUI files-and-exports and delivery-receipts-and-weekly sections 2–3. Old SSR,
operator CLI/pending-file and shared receipt file mechanics are replaced by native
GUI/QEP outcomes. Procurement owns RFQ lifecycle/clarifyDeadline and slot placement;
this plugin owns operational response records and projections, not monetary state.
