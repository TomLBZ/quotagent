# RFQ versions and shared clarification
<!-- budget: 12288 bytes, hard -->

Owner: `domain/procurement`. This native slice implements FR-RFQ-003/006,
FR-NORM-004, FR-CLARIFY-001/002/003/004 and the project/section part of
`docs/design/02-domain-model.md` §2.1. It does not claim completion of unrelated
commercial, costing, authority, acceptance or invoice clauses.

## Records and behavior

Contractors can maintain private projects (name, default currency, calendar note)
and sections. RFQs select these contexts; only the selected project/section names
and references are delivered, never a roster or unrelated project records.

Published RFQs have `publishedRevision`; private draft edits do not create public
versions. `rfq-versions` contains immutable published snapshots. A private
`rfq-amendments` record freezes its base revision, changed fields and reason.
Saving it sends nothing. Human publication checks that base revision still matches,
increments the published revision, delivers the full new scope to every invited
supplier, appends a rebid request, and reopens existing clarification tickets.
Supplier removal through an amendment is rejected: previous recipients retain
their evidence and cannot silently lose information. Supplier additions are
allowed and receive the current scope and the published version history.

Quotes bind `rfqRevision` when saved. Stale quotes remain visible with old/current
revision labels, cannot submit or be awarded, and are excluded from comparison.
Rebidding copies prices by stable item ID into the new scope, with new items left
unpriced. Explicit review of the current quantities/specification is required.
Legacy RFQs/quotes are interpreted using their first known publication revision;
the first amendment persists that baseline without rewriting old ledger entries.

Clarifications have a question, item references, RFQ revision and open/answered/
closed state. Supplier questions go only to the inviting contractor. Contractors
can privately save an answer, including using a source-linked local FAQ. Only an
explicit human broadcast publishes the answer to every currently invited supplier
and closes the ticket. Each supplier receives an anonymized question (no other
supplier identity, roster or private answer draft). A revision change reopens
tickets and clears the active answer while keeping prior broadcast evidence.
Broadcast answers may be explicitly saved to the current account's FAQ, with
source ticket/RFQ/revision provenance; archived entries stop being offered for reuse.
FAQ reuse is a draft answer and must be reviewed and broadcast anew.

## Owned interfaces

`procurement.snapshot(user)` adds `projects`, `sections`, `amendments`,
`rfqVersions`, `clarifications`, `faqs`, `rebidRequests`. It derives quote
`stale`, `staleReason`, `rfqRevision`, `currentRfqRevision` for downstream evaluation.
Public structured declarations are preserved through the same owned mutations:
quote `commercial` contains taxMode (inclusive/exclusive/unspecified), taxRate,
freight, validityUntil, advancePercent, paymentDays, warrantyMonths, penaltyPercent,
deliveryBinding (firm/indicative), and deviations (itemId, description, priceImpact,
timeImpactDays). RFQ `requirements` contains deliveryBy, paymentDays, warrantyMonths,
penaltyPercent. Percentages are 0–100 percentage points, money is quote-currency
major units with two decimals, duration quantities are integers, and dates are
ISO YYYY-MM-DD. Missing values stay unknown; scalar null/empty explicitly clears.
`normalizeCommercial` and `normalizeRequirements` expose these validators to the
commercial-workbench plugin, which owns their controls and sourced evaluation.
`normalizeQuotePrice(items, commercial)` returns exact line subtotal and the
reviewable declared total: subtotal + exclusive tax on that subtotal (rounded to
cents) + declared freight. Inclusive tax is already in line prices. Published
quote/order `subtotal`, `total`, `priceBreakdown` preserve this basis; unstated
components are null and `totalComplete:false`, never inferred. Tax-exclusive
submissions need a rate; explicitly expired quotes cannot submit or award.
The existing snapshot and execution API remain additive. Module
`code/rfq-lifecycle.mjs` owns context/version/clarification logic; future evaluation
plugins can consume current quote metadata without editing the shell or kernel.

`POST /workspace/:action`: `save-project`, `save-section`, `save-amendment`,
`publish-amendment`, `ask-clarification`, `save-clarification-answer`,
`broadcast-clarification`, `save-faq`, `archive-faq`. Human outbound operations
require `confirmed:true`. Agent tools may save private amendment/answer drafts;
outward operations only create `procurement.commit` review proposals. Pending
proposals freeze input, recipient set and current records; changed versions refuse.
All mutations are serialized per RFQ; stale expected/base revisions return a
clear conflict rather than overwriting. Public shape selection excludes costs,
private notes, private draft answers and other suppliers' identities.

Additive events are documented in ADR-0032. All new model-visible records use
`store.put`/QEP through the existing ledger adapter. Registrations dispose with the
procurement fiber. Kernel/QEP version semantics are unchanged.

## Executable acceptance

- `node src/domain/procurement/tests/rfq-lifecycle.mjs`: private project isolation;
  publish/version immutability; amendment review and revision conflicts; old quote
  comparison/submission/award refusal; changed/new-item rebid; complete anonymized
  broadcast; answer draft privacy; amendment reopens tickets; FAQ provenance/archive;
  agent outbound refusal; actual ledger/QEP reload reconstructs records.
- `node src/domain/procurement/code/smoke.mjs`: existing two-party business flow.
- `npm --prefix host run build`: native client composition.
- `BASE_URL=<public-url> node src/domain/procurement/tests/rfq-lifecycle-browser.mjs`:
  GUI-only contractor project/RFQ and supplier quote, question, reviewed broadcast,
  FAQ, amendment, stale quote and rebid; screenshots and raw report under
  `tmp/product-evidence/rfq-lifecycle`. Public run follows root deployment.
