# ADR-0048 Canonical plugin requirements and current documentation
<!-- budget: 8192 bytes -->
Status: accepted

## Problem
The repository contains numbered design documents, archived global FR/AC tables, implementation plans and historical SSR instructions that contradict the native React/Cordis product. The September26 audit located323 historical, supplemental and nonfunctional clauses across214 source documents. Ownership counts were previously mistaken for implementation completion. The user explicitly requires removing obsolete information and completing all compatible missing functionality.

## Decision
`docs/requirements/catalog.json` becomes the canonical migration/disposition index. Every audited clause retains its original text/source location, an immutable source revision, current plugin owner, disposition, implementation status, acceptance command and evidence references. Compatible outcomes remain open until demonstrated; obsolete mechanics receive an explicit reason and replacement reference. Historical IDs remain stable trace keys, not a requirement to execute obsolete CLI/SSR gates.

Current, detailed functional specifications live with their owning native plugins under `requirements/`. The catalog links them and records which exact source clauses they cover. Documentation is organized as product usage (`docs/product`), architecture/decisions (`docs/design`), requirement traceability (`docs/requirements`), and executable evidence (`docs/work/evidence`). Current handover/progress/session recovery files remain ignored. Git history retains removed plans, old design and historical evidence; source references remain resolvable to their immutable revision. Accepted ADR bodies retain their history; supersession is additive.

Repository documentation checks validate the catalog's ownership, dispositions, source references and real evidence paths, plus current document links and declared budgets. They do not require deleted global FR/AC tables, obsolete task archives, fixed screenshots or SSR shapes. Verification remains proportionate to actual product behavior, as required by the user's feature-first instruction. Current plugin lifecycle checks must reflect independent installed-runtime ownership and actual native dependencies.

The original user requirements and all323 audit clauses remain visible even while work is incomplete. An index assigning every clause an owner does not establish that every clause is passed. Protocol kernels, ledger semantics, human review and realm boundaries do not change through documentation cleanup.

## Consequences
Readers can locate one current specification and its observed evidence without traversing competing historical contracts. Machine consumers can distinguish open work, implementation and acceptance. Repository-only historical modules remain labelled as such until separately removed; their old checks do not establish current product capability. Git is required to retrieve removed historical text, using catalog source revisions.

## Alternatives rejected
| Alternative | Reason |
| --- | --- |
| Keep all old documents with banners | Preserves contradictory instructions and makes discovery harder. |
| Declare every plugin-owned requirement complete | Confuses responsibility with tested behavior. |
| Copy old FR/AC tables into another global table | Recreates duplicate specifications and ties product progress to obsolete mechanics. |
| Delete old requirements without mapping | Loses compatible functional promises. |

## Revisit conditions
Extend the catalog schema if new domains need richer acceptance metadata; preserve clause identity, one functional owner and the distinction between observed and unverified outcomes.
