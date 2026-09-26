# Role guides and in-app Help
<!-- budget: 4096 bytes, hard -->

Owner: native `code/index.mjs`, role content `code/content.mjs`, `client/guide.jsx` and `client/guide.css`. This plugin contributes guidance; business actions remain with their owning plugins.

Requirements:
- Show a dismissible first-use invitation and short, replayable walkthrough for the signed-in contractor, supplier or administrator. Start/Open/Next/Finish are explicit user choices. Guidance never submits a quotation, approves an action, runs a model or changes a business record.
- Track status and step per account and role. Reload resumes an active walkthrough; dismissal/completion suppresses the first-use invitation. Replay starts its steps again without altering work. Account setting `user-guide.showWelcome` can hide invitations.
- Help & getting started is a stable navigation/header destination. Curated searchable, grouped topics describe the actual quotation, agent, review, ingestion, connection, memory, plugin and appearance workflows. Administrators receive their own management topics. Open-page links appear only when the target page is registered and permitted for this account.
- Content accurately distinguishes private drafts, approved commitments, SMTP acceptance, bot messaging and uncertain execution. Explain relevant scope limits in the matching topic, not as disruptive warnings on every page.
- All native routes/settings/nav and frontend overlay/header/account slots are disposable. Guidance UI unmounts when its native `help` contribution is absent; saved progress remains for re-enable.

API: `GET /user-guide` => `{role,preferences,progress,tour,topics}`; `POST /user-guide/progress {status,step}` => updated projection. Status is `new|active|dismissed|completed`; step is an in-range integer. `ctx.userGuide.get(user)` / `progress(user,input)` operate only on that account. Progress record ID is the current role in account collection `user-guide`, event `user-guide/progress-saved` records navigation learning state; this is not a business completion assertion or model input. Schema ID `user-guide` uses account scope and the existing settings ledger events.

Acceptance and executable evidence:
1. `node src/system/workspace-styles/tests/smoke.mjs`: real native persistence, role-filtered topics, validated progress, isolation, replay/resume and disposal for both plugins.
2. `BASE_URL=http://127.0.0.1:8620/quotagent/ node src/system/workspace-styles/tests/browser.mjs`: contractor/supplier/admin guidance, skip/replay, Help search and destination link, persistence, 390/1024/1440 layouts. Public URL verification follows integration.

Current workflow facts are sourced from `docs/design/architecture.md`, `docs/product/getting-started.md`, and the owning plugin code/requirements referenced in `code/content.mjs`. Requirements are acceptance targets until recorded commands pass.

Lifecycle browser: `BASE_URL=http://127.0.0.1:8620/quotagent/ node src/system/workspace-styles/tests/lifecycle-browser.mjs` disables/re-enables only these two native plugins through admin GUI and verifies removal/restoration of client effects. Saved account choices/progress remain.
