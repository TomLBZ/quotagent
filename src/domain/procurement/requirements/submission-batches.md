# Selected quotation submission preparation
<!-- budget: 4096 bytes, hard -->
Owner `domain/procurement`; ADR0053; canonical SUPPLEMENT-019. Supplier Quotes GUI
selects up to 50 own private drafts across requests, prepares distinct exact frozen
review actions, and retains a per-item preparation receipt. Stale, closed, missing
and unauthorized items fail individually; successful items remain available. Nothing
is submitted by preparation. Matching pending reviews are reused. Changed drafts
invalidate frozen execution, and action-center owns actual human batch decisions.
Receipts and current action outcomes remain readable after restart. Own team business
realm and actual author stay separate. Private costs never enter outgoing messages.

AC: `node src/domain/procurement/tests/submission-batches.mjs` exercises actual native
store, team scope, per-item partial failures, repeated selection idempotence, stale
frozen execution, real reviewed signed QEP submissions and replay.
`node src/domain/procurement/tests/submission-batches-browser.mjs` selects multiple
visible drafts, inspects partial results, and executes only explicitly selected exact
review actions through GUI. Four native groups and four GUI groups passed; see
[executed evidence](../../../../docs/work/evidence/quote-submissions-2026-09-26/README.md).
