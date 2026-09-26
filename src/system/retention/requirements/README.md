# Native retention
<!-- budget: 4096 bytes, hard -->

Current owner: `code/product.mjs`, `client/retention.jsx`; provides `ctx.retention`,
File & retention GUI, project/account settings and an action-center executor.
[Native acceptance](native.md) maps FR-EVIDENCE-004, NFR-COMP-003, FR-STORAGE-006 and
SUPPLEMENT-027. Historical AC-AUDIT-003/005 describe the retained outcomes.

An owner can configure age/type constraints, inspect exact candidates, apply and
release named holds, then review a frozen disposal list. Additional project patches
apply only to files referenced by this party's own projects. Shared file copies
follow the strictest applicable account/project policy; absent project ownership
or scope services never imports another party's policy or grants disposal.

Execution rechecks holds, content and current object references. The file-store
serializes mutations and removes physical bytes only after the last retained
reference. Actual complete/partial/interrupted outcomes persist; restart observes
byte presence rather than repeating a deletion. The ledger and counterparty copies
are not deletion targets. No automatic destructive timer exists.

Run `node src/system/retention/tests/native.mjs` and
`BASE_URL=http://127.0.0.1:8648/quotagent/ node src/system/retention/tests/browser.mjs`.
[Native and GUI evidence](../../../../docs/work/evidence/native-artifacts-2026-09-26/README.md)
records actual bytes, hold-after-proposal refusal, project constraints and recovery.
Legacy `retention-view.mjs` and Python planning/operator scripts remain historical
references; they are not the mounted product entry or current GUI acceptance.
