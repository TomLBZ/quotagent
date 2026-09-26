# Commercial workbench evidence
<!-- budget: 4096 bytes, hard -->

Decision ADR-0033. Requirement mappings and arithmetic are defined in
`src/domain/commercial-workbench/requirements/README.md`.

Executed 2026-09-26, exit 0:

- `node src/domain/commercial-workbench/tests/smoke.mjs`: [native.json](native.json), five substantial groups on actual Cordis/ledger, including private factor costs, reviewed pricing, sourced TCO/FX, capacity/dependencies, CSV/report persistence, accepted team source access and effect disposal.
- `BASE_URL=http://127.0.0.1:8641/quotagent/ node src/domain/commercial-workbench/tests/browser.mjs`: [gui-local.json](gui-local.json), five GUI workflow groups and seven screenshots; no JavaScript errors or mobile overflow. £110 costs at reviewed 20% item margin yield £137.50 items + £27.50 tax + £5 freight = £170. Manually sourced 1.2 FX converts €300 to £360. Unknown inputs remain unknown. Failed CSV rows retain originals.
- Vite: 66 modules PASS.

Screenshots, downloaded comparison/order CSVs and responses remain in ignored
`tmp/agent-experience/commercial/local`. [Process/source record](process-version.json)
identifies the tested working tree. The local GUI used the earlier single-human PO
fixture; subsequent independent signing and public integration are not claimed by
this evidence. ERP transport is explicit CSV, not a live ERP connection. Reference
prices and rates are human-sourced observations, not an unconfigured market feed.
