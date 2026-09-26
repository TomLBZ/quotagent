# Human action review
<!-- budget: 8192 bytes, hard -->

Native owner `system/action-center`; independent party authority decision
[ADR-0035](../../../docs/design/adr/0035-party-teams-and-reviewed-authority.md).
Source: `code/service.mjs`, `code/index.mjs`, `client/actions.jsx`.

## Outcome and owner contract

A plugin registers an executor with a disposer. Proposals freeze their exact input.
Personal actions retain direct human review. New proposals preserve the originating
account perspective; changing account type hides and blocks former-side proposals
until that perspective is restored. An executor that declares independent
review binds action, business workspace, object, amount in integer cents, currency,
semantic fingerprint and current authority policy revision. Its party teammates can
read that shared review; personal connection credentials and unrelated accounts
remain personal. The service records the actual proposer, nominated reviewer and
signer separately from business ownership.

The proposer nominates a different active colleague with sufficient monetary
authority. That colleague grants the exact request. Only its proposer can sign and
execute. Changed policy, removed/under-authorized reviewer, changed frozen input or
wrong target invalidates signing. `authorizeCommitment` accepts only the matching
live execution lease; domain services invoke it before monetary effects. A model
has no grant or signing tool. Legacy single-human receipts remain readable and are
labelled by their actual decision, without inventing a second signature.

A nomination can be delegated with a reason; participants can remind or decline.
Queues show names, elapsed time, policy, due action, authority bands and the next
available decision. Policy timeout choices remind, escalate to an eligible higher
role or expire. If no higher reviewer exists, the current participant is reminded
and that limitation is recorded. Waiting never grants or executes an action.

## Execution and batches

Concurrent signatures execute once. Result/error receipts survive refresh.
Interrupted execution becomes uncertain without automatic retry. Notification
failure cannot change a successful commitment into a failed one. Owning preview
slots render readable frozen content; full content and source remain inspectable.

Users can select up to 100 actions and inspect their exact contents before a batch
decision. Each item is independently checked and recorded. Background jobs persist
selection, human confirmation, active item and every completed receipt. People can
continue other work, pause after the current effect, cancel remaining items, or
resume unattempted items. Restart pauses a batch, reconciles a completed current
receipt, and never automatically repeats an uncertain effect. Successful items stay
completed when another fails. Failed items can be selected for deliberate fresh
proposals. All route, timer, executor and job effects dispose with the plugin.

New events are additive `actions/nominated`, `delegated`, `independent-granted`,
`signed`, `reminded`, `age-reminded`, `escalated`, `expired`, `aging-failed`,
`batch-started`, `batch-progress`, `batch-pause`, `batch-cancel`, `batch-resumed`,
`batch-completed`, `batch-recovered`, `batch-suspended`. Existing personal events
retain their original meanings. New shared records identify realm/workspace/side;
background jobs are personal `action-batches` records. Full facts use the existing
append-only workspace record envelope.

## Executable acceptance

| Command | Required behavior |
|---|---|
| `node src/system/action-center/tests/state.mjs` | Actual ledger, personal-account settings/actions, concurrent execution, notification faults, delegated policy and uncertain restart recovery |
| `node src/system/action-center/tests/independent.mjs` | Actual teams/ledger; separate grant/sign; authority changes; wrong actors/scopes; escalation/expiration; partial batches; durable pause/resume and recovery |
| `node src/system/teams/tests/browser.mjs` | GUI accepted colleagues and independently reviewed policy setup |
| Procurement phase2 GUI journey | Frozen monetary review → named reviewer grant → proposer signature → exact shared PO; domain controls prevent direct signing |

Local native evidence belongs in `docs/work/evidence/independent-actions-2026-09-26/`.
The generic service tests do not establish final domain integration or public GUI
completion; those are recorded separately after their journeys run.

## Captured provenance and declared risk

ADR-0051 closes FR-UX-001 and NFR-UX-002 in the native review UI. Every detail view
shows its exact sorted-key JSON input hash and explicit risk assessment status.
Owning `input.preview.risks` supplies flags; absence is Not assessed and an empty
array never means risk-free. New `input.preview.sources` references include a
label, `{realm,seq,hash}`, optional collection/recordId and owner-provided page link.
Capture checks current realm authorization, exact event hash and record identity.
Source inspection stays limited to the authorized action's captured references.
Proposal receipt, frozen input and recorded task/retry form the remaining chain.
Historical proposals explicitly report missing upstream capture; current records
must never be substituted for their unknown historical revisions. The GUI can
inspect exact ledger source bodies and navigate owner-supplied source pages.

Acceptance commands: `node src/system/action-center/tests/provenance.mjs` proves
real ledger capture, later-record stability, wrong-account/refusal, historical gaps,
owner risk flags, exact payload hashes and disposable routes. The corresponding
`tests/provenance-browser.mjs` creates a real proposal through GUI controls, inspects
risk/hash/source and source navigation, reloads its URL and checks mobile fit. These
checks do not approve an external commitment or fabricate model risk assessment.

Observed local native5 and GUI3 groups passed, with regressions state9/independent7,
103-module build and docs checks. Commands and limits are in
`docs/work/evidence/action-review-provenance.md`.
