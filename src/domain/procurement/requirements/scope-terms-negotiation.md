# Structured scope, term review and negotiation
<!-- budget: 12288 bytes, hard -->

Owner: `domain/procurement`; decision ADR-0045. Implements remaining compatible
outcomes of FR-RFQ-001/002, FR-NORM-001/002/003, FR-TERMS-001/002,
FR-DEV-001 and FR-NEGO-001/002. FX timestamps and financial/tax comparison retain
their existing `domain/commercial-workbench` owner. Deadline/response/read/print
work is separately owned and must not be counted complete here.

## Scope and normalization

Structured RFQ scope has explicit measurement rules, interfaces, deliverables and
exclusions. Each item identifies one rule, admitted unit and unique responsibility
owner. Drafts can be incomplete; publication checks structured references before
the human approval event. Editing published scope uses an amendment/rebid.
Historical unstructured records are identified as such; migration cannot fabricate
their missing responsibility or measurement declarations.

Quote lines distinguish base, additional and alternative scope. An alternative
references the original RFQ item; an additional line is labelled and never treated
as fulfilling an omitted requirement. Source units may be normalized only through
a declared compatible conversion, with original input and normalized output kept.
Unknown or inexact conversion records a refusal with next action. No default FX
or unit guess is allowed. Accepted order scope preserves these classifications. Structured deviations retain an explicit technical/commercial/schedule/scope category and optional source item, price and whole-day impacts; unknown impacts stay absent and are never invented as zero. Historical uncategorized deviations are identified as undeclared. Impact is descriptive and never silently added to the commitment total.

## Terms

Own term library records have key, family, label, text, revision, active state and
default target. Changes append revisions; archive preserves history. Applying
defaults fills only missing request/quote terms and records exact library references
locally. Publication/submission alone exposes the authored terms.

Comparison lists required and offered values, including missing values and unknown
custom keys. Conflicts never choose a winner. A contractor records a reasoned human
decision bound to exact RFQ/quote revisions: accept the offered exception or require
a revised quote. An unresolved/revision-required conflict prevents award. Revision
invalidates prior decisions. The bilateral reviewed award freezes accepted terms.

## Negotiation

A human configures private rounds, concession percentage, minimum cost uplift and bounds
before opening a thread. Sources must exist; unknown cost floors cannot be bypassed
by a model estimate. Attempts persist increasing numbers, original/current/proposed
amounts, policy source, outcomes and source quote revision. Rejected attempts count.
Every price concession needs an exact action-center review; approval only drafts a
revision, and separate human submission shares it. Changed quote/policy refuses old
proposals. Close and replay retain used rounds. Private policies, floors and internal
analysis never enter public records, exports for counterparties or shared messages.

## Executable acceptance

- Native actual-ledger/QEP checks: incomplete/invalid scope refusal; complete scope
  published and amended; unit conversion retains source and exact money; incompatible
  conversion refused with local event; additional/alternative scope distinguishable.
- Term library revision/default/archive; offered-vs-required conflicts, human
  resolution with exact sources, stale resolution refusal; accepted order terms.
- Policy required, private floor and concession/round limit refusal; human review
  for valid concession, stale proposal refusal, durable attempt order and restart;
  public QEP excludes floor/cost/limits.
- Full GUI authored structured request→supplier offer→term decision→concession
  proposal/review→quote revision, screenshots and actual response/ledger evidence.
- Cross-workspace source links stop at an explicit membership-checked Teams switch; unauthorized parties cannot open the target.
- Focused existing RFQ/fulfillment checks plus isolated production build.

Executed 2026-09-26: scope/deviation/cutoff native5, terms native4, negotiation native5, GUI8, focused RFQ4 and fulfillment6 passed. Real200-item×5-quote normalization/comparison measured93.96ms and replay appended no events. Isolated Vite build108 modules passed. The full GUI report contains zero JavaScript errors. Commands and honest remaining compatible gaps are retained in [execution evidence](../../../../docs/work/evidence/procurement-scope-2026-09-26/README.md).
