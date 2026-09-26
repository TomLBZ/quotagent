<!-- budget: 8192 bytes, hard -->
# Independent quotation-work rubric — 2026-09-26

This prepares hands-on evaluation, not a verdict or human study. Initial read:
HEAD `0d44e56` plus uncommitted batches; public `f2366a0` is not the new target.
Final observations must name the immutable public revision. Source/catalog state
is recorded in `snapshot.json`; no shared product source was modified.

## How I will make the decision

Compare the same contractor/supplier jobs a person would otherwise coordinate with
mail or Teams/WhatsApp/Slack and a comparison worksheet. Do not assign competing
products capabilities I have not checked. This session is not a timed comparative
trial: no invented minutes saved, productivity score, win-rate gain or universal
claim that one communication tool is better. Separate the quotation workspace
choice from the choice of message transport.

For each job, record: completed/blocked/untested; exact inputs and outputs; mistakes
or missing facts; manual correction/re-entry; where attention and another person
were needed; and the UI route/screenshot/record supporting the result. Record real
elapsed waits only when measured, without treating agent speed as human speed.

An unauthorized commitment, private cost/competitor disclosure, silent stale-source
acceptance, incorrect unflagged arithmetic, false delivery claim, lost edits or
duplicated effect after resume is a material failure. A catalog pass or unrelated
fixture is not a substitute for the affected public job. The final choice can be
positive, conditional or negative, and must identify the exact kind of work I would
move and the work I would keep elsewhere.

## Contractor jobs

| Job | Practical question | Public evidence needed |
| --- | --- | --- |
| Arrive and orient | Can I identify my workspace and next action without learning the architecture? | Fresh role home, Help/walkthrough, agent starter and manual path; layout choice persists; account sandbox is visibly distinct from live work. |
| Turn source into RFQ | Can an email/XLSX/PDF brief become reviewed quantities and scope without unsupported assumptions? | Original/source excerpt next to edited lines; missing unit/currency explicit; changed assumptions require new confirmation; scope/measurement/interfaces/deliverables/exclusions declare before publication. |
| Ask once and maintain a shared basis | Can I clarify scope, broadcast an answer, reuse an FAQ and amend a request without losing revision context? | Sender/recipients and exact source; supplier sees its addressed publication; amendment makes old quotes stale; FAQ applicability is shown, never silently imported as new fact. |
| Compare actual offers | Can I explain the decision, not just pick the lowest total? | Hand-check two different totals, tax/freight, alternatives, lead times, payment and unknowns; weights/FX/source age visible; private assumptions separated; AI cites actual offer revisions and does not invent budget or supplier economics. |
| Commit and fulfill | Can people finish the business in the GUI with clear responsibility? | Award intent → supplier confirmation → eligible independent reviewer → proposer signature/PO; sourced change, partial acceptance and invoice mismatch/correction; no hidden CLI or receipt-as-acceptance shortcut. |
| Follow up and hand over | Can I see who owes what, how long it has waited and what changed? | Coverage/deadline/promise source, reviewed reminder, assigned colleague, waiting reviewer and delivery status; deep link and reload preserve the intended object. |

## Supplier jobs

| Job | Practical question | Public evidence needed |
| --- | --- | --- |
| Understand the invitation | Is the current RFQ and delivered source clear while other bids stay private? | Own addressed request/version, clarified answers and attachments; no competitor roster, ranking, buyer estimate or other-party cost. |
| Prepare a defensible offer | Can my source schedule and private costing become a quote I can stand behind? | Editable imports, private cost/margin/capacity provenance; reviewed draft price application; declared tax, assumptions, exclusions, alternative lines and firm/indicative milestones; outgoing preview excludes cost/private notes. |
| Submit several offers reliably | Does batching remove repetition without hiding mistakes? | Select separate own drafts; one bad/stale item fails individually; inspect exact successful actions; human decisions and per-item receipts; retry does not resubmit a successful quote. |
| Revise and deliver | Can I react to an amendment or commercial negotiation with clear obligations? | Old basis flagged; deliberate revision/withdrawal; own authorization bounds; award-intent answer, PO acknowledgment, change confirmation and acceptance/invoice records use the agreed source. |

## Agent and cross-channel behavior

- Start a real configured-model task; pause/steer/resume/stop at meaningful stages.
  Reload while interrupted. Completed work must remain; uncertain effects must not
  be automatically repeated. Inspect a workroom plan, human question, separate
  reports and synthesis; saved memory must retain human provenance and be editable.
- Read actual recorded incoming mail/Telegram sources and attachment-derived items.
  For signed QEP email, distinguish editable message text, the unchanged signed
  commercial package, SMTP acceptance, QEP receipt and contractual acceptance.
  Use only local protocol services; do not imply real provider interoperability.
- Review MCP/A2A exact outbound input, returned source/result and task continuation.
  Show any manual refresh or configuration burden. Do not count mock text as remote
  execution. Removed services must retain readable results without active access.
- Inspect AI usage and Business measures with real recorded rows: known zero versus
  unknown, scope/denominator/date filters and source links. Structural completeness
  and local response cycles are not correctness or proof of business improvement.
- Check the critical forms on a narrow viewport, unsaved editor state, unavailable
  source/error explanation and a safe return from a copied link. A successful desktop
  screenshot alone is not a complete daily-work assessment.

## Substantiated current boundaries to carry into the verdict

These are declared scope limits, not newly invented unfinished requirements:

- Scanned/image-only PDFs need external OCR; encrypted PDFs need export; legacy
  `.doc` and RTF-only MSG bodies need conversion. Saved spreadsheet formula values
  are read without recalculation; complex PDF tables may need correction.
  Source: `src/domain/ingestion-engines/requirements/README.md:16`.
- Provider OAuth onboarding is absent; mail providers must permit IMAP/SMTP.
  Telegram is a bot channel, not personal-account login. A2A task updates require
  manual refresh and its OAuth/push features are not provided.
  Sources: `src/system/mail/requirements/product.md:19`,
  `src/system/telegram/requirements/README.md:32`,
  `src/system/agent-connections/requirements/functional.md:27`.
- Offline installation preserves the shell, not business data or unsent edits.
  This intentionally supersedes historical private offline editing and matters to
  site work with unreliable connectivity. Source:
  `src/system/webui/requirements/offline.md:10`; catalog `NFR-UX-004`.
- ERP is CSV staging; FX/reference rates and capacity are declared observations,
  not automatically refreshed connected enterprise systems. Source:
  `src/domain/commercial-workbench/requirements/README.md`.
- The host and installed native plugins are trusted. Current ledger/QEP versions
  have explicit support boundaries, not arbitrary historical/mixed-version rollout.
  Source: `docs/design/adr/0055-native-host-and-version-support-boundaries.md`.
- Model latency and every-event durable-write targets remain measured assumptions;
  Business measures expressly avoids causal productivity claims. Sources: catalog
  `NFR-PERF-002/004`; `src/domain/response-workbench/requirements/business-measures.md`.

The public trial will determine which limits matter and whether defects remain.
