# Plugin settings
<!-- budget: 4096 bytes, hard -->

Owns schema registration, global defaults, per-account overrides and private credentials.
Implementation: `code/index.mjs` and `code/service.mjs`. Each schema registration returns a disposer; non-secret
versions are ledger records (`settings/config-saved`, collection `plugin-settings`).
Credential persistence is separate and masked in every HTTP view. Effective values
are read by the owning plugin, not merely displayed in a form. Reset restores inherited
defaults; blank password fields preserve existing credentials and explicit clearing is
separate. UI consumers use GET/PATCH `/settings/:id` and GET `/settings`.

Current integration: AI provider credentials/model/endpoint/timeout, assistant language,
response length and working preferences, WebUI refresh/upload limits and ingestion
preferences. `node src/system/settings/tools/live-check.mjs` verifies masking, inheritance,
provider consumption and account separation against a running product instance.

Connection schemas use `scope:'account'`: built-in defaults plus only this account's
values and private secrets, including for an administrator. They never inherit an
administrator's mailbox/token. Dynamic schemas may declare `ownerId`; list/view/get/save
then enforce that owner. Existing `scope:'user'` retains shared defaults for AI settings.
Evidence: `node src/system/action-center/tests/state.mjs`, and connection GUI journeys.

## Native file transactions and scoped provenance (G9)

ADR-0041 retains FR-CONFIG-001, FR-USREQ-009, FR-PLUGIN-004 and the configuration portions of audit G9. Acceptance: a GUI-generated YAML template/export round-trips non-secret explicit overrides; preview makes zero changes; invalid/unknown fields and a registered plugin veto prevent activation; failed apply restores previous values and records compensation; initialize-only import preserves existing overrides; credentials remain write-only across all outputs and restart. Every effective key exposes layer/source/patch references. Disposable domain scope providers authorize workspace/project/section targets; only explicitly opted-in schemas may inherit those layers. Account connection credentials remain private.

Evidence: `node src/system/settings/tests/transactions.mjs` (11 native groups); `node src/system/settings/tests/browser.mjs` (GUI file review/import/export/veto plus communications), recorded in [G9 evidence](../../../docs/work/evidence/g9-configuration-and-notifications.md). Failed-activation rollback is exercised natively; GUI exercises preflight rejection. Settings owns generic persistence, not business-scope access policy.

API: `preview/apply(user,{changes:[{id,values,scope,context}],previewId})`; schema `preflight` or disposable `beforeUpdate(id,hook)` may veto before writes. Reversible `onChange(next,{previous,...})` may return a rollback callback; otherwise schema `rollback(previous,...)` handles failure. `get/view(user,id,context)` expose authorized effective layers; `origins` optionally labels environment/file defaults. `PluginSettings` accepts `context` and `scope`. `QUOTAGENT_SETTINGS_INIT` selects an operator YAML bundle with `format: quotagent/settings/v1`, `ownerId`, and `settings` patches. Initialization runs once after referenced schemas load, preserves existing overrides, and surfaces status in configuration history. Credentials/journals are0600; startup recovery precedes consumers.
