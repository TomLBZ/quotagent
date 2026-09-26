# Canonical requirement and document migration
<!-- budget: 4096 bytes, hard -->

Decision: [ADR-0048](../../../design/adr/0048-canonical-plugin-requirement-catalog.md).
The [catalog](../../../requirements/catalog.json) retains323 original clauses,
31 native/tooling owners and226 immutable or embedded source records. Each clause
links one current owner contract.159 obsolete global specifications, duplicated
ownership tables and old SSR/runtime descriptions are removed; every removed path
has a source hash/revision and replacement route in `documents`.

Executed2026-09-26: `tools/verify.sh docs` — PASS:323 clauses,31 owners,226 sources,
47 current documents;190 verified,37 superseded,96 pending review at this checkpoint.
The command validates source blobs against git, original functional ID coverage,
owner/contract existence, proof metadata, document dispositions, links and budgets.
This checks documentation consistency, not completion of unresolved functionality.

Independent reviews: [runtime and integrations](runtime-review.json),
[procurement](procurement-review.json). These are checkpoint observations with exact
source/evidence scope; current live status belongs to the catalog. Fresh kernel
acceptance outputs are retained alongside them. Historical mechanics can be
superseded only with the retained user outcome recorded; compatible missing work
remains open. Public acceptance is explicitly distinguished from local native/GUI
results and loopback protocol fixtures.

Current role guides, architecture boundaries and evidence navigation replace the
old global FR/AC/coverage tables. Three repository skills and project AGENTS now
point to owner contracts and ignored recovery files. Each skill passed
`tmp/skill-validator-env/bin/python /workspace/runtime/code-server/home/.codex/skills/.system/skill-creator/scripts/quick_validate.py <skill-directory>`.
The parent workspace rules were unchanged. Accepted ADR bodies remain historical
records; only their index and new additive decisions change.
