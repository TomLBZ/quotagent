# Native object attachments
<!-- budget: 8192 bytes, hard -->

Owner: `system/attachments`, using `system/file-store` and QEP store policy hooks.
Decision: [ADR-0040](../../../../docs/design/adr/0040-native-evidence-artifacts-and-retention.md).

| Retained clause | Executable native acceptance |
|---|---|
| SUPPLEMENT-003 | Both roles attach to readable RFQ/quote/order/change through GUI; internal remains in party, delivered bytes and hash-bound manifest travel only through explicit QEP transfer to eligible participant |
| SUPPLEMENT-004 | Bounded image/PDF/text preview; escaped plain text, honest truncation and unsupported-type download explanation |
| SUPPLEMENT-005 | Same object+filename versions link immutably; identical retry is unchanged; old version download, explicit removal tombstone and missing/disposed states survive reload |
| CURRENT-012, FR-STORAGE-001/004 | Keep immutable account uploads/downloads and correct digest/realm boundaries; recorded provenance replaces obsolete zero-ledger storage metadata requirement |

Executable checks: `node src/system/attachments/tests/native.mjs` and
`BASE_URL=http://127.0.0.1:8648/quotagent/ node src/system/attachments/tests/browser.mjs`.
Use real two-store QEP artifact transport plus GUI upload/version/remove/preview and
counterparty download; no private costs or raw other-account file reads. Stage a
signed but pending/conflicting resource without making it an effective attachment.

UI registers `object-attachments` slot, navigation `attachments`; procurement owns
slot placement. Props: `{kind,record,rfq,onChange}`. Service `ctx.attachments` owns
list/upload/version/remove/deliver/preview, and registered public QEP manifest
policy. Byte payloads stay outside ledger; provenance and accepted manifests remain
reconstructible. Historical SSR/shared-directory files are implementation references.
