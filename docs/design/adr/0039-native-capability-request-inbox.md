# ADR-0039 Account capability requests with administrative receipts
<!-- budget: 4096 bytes, hard -->
Status: accepted

## Problem

Native accounts and plugin management expose real permissions and lifecycle, but a
client cannot ask the separate administrator to resolve a blocked capability and
track the answer. Historical FR-ADMIN-004/005 require an actionable pending inbox;
CLI pending files and inline administrator elevation are obsolete mechanics.
Sources: `src/system/plugin-manager/code/index.mjs`, `src/system/accounts/code/product.mjs`.

## Decision

A native child of plugin-manager owns capability requests in a system ledger. Each
request contains only the requester, chosen capability/plugin, their explicit
reason and its decisions. It never captures private business records, prompts,
credentials or another account's settings automatically. Clients see their own
requests; the administrator sees the administrative inbox. Client identity never
becomes an administrator session.

Requests can ask for an existing account permission, an existing runtime plugin,
or configuration guidance. The administrator reviews the exact requested change.
Permission/plugin resolution performs the actual registered operation and reads
back the result. Failed operations remain blocked with a reason. Configuration
questions receive guidance; only the requester confirms that the issue is resolved.
Rejection and expiry do not change permission or plugin state. Reopening creates a
new linked request. All writes append capability-request events; original reasons
and earlier decisions remain recoverable. Notifications stay in the app.

## Consequences

People can resolve blockers without leaving the GUI or sharing credentials. An
administrator must deliberately grant access or enable a global plugin. Enabling a
plugin affects the application, and the review identifies that scope. A guidance
receipt is a human report of resolution, not an automatic configuration probe.

## Alternatives rejected

| Alternative | Reason |
|---|---|
| Silent permission elevation after a request | A request is not authorization |
| Copy full failing model/business context to the administrator | Unnecessary disclosure across party realms |
| Keep terminal pending files as the only workflow | Conflicts with the complete GUI requirement |

## Revisit conditions

Revisit when requests need multi-administrator approval or external support systems.
