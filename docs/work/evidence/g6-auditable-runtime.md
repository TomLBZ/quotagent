# G6 — native runtime limits and recorded evaluation
<!-- budget: 8192 bytes, hard -->

Date: 2026-09-26. Sources: ADR-0038; `src/system/agent-runtime/requirements/controls-and-evaluation.md`; `src/system/agent-workflows/requirements/README.md`. Root owns release/commit. These results cover native code and isolated GUI; they are not a public deployment claim.

## Executed acceptance

| Command | Observed result |
|---|---|
| `node src/system/agent-runtime/tests/provider-controls.mjs` | PASS 14 groups, 15 actual loopback HTTP requests. Explicit/unknown pricing, integer micro-unit charges, oversized request vs rolling exhaustion and injected rollover, in-flight/durable dedup/failure/conflict, one half-open probe, bounded eligible retry with Retry-After, backpressure/queue timeout/cancel, actual timeout without retry, bounded prefix subscription/dedup/disposal, realm metadata, whole-record/turn context coverage, native unload; quarantined-realm startup isolation and incomplete admin aggregates. |
| `node src/system/agent-runtime/tests/evaluation.mjs` | PASS 7 groups. Four synthetic scenario families execute native assistant + real HTTP + real ledger; cases freeze actual recorded output/events, require action-center human acceptance, replay assertions twice identically without model calls, retain a failed counterexample, remain account-owned, survive store/runtime restart, preserve reservation/request identities, and exclude old/untagged perspective from new model history. |
| `node src/system/agent-runtime/tests/usage.mjs` | PASS 6 groups. Historical/partial/cache counts, account/admin projections, five loopback response outcomes, once-only usage receipt, real ledger restart and disposal. |
| `node src/system/agent-runtime/tests/controls.mjs` | PASS 8 groups. Pause/stop/resume/steer, delayed-write/tool receipts, restart ambiguity, unload, pinned team, changed role refusal and correctly tagged new task. |
| `node src/system/agent-workflows/tests/state.mjs` | PASS 8 groups; 12 controlled model calls; actual independent-agent overlap 2. Existing memory, human checkpoints, isolation, cancellation and dependencies retained. |
| `node src/system/agent-workflows/tests/cancellation.mjs` | PASS 3 cancellation/recovery races. |
| `node src/system/agent-workflows/tests/scope.mjs` | PASS 2 native Cordis/real-ledger groups; 13 controlled model calls and 7 tool calls retain original team after navigation. Role change rejects resume with zero dispatch; cancel/new supplier task works. |
| `host/node_modules/.bin/vite build --config src/system/webui/client/vite.config.mjs --outDir /workspace/projects/quotagent/tmp/agent-experience/g6-assets` | PASS 78 modules in the final integrated build. Build reports a >500kB bundle advisory; no performance improvement is inferred. |
| `BASE_URL=http://127.0.0.1:8647/quotagent/ node src/system/agent-runtime/tests/runtime-browser.mjs` | PASS 5 GUI groups, zero browser errors, 7 screenshots, desktop and 390px. All changes made through visible GUI. Configured budget refuses; human changes budget and resumes; context omissions remain visible; cost distinguishes unknown vs a matching synthetic tariff; captured failing case goes through readable human approval and recorded replay. |

Native raw outputs: `tmp/provider-controls-YhXyu4/report.json`, `tmp/usage-smoke-dk3LZz/`, `tmp/workflow-scope-ixkTX3/report.json`. Latest evaluation: `tmp/native-evaluation-8D0u5R/report.json`; rerunning creates `tmp/native-evaluation-*/report.json` with source run IDs, snapshot hashes and explicit fixture limitation. GUI report/screens: `tmp/agent-experience/g6-browser/` (01 budget refusal, 02 context receipt, 03 unknown cost, 04 configured estimate, 05 human review, 06 retained failure, 07 mobile).

GUI fixture launch: `node src/system/agent-runtime/tests/provider-fixture.mjs` binds loopback8653 only. Isolated host8647 uses `QUOTAGENT_PRODUCT_DATA=tmp/agent-experience/g6-browser-data` and the above asset directory. The browser configures provider `g6-loopback`, model `g6-protocol-fixture`, URL `http://127.0.0.1:8653/v1`, credential `fixture-only`. Synthetic tariff 2 input/4 output currency units per million gives **USD0.00036** for a reported120input/30output-token call. This rate is test data, not a provider price. Provider outputs clearly identify themselves as protocol fixtures; no outbound procurement/mail/chat commitment was sent.

## Source and limits

Native composition `agent-runtime/code/product.mjs` owns `product-provider-controls` through `product-ai` and `product-run-evaluation`. Their settings, services, routes, tool/approval registrations and diagnostics are disposable; no host/core business import is required. `client/usage.jsx` exposes Tokens & cost / Runtime controls / Recorded evaluations; shared `runtime-panels.jsx` supplies conversation/workroom receipts and the evaluation action preview. Safe declared link keys contain only IDs/tabs.

`provider-controls.mjs` reserves before dispatch, reconciles only complete usage, retains unknown attempt cost, and never retries timeout/network ambiguity. Tariffs are exact provider/model bindings with human source/date, integer micro-unit estimates and separate currencies; they are not bills. Unknown counts/cost remain unknown. Runtime views are read-only; admin sees aggregate metadata only. `context.mjs` omits whole records/turns and records counts, bytes, hashes and reasons. `perspective.mjs` prevents role changes from repurposing saved context; untagged legacy tasks require a new task, and previous-role transcripts are explicitly excluded with ledger evidence.

`product-evaluation.mjs` replays **recorded assertions**, not fresh model execution. Four fixture families exercise materials, subcontract scope, currency/terms and untrusted-source labels but do not establish live reasoning quality or attack resistance. Counterexamples require human acceptance and have no delete/overwrite route. Baselines report recorded status/token/duration coverage; elapsed time can include human waits. Quote completeness, procurement cycle-time improvement and business quality stay unmeasured. Supplier descriptive observations remain G2 commercial-workbench ownership. Live public model/user evaluation belongs to the root release check.

Measured dispatch follow-up (ADR-0043):
`node src/system/agent-runtime/tests/dispatch.mjs`, 2026-09-26, exit0;
[two checks PASS](runtime-controls-2026-09-26/dispatch.json). The actual local HTTP
request (150 UTF-8 bytes, including Unicode and newlines) equals reconstruction
from the recorded request and declared sorted-key serialization. Boundary hash and
length agree; replay sends no second request. This observes local dispatch, not
remote model execution or historical calls without this event.
