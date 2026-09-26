# Private commercial workbench
<!-- budget: 16384 bytes, hard -->

Native owner: `domain/commercial-workbench`; decision:
[ADR-0033](../../../../docs/design/adr/0033-native-private-commercial-workbench.md).
The plugin implements the compatible G2 gaps recorded in the Sept26 requirements
audit. It consumes `procurement.snapshot(user)` and its authorized `realm(user)` source.
Private cost/evaluation records remain caller-owned; source quotations may belong
to an explicitly joined, selected party workspace. It never scans other realms. No completion claim is made until the executable checks below pass.

## Requirement mapping

| Retained clause | Native outcome | Executable check |
|---|---|---|
| FR-COST-001, FR-COST-003 | Per-item material, labor, equipment, overhead, risk, tax and finance costs; rate/base/source explanation | factor arithmetic and source reconstruction |
| FR-PRICE-001 | Saved pricing intent, margin floor warning and durable human review before applying exact prices to a draft | below-floor review, stale-basis refusal, no automatic submission |
| FR-CAP-001, FR-GUARD-003 | Private dated availability, dependency milestones and delivery feasibility flags | shortage/critical path/overlap cases and no automatic date change |
| FR-COMPARE-001, FR-COMPARE-002 | Five-component normalized TCO, account policy weights, contribution breakdown and saved what-if results | hand-computed totals, equal-input digest and weight-change ranking |
| FR-COMPARE-003 | Each calculated amount, factor and score traces to ledger and line/policy/rate source | citation completeness and source sequence/hash lookup |
| FR-GUARD-001, FR-GUARD-002, FR-GUARD-004 | Same-scope and sourced historical low-price, line gaps, payment/warranty/penalty conflicts | flags do not change scores or commit decisions |
| FR-PRICE-003 | Source-labelled counts, min/median/max/latest and discrete trend by supplier and comparable item | missing-data handling and no rating/ranking fields |
| DOMAIN-009 | Explicit master/column mappings and two-way PO CSV fallback; original failed rows retained | export/import round trip and mapping-error retention |
| DOMAIN-010 | Human-recorded FX rate, source, effective/expiry timestamps and explicit readiness | missing/stale rate cannot silently normalize a quote |
| DOMAIN-011 | Manual source-labelled reference prices with own-realm awarded-item fallback | manual/award reference provenance and anomaly flag |

Also preserves FR-COST-002 private realm isolation, FR-CAP-002 firm date protection,
FR-PRICE-002 human final price, FR-COMPARE-004 readable/exportable comparison, and
FR-EVAL-005 descriptive supplier scorecards. Weekly reporting is a sourced summary
of stored quotation/order activity; it does not invent delivery or savings results.

## Service and GUI contract

Inject `procurement`, `store`, `accounts`, `web`, `settings`; provide `commercial`.
Deferred `assistant` and `actions` integrations avoid composition cycles. Root
mounts this plugin after procurement and imports its client page. Native page ID
`commercial`, label `Commercial workbench`; admin receives no access to another
party's commercial data. Editable account-scoped settings ID `commercial` contains the private minimum
pricing margin; private models and selected policies are
account-owned records.

GET `/commercial?rfqId=...` returns the caller's visible procurement context,
private workbench records and descriptive history. POST `/commercial/:action`
performs named owned operations. Export GET `/commercial/export?kind=...` returns
the caller's comparison, report or order CSV. All writes enforce account capability
`workspace:write`; assistant tools declare read/draft/proposal effects. Models can
read only their user's facts, prepare private analyses and propose pricing review.
They cannot approve a pricing exception, modify a firm date, publish or submit.

Supplier GUI: choose a quote, edit factor rows with sources, inspect totals/margin,
prepare reviewed pricing, maintain dated capacity and a dependency plan, inspect
own descriptive history and download reports/ERP rows. Contractor GUI: choose an
RFQ, review normalized commercial fields and missing assumptions, record FX and
reference observations, set weights/cost policy, compute/inspect/export sourced
TCO and flags, compare saved what-if results and supplier descriptive scorecards.
Both roles can import explicit ERP mappings and retain failed rows for correction.

Procurement remains owner of public quote tax/validity/deviation/payment/warranty
fields, RFQ required terms, publishedRevision and quote rfqRevision/stale status.
Workbench analyses snapshot those public fields. Private factor prices and capacity
never enter public quote payloads. Applying human-reviewed pricing calls the
existing draft service with exact RFQ item IDs, not direct procurement record writes.

## Arithmetic and provenance

FR-GUARD-005 adds source-path warning flags for instruction-like quotation text and
explicit private-cost/benchmark disclosures. These deterministic signals are
nonexhaustive prompts for human inspection; they neither reject nor change scoring.
FR-VIZ-001 retains contribution-based improvement guidance against the current
comparison set, with source citations and explicit fixed-peer assumptions. It is
not a promise of a future rank. Human-entered finite weights are clamped0–100 and
normalized to100, with original inputs, adjustments and accepted weights displayed
and persisted. All-zero weights require correction; no policy is guessed.

