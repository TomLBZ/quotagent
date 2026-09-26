# G1 sourced defaults and paired-party execution
<!-- budget: 8192 bytes, hard -->

Executed 2026-09-26 against native Cordis plugins, the actual append-only workspace
store and signed QEP adapter. Owner contract:
[context defaults and peers](../../../src/domain/procurement/requirements/context-defaults-and-peers.md).
Raw reports, response captures and screenshots remain under ignored
`tmp/product-evidence/procurement-context/`; fixture accounts are local only.

| Command | Result and scope |
|---|---|
| `node src/domain/procurement/tests/context-defaults.mjs` | PASS 5: sourced precedence, explicit edits, team authority, supplier isolation, actual paired contacts, disabled/manual handoff, removed-route preflight, durable remount and disposal. Raw `tmp/product-evidence/fulfillment/verification/context-defaults.json`. |
| `BASE_URL=http://127.0.0.1:8645/quotagent/ node src/domain/procurement/tests/context-defaults-browser.mjs` | PASS 3: GUI hierarchy configuration, manually edited form preserved across defaults refresh, saved draft source survives reload. `defaults/report.json`, response captures and three screenshots; no JavaScript errors. |
| `EVIDENCE_DIR=tmp/product-evidence/procurement-context/paired-final node src/domain/procurement/tests/paired-party-browser.mjs` | PASS 4: separate complete applications at ports 8645/8652, GUI account creation and explicit pairing, RFQ publication, reverse quotation, applied signed receipts. Public total 200 from price 20 × quantity 10; supplier private cost 12 and preparation metadata absent from contractor response. `paired-final/report.json`, captures and screenshots; no JavaScript errors. |
| `node src/domain/procurement/tests/fulfillment.mjs` | PASS 6 groups, 470 events: bilateral award/signing, independent grant, exact amounts, line changes, acceptance/invoice matching, queued delivery and replay. Raw `tmp/product-evidence/fulfillment/verification/context-fulfillment-regression.json`. |
| `node src/domain/procurement/tests/rfq-lifecycle.mjs` | PASS 4 groups, 286 events: publication versions, structured clarifications, stale-quote refusal, rebid/FAQ and replay. Raw `tmp/product-evidence/fulfillment/verification/context-rfq-regression.json`. |
| `npm --prefix host run build -- --outDir /workspace/projects/quotagent/tmp/agent-experience/rfq-build` | PASS 88 modules; isolated assets only. |

All paired business writes used visible GUI controls. Response recording is
read-only and omits submitted pairing credentials. This is local integration
evidence; public deployment/replay remains a separate root integration task.
