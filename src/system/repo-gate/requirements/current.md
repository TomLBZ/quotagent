# Requirement traceability and documentation consistency
<!-- budget: 4096 bytes, hard -->

Owner: `system/repo-gate`, repository tooling rather than a customer application
service. [ADR-0048](../../../../docs/design/adr/0048-canonical-plugin-requirement-catalog.md)
replaces obsolete global-table/SSR checks with a canonical migration index.

`tests/check-docs.py` verifies every original clause has one real plugin owner,
source text/revision, explicit disposition and current contract. Verified clauses
must link actual executable acceptance evidence and name its scope. Open clauses
remain visible in the report; structural success never implies functional completion.
Current documentation has checked links and byte budgets. Accepted historical ADR
bodies retain their decision history.

Commands: `python tools/check-docs.py` or `tools/verify.sh docs`. Recovery state,
progress/handover and sessions remain ignored. Functional batches include owner
contract/evidence, normal commit/push and remote-ref readback. The project rules
remain solely in AGENTS.md; this owner records how traceability is implemented.
