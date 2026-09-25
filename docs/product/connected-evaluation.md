<!-- budget: 6144 bytes, hard -->
# Connected-product independent evaluation — 2026-09-25

URL: https://novara.remoteblossom.com/quotagent/

Independent agent evaluation, not a human study. I did not implement this work. I inspected the public contractor/supplier2 GUI and existing records, without sending, approving, changing settings or touching runs. Other tests ran concurrently; fixture connections/credentials and memories were deliberately removed/archived during inspection.

## Preference

For organizing and assessing a multi-supplier quotation, **I would choose Quotagent over relying on Mail, Teams, Slack or WhatsApp alone**. It connects source attachments, editable items, quoted terms, specialist findings, human answers and reviewed actions. The completed Riverside run exposed a decision conflict: the cheaper quote saves $240 but has a 35-day lead and full prepayment; the 14-day offer needs a decision before the tender closes to meet the buyer's stated date. That is useful quotation support. Sources: 07, 19, 21, 25–27 below.

**I would start a supervised quotation pilot and retain existing communication tools.** Production provider reliability and real supplier adoption remain unproven. SMTP, Telegram, MCP and A2A traffic demonstrated here used local protocol fixtures only. No live Gmail/Outlook/Telegram service or independent remote agent provider was tested in this evaluation.

## What I personally inspected

Evidence root: `tmp/product-evidence/connected-independent/`. Numbers identify the matching `.txt` and `.png` captures; field values are also saved as JSON where needed. I inspected these records; I did not initiate their execution.

| Public GUI route | Observed result | Evidence |
| --- | --- | --- |
| Contractor → Email → Riverside cabling offer | Received source, sender/time, 12-day lead and net-30 text, downloadable `cabling-offer.xlsx`, Reply and Extract controls. | 10 |
| Ingest documents → cabling-offer.xlsx | Original/source-review interface and two editable rows: 1,500 m CAT6 at 1.8; 48 outlets at 9.5. Private RFQ creation is a separate action. | 23, 25, `25-extracted-values.json` |
| Email → Drafts → untrusted-source reply | Existing draft requests missing currency, carriage, VAT, scope and validity rather than accepting the offer. The source explicitly tries to bypass approval and inject memory; its instruction is reported as untrusted in the workroom. | 24, 31, 07 |
| Telegram → Fixture supplier | Received text, CSV attachment and an existing fixture reply are retained with direction/time; sent reply links to its review. | 13 |
| Review actions → All activity → MCP call | Approved exact payload contains only quantity 30, unit price 80 and freight 120; receipt returns 2520 and the loopback source. | 19 |
| Review actions → A2A task/reply | Reviewed London reply retains task/context IDs; completed artifact says freight 120 USD. A separate working task and cancellation receipt also remain in history. | 20, 26, 09 |
| Review actions → sent email | Exact recipient/body and approval state are readable; SMTP receipt says `250 Fixture accepted`. This proves fixture acceptance, not internet delivery. | 21 |
| Agent workroom → Riverside lighting run | Complete, three specialist reports, recorded tools, human delivery-date question/answer and reconciled decision brief. It uses 15 Oct, separates tender close from delivery, computes deposit exposure and flags unknown scope/tax. | 07 |
| Agent workroom → Account memory → Archived | Net-30/full-prepayment preference, human provenance and revision history remain visible. The completed run cites that preference; it was later archived during cleanup. | 22, 32, 07 |
| Supplier2 → Requests → Riverside lighting | Only Atlas's $5,292 offer appears under My quotes. Contractor mailbox/connection contents were absent from this supplier's inspected pages. This is a GUI observation, not an authorization audit. | 15, 17–18, 27 |
| Mobile at 390px | Email and workroom stayed within the viewport, with no page-wide horizontal overflow. | 33–34, `34-mobile-widths.json` |

Prior implementation-team evidence, also reviewed: `tmp/product-evidence/agent-connections/public/a2a-completed.png` shows the discovered agent and completed freight artifact; `public/report.json` records discovery/resource/prompt/task checks. `public-ai/report.json` records the live-model MCP proposal and approved 2520 result. I did not recreate those removed connections. Current receipts corroborate their results; endpoints were `127.0.0.1:8621`, not third-party services.

## Remaining friction and verification boundary

- Fixed during review: supplier2's cancelled run retained one Working specialist (28, 30). After deployment, all four tasks read Cancelled and the history appended Cancellation Reconciled (35). I verified the repaired old run; I did not trigger new cancellation races.
- Fixed during review: a removed connection's historical result link was empty (29). Retest shows Removed, cleared remote access, recorded MCP 2520 and completed A2A 120 USD; no remote-operation controls are offered (36–37).
- Remote-action review is much more technical than email review: endpoints, IDs and large JSON payload/result blocks dominate the view. A concise business summary above expandable details would make reviewing the three outbound numbers and returned total easier. Sources: 19–21, 26.
- The completed run is useful but verbose: the long plan, repeated reports and unrelated source warnings make the 31-record page hard to scan. The synthesis is the part I would return to; I would prefer its short outcome and required decisions first. Source: 07.
- Document limitations remain explicit in the UI: scanned PDFs require OCR before upload and legacy `.doc` is unsupported. I did not test arbitrary documents, sustained provider outages, real supplier onboarding, mobile sending or execution without supervision. Source: 23; evaluation scope above.
