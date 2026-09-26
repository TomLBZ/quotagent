# Native action review provenance
<!-- budget: 8192 bytes, hard -->

2026-09-26 local evidence for FR-UX-001 / NFR-UX-002; ADR-0051 defines captured
references and their limits. Native owner: `src/system/action-center`. Procurement
supplies its own source labels/navigation and existing comparison/term flags from
`src/domain/procurement/code/index.mjs`; WebUI has no business collection mapping.

| Command | Observed result |
|---|---|
| `node src/system/action-center/tests/provenance.mjs` | Five groups PASS, preserved `action-review-provenance/native-report.json`; original `tmp/review-provenance-pu0tbI/report.json`. |
| `node src/system/action-center/tests/state.mjs` | Existing nine groups PASS: account credentials, idempotent execution, review gates, durable notifications, delegated/external tools, uncertain recovery and post-send notification failure. |
| `node src/system/action-center/tests/independent.mjs` | Existing seven groups PASS; Console output records data root `tmp/independent-actions-h6sibA`, 117 events and two fixture deliveries. Separate grant/sign, authority/scope/role, batches and recovery remain intact. |
| `node src/system/action-center/tests/provenance-browser.mjs` | Three groups PASS, five screenshots, zero JavaScript errors; preserved `action-review-provenance/browser-report.json`. Base `http://127.0.0.1:8650/quotagent/`. |
| `npm --prefix host run build -- --outDir /workspace/projects/quotagent/tmp/agent-experience/review-provenance-assets` | 103 modules passed. Existing large-bundle advisory remains. |
| `tools/verify.sh docs` and `git diff --check` | PASS. |

The real native ledger test captures a source event at revision1, changes the
business record to revision2 and separately alters the current review projection.
Inspection still returns revision1 from the original `actions/proposed` provenance,
not the newer business record or altered metadata. Arbitrary source keys, foreign
account actions, foreign realms, wrong record IDs and changed hashes refuse. Exact
input digest mismatch is explicit. Missing owner assessment, explicitly empty
flags and historical uncaptured references stay distinct. Native reload preserves
references and unload removes the read routes. These inspections execute no action.

The local browser journey used fictitious built-in demo participants. Its first
run created a nonbinding Atlas selection and supplier confirmation through visible
controls. The successful repeat reused that confirmed intent and prepared a new
unsigned order review through the ordinary GUI. It displayed the two actual
procurement flags: 35-day lead time and full advance payment. It opened the original
proposal event and exact quotation source, navigated to the source quotation,
reopened/reloaded the selected action ID and checked 390px width. No PO was signed;
no external mail/chat/model service was invoked. Repeated local attempts remain as
honest pending review history, rather than being rewritten as one attempt.

Screenshots `01-declared-risks-and-source-chain.png` and
`05-mobile-review-chain.png` are preserved alongside the reports. The other three
are in `tmp/agent-experience/review-provenance-browser/` and show the proposal event,
original quotation body and domain navigation. The test accepts `BASE_URL` and
`EVIDENCE_DIR`; public verification is a later release task.

The hash proves identity with local recorded content, not truth of an external
claim, independent remote verification, or exhaustive risk assessment. Other
proposal owners that omit upstream references or flags receive explicit missing
information labels. Current permission checks still apply when opening a captured
source, even if it was readable when the proposal was prepared.
