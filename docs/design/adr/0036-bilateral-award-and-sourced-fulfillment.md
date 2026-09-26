# ADR-0036 Bilateral award, sourced changes and delivery reconciliation
Status: accepted
<!-- budget: 8192 bytes, hard -->

## Problem

The native award operation creates a PO before the supplier confirms the proposed
award. Free-amount changes cannot reconstruct quantity/rate basis, and order
acknowledgement is not delivery acceptance or invoice reconciliation. These remain
valid documented business requirements (domain model §2.4–2.5; ADR-0024/0025).

## Decision

Add procurement-owned `award-intents`, `acceptances`, `invoices`, and
`invoice-matches` records. An immutable public quote snapshot is proposed as an
intent, confirmed independently by the supplier, then signed by the contractor
only after the action-center's scoped independent authorization. The final order
is uniquely derived from that confirmed intent. Withdrawal/decline closes only
uncommitted intent; existing commitments are never deleted or retroactively changed.
Legacy `award` becomes a final-sign alias and cannot bypass the bilateral state.

The optional constructor authorization hook is awaited inside domain approval
before any human-approved fact. Native composition fails closed when protected
monetary operations have no review service/grant. Account/team scope and actual
human identity remain distinct. The shared review service owns nomination,
authority, approval grants and their consumption; procurement owns source snapshots,
version checks and commercial state transitions.

New changes reference original quote lines/rates and the exact current order
revision. Counterparty acceptance precedes independent contractor approval.
Approval and application are separate durable states with an idempotent application
reference. Current quantities and total use the approved scope and stated tax/
freight formula from the commercial contract. Settlement records closure only,
never payment. Existing lump-sum historical changes remain readable; new proposals
cannot invent an unsourced free amount.

Delivery acceptance records positive increments and deficiencies; cumulative
quantity cannot exceed approved scope. Invoice declarations are matched against
the approved order and recorded deliveries, less previously matched quantities.
Every mismatch/recheck preserves exact source versions and differences. This is
reconciliation, not invoice issuance, tax filing or payment (explicit non-goals).

Additive events in the `procurement/` family: `award-intent-proposed`,
`award-intent-received`, `award-intent-confirmed`, `award-intent-declined`,
`award-intent-withdrawn`, `award-committed`, `rfq-closed`, `quote-withdrawn`,
`change-confirmed`, `change-rejected`, `change-applied`, `change-settlement-recorded`,
`acceptance-recorded`, `acceptance-received`, `invoice-recorded`, `invoice-received`,
`invoice-matched`, `invoice-mismatch-recorded`. Existing order/change/approval
events keep their meanings. These are business records over workspace-record/v1;
ledger/QEP kernel and transport envelope version semantics are unchanged.

## Consequences

An unconfirmed offer cannot become an order, reviewers can stop a commitment, and
quantity/price changes and fulfillment discrepancies have reconstructible sources.
Users perform more explicit bilateral steps. Legacy evidence still shows the old
instant-award behavior honestly, while new GUI checks exercise the new state machine.
Distributed delivery failures retain local facts and use idempotent resume where
specified; universal transport outbox work remains a separate owner concern.
The domain integrates that store-owned outbox through ADR-0037's policy interface:
public semantic whitelists and source approval references are prepared here;
the adapter binds them to signed record hashes. Receiver checks reconstruct line
arithmetic and confirmed intent/change basis before accepting a monetary record.
Queued or conflicted packets never masquerade as a counterparty receipt. Draft
compare-and-save uses the store's atomic revision check; human forms retain their
unsaved edits and show the current source before an explicit retry.

## Alternatives rejected

| Alternative | Reason |
|---|---|
| Treat post-order acknowledgement as prior award consent | Reverses the documented condition for commitment |
| Implicitly approve while signing | Removes the independent reviewer's veto |
| Permit arbitrary amount-only change | Cannot prove original line/rate basis or accepted scope |
| Treat order acknowledgement as delivery | Does not establish received quantities or deficiencies |
| Auto-correct mismatched invoices | Erases the discrepancy instead of recording it |
| Rewrite old orders and approvals | Violates append-only history and misrepresents prior behavior |

## Revisit conditions

Revisit for multiple partial awards, multi-currency invoicing/conversion, credit
notes/returns, or a transport-level commitment proof design. Until explicitly
specified, do not infer those operations from payment or invoice matching.
