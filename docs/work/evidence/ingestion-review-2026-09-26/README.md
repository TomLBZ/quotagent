# Source assumptions and missing-detail questions
<!-- budget: 4096 bytes, hard -->

Owner: [ingestion](../../../../src/domain/ingestion/requirements/README.md).
Retained clauses FR-INTAKE-001/002/003 and CURRENT-013 preserve source-linked
editable extraction rather than treating an uncited model or manual addition as fact.

Executed 2026-09-26:

- `node src/domain/ingestion/tests/smoke.mjs` — PASS8 groups using actual native
  Cordis, Python ledger and file parsers. [Result](native.json). Missing quantity
  and unit produce questions; fabricated source excerpt remains an assumption;
  unconfirmed import creates no RFQ; explicit human confirmation permits a private
  draft; changing quantity invalidates it. Exact questions and confirmation are
  reconstructible from the ingestion ledger record.
- `BASE_URL=http://127.0.0.1:8660/quotagent/ node src/domain/ingestion/tests/review-browser.mjs`
  — PASS3 groups, zero JavaScript errors. [Result](report.json). Fresh contractor
  account uploads a real CSV, resolves missing values, adds an uncited item,
  observes the explicit refusal, confirms and edits/reconfirms, reloads, then creates
  a private draft. All writes use GUI controls. Document selection now survives
  reload through its declared deep-link key. Settled390px layout inspected.
- `npm --prefix host run build -- --outDir /workspace/projects/quotagent/tmp/agent-experience/ingestion-review/assets`
  — PASS108 modules.

Screenshots: [questions](01-private-source-questions.png),
[assumption](02-unconfirmed-assumption.png), [confirmation](03-exact-value-confirmation.png),
[mobile draft](04-mobile-reviewed-draft.png).

The first reload check exposed missing selected-document URL state; this was fixed
in the owning page and rerun. An immediate viewport screenshot captured the drawer
transition; final evidence waits for the drawer to settle. No external questions
were sent. The fixture does not measure live model extraction accuracy. A source
reference indicates a row or exact excerpt exists; humans still compare edited
values with it. Public acceptance remains a later integration step.
