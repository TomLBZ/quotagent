# ADR-0037 Native durable QEP exchange and reconciliation
Status: accepted
<!-- budget: 8192 bytes, hard -->

## Problem

The native adapter has no product outbox, portable handoff, retry/receipt surface
or field-conflict review. It labels all transfers as facts, without binding human
approval to business revisions. Error replies can omit appended events; forms lack
atomic expected-revision writes.
Sources: `src/system/workspace-store/code/{bridge.py,index.mjs}`, historical
`docs/design/03-exchange-protocol.md`, `11-integration-map.md`, and ADR-0032/0036.

## Decision

Extend the native adapter and add an unloadable `system/exchange-workbench` plugin.
Do not change the Python Ledger, QEP envelope version, canonicalization, signing,
sequence or deduplication rules. The current kernel implements QEP 1.0 with
HMAC-SHA256 shared-secret authentication, not independent public-key signatures;
the product must say so. Explicitly paired independent installations may use a
per-account peer secret saved only by the settings credential store. Packages,
ledgers, model inputs and GUI summaries never contain that secret. A paired peer attests its local human approval.

### Adapter and policy contracts

`store.exchange(from,to,collection,record,options)` remains the domain entry. Its
new pipeline persists the exact signed envelope before transport, and derives a
stable delivery identity from its signed record version. Retries use the original
message ID, body hash and bytes. A successful delivery requires a verified receipt;
queued, held, failed, rejected and conflict states stay distinct. A failed or
ambiguous HTTP attempt remains pending until a signed receipt is verified.
The package and inbox are durable so process loss between send, receive, apply and
acknowledgment can recover without a duplicate business projection.

The domain registers a disposable `store.exchangePolicy(definition)`, with:

- `id`, `collections` identifying owned record families;
- `prepare({from,to,collection,record,options})` returning `type`, `eventClass`,
  `refs`, and human `approvals[{by,at,scope,sourceRef}]` derived from real ledger
  approval records. Scope includes public reviewed semantic fields and revision;
- `validate({from,to,collection,record,local,base,metadata,peer})` returning a
  structured decision. It verifies public scope, counterpart authority, revision
  and approval binding before any record becomes an effective projection;
- `authority({collection,path,record,from,to})` returning an owning realm or
  `sender`/`recipient`/`both`, and whether the field is a commitment.

The adapter adds the exact record digest to every approval scope and signs the
entire envelope. An approval cannot be supplied by a browser as an asserted human
identity. The domain declares commitment transitions, including signed orders and approved changes. No private cost,
internal scoring or unrelated bidder list is added to transport proof.

A new QEP body schema `quotagent/qep-workspace-transfer/v1` carries a public record,
its last shared base and metadata. A verified outbound receipt or an accepted
reverse transfer can establish that base. Valid raw received transfer facts remain
separate from the effective `quotagent/workspace-record/v1` projection. The adapter
appends one effective projection only after validation/reconciliation, keyed by
message ID. Duplicates can reproduce receipts but cannot create a second effective
version. Older received workspace-record/v1 events retain their prior meaning.

### Durability, transport and conflicts

Add private adapter records/events for deliveries, inbox stages, receipts, peer
negotiation, conflicts and decisions under `exchange/`; retain existing
`kernel/qep-*` facts unchanged. Restore sequence cursors, unresolved inbox stages
and pending delivery state from ledger. Preserve all delta events on error replies.
Out-of-order input stays held, shows missing sequence numbers, and can request or
manually transfer exact missing packages. No dependent state skips a gap.

Support the existing same-host delivery plus explicit manual package and HTTP
bindings. Manual packages are materialized through a temporary file and atomic
rename, named by message ID and digest. HTTP transports exact signed QEP packages
and signed acknowledgment packages. Transport-only fixtures relay/retain bytes;
they cannot create business approval or effective domain facts. The party workspace owner selects recipient and endpoint; accepted party members
see the routing metadata, while pairing credentials remain owned by the configuring
workspace owner. There is one enabled route per selected party and recipient. Exporting an already approved package or retrying
its identical bytes does not approve new content. New business commitments still
use the owning domain's human review.

Three-way comparison uses the last acknowledged base, current local record and
received record. Equal values agree; one-sided changes remain identifiable.
Registered field authority can resolve ordinary competing facts with an explicit
conflict record explaining base/mine/theirs and the winner. Unknown authority and
commitment-field conflicts remain pending. A proposed counterparty-owned change
is a suggestion, never an automatic rewrite. Resolving a bilateral commitment
uses the original sender approval for the exact incoming value plus an explicit
recipient decision naming its record/body hashes and the reviewed conflict fields. Neither transport acknowledgment nor a single
party's decision creates the other party's consent. The domain validates any
resulting transition again.

### Local editing, projections and diagnostics

Add `store.put(...,{expectedRevision})` with an atomic bridge-side check. A stale
write returns the current revision and actionable conflict detail without replacing
it. Existing callers remain compatible while domain forms adopt the expected
revision. Historical projection supports a sequence or timestamp cut; effective
records are derived from the same ledger replay rules as current state.

The bridge declares its supported protocol, QEP versions, operations and features
before initialization. An incompatible handshake makes no ledger change; generic
commit operations remain unavailable. Errors provide stable code and next action.
Malformed record metadata is counted and excluded from effective projection. An
unhealthy ledger or inaccessible storage is explicitly unavailable, never presented
as an empty healthy account; other healthy realms may remain usable. Diagnostics
show counts and repair guidance, not an automatic destructive repair operation.

## Consequences

Users can inspect unfinished transfers, portable facts, receipts, gaps and conflicts.
Delivery metadata increases storage, and pairing needs human setup. HMAC peers
share symmetric trust; public-key identity needs a separate kernel decision.
Conflict review pauses affected records while unrelated drafting remains available.
Domain policy and form revisions require integrated evidence.

## Alternatives rejected

| Alternative | Reason |
|---|---|
| Treat in-process delivery as portable interoperability | Cannot prove failure recovery or independent receipt |
| Create a fresh envelope for each retry | Changes sequence/identity and risks duplicate facts |
| Let a transport receipt mean business approval | Confuses delivery with commercial consent |
| Project every valid signed body immediately | Ignores business revision, approval and field conflicts |
| Replace QEP signing or ledger semantics in this task | Violates the kernel boundary and historical compatibility |
| Silently let the last arriving record win | Loses concurrent work and party ownership |
| Automatically repair corrupt historical files | Rewrites evidence and can conceal lost facts |

## Revisit conditions

Revisit identity when the kernel gains a separately approved public-key contract;
add new transport bindings through the same durable package/receipt interface.
Revisit reconciliation policies through domain-owned versioned declarations as new
public record families appear. Preserve prior raw envelopes, bases and decisions.
