# ADR-0034 Immutable extension revisions and independent installed runtime
<!-- budget: 8192 bytes, hard -->
Status: accepted

## Problem

`src/system/plugin-studio/code/product.mjs` currently owns generated Cordis children, overwrites each artifact and writes version `1.0.0`. Disabling Studio therefore disables installed capabilities; prior artifacts cannot be selected or checked against the live revision. Configuration edits have no native proposed diff, paired evaluation or observable limited rollout. Retained outcomes are the thirteen G7 clauses mapped in `src/system/plugin-studio/requirements/evolution.md`.

## Decision

1. A separate native `system/installed-plugins` owns installed fibers, utility execution, account-visible runtime pages and artifact lifecycle. Studio is an optional management client of `ctx.installedPlugins`. Its unloading removes generation/edit/proposal endpoints and assistant tools, while installed contributions, run endpoints, observations and automatic rollback remain active. Unloading the installed runtime intentionally removes its own fibers/effects. Host composition mounts the installed runtime before Studio; no kernel lifecycle wrapper replaces Cordis. Generated children receive a scoped `attach` capability in their Cordis config and register it as an effect, avoiding a startup dependency cycle on their own parent. Descriptor hashes use canonical object-key ordering; source/manifest hashes bind exact bytes.
2. Each extension instance has immutable numbered revisions. A revision binds its descriptor, generated module bytes and manifest bytes to hashes. Content changes allocate a new number; a number cannot identify different bytes. An active pointer may select a real earlier revision. Restore verifies the stored artifact, installs those exact bytes, remounts the actual child, checks the active artifact and only then records successful restoration. Failures restore the previous live revision or report an explicit unavailable state. Current unversioned installations receive a labelled imported baseline; this does not invent missing historical version numbers.
3. Account installations and promoted global instances keep independent IDs and active pointers. Copy provenance binds the originating instance, revision and content/artifact hashes. Changing or restoring one instance never rewrites another account’s copied artifact. Publication/installation/global-promotion permissions and lineage precedence remain as defined by current Studio behavior.
4. Studio persists feedback and structured proposals containing target/base/candidate revisions, source/descriptor differences, rationale, expected effect, risks, rollback plan and source references. Model-assisted revisions remain proposals. Live installation, trial and restoration require explicit GUI actions. Similar failed proposal attempts are counted; three failures require a human review note before another attempt. No generated revision writes kernel, QEP, credentials or another account’s private record.
5. Shadow evaluation runs baseline and candidate against the same frozen, recorded inputs. Append-only cases retain previous counterexamples. Executable utilities run their actual bounded JavaScript; skills use an explicitly labelled model-only prompt replay without external actions; visual extensions expose paired descriptor/render previews for recorded human assessment. Reports distinguish executed observations, human judgments and unavailable measurements. They do not use a model’s self-rating as evidence.
6. Five simultaneous review outcomes remain visible: target quality does not regress; supported capability invariants pass; retained counterexamples pass; measured resource use stays within human-selected budgets; human-intervention rate does not rise. Missing measurements or human classifications remain unmeasured and cannot be reported as passed. Checks are scoped to the supported extension surface; a report does not claim to rerun all kernel invariants or measure production business outcomes.
7. A canary binds an immutable candidate to explicit account IDs and declared observation limits. The baseline remains available outside that cohort. Actual executions and explicit user preview judgments produce observations. Exceeded limits or execution failure trigger removal of candidate effects and restoration of the verified baseline, with a durable receipt. Promotion uses the recorded evaluation/trial/rollback evidence; nothing is presented as successful merely because time passed. Interrupted trials reconstruct their explicit state and baseline artifacts after restart.
8. An installed-artifact inventory compares ledger revision metadata, on-disk artifact/manifest hashes and live registrations. Mismatches are `inconsistent` with field-specific differences, never silently chosen away. The read-only result is stably ordered, bounded, includes total/truncated counts and contains metadata only. This inventory covers generated installed artifacts; it does not claim an aggregate scan of every repository plugin. Evolution summaries likewise expose counts/recent event metadata, not feedback bodies or private source content.

Additive event families are `studio/revision-*`, `studio/feedback-*`, `studio/proposal-*`, `studio/shadow-*`, and `studio/canary-*`; existing `studio/plugin-*` and `studio/tool-ran` meanings remain. Model requests/results remain recorded through `ctx.ai`. New events are append-only projections through the existing store; ledger/QEP semantics are unchanged.

## Consequences

Installed capabilities survive optional management downtime and users can inspect the actual version behind an effect. Rollback and trial results become explainable, account-scoped facts. Immutable artifacts consume more disk; retention must preserve revisions referenced by active installs, proposals, observations or provenance. Non-executable visual/prompt comparisons require explicit human assessment, and unavailable metrics can prevent a full pass. Scope-limited replay cannot establish arbitrary production correctness.

## Alternatives rejected

| Alternative | Rejection |
|---|---|
| Keep children under Studio but hide its page | A disabled management plugin would still own runtime effects and could not truly unload. |
| Overwrite artifacts and rely on ledger text alone | A claimed historical version could disagree with disk or active implementation. |
| Treat a model’s success statement as evaluation | It does not establish execution, quality or reduced human intervention. |
| Quietly update every copy when a market item changes | It violates account ownership and makes rollback alter unrelated installations. |
| Restore old CLI-only review carriers | Users must complete the workflow through the native GUI. |

## Revisit conditions

Revisit when generated plugins gain external effects beyond the bounded supported surface, remote artifact distribution/signatures are added, or retention/organization tenancy changes the ownership of immutable revisions.
