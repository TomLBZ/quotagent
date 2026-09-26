# RFQ lifecycle evidence
<!-- budget: 4096 bytes, hard -->

Native owner: `domain/procurement`; decision ADR-0032; requirements in
`src/domain/procurement/requirements/rfq-lifecycle.md`.

Executed 2026-09-26. All commands exited zero:

- `node src/domain/procurement/tests/rfq-lifecycle.mjs`: [native.json](native.json), actual ledger/QEP, interrupted broadcast recovery, immutable RFQ revisions, stale quotation rejection, private facts excluded, rebid and exact tax/freight totals.
- `node src/domain/procurement/code/smoke.mjs`: existing business regression passed.
- `BASE_URL=http://127.0.0.1:8640/quotagent/ node src/domain/procurement/tests/rfq-lifecycle-browser.mjs`: [gui-local.json](gui-local.json), three accounts perform all writes through GUI; 12 screenshots retained in ignored `tmp/product-evidence/rfq-lifecycle/local-final`.
- Same browser command with `RFQ_RECHECK_REPORT` selecting the local report after an actual process restart: [restart.json](restart.json), persisted revision, quotations and shared clarification visible to all three accounts.
- Isolated Vite build: 53 modules passed. Later integrated build: 66 modules passed.

No browser JavaScript errors or mobile overflow. Public deployment validation is
pending; these reports establish local behavior, not completion of later order,
independent authority or invoice requirements.
