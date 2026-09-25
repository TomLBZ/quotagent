<!-- budget: 8192 bytes, hard -->
# Independent public-product evaluation — 2026-09-25

Evaluated URL: https://novara.remoteblossom.com/quotagent/
Evaluator: an independent agent using the public UI before reading implementation; **not a human usability study**. No preference was prescribed. Contractor/supplier demo accounts were used alongside other agents. I created a draft and personal skill, but made no award and sent no negotiation. Read-only replay: 08:26:29 UTC.

## Would I choose it?

**For the small, structured two-supplier RFQ I actually tried, yes: I would prefer Quotagent to managing the quotation in email plus a separate comparison sheet, or in a Teams/Slack/WhatsApp thread.** Scope, offers, commercial differences and editable drafts were accessible together. The assistant did useful arithmetic and produced editable work. This supports my preference, not a prediction that people will switch.

**I would adopt through a bounded pilot.** For tenders arriving as spreadsheets, PDFs and email attachments, I would retain email/spreadsheets until intake and detailed export were verified with real documents. The inspected editor offers pasted-text intake; I found no file-import control. Export contains supplier totals/terms but no quoted lines. I would retain our messenger for general coordination. These are limits of the inspected UI, not claims about every extension. Sources: 06, 10, 19, 26–29.

## What I actually did

Evidence: [captured results](../work/evidence/product-2026-09-25/evaluation/). Names below identify browser `.txt` and available `.png` captures unless stated otherwise. Replay: `tools/product-evaluation-replay.mjs`.

| Task and reproducible UI route | Actual observation | Evidence |
| --- | --- | --- |
| Public entry → contractor demo → Overview; repeat at 390×844 | Clear role/workspace navigation and next actions. Mobile overview had document width 390 and viewport width 390. Initial demo had no active offer comparison; after the deployment update, Riverside examples were present. | `01-public-entry`, `02-contractor-home`, `15-mobile-overview`, `replay-summary.json` |
| Paste the Library brief into the assistant; Requests → Library → Edit draft | A private RFQ was created with exactly 120 panels and 20 battery packs. It retained delivery by 20 Nov 2026, left the unspecified quotation deadline empty, and flagged currency, dimming protocol, battery duration and delivery details. Both lines were editable. | `04-ai-brief-extraction`, `09-draft-detail`, `10-edit-existing-draft` |
| Ask the assistant to compare only that Library RFQ and recommend an award | It reported zero submitted offers, no invitations and draft status, and declined to name a winner. It explicitly separated the unrelated Community centre quote. | `14-ai-empty-offer-grounding` |
| Plugin studio → save a read-only quote-review workflow → Saved skills → Run skill | A persistent local skill appeared with Run, Disable, details and Publish controls. Running it against the Library context reported no offers and stopped comparison. The requested name `[Evaluation] Quote review checklist` became `RFQ Quote Review Checklist`; exact naming was not preserved. No market publication was performed. | `16-save-workflow-skill`, `17-skill-library`, `21-run-skill-result` |
| Supplier demo → Overview → Messages | Opportunities/orders and a project-linked conversation were visible, with recipient, message type and Send controls. The private Library draft was not shown as an opportunity. Sending/notifications were not tested. | `18-supplier-overview`, `19-supplier-messages` |
| Requests → `[Demo] Riverside office lighting` → Compare offers → expand both prices | Atlas: $5,292, 35 days, 100% advance. Summit: $5,532, 14 days, 30% deposit/70% after delivery. Both contained 120 panels and 24 sensors. UI identified the lower total and Atlas's lead/payment risks. | `24-two-supplier-comparison`, `26-line-prices` |
| Ask AI for exact totals, line prices, delivery, lead, payment and missing VAT/warranty, using only Riverside | Correct arithmetic: Atlas panels $4,776 + sensors $516; Summit $5,100 + $432. Atlas's $324 panel saving minus $84 sensor premium gives $240 net saving. AI kept VAT unknown, distinguished quote deadline from required delivery, and tied warranty statements to line descriptions/notes. No award was made. | `25-ai-grounded-comparison` |
| Export comparison | A real CSV downloaded: two suppliers, totals, currency, lead days, payment terms, risks and quote references. It did not contain the line-level price comparison. | `27-comparison-export.csv` |
| Atlas → Negotiate with AI → Review message | It prepared a targeted, editable negotiation with sensor price, payment and delivery requests. Review offered Keep draft and Send message separately. I did not send it; the request still showed Conversation 0 during generation. | `28-ai-negotiation`, `29-negotiation-review-form` |

Library prompt: “Create an RFQ draft only, labelled [Evaluation] Library lighting 20260925. We need 120 dimmable LED panels (600x600 mm, 4000 K, UGR<19) and 20 emergency battery packs. Deliver to Bristol library by 20 November 2026. Separate delivery and VAT. Ask suppliers for warranty length, lead time and substitutions. Do not send or publish. Extract the exact quantities and flag missing information.” Other exact prompts/responses are in the artifacts. Library record: `rfq-80ec3366-5f0`; Riverside record: `demo-contractor-demo-supplier-demo-lighting`.

## Gaps that affect my willingness to use it

1. **Negotiation needs substantive editing.** Initial analysis said changing payment “costs them little”; the draft called Atlas our “preferred source” and implied quick confirmation. After a deployment update, those statements disappeared on retest. However, the final draft still invented buyer constraints: sensors were “above the level we had allowed”, advance payment was “difficult for us to release”, and 35 days was “longer than we can comfortably programme around”. No corresponding budget, cash constraint or required delivery date was supplied. It also retained `[date]`. The separate review gate worked; I would edit before sending. Sources: 28, `29-negotiation-review-form-values.json`, `30-negotiation-retest`, `31-retest-review-form-values.json`.
2. **An edit originally invented a deadline; verified fixed.** Library said No deadline, but Edit draft populated 2026-10-09. I reported it and cancelled. After deployment, the field was blank and optional; saving unchanged preserved No deadline, quantities and draft status. Sources: 10, `22-fixed-blank-deadline`, `23-saved-blank-deadline`, `replay-summary.json`.
3. **Document intake needs a real-world trial.** Pasted briefs worked; file intake was not discoverable in the inspected controls. The CSV is a summary without quoted lines. Whether integrations/extensions close this gap is unverified. Sources: 06, 10, 27.
4. **The assistant presentation gets verbose.** Running the saved skill placed its long workflow instructions and a wide comparison table in the narrow chat history. Its factual result was useful, but scanning repeated runs was harder than scanning the main business view. The exact requested skill name was also lost. Sources: 16–17, 21.

## Reproduction and limits

From the repository root, run:

```sh
node tools/product-evaluation-replay.mjs
```

The Playwright replay logs in through the public demo button, reads Library edit fields, Riverside comparison and Saved skills, then captures mobile Overview. It does not mutate records or call private APIs. `replay-summary.json` records `deadline: ""`, `items: ["120", "20"]`, both offer totals/terms and equal 390px viewport/document widths. The earlier save only verified my Library draft deadline.

No time benchmark, human participants, large tender, arbitrary attachments or award/order/change lifecycle were tested here. Separate workflow tests do not mean I completed those steps. My preference is for the demonstrated quotation task with participating suppliers; broader adoption remains unproven.
