# Application plugin management
<!-- budget: 4096 bytes, hard -->

The administrator sees registered runtime plugins, named Cordis child plugins, and
all repository `src/**/plugin.json` manifests. These categories have distinct active,
disabled, and available statuses; availability does not imply runtime compatibility.
Generated personal/global artifacts and execution belong to Installed plugins;
Plugin Studio owns creation and evaluated revisions.

The host registers actual modules, fibers, dependencies, and configuration schema IDs
with `ctx.plugins.register`. Its disposer removes the registration. Lifecycle controls
call real Cordis plugin mount/disposal, persist enablement under the product data root,
and block disabling providers with active dependent plugins. The host consults
`ctx.plugins.enabled(id)` on startup and registers disabled modules for later activation.
Required web/store/accounts/settings/manager services stay active with an explanation.
Named child plugins are inspected from Cordis's live registry and controlled through
their registered parent. Configuration links appear only for a settings schema the
administrator can access; raw configuration values and credentials are never listed.

API: admin `GET /plugins`; `POST /plugins/:id/enable` or `/disable`. IDs are slash-free.
The historical mail adapter is shown separately from current email ingestion.
Implementation: [code/index.mjs](../code/index.mjs). Narrow lifecycle evidence:
`node src/system/plugin-manager/tools/lifecycle-check.mjs`.

Clients request administrative help in Account settings; the administrator sees
the capability inbox above Application plugins. See [capability requests](capability-requests.md)
for native permissions, lifecycle resolution and guidance receipts.
