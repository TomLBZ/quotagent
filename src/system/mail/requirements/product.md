# Native account email
<!-- budget: 4096 bytes, hard -->

Owner: `code/product.mjs`, `code/product-transport.mjs`, `client/mail.jsx` and `client/mail.css`.
Native manifest entry; requires store, settings, accounts, web, files, ingestion, actions and notifications.

Email configures account IMAP/SMTP, tests without sending, syncs inbox/optional sent folder, searches, composes and replies with attachments, then opens human review. Its frozen preview uses `action-preview:mail.send`; exact recipients, subject, body and files are visible before approval.

`ctx.mail.status/list/get/test/sync/draft/propose/ingest` are provided by the plugin. Routes are
`GET /mail`, `GET /mail/:id`, `POST /mail/test`, `/mail/sync`, `/mail/draft`, `/mail/:id/review`,
`/mail/:id/ingest` and `/mail/:id/read`. Read state is local; IMAP uses read-only mailbox selection.
Inbox IDs combine connection identity, folder, UIDVALIDITY and UID. Initial sync reads the latest
configured window (default 50, maximum 500); subsequent sync advances through new-message backlogs.
It does not mirror remote deletion or provide mailbox management/full archive backfill.

Configuration ID `mail`, scope `account`: IMAP/SMTP host, port, encryption, username, app password or
OAuth access token; sender name/address; inbox/sent folder; optional automatic check interval and message
limit. There is no credential inheritance between accounts. Password/token values are masked; token
refresh and provider OAuth authorization are not implemented. Providers must allow IMAP/SMTP. Sent folders are configurable.

Transport uses pinned ImapFlow and Nodemailer. IMAP source MIME is parsed with mailparser; originals
and attachments are saved with `ctx.files` and can enter the existing ingestion page. Attachment/file
limits produce visible warnings without losing a usable body. IMAP messages over 20 MB are skipped
with a warning; original/file storage also respects the account's upload limit. Rich HTML is presented
as extracted plain text. SMTP acceptance is displayed as acceptance, not proof of recipient delivery/read.
Transport APIs: [ImapFlow](https://imapflow.com/docs/api/imapflow-client/),
[Nodemailer SMTP](https://nodemailer.com/smtp), [attachments](https://nodemailer.com/message/attachments).

Model tools: `mail_list`, `mail_read`, `mail_sync`, `mail_draft`, `mail_prepare_send`, `mail_ingest`.
Each declares its effect; received source is external content. Drafts/proposals send nothing. `mail.send`
executes only through `ctx.actions` human approval; draft-version/connection checks prevent stale sends.
Unconfirmed delivery is recorded as uncertain and is never retried automatically. Outbound receipts,
source bodies, attachment IDs, drafts and review links are account-ledger records (`mail/*` events).
In-app notifications link new mail and send results to the mailbox. Email digests are optional ([contract](digest.md)). Pollers, sockets, routes, settings, tools and action handlers are disposable effects.

Structured MIME delivery-status reports retain external source, exact returned Message-ID and recipient/action/status; unknown formats stay ordinary source mail. `mail.extension({id})` returns a disposer and exposes generic attachment/message UI slots. Signed package handling belongs to [QEP email delivery](../../exchange-mail/requirements.md).

Evidence:
- `node src/system/mail/tests/product-smoke.mjs`: actual loopback IMAP/SMTP and Telegram; native settings/store/actions/notifications, dedup, files/ingestion, no-send proposal, approval, stale/ownership refusal and disposal.
- `node src/system/mail/tests/product-fixture-server.mjs`: fictitious loopback services, never forwards; details in `tmp/product-evidence/external-connections`.
- `BASE_URL=http://127.0.0.1:8620/quotagent/ node src/system/mail/tests/product-browser.mjs`: GUI setup, receive/extract/reply/review/approve and notifications. Host Telegram uses the printed fixture `apiBase`. Reports explicitly record fixture scope.
- [QEP/DSN protocol and GUI evidence](../../../../docs/work/evidence/qep-mail-2026-09-26/README.md).
