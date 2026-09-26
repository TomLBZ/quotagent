# Administrator guide
<!-- budget: 6144 bytes, hard -->

Sign in to the separate administrator account. Administrative permission does not
grant a contractor/supplier business perspective or access to their private cost
models. Use a client account to perform that side's business work.

**People & permissions** manages account roles, deactivation and capabilities.
Changing a client's perspective changes its available workflows; saved runs retain
the role/workspace they started with. The account must start a new run when its
perspective no longer matches. Keep at least one active administrator.

**Application plugins** distinguishes active native Cordis plugins and children,
disabled managed plugins, and repository-only modules. A repository entry is not a
claim that it is loaded or compatible with this product. Disable dependents before
a provider. Required foundation services explain why their controls are unavailable.

Review client capability requests in the plugin inbox. Enable an actual required
capability where appropriate, or send a specific configuration instruction for the
requester's own credentials. A guidance message is not proof the requester completed
setup; their acknowledgement remains visible.

**Plugin studio** can inspect shared personal extensions and promote an independent
global copy. **Installed plugins** owns executing extensions; disabling Studio alone
does not remove installed tools/themes/skills. Evolution proposals retain immutable
versions, diffs, paired evidence, limits and rollback outcomes. Unknown evaluation
results are not a pass.

**Plugin settings** shows authorized schemas. Preview YAML changes before applying,
export explicit non-secret overrides, or initialize unconfigured scopes. Credentials
belong to the account supplying them; an administrator's mailbox token is not a
shared default. Failed activation records compensation and restores prior values.

**Operations & timeline** shows current workload/plugin/provider counts with
explicit account/source coverage. Download the metadata snapshot or adjust its
periodic derived output. It contains no business record bodies. Your event timeline
is your own account's metadata, not every party's ledger. **Files & retention**
provides body-free storage observations; it does not grant cross-party disposal.

For release operation use [the root run instructions](../../README.md) and retain
the exact source revision in evidence. Public acceptance uses the existing gateway
URL. No extra public host or port is part of this product deployment.

Sources: [accounts](../../src/system/accounts/requirements/README.md),
[plugin manager](../../src/system/plugin-manager/requirements/README.md),
[configuration](../../src/system/settings/requirements.md),
[operations](../../src/system/observability/requirements/native.md),
[extension evolution](../../src/system/plugin-studio/requirements/evolution.md).
