# Selected quotation preparation and per-item human decisions
<!-- budget: 4096 bytes, hard -->
Owners: [procurement preparation](../../../../src/domain/procurement/requirements/submission-batches.md)
and [action-center execution](../../../../src/system/action-center/requirements.md).
Retained SUPPLEMENT-019; ADR0053. Executed 2026-09-26.

- `node src/domain/procurement/tests/submission-batches.mjs` — [four native groups
  PASS](native.json), actual Cordis/Ledger/QEP and team authority. A supplier colleague
  prepares two valid, one stale and one unavailable quotation; each has an independent
  durable receipt in the business realm with the real author. Matching pending reviews
  are reused. After one draft changes, explicitly approved generic batch sends one
  unchanged quote and refuses the other frozen input. Fresh failed-only preparation
  and review send the edited quote without repeating the success or sharing cost.
  Real remount preserves preparation history and the failed/succeeded action outcomes.
- `node src/domain/procurement/tests/submission-batches-browser.mjs` — [four GUI groups
  PASS](gui-local.json), zero JavaScript errors. Fresh supplier/contractor accounts create
  three authored requests and private quotes entirely through GUI. Amendment makes
  one draft stale; multiple selection produces two exact reviews and a visible error.
  Repeating selection reuses reviews. Both selected action previews show business
  recipients and prices, with raw detail hidden. Editing one draft before explicit
  two-action confirmation produces real mixed execution. Only the failed draft is
  prepared again, inspected with its changed terms and separately submitted. Contractor
  receives both actual offers, with no private cost; history survives navigation and
  the narrow layout stays within its viewport.
- `npm --prefix host run build -- --outDir /workspace/projects/quotagent/tmp/agent-experience/rfq-build`
  — PASS, 114 modules. Existing bundle-size advisory remains.

Raw GUI receipts and nine screenshots: `tmp/product-evidence/quote-submissions/local`.
Selected [readable batch review](readable-batch-review.png), [mixed receipts](mixed-receipts.png),
[mobile history](mobile-history.png). Server8645 was an isolated native test application;
these checks do not claim public deployment or autonomous commitment.

Earlier harness runs hit renderer crashes under the container's actual 8GiB cgroup
limit (`memory.events` recorded OOM kills, despite larger host-reported free RAM).
After stopping verified stale local test servers, the complete journey passed.
Viewport evidence avoids unnecessary large history rasterization. No product rule or
business verification was disabled to obtain this result.

A bounded read-only follow-up reopened the final GUI account after the small receipt
label refinement: [failed-item navigation PASS](failed-item-navigation.json). The
failed row shows its authorized request title and opens the exact stale quotation
with Prepare rebid available; no business API writes were used. The reusable main
browser script now also asserts the named failed row and its Open quotation control.
