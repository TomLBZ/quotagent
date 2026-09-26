# Agent workroom
<!-- budget: 6144 bytes, hard -->

Owner: native `agent-workflows` plugin. Composition and trust contracts are in
`docs/product/getting-started.md`; this plugin changes no kernel or QEP semantics.

- `code/index.mjs` supplies `workflows` and `memory`, account-owned HTTP routes,
  assistant tool registrations, workroom navigation and configurable planner review/parallelism.
- `code/engine.mjs` calls the configured provider for a planner, distinct specialist
  conversations, and synthesis. Independent ready tasks execute concurrently; dependencies
  use completed reports. All provider messages are captured by the model provider's ledger.
- `client/workroom.jsx` lets users create a run, review its plan, answer questions,
  pause/resume/cancel, add feedback, inspect reports and trace inputs/outputs, and edit memory.
  Displayed traces contain plans, tool calls/results and reports, not hidden chain-of-thought.
- `code/memory.mjs` supplies active reviewed context. Manual edits are active immediately;
  model suggestions produce `memory.save` review actions. Only the action center's human
  approval executor activates a suggestion. Revisions retain the prior value and provenance;
  archival excludes a memory from future context while retaining history. Existing account
  preferences import with deterministic IDs and legacy provenance; existing records and
  tombstones prevent duplication or resurrection. The account settings memory card is a
  plugin-owned `account:memory` slot that links to the editable memory tab.

## Durable state and source handling

Account ledger collections: `workflow-runs`, `workflow-traces`, `agent-memory`.
Runs retain objective, plan, per-task agent identity/conversation/status, human feedback,
questions, planning context, result and timestamps. Traces reference one account/run and,
where applicable, its step/agent. The provider separately records complete model input/output.

States: `running`, `awaiting-plan`, `waiting-input`, `paused`, `completed`, `failed`, `cancelled`.
Phases: `plan`, `agents`, `synthesis`, `done`. Plan review precedes workers by default.
Multiple specialist questions remain queued. Answers and feedback enter retained contexts.
Pause and cancel abort provider requests and discard late results. Incomplete tool responses
are explicitly marked interrupted before a transcript is resumed. Completed reports remain.
An unloaded or interrupted active run recovers as paused and requires explicit user resume.
Human controls serialize per run and block relaunch until the control write is durable.
Background transitions validate their execution signal and current status inside the same
write queue as trace events. Startup appends a correction for historical cancelled runs that
retain unfinished task states; it never restarts those tasks.

Additive events use `workflows/`: `created`, `state-changed`, `planning-started`,
`plan-created`, `awaiting-plan`, `agent-started`, `tool-result`, `human-question`,
`waiting-input`, `human-answered`, `human-feedback`, `paused`, `resumed`, `cancelled`,
`synthesis-started`, `completed`, `failed`, `recovered`, `suspended`,
`cancellation-reconciled` (unfinished task states aligned with a saved human cancellation).
Memory events: `agent-memory/saved`, `agent-memory/archived`; suggestions and decisions use
existing action-center events. Record append/replay behavior is the existing store contract.

Account evidence, memory values, source/tool results and other agents' reports are separate
from the human objective and are labelled as lower-trust data. Tool execution always uses
`assistant.invoke` and its runtime effect policy. Delegates receive only declared read,
private-draft or proposal tools; they cannot approve actions or directly execute external
commitments. A model may still misinterpret text; reviewable proposals and guarded effects
limit consequences rather than asserting perfect prompt-injection prevention.

## Executable evidence

Commands are run from the repository root:

- `node src/system/agent-workflows/tests/state.mjs`: controlled provider checks
  memory approval/isolation/history, human checkpoints, independent contexts,
  recorded feedback, cancellation, recovery and dependencies; not live-model proof.
- `node src/system/agent-workflows/tests/cancellation.mjs`: delayed storage and
  worker transitions retain terminal cancellation and completed reports.
- `node src/system/agent-workflows/tests/recovery-browser.mjs start`, process
  restart, then `verify`: public paused recovery and explicit human continuation.
- `node src/system/agent-workflows/tests/cancellation-browser.mjs`: cancel a real
  four-specialist run; inspect terminal states after a delay and reload.
- `BASE_URL=https://novara.remoteblossom.com/quotagent/ node src/system/agent-workflows/tests/browser.mjs`:
  actual configured-model plan, pause/resume, feedback, question/answer, parallel
  specialist traces, synthesis and memory history. Results and limitations are in
  `docs/work/evidence/connected-agent-2026-09-25/README.md`.

## Runtime controls and context integration (G6)

See agent-runtime `requirements/controls-and-evaluation.md` and ADR-0038. Every model/tool call carries saved run ID, workspace and role; changed/untagged roles cannot resume. Shared
provider limits and context receipts apply without bypassing approval/tool policy. A typed
budget, circuit, queue, timeout or human stop reason remains visible beside completed
reports; no unknown token/cost or business success value is fabricated. Evidence: `docs/work/evidence/g6-auditable-runtime.md`; `tests/scope.mjs` verifies both pins.

Chat and all workroom roles share the runtime monetary-arithmetic instruction:
use recorded deterministic totals or a source-bound calculation tool; do not invent
derived amounts. Synthesis may repeat an observed specialist result but cannot
claim new uncomputed arithmetic. Source: `agent-runtime/code/product-policy.mjs`
and `code/engine.mjs`. The public deposit counterexample and corrected replay are
retained with the owning runtime/procurement evidence.
