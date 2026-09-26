# Requirement traceability
<!-- budget: 4096 bytes, hard -->

[The catalog](catalog.json) indexes all 323 clauses from the September 26 audit:
166 historical functional, 127 supplemental/current/visual, and 30 nonfunctional clauses.
Each has one current plugin owner, original text, immutable source reference,
disposition, current contract and acceptance state. This is ownership and traceability,
not a claim that 323 requirements have passed.

Detailed functionality belongs to the plugin contract linked by each row. Historical
source mechanics can be superseded while their compatible outcome remains required.
Numerical assumptions are labelled, measured and limited; they are not fabricated
performance guarantees. `pending-review` means current acceptance still needs an
exact clause review, even when earlier source or evidence exists.

The `sources` map preserves original file hashes and git revisions. Retrieve a
removed source with `git show <revision>:<path>` or its immutable GitHub link. Session
requirements that were deliberately never committed retain their source text in the
catalog. The `implementation.auditStatus` fields record the starting audit only.

Run `python tools/check-docs.py` to validate structure and print state counts. A
`verified` row needs executable command, retained evidence, scope and an explanation
of the observed outcome. A local native result does not mean a public journey passed.
See [evidence](../work/evidence/README.md) for release-specific results and limitations.
