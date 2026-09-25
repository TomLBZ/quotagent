# Operational assistant
<!-- budget: 4096 bytes, hard -->

Owns live AI, context understanding/extraction, business drafting, comparison,
negotiation suggestions, explicit preference memory, and tool orchestration in
[product contract](../../../../docs/product/runtime-contract.md).

`code/product-ai.mjs` reads configured provider settings, sends real requests and
appends complete input/output events. `code/product-assistant.mjs` persists chat
turns, includes only the current account snapshot, executes registered tools and
returns review actions. Business plugins own business tools; the assistant does
not implement or bypass commitments. External commitments require UI confirmation.

Source: configured provider verified in `tmp/product-evidence/provider-live.json`;
public product acceptance is documented separately after execution.

`code/product-policy.mjs` owns effect metadata, delegated-tool filtering, argument
validation and data provenance. Shared `assistant.definitions/invoke` supports both
chat and workflow workers; delegated agents receive only read/draft/proposal tools.
Unknown writes and model-supplied human confirmations are refused. Source context is
separated from trusted system instructions. External tool results are labelled data,
with source identities and suspicious-instruction warnings. This is layered resistance,
not a claim of complete model immunity. See [ADR-0030](../../../../docs/design/adr/0030-connected-agent-workflows.md).

Memory suggestions create `memory.save` review actions through the workflow memory
service. Approved active memories enter later model inputs; model suggestions cannot
silently become active. Full tool results carry run/step/agent identifiers. Provider
calls support cancellation and record model input/output; workers retain distinct
contexts. Events: `agent-policy/tool-refused`, `agent-policy/external-content`,
`agent/tool-completed`, plus existing `agent/llm-request`, `agent/llm-response` and chat
records. Acceptance: action-center state checks, workroom actual-model GUI journeys,
and external-source injection probes in the connected-agent evidence report.

A native write tool may register a trusted `propose` callback. After external content,
chat invokes that callback instead of executing the write. Plugin studio uses this to
review source-assisted plugin/skill creation; direct user creation retains its existing
behavior. Delegated workers still exclude write tools. Remote descriptors cannot
register these callbacks. Acceptance is included in action-center state checks.
