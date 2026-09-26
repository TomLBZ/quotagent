# Native artifact lifecycle
<!-- budget: 4096 bytes, hard -->

Decision: [ADR-0040](../../../../docs/design/adr/0040-native-evidence-artifacts-and-retention.md).
This extends existing immutable uploads/downloads without changing caller APIs.
Retained FR-STORAGE-001, FR-STORAGE-004, FR-STORAGE-006 and SUPPLEMENT-027 outcomes
are exercised by native evidence/attachment/retention tests in their owning plugins.

Acceptance: correct file hashes/bytes and unchanged older downloads; explicit
archive versus physical disposal; shared-content reference prevents early blob
removal; current plugin holds/references checked before disposal; interrupted intent
reconciles actual bytes; read-only summaries expose counts/bytes/known failures and
bounded integrity scans without writing; private content is absent from admin
aggregate responses. Text preview discloses exact truncation. Upload and download
failures retain operation evidence. Existing ingestion and mail Buffer-returning
read APIs remain compatible.

Run: `node src/system/retention/tests/native.mjs` (new lifecycle assertions),
`node src/domain/ingestion/tests/smoke.mjs` (existing real source ingestion).
No outcome is marked passed until its command is executed and evidence retained.
