# Jev advisory acceptance
<!-- budget: 8192 bytes, hard -->

User supplied `api_keys.typesafe` in the operator configuration, enabling the
deferred T-224 advisory implementation. Owner:
[domain/advisor](../../../../src/domain/advisor/requirements/README.md).
[ADR-0056](../../../design/adr/0056-typed-quotation-advisory.md) adds plugin event
types without changing ledger/QEP semantics. Final public acceptance is pending.

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
after two browser-script interruptions; it was not one uninterrupted run. A wrong
settings-button selector and an aborted response/read race were corrected without
repeating the four successful contractor calls. All personal settings were restored.

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
