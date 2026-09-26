# Explicit publication and reusable source declarations
<!-- budget: 6144 bytes, hard -->
Owner [procurement public declarations](../../../../src/domain/procurement/requirements/public-declarations.md),
ADR0053. Retained FR-RFQ-002, DOMAIN-002/003, FR-DEV-002 and SUPPLEMENT-031.
Executed 2026-09-26; all tests use native Cordis and actual Ledger/QEP.

- `node src/domain/procurement/tests/public-declarations.mjs` — [four groups PASS](native.json).
  Incomplete new publication refuses before approval; human-authored scope and policy
  marker roundtrip. Alternative + additional offer follows supplier confirmation,
  independent reviewer grant and actual signed PO. Named firm milestones and separate
  assumptions/exclusions survive source fingerprints and exchange. Valid firm promise
  changes by an agent refuse. Structured FAQ candidate, allowed keys, human publication,
  exact read-only lookup, empty mismatch, explicit private adaptation, deprecation and
  real store remount preserve source references and realm isolation.
- `node src/domain/procurement/tests/public-declarations-browser.mjs` — [five GUI groups
  PASS](gui-local.json), zero JavaScript errors. Three fresh accounts author exact scope,
  alternative + additional offer and firm milestone, set reviewed colleague authority,
  independently sign a PO, then exercise structured FAQ publication and changed-scope
  adaptation. All business writes use visible controls. Raw ten screenshots and HTTP
  receipts: `tmp/product-evidence/public-declarations/local`.
- `EVIDENCE_DIR=tmp/product-evidence/public-declarations/paired node src/domain/procurement/tests/paired-party-browser.mjs`
  — [four GUI groups PASS](gui-paired.json), zero JavaScript errors. Two independent
  native application processes explicitly pair through their GUI; declared RFQ/version
  and reverse quote arrive over HTTP QEP with signed applied receipts. Supplier private
  cost and preparation defaults are absent from the recipient's projection.

Regression commands, all PASS with explicitly authored fixture scope:

| Command under `src/domain/procurement/tests/` | Groups | Output |
| --- | ---: | --- |
| `node structured-scope.mjs` | 5 | [Scope](scope-regression.json) |
| `node terms.mjs` | 4 | [Terms](terms-regression.json) |
| `node negotiation.mjs` | 5 | [Negotiation](negotiation-regression.json) |
| `node context-defaults.mjs` | 5 | [Defaults](defaults-regression.json) |
| `node request-collection.mjs` | 3 | [Collection](collection-regression.json) |
| `node fulfillment.mjs` | 6 | [Fulfillment](fulfillment-regression.json) |
| `node rfq-lifecycle.mjs` | 4 | [RFQ lifecycle](rfq-regression.json) |

`node src/domain/ingestion/tests/smoke.mjs` — [eight groups PASS](ingestion-regression.json):
import remains private, with explicit human-authored scope before fixture publication.
`node src/domain/procurement/code/smoke.mjs` — PASS, full actual QEP/two-party source
flow, private drafts/costs, exact totals, version supersession, independent order/change,
demo replay and effect removal (raw root `tmp/procurement-smoke-HfgJAr`).
`npm --prefix host run build -- --outDir /workspace/projects/quotagent/tmp/agent-experience/rfq-build`
— PASS, 114 modules. The existing large-bundle warning remains advisory.

Screenshots: [signed PO declarations](signed-order.png), [content-free FAQ mismatch](faq-mismatch.png).
All declarations were authored fixture inputs; these checks do not claim automatic
extraction quality. Existing historical published records remain honestly unknown,
and these local checks do not claim public deployment. The manual-outage fixture now
pauses every outbound record in that decision: pausing only its order allowed QEP's
valid missing-sequence recovery to deliver it during later automatic fact transfers.
