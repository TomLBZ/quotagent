# Personal views and large collections
<!-- budget: 8192 bytes -->

Owner: `system/webui` supplies disposable collection registration, account/role-owned saved view preferences, and reusable query controls. Each business plugin owns its authorized row source, field descriptions and row actions. This implements the compatible outcomes of SUPPLEMENT-002/021 and `docs/design/29-webui-gui-app.md` §9/14/20; old SSR attributes and global business tables are superseded.

- Register a collection with columns, roles, an authorized `load(user)` source and a stable row key. Removing its registration removes query, preference and export access.
- Search and conjunctive column conditions apply to the entire authorized source before stable sorting and pagination. Return total, matched, page, pages, rows sent and per-column values from the whole source. A read cannot change records or saved preferences.
- Default 25 rows; explicit page sizes 10/25/50/100 or All. All explicitly asks for full rendering. Return all matching keys only when requested, with a declared 5,000-key limit; refuse oversize selection, never truncate it.
- Save query, column conditions, sort, size and export columns per account and role, with an explicit Save view control. Use ledger events `webui/view-preferences-saved` in `ui-view-preferences`; stale revision refuses without overwriting a newer view. Reset is an explicit new preference revision, not ledger deletion.
- Query changes clear cross-page selection; paging preserves it. Show selected total and current-page count. Batch actions retain their owning plugin's exact review and per-item receipts.
- Export applies the same whole-source query and selected columns. CSV protects spreadsheet cells from formula execution and identifies the selected columns. Export does not mutate source data.
- Before initial saved preferences resolve, generic search/filter/sort/export-column/save/paging controls are disabled. Error Retry remains usable. Any early page-specific programmatic query update is merged over the saved view when hydration completes, so the user’s expressed intent is retained.
- During fetch, controls disclose loading; failed reads show unavailable/retry, never a truthful-looking empty collection. A later response cannot overwrite a newer query or account.

Acceptance: native collection tests compare pages/IDs against a full independent source; preference replay and role isolation; stale saves and unload; native action pagination and GUI query/save/reload/export/cross-page selection. Public GUI evidence is required before full acceptance.

Preference readiness and retry evidence: [delayed-load GUI and original Operations replay](../../../../docs/work/evidence/collection-readiness-2026-09-26/README.md).
