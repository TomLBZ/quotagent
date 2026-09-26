# Native product architecture
<!-- budget: 8192 bytes, hard -->

The product composes native Cordis plugins and a React application. `host/product.mjs`
is composition only; `host/client.mjs` imports plugin-owned components. Pinned runtime
versions are in `host/package.json` and its lockfile. Repository-only historical
modules are explicitly distinct from mounted native plugins.

| Boundary | Functional owner and source |
|---|---|
| HTTP shell, reusable controls, navigation, collections | [WebUI](../../src/system/webui/requirements/current.md) |
| Login and single account perspective | [Accounts](../../src/system/accounts/requirements/README.md) |
| Ledger projections and QEP adapter | [Workspace store](../../src/system/workspace-store/requirements/README.md) |
| RFQ/quote/award/order/change and fulfillment | [Procurement](../../src/domain/procurement/requirements/README.md) |
| Private pricing, capacity and sourced TCO | [Commercial](../../src/domain/commercial-workbench/requirements/README.md) |
| Team membership, authority and daily work | [Teams](../../src/system/teams/requirements/README.md) |
| Human-reviewed actions and batch receipts | [Action center](../../src/system/action-center/requirements.md) |
| Provider, operational assistant, usage and evaluations | [Agent runtime](../../src/system/agent-runtime/requirements/product.md) |
| Delegated work and explicit memory | [Workroom](../../src/system/agent-workflows/requirements/README.md) |
| Customization and independent installed execution | [Extensions](extensions.md) |
| Schemas, scope providers and configuration transactions | [Settings](../../src/system/settings/requirements.md) |
| Mail, Telegram, MCP and A2A | Their plugin-owned [catalog entries](../requirements/README.md) |
| Uploads, object versions, evidence and reviewed retention | [Data and exchange](data-and-exchange.md) |
| Layout, help, isolated practice, operational metadata | Workspace-styles, user-guide, sandbox and observability plugins |

WebUI contains no procurement decision logic. Plugins register pages, slots,
commands, routes, collections, tools and state contributions. Registrations return
disposers and are owned by Cordis effects. Optional dependencies use disposable
injection; required services are declared. Plugin-manager controls actual fibers,
records enablement and rejects dependency-breaking operations.

The generic account shell displays one business role. A selected same-party
workspace requires accepted membership. Domain services distinguish the workspace
owner from the human actor; other users with the same role do not share data merely
because that role matches. The administrator is a separate account perspective.

Two AI layers are explicit. The operational assistant uses actual model calls and
recorded domain tools for drafts, interpretation, communication and recommendations.
Plugin Studio generates themes, widgets, bounded executable utilities and reusable
skills. The independent installed runtime keeps activated effects alive when optional
management unloads. Generated work cannot redefine ledger or QEP semantics.

The demo sandbox intercepts authenticated API requests before body consumption and
delegates to a separate native Cordis composition under that account's own demo
root. The child opens no listener and inherits no live credentials. Failed demo
startup remains an explicit unavailable state with exit controls; it never silently
falls back to live business data. Source: [ADR-0047](adr/0047-native-isolated-demonstration-runtime.md).

Evidence is revision-scoped. Native fixture checks establish their stated behavior;
local GUI checks do not establish public deployment, and protocol fixtures do not
measure model quality. See [executed evidence](../work/evidence/README.md).
