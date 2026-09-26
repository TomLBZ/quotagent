# Isolated demo workspace
<!-- budget: 4096 bytes, hard -->

Owner: native system/sandbox; ADR-0047 replaces historical SSR mechanics while retaining design29§11 and sandbox-and-demo outcomes. Scenario business steps belong to domain plugins.

Acceptance: a signed-in client can inspect steps, start a demo, use its normal application pages, leave, resume, reset or clear from the GUI. A persistent visible banner names the synthetic perspective and states that all account tabs use demo data. Account-isolated native services use a distinct data root. Parent authentication/control routes remain explicit; all other API reads/writes/downloads route into the selected child. An unavailable child refuses rather than touching live data, with Exit still available. Reset stops the child before deleting only its generated directory. Unknown scenario/account/role changes refuse. At most32 owner entries are retained. Routes/scenarios/interception and all children dispose.

Executable evidence: `node src/system/sandbox/tests/isolation.mjs` runs current native writers/real Python ledgers, compares real business/settings/file hashes before and after seed/write/reset/clear, checks another account and unavailable scenario, restart and native unload. `node src/system/sandbox/tests/browser.mjs` uses visible client controls and verifies both roles/mobile. Native8 and GUI4 groups passed; source paths, commands and observed limits are recorded in `docs/work/evidence/g8-isolated-sandbox.md`.
