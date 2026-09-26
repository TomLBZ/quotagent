# Explicit party team evidence
<!-- budget: 4096 bytes, hard -->

Decision ADR-0035, owner `system/teams`. Executed 2026-09-26:

- `node src/system/teams/tests/state.mjs`: [native.json](native.json), five groups PASS using actual Cordis, ledger and QEP. Same-party accepted membership, actual actor versus business owner, separately reviewed authority revisions, assignment/mention delivery and realm/lifecycle recovery.
- `BASE_URL=http://127.0.0.1:8643/quotagent/ node src/system/teams/tests/browser.mjs`: [gui-local.json](gui-local.json), five groups PASS. Registration, invitation, explicit acceptance, selected workspace, independent policy grant/application, assignment, comments/mentions, follow and completion all performed through the GUI. Five screenshots in ignored `tmp/product-evidence/teams/local/`.
- Integrated Vite build: 66 modules PASS.

Zero browser JavaScript errors and zero mobile page overflow. Selection and comments
survive reload. The default monetary limits are unknown; policy review does not
claim that business signing has occurred. Domain signoff, background batches and
public deployment are verified separately in the next integration slice.
