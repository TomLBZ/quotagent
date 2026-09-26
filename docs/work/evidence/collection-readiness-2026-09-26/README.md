# Collection preference readiness
<!-- budget: 4096 bytes, hard -->

2026-09-26. The initial saved-view fetch could replace a search typed before it
completed. `src/system/webui/client/collections.jsx` now disables generic query,
sort, filter, export-column, saved-view and paging controls until initialization.
Retry remains available after a failed preference fetch. Early page-specific
`view.update` patches are retained and applied over the loaded preferences.
No records, preference formats or business rules changed.

`node host/node_modules/vite/bin/vite.js build --config src/system/webui/client/vite.config.mjs --outDir /workspace/projects/quotagent/tmp/agent-experience/collection-readiness/assets`
→114 modules built; bundle-size advisory only. Preview used the real native host
from immutable release `bf2cb4bd7f15eaec3201a0fc49077e7c7ea20288` on isolated8648,
its existing isolated ledger data, and assets built from `7f9a39baabf4d6569f8609a393c7b99b12968bf4`
plus this collection patch. Public8093 was not changed.

`BASE_URL=http://127.0.0.1:8648/quotagent/ EVIDENCE_DIR=tmp/agent-experience/collection-readiness/browser node src/system/webui/tests/accessibility-browser.mjs`
→ [10 GUI groups passed,0 JavaScript errors](accessibility.json). The new checks hold
actual preference HTTP requests until released: Operations controls remain disabled,
then entered search reaches the real query and persists; an early Review actions
“My decisions” tab choice also reaches the real authorized query after hydration.
Existing failed-preference and failed-row retries still recover without a false
empty state. [Search after delayed hydration](delayed-view.png).

`BASE_URL=http://127.0.0.1:8648/quotagent/ EVIDENCE_DIR=tmp/agent-experience/collection-readiness/operations node src/system/observability/tests/browser.mjs`
→ [6 GUI groups passed,0 JavaScript errors](operations.json). This replays the
original failing Operations flow using new contractor/supplier accounts: search,
sort, explicit Save view and reload retain the entered query. Admin metadata,
settings save/restore and390px checks also pass. All writes were through GUI on
isolated data; shared snapshot interval was restored. The preview was stopped
after verification. Corrected public-release replay remains the deployment owner’s
next acceptance step.

Corrected public `67bd9af5b73036104f81abdacae0883fd8d2ffce`: the same Operations
command with `BASE_URL=https://novara.remoteblossom.com/quotagent/` passed
[6 GUI groups and0 JavaScript errors](public-operations.json), including actual
search/sort Save view and reload for fresh contractor/supplier accounts.
