# Native evidence and reconstruction
<!-- budget: 8192 bytes, hard -->

Owner: `system/evidence`; decision: [ADR-0040](../../../../docs/design/adr/0040-native-evidence-artifacts-and-retention.md).
This replaces historical operator-only export/verify acceptance with the same
useful outcomes in the account GUI. The existing Python hash-chain/Merkle helpers
remain authoritative; no kernel semantics change.

| Retained clause | Executable native acceptance |
|---|---|
| FR-EVIDENCE-001/002/005, NFR-COMP-001 | Export an explicit contiguous range with exact original events, manifest, Merkle root/inclusion proofs and Ed25519 wrapper; verify on an independent store with no original ledger; altered event/proof/signature, missing or wrong trusted key cannot pass |
| FR-EVIDENCE-003, NFR-COMP-002 | Reconstruct a genuine recorded model request and source coverage; missing/malformed/mismatching source checks record a failed result and notification; UI never claims an independent network witness |
| FR-EVIDENCE-006 | Read-only counts by type, correlations, references and time range; admin aggregates contain no event bodies; observations do not append |

Executable checks: `node src/system/evidence/tests/native.mjs` and
`BASE_URL=http://127.0.0.1:8648/quotagent/ node src/system/evidence/tests/browser.mjs`.
The browser must export/download, transfer a public key separately, upload/verify,
inspect a deliberate failed package and reconstruct a recorded request. Only
actual command output and saved evidence can mark these outcomes passed.

Service: `ctx.evidence` provides summary/export/list/download/verify/rebuild.
Private party exports require authorized selected scope; model-call reconstruction
is limited to the calling account. Native mounts after store/accounts/settings,
files and notifications. All additions use append-only evidence events and removable
Cordis effects. Historical `code/evidence-summary.mjs` and tools remain references,
not current native product evidence.
