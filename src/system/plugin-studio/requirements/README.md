# Plugin studio
<!-- budget: 4096 bytes, hard -->

Optional management owner for natural-language plugin/skill creation, configuration,
marketplace sharing, administrator promotion and the revision review workflow.
Installed capabilities and artifact lifecycle belong to `system/installed-plugins`.
Source: `docs/product/runtime-contract.md`, acceptance checks 4 and 5.

Implementation: `../code/product.mjs`. A real model produces a theme/widget/skill
descriptor or a calculator descriptor with actual JavaScript implementation. The
management plugin asks the installed runtime to compile an immutable, numbered Cordis
artifact and load a native child. The child receives a scoped attach capability and
registers a reversible effect. Enabled plugins restore independently of Studio, including
when Studio is disabled. No directory-wide user scanning.

Publication exposes a marketplace listing. Installation creates an independent personal
copy. Administrator promotion creates an independent global default plugin. Only its
owner or an administrator can manage a personal plugin; only administrators manage
global plugins. Skill execution calls the real assistant with the saved instructions.

Executable utilities use number/text input schemas, model-authored `spec.code`, and
only the calling account's read snapshot. `../code/tool-runtime.mjs` registers their
callable behavior as Cordis effects and executes pure code with a timeout. The runtime
contains no domain formulas. Publication/install/promotion preserve executable source.
The narrow live-provider check is `node src/system/plugin-studio/tools/live-utility-check.mjs`.

Generation, lifecycle, skill and utility execution are recorded through workspace-store. Full
provider input/output uses agent-runtime. Executable artifacts remain local runtime data.

Revision history, feedback proposals, paired evaluation, five review checks and observed
trials are specified in [evolution.md](evolution.md). Read-only assistant inspection is
ledger-recorded; assistant-generated revisions remain inactive until human review.
