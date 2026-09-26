# Native object attachments
<!-- budget: 4096 bytes, hard -->

Current owner: `code/product.mjs`, `client/attachments.jsx`; provides
`ctx.attachments` and the removable `object-attachments` GUI slot used by procurement.
[Native acceptance](native.md) maps SUPPLEMENT-003/004/005 and the retained storage
outcomes. This supplies the attachment portion of FR-UXWEB-001 and FR-USREQ-001;
FR-USREQ-011 document generation belongs to the domain report/print owners.

Both roles upload internal versions beside readable RFQs, quotations, orders and
changes. A filename/object chain preserves superseded bytes and removal tombstones.
Explicit delivery reviews exact version, digest and recipient, then uses signed QEP
manifests and separate artifact resources. Required bytes are checked before the
record becomes effective; missing bytes remain visibly pending. Raw bytes never
enter append-only ledger events. Sender removal cannot erase counterparty copies.

Image/PDF/text previews offer original downloads. Text truncation is explicit;
PDF pages render with the bundled PDF.js worker and a bounded canvas; unsupported documents retain an original-download fallback. Retention may dispose a historic local
copy only after a separate review; metadata then says disposed rather than missing.

Run `node src/system/attachments/tests/native.mjs` and
`BASE_URL=http://127.0.0.1:8648/quotagent/ node src/system/attachments/tests/browser.mjs`.
[Local native and GUI evidence](../../../../docs/work/evidence/native-artifacts-2026-09-26/README.md)
includes independent stores, actual HTTP resource transport and three-account GUI
isolation. Old SSR routes, shared-directory indexes and the obsolete zero-ledger
metadata rule are historical references; their restrictions do not describe this API.
