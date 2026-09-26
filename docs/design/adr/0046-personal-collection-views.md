# ADR-0046 Personal collection views
<!-- budget: 4096 bytes -->
Status: accepted

## Problem
Native business plugins currently send complete collections to the browser. The compatible personal-view and scale requirements from WebUI design §9/14/20 need an owner-neutral API without moving business authorization into the shell.

## Decision
WebUI provides disposable `web.collection` declarations. Owners provide authorized rows and columns; WebUI applies query windows, whole-source counts and CSV export. It stores explicitly saved account/role view preferences as append-only `webui/view-preferences-saved` records in `ui-view-preferences`, with optimistic revision checks. These are presentation preferences and are not included in model input. Owners must record any future model-visible use separately. Querying, paging and exporting never save preferences implicitly.

## Consequences
The browser receives only requested rows; all matching keys are an explicit bounded request. Server-side source reads still materialize the owner's source, so this is transport/rendering pagination rather than an indexed database. A plugin's unload removes collection access without deleting saved preferences. Cross-page selection remains a client decision and cannot bypass owner validation or human review.

## Alternatives rejected
| Alternative | Reason |
| --- | --- |
| Client truncation | Transfers the complete source and misstates complete-set counts. |
| Business-specific shell | Couples WebUI to procurement and makes extension ownership unclear. |
| Save each keystroke | Surprising writes, stale update races and unnecessary ledger growth. |

## Revisit conditions
Introduce owner-side indexed queries when measurements show material source-read cost; retain the query/count/selection semantics and authorization contract.
