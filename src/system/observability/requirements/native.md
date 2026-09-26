# Native operations and event timeline
<!-- budget: 8192 bytes -->

Owner: `system/observability`. Retains FR-UX-004/005, FR-RUNTIME-007/008 and the compatible operations outcomes of audit G8. Native sources replace old SSR and middleware snapshot files.

Administrators receive a current operational summary: actual plugin states, provider admission/circuit/concurrency counts, completed/failed/unknown request totals, review/workflow/exchange/extension counts, ledger availability and explicit partial coverage. It contains no message/prompt/business-record bodies, costs, credentials or counterparty private fields. Unknown/unavailable sources are labelled; aggregate counts state the covered realm count. Periodic snapshots are derived metadata, atomically replaced in the private runtime directory and removable on unload. A current snapshot can be downloaded in GUI, with generated time and source declarations.

Each account can browse event metadata for its own account and explicitly joined same-party workspaces. Admin status alone does not expose another party's timeline. Whole-source search/filter/sort/paging uses WebUI collection registration. Show event type, sequence, time and chain hash; never expose bodies in this generic page. Hash/sequence help the user locate corresponding evidence in the evidence plugin. Current membership and role are rechecked per query. No model tool exposes this page or snapshot.

Acceptance: actual native store events with private canaries are absent from serialized admin snapshot; own/joined/outsider timeline rules; unavailable realm counts; atomic periodic file and disposal; native GUI administrator/client navigation/filter/download/narrow screen. Historic per-event wall-clock exclusion applies to the old deterministic snapshot artifact, not the current account event timeline; event timestamps are explicitly factual metadata.
