# Requests collection execution
<!-- budget: 4096 bytes, hard -->

2026-09-26 local native application evidence for the
[Requests collection contract](../../../src/domain/procurement/requirements/request-collection.md).

| Command | Result |
|---|---|
| `node src/domain/procurement/tests/request-collection.mjs` | PASS 3: 31 real-ledger drafts over four server pages; exact stable IDs; whole-source filters/export; party isolation; current offer count; compact row whitelist; personal preferences replay and unload. Raw `tmp/request-collection-UDVhht/report.json`. |
| `node src/domain/procurement/tests/request-collection-browser.mjs` | PASS 3: eleven GUI-authored RFQs; 10+1 paging with actual counts; filter currency, descending order, save/reload personal view; selected-column CSV with every matching record; correct detail and unsaved form focus across background refresh. Raw `tmp/product-evidence/request-collection/local/` including responses, CSV, screenshots and report; zero JavaScript errors. |
| `npm --prefix host run build -- --outDir /workspace/projects/quotagent/tmp/agent-experience/rfq-build` | PASS 90 modules, isolated output; shared distribution untouched. |
| `node src/domain/procurement/tests/rfq-lifecycle.mjs` | PASS 4 focused prior lifecycle groups; raw `tmp/product-evidence/request-collection/local/rfq-regression.json`. |

The list endpoint returns a bounded compact row window. Its authorized source
still uses the domain snapshot; this does not assert indexed database queries or
elimination of the full detail/assistant snapshot. Public replay is a separate
integration step after deployment.
