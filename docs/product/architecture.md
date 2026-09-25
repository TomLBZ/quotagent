# Current product architecture
<!-- budget: 12288 bytes, hard -->

The current product is composed by [host/product.mjs](../../host/product.mjs) from
native Cordis plugins. Plugins own routes, services, assistant tools and frontend components. React renders a generic shell and registered feature pages.
Public acceptance follows the [runtime contract](runtime-contract.md).

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

| `system/mail` | [service](../../src/system/mail/code/product.mjs), [transport](../../src/system/mail/code/product-transport.mjs), [inbox](../../src/system/mail/client/mail.jsx) | Account IMAP sync, SMTP, drafts/replies, attachments and agent tools |
| `system/telegram` | [service](../../src/system/telegram/code/product.mjs), [client](../../src/system/telegram/client/telegram.jsx) | Bot messages/files, reviewed sending and opted-in generic activity reminders |
| `system/agent-connections` | [service](../../src/system/agent-connections/code/index.mjs), [protocols](../../src/system/agent-connections/code/protocols.mjs), [client](../../src/system/agent-connections/client/connections.jsx) | MCP discovery/tools/resources/prompts and A2A tasks/messages/artifacts |
| `system/action-center` | [service](../../src/system/action-center/code/index.mjs), [client](../../src/system/action-center/client/actions.jsx) | Frozen proposals, human decisions, durable receipts and uncertain execution recovery |
| `system/notifications` | [service](../../src/system/notifications/code/index.mjs), [client](../../src/system/notifications/client/notifications.jsx) | Account activity inbox, header indicator, linked navigation and listeners |
| `system/agent-workflows` | [engine](../../src/system/agent-workflows/code/engine.mjs), [memory](../../src/system/agent-workflows/code/memory.mjs), [workroom](../../src/system/agent-workflows/client/workroom.jsx) | Actual planner/specialist/synthesis calls, human input, durable run state, traces and explicit memory |

The [launcher](../../run) owns process startup, build and diagnostics. [host/client.mjs](../../host/client.mjs) imports plugin React contributions for Vite. User-generated extensions register runtime descriptors and utility code through actual Cordis fibers. Dependencies are pinned in [host/package.json](../../host/package.json).

## Accounts, data and reviewed actions

Each account has one client role; a separate admin manages accounts and global extensions. Generic routes consume capability metadata from `accounts.can`. Source: [accounts service](../../src/system/accounts/code/product.mjs).

The [store adapter](../../src/system/workspace-store/code/bridge.py) reuses existing Python Ledger/QEP kernels without changing their semantics. Account IDs are realms. Plugins append complete versions through `store.put`; explicit public procurement records cross realms through QEP. [Procurement serializers](../../src/domain/procurement/code/service.mjs) exclude supplier costs and private notes.

Manual procurement commitments require human confirmation and append `procurement/human-approved`. Agent proposals use the action center: immutable request, originating run, decision, executor outcome and destination link. Plugin-owned preview slots make exact requests readable. A stale draft or commitment is refused by its owning executor. Concurrent/repeated approval does not repeat a completed action; interrupted delivery becomes uncertain without automatic retry. Sources: action-center and procurement modules above.

## Operational agents and memory

The provider issues real chat-completions requests and records complete model input/output in the account ledger. Chat and workroom specialists share [assistant.invoke](../../src/system/agent-runtime/code/product-assistant.mjs) and [agent policy](../../src/system/agent-runtime/code/product-policy.mjs). Tool definitions carry effect and source metadata. Delegates receive read/private-draft/proposal tools; they have no approval tool. Unknown writes remain unavailable to delegates. Chat writes derived from external source content use an explicitly registered proposal callback or are refused.

Trusted app instructions are separate from account/source data. External mail, documents, remote prompts and tool/agent results retain their provenance and are treated as data. Effect checks, human action execution and memory acceptance are code boundaries. Suspicious-text warnings aid review; this does not assert model immunity to all prompt injection.

