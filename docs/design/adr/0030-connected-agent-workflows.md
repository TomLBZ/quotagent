# ADR-0030 Connected services and reviewable agent workflows
<!-- budget: 6144 bytes, hard -->
Status: accepted

## Problem

The current product can ingest exported files and execute a conversational tool loop,
but its native composition has no usable mailbox connection, remote MCP/A2A access or
persistent multi-agent workroom. The historical mail manifest exposes an operations
view rather than the product's send/receive experience. These gaps prevent the agent
from coordinating real quotation work without the user leaving the application.
Sources: `host/product.mjs`, `src/system/mail/code/index.mjs`,
`src/system/agent-runtime/code/product-assistant.mjs`; user objective 2026-09-25.

## Decision

Add native mail, Telegram, agent connections, action center, notifications and agent
workflow capabilities with plugin-owned interfaces and settings. Reuse current
configuration/file/procurement services. Keep mail/chat credentials account-local,
including administrators; dynamic connection settings carry owner identity. Existing
shared model defaults keep their current inheritance semantics.

All agent-initiated external sends and effectful remote tool/task requests become
frozen, durable action proposals. Only an authenticated human review endpoint executes
an approved proposal. Store decisions and receipts; interrupted ambiguous sends are
not automatically retried. Remote content has no authority to approve its own actions.
Manual workflows use the same reviewed action path. Generic notifications link results
and requests to their owning feature pages.

Use official current MCP and A2A SDKs and documented HTTP bindings. Preserve remote
identity, task state and artifacts rather than replacing protocols with bespoke mock
endpoints. Local test services prove transport behavior without real third-party sends.
No full workspace or private cost context is implicitly exported.

Multi-agent runs use actual planning, isolated role contexts, dependency-aware parallel
steps and synthesis. Plans, questions, tools, source references and results are durable
and visible; human checkpoints can pause/resume execution. Recover interrupted runs
paused. Explicit memories are user editable and carry provenance; model suggestions
require acceptance before influencing future requests.

A runtime policy module separates trusted instructions from external data and enforces
role, account and tool-effect restrictions. Prompts complement these controls. Claims
are limited to verified resistance properties, not universal prompt-injection immunity.
Sources: [connected-agent contract](../../product/connected-agent-contract.md),
[OWASP guidance](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html).

New event families are additive application records through the existing store. This
ADR changes no ledger/QEP kernel formats or previous event semantics. Registrations,
connections, polling, model requests and workers belong to disposable Cordis contexts.

## Consequences

Positive: users work with real incoming material and external tools inside the same
quotation workspace; delegation remains inspectable, recoverable and reviewable.

Negative: protocols, network failures and credentials add operational complexity;
external service availability cannot be guaranteed. Human review adds an intentional
step before effects. Delivery can be uncertain after a network interruption, requiring
user inspection rather than a potentially duplicate automatic retry. Model safeguards
remain imperfect, so direct action and memory boundaries are indispensable.

## Alternatives rejected

| Alternative | Reason |
|---|---|
| Show historical mail as active without integrating it | Does not give users functional settings or inbox/send workflows |
| Give the model raw send/approve/write APIs | External text could trigger irreversible effects without review |
| Call deterministic scripts multi-agent orchestration | Does not provide actual delegated reasoning or adaptive work |
| Concatenate mail/remote prompts into system instructions | Promotes external content into app authority |
| Make all account connections inherit admin secrets | Mixes independent inbox/chat realms |
| Replace ledger/kernel semantics for new protocols | Unnecessary; additive plugin-owned state is sufficient |

## Revisit conditions

Revisit transport bindings when official protocol/SDK behavior changes, add OAuth or
stdio when required by concrete deployments, and revisit automatic execution policies
only with explicit scoped authorization and measured workflow needs. Reassess memory
and agent concurrency limits against actual long-running quotation tasks.
