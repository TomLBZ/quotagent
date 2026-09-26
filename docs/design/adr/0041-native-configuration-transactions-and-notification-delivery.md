# ADR-0041 — Native configuration transactions and notification delivery
<!-- budget: 8192 bytes, hard -->
Status: accepted

## Problem

The native settings GUI persists schema values but lacks file round-trip/initialization, a reviewable dry run, complete patch provenance and plugin veto/rollback. Notifications have unbounded list responses and discard additional source attribution when deduplicating. People can miss activity while away from the browser; a native email digest must preserve explicit permission, privacy and delivery uncertainty.

Sources: FR-CONFIG-001, FR-USREQ-009, FR-PLUGIN-004; audit G9 clauses SUPPLEMENT-015/016/017/035 and NFR-MNT-002 in `tmp/agent-experience/requirements-audit.json`; historical `src/system/mail/docs/notification-digest.md` and `src/system/webui/docs/notifications-and-dedupe.md`. The compatible outcomes remain; historical CLI-only writer/SSR/ledger-invisibility mechanics are replaced by the current native plugin contract.

## Decision

1. `settings.define` remains disposable and backward compatible. Native YAML bundles contain schema identifiers, explicit scope references and non-secret patches. A generated template initializes supported schemas; a GUI upload can preview and apply it. Passwords can be supplied through private import/write fields but are never returned in views, exports, diffs, provenance or ledger events. Exports omit credentials rather than substitute fake values. YAML parsing rejects unknown schemas/keys/scopes and unsupported shapes. No YAML tags execute code.
2. Dry-run preparation resolves all targets, current revisions, inherited values, schema validation and plugin veto hooks without persistence or activation. Applying checks the frozen revision/digest and revalidates. A transaction journal and credential file are private0600; replacement uses temporary-file rename. Non-secret configuration and transaction outcomes are append-only ledger facts. A failed apply restores previous values/credentials, invokes registered rollback hooks and records the failure/compensation. Startup reconciles unfinished transactions conservatively instead of silently claiming success. Side-effecting plugins must supply a reversible apply/rollback pair; preflight hooks do not perform commitments.
3. Each changed key retains source (schema default, supplied file or runtime GUI), layer, scope and patch/transaction reference. Effective views identify overrides and what they shadow. Existing shared `user` and private `account` behavior remains; connection credentials never inherit from workspace/project/section. Explicitly opted-in business schemas may use workspace→project→section overrides, authorized by disposable scope providers owned by domain plugins. Settings owns no procurement record policy.
4. `settings.registerScope({id,label,list,resolve})` returns a disposer. Resolution returns an authorized realm/key/label for an explicit context; schema consumers pass the same context when obtaining effective values. Scope UI uses these providers. Public schemas cannot invent access to an account or team by supplying IDs. File initialization is deliberate, idempotent by source digest and does not overwrite existing overrides in initialize-only mode. Optional startup initialization uses an operator-configured local file; GUI remains the full authoring path.
5. Notifications retain account-owned history. Server windows filter the complete merged set before sorting/paging and report produced reports, merged notices, visible/matched/unread counts, window boundaries and remaining rows. Search, type/severity/source filters and preferences never silently truncate counts. Reading a list does not mark anything read. Mark-matched-read is explicit and acts on the server-filtered set.
6. Deduplication keys are supplied by the owning plugins. A serialized per-account merge keeps all distinct plugin/source attributions and raises severity without duplicate listener delivery for a repeated identical report. Merged source count remains visible; a newly escalated notice becomes unread. New notices include source ownership metadata, and old unlabelled notices remain explicitly unlabelled rather than assigned a fabricated origin.
7. Mail owns an email-digest child and transport. Default is off. The account explicitly chooses a recipient, severity threshold, bounded number of items and minimum send interval. That saved opt-in is standing permission only for fixed safe activity summaries; no notification body, source quotation/cost, message content or arbitrary destination is forwarded. A preview shows the exact eligible set/counts and omissions. One-off sending is an explicit human GUI action; background delivery requires a separate explicit automatic opt-in. No model tool enables or sends digests.
8. Digest delivery records immutable selected notification IDs/severity and destination/connection binding before SMTP. Serial account execution, durable dedupe and throttling prevent repeat sends; restart or transport ambiguity becomes uncertain and is never automatically resent. Successful SMTP receipt is durable before optional UI notices. New activity/digest success must not form notification loops. Timers/listeners/transports dispose with native lifecycle. In-app history and delivery receipts remain traceable account facts, not procurement commitments.

## Consequences

People can review/import/export/init native configuration, see exactly which layer supplied a value, and recover from a veto or failed apply. Notification totals remain honest at larger volumes and communications have readable delivery receipts. Scope providers keep domain ownership separate from generic settings. Costs are additional journal/reconciliation logic and deliberate restrictions on digest contents; SMTP acceptance is not proof of final mailbox delivery. Rollback cannot undo arbitrary external effects, so hook contracts require reversible configuration changes and forbid outbound commitments.

## Alternatives rejected

| Alternative | Reason |
|---|---|
| CLI pending-file writer as the only configuration GUI path | Contradicts the native GUI application contract. |
| Export every effective value including credentials | Exposes private connection secrets and freezes inherited choices. |
| Persist first and call validation later | A veto would arrive after the invalid configuration became active. |
| Page a capped client snapshot | Conceals inaccessible rows and gives false complete totals. |
| Forward arbitrary notification text or silently enable digest | Leaks account facts and exceeds standing permission. |
| Automatically retry ambiguous SMTP sends | Can duplicate external messages. |

## Revisit conditions

Revisit cross-node configuration transactions, project providers beyond procurement, stronger provider delivery receipts, or digest content expansion only with new explicit authorization and source/realm requirements. Do not infer those capabilities from the local protocol fixture checks.
