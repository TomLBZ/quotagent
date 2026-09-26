# Independent installed plugin runtime
<!-- budget: 4096 bytes, hard -->

Native owner for installed extension fibers, immutable artifact revisions, account-visible execution and limited-rollout observation/rollback. Management remains in optional Plugin studio. [Evolution requirements](../../plugin-studio/requirements/evolution.md) map the thirteen retained clauses; [ADR-0034](../../../../docs/design/adr/0034-immutable-extension-revisions-and-runtime-ownership.md) defines ownership and revision semantics.

Host ordering: web/store/accounts and procurement first, installed-plugins next, Studio afterward. Runtime provides `installedPlugins` and owns the `studioRuntime` utility child. It restores active account/global instances independently of Studio and disposes all its own fibers/registrations when explicitly unloaded. Generated children receive a scoped `attach` capability in Cordis config and register it with `ctx.effect`; they do not depend on their parent’s still-starting provided service. Descriptor hashes canonicalize object keys so durable reconstruction preserves artifact identity.

The Installed tools page and `/installed-plugins/:id/run` stay available when management is disabled. Read-only artifact inventory has stable bounds and compares recorded revision, disk artifacts and live registrations; inconsistent sources yield named differences. Marketplace copies keep their own immutable revisions and reference the originating hashes. Restoring one copy does not modify other accounts.

Acceptance is shared with `node src/system/plugin-studio/tests/evolution.mjs` and the native GUI journey in that plugin. Local native and real-model GUI evidence is recorded in `docs/work/evidence/g7-native-evolution.md`; the public release replay remains an integration step.
