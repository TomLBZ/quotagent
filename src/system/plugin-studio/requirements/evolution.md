# Native extension evolution
<!-- budget: 12288 bytes, hard -->

Decision: [ADR-0034](../../../../docs/design/adr/0034-immutable-extension-revisions-and-runtime-ownership.md). Management owner is `system/plugin-studio`; installed execution and artifacts belong to `system/installed-plugins`. This contract maps every G7 clause from `tmp/agent-experience/requirements-audit.json`; the source documents below remain the requirement origins. Implemented in the sources below; local native and real-model GUI evidence is recorded in `docs/work/evidence/EV-G7-NATIVE-EVOLUTION.md`. Public replay remains a release step owned by the host integrator.

| Retained clause | Native outcome and acceptance |
|---|---|
| FR-EVOLVE-007 | Read-only bounded counts and recent metadata for proposals, shadow passes/failures, trials, promotion and rollback; no feedback/source bodies in summary. |
| FR-UIFB-001 | Account-owned feedback with original text/hash/target → model or manual proposed revision → reviewed activation → visible persisted revision/update notice. SSR, cron and CLI-only write mechanics are replaced by native GUI/plugin services. |
| FR-EVOLVE-001 | Proposal stores target, base/candidate immutable references, actual diff, rationale, expected effect, risks, rollback plan and evidence references. |
| FR-EVOLVE-002 | Baseline/candidate use identical frozen case inputs; actual executable outputs, durations and measured usage are recorded side by side. Prompt replay is explicitly model-only; visual changes require human preview judgment. |
| FR-EVOLVE-003 | Five visible outcomes all required for pass: nonregressing quality, supported-surface invariants, retained counterexamples, measured resource budgets, nonincreasing human intervention. Unknown is never passed. |
| FR-EVOLVE-005 | Explicit cohort/limits; actual canary observations; exceeded limits automatically remove candidate effects and restore verified baseline with recorded result. |
| FR-EVOLVE-006 | Three failed similar attempts require explicit human review before another attempt; the failed history remains visible. |
| FR-MARKET-003 | Generated-artifact inventory compares ledger, artifact/manifest disk hashes and live registration, with field-level inconsistency reasons. Scope is installed artifacts, not all repository metadata. |
| FR-MARKET-005 | Inventory/summary read projections have stable ordering, limits and total/truncated counts; metadata only, no private spec/source/feedback bodies. |
| FR-USERPLUG-008 | Disabling Studio removes management but leaves installed themes/widgets/tools/skills active and reachable. New generation/edit/install requests cannot succeed while management is absent. |
| FR-USERPLUG-005 | Content revisions monotonically allocate immutable numbers. Restore only selects an existing recorded revision, verifies disk bytes and remounts before success is recorded. |
| SUPPLEMENT-029 | Version selector, descriptor/source differences, artifact identity, validation/replay and tested rollback evidence before promotion; source `docs/design/07-self-evolution.md` §3 and user-plugin-manager requirements. |
| SUPPLEMENT-030 | Self-inspection and complete proposal/shadow/review/canary/rollback GUI with outcomes; no generated kernel/configuration-authority mutation. Source `docs/design/07-self-evolution.md` and evolution requirements. |

Historical clause sources: `docs/work/functional-requirements.md` (EVOLVE-007/UIFB-001), `docs/work/functional-requirements-archive.md` (EVOLVE-001/002/003/005/006), `docs/work/functional-requirements-archive-b.md` (MARKET-003/005, USERPLUG-005/008). Existing account/market/global lifecycle and real model generation remain supported.

Service split: `ctx.installedPlugins` owns installed list/get/run, immutable revision/history/restore, artifact inspection and runtime trial/rollback. Studio consumes it for generation/configuration/copy/publication and exposes proposal/feedback/shadow/review operations. Optional services use disposable Cordis injection; all routes/tools/UI metadata use effects. Host mounts installed runtime after procurement and before Studio; it is not a child of Studio.

HTTP/UI targets: existing `/studio` generation/configuration routes remain; new revision/evolution operations live under `/studio/evolution/:id/*`, proposal/shadow/trial controls under `/studio/proposals`, `/studio/shadows` and `/studio/trials`, summary under `/studio/evolution/summary`. Runtime `/installed-plugins`, `/installed-plugins/inventory`, `/:id/run` and observation routes stay available independently. UI gives current/past revision, preview/diff, feedback, candidate review, paired replay, explicit trial scope, observed results and restore/rollback controls. The assistant tools `inspect_extension_evolution` and `propose_extension_revision` support read-only inspection and inactive drafts; no model tool can start a trial or activate a revision.

Data: immutable revision records and artifacts, instance active pointers, provenance-bound copies, account feedback, candidate proposals, append-only cases, frozen shadow outputs plus attributed human review, cohort trials and observations. Runtime restart reconstructs active records; no unconfirmed delivery-like outcome is invented. Existing ledger/QEP semantics and domain commitment approvals are untouched.

Executable acceptance (targets):
- `node src/system/plugin-studio/tests/evolution.mjs`: actual native runtime/store, immutable artifact identity, independent management unload, source-backed comparisons, paired case execution/five outcomes, counterexample retention, three-failure escalation, scoped canary observations and automatic rollback, copy isolation, mismatch inventory, restart recovery.
- `BASE_URL=http://127.0.0.1:8620/quotagent/ node src/system/plugin-studio/tests/evolution-browser.mjs`: GUI generation/edit/history/diff/restore, feedback proposal, shadow/review/trial/rollback, surviving installed-tool run when Studio is disabled, responsive controls; public replay after deployment.
- Existing `src/system/plugin-studio/tools/lineage-check.mjs` and `src/system/plugin-studio/tools/live-utility-check.mjs` are updated for independent runtime composition and retain their meaningful scope/lineage/custom-code checks.
