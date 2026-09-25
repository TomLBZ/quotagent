# Plugin settings
<!-- budget: 4096 bytes, hard -->

Owns schema registration, global defaults, per-account overrides and private credentials.
Implementation: `code/index.mjs`. Each schema registration returns a disposer; non-secret
versions are ledger records (`settings/config-saved`, collection `plugin-settings`).
Credential persistence is separate and masked in every HTTP view. Effective values
are read by the owning plugin, not merely displayed in a form. Reset restores inherited
defaults; blank password fields preserve existing credentials and explicit clearing is
separate. UI consumers use GET/PATCH `/settings/:id` and GET `/settings`.

Current integration: AI provider credentials/model/endpoint/timeout, assistant language,
response length and working preferences, WebUI refresh/upload limits and ingestion
preferences. `node src/system/settings/tools/live-check.mjs` verifies masking, inheritance,
provider consumption and account separation against a running product instance.
