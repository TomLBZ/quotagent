# Current product architecture
<!-- budget: 12288 bytes, hard -->

The current product is composed by [host/product.mjs](../../host/product.mjs) from
native Cordis plugins. Plugins own routes, services, assistant tools and frontend components. React renders a generic shell and registered feature pages.
Implementation scope is described here; public-browser acceptance is recorded
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
| `system/settings` | [service](../../src/system/settings/code/index.mjs), [forms](../../src/system/settings/client/settings.jsx) | Schema registration, global defaults and account overrides, masked credentials, persisted preferences and generic config UI |
| `system/plugin-manager` | [manager](../../src/system/plugin-manager/code/index.mjs), [catalog](../../src/system/plugin-manager/client/manager.jsx) | Native fiber inventory including children, repository-only catalog, persisted real enable/disable and dependencies |
| `system/file-store` | [service](../../src/system/file-store/code/index.mjs) | Account-owned immutable uploads, downloads and ledger-backed metadata |
| `domain/ingestion` | [service](../../src/domain/ingestion/code/index.mjs), [workspace](../../src/domain/ingestion/client/ingestion.jsx) | Upload, source preview, column mapping, editable extracted lines and private procurement draft import |
| `domain/ingestion-engines` | [engines](../../src/domain/ingestion-engines/code/index.mjs) | Five individually mounted parsers: email, Excel, CSV/TSV, documents and optional live AI extraction |

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

The signed-in user's confirmation appends `procurement/human-approved` before business
writes; this does not implement the historical multi-approver queue. Negotiation messages are nonbinding context;
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

Extraction consumes pasted text and uploaded files. Traditional engines preserve rows,
text and email attachments; the optional AI engine uses the actual source and records
its extraction request/output. Users review and edit lines before creating a private
RFQ or quote. Supplier imports reconcile RFQ item identity, quantities, units and
currency; costs stay private. See the [ingestion contract](plugin-workspace-contract.md).
Saved skills run on demand. Live inbox sync, scheduled skills and scanned-document
OCR are outside the [current composition](../../host/product.mjs).

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
so the author's original extension retains its own lifecycle. Origin lineage is the
identity for installed state and UI selection. One instance per account/global scope
is active; enabled personal copies take precedence over global defaults. Older duplicate
records are retained and unloaded. Editable theme colors, widget content, utility inputs
and skill instructions remount their effects through Cordis. Client accounts cannot
make system-wide changes. Pure utility code can implement new calculations and data
transformations; adding arbitrary frontend dependencies or server integrations is
outside the supported generation surface.

## Plugin settings, inventory and files

The configuration plugin owns schema forms and persistence. Non-secret values append
`settings/config-saved` to the appropriate realm. Credentials live in its private file,
are masked in UI responses and do not enter model prompts. Account overrides inherit
global defaults; changing a personal AI endpoint requires an account-owned key. The
provider consumes effective settings on every request. Settings and admin inventory have
independent navigation, so disabling Studio does not remove its re-enable controls.
Sources: [settings](../../src/system/settings/code/index.mjs),
[provider](../../src/system/agent-runtime/code/product-ai.mjs),
[manager](../../src/system/plugin-manager/code/index.mjs).

The manager lists mounted native fibers and their named children. Repository manifests
that are not mounted are explicitly labelled repository-only; historical mail transport
is not presented as a running inbox. Email file ingestion is an active, separate engine.
File bytes are account-owned, content-addressed and checked against their recorded hash.
Parsed source and reviewed results are ledger facts; deletion from the library preserves
prior provenance. Source: [file store](../../src/system/file-store/code/index.mjs).

## Current scope and historical requirements

[ADR-0027](../design/adr/0027-agentic-product-composition.md) records the new composition
and separate administrator experience; [ADR-0028](../design/adr/0028-generated-personal-utility-code.md)
adds model-authored pure utility code. The [requirements map](plugin-requirements.md)
retains ownership of earlier requirements without asserting feature parity. Historical
`docs/design/`, `docs/work/` and old runtime evidence explain earlier stages, including
the previous panel UI and deterministic harness. Those checks are not evidence for
the new React experience.

The requirements map assigns all 166 historical definitions to owners; mounted
capabilities and acceptance are recorded separately.

Current acceptance is the public workflow in [runtime-contract.md](runtime-contract.md).
Real-provider and lifecycle smoke evidence is local under `tmp/product-evidence/`;
it does not substitute for the independent end-to-end browser evaluation.
