# Controllable assistant conversations
<!-- budget: 8192 bytes, hard -->

Status: implemented; [public evidence](../../../../docs/work/evidence/agent-experience-2026-09-26/README.md). Owner: native `agent-runtime` / `product-assistant`.
Source: user enhancement objective 2026-09-26; decision ADR-0031.

| Requirement | Acceptance |
|---|---|
| Start a durable account conversation task and show its status immediately | POST chat returns run; GET assistant restores messages and current task after browser reload |
| Pause, resume and stop from the conversation itself | Pause aborts provider work and prevents further tools; resume retains completed work; stop is terminal and a new message starts a new task |
| Add guidance while working or paused | Guidance is recorded before model use; working task restarts reasoning using it; paused task remains paused until Resume |
| No duplicated draft effects on resume/recovery | Tool checkpoints retain completed results; an interrupted tool without a receipt is explicitly uncertain and is never automatically repeated |
| Restart/unload recoverability | Running tasks recover paused; active requests abort, jobs settle and registrations disappear on unload |
| Clear useful state on failure | Error and completed tool/review actions remain visible; user can resume or stop |
| Agent-first conversation page | Native agent page reuses the conversation component, exposes role starters, progress and controls; dock is suppressed on that page |

`assistant.start(user,{message,rfqId?})` returns `{run}`; `control(user,id,{action,
message?})` supports pause, resume, stop, steer. `state(user)` returns messages,
current run and provider status. Run public views exclude raw model prompts. The
internal `chat` method may await completion for callers needing a result, but GUI
starts asynchronously and observes durable status. One unfinished task per account.
Completed effects are not undone by stopping. Tool cancellation waits for an already
executing tool to settle; the UI shows this explicitly. External commitments still
require a separate human review action.

Each run checkpoint stores exact wire/turn messages, tool call identities/results,
actions, status, phase, revisions and timestamps in `assistant-runs`. Events are
`assistant/started`, `model-checkpoint`, `tool-started`, `tool-completed`, `paused`,
`resumed`, `steered`, `stopped`, `completed`, `failed`, `recovered` (same prefix).
Existing complete provider inputs/outputs and shared tool receipts remain recorded.

Executable acceptance: `node src/system/agent-runtime/tests/controls.mjs` exercises
abort/resume, in-flight tool receipts, steering, delayed state writes, uncertain
restart recovery, account isolation and disposal. Public browser acceptance uses
the configured actual model and verifies pause/steer/resume/stop across reload.
Evidence is recorded only after execution, under `docs/work/evidence/`.
