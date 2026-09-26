# ADR-0043 Measure the actual model request boundary
Status: accepted
<!-- budget: 4096 bytes, hard -->

## Problem

`agent/model-requested` preserves the complete structured request, but a verifier
cannot establish that the provider boundary used those same bytes. Ledger JSON
object ordering is not a wire encoding contract. Source:
`src/system/agent-runtime/code/product-ai.mjs`; FR-EVIDENCE-003 and NFR-COMP-002.

## Decision

For new native provider calls, recursively sort object keys while retaining array
order, then serialize with JavaScript JSON.stringify and UTF-8 encoding. Identify
this adapter convention as `json-key-sorted/v1`. Preserve the structured request
and this serialization marker in the existing model-requested fact. Do not change
historical event or kernel canonicalization meanings.

Compute the string once and pass exactly that string to fetch. Before every actual
attempt, append `agent/model-dispatched` with callId, runId, one-based attempt,
serialization, SHA256 and UTF-8 byte count. The event contains no HTTP credentials.
It measures a local dispatch boundary; it does not establish remote receipt or
model execution. A failed/aborted network attempt retains its existing uncertainty.

Evidence consumers reconstruct that wire string from the corresponding complete
request and compare both count and digest. Historical calls without a boundary
event are explicitly unmeasured. Durable provider replay does not create a second
dispatch or pretend that the historical response is a new model invocation.

## Consequences

Reconstruction can now be compared with an actual adapter-boundary observation.
Each attempt adds a small ledger event, and proof remains limited to this adapter;
provider-side processing is outside its scope. Request JSON key ordering becomes
deterministic without changing message/array order or content.

## Alternatives rejected

| Alternative | Reason |
|---|---|
| Hash the reconstructed object only | Does not observe the actual fetch input |
| Record credentials with the request | Not needed to reconstruct model-visible input |
| Call every historical request measured | No such boundary evidence existed |

## Revisit conditions

A different wire encoding or provider protocol needs its own named serialization
contract and a verifier, retaining these existing receipts unchanged.
