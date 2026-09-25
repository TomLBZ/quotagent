# ADR-0028 Model-authored personal utility code
<!-- budget: 8192 bytes, hard -->
Status: accepted

## Problem

ADR-0027 and the initial studio implementation compile theme/widget/skill descriptors
into Cordis effects. That does not implement a user's request for a new calculation
or data-processing function. The user goal also requires agents to develop useful
new plugin behavior. Source: `src/system/plugin-studio/code/product.mjs` before this change.

## Decision

Extend plugin-studio with a `calculator` utility kind. The real model writes a
JavaScript function `(input, workspace) => result`, together with an input-field
schema. The complete generated source is reviewable and persisted in the Cordis
artifact. The formula or transformation is generated code, not a platform template.

Each executable plugin registers its UI descriptor and callable implementation as
Cordis effects. `studioRuntime` owns callable registration and disposal. Execution
receives user inputs and only the calling account's procurement snapshot. A bounded
`node:vm` execution returns JSON data without a business-write capability. Existing
approval and ledger/QEP meanings do not change. Skills retain their assistant-driven
workflow execution.

Publication, installation and administrator promotion preserve the generated source.
Each installed/global copy has independent Cordis effects. Execution results append
to the caller's account ledger as `studio/tool-ran`.

## Consequences

Positive: users can develop custom calculators, text transformations and account-data
summaries through natural language and execute their actual generated logic.
Negative: generated code may have reasoning errors; users can inspect the source and
results. Utilities are synchronous pure functions with number/text inputs and JSON
outputs; arbitrary frontend packages, network integrations and system changes are
outside this surface. Large or nonterminating computations fail at the runtime limit.

## Alternatives rejected

| Option | Reason |
|---|---|
| Add a fixed landed-cost template | Would not implement agent-developed behavior |
| Ask the model to calculate every execution | Would not create a reusable executable plugin |
| Permit unrestricted server source mutation | Unnecessary for personal utilities and conflicts with client scope |

## Revisit conditions

Revisit if users need additional field types, asynchronous integrations, richer
interactive components or a different execution environment.
