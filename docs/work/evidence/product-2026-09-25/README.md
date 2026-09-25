# Agentic product acceptance — 2026-09-25
<!-- budget: 8192 bytes, hard -->

Public URL: https://novara.remoteblossom.com/quotagent/
Final tested product runtime: `fd506e08f537b137d88e6adcaf5b6ce67711787b`.
Browser: Chromium headless via Playwright, separate account contexts, real public
HTTPS gateway, desktop and 390px mobile. State-changing browser checks use visible
UI controls. Generated data is labelled Demo, Public check or Evaluation. Real model
calls use the configured DeepSeek provider; no mock responses or scripted AI text.

## Results and reproducible commands

Run from the repository root after `./run up`. The public service here is managed by
`/workspace/bin/ws-gateway`; its restart and public health were verified. Browser
scripts accept `BASE_URL`, `EVIDENCE_DIR` and `CHROMIUM_PATH`. The recorded environment's
Chromium executable is the default in the scripts; set `CHROMIUM_PATH` elsewhere.
Scripts that create work intentionally leave labelled demo records for inspection.

| Command | Executed result | Evidence |
|---|---|---|
| `npm --prefix host run build` | PASS: React/Vite production assets built after final RFQ form change | [client configuration](../../../../src/system/webui/client/vite.config.mjs) |
| `node src/domain/procurement/code/smoke.mjs` | PASS using real Python Ledger/QEP: two recipients, private costs/preferences, precise totals, draft edits/revisions, award/ack/change, idempotency, native effect disposal, built-in demo initialization and zero events on remount | [smoke source](../../../../src/domain/procurement/code/smoke.mjs) |
| `node tools/product-e2e.mjs` | PASS, 14 checks, 08:28:32–08:28:40 UTC: create/publish RFQ, quote 2,125.00, human award/PO, supplier acknowledgment, approved change → 2,200.00, message, separate admin, mobile, zero page errors | [raw business journey](public-business.json) |
| `node tools/product-agent-e2e.mjs`; selector correction then `RESUME=1 node tools/product-agent-e2e.mjs` | PASS: new account, actual preference tool, AI-extracted two-line draft, human publish, remembered Net30 after reload, supplier AI draft from authorized prices/costs → 764.00, human submit, buyer receipt, role settings persist | [raw AI journey](public-agent.json) |
| `node tools/product-studio-e2e.mjs`; `STUDIO_RECHECK_SKILL=1 node tools/product-studio-e2e.mjs` | PASS: account-scoped theme/disposal, publication/install, admin global promotion/disposal, generated JavaScript returns136.5 then100, source review, saved skill runs with Riverside facts; final supplier response rejects unsupported competitive ranking; zero page errors | [raw studio journey](public-studio.json) |
| `node tools/product-evaluation-replay.mjs` | PASS: read-only replay of independent evaluator's draft, blank deadline, two offer values, saved skill, mobile width390 | [replay summary](evaluation/replay-summary.json), [independent report](../../../product/evaluation.md) |
| `tools/verify.sh docs` | PASS:667 IDs,166 FR,135 AC. A fresh copy also passes with local handover/progress/goal/state absent | [fresh-copy output](docs-recovery.txt) |

AI journey originally encountered browser selector mismatches (model-normalized item
wording, title targeting and Settings outside the main nav); these were corrected,
then the same created account/records were resumed. No product success is inferred
from a failed script. The raw final report retains its accumulated observations.

Earlier narrow real-provider utility checks also verified a generated landed-cost
function at1,235.85 and441.00, per-caller workspace reads, publication/install/promotion,
and removal of both callable/UI effects on unload. Command:
`node src/system/plugin-studio/tools/live-utility-check.mjs`; local raw output
`tmp/product-evidence/generated-utility-live.json`. This supplements public UI evidence.

## Independent preference and resolved findings

The fresh-context evaluator preferred Quotagent over email plus a comparison sheet,
or Teams/Slack/WhatsApp threads, **for the structured two-supplier quotation actually
tried**. It cited connected scope, accurate line arithmetic, commercial comparisons
and editable negotiation drafts. This is an agent evaluation, not a human study or
a timed productivity benchmark. See the [full report](../../../product/evaluation.md).

Findings led to shipped fixes: built-in demo accounts now start with comparable
labelled offers; editing a draft preserves a missing deadline; suppliers no longer
receive competitive rank/savings calculated from their own quotes alone. Independent
retest verified the deadline correction. The final saved-skill response explicitly
states that rival bid ranking cannot be inferred from its own quote.

## Material limits observed

- Negotiation suggestions can still invent buyer negotiating constraints or leave
  placeholders. The evaluator kept the draft unsent and identified wording to edit.
- One existing saved skill still described today's date as unavailable despite the
  recorded current UTC time in model context. See `skillRecheckFinal` in studio JSON.
- Pasted text intake was verified; document OCR, external inbox sync and scheduled
  skills are not part of this composition. CSV export summarizes offers, not all lines.
- Long assistant replies are less scannable than the business views. One generated
  skill did not preserve the user's exact requested name.
- Generated utility code is a bounded pure function; arbitrary server integrations
  and frontend dependencies are outside its surface. Runtime publication is not a
  guarantee that a generated formula is correct for every input.

## Selected public screenshots

[Two-supplier comparison](comparison.png) · [Grounded AI comparison](agent-comparison.png)
· [Actual generated utility](generated-tool.png) · [Mobile workspace](mobile.png).

Numbered evaluator text/CSV artifacts are preserved in [evaluation/](evaluation/).
Browser session cookies are excluded. Full local screenshot sequences remain under
`tmp/product-evidence/`; tracked reports are the durable acceptance summary.
