# Public scope, schedule and reusable source declarations
<!-- budget: 12288 bytes, hard -->

Owner `domain/procurement`; ADR-0053. Retains FR-RFQ-002, DOMAIN-002/003,
SUPPLEMENT-031 and completes adoption for FR-DEV-002. Source clauses are immutable
in `docs/requirements/catalog.json`; old Python/SSR mechanics are not reinstated.

- New publish/amendment: complete declared measurement rules, admitted units,
  responsibility interfaces, deliverables/exclusions. Incomplete draft allowed;
  legacy published records remain unknown. UI does not infer owner/dimension.
- Quote: optional explicit assumptions/exclusions arrays, schedule milestone IDs,
  labels, ISO dates, firm/indicative binding and item refs. Omitted remains unknown;
  explicitly empty is declared none. Source revision/approval/QEP/PO preserve all.
  Model cannot change still-valid submitted firm promises. Human prepares revisions.
- Alternatives: each requested line covered once by base or explicit alternative;
  additional lines allowed and visibly reviewed. Exact accepted source list derives PO.
- Structured FAQ: draft candidate from fully broadcast source; allowed authored
  reusable fields, immutable question hash/source refs; human publish; pure exact
  package+revision lookup; content-free mismatches; explicit separate private
  adaptation; archive/deprecation and restart history. No automatic fact publication.

Executable AC: `tests/public-declarations.mjs` actual signed exchange and independent
PO review; `tests/public-declarations-browser.mjs` visible GUI-only writes, separate
accounts, source screenshots, no JS errors. Focused RFQ/scope/terms/fulfillment tests
and isolated build passed. Command outputs and scope are in
[executed evidence](../../../../docs/work/evidence/procurement-declarations-2026-09-26/README.md).
