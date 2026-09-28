# Jev advisory acceptance
<!-- budget: 8192 bytes, hard -->

User supplied `api_keys.typesafe` in the operator configuration, enabling the
deferred T-224 advisory implementation. Owner:
[domain/advisor](../../../../src/domain/advisor/requirements/README.md).
[ADR-0056](../../../design/adr/0056-typed-quotation-advisory.md) adds plugin event
types without changing ledger/QEP semantics. Public GUI acceptance passed on
committed release `19683f182a49270b5fa0de7df7dfee38db77ae3f`. Independent
review then found RFQ context contaminated a source-only claim; ADR-0057 correction
and exact public recheck are in progress.

## Native and actual-provider evidence

| Command | Observed result | Scope |
|---|---|---|
| `node src/domain/advisor/tests/provider.mjs` | [8 groups,28 real loopback HTTP calls](provider.json) | Typed request/response validation, exact hash reconstruction, usage, credential isolation, failure/timeout/cancellation, admission identity, registered assistant/workroom tool context and complete parent unload. Controlled provider, not model-quality evidence. |
| `node src/domain/advisor/tests/business.mjs` | [6 groups](business.json) | Actual Cordis/Python ledger/QEP: both parties, all4 modes, private-cost exclusion, pinned role/realm, candidate arrival/withdrawal staleness, private review, stop and recovery. Typed provider controlled. |
| `JEV_LIVE=1 node src/domain/advisor/tests/live.mjs` | [10 actual calls](live.json) | Configured TypeSafe endpoint:9 labelled Chinese clarification examples matched expected topics; complete16-line RFQ and16-line received quotation assessed. Exact requests/responses/usage retained. |
| `node src/system/workspace-styles/tests/smoke.mjs` | [8 checks](help-navigation.json) | Role Help, navigation, persisted preferences and disposable contributions. |

Real model observed: `jev-1.13.0`. [Model listing](models.json) and
[initial Chinese probe](live-probe.json) retain HTTP200 observations without keys.
The full RFQ/quote call completed in404ms in this sample; it reported deviation
confidence0.5, requiring manual review. The9/9 topic result is a small authored
sample, not a general Chinese-language accuracy or latency guarantee. Reported
input/output tokens are retained; a total is their explicit sum when the provider
omits total_tokens. No tariff is guessed and unknown cost stays unknown.

## Local GUI acceptance

[Combined browser report](gui-local/combined.json) records five actual Jev
assessments across both roles, exact call IDs and commands. The journey continued
after two browser-script interruptions, without repeating the four successful
contractor calls. Original failures and corrections are retained; settings restored.

Verified: four modes, private acceptance/dismissal and reload, RFQ contextual entry,
inspectable criteria/source snapshots, unavailable recovery, supplier history
isolation,390px layout, TypeSafe usage receipts and Help navigation. A separate
real slow loopback service observed one request using only a dummy personal key;
**Stop assessment** aborted it, kept interrupted history and did not resend while
polling. See [pending](gui-local/cancel-only/07-pending-with-owned-stop.png),
[retained interruption](gui-local/cancel-only/08-interrupted-retained.png) and
[mobile](gui-local/resume/05-mobile-advisor.png).

## Findings retained and corrected

The initial full-host GUI exposed access to the child provider through an undeclared
Cordis property. Capturing `ctx.get('jev')` fixes the native composition; the full
parent unload test also verifies durable interrupted work and removed effects.

An independent source review found an older shortlist could remain current after
a new eligible offer arrived. Saved candidate identities and quote-status hashes
now participate in staleness; actual new rival submission and withdrawal are in
the business test. Role changes also hide the former perspective's assessments.

Actual quote-review response validation rejected a provider reply. The original
failed response was not retained, so it cannot be reconstructed after the fact.
One [exact-request replay](quote-review-replay.json) returned HTTP200 in433ms:
reported score1.14 versus1.13 from the rounded probabilities, confidence0.11.
This demonstrates the strict precision mismatch, not identical output on the
original call. Validation now checks whether a normalized distribution within
the reported rounding intervals can explain the score, preserving raw values.
Impossible distributions/scores still fail. Rejected responses now retain a
sanitized body and field-specific reason in `advisor/model-failed`.

Pending assessments have an explicit in-progress state, read-only polling and an
owner stop action. A client correlation identifier selects the exact newly
started job; it is not an idempotency guarantee. No polling or restart resends a
provider request. Accept/dismiss records only a private review annotation.

## Committed public release

[Build/deployment commands](release/commands.json), [manifest](release/manifest.json)
and [served assets](release/served-assets.json) bind the immutable release to the
pushed source. Build:117 modules. [Copied-data preflight](release/preflight.json):
38 reads across three roles, with outbound transports disabled only for that copy.
The old process was stopped, production data backed up and releasePID84718 started.
All local build hashes and all8 public non-HTML asset hashes match. The public
gateway injects a bridge into HTML; its exact entry JS/CSS references match.

[Public GUI report](public/combined.json) retains five unique real Jev call IDs:
Chinese clarification, quote review, shortlist, contractor claims and supplier
claims. Source navigation, private review/reload, disable/recover,390px, usage and
Help passed with no JavaScript errors. One duplicate-heading selector required
continuation from the saved clarification; no successful model call was repeated.
No local provider override was used publicly. Personal settings were restored.
The review showed confidence0.26; shortlist returned no-match at0.41. Both required
human review. These are observed suggestions, not an accuracy or award claim.

## Claim evidence correction

Independent public chat invoked the registered Jev tool and exposed a source
attribution defect: an unstated supplier warranty was judged contradicted at0.70
using the buyer RFQ requirement. [ADR-0057](../../../design/adr/0057-claim-evidence-scope.md)
limits field-check model input to the pasted passage and explicit claims. The
linked RFQ remains an authorized association. Old snapshots remain intact and
warn that their earlier method included RFQ context. Other modes keep their inputs.
[Seven native groups](business-claim-scope.json), command
`node src/domain/advisor/tests/business.mjs`, prove conflicting RFQ warranty/item
requirements cannot enter or change field-check evidence. Corrected public replay
is pending; input isolation does not establish general model accuracy.

## Reproduction and limits

Commands run from the repository root. Native tests create isolated fictional
records; live testing requires the explicit `JEV_LIVE=1` opt-in and configured
TypeSafe credentials. GUI tests use role-authorized app interactions; only
fictional quotation records are sent for model assessment.

The independent chat connection remains configured separately. Jev supplies typed
suggestions, not text, monetary calculations, supplier authority or approvals.
No assessment changes deterministic comparison, pricing or business commitments.
Admin manages configuration/usage and cannot open private client assessments.
Primary API sources: [HTTP](https://docs.typesafe.ai/api),
[confidence](https://docs.typesafe.ai/confidence),
[models](https://docs.typesafe.ai/models), accessed2026-09-28.
