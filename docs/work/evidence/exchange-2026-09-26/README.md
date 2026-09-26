# Durable QEP exchange evidence
<!-- budget: 4096 bytes, hard -->

Owners: `system/workspace-store`, `system/exchange-workbench`. Decision ADR-0037.
Executed 2026-09-26, exit 0:

- `node src/system/workspace-store/tests/exchange.mjs`: [nine groups PASS](native.json). Independent ledger roots use real loopback HTTP, signed package/receipt exchange, held gaps, stable-byte retry, restart/crash recovery, field authority and reviewed conflicts. Tests include accepted team routing visibility, atomic stale-edit refusal, clearing credentials, handshake denial and explicit 503 errors for corrupt ledger reads.
- `BASE_URL=http://127.0.0.1:8646/quotagent/ node src/system/exchange-workbench/tests/browser.mjs`: [four groups PASS](gui-local.json). GUI pairing, queued publication, exact file export/import and receipt; failed HTTP endpoint corrected and retried; labelled independent supplier conflict inspected and accepted; history/reload, mobile and separate admin diagnostics. No JavaScript errors or page overflow.
- `node src/system/webui/tests/conflicts.mjs`: real native HTTP/store test PASS. Stale revision returns HTTP409 with code, current record and next action; rejected write appends no event.
- Integrated Vite build: 77 modules PASS, including concurrent navigation/runtime work.

QEP uses the existing HMAC-SHA256 symmetric pairing. These results do not claim
public-key identity, external production integrations or final public GUI coverage.
Raw screenshots remain in ignored `tmp/agent-experience/exchange/local/`. Domain
commitment binding is verified in the separate procurement integration evidence.
