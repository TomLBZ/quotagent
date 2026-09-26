# Native evidence, attachments and retention
<!-- budget: 8192 bytes, hard -->

Executed 2026-09-26 against isolated app `http://127.0.0.1:8648/quotagent/` and
private temporary stores. These are local implementation checks; public deployment
acceptance remains a separate integration step. No production files were disposed.

Decision: [ADR-0040](../../../design/adr/0040-native-evidence-artifacts-and-retention.md).
Requirements: [evidence](../../../../src/system/evidence/requirements/native.md),
[attachments](../../../../src/system/attachments/requirements/native.md),
[retention](../../../../src/system/retention/requirements/native.md),
[file lifecycle](../../../../src/system/file-store/requirements/lifecycle.md).

| Command | Observed result and retained output |
|---|---|
| `node src/system/evidence/tests/native.mjs` | 4 groups PASS: exact original Python package bytes, independent Ed25519/chain/Merkle/proof verification, trusted-key and tamper failures, real loopback HTTP dispatch reconstruction and restart/disposal. [Report](evidence-native.json) |
| `node src/system/attachments/tests/native.mjs` | 6 groups PASS: actual two-store QEP resources, altered-byte refusal, held delivery and restart/reimport, immutable versions/tombstones, all four business object kinds and concurrent version allocation. [Report](attachments-native.json) |
| `node src/system/retention/tests/native.mjs` | 5 groups PASS: shared blobs, current holds and object references, own-project policy constraints, genuine removal with ledger prefix intact, capacity/integrity/I/O evidence and interrupted-intent recovery. [Report](retention-native.json) |
| `BASE_URL=http://127.0.0.1:8648/quotagent/ node src/system/evidence/tests/browser.mjs` | 4 groups PASS: GUI export/key download, separate reviewer upload and trusted verification, actual configured model request reconstruction, private history/admin counts/mobile. [Report](evidence-browser.json) |
| `BASE_URL=http://127.0.0.1:8648/quotagent/ node src/system/attachments/tests/browser.mjs` | 4 groups PASS: both parties use GUI/QEP, intended recipient downloads equal bytes while another bidder sees none; versions/removal survive reload; PNG/PDF/text previews and narrow viewport. PDF assertion checks actual nonblank canvas pixels. [Report](attachments-browser.json) |
| `BASE_URL=http://127.0.0.1:8648/quotagent/ node src/system/retention/tests/browser.mjs` | 5 groups PASS: account and project policies, object-reference guard, hold/release, exact reviewed removal and durable result, admin body-free totals/mobile. [Report](retention-browser.json) |
| `node src/system/evidence/tools/verify-native.mjs tmp/agent-experience/artifacts/evidence/source.audit.json tmp/agent-experience/artifacts/evidence/trusted.public.pem` | 14 checks PASS without access to the original store. Package and separately supplied key remain private temporary artifacts. [Report](standalone-verification.json) |
| `node src/domain/ingestion/tests/smoke.mjs` | 7 groups PASS, `tmp/ingestion-smoke-Dajc1o`: existing uploads/Buffer reads, source parsing and private supplier import remain compatible. |
| `node src/system/workspace-store/tests/exchange.mjs` | 9 groups PASS, `tmp/exchange-smoke-wU3JZf/report.json`: existing durable QEP delivery/conflict/recovery and corrupt-store behavior remain compatible. |
| `npm --prefix host run build -- --outDir /workspace/projects/quotagent/tmp/agent-experience/artifacts/assets` | PASS, 100 modules; PDF parser/worker emitted as separate browser chunks. |

Retained clauses: FR-EVIDENCE-001/002/003/004/005/006, FR-STORAGE-001/004/006,
CURRENT-012, SUPPLEMENT-003/004/005/027 and NFR-COMP-001/002/003. Their per-plugin
requirements map each outcome to the executed commands above. This does not claim
that historical operator-only gates or unrelated business clauses were executed.

Screenshots: [independent verification](independent-verification.png),
[model reconstruction](model-reconstruction.png), [version history](attachment-history.png),
[rendered PDF](pdf-preview.png), [project constraint](project-retention.png),
[exact disposal review](disposal-review.png), [actual result](disposal-result.png).

Evidence limits: an embedded public key alone does not establish exporter identity;
the verifier requires a separately trusted key. QEP retains its configured HMAC trust
model; the outer audit signature is independent. Reconstructed dispatch bytes are
the application's measured pre-fetch boundary, not a network witness. Historical
calls without that measurement remain explicitly unmeasured. Private exports can
contain all facts in their chosen contiguous range, including private business data.
PDF preview renders one bounded page at a time; original download preserves the full
document. Disposal removes eligible local file bytes only: append-only ledger facts,
existing exported copies and counterparty copies remain. Shared references and the
strictest applicable own-project policy can retain content. No automatic destructive
timer or fabricated successful disposal is used.
