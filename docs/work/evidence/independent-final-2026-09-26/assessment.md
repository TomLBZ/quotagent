# Independent practical evaluation — 2026-09-26
<!-- budget: 8192 bytes, hard -->

**My preference:** I would choose
Quotagent as my supervised workspace for repeated, multi-supplier quotation work
instead of managing the business state in email or Teams/Slack/WhatsApp threads
plus a comparison sheet. I would retain those channels for reaching suppliers,
quick discussion and one-off enquiries. This is an agent judgment, not a human study or timed competitor trial.

I independently used the public GUI at
<https://novara.remoteblossom.com/quotagent/> on immutable
`67bd9af5b73036104f81abdacae0883fd8d2ffce`, 07:38–07:53 UTC, with two fresh
accounts, the configured contractor demo AI and a read-only admin session.
`release-initial.json` records deployment. At 07:56–08:00 UTC I
rechecked the arithmetic/picker corrections on immutable
`3ab6d8cde6d2d05acb3a73403279fc9be579a15f` (`release-recheck.json`).

## What I actually did

| Job | Observed result and evidence |
| --- | --- |
| Fresh contractor request | Created `[Evaluation] North workshop benches`: 12 benches, explicit delivery/unloading/install boundary, count measurement, no quote deadline. Saved, inspected and explicitly published to my fresh supplier. Optional deadline remained absent. `08-saved-draft`, `09-publish`, `10-published` PNG/TXT; exact inputs `08-draft-fields.json`. |
| Fresh supplier response | Received the same revision and declarations; drafted 12 × $250 = $3,000, private unit cost $187, 21 days, Net 30, shared exclusions/tax question. Reviewed then submitted through GUI. Buyer received $3,000/terms without $187. Tax and freight stayed visibly unstated in structured charges despite free-text delivery included. `11-supplier-request` through `16-contractor-offer`. No award or PO made in this trial. |
| Operational AI | Real model read Riverside's existing two offers: $5,532/$5,292, panels $324 lower and sensors $84 higher, net $240, 14/35 days, 30/70 versus full advance. It identified unstated tax and conditional next steps. A second answer made the material deposit error below. `18-ai-paused.txt` contains the first completed answer; that filename reflects a failed evaluator locator, not an actual paused state. |
| Task control | Paused a new read-only task, reloaded and saw saved pause; added guidance, resumed, and received the corrected $1,659.60/$3,872.40 split. A separate task stopped and remained stopped after reload. No send/award occurred. `20-paused`–`24-stopped-reloaded`. |
| Generation AI | Asked Studio for a personal Deposit split utility. It generated a runnable tool; 5532/30 produced 1659.60 and 3872.40; 130% produced an explicit error. `28-generating`, `32-generated-library`, `33-generated-tool`, `34-generated-valid`, `35-generated-invalid`. Usage records actual creation: 2,171 tokens/5.6s, not a general speed claim. |
| Usage and measures | Clicked Sep26 usage bar: 13 calls, 11 with reported tokens, 2 canceled/unreported, unknown costs clearly stated. Fresh business measures showed one sourced 78-second response cycle, 100% line completeness, 20% structured commercial-field completeness and unmeasured baseline. `36-ai-usage`, `39-usage-day-detail`, `49-response-coverage`, `50-business-measures`. |
| Mobile/admin | At 390px supplier quote and actions remained readable, with vertical scrolling. Admin separates account/global extension controls; no settings changed. Directory omitted from evidence. `38-supplier-mobile`, `31-administration-header`. |
| Earlier connected work | Opened retained email source/XLSX attachment, Telegram fixture history, completed three-specialist workroom and an exact approved MCP input/result. Removed connection still opens read-only history: 30×80+120=2520. These are earlier loopback executions. `40-workroom`–`44-mail-source`, `48-remote-review-receipt`, `51-removed-connection-results`. |

## Material finding and practical limits

**AI arithmetic failed on 67bd9af.** In the detailed Riverside answer, the agent
said Summit's 30% deposit on $5,532 was “3,240 down.” Correct is $1,659.60.
It was not flagged by the UI; “illustrative” did not make it accurate.
`21-paused-after-reload.txt` preserves the original wrong answer; `23-resume-reloaded`
preserves my explicit correction and the resulting answer. The quote record stayed correct. Human steering
corrected this instance; that alone does not establish a product fix. This rules out trusting financial prose without verification.

**Targeted correction passed on 3ab6d8c.** Without feeding the correct amounts,
I requested a detailed comparison and payment amounts. The model actually used
`calculate_quote_amount`: 30/70% of source $5,532 became $1,659.60/$3,872.40,
with quotation revision 1, ledger sequence 83 and hash; Atlas 100% used sequence85.
The UI opened the source quote. `52`–`56` preserve response, expanded receipts and
normal GUI response JSON. This closes the observed instance, not every possible
AI arithmetic failure. The separate generated utility is not this built-in fix.

The former unfiltered 15-supplier picker (`05`, `07`) now has search. I selected
my supplier, filtered to no matches, saw “1 selected · 1 hidden,” then cleared
and retained the selection (`54`, `55`, `57`). Structured scope still takes more
effort than a short email; worthwhile for repeat tenders, less for one-item enquiries.
The workroom reports require substantial reading and repeat unrelated warnings.
Mobile quote details are long.

The generated utility is useful for recurring calculations but has manual inputs;
it does not automatically bind its amount to a saved quote. I tested one valid and one invalid case, not every edge. Generation does not
prove every generated tool correct. The app's own deterministic quote total and reviewed business records
remain my basis for decisions.

Declared boundaries matter: image-only PDFs need external OCR; mail needs
IMAP/SMTP, Telegram a bot; A2A updates need manual refresh; offline stores only
the shell; ERP/FX/capacity need manual input. Sources: current owner contracts
listed in the [preflight rubric](preflight-rubric.md). Production-channel interoperability and human supplier adoption were untested;
prior external-protocol executions used loopback fixtures only.

## Why I would choose it, and where I would not

For a contractor repeatedly comparing suppliers, I prefer having one identifiable
request revision, declarations, scoped offers, visible unknowns, review boundaries,
receipts and sourced comparison together. AI assembled the
Riverside explanation, and the second layer produced a reusable
calculation tool I could run. I prefer this to reconstructing business state from messages and a sheet;
I have not measured time saved.

For a supplier serving buyers already using this workspace, I prefer its received
scope, private costing and exact submitted offer record. For a supplier answering
one occasional enquiry, I would still choose email: creating an account and filling
structured declarations may exceed the benefit. I would not replace Teams, Slack
or WhatsApp as general conversation tools, or claim this deployment has proven
production-channel interoperability. My choice is a supervised quotation system
with existing communication channels and verified calculations.

## Reproduction and scope

From repository root, browser driver:
`ROLE=contractordemo ACTION_FILE=<action.js> SHOT=<name> node docs/work/evidence/independent-final-2026-09-26/browser-inspection.mjs`.
Per-action code/timestamps: `executed-actions.jsonl`; named action scripts sit alongside.
Private sessions stay in ignored `tmp/product-evidence/independent-final-2026-09-26/`.
Use demo role buttons or fresh fictional accounts. Never replay writes against
other people's records. Corrected exploratory locator timeouts were evaluator
errors, not product failures.

I did not re-execute bilateral award/colleague signoff, fulfillment, every parser,
batch retry or protocol service.
Separate functional evidence does not count as my own hands-on observations. No product source, deployment, global settings,
real external messages or commits were changed by this evaluator.
