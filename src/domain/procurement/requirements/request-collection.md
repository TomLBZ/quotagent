# Requests collection and personal view
<!-- budget: 8192 bytes, hard -->

Owner: `domain/procurement`, consuming the generic WebUI collection contract and
ADR-0046. Retains large-list, per-column filtering, personal view and CSV outcomes
of supplemental requirements 002/021 and WebUI GUI sections 9/14/20.

The Requests page queries collection `requests` using only the caller's authorized
procurement snapshot. Rows expose request identity, title, brief, project/section,
owner label, status, quote deadline, currency, line count and current offer count.
Current offers are submitted/awarded quotations for the current RFQ revision;
drafts and superseded/withdrawn/stale quotations are excluded. A supplier sees
only its own visible quotations. List rows never contain private costing, other
bidder identities, draft preparation provenance, item arrays or recipient lists.

Reuse generic whole-source search/column filters, stable sort, page sizes and
explicit personal Save view/export controls. Default 25 request cards; show actual
total, matching and visible counts. Failures show an error and retry, not a new-user
empty state. Selecting a card retains the existing authorized detail/deep link.
Background refresh and pagination do not reset an open request draft. The full
workspace snapshot remains available for details and assistant context; this slice
bounds list response/rendering and does not claim storage-level indexed querying.

The request editor's invitation picker searches authorized supplier contacts by
actual name, company or email, ignoring case and surrounding whitespace. Searching
never selects or removes a supplier. Show the total selected and any selected
suppliers hidden by the search, distinguish no matches from no contacts, and offer
an explicit clear-search action. Existing amendment invitation restrictions remain.
This addresses original product brief §13's everyday long-list usability outcome.

Executable acceptance:

1. `node src/domain/procurement/tests/request-collection.mjs`: real-ledger requests
   cross server pages without omissions/duplicates, authorized private projections,
   current-offer counts, filters/export consistency, saved view/replay and disposer.
2. `node src/domain/procurement/tests/request-collection-browser.mjs`: GUI-created
   drafts, filters/sort/page changes, explicit view save/reload, CSV columns, open
   record and form preservation across refresh; capture actual list responses and
   screenshots from an isolated full native application.
3. Isolated Vite build and focused procurement native regression.
4. `node src/domain/procurement/tests/supplier-picker-browser.mjs`: real GUI name,
   company and email searches, explicit selection across filters, no-match/clear,
   then private draft save/reopen with both selections intact; no publication.

Executed 2026-09-26: native 3 groups, full GUI 3 groups and isolated Vite build
90 modules passed. Raw native report: `tmp/request-collection-UDVhht/report.json`.
GUI report, actual collection responses, selected-column CSV and three screenshots:
`tmp/product-evidence/request-collection/local/` (zero JavaScript errors).

Supplier picker acceptance 2026-09-26: focused GUI 3 groups, zero JavaScript errors,
and Vite build 114 modules passed against immutable 67bd9af backend with patched
local assets. Evidence: `docs/work/evidence/supplier-picker-2026-09-26/`.
