# Integrated public GUI checks — September 26
<!-- budget: 4096 bytes -->

Public URL: https://novara.remoteblossom.com/quotagent/
Runtime: immutable release `f2366a06a3aa2995d07ed4896b65d8ab724be2c4` at `tmp/releases/integrated-f2366a0`. Production data was backed up before deployment. Clean release build: 80 modules; copied-data preflight: 15 read routes across three account roles, all healthy.

| GUI command (`BASE_URL` above, `EVIDENCE_DIR` below) | Result |
| --- | --- |
| `node src/system/webui/tests/navigation-browser.mjs` | 5 groups passed: commands, deep links/history, sharing, modal keyboard/focus, narrow viewport |
| `node src/system/webui/tests/offline-browser.mjs` | 4 groups passed: Chromium installability, six static cache entries/no API, offline failure/no replay, cache removal |
| `node src/domain/procurement/tests/fulfillment-browser.mjs` | 5 groups passed: actual three-account independent authority; offer/PO; sourced change; partial delivery and retained invoice mismatch then match; supplier/narrow GUI |
| `node src/system/plugin-studio/tests/evolution-browser.mjs` | 6 groups passed using the configured live model: generated tool, retained feedback and proposed revision, actual paired6→9, bounded live trial/rollback, historical restore, Studio-disabled independent installed runtime |

Raw reports/screenshots: `tmp/product-evidence/integrated-release/{navigation-public,offline-public,fulfillment-public-retry2,evolution-public}/`. Tracked JSON reports retain test identities, exact outcomes and screenshot filenames. All four report no browser JavaScript errors. Fulfillment used the same runtime with a test-only navigation wait correction: wait for the named button to exist, including collapsed groups, before opening the group. Initial test navigation timeouts are retained in raw failure directories.

This is partial public acceptance of the ongoing requirement completion goal. Other groups and final independent product evaluation remain pending. Browser installability does not claim an actual operating-system installation. Protocol/runtime fixture checks do not measure live model quality.

Additional public checks against the same immutable runtime: commercial5 (private costing, FX/TCO, schedules, independently reviewed award, CSV and reports); capability4 (real account/plugin changes and requester acknowledgement); runtime5 (fresh isolated GUI account, loopback token protocol, deliberate budget change, saved failing evaluation); teams5 (actual new colleague, reviewed custom authority role, assignment, mention, follow and restart). Commands are their owner `tests/{browser,capability-browser,runtime-browser}.mjs` scripts; tracked named JSON reports record counts and limitations. Runtime fixture modifies only its newly registered test account. Team/runtime harnesses wait for asynchronous workspace selection/record options before acting. All four report zero browser errors.
