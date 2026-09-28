# ADR-0056 — Typed quotation advisory
<!-- budget: 4096 bytes, hard -->

Status: Accepted, 2026-09-28.

## Problem

T-224 deferred Jev until credentials existed. The current native chat adapter
expects generated messages; Jev evaluates a state against typed questions.
Historical SSR advisor scaffolding does not implement this behavior.

## Decision

`domain/advisor` owns a disposable native service, TypeSafe transport and GUI.
Its [contract](../../../src/domain/advisor/requirements/README.md) describes the
business outcomes. Existing provider admission and usage services are reused.

New `advisor/model-requested`, `advisor/model-completed`, `advisor/model-failed`
events retain the entire typed request, exact serialized digest, sources and
actual result/failure. `advisor/assessment-created`, `advisor/assessment-completed`,
`advisor/assessment-unavailable`, `advisor/assessment-interrupted` and
`advisor/assessment-reviewed` record account-owned assessment projections.
These are additive plugin event types using the existing workspace envelope;
neither ledger encoding nor QEP semantics change. Assessments are not exchanged.

The selected authorized business realm is pinned when building the request.
Inputs use public RFQ/quotation terms and explicit user text, excluding private
costs/internal evaluation. Exact source revisions are recorded and rechecked.
The external response is an advisory observation, not a verified business fact.
High confidence never grants permission. Accept/dismiss writes only the private
annotation; existing business approvals remain independent.

## Consequences

Typed assessments are reconstructable without interpreting a chat transcript.
The UI can distinguish Noul probabilities from Choice/Score confidence, retain
low-confidence results for manual review, and report failure without blocking
ordinary quotation work. Calls consume configured provider budgets. Costs remain
unknown unless an explicit matching tariff exists. Missing/ambiguous responses
are not replaced with fabricated answers; interrupted requests need explicit retry.

## Alternatives rejected

Reusing `/chat/completions` would misrepresent the provider API. Auto-awarding from
model confidence would replace human authority. Reinstating obsolete SSR modules
would not make the current GUI usable. Logging only a state hash would prevent
reconstruction of model-visible input.

## Revisit conditions

Revisit if TypeSafe changes typed response semantics, new cross-realm sharing is
requested, or measured domain quality warrants different rubrics/thresholds.
