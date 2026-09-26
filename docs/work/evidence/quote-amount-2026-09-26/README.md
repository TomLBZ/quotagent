# Source-bound quotation amounts
<!-- budget: 4096 bytes, hard -->

Command: `node src/domain/procurement/tests/quote-amount.mjs`.
Result: **PASS, five native groups**, 2026-09-26T07:50:44.449Z.
Raw output: [native.json](native.json); actual Cordis/Python ledger fixture retained
at `tmp/quote-amount-i1kbwG`. Source is the focused calculator worktree batch on
parent HEAD `031d0e5`; the parent records its commit identity after review.
No kernel, QEP or persisted business format changes.

Observed: received quote 5532 at 30% produces 1659.60 with 3872.40 remaining and a
resolvable buyer-realm source event. Full 5292, zero, fractional 12.345678%, two
half-cent roundings and invalid inputs passed. Each amount plus remainder equals
the stored total exactly. Stale supplier edits, later buyer receipts, superseded
offers and amended request scope refuse; the buyer retains its last actually
received source while an unsent supplier edit is private. Own/received visibility,
explicit team membership, admin denial, no business writes, absence of private
costs, reconstruction and tool disposal passed.

Implementation: `src/domain/procurement/code/quote-amount.mjs`, registered by
`code/index.mjs`; [contract](../../../../src/domain/procurement/requirements/quote-amount.md).
The existing assistant GUI displays its readable summary and source navigation.

Limitation: native execution proves deterministic arithmetic and registration,
not model tool selection or final prose. Public real-provider replay is separate
and must run on the committed deployed correction. The previously observed model
error remains retained in independent public evidence; no amount here creates an
agreed deposit or payment schedule.

[Retained public counterexample](counterexample.json): the model supplied3240 for
5532 at30%. Shared `arithmeticInstruction` in agent-runtime `product-policy.mjs`
now requires a registered calculation result for new monetary amounts, otherwise
leaving the amount unquantified. Chat and every workroom role use the same guidance.
[Existing policy9 and controlled-provider workflow8 groups passed](prompt-integration.json)
after integration. This is capability and guidance, not a guarantee of perfect model
prose; independent corrected public tool selection remains required.
