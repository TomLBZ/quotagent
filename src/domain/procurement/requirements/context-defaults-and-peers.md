# Scoped draft defaults and paired-party workflow
<!-- budget: 12288 bytes, hard -->

Owner: `domain/procurement`; ADR-0044 integrates generic settings ADR-0041 and
exchange ADR-0037. Retained requirements: FR-CONFIG-001, FR-USREQ-001/003/009 and
the real participant/realm isolation outcome of FR-QEP and native product contract.
This is a bounded G1 integration slice; it does not claim structured RFQ or
negotiation requirements complete.

## Draft defaults

Register schema `procurement` for both business roles: `currency`, `requestBrief`,
`quoteLeadDays`, `quotePaymentTerms`, `quoteNotes`. No credentials. Existing schema
fallbacks match current draft behavior (USD, empty text,14 lead days). Effective
precedence is generic defaults/shared/account/workspace/project/section. Domain
providers expose only the active authorized party and its owned project/section
records; each section verifies its project parent. Shared writes require the
actual human's workspace edit permission.

New drafts use effective values only where a field was omitted. Explicit blanks
remain explicit; existing drafts retain their previous values. Record applied
values and generic per-key provenance locally in the draft. Do not exchange the
private preparation basis. Changing a default never updates an existing record
or creates publication/submission. A supplier's received buyer project IDs do not
select buyer configuration. GUI users can edit defaults from account/project
context, inspect their origin and apply them without losing manually typed values.

## Paired parties

Read selected-party `exchange.list(user).peers`; require enabled and paired and an
explicit supplier/contractor role. Expose external contacts with name, realm and
pairing source. Do not inject fake local accounts or scan unrelated realms. Contact
validation and each send recheck the authorized route. Local accounts continue to
work without configured external pairing. New RFQ invitations can choose remote
suppliers; received quote submission returns to the paired contractor. Public
projections and receiver policy remain in force, including private-cost exclusion.
Disabled paired routes disappear from new invitations but existing approved
transfers can enter the manual delivery queue. Removing a route entirely refuses
the operation before its approval or publication record is appended.

## Executable acceptance

1. Native actual-ledger settings tests: account/workspace/project/section precedence,
   provenance, forbidden foreign scope and wrong parent, actual team actor, explicit
   blank preservation, old draft stability, supplier isolation and disposer cleanup.
2. Native actual paired-QEP tests: external roles supplied only by enabled authorized
   pairing; unpaired/foreign contacts unavailable; real request and quote arrive
   with exact source fields and no costs.
3. GUI settings/project defaults: configure distinct levels, open a new draft,
   inspect inherited values, keep a manual override, save and reload with source.
4. Two independent local application processes, all business writes via GUI: create
   accounts, pair explicit opposite parties, publish a request, supplier reads it
   and submits a human-reviewed quote, contractor sees the received quote and both
   inspect signed delivery receipts. No direct API fixture business writes.
5. Isolated native client build and focused prior RFQ/fulfillment regressions.

Executed 2026-09-26: native 5 groups, scoped-default GUI 3 groups, independent
two-application GUI 4 groups, fulfillment regression 6 groups, RFQ regression
4 groups and isolated Vite build 88 modules passed. Both browser reports contain
zero JavaScript errors. Commands, scope and raw-evidence locations are recorded in
[the execution evidence](../../../../docs/work/evidence/g1-context-defaults-and-peers.md).
