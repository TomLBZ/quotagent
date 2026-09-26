# ADR-0040 Native evidence, attachment artifacts and audited retention
Status: accepted
<!-- budget: 8192 bytes, hard -->

## Problem

The native product records model requests and immutable uploads but has no user
workflow for independently verifying audit exports, reconstructing model inputs,
linking versioned files to business objects, or reviewing file disposal. Historical libraries use obsolete operator tooling.
Sources: `src/system/kernel/code/evidence.py`, `src/system/file-store/code/index.mjs`,
`src/system/retention/code/retention.py`, and the native provider's
`agent/model-requested` events. Retained requirements are mapped in each owning
plugin's requirements; old zero-ledger attachment indexes and shared-folder GUI
routes are not the current product contract.

## Decision

Add native evidence, attachments and retention plugins; extend the native file
store with bounded previews, storage observations and explicit artifact lifecycle
metadata. Keep the Ledger and QEP kernels unchanged. All registered effects dispose with their owning Cordis plugin.

### Signed evidence and independent verification

Use the existing Python evidence export/verification and Merkle helpers for an
exact contiguous ledger slice. The native plugin wraps the original UTF-8 payload
in `quotagent/audit-bundle/v1`, encoding the bytes as base64 to preserve Python
canonical JSON number representation. The wrapper includes selected inclusion
proofs, export scope, range and an exporter public-key fingerprint. It signs the
whole unsigned wrapper with Ed25519 using a per-party key stored outside the
ledger. This wrapper is a new evidence format, not a change to HMAC QEP1.0 or the
historical evidence-pack format.

Verification takes only the uploaded bundle and an independently supplied trusted
public key; no original ledger or exporter server is consulted. Recompute the
payload digest, manifest, entry/body hash chain, Merkle root and every supplied
inclusion proof, and verify the outer signature. An embedded public key permits
checking mathematical consistency but cannot establish exporter identity. Missing
trusted key, malformed package, wrong key or missing proof reports a failed or
untrusted result, never a successful identity check. Export and verification
results are recorded with digest, scope and check outcomes. Private account/party
exports are explicit downloads, not automatically sent to counterparties.

The GUI explains that a contiguous slice can contain private and unrelated events
between its boundaries. Choosing an object helps identify the relevant range; it
does not falsely claim that the range contains only that object's facts. Merkle
proofs establish inclusion in the signed slice, not that its contents are true or
that omitted history does not exist.

### Model-input reconstruction

Reconstruct the complete model request from its recorded `agent/model-requested`
event and report request digest, source event reference, available context coverage
and any verifiable source hash relationship. Validate the containing ledger before
claiming reconstruction. Missing request facts, duplicate/conflicting identifiers,
malformed messages or mismatching recorded source coverage produce an explicit
failed check and an account notification. Record each check and its result. A
recorded request alone proves what the application recorded, not independent
network observation; the UI states that limit. Exported request JSON remains in
the account that owns the model call, even when the request used an authorized
shared party scope.

### Object attachment versions and QEP artifacts

Attachments belong to a selected authorized party and a readable RFQ, quotation,
order or change. Internal files never appear in a counterparty projection. The
user explicitly chooses a delivered copy and its eligible recipient, with exact
file identity and digest visible before sending. A filename/object chain has
immutable versions, supersedes references and removal tombstones; old versions
remain downloadable until a separately reviewed disposal. Equal bytes/name/target
are idempotent. The current party's visible metadata identifies uploader, version,
visibility, source and disposition.

Deliver only through QEP: the signed public record binds every artifact's SHA-256,
byte length, filename and media type. The portable/HTTP package wrapper may carry
those bytes as resources, outside the signed envelope and outside ledger records.
Optional domain policy hooks `packageResources` and `receiveResources` supply and
stage the bytes. Inspect the original signature and domain policy before staging;
check digest/size before writing a private blob. Store only the original envelope,
manifest and resource provenance in the ledger. Missing, altered or disposed bytes
cannot be silently regenerated or replaced during export/retry.

A held/conflicting package can retain a verified staged blob, labelled as staged;
it becomes an effective object attachment only when its public record is accepted.
Metadata and raw QEP facts stay append-only. Tombstones can mark a received
attachment removed, but cannot revoke an already downloaded counterparty copy.

Image/PDF/text previews are same-origin and bounded. Plain text is rendered as
text with explicit truncation; unsupported media have a clear download option.
PDF uses a bounded browser renderer, with original download when unavailable.

### Retention, holds and file observations

Retention policies are private party/account settings with explicit age thresholds
and source types. Preview is read-only and names exactly which uploaded/derived
artifacts are eligible, held, referenced or unknown. Unknown age/type is kept;
ledger rows and credential files are never disposal targets. Legal/operational
holds have a reason and named author; releasing one is a recorded user action.

Disposal requires a human review of a frozen candidate list and rechecks current
holds/references/digests before execution. Tombstone the specific artifact records,
remove an underlying blob only when no retained reference to the same content
remains, and append the actual outcome (including partial failure). Do not rewrite
or remove ledger rows. A source copied into an immutable historical ledger cannot
be erased by file disposal; disclose that limit. Recovery reconciles interrupted
file operations against retained intent/result records rather than guessing
success. No policy schedules automatic destructive deletion.

Storage observations expose counts, bytes, configured capacity, missing/corrupt
artifact counts and recorded failure totals without private content. Owner views
may list their filenames; admin aggregate views contain only counts and health.
Read-only observations do not append events or alter storage.

## Consequences

Users can carry and independently check signed evidence, trace model inputs,
exchange actual versioned deliverables and explicitly manage retained file bytes.
Public-key continuity is a new operational responsibility; key loss cannot be
hidden by silently declaring a different exporter trusted. Ledger storage grows
with immutable metadata, while blob disposal cannot erase historical facts or
counterparty copies. Staged artifact recovery adds lifecycle work around QEP.

## Alternatives rejected

| Alternative | Reason |
|---|---|
| Mark the presence of a signature as verified | Does not establish integrity or identity |
| Export a shared HMAC verification secret | Gives the verifier signing authority |
| Put every binary attachment into append-only events | Prevents meaningful blob disposal and bloats model-visible history |
| Serve another account's raw file path | Bypasses explicit QEP delivery and independent receipt |
| Let retention delete matching ledger rows | Rewrites the historical trust boundary |
| Automatically delete files when a timer expires | Avoids review of current holds and references |

## Revisit conditions

Revisit key trust with an independently approved organizational key directory,
and resource transport with larger streaming artifacts. Preserve old package
formats, fingerprints, tombstones and recorded verification outcomes.
