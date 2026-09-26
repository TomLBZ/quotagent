# Installable application and truthful offline behavior
<!-- budget: 4096 bytes, hard -->

Native owner `system/webui`; ADR-0042. Retains SUPPLEMENT-018 from design29 §18
and the old PWA documentation without reviving its retired client/side-switching.

- Manifest: standalone launch, application scope, 192/512 icons, same-origin URLs.
- Settings: explicit device-local offline-shell enable/remove and installation
  guidance; a real browser install prompt is used only when available.
- Versioned cache: exact static build assets and empty HTML shell only. Never cache
  API/file/account data; never queue or replay writes. Removal unregisters and
  clears all cache versions owned by this application scope.
- Disconnection: distinguish offline/unreachable/connected, show last successful
  API contact and explain existing data may be stale. Offline reload does not
  invent a session or empty business data.
- Recovery: explicit retry and normal successful network response clear the
  connection warning; a cached shell cannot make an API call appear successful.

Acceptance: `node src/system/webui/tests/offline-browser.mjs` exercises Settings,
manifest/worker, actual network disconnection/reload/reconnection, cache inventory
and removal in Chromium. Recorded results state the difference between browser
installability and real operating-system installation.
