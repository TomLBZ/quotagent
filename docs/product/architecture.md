# Current product architecture
<!-- budget: 12288 bytes, hard -->

The current product is composed by [host/product.mjs](../../host/product.mjs) from
native Cordis plugins. Each plugin owns its routes, services, assistant tools, and
frontend components. React renders a generic shell and registered feature pages.
This document describes implementation scope; public-browser acceptance is recorded
separately against the [runtime contract](runtime-contract.md).

## Source map

| Plugin | Backend and frontend sources | Responsibility |
|---|---|---|
| `system/webui` | [server](../../src/system/webui/code/product-server.mjs), [React registry and shell](../../src/system/webui/client/core.jsx) | Generic HTTP routing, session resolution, navigation, contribution registry, UI components, static files |
| `system/accounts` | [service](../../src/system/accounts/code/product.mjs), [account pages](../../src/system/accounts/client/accounts.jsx) | Persistent email/password accounts, one client role, separate admin, profile settings and permission management |
| `domain/procurement` | [service](../../src/domain/procurement/code/service.mjs), [routes/tools](../../src/domain/procurement/code/index.mjs), [pages](../../src/domain/procurement/client/procurement.jsx) | RFQs, supplier quotes/private costs, comparisons, messages, human-confirmed awards/orders, changes and CSV export |
| `system/agent-runtime` | [provider](../../src/system/agent-runtime/code/product-ai.mjs), [assistant](../../src/system/agent-runtime/code/product-assistant.mjs), [assistant UI](../../src/system/agent-runtime/client/assistant.jsx) | Actual model requests, account conversations, current workspace context, remembered preferences and registered tool execution |
| `system/plugin-studio` | [studio](../../src/system/plugin-studio/code/product.mjs), [utility runtime](../../src/system/plugin-studio/code/tool-runtime.mjs), [studio UI](../../src/system/plugin-studio/client/studio.jsx) | Model-authored utility code, real Cordis child plugins, load/unload, skills, publication, installation and admin promotion |
| `system/workspace-store` | [Node service](../../src/system/workspace-store/code/index.mjs), [Python adapter](../../src/system/workspace-store/code/bridge.py) | Append-only account facts, replayable projections, and public record exchange using existing kernels |

The [launcher](../../run) owns process startup, shutdown, build, status and diagnostics.
The host contains plugin composition rather than procurement behavior. Dependency
versions and frontend build scripts are in [host/package.json](../../host/package.json).
The [client composition](../../host/client.mjs) imports plugin-owned React pages into
the shell's component registry. These bundled pages build with Vite. User-generated
extensions register runtime descriptors and utility code through Cordis; they do not
rewrite the bundled frontend source.

## Accounts, data and business actions

The accounts plugin stores password hashes and sessions outside the ledger. Public
contact listings contain identity fields; private preferences stay on the account.
Settings select one client type. The separate administrator account manages users,
capability restrictions and global extensions. Account permission flags are resolved
through `accounts.can(user, capability)`; generic routes consume capability metadata.
Source: [accounts service](../../src/system/accounts/code/product.mjs).

Business plugins append records through `store.put()` and reconstruct their current
state from ledger events. Each account ID is its own realm. Explicit public records
travel through `store.exchange()`; supplier costs and private notes are excluded
before exchange. The adapter imports the existing
[Ledger](../../src/system/kernel/code/ledger.py) and
[QEP](../../src/system/kernel/code/qep.py) implementations. It does not change their
format or protocol semantics. Sources: [adapter](../../src/system/workspace-store/code/bridge.py)
and [procurement service](../../src/domain/procurement/code/service.mjs).

The procurement service owns both HTTP actions and assistant-facing tools. Tools can
save private drafts and prepare review actions. The user confirms external business
commitments through the corresponding client workflow; an assistant tool does not
confirm them. Sources: [tools](../../src/domain/procurement/code/index.mjs) and
[action implementation](../../src/domain/procurement/code/service.mjs).

The confirmation records the current signed-in user's decision as
`procurement/human-approved` before the corresponding business writes. It is the
current product's approval interaction; older multi-approver queue acceptance is
not implied by this implementation. Negotiation messages are nonbinding context;
changed commercial terms become effective through an approved quote/order workflow.

## Operational assistant

