# ADR-0057 — Evidence scope for source claims
<!-- budget: 4096 bytes, hard -->

Status: Accepted, 2026-09-28; narrows field-check inputs from ADR-0056.

## Problem

Independent public evaluation of release19683f1 found that a passage mentioning
packaging and installation produced a contradicted five-year-warranty claim at
confidence0.70, although the passage said nothing about warranty. The associated
RFQ required three years. The old question explicitly admitted both `state.text`
and `state.request` as evidence; a buyer requirement is not a supplier assertion.
Observed assessment: `00e6a0af-5b5b-4c18-8574-b51e00bb6e96` (retained in the
[Jev evidence](../../work/evidence/jev-2026-09-28/README.md)).

## Decision

For `field-check`, the model receives only the supplied passage and explicit
claims. A claim requires passage evidence: an omitted fact is unknown; an explicit
opposing statement is contradicted. The selected authorized RFQ organizes the
assessment and remains a pinned ledger reference, but its terms are not sent as
claim evidence. Other modes retain their appropriate RFQ/quotation context.

The GUI distinguishes an associated request from the source passage. Old saved
assessments retain their exact original inputs/results and are labelled when they
included request context; users can deliberately run a new passage-only check.
The existing plugin event envelopes, raw receipt semantics and QEP are unchanged.
This is an application rubric/input selection correction, not a kernel migration.

## Consequences

The native [advisor](../../../src/domain/advisor/requirements/README.md), owning
JEV-002/003/004, can test that unrelated RFQ requirements never enter this mode's
model payload. The same public assistant example must be rechecked with actual Jev.
Users wanting a whole quotation-versus-RFQ comparison should use quote review.
Source isolation cannot guarantee model accuracy; all results remain suggestions
and no confidence value authorizes a commitment.

## Alternatives rejected

Increasing a confidence threshold would not correct evidence attribution. Merely
adding instructions while sending irrelevant RFQ terms leaves avoidable ambiguity.
Replacing the model answer with a programmed expected answer would falsify receipts.
Rewriting saved history would lose the original observation.

## Revisit conditions

Revisit when users need explicit multi-source claim evidence; require identified
source roles and a new bounded rubric rather than implicit context blending.
