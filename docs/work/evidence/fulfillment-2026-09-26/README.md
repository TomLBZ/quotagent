# Bilateral fulfillment and independent signing evidence
<!-- budget: 4096 bytes, hard -->

Native owner `domain/procurement`, with party teams, action review and durable QEP
provided by their own plugins. Decision ADR-0036. Executed 2026-09-26, exit 0:

- `node src/domain/procurement/tests/fulfillment.mjs`: [six native groups PASS](native.json), 470 buyer events. Real team policy, distinct reviewer grant/proposer sign, supplier confirmation, exact declared tax/freight, sourced changes, acceptance/invoice matching, queued signed delivery/retry, CAS, replay and counterpart/private-field boundaries.
- `BASE_URL=http://127.0.0.1:8645/quotagent/ node src/domain/procurement/tests/fulfillment-browser.mjs`: [five GUI groups PASS](gui.json), three human identities. Zero-limit proposer nominates a reviewer authorized for USD10,000; one USD265 order follows supplier confirmation and reviewer grant. Quantity10→12/rate20→22 yields a reviewed USD76.80 change and USD341.80 order. Partial receipt5 makes invoice12 mismatch; receipt7 enables a fresh match while retaining the previous mismatch.
- `BASE_URL=http://127.0.0.1:8645/quotagent/ node src/domain/procurement/tests/edit-conflict-browser.mjs`: [three GUI groups PASS](editConflict.json). Stale409 preserves unsaved input, explicit merge succeeds, absent optional deadline remains absent, record/tab links survive reload and unauthorized private-draft links explain missing access.
- Actual host process stop/restart, then GUI readback: [one group PASS](restart.json); approved scope, both receipts and invoice reconciliation history remain.
- Existing RFQ native regression: four groups PASS, 285 events; procurement business smoke/disposal/startup PASS. Raw outputs `tmp/product-evidence/fulfillment/verification/`.
- Integrated Vite build78 PASS. No JavaScript errors or 390px horizontal overflow.

Screenshots/raw GUI responses remain in ignored
`tmp/product-evidence/fulfillment/local-final-v3/`. Public integration is a separate
release step. Remaining G1 clauses (measurement/interfaces, terms library, response
coverage, structured negotiation and read/print features) are not marked complete.
