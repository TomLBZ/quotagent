# Native collection views
<!-- budget: 4096 bytes -->

Owner `system/webui`; consumer `system/action-center`; ADR-0046 and `src/system/webui/requirements/collections.md` define the contract.

- `node src/system/webui/tests/collections.mjs`:5 groups passed against the real ledger.257 source rows, independent query/sort/page comparison, whole-source enums/counts/keys, read-only query, account/role preference replay, stale update refusal, reset history, unload and CSV formula escaping.
- `node src/system/webui/tests/collections-browser.mjs`:5 groups passed. Native action service seeded36 explicitly synthetic proposals into an isolated directory, then the ordinary GUI showed10 rows per page, retained selections across pages, selected all36, cleared selection on a new query, saved/reloaded filters and export columns, downloaded exactly10 matching rows/one selected column, ignored an intentionally delayed older response, and displayed a503 source error.390px screenshot/no browser errors. No fixture proposal was executed.
- `node src/system/action-center/tests/state.mjs`:9 existing action/settings/notification groups passed.
- `node src/system/action-center/tests/independent.mjs`:7 existing independent authority/batch/restart/perspective groups passed;117 events and2 fixture deliveries.
- `node host/node_modules/vite/bin/vite.js build --config src/system/webui/client/vite.config.mjs --outDir /workspace/projects/quotagent/tmp/agent-experience/collections-build`:90 modules passed. Bundle-size advisory remains.

Raw GUI data/screens/download: `tmp/collection-gui-mbVxRK/`; native `tmp/collections-QpwRfJ/`. `native.json` and `gui.json` retain observations. This is local acceptance; public replay follows immutable release integration. Server source projection still reads the owner's full collection; transport/DOM are paginated. Batch reviews cap at50 and refuse larger all-match selection without truncation.
