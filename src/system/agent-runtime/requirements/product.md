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
