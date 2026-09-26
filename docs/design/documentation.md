# Documentation structure
<!-- budget: 4096 bytes, hard -->

The project rules remain solely in [AGENTS.md](../../AGENTS.md). This page describes
where documentation lives and how its consistency is measured; it does not add a
separate approval policy.

| Location | Meaning |
|---|---|
| `docs/product/` | Role-oriented product use, limitations and links to functional owners |
| `docs/design/` | Current architecture and boundaries |
| `docs/design/adr/` | Accepted decision history; later changes use a new decision |
| `docs/requirements/catalog.json` | Clause provenance, sole current owner, disposition and observed acceptance |
| `src/<layer>/<plugin>/requirements*` | Detailed current plugin-owned functional contract |
| `docs/work/evidence/` | Command, observed result, revision/scope and artifacts |
| Ignored `.agents/` state and `docs/work/handover.md` | Active recovery instructions, never a completion claim |

The catalog is an index, not another global functional specification. Original
clauses and immutable source revisions remain traceable even when obsolete documents
are removed. Compatible outcomes stay open until their actual acceptance is
recorded. Superseded implementation mechanics name a replacement and reason.

Current Markdown declares a byte budget near its head. Default maximum is8192bytes;
a focused larger contract may declare16384bytes. Root README/AGENTS remain4096bytes;
handover remains1024bytes. Catalog JSON declares its own bounded budget. Evidence
artifacts retain actual data and do not acquire arbitrary prose quotas. Historical
accepted ADR bodies are retained as decision history rather than rewritten to fit a
new editorial shape.

`tools/verify.sh docs` checks current links, declared budgets, catalog identities,
plugin ownership, source integrity and acceptance evidence paths. It reports open
requirements separately from structural validity. Passing documentation consistency
never establishes product completion. Historical fixed SSR/CLI/global-table checks
are replaced by this catalog check under
[ADR-0048](adr/0048-canonical-plugin-requirement-catalog.md).
