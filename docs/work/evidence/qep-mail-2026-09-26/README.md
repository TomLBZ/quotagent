# Reviewed QEP email — local verification, 2026-09-26
<!-- budget: 6144 bytes, hard -->

Contract: [exchange-mail](../../../../src/system/exchange-mail/requirements.md).
Decision: [ADR-0054](../../../design/adr/0054-reviewed-qep-mail-carriage.md).
Implemented native source plus parent host mounts were tested in the working tree
based on `8ba25ea`; this is local acceptance, not evidence of a public deployment.

| Command | Observed outcome | Evidence |
|---|---|---|
| `node src/system/exchange-mail/tests/native.mjs` | Seven groups pass, two independent native stores, actual SMTP/IMAP; original+receipt2 sends and reviewed recovery3 sends | [native.json](native.json) |
| `BASE_URL=http://127.0.0.1:8650/quotagent/ node src/system/exchange-mail/tests/browser.mjs` | Four GUI groups, eight screenshots, zero JavaScript errors, independent native inventory visible, 390px/reload pass | [browser.json](browser.json) |
| `node src/system/mail/tests/product-smoke.mjs` | Ten groups pass after fixture mailbox support was added; real inbox/sent-folder imports, ingestion, immutable reviewed sends, ownership and disposal | [mail-regression.json](mail-regression.json): 10 checks, SMTP2/Telegram2 |
| `BASE_URL=http://127.0.0.1:8650/quotagent/ EVIDENCE_DIR=tmp/agent-experience/exchange-isolated node src/system/exchange-workbench/tests/browser.mjs` | Four portable/HTTP/conflict/history GUI groups, scoped RFQs and unique GUI-created accounts | [exchange-isolated.json](exchange-isolated.json) |
| `EVIDENCE_DIR=tmp/agent-experience/resend-isolated node src/system/exchange-workbench/tests/resend-browser.mjs` | Three signed gap-request/replay GUI groups, own scoped RFQ/accounts, reload/mobile pass | [resend-isolated.json](resend-isolated.json) |
| `node host/node_modules/vite/bin/vite.js build --config src/system/webui/client/vite.config.mjs --outDir /workspace/projects/quotagent/tmp/agent-experience/qep-mail-assets` | Build passes, 114 modules; existing bundle-size advisory retained | Local assets; no loading-time claim |

Mail acceptance measures exact MIME attachment bytes, source ownership and size
refusal, preview without domain projection, explicit import, duplicate application
once, separately reviewed original signed receipt, and delivery only after verified
receipt import. A separate paired stream carries a held later message, its signed
gap request, and exact original replay through three further reviewed SMTP sends;
IMAP import releases the held successor and records fulfilled recovery. A structured fixture bounce matches exact outgoing Message-ID and
recipient; its external reported failure does not erase the signed QEP receipt or
send again. Unmatched reports stay source mail. Restart and independent plugin
unload preserve ordinary retained mail while removing QEP mail service/routes/UI
extension registrations.

The browser creates labelled fictitious business accounts through registration;
all app writes use visible controls. Test mail servers listen on loopback, route
only to each other, and never forward externally. Admin login reads plugin
inventory only. New exchange/recovery fixtures also use their own GUI-created
accounts, preserving shared demo routes. Mail package, receipt and DSN round trips
use actual SMTP/IMAP protocols, not mocked browser responses. No production
provider authentication, OAuth refresh, internet delivery or live supplier is
claimed. Public acceptance remains pending in the parent deployment task.

The earlier recovery browser attempt crashed during screenshot while several
Chromium checks ran concurrently; its isolated rerun passed without a source fix.
The first mail attempts exposed outdated selector assumptions (nested Field label
and paired contact display); corrected selectors passed. No transport was sent in
those failed early setup attempts.

Selected observed screens: [verified import](03-verified-import.png),
[mobile separate mail/QEP/report states](06-mobile-mail-provenance.png).
All eight original GUI images remain under `tmp/agent-experience/qep-mail-browser`.
