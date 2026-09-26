# Agent experience evidence
<!-- budget: 8192 bytes, hard -->

Scope: assistant controls, workspace styles, role guides and provider usage.
Local integrated verification uses an isolated copy of demo ledgers at loopback8620;
public verification is pending. This evidence does not close the wider requirements
completion objective or imply all historical business features are implemented.

| Command | Observed result |
|---|---|
| `node src/system/agent-runtime/tests/controls.mjs` | 6 groups: model abort/resume/guidance, retained tool receipts, delayed stop writes, uncertain recovery, isolation and disposal |
| `node src/system/agent-runtime/tests/usage.mjs` | Historical replay/filter/isolation; five actual local HTTP outcomes, unknown usage and real-ledger restart/disposal |
| `node src/system/workspace-styles/tests/smoke.mjs` | Native Cordis registration, account styles, role guide progress, restart and disposal |
| `BASE_URL=http://127.0.0.1:8620/quotagent EVIDENCE_DIR=tmp/agent-experience/controls-local node src/system/agent-runtime/tests/controls-browser.mjs` | 9 GUI checks with actual configured model; [output](controls-local.json) |
| `BASE_URL=http://127.0.0.1:8620/quotagent/ EVIDENCE_DIR=tmp/agent-experience/usage/local node src/system/agent-runtime/tests/usage-browser.mjs` | 5 groups, historical actual token charts, filters/admin/account boundaries and390px; [output](usage-local.json) |
| `BASE_URL=http://127.0.0.1:8620/quotagent/ node src/system/workspace-styles/tests/browser.mjs` | Three-role style/tutorial/help journey, persistence,390/1024px and no JS errors; [output](workspace-local.json) |
| `BASE_URL=http://127.0.0.1:8620/quotagent/ node src/system/workspace-styles/tests/lifecycle-browser.mjs` | Disable/re-enable each plugin removes/restores owned GUI contributions; [output](lifecycle-local.json) |

Build: `host/node_modules/.bin/vite build --config src/system/webui/client/vite.config.mjs --outDir /workspace/projects/quotagent/tmp/agent-experience/build` →50 modules PASS.
A separate race review reproduced rapid pause/resume/stop and wrong-account control;
fixes abort the latest queued controller, validate ownership before abort, and make
Resume on running state idempotent. Core test now covers those behaviors.
