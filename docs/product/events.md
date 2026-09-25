# Product plugin events
<!-- budget: 8192 bytes, hard -->

All events below append through existing `quotagent.kernel.ledger.Ledger`. The
additive product event catalogue follows ADR-0027/0028/0030 and preserves existing event
semantics. Sources: [adapter](../../src/system/workspace-store/code/bridge.py),
[projection reader](../../src/system/workspace-store/code/index.mjs),
[assistant/provider](../../src/system/agent-runtime/code/product-assistant.mjs),
[procurement](../../src/domain/procurement/code/service.mjs), and
[studio](../../src/system/plugin-studio/code/product.mjs).

| Event | Body | Owner |
|---|---|---|
| workspace/record-saved | schema, collection, record (complete new version) | workspace-store |
| workspace/record-exchanged | same; QEP receiver creates projection from validated body | workspace-store |
| agent/model-requested | callId, purpose, provider, request (complete messages/tools/parameters), endpoint | agent-runtime |
| agent/model-completed | callId, response (complete provider response) | agent-runtime |
| agent/model-failed | callId, error | agent-runtime |
| agent/tool-completed | callId, tool, arguments, result | agent-runtime |
| account/preferences-updated | preferences (current private account preferences) | accounts |
| procurement/human-approved | action, recordId, confirmed, humanId, scope (reviewed record), approvedAt | procurement |
| studio/skill-ran | pluginId, name; conversation and model events retain the complete execution | plugin-studio |
| studio/tool-ran | pluginId, name, input, result; generated source lives in the plugin record | plugin-studio |

Record events have body `{schema:'quotagent/workspace-record/v1',collection,record}`.
Local record event families are:

| Local event names | Collection | Owner |
|---|---|---|
| procurement/rfq-drafted, rfq-published, rfq-awarded | rfqs | procurement |
| procurement/quote-drafted, quote-submitted, quote-superseded, quote-awarded | quotes | procurement |
| procurement/order-issued, order-acknowledged, order-revised | orders | procurement |
| procurement/message-sent | messages | procurement |
| procurement/change-proposed, change-approved | changes | procurement |
| procurement/demo-rfq-created, demo-quote-created, demo-loaded | rfqs, quotes, demo-seeds respectively | procurement |
| studio/plugin-created, plugin-installed, plugin-promoted, plugin-loaded, plugin-unloaded, plugin-published, plugin-deleted | studio-plugins in system realm | plugin-studio |
| workspace/record-saved | chat, agent-turns and other records without an explicit local event name | workspace-store |

Names after the first comma retain the row's `procurement/` or `studio/` prefix.
The `exchange` adapter uses QEP type `workspace/record-exchanged` for recipient
records. Caller labels such as `procurement/quote-received` do not create additional
recipient event types. Projection readers only accept the record schema above;
unrelated historical event formats are not reinterpreted.

QEP kernel `kernel/qep-sent` and `kernel/qep-received` retain their existing shapes.
Each account pair has its own ordered QEP participant stream, backed by the same
account ledger; inbound cursor recovery reads durable receipts. Private fields
are excluded by the public-record serializers in the procurement plugin. Account
credentials and sessions are local account-store data, not ledger events. Model
requests/responses, preferences and generated-utility execution results remain in
the calling account's realm.

## Connected services and agent work

The connected composition adds account-local event families; exact names and bodies are
owned by the plugin implementation/requirements rather than new kernel semantics.

| Family | Durable facts | Owner/source |
|---|---|---|
| actions/* | Frozen proposal, decision, execution receipt, failure or uncertain outcome | [action-center](../../src/system/action-center/requirements.md) |
| notifications/* | Content/link/source, deduplication key, read timestamp, delivery failure | [notifications](../../src/system/notifications/requirements.md) |
| mail/* | Received MIME/file references, draft versions, sync state and SMTP receipts | [mail](../../src/system/mail/requirements/product.md) |
| telegram/* | Updates/cursor, messages/files, drafts and send/reminder outcomes | [Telegram](../../src/system/telegram/requirements/README.md) |
| connections/* | Connection discovery, MCP operations, A2A task/context/artifacts and reviews | [connections](../../src/system/agent-connections/requirements/functional.md) |
| workflows/* | Run/step/agent context, plan, questions, human answers, results, recovery and traces | [workroom](../../src/system/agent-workflows/requirements/README.md) |
| agent-memory/* | Active/archive state, revisions and human/agent/legacy provenance | [memory](../../src/system/agent-workflows/code/memory.mjs) |
| agent-policy/* | Tool refusals and external-source provenance/warnings | [policy](../../src/system/agent-runtime/code/product-policy.mjs) |

Full model calls retain `agent/model-requested`, `model-completed`, `model-failed`.
Shared tool completion adds optional runId/stepId/agentId to existing tool facts.
Credentials stay outside ledger facts; they are not model inputs.
