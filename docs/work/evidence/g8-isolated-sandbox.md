# Native isolated demonstration workspace
<!-- budget: 8192 bytes, hard -->

2026-09-26 local verification; source decision ADR-0047. Commands ran against the current native Cordis plugins and Python ledger adapter. Public verification remains a release task; these observations do not claim real procurement outcomes or model quality.

## Commands and observations

| Command | Result and evidence |
|---|---|
| `node src/system/sandbox/tests/isolation.mjs` | Eight assertion groups; `g8-isolated-sandbox/native-report.json` (source `tmp/sandbox-isolation-61ts48/report.json`). The real HTTP gateway delegates before parsing; actual native procurement, actions, teams and QEP writers generate eight simulated steps. |
| `node src/system/sandbox/tests/browser.mjs` | Four groups, eight screenshots, no JavaScript errors; preserved `g8-isolated-sandbox/browser-report.json`. `tmp/agent-experience/sandbox-browser/report.json`; local base `http://127.0.0.1:8650/quotagent/`. Every browser write used a visible control. |
| `npm --prefix host run build -- --outDir /workspace/projects/quotagent/tmp/agent-experience/sandbox-assets` | Integrated build passed, 102 modules. Existing bundle-size advisory remains; no performance improvement is claimed. |

Native isolation compares SHA-256 for every existing live business ledger, settings/credentials and stored file before/after seeding, manual draft, file upload/download, reset, exit, resume, supplier practice, controller restart and clear. Only the separate `.sandboxes` and `.sandbox-control` directories are excluded. Root authentication may still update ordinary session metadata; this test uses resolved fixture users and makes no claim that real login itself writes zero bytes.

The example uses two fictitious supplier quotations, a recorded comparison, a nonbinding award intent, supplier confirmation, a separate simulated same-party reviewer, buyer signature and supplier acknowledgement. Its second published request remains available for practice. Contractor snapshots omit supplier costs; supplier snapshots retain only that supplier's own private costs. No live credentials or contacts are copied; child AI reports unconfigured and outbound connection plugins are absent.

Native requests confirm that uploads/downloads use child storage and a known live file ID refuses inside the demo. A missing scenario produces explicit503 with a minimal bootstrap retaining demo exit. Whole-controller restart restores each owner's saved mode/records; concurrent initial requests reuse one child. Role changes cannot mutate the synthetic perspective and do not prevent exiting. A factory failure before creating its directory still leaves owned clear/exit controls. Native unload removes handlers and child compositions.

## Browser acceptance mapping

| Observed interaction | Screenshot |
|---|---|
| Inspect declared steps before generating simulated commitments | `01-reviewed-demo-steps.png` |
| Inspect eight completed receipts labelled simulated | `02-contractor-demo-receipts.png` |
| Open the ordinary acknowledged-order page | `03-native-order.png` |
| Use ordinary request editor; another account tab sees same mode | `04-normal-draft-editor-result.png` |
| 390px boundary/exit visible in normal flow, no horizontal overflow | `05-mobile-active-boundary.png` |
| Reset removes practice edit; exit restores original live IDs; resume preserves order; clear removes demo | `06-live-workspace-restored.png` |
| Supplier uses separate fixed-perspective demonstration | `07-supplier-demo-receipts.png` |
| Ordinary quote editor saves editable supplier draft; clearing preserves live quote IDs | `08-supplier-private-draft.png` |

Screenshots are under `tmp/agent-experience/sandbox-browser/`. The browser script accepts `BASE_URL` and `EVIDENCE_DIR`; it explicitly clears only that signed-in participant's previous demo to make repeated runs independent.

## Scope and limitations

Native owners: `src/system/sandbox/{code,client,tests}` and `src/domain/procurement-sandbox/code`. Small configuration opt-outs are in `agent-runtime/code/product-ai.mjs` and `settings/code/service.mjs`; default live behavior remains enabled. WebUI supplies generic handler/interceptor/banner seams; host composes the plugins.

This is a single-host, account-owned demonstration with static shared assets and separate data roots. It opens no child listener. All same-account tabs share mode. At 32 retained owner entries it refuses a new participant; it never deletes another participant's demo. Simulated approvals are clearly labelled and cannot establish real independent human review. Optional model configuration in the demo was not exercised; email/Telegram/remote services are deliberately not mounted. Uninstalling the controller removes its UI/interception and returns the parent application; disabling only the scenario keeps the explicit unavailable-demo boundary.
