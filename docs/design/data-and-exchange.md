# Data, exchange and reconstruction
<!-- budget: 8192 bytes, hard -->

`system/workspace-store` is the native adapter to the existing Python append-only
Ledger/QEP kernels. Account ledgers retain hash chains and source sequence/hash
references; projections rebuild from those events. Model-visible inputs and tool
results are recorded. New events add capabilities without silently rewriting old
version semantics. Sources: [store](../../src/system/workspace-store/code/index.mjs),
[bridge](../../src/system/workspace-store/code/bridge.py),
[kernel ledger](../../src/system/kernel/code/ledger.py).

The native host resolves account/team identity before calling its private NDJSON
adapter. Current declared ledger/QEP formats retain explicit compatibility checks;
unsupported historical business schemas do not acquire an implicit migration
guarantee. Original archives remain unchanged.
[Current trust/version boundary](adr/0055-native-host-and-version-support-boundaries.md).

QEP is the sole inter-party exchange boundary. Domain plugins authorize and shape
public records, classify facts/intents/commitments and bind applicable approvals.
Supplier costs, contractor private estimates and internal evaluation policies do
not enter public quotations. A durable outbox keeps exact message identity;
acknowledged, queued, failed, held and conflicting deliveries remain distinct.
Manual packages and loopback/HTTP delivery use the same signed envelope contract.
QEP retains its configured HMAC trust model. Sources:
[exchange contract](../../src/system/exchange-workbench/requirements/README.md),
[ADR-0037](adr/0037-native-durable-qep-exchange.md).

Optimistic writes pin reviewed revisions. A stale input refuses instead of silently
replacing newer work. Unknown/conflicting authority requires a human decision;
retrying an ambiguous external operation cannot invent delivery success. Domain
commitments consume the appropriate exact human review; transport receipt is not
contractual acknowledgement.

Files are separate immutable content bytes with ledger metadata. Object attachment
versions retain predecessor identity, filename, size and digest. Explicit delivery
shares a signed manifest; required bytes are verified before an effective incoming
attachment record. A held package can resume when its predecessors/resources arrive.
Removal records a tombstone; historical versions remain evidence while retained
bytes are available. [Attachment contract](../../src/system/attachments/requirements/native.md).

Evidence exports wrap the unchanged Python slice/proofs in an Ed25519 signed bundle.
An independent verifier checks chain, Merkle/proofs, byte digest and a separately
trusted exporter key. It does not certify business truth or unexported history.
Exact model reconstruction uses recorded key-sorted JSON bytes/hash at the
application's pre-fetch boundary; it is not a network witness. Older unmeasured
requests remain labelled. [Evidence contract](../../src/system/evidence/requirements/native.md),
[dispatch decision](adr/0043-measured-model-dispatch-boundary.md).

Retention operates on reviewed local file bytes, never ledger rows. Account/project
constraints, active references and holds can prevent disposal. Shared blobs remain
while another retained reference needs them. Interrupted disposal records unknown
remaining work and requires fresh review; exported and counterparty copies are not
erased. [Retention contract](../../src/system/retention/requirements/native.md).

Operational snapshots are derived body-free metadata, not new model-visible facts.
Account event timelines show readable authorized metadata. Configuration credentials
are separately stored and masked; captured effective model facts still require their
own ledger inputs. [Operations](../../src/system/observability/requirements/native.md),
[settings](../../src/system/settings/requirements.md).
