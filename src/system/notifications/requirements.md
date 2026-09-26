# Account notifications
<!-- budget: 4096 bytes, hard -->

Owns the activity inbox, unread header indicator, read state and linked navigation in the [connected agent contract](../../../docs/product/getting-started.md). Sources: `code/index.mjs`, `client/notifications.jsx`, generic WebUI header slots.

`push` persists each notification before calling registered listeners. Source deduplication prevents repeat sync notifications. A listener registration returns a disposer. The account-scoped enabled setting controls the header indicator; the activity inbox preserves history. Optional transports subscribe through the service and own their configuration/delivery policy.

Events: `notifications/created`, `notifications/merged`, `notifications/read`, `notifications/delivery-failed`. Text, links and read timestamps remain in the originating account ledger. HTTP views expose only the current account. All routes, header/page contributions and listeners unload with their plugin.

Acceptance: `node src/system/action-center/tests/state.mjs`; mail/Telegram protocol and GUI journeys demonstrate incoming-message notifications and review links. External delivery is implemented and documented by the Telegram plugin, not the WebUI core.

## Complete windows and merged attribution (G9)

ADR-0041 retains audit SUPPLEMENT-002/015/016/017. Server-side filter/sort/page must expose complete produced/merged/matched/unread/window/remaining counts. A last-page GUI control reaches every matching record. List reads are pure; mark-filtered-read is an explicit write. Duplicate reports retain distinct plugin/source attribution, severity escalation and source count; repeating the same source report does not notify twice. Preferences are account-owned. Native subscriptions, routes and timers dispose.

Email digest is owned by mail and defaults off: bounded safe summaries, explicit recipient/permission, durable dedupe/throttle, observable SMTP receipt and uncertain-no-auto-retry. It never includes notification body, quote/cost or message content. Evidence: `node src/system/notifications/tests/windows.mjs` (5 native groups,253 notices); `node src/system/mail/tests/digest.mjs` (5 real protocol groups); `node src/system/settings/tests/browser.mjs` (GUI). See [G9 evidence](../../../docs/work/evidence/g9-configuration-and-notifications.md).

`notifications.list(user)` returns full owned history for native consumers; `window(user,query)` powers GET `/notifications` with page/limit/search/type/level/source/unread filters and complete counts. Explicit `readMatched` acts across matching pages. `push` accepts `source:{pluginId,panelId,sourceId,label}` and optional source `reportId`; attribution inferred from legacy view links is labelled as such. Account schema `notifications` persists enabled/minSeverity/mutedSources; muted notices remain in full history and suppress alert/digest eligibility, including after reload.
