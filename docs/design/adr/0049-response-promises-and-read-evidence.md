# ADR-0049: Response promises, read evidence and printable source views
<!-- budget: 8192 bytes, hard -->

Status: accepted for implementation, 2026-09-26. Complements ADR-0032, ADR-0037
and the native runtime contract without changing Python ledger/QEP semantics.

## Decision

`domain/response-workbench` is a removable native Cordis plugin. Procurement retains
RFQ ownership, published revisions and `clarifyDeadline`; a clarification deadline
is explicit, normalized UTC and cannot follow the quote deadline. Changing a
published deadline requires the normal reviewed amendment. Questions after the
cutoff are refused with the route to request an amendment, never silently accepted.

Read-only coverage uses a supplied `asOf` (GUI defaults to current time and displays
it). Latest current-revision submitted/awarded quotation per invited supplier counts
as a response; draft, withdrawn or stale quotations do not. A latest same-revision
supplier promise supplies that supplier's response due time, with quote deadline
shown separately. Promises are response intentions, not a price or contract. Missing
dates stay unknown; coverage minima are private account policy. Suppliers receive
only their invitation and response, never another bidder's roster or quotation.

Promises and reminders are new public operational records, explicitly reviewed in
Action center before QEP transfer. The proposal pins party, RFQ published revision,
recipient and exact payload. Execution refuses changed targets. The plugin appends
`procurement/human-approved` with action `promise-response` or `send-response-reminder`
and the exact scope, using the existing domain approval fact shape; QEP metadata
binds its source reference and semantic record. These remain `intent`/`fact`, never
monetary commitments. Durable outbox pending is reported honestly and retried only
through existing Deliveries. A completed local fact is not recreated to retry it.

Automatic reminders are private in-app notifications, not outbound commitments.
A removable bounded scheduler checks real account realms, records observed asOf,
uses stable deadline/revision/type deduplication, reports unavailable realms, and
stops/drains on unload. Connected notification delivery follows that plugin's
explicit user configuration. Counterparty reminders require human review.

Received object detail includes visible disclosure before recording a read receipt.
The receipt identifies authenticated human and party, object/revision, first/last
observed time and count; repeat visits within 60 seconds are unchanged. Only readable
received RFQ/quote/order/change objects qualify; own drafts do not. Metadata travels
via QEP to the originating counterparty with no prices or message content. Signed
receipt facts show that the authenticated account opened the detail. They do not
prove understanding, acceptance or signature. Unlike the historical shared-file
implementation these operational facts are append-only and may be model-visible;
that preserves the current model-visible/ledger-visible invariant. Bidder receipts
are never broadcast to other bidders.

Printable RFQ/quote/order/change views are escaped read-only copies from the calling
party snapshot, with line IDs, revision and exact ledger references. Supplier private
cost fields are excluded from quotation print. Browser printing/export does not
issue or sign a commitment. Weekly/date reports use a single bounded source-derived
calculation for screen, CSV, text and print. Currency totals remain separate; source
rows and unmatched approval decisions are explicit. Reports do not infer payments,
savings, delivery completion or a zero-second wait when no decisions were matched.

## Ownership and verification

Collections: `response-promises`, `response-reminders`, `response-reads` with QEP
sender authority and public shape validation. The bounded scheduler returns checked,
omitted and unavailable counts; produced notifications retain their observed time. No new kernel format and no global shared mutable state.
All services, routes, tools, policy/schema registrations and timers are effects.
Plugin requirements define executable native and GUI acceptance. Original historical
IDs: FR-RFQ-005/007/008, SUPPLEMENT-006/022/023; former exact SSR route names, CLI
handoff files and zero-ledger operational traces are superseded, not useful outcomes.
