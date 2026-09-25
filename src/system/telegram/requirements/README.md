# Telegram conversations
<!-- budget: 4096 bytes, hard -->

Native owner: `code/product.mjs` / `code/transport.mjs`; GUI `client/telegram.jsx` / `telegram.css`.
Requires store, settings, accounts, web, files, ingestion, actions and notifications. No Telegram SDK is
required: the transport calls the documented Bot API with `fetch`.

The Telegram page connects an account-owned bot, tests its identity, receives text/document messages,
shows chat threads, prepares editable replies, extracts attached documents into procurement source
items, and creates human approval requests. Its `action-preview:telegram.send` slot displays the frozen
recipient/chat ID and exact text. Bots are separate from personal Telegram accounts; users must start
a chat with their bot. This is not an import of an arbitrary user's Telegram history.

Configuration ID `telegram`, scope `account`: enabled, botToken, defaultChatId, autoSync, pollSeconds
and optional allowedChatIds, notifyActivity and notificationChatId. Tokens are masked and never inherited by another account. By default no
connection or background polling is active. One token should have one polling consumer; an existing
webhook prevents polling and produces the provider error. Bot creation and webhook removal remain
explicit provider-side operations. No webhook is silently removed.

`ctx.telegram.status/list/get/test/sync/draft/propose/ingest`; routes `GET /telegram`, `GET /telegram/:id`,
`POST /telegram/test`, `/telegram/sync`, `/telegram/draft`, `/telegram/:id/review` and `/telegram/:id/ingest`.
Tools `telegram_list/read/sync/draft/prepare_send/ingest` expose owned context and declare read, draft
or proposal effects. Received content is external source data. Bodies, sender/chat references, attached
file metadata, draft versions, cursor offsets and sent-message receipts enter the account ledger through
`telegram/*` events. Private files are stored by `ctx.files`, then parsed by `ctx.ingestion` on request.

The transport implements getMe, getUpdates, getFile/download and sendMessage. Cursor acknowledgment
advances only after each message is recorded. Update/message IDs deduplicate polling; edited messages
append new facts. Requests are aborted and timers removed on unload. Outgoing text is limited to 4,096
characters. Inbound documents use Telegram's cloud download limit (20 MB) and the account's file limit.
Attachment failures preserve the message and show an error. Photos, voice, stickers, document sending,
inline keyboards and user-account login are not implemented.

Drafting and proposing never send. `telegram.send` executes through shared human approval. Changed
drafts or bot connections invalidate old proposals. Failed/unknown delivery is recorded honestly and
never automatically retried. In-app notifications link received messages and send results to the chat. Explicitly enabling
notifyActivity grants standing permission for a fixed generic reminder to notificationChatId. Only
“New activity is waiting in Quotagent. Open your workspace to review it.” is sent; source notice text,
prices and costs are never forwarded. Reminders are deduplicated and recorded; failure is not retried.

Primary source: [Telegram Bot API](https://core.telegram.org/bots/api), specifically
[updates](https://core.telegram.org/bots/api#getupdates), [sending](https://core.telegram.org/bots/api#sendmessage)
and [file downloads](https://core.telegram.org/bots/api#getfile).

Evidence shares the loopback transport suite:
`node src/system/mail/tests/product-smoke.mjs`; browser flow
`BASE_URL=http://127.0.0.1:8620/quotagent/ node src/system/mail/tests/product-browser.mjs`.
`product-fixture-server.mjs` starts a fictitious Bot API that never contacts Telegram or forwards messages.
The native plugin's optional `apiBase` configuration points only test hosts at that fixture; ordinary
runtime defaults to `https://api.telegram.org`. Fixture success verifies API behavior, not live Telegram
service authorization/delivery. Real credentials are configured later through the GUI.
