# Response promises, receipts and printable activity
<!-- budget: 8192 bytes, hard -->

Executed 2026-09-26 on private stores and isolated `http://127.0.0.1:8648/quotagent/`.
Public acceptance is a later integration step. No external counterparties were contacted.

Owner: [response-workbench requirements](../../../../src/domain/response-workbench/requirements/README.md).
Decision: [ADR-0049](../../../design/adr/0049-response-promises-and-read-evidence.md).
Procurement owns the shared `clarifyDeadline` lifecycle and `object-response` slot
placements; this plugin owns promises, read metadata, reminder review and reports.

| Requirement | Observed proof |
|---|---|
| FR-RFQ-005 | Native and GUI normalize an explicit UTC clarification cutoff, preserve it through RFQ/QEP/amendment, reject questions after cutoff, and produce deduplicated private due/overdue notifications. |
| FR-RFQ-007 | Owner sees invited/nonresponding parties and desired minimum; only current submitted/awarded quotations count. Supplier sees self only. Draft/stale quotations do not count. |
| FR-RFQ-008 | GUI supplier proposes an exact response time, reviews it in Action center, then human approval delivers it through QEP. Buyer sees promise basis, exact UTC deadline and hours remaining. A separately reviewed reminder reaches only the chosen invitee. |
| SUPPLEMENT-022 | Actual object opening visibly discloses authenticated reader/version/first/last/count; native repeat within 60 seconds adds zero events or transfers. Buyer receives the receipt through QEP; other bidder cannot inspect it. Reload/restart retain history. |
| SUPPLEMENT-006 | RFQ/quote/order/change print uses actual accessible records, item IDs, revision, main/source-status/request ledger anchors; private quote costs/notes omitted and markup escaped. GUI opens a printable RFQ and exposes browser print/save-PDF. |
| SUPPLEMENT-023 | Single range calculation powers screen/CSV/TXT/HTML. Native uses an actual independently signed order; amounts remain separate by currency, exact matched request/decision sources explain waiting time, later acknowledgment does not count the order again, historical overdue reconstructs accepted workspace facts before range end; unapplied transfer bodies do not become business activity. |

Commands and output:

- `node src/domain/response-workbench/tests/native.mjs` — 6 groups PASS; actual Cordis,
  Python Ledger/QEP, three parties plus accepted colleague/independent reviewer,
  frozen proposal refusal, private boundaries, serial deduplication, source exports,
  scheduler deduplication and full effect disposal. [Native report](native.json).
- `BASE_URL=http://127.0.0.1:8648/quotagent/ EVIDENCE_DIR=tmp/agent-experience/responses/browser-final node src/domain/response-workbench/tests/browser.mjs`
  — 6 groups PASS, 0 browser errors. Three real account contexts complete creation,
  publication, disclosed reading, promise review/approval, targeted reminder,
  printable record and weekly CSV/TXT/HTML, 390px layout and reload. [GUI report](browser.json).
- `npm --prefix host run build -- --outDir /workspace/projects/quotagent/tmp/agent-experience/responses/assets`
  — PASS, 106 modules in integrated local composition.
- `tools/verify.sh docs` — PASS after the evidence and source requirements were finalized.

Screenshots: [read disclosure](read-disclosure.png), [frozen promise](promise-review.png),
[buyer coverage](coverage.png), [received reminder](received-reminder.png),
[printable record](print-record.png), [sourced report](weekly-report.png), [mobile](mobile.png).

Limits: read evidence proves authenticated opening, not understanding or contractual
acceptance. Automatic reminders are private in-app notifications; configured external
notification delivery belongs to its separate plugin. No automatic counterparty message
is sent. Current coverage evaluates currently recorded facts at the displayed time;
weekly overdue reconstructs the historical range end. Report intervals include the
start and exclude the end using the ledger’s one-second timestamp precision. Approval-wait figures use only the selected party ledger,
with unavailable matches shown rather than guessed. Printed copies neither sign nor
issue a contract. The native report assertion covers all four object types; the GUI
print journey specifically covers an RFQ and sourced activity report. Historical SSR,
CLI pending-file and shared nonledger receipt storage mechanics are superseded by the
native GUI/QEP implementation, with the useful outcomes retained.
