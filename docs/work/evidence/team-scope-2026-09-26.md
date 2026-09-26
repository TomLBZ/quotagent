# Durable agent workspace scope
<!-- budget: 4096 bytes, hard -->

Decision: ADR-0035. Assistant and workflow runs capture the selected party workspace
when created. Model calls and tools keep this identity through pause/resume and
browser workspace changes. UI names the run workspace. Conversation source history
is filtered by its recorded workspace; personal account/provider preferences remain
personal. Implementation: `src/system/agent-runtime/code/{conversations,product-assistant}.mjs`
and `src/system/agent-workflows/code/engine.mjs`.

Executed 2026-09-26, exit 0:

- `node src/system/agent-runtime/tests/controls.mjs`: seven groups PASS, including switching workspace while paused and checking all subsequent model/tool calls and retained transcript scope.
- `node src/system/agent-workflows/tests/state.mjs`: eight groups PASS; independent workers, checkpoints, memory, isolation and cancellation; 12 model calls, 57 fixture ledger records.
- `node src/system/agent-workflows/tests/cancellation.mjs`: three cancellation/recovery race groups PASS.

These focused tests establish scope/control behavior. Team business GUI evidence
and full procurement independent signoff are separate integration work.
