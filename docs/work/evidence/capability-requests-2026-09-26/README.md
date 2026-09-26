# Administrative capability request evidence
<!-- budget: 4096 bytes, hard -->

Decision ADR-0039; native owner `system/plugin-manager` child
`capability-requests`. Executed 2026-09-26:

- `node src/system/plugin-manager/tests/capability-requests.mjs`: [native.json](native.json), four groups PASS on actual Cordis/ledger/accounts/settings. Permission remains blocked until separate administrator decision; unrelated clients cannot read reasons; lifecycle failure retains blocked receipt; requester confirms guidance; rejection/expiry/linked retry and unload/reload preserve truthful history. Registered lifecycle operation is a controlled fixture here.
- `BASE_URL=http://127.0.0.1:8644/quotagent/ node src/system/plugin-manager/tests/capability-browser.mjs`: [gui-local.json](gui-local.json), four GUI groups PASS with three roles. Actual account AI permission changed; actual Help plugin disabled and re-enabled through its request using Cordis lifecycle; configuration guidance confirmed by client; supplier sees none of buyer explanations. All writes used visible controls.
- Vite build: 69 modules PASS.

Four screenshots are retained under ignored
`tmp/product-evidence/capability-requests/local/`. No browser JavaScript errors or
mobile overflow. The browser exercised the full real lifecycle, supplementing the
controlled failure in the native suite. The final small source correction directs
client notifications to the registered Settings page and rejects confirmation after
expiry; it is covered by native/source review. Public deployment remains pending.