Money rounds to cents at explicit line/conversion/component boundaries; quantities
allow six decimals. Cost factors retain their entered base, rate, amount and source.
Overhead applies to direct material/labor/equipment; risk and finance apply to direct
plus overhead; tax applies to the resulting pre-tax cost. No absent factor is
silently fabricated. Pricing margin is `(item subtotal − fully burdened cost) / item subtotal`;
separately declared sales tax and freight appear in the exact invoice preview but
do not inflate that item-price margin. Exclusive sales tax applies to item subtotal.
Users select the target margin and review its resulting prices before applying to the draft.

TCO preserves ADR-0011's policy convention: normalized price, excess delivery days
times time cost, financed share times net days/365 times annual capital rate,
warranty-month shortfall times cost, and explicitly quantified deviation impact.
Weights scale min/max normalized components; equal values score zero; ties use
quote ID. Missing inputs and unquantified deviation impacts are exposed. Stale RFQ
quotes remain visibly excluded. Warning flags cannot alter scores. Supplier history
does not contribute to scores. Rates and reference observations have source and
effective timestamps; expired FX is never silently reused.

Source references include realm, event sequence/hash, collection, record ID,
revision and item/field path. Evaluations retain exact frozen inputs and derived
content digest; display timestamps remain outside the deterministic digest.

## Acceptance commands and evidence

`node src/domain/commercial-workbench/tests/smoke.mjs` must exercise real native
Cordis and Python-ledger persistence for every mapping above, both account roles,
cross-account rejection, no competitor/cost leakage, reviewed pricing replay,
source reconstruction after remount and complete effect disposal.

`BASE_URL=http://127.0.0.1:8620/quotagent/ EVIDENCE_DIR=tmp/agent-experience/commercial
node src/domain/commercial-workbench/tests/browser.mjs` must perform both roles'
cost/capacity/evaluation/FX/reference/history/ERP/report workflows through the GUI,
inspect actual calculated amounts, preserve raw mapping failures, exercise human
price review without submitting a quotation, and save screenshots plus JSON report.
Public deployment acceptance repeats the command with the public URL. Model tool
integration must read the same persisted facts; fixtures are labelled as fixtures.

## Local verification (2026-09-26)

Service command above: **PASS 5 groups** at 02:22:01Z, report
`tmp/commercial-smoke-DII3eE/report.json`. Native Cordis mounts real store, settings,
teams, actions, procurement and this plugin; no fake ledger. The team check uses
actual invitation/acceptance/selection and confirms party-source references with
member-owned evaluation records.

Browser command with `BASE_URL=http://127.0.0.1:8641/quotagent/`: **PASS 5 groups**,
zero JavaScript errors, at 02:22:33Z; report, captured responses, seven screenshots
and exported CSV files are in `tmp/agent-experience/commercial/local/`. All business
writes used visible GUI controls. £110 factor costs at 20% item-price margin
produced £137.50 items + £27.50 tax + £5 freight = £170, reviewed below the 25%
margin floor. Received €300 normalized to £360 at a manually sourced 1.2 rate.
An unmapped CSV retained its exact original row and error. Browser reload restored
private costs; the mobile report did not overflow. Native unload/remount recovery
is covered separately by the service check. Build: **PASS 66 modules**.

This isolated process used procurement's then-current single-human fixture award
flow. The subsequent independent reviewer/signature integration and final public
journey belong to the parent integration batch; this local evidence does not claim
those passed. ERP is manual CSV staging; rates/references are manual observations;
capacity is declared availability, not a connected factory schedule.

## Bilateral integration and editable-state follow-up (2026-09-26)

The native five-group check now creates a nonbinding award intent, supplier
confirmation, an independent colleague's grant and a separately signed PO before
checking award references and ERP. The full GUI check performs the same sequence
with a newly invited reviewer; its five groups pass at03:24Z on the integrated
native application. Source evidence: `tmp/product-evidence/fulfillment/verification/commercial-smoke.json`
and `tmp/product-evidence/fulfillment/commercial-gui-final/` (responses, CSVs,
seven screenshots, no JavaScript errors).

Editor identity is the quotation ID, not its refreshed revision. Unsaved cost
inputs and focus survive two background refreshes. Terms retain their opened
revision, show the latest declaration when it changes, and require explicit load
or keep-edits review. Save sends that opened revision to the atomic procurement
write; changed quotations cannot silently replace terms. Buyer assumptions also
refuse a stale opened quote revision, without recording a misleading source. Executable check:
`BASE_URL=<url> node src/domain/commercial-workbench/tests/editor-browser.mjs`.
Two GUI editors with a delayed read refresh produce a real409; edited freight
remains visible, the human reviews and retries, and the other editor explicitly
loads the resulting current values. **PASS2 groups**, evidence
`tmp/product-evidence/fulfillment/commercial-editors/`. Public acceptance remains
pending the parent's committed release.
