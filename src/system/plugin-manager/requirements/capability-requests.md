# Capability request inbox
<!-- budget: 4096 bytes, hard -->

Native owner `system/plugin-manager` child `capability-requests`; ADR-0039.
Retains FR-ADMIN-004/005 pending/blocker/resolution outcomes with separate admin
accounts. No inline token elevation or filesystem handoff is required.

Clients submit an explicit reason and choose permission, runtime plugin or
configuration guidance. Account settings shows their pending/blocked/resolved/
rejected/expired history. Administrators inspect requests, perform the exact
permission/plugin change or provide guidance. A failed change stays blocked; a
configuration requester confirms the result. Expired/rejected requests never grant
anything. Reopening links a new request to the old receipt. Names/statuses/counts
are metadata; private source context is never copied automatically.

Record collection `capability-requests` in system realm; events
`capabilities/requested`, `decided`, `guidance-provided`, `resolved`, `blocked`,
`expired`, `notification-failed`. Original reason, decision actor and timestamp are
retained. Read/model tools cannot grant permissions or execute lifecycle changes.
Native routes, tools, notices and aging job dispose with their Cordis owner.

Acceptance: `node src/system/plugin-manager/tests/capability-requests.mjs` exercises
actual account/ledger/plugin effects, unrelated-user privacy, admin-only decisions,
blocked operation recovery, guidance confirmation, rejection, expiry and lifecycle.
Browser acceptance uses separate client/admin GUI identities and verifies actual
permission state plus retained outcomes. Evidence is required before marking passed.
