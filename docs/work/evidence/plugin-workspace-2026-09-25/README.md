# Plugin workspace and ingestion acceptance
<!-- budget: 8192 bytes, hard -->

Verified 2026-09-25 at [the public application](https://novara.remoteblossom.com/quotagent/).
Functional commits through `eea444e`; later commits package these checks and documentation.
Scope: [five follow-up requirements](../../../product/plugin-workspace-contract.md).
All product mutations in the public journeys use visible GUI controls. Login, uploads,
model-generated theme, color/config edits, lifecycle actions and imports are exercised.
A final [settings-dialog check](studio/schema-guidance-report.json) verifies the personal
endpoint/API-key guidance is visible. Private demo records are retained; ingestion does not publish or submit them.

| Acceptance | Result and evidence |
|---|---|
| Studio does not flash or duplicate extension lineages | PASS: 18 seconds through refresh; zero removed grids/loading frames, identical grid/dialog nodes and input focus. One lineage card with selectable scoped instances; disabled personal copy falls back to global. [Public report](studio/report.json) |
| Marketplace recognizes installation | PASS: owner/personal/global state, Manage instead of Install, repeated customization reuses the existing personal ID. [Installed card](studio/02-marketplace-installed-state.png) |
| Admin sees all application plugins | PASS: 18 native/child runtime entries, including WebUI/provider/assistant, file/config services and five engines. Historical mail is repository-only. CSV disable removes its client parser choice; re-enable restores it. Studio re-enable works through its independent manager page. [Inventory after restart](admin-after-restart.png) |
| Configurations are editable and persistent | PASS: color picker changes live theme; per-account timeout persists; untouched fields retain inheritance; credentials masked. Real Cordis provider check proves personal endpoint/key behavior. [Theme](studio/01-theme-color-configuration.png), [provider scope](ai-credential-review.json) |
| File ingestion supports real source material | PASS: public email+Excel attachment, CSV mapping, DOCX, text PDF, mixed-sheet Excel and empty-attachment recovery; actual AI extraction with source excerpts. [Public observations](ingestion/observations.json) |
| Contractor and supplier workflows | PASS: email→AI→private RFQ; Excel→matched private quote at **$3,156**, Net 30, 12 days and private cost. Currency/unit mismatch refused until explicit correction. [RFQ](ingestion/03-private-rfq-draft.png), [quote](ingestion/05-private-quote-draft.png) |
| Mobile and restart | PASS: 390px viewport, 286px instructions field, button below textarea, no page overflow. Four public accounts retain settings, extension IDs, marketplace state, file hashes, parsed/imported records and native/engine availability after server restart. [Mobile](ingestion/mobile.json), [restart](restart-after-report.json) |

Studio journey: **26 checks, zero browser errors**. Ingestion journey: six scenario groups,
11 screenshots, zero browser errors. [Independent review](independent-review.md) separately
assesses usability and advantages over chat/email; it is not a required favorable verdict.

## Reproduce

From repository root with installed host dependencies and the running public demo:

```sh
BASE_URL=https://novara.remoteblossom.com/quotagent EVIDENCE_DIR=tmp/product-evidence/plugin-workspace/public node tools/product-plugin-workspace-e2e.mjs
BASE_URL=https://novara.remoteblossom.com/quotagent/ EVIDENCE_DIR=tmp/product-evidence/ingestion/public node src/domain/ingestion/tests/browser.mjs
node tools/product-plugin-restart-check.mjs before
/workspace/bin/ws-gateway restart quotagent
node tools/product-plugin-restart-check.mjs after
```

Restart comparison reads public account-visible APIs after GUI login/navigation. It
compares all captured configuration, extension and ingestion state; transient Cordis
fiber UIDs and JSON object key order are not persisted product identities. The two
reports show 18 runtime entries; contractor 13 parsed documents/10 files, supplier 3/2,
and supplier2 0/0. The complete masked snapshots stay in local `tmp/`; reports are
[before](restart-before-report.json) and [after](restart-after-report.json).

Focused executable checks and recorded outputs:

| Command | Output |
|---|---|
| `node src/domain/ingestion-engines/tests/parsers.mjs` | [16 real-format fixtures](ingestion-parsers.json), including binary XLS/MSG and real DOCX/PDF |
| `node src/domain/ingestion/tests/smoke.mjs` | [Real Cordis and Python ledger](ingestion-smoke.json): account ownership, private drafts, mismatch refusal, mixed headers, empty attachment and disposal |
| `node src/system/plugin-manager/tools/lifecycle-check.mjs` | [Actual fibers](plugin-manager-lifecycle.json): native/child inventory, dependency checks, dispose/remount and persisted disable |
| `node src/system/plugin-studio/tools/lineage-check.mjs` | [Lineage regression](studio-lineage-review.txt): startup retirement, fallback, configuration remount and concurrent loads |
| `node src/system/settings/tools/provider-scope-check.mjs` | [Dummy endpoint request evidence](ai-credential-review.json): effective credentials, reset, blank/clear behavior and no credential in views/ledger |
| `npm --prefix host run build` | PASS, Vite 8.3.1, 28 transformed modules |
| `tools/verify.sh docs` | PASS, document budgets and IDs (edited links checked separately) |

The public AI cases use the configured provider; the focused credential test deliberately
uses a local dummy endpoint and is not claimed as live AI. Traditional parsing remains
usable without AI. Scanned-document OCR, live inbox synchronization, legacy `.doc` and
RTF-only MSG are not implemented; accepted formats and limits are in the contract.