The workroom calls a real planner, preserves distinct specialist conversations, runs ready independent tasks concurrently and synthesizes their reports. Users review a plan, answer queued questions, pause/resume/cancel and give feedback. Ledger records retain runs, agent identities, task states, tool results, reports and decisions. Interrupted runs recover paused; incomplete tool turns are repaired before explicit resume. Visible traces expose inputs/results rather than hidden chain-of-thought. Source: workroom engine above.

The memory service owns inspectable, editable and archivable facts/preferences with source and revision history. Model suggestions wait for human review. Existing preferences are imported with legacy provenance and stable IDs; archiving prevents re-import. Only active explicit memory enters later assistant/workroom context. Account settings renders a plugin-owned memory card. Source: memory and workroom client above.

## Connected services and information intake

Mail uses ImapFlow and Nodemailer for real IMAP/SMTP. It retains source MIME, deduplicates by connection/mailbox/UID identity and saves attachments through file-store. Telegram uses Bot API polling with durable update cursor, reviewed sends and optional generic notifications to a user-configured chat. Their settings are account scoped, including for admin, with masked credentials and no shared-token inheritance. Polling/sockets/listeners abort on unload. SMTP acceptance is not a delivery/read guarantee.

Agent connections uses official MCP and A2A SDKs. Supported MCP transports are Streamable HTTP and explicit legacy SSE; tools/resources/prompts are discoverable and available to chat. Remote operations create exact-input review proposals by default. A2A retains task/context/message IDs and supports input-required continuation, status/artifacts and cancellation. Discovery/metadata remain external data. [Connection requirements](../../src/system/agent-connections/requirements/functional.md) specify verified protocol versions and limits; no stdio launching, OAuth consent, gRPC or push-webhook subscription is implied.

Files and attachments enter the [ingestion workspace](../../src/domain/ingestion/code/index.mjs). Traditional parsers preserve rows/text; optional live AI extracts unstructured sources. Users review editable lines before private RFQ/quote import. Supplier imports reconcile item identities and retain private costs. OCR and scheduled skills are outside this composition.

## Personal extensions and plugin management

The studio's real model generates themes, reference widgets, reusable skills and executable utilities. Artifacts register account-specific UI/effects through Cordis and survive restart. Skills execute a new assistant turn; generated utilities are bounded pure JavaScript with number/text inputs, JSON outputs and caller workspace context. The utility runtime offers no filesystem, network or business-write interface. Source: [studio](../../src/system/plugin-studio/code/product.mjs) and [utility runtime](../../src/system/plugin-studio/code/tool-runtime.mjs).

Publishing, independent personal installation and independent global promotion preserve source and lineage. One active instance per account/global scope is selected; personal copies take precedence. Unload disposes effects, while reconfiguration remounts them. Client accounts cannot change global plugins. Arbitrary generated server integrations are outside this generation surface.

Settings schemas own their fields and validators. Ordinary user schemas can inherit admin defaults; account connection schemas use only built-in defaults and the current account's values/secrets. Credentials do not enter model context. Dynamic schemas can restrict ownership. Sources: [settings](../../src/system/settings/code/index.mjs), [plugin inventory](../../src/system/plugin-manager/code/index.mjs). Inventory exposes actual native fibers/children, dependencies and enable/disable controls; unmounted historical manifests are labelled repository-only.

## Scope and evidence

[ADR-0027](../design/adr/0027-agentic-product-composition.md), [ADR-0028](../design/adr/0028-generated-personal-utility-code.md), [ADR-0029](../design/adr/0029-configurable-plugin-workspace.md) and [ADR-0030](../design/adr/0030-connected-agent-workflows.md) record the composition changes. The [requirements map](plugin-requirements.md) preserves all 166 historical owners without claiming feature parity. Historical runtime/panel tests are not evidence for the React product. Current acceptance is defined by the [runtime](runtime-contract.md), [plugin workspace](plugin-workspace-contract.md) and [connected agent](connected-agent-contract.md) contracts and their public GUI evidence.
