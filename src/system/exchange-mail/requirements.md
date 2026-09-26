# Reviewed QEP email delivery
<!-- budget: 8192 bytes, hard -->

Owner: native `system/exchange-mail`; DOMAIN-012 and the mail transport portion of
FR-INTEG-003. Decision [ADR-0054](../../../docs/design/adr/0054-reviewed-qep-mail-carriage.md).
The existing workspace-store/exchange and mail owners retain their protocol,
approval, account credential and transport contracts.

## Required behavior

1. From a delivery, prepare an editable private email containing the exact signed
   package and public summary. No SMTP call occurs before existing human review.
   Recipient/summary edits never rewrite an embedded commercial envelope.
2. A received QEP JSON attachment has a visible preview/import action. Only its
   account-owned mail attachment may be read; pairing/signature/recipient and
   bounded shape are checked. Preview states that domain validation follows.
3. Import uses existing native reconciliation, dedup, sequence and approval rules.
   Store exact source mail/file and package IDs/hashes. Original signed receipts,
   missing-message requests and exact requested replays can become reviewed reply
   drafts; no automatic external send or new business approval is inferred.
4. UTF-8 JSON and MIME attachments preserve bytes. Account schema `qep-mail`
   bounds package megabytes; oversized files fail explicitly, never truncate.
5. Show separate mail draft/review/accepted/uncertain/reported-failure and signed
   QEP delivery state. SMTP acceptance alone cannot mark QEP delivered. Structured
   DSN reports match only exact original Message-ID and retain external provenance.
6. The native plugin is independently visible/disposable. Disabling it removes
   registrations, routes and GUI actions; ordinary mail and retained records work.

## Executable acceptance

`node src/system/exchange-mail/tests/native.mjs` must use real independent native
stores plus actual loopback SMTP/IMAP: approved send→MIME bytes→sync→preview/import→
reviewed signed receipt reply→verified original delivery; no-send proposal,
duplicate/size/ownership refusal, matched/unmatched structured bounce and disposal.

`node src/system/exchange-mail/tests/browser.mjs` must use visible GUI controls
for pairing/mail configuration, delivery draft, review/approve, inbox sync/import,
reply receipt and reload/narrow view. Fixture mailboxes never forward and are
explicitly labelled. Local checks do not establish public production acceptance.

Local implementation acceptance: native seven groups and GUI four groups passed;
[commands, reports and screenshots](../../../docs/work/evidence/qep-mail-2026-09-26/README.md). Final public release/verification remains pending in the root task. This plugin adds no navigation destination; its controls sit beside the
relevant delivery or mailbox attachment through generic owner extension slots.
