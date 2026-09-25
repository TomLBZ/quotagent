# Independent public review: ingestion and plugin workspace
<!-- budget: 6000 bytes, hard -->

Reviewed [the public application](https://novara.remoteblossom.com/quotagent/) on
2026-09-25, using separate contractor, supplier and administrator browser sessions
at 1440×1000. This is a task-based product judgment, not a timed competitor benchmark.
The reviewer contributed backend implementation earlier; this assessment uses its
own sample and browser observations rather than the acceptance scripts' verdicts.

**I would choose Quotagent over conducting this quotation task entirely in email,
Teams, Slack or WhatsApp.** The useful difference is the continuous path from an
actual attachment to editable, account-owned line items and a private business draft.
Message, extracted scope and next action remain together. Messaging still helps
collect material and contact people outside the application.
This does not assess competitors' integrations or extensions.

## Observed task and result

- Contractor: uploaded a private EML containing a CSV attachment. Without retyping,
  the application extracted 24 brass valves at USD 18.50 and six gauges at USD 31.25.
  Source text retained the message and attachment; its tab offered a download. Created and opened an unpublished RFQ draft
  containing the two descriptions, quantities and units. Supplier offer prices did
  not become requested RFQ prices. No invitation or external commitment was sent.
- Supplier: its document library did not contain that contractor upload. A separate
  private CSV displayed quoted unit price 1.95 alongside private unit cost 1.20,
  incoming-RFQ selection, per-row scope matching and reviewed offer currency.
  The screen explains that currency/unit conversion is manual. I inspected this
  preparation step; I did not submit a quote or create a supplier draft in this review.
- Client configuration: Plugin settings is directly reachable in navigation.
  AI connection, assistant preferences, uploaded files and document ingestion each
  have their own settings. Opening the connection form showed a blank credential
  input with configured-state guidance. I made no configuration changes.
- Administrator: the catalog listed 18 runtime entries, including platform services,
  the model provider and five ingestion engines. WebUI Configure opened the actual
  refresh-interval/request-size form. The historical mail entry clearly said
  “Repository only,” explained its difference from current email ingestion, and
  offered no enable button. No lifecycle control was changed by this reviewer.
- Marketplace: inspected installed entries with Manage/Enable controls and source
  details. Installed state was understandable. A marketplace full of themes alone
  would not establish quotation value; reusable business utilities and workflows
  are the more consequential customization opportunity.

The successful email-to-draft step used traditional parsing. I do not attribute
that result to AI. “Extract with AI” and “Discuss with AI” are positioned beside the
source, which is a useful entry point for irregular documents and unresolved scope.
This pass did not invoke a fresh model response or re-evaluate generated code.

## Friction and limits

The material usability issue is editing width. With the document library and
persistent assistant visible, the supplier's 587-pixel table had only 482 pixels
available. The private-cost column required horizontal scrolling; descriptions and
RFQ choices were also truncated. A collapsible library/assistant or expanded review
mode would reduce mistakes when checking scope, price and cost together. The workflow
remained usable, but this deserves priority over more cosmetic themes.

Some source/target wording still needs human matching: my “RJ45 outlet with faceplate”
was not automatically selected against differently worded RFQ scope. The explicit
matching control makes that uncertainty visible. This is preferable to inventing a
match, but users should expect review work rather than one-click import of every offer.

This is an exported-file workflow, not a connected inbox. The page explicitly warns
that scanned PDFs require OCR before upload and legacy Word .doc is unsupported.
No automatic foreign-exchange/unit conversion was observed or implied. Those limits
make email a continuing intake channel, while Quotagent becomes the working surface
for review, private costing and preparation. No browser JavaScript error was recorded in these sessions.

## Evidence and implementation sources

Browser observations, timestamps and nine screenshots are in the packaged
[review report](independent/report.json).
Key views: [email-to-items](independent/01-contractor-email-to-items.png),
[private RFQ](independent/03-contractor-private-rfq.png),
[supplier review](independent/04-supplier-scope-and-private-cost.png),
[runtime catalog](independent/07-admin-runtime-catalog.png),
[historical mail](independent/08-admin-historical-mail.png).
An initial automation selector mismatch on the currency field was corrected without
a product change; the resumed review completed.

Relevant sources: [ingestion flow](../../../../src/domain/ingestion/code/index.mjs),
[review UI](../../../../src/domain/ingestion/client/ingestion.jsx),
[account file storage](../../../../src/system/file-store/code/index.mjs),
[private/public quote separation](../../../../src/domain/procurement/code/service.mjs),
[settings](../../../../src/system/settings/code/index.mjs),
[runtime inventory](../../../../src/system/plugin-manager/code/index.mjs),
[studio ownership and configuration](../../../../src/system/plugin-studio/code/product.mjs).
