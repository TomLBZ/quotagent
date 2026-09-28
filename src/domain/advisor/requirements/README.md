# Jev quotation advisory
<!-- budget: 8192 bytes, hard -->

Owner: `domain/advisor`. This implements the deferred T-224/D-018 advisory outcome
from `9918eb74:docs/work/progress-checklist-archive-b.md` and
`9918eb74:docs/analysis/jev-model-research.md`, reauthorized September28 after the
operator supplied `api_keys.typesafe` in `/workspace/config.yaml`.

## Required behavior

1. A disposable native Cordis plugin calls TypeSafe's structured System One API,
   independently of the chat model. Read the configured TypeSafe key without
   rewriting the operator file; account settings support shared or personal
   connection, model, timeout and review threshold. A personal endpoint change
   cannot forward an inherited shared key.
2. Both client roles can assess authorized RFQs/quotes in the GUI and through
   the assistant/workroom. Offer clarification topic routing, quote anomaly and
   deviation review, a contractor shortlist suggestion with an explicit no-match
   choice, and source/claim cross-checking. These are suggestions, never changed
   prices, numerical scores, supplier permissions, awards or business approvals.
3. Select business sources server-side in the current party. Pin exact revisions,
   ledger references and the complete source text/rubric before dispatch. Exclude
   supplier private costs and buyer private evaluation data from provider inputs.
   User-authored clarification/source/claim text is retained with the assessment;
   do not silently truncate requests. Report changed sources and shortlist candidate sets as stale on replay.
4. Record exact typed request, serialization/hash, model/version, actual response,
   confidence/probabilities, usage and failure in append-only events. Existing
   AI budget/concurrency/cancellation controls and usage charts also cover Jev.
   Unknown usage/cost stays unknown. A Noul probability is not Choice confidence.
5. Low Choice/Score confidence and ambiguous Noul probability require explicit
   human review. Every result remains advisory even at high confidence. Accepting
   or dismissing an assessment records only a private annotation. It never supplies
   an approval to a send, award, order or self-evolution decision.
6. Missing credentials, malformed responses, timeout, capacity refusal or provider
   failure visibly leave the assessment unavailable and normal quotation work
   usable. No synthetic fallback answer or silent retry. The GUI can stop the exact pending assessment; assistant/workroom cancellation
   and plugin disposal abort calls; interrupted saved work is explicit and never silently replayed.
7. The GUI exposes current availability/settings, task selection, typed results,
   uncertainty, source/rubric inspection, human review and saved history. Account
   records remain private and administrative views expose configuration/status
   rather than other users' assessment text.

## Acceptance to execute

- Native local-protocol provider tests: exact request/receipt reconstruction,
  response types, key scope, timeout/cancel/unload, failure and measured usage.
- Native business tests: both party perspectives, current-source binding/staleness,
  private-data exclusion, four assessment modes, low-confidence review, unchanged
  deterministic comparison/commitment records and remount history.
- Actual configured Jev calls: labelled Chinese clarification cases and a complete
  RFQ/quote review; retain measured latency/usage and limitations, not vendor claims.
- Browser journey: assess, inspect, review, reload, source navigation, unavailable
  recovery and narrow viewport; final public replay on a committed release.

API contract sources (checked September28):
[HTTP API](https://docs.typesafe.ai/api),
[models](https://docs.typesafe.ai/models),
[confidence](https://docs.typesafe.ai/confidence).
Evidence: [Jev acceptance](../../../../docs/work/evidence/jev-2026-09-28/README.md).
