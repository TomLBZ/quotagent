# Native signed missing-message recovery
<!-- budget: 6144 bytes, hard -->

Date:2026-09-26. Decision [ADR-0052](../../../design/adr/0052-native-qep-resend-control.md).
Owners: workspace-store and exchange-workbench; retained clause FR-QEP-003.
This is local native/GUI evidence; final public deployment belongs to the root release.

| Command | Observed scope/result |
|---|---|
| `node src/system/workspace-store/tests/resend.mjs` | Six groups PASS, [native.json](native.json): actual independent Cordis/Python stores, signed request and exact original replay over HTTP; crash prefix after control send recovers missing adapter index; duplicate identity; bounded/foreign range refusal; unavailable originals remain explicit; repeating control ends bounded; prior receipts survive later outage. Four HTTP requests across success and repeated-control scenarios. |
| `node src/system/workspace-store/tests/exchange.mjs` | Existing nine groups PASS in `tmp/exchange-smoke-S5ZXW4/report.json`: approval/signature/dedup, held-gap restart, three-way conflict/private fields, HTTP outage/retry, send/receive crash prefixes, corruption isolation, CAS and bridge handshake. The manual fixture now carries all returned signed controls in their original stream order. |
| `BASE_URL=http://127.0.0.1:8650/quotagent/ node src/system/exchange-workbench/tests/resend-browser.mjs` | Three groups PASS, [gui-local.json](gui-local.json), four screenshots: GUI pairing/import/recovery retry, actual fixture HTTP, original quote recovered and successor released, full reload and390px without overflow or JavaScript errors. All application writes use visible controls. |
| `node host/node_modules/vite/bin/vite.js build --config src/system/webui/client/vite.config.mjs --outDir /workspace/projects/quotagent/tmp/agent-experience/resend-assets` |110modules PASS for shared current composition. Existing bundle-size advisory remains; no performance improvement inferred. |

The native already-delivered sender flag is an explicit fault fixture: it exercises
replay selection even when normal predecessor batching excludes that message. It
does not claim a real receiver acknowledged and subsequently lost a ledger fact.
All QEP envelopes/signatures, HTTP traffic, adapter replay and effective records
are real. No commercial party or external service was contacted.

The browser supplier is a labelled independent native protocol fixture; it authors
two approved test quotation revisions at the same exact unit prices. The application
imports only the successor, holds it, then requests and receives the original
predecessor. Existing domain policy validates both before they become effective.
An earlier fixture used amount/quantity and produced invalid fractional prices;
the domain correctly rejected it. The fixture now uses exact unit price times
quantity and retains that rejected first run under ignored raw evidence.

Recovery uses the existing kernel control type and changes no kernel semantics.
At most64requested packages and eight recovery rounds are admitted per attempt;
the normal five-attempt background policy remains. Requests do not acknowledge
other controls. A request is fulfilled only when each named sequence appears in
the receiving ledger. Unavailable original sequences and pending/failed requests
remain visible; no replacement commercial content is manufactured.

Raw files: `tmp/qep-resend-fdUMqI/`, `tmp/agent-experience/resend-browser/`.
The isolated local host uses `tmp/agent-experience/resend-data` and generated assets;
existing production data and public runtime were not changed.
