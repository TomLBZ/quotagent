# Bilateral award and sourced fulfillment
<!-- budget: 12288 bytes, hard -->

Owner: `domain/procurement`. Phase2 of the native G1 implementation covers
FR-AWARD-001/002/003, FR-CHANGE-001/002, FR-GATE-002 and the acceptance/invoice
requirements in `docs/design/02-domain-model.md` §2.5 (audit DOMAIN-004–008).
Decision: ADR-0036. Independent reviewer policy/grants belong to action-center
and teams; this plugin consumes their authorization before recording a commitment.

## Award states

An award intent freezes the submitted public quote, RFQ publication revision,
price basis, commercial terms, source references and selection reason. Creating
it is explicitly nonbinding. The supplier separately confirms or declines it;
the contractor can withdraw it before commitment. A new selection is a new intent,
never an edit of a confirmation. Quotes must still match the frozen source and
remain current, complete and valid at signing. No order exists until supplier
confirmation and authorized contractor signing are both present.

`propose-award{quoteId,reason}`, `confirm-award{id}`, `decline-award{id,reason}`,
`withdraw-award{id,reason}` require signed-in human confirmation. `sign-order{id}`
consumes a separately approved action grant through `authorizeCommitment` and
creates one PO from the confirmed intent. Legacy `award{quoteId}` is a final-sign
alias requiring a confirmed intent; it cannot recreate the former instant PO path.
Repeat completed signing returns the same order. Existing issued orders remain
historical facts and are not retroactively invalidated.

`close-rfq{id,reason}` closes an unawarded published request with an appended fact;
`withdraw-quote{id,reason}` appends withdrawal and removes the quote from candidates.
Uncommitted intents based on changed, withdrawn or expired quotes cannot sign.

## Changes and accepted scope

A structured change references an existing ordered quote line and its original
quoted unit rate. Input lines contain `itemId`, signed `deltaQuantity`, optional
`newUnitPrice` and a required `rateReason` when changing the original rate. The
preview records original quoted quantity/rate, current order quantity/rate,
proposed quantity/rate and exact cents delta. No missing source is guessed.
Changing a price requires supplier confirmation of the proposed change before
contractor approval; quantity-only changes also require explicit acceptance by
the other party. Old lump-sum historical records stay readable; new changes must
have a quoted-line basis.

`propose-change{orderId,title,description,lines,expectedOrderRevision}` proposes;
`confirm-change{id}` records the counterparty's acceptance; `reject-change{id,reason}`
closes an unapproved proposal. `approve-change{id}` requires the independent grant
and an unchanged base order revision. Approval records the authorized delta then
applies the new order scope and price breakdown; an interrupted application is
retryable and never adds the delta twice. Existing receipts cannot be reduced below
accepted quantities. `settle-change{id,note}` records both parties' closure of an
applied change; it does not record or imply payment.

## Acceptance and invoice reconciliation

`record-acceptance{orderId,reference,acceptedAt,lines:[{itemId,quantity}],deficiencies}`
is a contractor's reviewed delivery record, shared with the supplier. Quantities
are positive received increments. Cumulative receipts cannot exceed the current
approved ordered quantities. Unknown lines and unapproved extra scope refuse.
Deficiencies are explicit; acknowledgement of an order is not delivery acceptance.

`record-invoice{orderId,invoiceNumber,invoiceDate,currency,lines:[{itemId,quantity,unitPrice}],taxAmount,freightAmount,statedTotal}`
records a source invoice declaration. It creates no invoice, tax filing or payment.
`reconcile-invoice{id}` compares the invoice's line quantities/prices with approved
order scope and cumulative accepted quantities less earlier matched invoices.
Currency, unknown/duplicate lines, rates, excess quantities, missing acceptance,
tax/freight and arithmetic mismatches remain named differences in a durable match
record. New acceptance/order revisions require a new reconciliation; prior matches
remain in history. Matched invoice quantities cannot be counted twice.

## Integration and review boundary

`createProcurement` accepts optional async
`authorizeCommitment(user,{action,id,record,input})`. `approval()` calls it before
appending `human-approved`. Native index delegates protected sign-order/award/
approve-change to action-center and fails closed if that review service is absent.
The execution handler forwards the current `reviewActionId`; the domain still
rechecks source fingerprints and states. Team business identity is separate from
the actual human actor in all approvals, confirmations and receipts.

`POST /workspace/review/:action` prepares a frozen human-origin review without
executing it. Monetary buttons navigate to Review actions. Agent tools create
review proposals; they cannot confirm, sign, approve, accept delivery or reconcile
invoices without the corresponding human operation. Snapshot adds `awardIntents`,
`acceptances`, `invoices`, `invoiceMatches`; current changes expose their line basis,
counterparty acceptance and applied order revision. New records are append-only
workspace records exchanged through existing QEP; no kernel semantics change.

`exchange-policy.mjs` supplies the domain policy for the store's native QEP
adapter (ADR-0037). Only whitelisted public fields leave the source realm. Source
human approval ledger references bind the reviewed business semantics; receiving
quotes are checked against RFQ line scope and exact price arithmetic, changes
against their quoted-line basis, and orders against confirmed intent/change.
Unknown actors or invalid authority/source states refuse before application.
Signed queued delivery is a local recorded commitment, not proof of receipt:
the response and GUI say pending and link to Deliveries & exchange. Retrying the
stored packet does not create another commitment.

RFQ/quote/project/section and clarification drafts accept their opened revision.
An atomic stale write returns409 without appending a replacement. Forms preserve
unsaved values, show the current source, and require explicit review/merge before
retrying. The selected order is frozen while preparing a change. Corrupt selected
realms return503 rather than an apparently empty workspace; startup seed skips
quarantined demo realms. Safe RFQ/quote/order IDs and tabs persist in links; an
unavailable record explains access rather than silently opening another record.
Object attachment controls are contributed by their owner plugin through the
optional `object-attachments` slot; procurement provides authorized object context.

## Executable acceptance

- `node src/domain/procurement/tests/fulfillment.mjs`: real Ledger/QEP, no PO before
  supplier confirmation and scoped authorization; withdrawal/stale source refusal;
  duplicate sign idempotence; original-rate quantity changes and changed-rate
  acceptance; stale change refusal; receipts within approved quantities; invoice
  discrepancies, cumulative matching and replay; no private cost exchange.
- `node src/domain/procurement/code/smoke.mjs` and
  `node src/domain/procurement/tests/rfq-lifecycle.mjs`: existing workflows updated
  for bilateral signing, never preserve an obsolete instant-order behavior.
- `BASE_URL=<url> node src/domain/procurement/tests/fulfillment-browser.mjs`:
  GUI contractor intent → supplier confirmation → independent review → sign/PO,
  quoted-line change, acceptance and mismatch/match records; raw receipts/screens.
- `BASE_URL=<url> node src/domain/procurement/tests/edit-conflict-browser.mjs`:
  two GUI editors, real409, preserved unsaved input, reviewed merge, no invented
  deadline, copied record/tab reload and another party's unavailable-record view.
- `npm --prefix host run build`: native client composition.

Later G1 closure still tracks structured RFQ interfaces/measurement and terms
library/conflict decisions, response promises/deadlines/coverage, negotiation bounds,
and delivery read receipts/print. Those outcomes are not waived or claimed complete
by this fulfillment slice.
