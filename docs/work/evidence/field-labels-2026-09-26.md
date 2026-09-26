# Stable form control labels
<!-- budget: 2048 bytes, hard -->

Generic WebUI `Field` now gives native input/select/textarea controls their visible
field name as an accessible label, preserving any explicit label supplied by the
plugin. Option text and help text no longer become part of a select's name.
Source: `src/system/webui/client/core.jsx`.

2026-09-26: integrated Vite build passed (66 modules); real two-account team browser
journey passed five groups with zero JavaScript errors, using exact visible labels
for invitation role, authority reviewer, workspace selection, assignment and
comments. Command: `node src/system/teams/tests/browser.mjs`.
Report retained in `tmp/product-evidence/teams/local/report.json` and the subsequent
team evidence bundle. This fixes control naming, not business approval semantics.
