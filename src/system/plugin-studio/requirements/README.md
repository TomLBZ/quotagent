# Plugin studio
<!-- budget: 4096 bytes, hard -->

Owner of natural-language plugin/skill creation, user-scoped installation and disposal,
marketplace publishing and installation, administrator global promotion and deletion.
Source: `docs/product/runtime-contract.md`, acceptance checks 4 and 5.

Implementation: `../code/product.mjs`. A real model produces a theme/widget/skill
descriptor or a calculator descriptor with actual JavaScript implementation. The
plugin compiles that descriptor into a visible executable Cordis module,
persists the module and skill instructions under the runtime store, and loads it as a
Cordis child plugin. Each child registers an account-scoped UI effect; unloading disposes
that effect. Enabled plugins restore on server restart. No directory-wide user scanning.

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
