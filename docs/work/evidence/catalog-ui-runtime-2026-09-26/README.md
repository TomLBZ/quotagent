# Current UI and runtime review
<!-- budget: 4096 bytes, hard -->

Local integrated application: `http://127.0.0.1:8648/quotagent/`, 2026-09-26.
The browser used real login and server validation, actual saved preferences and
ledger event rows. Only source-failure responses were deliberately intercepted.
No account or business commitment was created. This is local evidence; public
release replay and dashboard click-through remain a separate integrator step.

| Command | Observed result |
|---|---|
| `BASE_URL=http://127.0.0.1:8648/quotagent/ EVIDENCE_DIR=tmp/agent-experience/catalog-ui-runtime/browser node src/system/webui/tests/accessibility-browser.mjs` | [8 GUI groups](accessibility.json): native required/email errors; linked hints; actual duplicate-email409 inline field error; implicit and explicit table names; separate saved-view/source failure and recovery; settled390px sidebar; zero JavaScript errors. |
| `node src/system/webui/tests/discovery.mjs` | [2 actual HTTP groups](discovery.json): configurable-prefix public entry/health, slash normalization and native disposal closes listener. |
| `node src/system/runtime/tests/native-events.mjs` | [3 native groups](cordis.json): five actual Cordis event modes, waterfall short-circuit/repeated-next refusal, explicit listener removal, dependency loss/remount, no later timer/listener effects. |
| `node src/system/plugin-manager/tools/lifecycle-check.mjs` | [4 native groups](lifecycle.json): actual child inventory, dependency refusal, installed utility survives Studio unload, persisted disablement/remount and real fiber disposal. |
| `node src/system/plugin-studio/tests/evolution.mjs` | [13 native groups](evolution.json): generated source, immutable revision/restore, realm copies, paired evaluation, observed rollback, retained counterexamples, independent runtime and restart. Model output is an explicit fixture here. |
| `node src/system/plugin-studio/tools/lineage-check.mjs` | [Lineage proof](lineage.txt): global fallback, live configuration remount, deterministic duplicate retirement and concurrent/idempotent installs. |
| `npm --prefix host run build -- --outDir /workspace/projects/quotagent/tmp/agent-experience/responses/assets` | PASS,108 transformed modules. |
| `./run doctor` | Node26.5.1, Python3.13.5, npm11.17.0, Cordis4.0.0-rc.10; existing application healthy. |

Screenshots retained locally under `tmp/agent-experience/catalog-ui-runtime/browser/`:
invalid fields, server email error, hint/focus, named admin table and settled mobile
layout. Visual inspection found clear page titles, section hierarchy, explanatory
empty/error text and bounded table scrolling. A table is intentionally horizontally
scrollable on a phone; no document overflow was observed. Old exact CSS tokens,
SSR-only rules and mandatory CSS card conversion are superseded by ADR0048;
accessible names, visible focus, readable validation and truthful errors remain
functional obligations and were checked separately.
