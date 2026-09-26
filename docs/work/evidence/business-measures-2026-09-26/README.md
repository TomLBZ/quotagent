# Sourced business measures
<!-- budget: 4096 bytes, hard -->

2026-09-26, owner `domain/response-workbench`, SUPPLEMENT-034. Contract:
[Recorded business measures](../../../../src/domain/response-workbench/requirements/business-measures.md).
Feature code was tested over integration HEAD `163ef4787457aeaf7758ecf9655d68d1dac3dcb2`
with the owned metrics changes present; this is isolated local acceptance, not a
claim about a public release.

`node src/domain/response-workbench/tests/metrics.mjs` → [5 groups passed](native.json).
Independent fixed-clock fixtures verify two 24-hour windows: baseline zero and
current3600-second response,50% line/40% commercial completeness, zero paired human
rewrite, measured comparison delay, declared-rule conformance, and known-zero
configured-rate estimate versus unknown cost. Stale/duplicate/late and unaccepted
quote events cannot inflate the result. Source references include answered
clarification events. A paired human edit to assumption text, exclusion text and
milestone date counts exactly three changes with both draft anchors. Empty, unequal, overlapping and future windows are exercised.
A separate actual Cordis/Python ledger fixture proves no append on read, supplier
and unrelated-account isolation, selected-team authorization, restart and disposal.
Synthetic arithmetic facts are explicitly fixtures, not model-quality evidence.

`node host/node_modules/vite/bin/vite.js build --config src/system/webui/client/vite.config.mjs --outDir /workspace/projects/quotagent/tmp/agent-experience/responses/assets`
→114 modules built (bundle-size advisory only).

`BASE_URL=http://127.0.0.1:8648/quotagent/ EVIDENCE_DIR=tmp/agent-experience/business-measures/browser node src/domain/response-workbench/tests/metrics-browser.mjs`
→ [5 GUI groups passed, no JavaScript errors](browser.json). Existing local native
records supply the data; labelled demo records are included by explicit checkbox.
The earlier window is honestly unmeasured and its history boundary is disclosed.
Request filtering, interactive day selection, actual sequence/hash references,
unequal-range refusal/correction, same-period/source-hash CSV, supplier-only scope,
reload and390px layout all passed. Screens: [desktop](01-observed-baseline.png),
[mobile](03-mobile-measures.png). The tab does not mutate business facts.

Limits: these observations are not a controlled productivity study. They establish
record-derived definitions and equivalent calculation windows, not time saved,
win-rate improvement, causal superiority or invoice totals. Costs are recorded
configured-rate estimates; absent tariffs/tokens remain unknown. No linked human
reference labels exist for detection/false-positive quality, so that rate is
unmeasured. Historical undeclared measurement rules are also unmeasured. Provider,
evidence reconstruction and replay results remain owned by their existing plugins;
the business tab reads only the signed-in account's recorded outcomes.
