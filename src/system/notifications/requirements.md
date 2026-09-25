# Account notifications
<!-- budget: 4096 bytes, hard -->

Owns the activity inbox, unread header indicator, read state and linked navigation in the [connected agent contract](../../../docs/product/connected-agent-contract.md). Sources: `code/index.mjs`, `client/notifications.jsx`, generic WebUI header slots.

`push` persists each notification before calling registered listeners. Source deduplication prevents repeat sync notifications. A listener registration returns a disposer. The account-scoped enabled setting controls the header indicator; the activity inbox preserves history. Optional transports subscribe through the service and own their configuration/delivery policy.

Events: `notifications/created`, `notifications/read`, `notifications/delivery-failed`. Text, links and read timestamps remain in the originating account ledger. HTTP views expose only the current account. All routes, header/page contributions and listeners unload with their plugin.

Acceptance: `node src/system/action-center/tests/state.mjs`; mail/Telegram protocol and GUI journeys demonstrate incoming-message notifications and review links. External delivery is implemented and documented by the Telegram plugin, not the WebUI core.
