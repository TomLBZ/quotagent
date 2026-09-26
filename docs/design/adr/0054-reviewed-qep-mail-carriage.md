# ADR-0054 Reviewed QEP mail carriage
Status: accepted
<!-- budget: 6144 bytes, hard -->

## Problem

DOMAIN-012 retains mail-carried QEP recovery. The original integration map at
commit `c00379af`, `docs/design/11-integration-map.md` section4 specifies message
attachments, a readable summary, encoding, size limits and delivery failures.
Manual forwarding in section3 is a fallback, not a replacement for that native
integration. Existing mail attachment ingestion extracts documents; it does not
verify or receive signed exchange packages.

## Decision

Add independently mounted native `system/exchange-mail`, depending on the existing
exchange, account mail and file services. Its contributions are reversible and
appear in the native plugin inventory. Generic extension slots in the two owning
GUI pages expose its controls only while the backend registration exists.

An account member with the selected workspace's existing exchange access may
prepare a private email draft containing the exact original signed QEP package
and a readable public summary. The attachment is stored by the file plugin in the
sending account. Every email uses the existing immutable `mail.send` human review;
drafting, package export and agent tools never send. Editing recipient or summary
does not alter the signed business message. A bounded array may carry original
receipt/control/replay packages; each envelope keeps its signature and identity.

The mailbox offers explicit preview/import for saved QEP JSON attachments. The
service verifies ownership, size, JSON shape, recipient pairing and signature;
preview distinguishes transport verification from later domain validation.
Import goes through existing exchange receive/reconciliation and records original
mail/file references plus QEP IDs/hashes. Conflicting business terms still require
the owning domain's separate review. Preparing a receipt or requested-message
reply creates another private draft for explicit human approval.

SMTP acceptance is mail-server acceptance only. It never marks a QEP message
delivered. The sender reaches QEP delivered only after importing the peer's
original signed receipt. Failed or ambiguous mail sends retain existing draft/
uncertain semantics and never automatically resend. Account settings bound package
size; MIME/base64 transport preserves attachment bytes. Larger packages retain the
portable-file/HTTP alternatives without partial truncation.

Mail records structured delivery-status reports from MIME report parts, including
the returned original Message-ID, recipient/action/status and exact source file.
Only an exact matching outgoing Message-ID links a report to a QEP mail attempt.
This remains an external reported outcome, not authenticated QEP proof or a reason
to change the original business receipt. No subject-line/body guess matches a
bounce and no report initiates an automatic retry. Source format:
[RFC3464](https://www.rfc-editor.org/info/rfc3464/); retained scope is ordinary
message/delivery-status MIME reports with returned original headers.

Additive `exchange-mail/*` events retain draft attachment identities, preview,
import and reply provenance. Structured report fields are part of the existing
mail/message-received event. Model-visible summaries remain ledger-visible.
No kernel signing, sequence, ledger or approval semantics change.

## Consequences

Users can exchange original signed commercial records through familiar email
while seeing separate mail transport and QEP acceptance states. Setup requires a
paired realm/channel and the user's own IMAP/SMTP connection. Unsupported or
unmatched delivery reports remain visible source mail; they are not guessed.
Disabling this plugin removes its routes/services/buttons while ordinary mail,
portable files and retained ledger history remain available.

## Alternatives rejected

- Treat parsed attachment rows as signed QEP import: loses protocol authority.
- Equate SMTP acceptance with QEP acceptance: cannot prove peer validation.
- Automatically send recovery replies: bypasses explicit email review.
- Match bounces by subject or inferred recipient: can attribute unrelated mail.
- Put business parsing in generic WebUI: violates plugin ownership.

## Revisit conditions

Add other structured report formats only with exact-source matching evidence.
OAuth refresh and third-party production delivery remain the account mail
plugin's separate concerns. End-to-end checks first use local protocol fixtures.
