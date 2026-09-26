---
name: quotagent-implement-task
description: Implement a quotagent requirement from its owning plugin contract, preserving traceability, native effects and proportional executable evidence.
---

# Implement an owned requirement
<!-- budget: 4096 bytes, hard -->

Resolve the source clause and sole owner in `docs/requirements/catalog.json`.
Read the owner's current `requirements*` contract and relevant source. Add missing
acceptance behavior there before implementation; the catalog is a trace index, not
a duplicate global functional specification. Current user direction takes precedence
over historical mechanics or tests that freeze a superseded UI.

Use native Cordis service injection and disposable effects for registrations.
Keep business decisions in their owning plugin; WebUI supplies generic mechanisms.
Follow AGENTS.md for ledger/model reconstruction, realm exchange and human approval.
Changing protocol/ledger/trust/evolution boundaries requires the design-note skill.

Validate actual affected behavior with appropriate native and GUI commands. Use
isolated data and loopback protocol services for integration fixtures. Retain command,
observed output, source revision/scope and material limitations under
`docs/work/evidence/`. A fixture does not prove live model quality; local GUI does
not prove public deployment. Do not rerun obsolete global suites merely to report
all gates green. Expand checks when a changed boundary or observed failure warrants it.

Update exact catalog clauses with current contract, implementation state and
acceptance evidence. Leave incompatible mechanics explicitly superseded with a
reason; leave unresolved compatible work open. Update ignored recovery state, then
commit only the functional batch, normal push and read back remote refs. Final
public acceptance uses the existing authorized URL and a committed release.
