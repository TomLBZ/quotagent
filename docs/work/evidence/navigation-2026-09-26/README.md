# Workspace navigation evidence
<!-- budget: 4096 bytes, hard -->

Owner `system/webui`; declared page context and commands belong to their plugins.
Specification: `src/system/webui/requirements/navigation.md`.

Executed 2026-09-26, exit 0:

- `BASE_URL=http://127.0.0.1:8649/quotagent/ node src/system/webui/tests/navigation-browser.mjs`: [five groups PASS](gui-local.json). Ctrl+K search, actual Help topic link/reload/back/forward, access explanation, client/admin availability, plugin command, inert modal background, both focus-wrap directions, Escape/focus restoration and supplier navigation.
- `node host/node_modules/vite/bin/vite.js build --config src/system/webui/client/vite.config.mjs --outDir /workspace/projects/quotagent/tmp/agent-experience/navigation-build`: 78 modules PASS including concurrent integration changes.

Zero JavaScript errors; screenshot inspection confirms 390px command palette has
no page overflow and a 44px close target. Screenshots remain in ignored
`tmp/product-evidence/navigation/local/`. This is local evidence; public release
and each business plugin's specific object links are verified separately.
