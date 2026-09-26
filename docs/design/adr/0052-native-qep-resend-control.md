# ADR-0052 Native QEP resend control recovery
Status: accepted
<!-- budget: 8192 bytes, hard -->

## Problem

FR-QEP-003 retains both sequence-gap detection and a wire resend request. Native
delivery currently holds missing sequences and prepends unacknowledged messages
on sender retry, but does not carry the existing kernel `relay/resend-request`
control between independently deployed parties. A peer restored from an earlier
valid ledger prefix can need a message that the sender already considers delivered.
Manual package recovery is useful but does not satisfy automatic request/replay.
Source: workspace-store `code/delivery.py`, exchange-workbench `code/index.mjs`,
ADR-0037 and the immutable original clause in the requirements catalog.

## Decision

Reuse the existing signed QEP `relay/resend-request` intent and the existing
per-peer/channel sequence, hash and signature rules. Change no kernel envelope,
canonicalization, ledger or commercial approval semantics. The native adapter
creates one durable request for a bounded missing range when a valid message is
held; the request names the exact requester, sender, channel and sequence range.
Identical unresolved ranges reuse the original signed request. Recovery after a
crash between kernel send and adapter indexing reconstructs that request.

A recipient validates control shape, pairing and ordered stream before selecting
original outbox envelopes for the requested range. It records requested, available
and unavailable sequences; an unavailable message is an explicit unresolved
condition, never a fabricated package. Replays use original message IDs, signed
bodies, approvals and resource hashes, including messages already acknowledged.
No control grants approval or changes commercial content. Domain validation still
runs when an original business package becomes applicable.

HTTP response packages may carry receipts, missing-message requests and exact
requested replays. The native exchange pump consumes them in stream order and
performs bounded rounds; duplicate requests cannot cause an unbounded exchange.
Each round admits at most 64 requested messages, with eight recovery rounds per
attempt. Persistent unfinished controls use the existing bounded retry timer and
manual retry surface. Network failure retains the original request/replay state.
Control messages do not generate transport acknowledgements of each other.
A request becomes fulfilled only when its named missing messages are present in
the receiving kernel ledger, not merely because an HTTP request succeeded.

Additive native `exchange/resend-*` events and existing record collections retain
request preparation, receipt, replay attempts and fulfillment. The GUI exposes
missing ranges, matched original message IDs, status and actionable failures;
normal delivery summaries remain distinct from recovery controls. Unload cancels
network attempts and removes timers/routes through existing Cordis effects.

## Consequences

Users can recover dropped or historically acknowledged predecessors through the
paired HTTP route without editing or reapproving signed business content. Bounded
work can require another scheduled/manual attempt for a large gap. Portable files
can carry the same controls and returned packages manually. Pairing remains the
existing symmetric HMAC trust model; this adds no claim of independent identity.

## Alternatives rejected

- Only prepend unacknowledged messages: cannot recover an acknowledged predecessor.
- Create new business envelopes: changes identity and may duplicate commitments.
- Automatically approve a received alternative: transport cannot supply consent.
- Change the kernel resend/sequence format: existing control semantics suffice.
- Unlimited recursive exchanges: can loop when either direction has missing history.

## Revisit conditions

Revisit batching for measured large gaps or a new transport. Direct QEP mail
carriage is a separate integration of the same packages with the reviewed mail
plugin; ordinary parsed mail attachments do not establish that capability.
