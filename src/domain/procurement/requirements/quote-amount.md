# Source-bound quotation percentage amounts
<!-- budget: 4096 bytes, hard -->

Owner `domain/procurement`. Source: independent public review on 2026-09-26 found
the assistant reading a 5532 quotation and literal 30% term but reporting a 3240
deposit. This focused extension supports FR-COMPARE-003's numeric reference chain;
it does not change the commercial-workbench ownership of comparative evaluation.

`calculate_quote_amount` is a disposable native read tool. It requires an authorized
quote ID, the current quotation revision and an explicitly supplied percentage
from 0 to 100 (up to six decimal places). It loads the stored total itself; a
caller-provided total is refused. Stale request scope, superseded/withdrawn offers
and changed quotation revisions require reading the current source again.

The calculation uses the product's existing two-decimal quotation amount scale:
integer minor units multiplied by an exact decimal percentage, rounded half up
once. The remainder is subtraction from the original total, so both portions sum
exactly. The result retains currency, base, percentage, amount, remainder, scale,
rounding rule and the exact quote/RFQ revisions and ledger realm/sequence/hash.
It is an illustrative derived amount, not an agreed deposit, tax, freight or payment
schedule. No payment text is parsed and no rate is guessed. It changes no business
record and creates no commitment. Existing `agent/tool-completed` events retain
actual assistant call inputs/results for reconstruction; no new ledger format is
introduced. Source: `system/agent-runtime/code/product-assistant.mjs`.

AC command: `node src/domain/procurement/tests/quote-amount.mjs`.

1. Actual Cordis registration plus real RFQ/quotation ledger: 5532 × 30% = 1659.60;
   remainder 3872.40; received source reference resolves to the quoted total.
2. 5292 × 100%, zero, fractional rate and half-cent rounding preserve the exact
   total; invalid rates/caller totals cannot substitute a calculation base.
3. Changed quotation revision and request revision refuse stale calculation;
   non-own/non-received quotation and admin role cannot expose another party.
4. Read calls append no business events or changes, omit private costs, support
   explicitly joined workspaces, reconstruct after remount, and unregister on unload.

The native test does not prove model selection or final narrative accuracy. Root's
separate real-provider public replay verifies that integration after deployment.
