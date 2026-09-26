---
name: quotagent-design-note
description: Record quotagent protocol, ledger, trust, runtime or self-evolution boundary changes in an additive ADR with traceable consequences.
---

# Record a boundary decision
<!-- budget: 4096 bytes, hard -->

Read the relevant accepted decisions and current plugin contract before changing
semantics. For protocol/ledger formats, trust/key boundaries, runtime stack or
self-evolution surfaces, add the next unused `docs/design/adr/NNNN-title.md`.
Coordinate its number with concurrent agents. Ordinary wording, UI polish and
scenario data do not require a new architecture decision.

Use: Status; Problem; Decision; Consequences; Alternatives rejected; Revisit
conditions. Describe the actual boundary and observable behavior, including known
costs or limits. Keep product contracts about current behavior and put decision
history in the ADR. Accepted bodies are historical evidence: supersede additively
instead of rewriting their meaning.

Link the current owning contract and affected catalog clauses. The original source
text/revision remains in `docs/requirements/catalog.json`; a removed old document
is available through that immutable provenance. Current document structure and
budgets are described in `docs/design/documentation.md`; rules remain solely in
AGENTS.md. Run `tools/verify.sh docs` for links, budgets and trace consistency.

This skill adds no separate approval step. Apply the user's existing authorization
and project commitment boundaries to the actual action.
