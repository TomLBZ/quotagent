# Current public journey fixtures
<!-- budget: 2048 bytes, hard -->

The response and attachment journeys now author scope through the ordinary request
editor before publication. They use the same declared-scope fixture helper as the
new-publication checks; no production rule is bypassed.

Executed 2026-09-26:
`BASE_URL=http://127.0.0.1:8648/quotagent/ node src/domain/response-workbench/tests/browser.mjs`
— [six GUI groups passed](responses-local.json), zero JavaScript errors.
`node --check src/system/attachments/tests/browser.mjs`,
`node --check src/system/webui/tests/offline-browser.mjs`, and
`node --check src/system/webui/tests/dashboard-browser.mjs` passed.
Their actual final public executions are pending at this harness checkpoint.

The offline check accepts the current static build’s JS chunks (including PDF
rendering) while still requiring shell/manifest/icons and excluding all API data.
It no longer freezes the obsolete exact six-file bundle. The dashboard journey
clicks the existing Projects & routes entry and checks that discovery comes from
the deployed service’s own route description. It creates no gateway or host.