The provider reads the configured chat-completions endpoint and issues actual model
requests. It appends the complete request, response or failure to the user's ledger.
The assistant includes the current account's workspace and preferences, then runs
registered tools in a bounded conversation loop. Conversations and tool results are
durable, and explicit preference updates are reflected in future turns. Sources:
[provider](../../src/system/agent-runtime/code/product-ai.mjs),
[assistant](../../src/system/agent-runtime/code/product-assistant.mjs), and
[accounts](../../src/system/accounts/code/product.mjs).

This is the first AI benefit: understanding information and preparing useful work
inside the procurement process. It depends on provider availability. No deterministic
rule result is presented as an actual model response.

Current extraction consumes pasted text. Saved skills run when the user chooses
Run skill, with the assistant's existing tools and current workspace context. There
is no scheduled skill runner, external inbox ingestion, or document OCR plugin in
the [current host composition](../../host/product.mjs).

## Personal extensions and reusable skills

The second AI benefit is customization. The studio asks the real provider for a
descriptor of one supported type:

| Type | Current supported behavior |
|---|---|
| Theme | Accent, background, surface, text colors and corner radius |
| Reference widget | Personal title, body and optional reference list; it does not invent live metrics |
| Workflow skill | Saved instructions and steps, executed as a new assistant turn with current account context |
| Executable utility (`calculator`) | Model-authored JavaScript function with number/text inputs and JSON results; can calculate, transform text or read the caller's account snapshot |

The descriptor is compiled into an executable `.mjs` module whose `apply(ctx)`
registers `ctx.web.extension(accountId, descriptor)` through `ctx.effect()`. A real
Cordis child fiber owns the effect. Unload disposes it; startup reconstructs enabled
plugins from stored records. Artifacts live beneath the runtime data directory;
skills additionally have `SKILL.md`. Source:
[studio generation and lifecycle](../../src/system/plugin-studio/code/product.mjs).

For a utility, the model supplies the entire JavaScript implementation in `spec.code`.
Its Cordis artifact also registers that function with `studioRuntime` through a second
effect. The runtime executes the generated source against user inputs and a copy of
the calling account's current procurement snapshot in `node:vm` with a time limit.
The platform contains no calculator formulas. Execution is synchronous and returns
JSON; the runtime supplies no filesystem, network, or business-write interface. The
default execution limit is 750 ms, with up to 24 number/text input fields. Runtime
errors are surfaced to the user; generated formulas are reviewable source rather
than a claim of guaranteed correctness. Sources:
[utility execution](../../src/system/plugin-studio/code/tool-runtime.mjs).

Publishing makes a descriptor available in the marketplace. Installing makes an
independent personal copy. Administrator promotion makes an independent global copy,
so the author's original extension retains its own lifecycle. Client accounts cannot
make system-wide changes. Pure utility code can implement new calculations and data
transformations; adding arbitrary frontend dependencies or server integrations is
outside the supported generation surface.

The narrow [live utility demonstration](../../src/system/plugin-studio/tools/live-utility-check.mjs)
uses an actual generated landed-cost implementation. It verified two input sets
(totals 1,235.85 and 441.00), caller-specific workspace reads, publication/installation,
global promotion and removal of both effects on unload. Evidence command:
`node src/system/plugin-studio/tools/live-utility-check.mjs`; output is recorded in
`tmp/product-evidence/generated-utility-live.json`. This is backend execution evidence,
separate from public-browser acceptance.

## Current scope and historical requirements

[ADR-0027](../design/adr/0027-agentic-product-composition.md) records the new composition
and separate administrator experience; [ADR-0028](../design/adr/0028-generated-personal-utility-code.md)
adds model-authored pure utility code. The [requirements map](plugin-requirements.md)
retains ownership of earlier requirements without asserting feature parity. Historical
`docs/design/`, `docs/work/` and old runtime evidence explain earlier stages, including
the previous panel UI and deterministic harness. Those checks are not evidence for
the new React experience.

All 166 historical definition rows are mapped to one owning plugin, with no missing
or duplicate assignment. The requirements map separates that ownership inventory
from the mounted product capabilities and their acceptance evidence.

Current acceptance is the public workflow in [runtime-contract.md](runtime-contract.md).
Real-provider and lifecycle smoke evidence is local under `tmp/product-evidence/`;
it does not substitute for the independent end-to-end browser evaluation.
