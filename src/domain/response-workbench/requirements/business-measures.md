# Recorded business measures
<!-- budget: 8192 bytes, hard -->

Owner: `domain/response-workbench`; SUPPLEMENT-034. Original source:
[09 observability and evaluation §§2–5](https://github.com/TomLBZ/quotagent/blob/9918eb74fee13615da77ca2837d359ebe3c17f2f/docs/design/09-observability-and-eval.md).
This closes the business projection gap; provider usage, evidence reconstruction,
recorded scenario replay and evolution trials retain their existing owners.

The Business measures tab compares two explicitly dated equal-duration windows
(default latest30 days against the preceding30). It reads accepted workspace-record
facts in the authorized selected business realm, never raw unaccepted transfers.
Only RFQs visible through procurement.snapshot participate. Supplier output contains
only its own offers/questions and shared answers; no competing response counts,
private contractor analysis or other-account provider costs. Own personal analysis
and model events are labelled separately from shared party records. Known demo
RFQs are excluded unless the person explicitly includes them.

Definitions and denominators are visible alongside values and source sequence/hash:

- Response cycle: first locally visible published RFQ revision to first locally
  recorded submitted matching quote, among revision cohorts starting in the window.
  Buyer publication→receipt and supplier receipt→submission are distinct local-clock
  measures. Unanswered cohorts are reported separately, not treated as zero time.
- Quote completeness: priced base RFQ lines / required lines and supplied applicable
  commercial fields / declared field checklist, on each distinct submitted quote
  version visible by that window's end. Alternative/additional scope is disclosed,
  not silently counted as identical base coverage. Missing fields stay missing;
  explicit zero is supplied. This is structural completeness, not correctness.
  Measurement conformance separately counts base lines matching a declared source
  measurement rule/quantity/unit. Historical lines without declarations are unknown.
  Submitted quotes after a superseding RFQ revision are excluded as stale, even if
  their older revision has its own cohort in the selected window.
- Clarification rounds: unique same-RFQ/revision questions with a published answer,
  divided by published revision cohorts. Open questions remain visible separately.
- Human changes: changed editable leaf values / compared leaf values for the first
  human save after a recorded agent draft of the same RFQ/quote, including public
  assumptions, exclusions and schedule declarations. Unmatched human
  records are not inferred to be agent rewrites. Count approved business actions and
  agent-control interventions separately; clicks and passive reading are not edits.
- Comparability and comparison latency: only actual saved private commercial analyses
  for exact visible RFQ/quote revisions; scored rows / analyzed rows, and analysis
  event minus latest included submitted quote event. No analysis means unmeasured;
  scope and denominator coverage are explicit. No reranking happens during a read.
- Provider cost: signed-in account's recorded configured-rate cost estimates within
  each period, grouped by currency with unknown-priced call count. Estimates use
  the recorded tariff and reported tokens, not billed charges. This is account usage,
  not an invented allocation of costs to a project.
  Own recorded provider duration/failure, measured-boundary reconstruction outcomes
  and double recorded-assertion replay consistency are also projected from their
  owner records. These do not certify fresh-model determinism or source accuracy.

False-positive/detection quality needs linked human reference labels; absent labels
remain explicitly unmeasured. Existing evidence reconstruction and recorded scenario
replay pages provide their own measured reports. No baseline target, time saving,
win-rate improvement, productivity superiority or causal inference is invented.
Baseline/current values use identical formulas and filters. Time is ledger-local at
one-second precision; same-second events can yield a measured zero duration.

HTTP: `GET /responses/metrics` and `/responses/metrics/export`; service
`ctx.responses.metrics(user, query)`. Read-only projection/export writes no events.
Dates are inclusive start/exclusive end, at most93 days per window, equal duration;
invalid or overlapping comparison ranges refuse rather than silently rescale.
The frontend shows both windows, source coverage, per-period/daily rows and accessible
charts. Filters/presets are interactive and CSV retains scope/definitions.
There is no new ledger/QEP format or automatic notification/commitment here.

Acceptance commands (implementation must provide recorded outputs before verified):
- `node src/domain/response-workbench/tests/metrics.mjs`: deterministic independent
  two-window arithmetic; known-zero versus missing; revision/duplicate/cutoff and
  unaccepted-transfer controls; actual Cordis/store ownership, no write on read,
  supplier/outsider/selected-team isolation, restart and disposal.
- `BASE_URL=http://127.0.0.1:8648/quotagent/ node src/domain/response-workbench/tests/metrics-browser.mjs`:
  contractor/supplier real GUI filters, equal-window comparison, source details,
  exports, unavailable/empty distinction and390px. Recorded synthetic fixtures are
  labelled; measured record behavior is not a live productivity study.
