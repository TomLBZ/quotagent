# Installable offline shell evidence
<!-- budget: 4096 bytes, hard -->

Owner `system/webui`, ADR-0042 and `requirements/offline.md`. Executed
2026-09-26, exit0:

- `BASE_URL=http://127.0.0.1:8651/quotagent/ node src/system/webui/tests/offline-browser.mjs`: [four groups PASS](gui-local.json). Settings opt-in, activated worker, valid standalone manifest with192/512icons and zero Chromium installability errors; actual network disconnection rejects a GUI write; offline reload starts only the empty shell; reconnect reads the unchanged profile; removal unregisters and clears the owned cache.
- Integrated Vite build80 PASS. Zero JavaScript errors and no390px horizontal overflow.

The cache inventory contains exactly six static entries and no API, account, file
or business data. A browser network indicator can remain online during a cached
reload; the fallback HTML carries an explicit offline-shell marker until a real
API response succeeds. No failed write is queued or replayed. Screenshot inspection
confirms the offline warning and unavailable identity/work state.

This proves headless browser installability, not an operating-system installation.
Public release replay remains separate. Raw screenshots in ignored
`tmp/product-evidence/offline/local/`.
