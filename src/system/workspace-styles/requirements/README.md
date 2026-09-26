# Workspace styles
<!-- budget: 4096 bytes, hard -->

Owner: native `code/index.mjs`, `client/styles.jsx` and `client/styles.css`; generic host/core wiring is supplied by WebUI. This plugin owns visual workspace preferences and navigation hierarchy, not quotation behavior.

Requirements:
- Account-owned settings ID `workspace-styles` with Focus, Balanced and Classic layouts; Calm, Ocean and Warm light palettes; comfortable/compact spacing. Administrator preferences also remain private. Generic settings and a visual Workspace style page edit the same values.
- Focus and Balanced start at the registered `agent` page. Classic starts at `workspace` for clients and `admin` for administrators. Explicit deep links remain authoritative; a missing destination falls back through the generic shell.
- Focus uses on-demand assistant access; Balanced/Classic permit a persistent desktop assistant alongside records. The agent page suppresses a duplicate assistant through page metadata. The plugin uses only reversible `app.registerPresentation` effects; generated theme colors retain their shell precedence.
- Plugin-owned navigation groups authorized pages into everyday agent work, quotation work, sources/connections, personalization and administration. Current groups expand on navigation. Unknown contributed pages stay accessible under More tools. Keyboard-operable disclosure buttons expose expanded state.
- Every backend registration uses `ctx.effect`; frontend slots are gated by the native `workspace-style` navigation contribution. Unloading removes grouped navigation, style effects and account/header controls; saved preferences remain for deliberate re-enable.

API: `GET /workspace-style` returns `{preferences,presets}`. Preferences save through the existing `PATCH /settings/workspace-styles` route, producing `settings/config-saved` account events. `ctx.workspaceStyles.get(user)` exposes the same settings to trusted runtime code. Preferences are not added to model context by this plugin.

Acceptance and executable evidence:
1. `node src/system/workspace-styles/tests/smoke.mjs`: native Cordis + real persistent store/settings; defaults, validation, account/admin isolation, restart persistence, schema/routes/nav disposal, guide role/progress isolation.
2. `BASE_URL=http://127.0.0.1:8620/quotagent/ node src/system/workspace-styles/tests/browser.mjs`: GUI layout/palette/spacing save and reload, account isolation, navigation reachability, role tours/Help links, responsive screenshots. Public base URL runs the same interaction proof after integration.

These are acceptance targets until the commands have run; reports record actual results. Source API contract: `docs/product/runtime-contract.md`; shell extension contract agreed in the Sept26 parent-agent task, with generic implementation in `src/system/webui/client/core.jsx`.

Lifecycle browser: `BASE_URL=http://127.0.0.1:8620/quotagent/ node src/system/workspace-styles/tests/lifecycle-browser.mjs` disables/re-enables only these two native plugins through admin GUI and verifies removal/restoration of client effects. Saved account choices/progress remain.
