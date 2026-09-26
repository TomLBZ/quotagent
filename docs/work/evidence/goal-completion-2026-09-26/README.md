# Goal acceptance audit
<!-- budget: 8192 bytes, hard -->

This audit preserves both the September26 enhancements and the original product
brief. The [independent public evaluation](../independent-final-2026-09-26/assessment.md)
is complete, including correction and replay of its findings. Current public application: immutable
`3ab6d8cde6d2d05acb3a73403279fc9be579a15f`.

## Five enhancements

| Requested outcome | Source and authoritative observations |
|---|---|
| Pause, stop, resume and steer the operational agent | `src/system/agent-runtime/code/conversations.mjs` serializes controls, retains completed receipts and records guidance. [Actual-model public controls](../agent-experience-2026-09-26/controls-public.json) cover9 checks; native control evidence additionally covers queued races, account ownership and uncertain recovery. |
| Lower cognitive load through workspace-style plugin | `system/workspace-styles` owns persisted layout/palette/density and grouped navigation. [Current public three-role journey](../final-public-2026-09-26/styles-help.json) verifies7 groups, reload and390/1024px; [rendered workspace](../final-public-2026-09-26/agent-workspace.png). |
| Walkthroughs and role-specific documentation | `system/user-guide` owns first-run guidance and searchable Help; [four current-feature Help groups](../final-public-2026-09-26/current-help.json) and the three-role journey verify role-authorized destinations. Current written guides are `docs/product/{contractor,supplier,administrator,getting-started}.md`. |
| Visual provider token statistics | `system/agent-runtime` owns usage charts, account/admin scopes, filters and explicit unknown usage. [Public usage](../agent-experience-2026-09-26/usage-public.json) verifies5 groups; later [runtime journey](../integrated-public-2026-09-26/runtime.json) verifies budget and priced/unknown observations. Estimates remain distinct from invoices. |
| Consolidate documentation and complete compatible gaps | The [catalog](../../../requirements/catalog.json) retains323 original clauses,226 immutable sources and32 sole owners;159 obsolete documents have replacement routes. Current guides/design/owner contracts replace duplicate global specifications. [Public release evidence](../final-public-2026-09-26/README.md) covers21 journeys/100 groups plus actual generated-plugin evolution. All compatible functional clauses are closed with scoped proof. |

## Original product brief

| Brief items | Outcome and evidence |
|---|---|
|1,12 first AI layer: quotation advantages for both parties | Actual assistant, ingestion, specialist workroom, source-aware comparison, memory and reviewed communication have [real-model/protocol evidence](../connected-agent-2026-09-25/README.md). Current public [scope/negotiation](../final-public-2026-09-26/scope.json), [commercial](../final-public-2026-09-26/commercial.json), response and evidence journeys verify the connected business surface. The independent evaluator confirms its practical advantage within the stated scope. |
|2,13 reusable modern and reachable GUI | React controls/page contributions and grouped navigation live in `system/webui`; plugin-owned pages are composed in `host/client.mjs`. Dashboard, narrow views, role Help, direct source links and actual write workflows are exercised publicly. Orders and loading defects found during that check were fixed and successfully replayed. |
|3,5 every capability has a native plugin owner | `host/product.mjs` composes35 native plugins; the catalog assigns every clause to one of32 functional owners, including repository tooling. Disposable Cordis effects own UI/routes/tools/runtime contributions. [Process snapshot](process.json) records `npm view cordis version --json` returning the pinned `4.0.0-rc.10`. |
|4 business progress first | Completed actual native RFQ scope/terms/FAQ, alternative offers, private costing, negotiation, quote batches, independent PO authority, fulfillment, signed email recovery, response tracking and business measures. Historical gates that froze obsolete SSR/global-table forms were replaced under ADR0048. Evidence records outcomes and failures, not invented business improvement. |
|6 public end-to-end experience | [Per-run commands and revisions](../final-public-2026-09-26/runs.json) cover actual public GUI mutations. [Immutable release](../final-public-2026-09-26/release.json) and36-read copied-data preflight identify deployment and backup. No dirty shared source was deployed. |
|7 independent preference | The independent evaluator prefers supervised repeat multi-supplier quotation work here over reconstructing business state from email/chat plus a sheet, while retaining communication channels. Its own fresh workflow, both AI layers, limitations and corrected-release recheck are in the linked assessment. |
|8 remove obsolete designs without compatibility burden | Catalog dispositions preserve original text/hash/revision while removing159 obsolete documents. ADR0048/0055 explicitly replace old UI/specification and arbitrary historical/untrusted-host promises; compatible business outcomes retain current owners. |
|9 account role separation and separate administrator | Fresh contractor/supplier accounts carry the current public quotation journeys. Explicit same-party membership/switch, independent review and counterparty refusal are exercised in the scope/declarations reports. Admin manages actual native fibers, scoped configuration and metadata without client-private bodies. |
|10,11,14 progress, docs and recoverability; separate commits/pushes | [Process snapshot](process.json) records individually named functional batches, normal push/read-back equality, ignored recovery files and handover byte budget. Rules link current architecture/catalog, role guides and owner contracts; recovery state retains next action and deployed process/data paths. |
|12 second AI layer: self-improvement and sharing | [Actual generated utility/revision](../final-public-2026-09-26/evolution/combined.json) records6→9 paired outputs, human review, bounded trial/rollback/restore, independent marketplace copy and both copies executing with Studio disabled. Themes/widgets/skills and independent global promotion have separately scoped native/public evidence in the catalog. Generated server/kernel mutation and unattended scheduled skills are not promised. |

Local protocol services were used first, as requested. Current SMTP/IMAP/QEP public
checks never forward to external recipients; MCP/A2A/Telegram evidence retains its
declared local-fixture scope. Live model cases are distinguished from fixtures.

Two historical numerical targets remain explicit unproven assumptions: every durable
append within5ms (measured maximum9.40ms, p953.08ms) and every real provider call
within60s. Supported timeout/budget controls are implemented. No unverified latency,
production-provider interoperability, causal productivity or quotation-win claim is
converted into a pass. OCR, OAuth onboarding, private offline editing and live ERP/FX
feeds remain the documented scope boundaries rather than hidden completion claims.

Final catalog disposition:277 verified,44 explicitly superseded,2 numerical
assumptions; no pending or merely implemented functional clauses.
[Documentation check](docs.json) validates provenance/links/budgets; the linked
functional reports establish behavior. Independent review found a wrong model
deposit and a long supplier picker. The source-bound exact calculator and shared
arithmetic guidance, plus preserving supplier search, were separately committed
and independently rechecked on3ab6d8c. The original failure remains visible.
