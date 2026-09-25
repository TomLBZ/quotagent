# Product plugin events
<!-- budget: 8192 bytes, hard -->

All events below append through existing `quotagent.kernel.ledger.Ledger`; this is
an additive plugin event catalogue under ADR-0027, not a change to existing events.
The source adapter is `src/system/workspace-store/code/bridge.py`.

| Event | Body | Owner |
|---|---|---|
| workspace/record-saved | schema, collection, record (complete new version) | workspace-store |
| workspace/record-exchanged | same; QEP receiver creates projection from validated body | workspace-store |
| agent/model-requested | callId, purpose, provider, request (complete messages/tools/parameters), endpoint | agent-runtime |
| agent/model-completed | callId, response (complete provider response) | agent-runtime |
| agent/model-failed | callId, error | agent-runtime |
| agent/tool-completed | callId, tool, arguments, result | agent-runtime |

Other plugin-specific record events use the same versioned record body and are
listed in their plugin code. Projection readers only accept schema
`quotagent/workspace-record/v1`; unrelated historical event formats are not reinterpreted.
QEP kernel `kernel/qep-sent` and `kernel/qep-received` retain their existing shapes.
Each account pair has its own ordered QEP participant stream, backed by the same
account ledger; inbound cursor recovery reads durable receipts. Private fields
never enter the public record selected by the procurement plugin.
