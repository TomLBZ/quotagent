# Native evidence
<!-- budget: 4096 bytes, hard -->

Current owner: `code/product.mjs`, `code/bundle.mjs`, `code/native_bridge.py` and
`client/evidence.jsx`. The plugin provides `ctx.evidence` and the account Evidence &
verification GUI. [Native acceptance](native.md) maps FR-EVIDENCE-001/002/003/005/006
and NFR-COMP-001/002 to executable outcomes.

- Original event slices use unchanged Python hash-chain/Merkle helpers. A new
  Ed25519 wrapper binds exact payload bytes, exporter identity, scope and inclusion
  proofs. Independently supplied public keys establish trust; embedded keys alone do not.
- Account-owned model calls reconstruct the complete request, containing ledger,
  available source digest and measured dispatch bytes. Historical unmeasured calls
  are explicit; failures produce recorded results and notifications.
- Owner and administrator observations contain counts, never private bodies.
  Reading these statistics does not append events.

Run `node src/system/evidence/tests/native.mjs`,
`BASE_URL=http://127.0.0.1:8648/quotagent/ node src/system/evidence/tests/browser.mjs`,
or verify a carried package with
`node src/system/evidence/tools/verify-native.mjs PACKAGE.audit.json TRUSTED.public.pem`.
[Recorded local evidence](../../../../docs/work/evidence/native-artifacts-2026-09-26/README.md)
distinguishes native, actual-provider, browser and standalone checks.

Historical AC-AUDIT-001/002/004 and AC-EVIDENCE-003 explain retained outcomes.
`code/evidence-summary.mjs`, the old wrapper entry and operator tools are historical
implementations, not proof that the native account GUI was exercised. Kernel
helpers remain reused without semantic edits. Signing keys stay outside the ledger;
loss of a previously used key requires restoring its backup, never silent replacement.
