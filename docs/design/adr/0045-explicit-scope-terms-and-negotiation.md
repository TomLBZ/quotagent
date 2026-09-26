# ADR-0045 Explicit scope, term decisions and bounded private negotiation
Status: accepted
<!-- budget: 8192 bytes, hard -->

## Problem

The native workflow preserves RFQ versions and bilateral commitments, but a brief
and unconstrained unit string cannot express measurement, interfaces or exclusions.
Named negotiation messages do not reconstruct a round budget or private cost floor.
Commercial differences need explicit human decisions rather than a silently chosen
value. Historical service contracts retain these outcomes, while their CLI-only
approval and unmounted Python composition are superseded by the native application.

## Decision

Procurement owns additive modules for structured scope, term libraries/decisions
and negotiation. They use the native workspace store, existing scoped user resolver,
public QEP policy and action center. No ledger or exchange kernel format changes.

A structured request names measurement rules, deliverables, exclusions and interfaces.
Each line references a rule admitting its unit and one explicit responsibility owner.
Private incomplete drafts are allowed; reviewed publication of structured scope
requires complete references. Existing unstructured records retain their original
meaning and are visibly identified; converting them requires an authored amendment,
never a migration that guesses responsibility. Controlled unit conversion retains
the original offered quantity/unit/price, the declared conversion rule and normalized
values. A missing, incompatible or non-exact basis records a local refusal; it never
guesses an equivalent. Additional/alternative quote lines require explicit classification
and reference and remain visible in comparison and the eventual accepted scope.

Each party owns an append-only versioned term library. Human-authored defaults only
fill missing fields of a private draft and retain local source provenance. Shared
required/offered terms remain separate. Quote-bound conflict decisions reference
the exact RFQ and quote revisions, show both sides, and require a human choice and
reason. Choosing a required revision cannot grant an award; accepting an offered
difference is a recorded exception, not a rewrite of either party's original terms.
Changing either source invalidates the old decision. Accepted scope and terms are
frozen into the existing bilateral award review and purchase order.

Negotiation uses a durable thread, explicit policy and ordered attempts. Policy has
no guessed round, concession or cost-uplift limits. A supplier's minimum price derives
from a sourced private cost basis and its explicit cost-uplift/floor policy; contractor
bounds are private authored limits. Attempts retain the quote/revision, prior price,
proposed price, applicable policy revision, exact arithmetic and outcome. Invalid
attempts consume their sequence number and record the refusal. Every permitted
price concession creates an exact review action, including those within bounds.
Human acceptance may prepare an editable quote revision, while outward submission
continues through its separate human review. Agents can propose and explain, never
approve, alter policy/bounds or send a concession. Replaying a store retains used
rounds, decisions and closed state. Public quote projections exclude policies,
private floors, costs, internal target prices and rejection analysis.

## Consequences

Both sides can explain the scope and terms behind an offer, and suppliers can ask
the agent for a concession without silently disclosing their floor or exhausting
an untracked budget. Existing signed commitments are preserved. New source fields
must be added explicitly to RFQ/quote/order public whitelists and review fingerprints;
model-visible facts are stored before model use. Registrations remain disposable.

This adds decisions and source review to workflows with real ambiguity. A missing
cost or measurement basis stops the affected calculation, not unrelated private
draft editing. Raw historical record shapes remain readable and visibly incomplete.

## Alternatives rejected

| Alternative | Reason |
|---|---|
| Infer unit equivalence or interface owner from prose | Turns a model guess into shared scope without an authored basis. |
| Merge required and offered terms by precedence | Hides the contractual difference and bypasses human judgment. |
| Auto-accept concessions inside a margin band | Violates the existing requirement for every price concession to be reviewed. |
| Keep negotiation counters only in memory | Restart would reset limits and detach decisions from their reviewed source. |

## Revisit conditions

Revisit when multiple native domains need the measurement or terms service, when
negotiation needs binding multi-issue bundles, or when external standards replace
the authored rule library. Preserve actual actors, private costs, source revisions
and the human commitment boundary.
