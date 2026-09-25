# Agent workroom
<!-- budget: 6144 bytes, hard -->

Owner: native `agent-workflows` plugin. Composition and trust contracts are in
`docs/product/connected-agent-contract.md`; this plugin changes no kernel or QEP semantics.

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

`node src/system/agent-workflows/tests/state.mjs` uses a controlled provider to verify memory
approval/history/isolation, human checkpoints, simultaneous independent contexts, provider
input memory/feedback, cancellation, unload/recovery and dependency validation. This is not
claimed as live model evidence.

`node src/system/agent-workflows/tests/cancellation.mjs` holds storage writes at the
cancel/abort-completion boundary and the next-worker transition. It verifies no late agent
start/provider call, completed-report preservation, and append-only startup reconciliation.

`node src/system/agent-workflows/tests/recovery-browser.mjs start`, an actual process restart,
then `node src/system/agent-workflows/tests/recovery-browser.mjs verify` exercise public GUI
recovery, explicit resume, cancellation, delayed task-state and reload checks.

`node src/system/agent-workflows/tests/cancellation-browser.mjs` checks visible correction
of the earlier cancelled run, then cancels a fresh real four-specialist run and verifies
terminal task states and trace ordering after a delay and full page reload.

`BASE_URL=https://novara.remoteblossom.com/quotagent EVIDENCE_DIR=tmp/product-evidence/workroom/public node src/system/agent-workflows/tests/browser.mjs`
uses the configured real provider and visible GUI controls for a complex quotation analysis,
manual memory, pause/resume, plan review, specialist question/answer, parallel task trace,
synthesis, reload and memory history/archive. Output and screenshots record observed results.
