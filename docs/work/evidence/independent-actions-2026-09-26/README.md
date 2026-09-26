# Independent review and durable batch evidence
<!-- budget: 4096 bytes, hard -->

Decision ADR-0035. Owner `system/action-center`; specification in its
`requirements.md`. Executed 2026-09-26, exit 0:

- `node src/system/action-center/tests/independent.mjs`: six groups PASS using actual Python-backed ledger and explicit party teams. Output: `ok: true`, 2 monetary fixture deliveries, 116 owner ledger events; temporary root `tmp/independent-actions-MQ45CO`.
- `node src/system/action-center/tests/state.mjs`: nine existing groups PASS, including personal account isolation, concurrent idempotence, notification outage, delegated-policy restrictions and uncertain restart recovery.
- Integrated Vite build: 66 modules PASS for this change; subsequent ongoing integration build 68 modules PASS.

The six independent-review groups cover:

1. Frozen proposal → different nominated reviewer → proposer signature; concurrent signatures execute once and same-side outsiders cannot read the team action.
2. Currency/amount limits, changed authority policy and removed reviewer block signing without delivery.
3. Reasoned delegation, reminders, higher-role escalation and expiry produce durable receipts. Expiry cannot grant or execute, even before the background timer runs.
4. Mixed batch preserves success, failure and blocked receipts. Retrying a failed action creates a fresh unsigned proposal and never repeats a successful item.
5. Recovery retains independent signatures and marks interrupted execution uncertain without replay.
6. Background batch persists its current item and every result, pauses after an in-flight effect, resumes only unattempted work and reconciles a completed effect after simulated interruption.

The local team GUI setup is independently verified in
[team evidence](../teams-2026-09-26/README.md). This service-level proof uses explicit
fixture executors; it does not claim procurement signing or public GUI validation.
The procurement integration journey supplies that evidence after domain binding is
complete. No emails, orders or other external commitments were sent by these tests.

Account-perspective follow-up, 2026-09-26: reran
`node src/system/action-center/tests/independent.mjs`, exit 0,
[seven groups PASS](perspective.json), 117 owner events and two fixture deliveries.
A newly proposed personal action records its originating contractor/supplier/admin
perspective. Switching the same account to another perspective hides it and blocks
execution; returning restores the pending action. Existing untagged receipts remain
readable without inventing historical role metadata. Origin links route conversation
tasks to the assistant and workflow runs to the workroom.
