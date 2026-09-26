# ADR-0051 — Captured action review provenance
<!-- budget: 8192 bytes, hard -->
Status: accepted

## Problem

The native human-review queue freezes an input hash but shows only the source label and raw input. FR-UX-001 and NFR-UX-002 require a readable source chain and risk flags. Looking up current records by historical IDs can falsely present a newer revision as the basis of an earlier proposal.

## Decision

The action-center service adds a versioned provenance field to new `actions/proposed` workspace records. The owning plugin may supply `input.preview.sources`: labelled record/event references with exact `{realm,seq,hash}`, collection/record ID and an optional application navigation link. Each reference is checked against an actual readable ledger event before the proposal is saved. An unreadable realm, unavailable reference, changed digest or mismatched record refuses the proposal. References are captured once; later source changes do not silently rewrite the review basis.

The owning input may also include `preview.risks`, an array of explicit risk messages or labelled flags. The generic review displays their supplied status without claiming a complete assessment or inventing risk-free status. Missing flags mean Not assessed; an explicit empty array means no flags supplied, with the limitation stated. Generic action-center and WebUI do not infer commercial risk.

The existing exact payload digest is exposed with its sorted-key JSON serialization label and a recomputation check. The source chain includes the actual proposal ledger event, captured owner-supplied event references, originating task/retry when recorded, and exact frozen input. Opening an event is limited to references belonging to an already authorized action and a currently readable realm. Source links are application page/context values supplied by the owner; they do not grant access or replace domain authorization.

Historical records without captured provenance remain readable and explicitly identify missing upstream references. Their frozen input and actual proposal event remain inspectable; the system does not synthesize a historical revision from current state. Reference inspection is read-only and adds no model-visible input or decision. Execution and independent-review authority retain existing semantics.

## Consequences

Reviewers can inspect exact original facts and declared risks before choosing a decision. Source references and hashes remain useful after their owning management plugin unloads. Generic presentation needs no business collection mapping. Plugins that omit upstream references or risk flags remain usable, with that omission visible rather than concealed.

This proves a reference matches its local recorded event, not independent truth of the source, signature verification of a remote party, or exhaustive risk analysis. Changed membership can make a previously captured reference unavailable; current account boundaries still apply.

## Alternatives rejected

| Alternative | Reason |
|---|---|
| Resolve latest record by ID | Misrepresents historical proposal basis. |
| Infer a safe/risky verdict from amount or domain keywords | Invents an assessment outside the owning plugin. |
| Expose arbitrary ledger sequence lookup | Circumvents action-bound source authorization. |
| Freeze existing source-label-only UI | Does not satisfy review provenance requirements. |

## Revisit conditions

Revisit independently signed upstream attestations or new risk-assessment owners through their own source contracts. Do not treat the presence of a local hash as proof that an external factual claim is true.
