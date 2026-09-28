# Independent Jev follow-up — 2026-09-28
<!-- budget: 8192 bytes, hard -->

Agent evaluation, not a human user study or accuracy benchmark. I independently
reviewed the new advisor source before this public trial; I did not implement it.
This is a scoped follow-up to the September26 product evaluation, not a repeat of
its full business, channel or generated-plugin acceptance.

## Scope and release

Public GUI: https://novara.remoteblossom.com/quotagent/ . Initial observed release
`19683f182a49270b5fa0de7df7dfee38db77ae3f`, deployment PID84718, asset
`index-CUSkb33R.js`; authority is
`docs/work/evidence/jev-2026-09-28/release/manifest.json` and its deployment record.
Initial public work ran approximately10:34–10:38UTC. Contractor and supplier demo
accounts were used after the preceding browser tester restored personal settings.
All writes used GUI: two direct private assessments, one assistant-created private
assessment and one private dismissal. No supplier message, publication, award,
price edit, settings change, source edit or deployment was made by this evaluator.

## Actual observations

| Job | What I observed | Evidence |
| --- | --- | --- |
| Contractor claim check | New passage states a three-year warranty, excludes installation and includes packaging. Three explicit claims returned supported/contradicted/unknown correctly, each confidence1. Unknown still required human review. Exact text and criteria were inspectable; private dismissal and note survived reload. | `03-independent-claims.json`, `03`–`05` screenshots/text; assessment `11010dcd-bb38-4b83-8610-c3119354eee6` |
| Supplier's real saved offer | Jev inspected Summit's Riverside quote: $5,532,14days,30/70 payment, freight/warranty note. Source snapshot omitted private cost. Result: possible mismatch probability0.43, ordinal deviation0.57/confidence0.43, next clarification commercial/confidence0.39. All were flagged for review. Source button opened the actual offer. Supplier had no shortlist option or contractor assessment history. | `06-supplier-context.json`, `07-supplier-review.json`, `07`–`09` screenshots/text; assessment `5ab508a0-3c94-4cba-abb8-b7f66af03013` |
| Existing contractor shortlist | Read an earlier tester's result through the actual GUI and expanded exact sources. Both offers state14days; explicit priority asks for shortest delivery. Jev chose none, confidence0.41, flagged review. This does not establish a superior supplier or measurable selection benefit. I did not rerun its model call. | `02-existing-shortlist.json/png/txt`; assessment `785d8ae9-2dcc-42ab-bac4-a4d7de5d1129` |
| Actual assistant integration | Submitted an explicit source/claims prompt in Agent workspace. Actual chat model `deepseek-flash` used `procurement_workspace` then `assess_quotation`; Jev returned `jev-1.13.0`. The assistant accurately relayed typed results and their source association. Its Review Jev assessment button opened the saved result. | `10-assistant-prompt.json`, `11-assistant-result.json`, `12-assistant-completed-link`, `13-assistant-saved-assessment`; run `6c082e6b-98b5-4d15-a1e3-dae72fb662ce` |

Own direct claim/supplier calls reported1180/1375tokens; the assistant's Jev call
reported1119. These are individual receipts, not cost or speed benchmarks. No
independent probability calibration was performed.

## Material finding on19683f1

The assistant source passage said only: “The offer includes packaging.
Installation is expressly excluded.” For “The offer states a five-year warranty,”
Jev returned **contradicted**, confidence0.70 (probabilities contradicted0.8,
unknown0.2), `requiresReview:false`. The saved request separately asks for a
three-year warranty. That buyer requirement cannot prove what this offer says.
The offer claim should remain unknown. Assessment
`00e6a0af-5b5b-4c18-8574-b51e00bb6e96` retains the exact input/result.

The chat assistant itself noticed this: it explained that five years was
unsupported rather than cleanly refuted. That was useful additional judgment,
but the standalone result still displayed the contradictory classification
without a review warning. This was a real source-scoping defect: the original
field-check rubric explicitly used both `state.text` and `state.request` as
evidence. I reported it before any correction.

## Targeted correction on c737f1

At10:42–10:44UTC on immutable `c737f100a7dbdb063dd5d288e726f4467424e0a5`
(PID88363), I repeated the exact original assistant prompt without supplying an
expected answer. Actual tools again read the workspace then called Jev. New
assessment `0855ad53-fda9-44fd-8a5f-545ea83d2143` saved only text and claims in
model state, with no request terms. Results were supported/contradicted/
**unknown**, all confidence1; unknown still required review. I opened its saved
GUI link and exact passage. The RFQ is labelled an association, not evidence.
The unchanged old result now displays “Earlier source-check method” and directs
a new passage-only assessment regardless of old confidence. Evidence:
`recheck/11-assistant-result.json`, screenshots13–15 and `15-legacy-record.json`.
This closes the observed scope defect, not every possible classification error.
The recheck reported1097Jev tokens; no direct-mode rerun was needed.

## Practical choice and remaining limitations

I would still choose Quotagent for repeat multi-supplier quotation work where both
parties use its structured workflow. Its saved request/offer identity, private
review and inspectable AI receipts remain more useful to me than reconstructing
that business state from email, Teams, Slack or WhatsApp plus a spreadsheet. This
is my preference based on the prior business trial and this bounded follow-up,
not a comparative benchmark or claim about untested competitors' integrations.

Jev adds a convenient, recorded second opinion. The three-way claim check was
clearer than an unstructured chat answer, and the assistant could call the tool
without my leaving the conversation. It is not sufficient reason by itself to
move an occasional supplier enquiry out of email. I would use it selectively,
not treat it as an automatic quotation judge.

The supplier result merely said “commercial” without identifying the clause or
explaining what conflicted. A reviewer still has to read the source. The ordinal
number is explicitly not money, and neither it nor confidence proves correctness.
The original warranty failure shows that a result above threshold can be wrong.
Even after the typed correction, chat added “Packing/freight/tax terms aren't
stated” although the passage includes packaging. That prose slip remains; the
typed answer correctly supported packaging. Long pages and raw JSON add reading work.
I would retain existing messaging tools for ordinary coordination and require
human source checking before acting on advisory results.

This trial did not independently replay pending/cancel, new-rival staleness,
admin configuration, live channel interoperability, mobile layout or provider
outage. Those have separate implementation/test evidence; they are not my own
public observations here. Four new Jev calls with two chat tasks are too small to
establish reliability, time saved, deployment adoption or accuracy calibration.

## Reproduction

From the repository root:
`BASE_URL=https://novara.remoteblossom.com/quotagent/ EVIDENCE_DIR=tmp/jev-2026-09-28/independent STAGE=<stage> node tmp/jev-2026-09-28/independent/replay.mjs`.
Stages executed: inspect, claims, supplier, assistant, inspect, assistant-read;
then assistant, assistant-read and legacy into `independent/recheck` after deployment.
The script contains exact GUI inputs. Replaying claims/supplier/
assistant creates new private test records and consumes model calls. Initial
request selection and an exact button-name locator were corrected evaluator
errors; the button includes “Ready for your review” and the corrected source panel
is called “Exact passage and questions.” Read-only retries used those labels.
No credentials/session files are saved in this evidence directory.
