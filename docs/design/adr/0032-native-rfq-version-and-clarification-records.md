# ADR-0032 Native RFQ revisions and shared clarification records
Status: accepted
<!-- budget: 8192 bytes, hard -->

## Problem

The native procurement workspace currently has mutable private RFQ drafts and
published scope, but cannot amend scope or bind quotations to its published
revision. Generic private messages cannot establish an answer shared equally with
all invited suppliers. Historical requirements retain those business outcomes;
the old CLI/SSR mechanisms are not the native product implementation.

## Decision

Implement the owned [RFQ lifecycle contract](../../../src/domain/procurement/requirements/rfq-lifecycle.md)
with additive workspace records: `projects`, `sections`, `rfq-versions`,
`rfq-amendments`, `clarifications`, `faqs`, and `rebid-requests`.
Existing RFQs gain publication revision/context references; quotes gain the RFQ
revision on which prices were prepared. Snapshot-derived stale metadata never
rewrites a historical submitted quotation. Version mismatch prevents comparison,
submission and award. Legacy records resolve against the first known published
revision, captured explicitly on their first amendment.

Version snapshots are immutable published facts. Amendment drafts and draft
answers stay in the contractor's realm. Human publication/broadcast freezes the
reviewed scope, records the existing human approval fact and delivers selected
public fields through `store.exchange`. A closed clarification is valid only
after delivery to every invited supplier; partial failure remains retryable and
does not report closed. Recipient-specific copies omit other suppliers' identities.
An amendment invalidates active clarification answers and records their prior
provenance, requiring a new reviewed broadcast.

New named record events use the `procurement/` namespace: `project-saved`,
`section-saved`, `rfq-version-recorded`, `amendment-drafted`,
`amendment-delivery-started`, `amendment-delivery-progress`, `amendment-published`,
`rfq-amended`, `rebid-requested`, `rebid-delivered`, `rebid-submitted`, `clarification-asked`,
`clarification-received`, `clarification-answer-drafted`,
`clarification-broadcast-started`, `clarification-delivery-progress`,
`clarification-broadcast`, `clarification-delivered`, `clarification-reopened`,
`faq-saved`, `faq-archived`. The existing `human-approved` event records explicit
publication/broadcast decisions. New records use the existing workspace-record/v1
wrapper and QEP fact transport. This ADR adds business record shapes; it does not
change QEP envelope/kernel semantics or resolve the separate future commitment
binding/authority workstream.

## Consequences

Scope and answer history become reconstructible; suppliers see version changes
and cannot accidentally submit or compare old scope. Context and private drafts
remain realm-owned. More stored snapshots and delivery steps increase write volume.
Multi-recipient sends are not an atomic distributed transaction: retry receipts
are retained per recipient and closure occurs only after complete delivery.
Persisted published scope is never edited back after a partial send.

## Alternatives rejected

| Alternative | Reason |
|---|---|
| Edit published RFQs in place | Breaks received quotation provenance and version consistency |
| Keep clarification as a message kind | Cannot prove common answer delivery or reopen on revision |
| Share full ticket/private answer with all suppliers | Leaks bidder identity or unreviewed guidance |
| Modify ledger/QEP kernels | Unnecessary; business records fit existing additive plugin surfaces |
| Block all native work on old CLI gate mechanisms | Conflicts with the complete GUI product contract |

## Revisit conditions

Revisit recipient delivery coordination when independently deployed QEP outbox
transport lands, and project participant access when explicit organization/team
membership is introduced. Neither grants cross-account private-data access now.
