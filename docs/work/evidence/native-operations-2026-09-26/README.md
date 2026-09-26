# Native operations execution
<!-- budget: 4096 bytes, hard -->

Executed 2026-09-26 with actual native Cordis/store composition and isolated
loopback application data. Public replay remains an integration step.
Contract: [native operations](../../../../src/system/observability/requirements/native.md).
Decision: [ADR-0050](../../../design/adr/0050-native-operational-metadata.md).

| Command | Observed result |
|---|---|
| `node src/system/observability/tests/native.mjs` | 4 groups PASS: actual ledger counts and private canary exclusion; explicit partial/unavailable source coverage; own/joined account metadata isolation; periodic derived file and full disposal. [Output](native.json). |
| `node src/system/observability/tests/browser.mjs` | 5 groups PASS: separate admin native-provider/plugin summary and JSON download; settings preview/apply/reload; contractor and supplier timeline filters/save/reload; all three390px views without overflow or JavaScript errors. [Output](browser.json). |
| `node src/system/teams/tests/state.mjs` | 5 groups PASS, raw `tmp/teams-state-MmDw1G`: membership, actual QEP actor/owner distinction, authority/independent policy decisions, daily collaboration, removal/disposal. |
| `npm --prefix host run build -- --outDir /workspace/projects/quotagent/tmp/agent-experience/operations-build` | PASS100 modules, isolated output; public distribution unchanged. |

A quarantined unrelated realm previously broke discovery for every same-side
account. Teams now validates the current workspace and excludes unreadable other
candidates; own/current unavailability still fails explicitly. Operations aggregates
report source coverage. Timeline metadata covers readable authorized workspaces;
it is not an export of every account or a completeness certificate.

Snapshots contain operational counts, not business record bodies. Their collection
source whitelist and observed state counts are views of the current runtime, not
an uptime guarantee. GUI [snapshot](operations-summary.json) and mobile screenshots
([admin](admin-mobile.png), [contractor](contractor-mobile.png),
[supplier](supplier-mobile.png)) are retained.
