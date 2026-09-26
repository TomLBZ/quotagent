# ADR-0035 Explicit party teams and independently reviewed authority
<!-- budget: 8192 bytes, hard -->
Status: accepted

## Problem

The native product has distinct accounts and human action review, but no colleague
membership, assignments or nominated second reviewer. Historical requirements in
ADR-0024/0025 and GUI sections15–19 retain independent signoff, role limits and batch
receipts. A global list of all contractors or suppliers is not a team. Sources:
`src/system/accounts/code/product.mjs`, `action-center/code/index.mjs`, and the
Sept26 requirement audit.

## Decision

A native `teams` plugin owns explicit party workspaces. Each workspace is anchored
to an existing business owner's account ledger. Invited accounts must explicitly
accept and have the same contractor/supplier perspective. Membership is never
inferred from a role, company label, login or administrator access. Records remain
in the owner's ledger; each write identifies the actual human separately from the
business owner. Selected workspace and personal styles/connections remain account
preferences. Model requests retain the complete authorized source context before
use. Shared party membership does not disclose facts to an opposite-side party.

Procurement accepts a disposable scope resolver: it authorizes the real account and
returns the business owner identity plus `actorId`. Ownership fields keep their
business meaning; event actors and approval signers use the real human. GUI shows
the selected team and role. Personal private capabilities are not silently pooled.

Teams own member roles, reporting lines and monetary authority. A missing limit is
unconfigured, zero authorizes no positive amount, and unlimited is an explicit
value. Currency is explicit; there is no silent FX conversion. Policy changes are
proposed with their exact diff, reviewed by a nominated different team member and
then applied by the proposer. This preserves ADR-0025's independent decision while
replacing its file/CLI-only implementation with the full GUI.

Action center owns frozen requests, nomination, independent grant, rejection,
signing/execution and receipts. Award/order commitments require a different human
reviewer by default, preserving ADR-0024. A grant is bound to its action, object,
version, amount and policy revision. The proposer signs the granted action; a
reviewer cannot silently execute it as the proposer. Domain services check signoff
before effects. Existing single-human historical receipts stay readable and are
labelled accurately. Policy/schema changes append new facts rather than rewrite
historical approvals. Other action kinds can retain direct human review when no
independent decision is required by policy.

Pending queues expose the actual assignee, elapsed age, due policy and next action.
Timeout policies remind, escalate or expire; none auto-approve. Delegation, reminders
and termination retain actor and reason. Batches have independent item receipts and
selective retry; one failed item never rolls back or disguises successful items.

Assignments, following and comments are scoped to explicit team objects. Mention
candidates come from active membership, with unknown names reported. The personal
today view derives assignments, mentions, pending reviews and relevant deadlines.
All services, routes, tools, timers and GUI contributions are disposable plugins.

## Consequences

Two humans can review a commitment without sharing credentials or exposing supplier
facts to buyers. People can work while approvals wait. Membership and authority add
setup, so the GUI must explain missing colleagues/limits and link directly to setup.
Default demo data needs a separately signed-in reviewer for independent scenarios.
Removing a member does not erase their historical signatures or comments.

## Alternatives rejected

| Option | Reason |
|---|---|
| Treat every same-role account as a colleague | Combines unrelated suppliers or buyers |
| Impersonate the business owner in audit events | Hides who actually approved or edited |
| Remove independent signoff because current UI lacks it | Silently drops a compatible documented outcome |
| Keep mandatory terminal-only policy files | Prevents the requested full GUI workflow |

## Revisit conditions

Revisit when an account must represent opposite-side parties simultaneously, when
external identity directories are required, or when a commitment needs multiple
independent approvers rather than one. These changes need explicit new decisions.
