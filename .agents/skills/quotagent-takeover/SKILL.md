---
name: quotagent-takeover
description: Recover quotagent work after a new session, crash or context compaction using persisted goal, handover and verified source state.
---

# Recover current work
<!-- budget: 4096 bytes, hard -->

Read `docs/work/handover.md`, `.agents/state.json`, then the ignored progress/goal
files they name. These files can be newer than committed documentation; confirm
claims against actual source, evidence and git refs before acting. The next unique
action in handover is the starting point, not a substitute for the full user goal.

Use `docs/requirements/catalog.json` to find the current plugin owner, contract,
remaining acceptance and immutable historical source. An ownership count or old
`EV-*` report is not current completion evidence. The product uses native Cordis
and React (`host/product.mjs`, `host/client.mjs`); repository-only modules and old
SSR/CLI checks do not establish current application behavior.

Inspect `git status`, recent commits and `git ls-remote origin refs/heads/main`.
Preserve other agents' dirty paths and existing user work. Verify the behavior
relevant to the resumed change; run `tools/verify.sh docs` for documentation state.
Do not rebuild or deploy dirty shared source. Public releases use immutable committed
checkouts and the existing gateway; read recorded process/data paths before changing
an application process.

Keep the compact ignored handover/state/progress current at meaningful checkpoints.
Record exact verified command/result, active workers, current public revision,
next unique action and blockers. Follow the commit/push/readback rule in AGENTS.md
for a completed functional batch; never stage unrelated shared-tree changes.
