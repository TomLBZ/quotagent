# Native plugin lifecycle
<!-- budget: 4096 bytes, hard -->

`node src/system/plugin-manager/tools/lifecycle-check.mjs` passed4 groups on
2026-09-26 using actual native store, accounts, settings, provider, installed runtime
and Studio. [Recorded output](report.json).

The previous check used incomplete service stubs and required Studio unloading to
remove `studioRuntime`. That contradicted ADR-0034's independent installed owner.
The replacement verifies actual child inventory, configuration association and
provider dependency refusals. An actual saved utility returns6 before/after Studio
disposal,8 after provider disposal, and10 after manager restart/remount; the single
immutable revision remains. Disabling installed execution removes its contributions.
Manager disposal removes managed fibers and services. No model or network call is
made; inputs and generated utility source are explicitly local fixtures.

This checks actual plugin composition, not UI or model quality. Public installed
runtime behavior is separately exercised by the evolution GUI journey.
