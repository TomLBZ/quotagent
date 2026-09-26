# G7 native extension evolution evidence
<!-- budget: 8192 bytes, hard -->

Date: 2026-09-26. Scope: thirteen retained clauses in `src/system/plugin-studio/requirements/evolution.md`; decision ADR-0034. Local integrated host only. Public replay is pending host integration; no public deployment is claimed by this record.

## Executed checks

| Command | Observed result |
|---|---|
| `node src/system/plugin-studio/tests/evolution.mjs` | PASS thirteen scenario groups using actual Cordis and Python-backed append-only store; generated-model output is explicitly a deterministic fixture in this native test. |
| `node src/system/plugin-studio/tools/lineage-check.mjs` | PASS active global fallback, account scope, live remount, deterministic restart precedence, duplicate retirement, idempotent install and concurrent scoped loads. |
| `npm --prefix host run build -- --outDir /workspace/projects/quotagent/tmp/agent-experience/g7-assets` | PASS 66 transformed modules. Bundler reports the existing large-chunk advisory; no compilation error. |
| `BASE_URL=http://127.0.0.1:8642/quotagent/ node src/system/plugin-studio/tests/evolution-browser.mjs` | PASS six end-to-end GUI groups, eight screenshots, zero browser errors. Model generation and revision generation used the actual configured provider. |

Raw local evidence: `tmp/product-evidence/extension-evolution/native-report.json`, `lineage.txt`, `report.json`, and screenshots `01-feedback-proposal-diff.png` through `08-consistent-artifact-inventory.png`. The browser report records the generated instance ID and timestamp. All browser mutations used visible controls, including administrator lifecycle changes. The temporary tool performed quantity arithmetic only; no quotation or external commitment was made.

## Observations and clause mapping

| Clause(s) | Source and observed outcome |
|---|---|
| FR-USERPLUG-005, SUPPLEMENT-029 | `installed-plugins/code/artifacts.mjs` binds numbered artifacts to canonical descriptor and exact source/manifest hashes. Native create/edit/restore executes 6 → 9 → 6, checks exact earlier bytes and stale-edit rejection, then restarts successfully. GUI selects prior active revision 1 after deploying revision 2. |
| FR-USERPLUG-008 | `installed-plugins/code/index.mjs` owns generated Cordis children independently. Native disposal removes Studio routes/tools but retains installed execution; GUI disables Personal plugins and marketplace as administrator, then runs the restored tool through Installed tools and receives 6. Studio is re-enabled afterward. |
| FR-UIFB-001, FR-EVOLVE-001 | `plugin-studio/code/evolution.mjs` retains original feedback text/hash, immutable base/candidate, actual descriptor diff, rationale, expected effect, risks, rollback plan and evidence references. GUI used actual AI to create the inactive candidate. `client/evolution.jsx` displays these facts; installed cards expose revision identifiers and a header update notice. |
| FR-EVOLVE-002 | Both calculator sides run the same frozen case through the same normalization/VM functions used by installed execution. Browser case quantity 3 produced baseline total 6 and candidate total 9. Inputs, workspace hash, actual outputs and durations remain recorded. |
| FR-EVOLVE-003 | No review starts with a fabricated pass. Five visible conditions require explicit classifications and measurements. Native test rejects a trial before review, passes all five afterward, and proves model-only skill replay with absent provider usage remains unmeasured and cannot proceed. Explicit failing expected assertions cannot be overridden by a human acceptance classification. |
| FR-EVOLVE-005 | Native global trial executes candidate only for the selected account and baseline for another account. Execution failure removes candidate effects and restores verified baseline. Browser owner-only trial automatically restores baseline after its one actual execution; human deployment is enabled only after an observed trial plus verified restoration. Restart of an interrupted trial restores baseline. |
| FR-EVOLVE-006 | Native third unchanged-proposal failure blocks another attempt; explicit human review note permits a changed approach. Failed attempt records remain visible. |
| FR-MARKET-003/005 | Native test deliberately changes an active artifact in its temporary directory: inventory reports `inconsistent` with named hash disagreement; restoring exact bytes returns consistent. Inventory compares record pointer/descriptor/hash, current artifacts and live registration, with stable bounds and total/truncated counts. Browser inspects consistent installed artifacts. |
| FR-EVOLVE-007 | `evolution.summary` exposes counts for feedback/proposals/cases/reports, passed/failed reviews, trials/activations/verified rollback and bounded recent metadata; native assertion excludes feedback bodies. Studio displays pipeline counts. |
| SUPPLEMENT-030 | Complete GUI tabs cover feedback/diff/history, retained examples, observed replay/review, explicit cohort/limits, trial observations, rollback and human deployment. Assistant self-inspection is ledger-recorded; assistant revision generation creates an inactive draft and links to human review. No assistant tool approves or activates a proposal. |

## Meaning and limits

These results cover generated themes, reference widgets, workflow skills and bounded pure JavaScript utilities. Artifact inventory explicitly covers generated installed artifacts, not every repository module. Paired utility execution is real; visual revisions use paired previews and human assessment. Skill shadow mode is explicitly model-only without tools or external actions. It records actual returned provider token usage when available; unavailable usage cannot pass a resource budget. No dollar price or production success metric is inferred.

The five checks cover this supported capability surface. They do not claim to rerun every kernel/QEP invariant, measure production human intervention automatically, or prove arbitrary generated programs correct. Human result/intervention classifications are identified as review observations. Historical unversioned installations receive a labelled current baseline, preserving their original artifact hash; absent older history is not invented. Account marketplace copies retain independent revision pointers and origin hashes.

Native tests caught and corrected canonical hash stability across ledger reconstruction, parent-service startup dependency, and migration precedence before release. The final children register a reversible effect through a scoped `attach` capability passed by their runtime parent. The three-role marketplace semantics remain covered by the existing lineage check.
