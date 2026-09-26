# Supplier invitation search
<!-- budget: 4096 bytes, hard -->

Owner: `domain/procurement`; contract
`src/domain/procurement/requirements/request-collection.md`. Original product brief
§13 requires basic work without browsing long lists. The request editor now filters
its existing authorized supplier contacts by name, company or email, keeps selection
independent from the filter and identifies selected suppliers hidden by search.

Executed 2026-09-26 on the actual native application at loopback 8648 with isolated
private data. Backend was immutable public revision
`67bd9af5b73036104f81abdacae0883fd8d2ffce`; frontend was a local working-tree build
containing this change. This is local acceptance, not a public deployment claim.
`provenance.json` records the frontend source digest. The preview was stopped after
the check; no public process, account or lifecycle change was performed.

Commands:

```sh
node host/node_modules/vite/bin/vite.js build --config src/system/webui/client/vite.config.mjs --outDir /workspace/projects/quotagent/tmp/agent-experience/supplier-picker/assets
BASE_URL=http://127.0.0.1:8648/quotagent/ EVIDENCE_DIR=tmp/agent-experience/supplier-picker/browser node src/domain/procurement/tests/supplier-picker-browser.mjs
```

Observed: build passed, 114 modules. Browser passed three focused groups with zero
JavaScript errors: real displayed company/name/email search, explicit selection
across disjoint/no-match filters with truthful hidden counts and clear action, then
private draft save/reopen retaining both invited suppliers. No publication or
external commitment. `report.json` and the two viewport screenshots retain results.

Public replay on immutable `3ab6d8cde6d2d05acb3a73403279fc9be579a15f`:
`BASE_URL=https://novara.remoteblossom.com/quotagent/ EVIDENCE_DIR=tmp/product-evidence/final-public/supplier-picker node src/domain/procurement/tests/supplier-picker-browser.mjs`
passed [the same3 groups with0 JavaScript errors](../final-public-2026-09-26/supplier-picker.json),
including private draft save/reopen. No invitation was published.
