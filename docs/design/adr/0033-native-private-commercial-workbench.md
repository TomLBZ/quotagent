# ADR-0033 Native private commercial workbench
Status: accepted
<!-- budget: 8192 bytes, hard -->

## Problem

The native procurement workspace exchanges RFQs, quotations and orders, but the
historical private cost factors, capacity checks, sourced weighted comparison,
descriptive supplier history and ERP fallback are not usable through its GUI.
Historical library ownership is not native feature completion. Both parties need
those outcomes without sharing private costs or letting an automated score award
work. RFQ lifecycle changes proceed independently in ADR-0032.

## Decision

Add a native `domain/commercial-workbench` plugin, injecting the procurement public
snapshot/service, account store, web, accounts and settings. It owns its service,
routes, UI contribution, settings and deferred assistant/action registrations with
disposers. It never reads another account's ledger. Contractor evaluations and
supplier factor costs, pricing intentions and capacity calendars remain in their
owner's realm. Generated model-visible analyses are reconstructible from stored
inputs and source event references.

Use additive workspace records in private `commercial-*` collections for cost
models, capacity calendars/plans, FX observations, reference prices, evaluation
policies/results, pricing proposals, ERP mappings/import attempts and reports.
Events use the `commercial/` namespace and the existing workspace-record/v1
wrapper. A source reference carries account realm, event sequence/hash, collection,
record ID/revision and item/field path when applicable. No ledger or QEP envelope
semantics change and none of these private records is exchanged.

Keep ADR-0011's five monetary components and deterministic min/max weighted score:
price, excess delivery days, policy financing exposure, warranty shortfall and
explicitly quantified deviations. Policy financing exposure retains the documented
formula `price × (1 − advance fraction) × net days / 365 × annual capital rate`;
it is a policy approximation, not an invoice, lender quote or claim that longer
credit is a buyer's cash penalty. Show that formula and all policy assumptions.
User-selected weights are account-owned; model suggestions do not silently alter
them. Values and contribution paths retain source citations. Evaluations use a
content digest over exact scope revisions, source snapshots, rates and policies;
the same inputs reproduce the same derived result. What-if evaluation creates a
separate saved result and never rewrites the original inputs.

Stale RFQ revisions cannot enter a current-scope comparison. Missing normalization
data is explicit, not fabricated: missing or expired FX prevents cross-currency
arithmetic until a human records an effective rate and source. Unknown monetary
deviation impact is listed separately. Risk flags identify missing lines,
same-scope/reference-price anomalies, capacity and structured-term conflicts;
flags never reject an offer, resolve themselves or alter its arithmetic/score.
Human decisions remain in the procurement and shared action-review services.

Supplier pricing proposals use private factor totals and explicit target margin.
Applying their proposed prices to an editable quote requires a durable human
review, including any below-floor exception; the final quote submission remains a
separate procurement commitment. A changed quote or cost basis invalidates that
review. Firm delivery commitments cannot be changed by model tools.

Supplier history and scorecards are read-only descriptive statistics, never a
rating, ranking, blacklist or scoring input. Group prices by comparable item,
unit and currency so unrelated lines are not blended. Explicit manual reference
prices or same-item awarded prices may support warning flags with provenance;
they do not turn history statistics into award decisions.

ERP CSV is an explicit manual interoperability fallback: export PO number, line
identifier, quantity and unit price; import through explicit field/master-data
mapping into retained account staging and reconciliation records. Invalid mappings
retain the original row and error. Import does not issue an order, accept goods,
post an invoice or make another external commitment. Weekly reports are sourced
snapshots of recorded activity and amounts, not claims about unrecorded outcomes.

## Consequences

The GUI gains reproducible commercial analysis while private data and human
commitment boundaries remain unchanged. Source snapshots and failed import records
increase storage. Policy approximations and stale references need human upkeep;
no live FX subscription, ERP credential or price feed is assumed. Calendar capacity
is user-declared availability, not independent proof of factory resources.

## Alternatives rejected

| Alternative | Reason |
|---|---|
| Extend the procurement implementation directly | Concurrent lifecycle work has a separate owner; analysis fits a disposable plugin |
| Treat existing library files as completed GUI features | Leaves valid business requirements unavailable to users |
| Infer missing prices, rates or terms | Produces unsupported commercial facts |
| Rank suppliers from descriptive history | Violates the historical read-only scorecard contract |
| Make warning flags automatically reject offers | Removes the human decision boundary retained by ADR-0011 |
| Import CSV as a signed procurement commitment | A data transport cannot supply human commercial approval |

## Revisit conditions

Review source mapping when independent-node ERP delivery arrives, team access when
explicit organizational membership exists, and the financing convention when users
request a different documented economic model. Preserve prior evaluation inputs
and identify the new formula version rather than silently changing saved results.
