# Native file retention and observations
<!-- budget: 8192 bytes, hard -->

Owner: `system/retention` with `system/file-store` artifact lifecycle operations.
Decision: [ADR-0040](../../../../docs/design/adr/0040-native-evidence-artifacts-and-retention.md).

| Retained clause | Executable native acceptance |
|---|---|
| FR-EVIDENCE-004, NFR-COMP-003 | Configure account and own-project retention age/types (strictest shared-file constraints), preview exact eligible copies, apply/release named holds, human-review frozen disposal, recheck current hold/content state; real blob bytes removed only after last retained reference, ledger preserved and result recorded |
| FR-STORAGE-006, SUPPLEMENT-027 | Read-only file count/bytes/capacity/failures/missing/corrupt observations, bounded owner details and body-free admin totals; observation adds zero events |

Executable checks: `node src/system/retention/tests/native.mjs` and
`BASE_URL=http://127.0.0.1:8648/quotagent/ node src/system/retention/tests/browser.mjs`.
Real bytes and shared-content references must prove keep/hold/dispose, tamper or
stale-review refusal, partial-failure recovery, record tombstones, immutable ledger
prefix and complete plugin disposal. Browser uses visible policy, preview, hold,
review and download controls. No new broad gate and no automatic destructive timer.

Native service `ctx.retention` consumes files/attachments/evidence metadata through
public APIs, registers an action-center executor and preview, and writes additive
retention intent/result events. Owner settings remain private. This does not claim
to erase prior ledger facts, already exported packages or counterparty copies.
