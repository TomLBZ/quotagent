# Operations and event timeline
<!-- budget: 4096 bytes, hard -->

Owner: `system/observability`; native entry `code/product.mjs`.

The [native contract](native.md) defines administrator operational metadata and
account-scoped event timelines. This replaces the historical middleware observer
and its SSR snapshot endpoint; the old implementation remains a historical source,
not a mounted product service. ADR-0050 records the boundary.

Provides `operations`; requires `web`, `store`, `accounts`, `settings`. Optional
provider, team and plugin-manager services contribute actual current signals.
The administrator sees aggregate counts with explicit unavailable-source coverage.
The client sees metadata from its own readable account and available joined party
workspaces. An unreadable current workspace remains an explicit error.

Validation: `node src/system/observability/tests/native.mjs` and
`node src/system/observability/tests/browser.mjs`. Native and GUI outputs are in
[execution evidence](../../../../docs/work/evidence/native-operations-2026-09-26/README.md).
