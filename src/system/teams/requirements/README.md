# Party teams, authority and collaboration
<!-- budget: 8192 bytes, hard -->

Status: team foundation implemented; local native and GUI evidence in
`docs/work/evidence/teams-2026-09-26/`. Domain independent signoff is the next
integration slice. Native owner `system/teams`; shared approval
execution belongs to `system/action-center`. Decision: ADR-0035.

Current requirements consolidate historical FR-AUTH-001, FR-GATE-001,
FR-APPROVE-003 and supplemental010–014,019–020 from the Sept26 audit. Independent
signoff retains ADR-0024/0025; side-global roster files and CLI-only policy changes
are superseded mechanics, not missing business features.

| Capability | Executable acceptance |
|---|---|
| Create a party team; invite an existing same-side account; accept/decline; select an authorized workspace | Two signed-in GUI identities observe accepted membership and same shared business context; unrelated/opposite-side accounts remain isolated |
| Manage active members, roles and reporting lines | GUI changes persist; inactive/unknown people cannot receive assignments or review grants; history retains names and signatures |
| Exact currency/role authority with unknown, zero and explicit unlimited | Native tests exercise threshold, currency mismatch and higher-role escalation; GUI shows complete bands and why a decision waits |
| Independent review and application of authority policy | Self-approval refused; nominated peer sees exact proposed changes; only reviewed revision can apply |
| Assignment, transfer, follow and comments with mentions | Object-scoped GUI thread/assignee survive reload; notify only known active team members; unknown mentions are explicit |
| Personal today view | My work, assigned by me, following, mentions, pending decisions and entered RFQ deadlines link to actual source records; clear zero-data state |
| Configurable authority roles and complete conversations | Add/rename/remove roles through independently reviewed policy; existing members prevent removal of their role; explicit load-more exposes all comments |
| Account and plugin lifecycle | Selection persists across browser restart; unload removes routes/tools/UI/jobs without orphaned notifications or losing durable business facts |

`teams.resolveUser(user,operation,input?)` authorizes membership and returns the
business identity with `actorId` for procurement. `teams.scope/authority/roster`
provide source-backed account context. Policy and collaboration APIs expose owned
records and exact next steps; model tools read context or propose changes only.

New record collections/events are `party-teams`, `team-invitations`,
`team-selections`, `team-policy-proposals`, `team-assignments`, `team-comments`,
`team-following` under the additive `teams/*` family. Event bodies use the existing
workspace record envelope. Personal notifications reference these recorded facts.

Acceptance commands: `node src/system/teams/tests/state.mjs` for native Cordis/ledger
state and boundaries; `node src/system/teams/tests/browser.mjs` for real multi-user
GUI workflow. Evidence is written under `docs/work/evidence/` after execution; no
requirement is passed by this specification alone.
