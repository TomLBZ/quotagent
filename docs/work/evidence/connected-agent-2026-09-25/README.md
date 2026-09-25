# Connected agent acceptance
<!-- budget: 8192 bytes, hard -->

Public URL: <https://novara.remoteblossom.com/quotagent/>. Date: 2026-09-25.
Scope: [connected-agent contract](../../../product/connected-agent-contract.md),
[ADR-0030](../../../design/adr/0030-connected-agent-workflows.md).
Browser mutations used visible controls. Loopback fixtures never forwarded messages;
live AI used the configured `deepseek-flash` provider.
This is evidence of real protocol integration, not verification of Gmail/Microsoft or
Telegram's production services. No unrelated recipient was contacted.

## Observed user outcomes

| Journey | Result and evidence |
|---|---|
| Email | GUI configured/tested IMAP/SMTP, received actual MIME and XLSX, extracted editable lines, saved reply, reviewed exact recipient/body, then SMTP accepted exactly one approved send. [Report](mail-telegram.json), [inbox](mail-inbox.png), [review](mail-review.png) |
| Telegram | GUI configured/tested bot, received text/CSV through Bot API fixture, extracted items, reviewed reply and observed exactly one approved send. [Report](mail-telegram.json), [review](telegram-review.png) |
| MCP | GUI created account connection, discovered tools/resources/prompts, read real content, reviewed invocation and received 2520. Actual model selected discovery/proposal tools before human approval. [Protocol](mcp-a2a.json), [AI](mcp-real-ai.json) |
| A2A | Agent card discovery, INPUT_REQUIRED task, status query, same-task reviewed reply, COMPLETED artifact and reviewed cancellation. Supplier could not see buyer connections. [Report](mcp-a2a.json) |
| Business proposals | Actual supplier assistant drafted clarification; readable recipient/body appeared in durable Review actions; human declined and no message was sent. [Report](procurement-review.json), [preview](procurement-review.png) |
| Multi-agent work | Real planner made three specialist tasks; human reviewed plan; specialists overlapped; scheduling agent asked for a date; human answered 15 October; real synthesis compared $5532 and $5292 offers, $240 difference, scope/payment/delivery risks and conditional negotiation. Fifteen GUI checks passed. [Report](workroom.json), [plan](team-plan.png), [result](team-result.png) |
| Trace and memory | Fourteen provider requests, eleven completed replies, three deliberate cancellations, three distinct agent IDs and 31 traces. Human feedback and reviewed memory entered provider inputs. GUI edit/history/archive and reload passed. [Ledger proof](workroom-ledger.json), [memory](memory-history.png) |
| Source resistance | Real hostile MIME instructed an unapproved acceptance send and poisoned preference. Chat used mail read/draft only, sent zero messages and installed no poisoned memory. Workroom also encountered and explicitly rejected those instructions. [Chat](hostile-email.json), [workroom](workroom-source-resistance.json) |
| Restart | Actual public process restart preserved interrupted run as paused; explicit human resume and cancel worked. Independent review then found a task-state race, addressed in the follow-up evidence below. [Initial recovery](restart.json) |
| Visibility and mobile | Admin GUI exposed mounted plugins and account connection settings. All six new client pages fit a 390px viewport without document overflow or JavaScript errors. [Admin](admin.json), [mobile](mobile.json) |

Prompt/data separation and runtime effects provide layered resistance. These observed
probes do not establish immunity to every malicious source or every model/provider.

## Reproduce

Install pinned dependencies and build with `npm --prefix host ci` and
`npm --prefix host run build`. Focused executable checks:

```sh
node src/system/action-center/tests/state.mjs
node src/system/mail/tests/product-smoke.mjs
node src/system/agent-connections/tests/smoke.mjs
node src/system/agent-workflows/tests/state.mjs
node src/system/agent-workflows/tests/cancellation.mjs
node src/domain/procurement/code/smoke.mjs
```

These use real native services and ledgers; protocol checks use actual IMAP/SMTP and
SDK servers. The workroom state check uses a controlled provider; it is separate from
the actual-model browser/ledger evidence. Protocol checks include disposal, credential
isolation, duplicate approval, stale requests, delivery receipts despite notification
failure, Telegram generic reminder opt-in and no private-content export.

For transport browser checks, start `node src/system/mail/tests/product-fixture-server.mjs`
and `QUOTAGENT_FIXTURE_PORT=8621 node src/system/agent-connections/tests/fixtures.mjs`.
Use their printed loopback settings. Only the test server process sets
`QUOTAGENT_TELEGRAM_API_BASE` to the fixture API URL. With the product running:

```sh
BASE_URL=https://novara.remoteblossom.com/quotagent/ node src/system/mail/tests/product-browser.mjs
HOSTILE_SOURCE=1 BASE_URL=https://novara.remoteblossom.com/quotagent/ node src/system/mail/tests/product-ai-browser.mjs
QUOTAGENT_BROWSER_URL=https://novara.remoteblossom.com/quotagent/ node src/system/agent-connections/tests/browser.mjs
QUOTAGENT_BROWSER_URL=https://novara.remoteblossom.com/quotagent/ node src/system/agent-connections/tests/assistant-browser.mjs
BASE_URL=https://novara.remoteblossom.com/quotagent/ node src/domain/procurement/tests/proposal-browser.mjs
BASE_URL=https://novara.remoteblossom.com/quotagent/ node src/system/agent-workflows/tests/browser.mjs
node tools/product-connected-admin-e2e.mjs
node tools/product-connected-mobile-e2e.mjs
```

The recovery harness `src/system/agent-workflows/tests/recovery-browser.mjs` runs in
`start` and `verify` modes around an actual process restart. Raw captures and corrected selector/load harness failures remain under
`tmp/product-evidence/`.

## Independent review and follow-up

The [independent evaluation](../../../product/connected-evaluation.md) prefers Quotagent
over messaging alone for supervised quotation work: source documents, itemized offers,
specialist evidence, human answers and reviewed actions stay connected. It does not
replace a production-provider/supplier trial. Remote review remains technical and
workroom history verbose.

Two observed defects were corrected and independently rechecked publicly:

- Cancellation could race a queued task write and relaunch. Human controls, execution
  writes and traces now serialize; terminal runs cannot gain working tasks. Startup
  appends a reconciliation for previously inconsistent records. A deterministic test
  fails on the old engine and passes on the fix. A new real four-role run was cancelled
  while three specialists called the provider; after eleven seconds and reload all
  four remained cancelled, with no later worker starts/model requests. [GUI](cancellation.json),
  [ledger](cancellation-ledger.json), [tasks](cancelled-tasks.png).
- Removed connection receipt links now show owner-only retained results, the removal
  explanation and no remote controls. With fixtures stopped, MCP 2520 and A2A 120 USD
  remained readable. [Public recheck](removed-history.json).

Final state/protocol command output: [checks](final-state-checks.json). Independent
recheck captures with prefixes `independent-35`, `36` and `37` are saved beside this report.

## Cleanup and limits

Fixture mail/Telegram settings were reset through the GUI; connection credentials were
cleared on removal and tombstone recovery; action receipts/history remain. The Telegram
fixture environment override was removed before restart. Test memories were archived,
completed analysis retained and the recovery run cancelled. [GUI cleanup](cleanup.json),
[runtime check](cleanup-runtime.json). Fixtures and the separate local app were stopped.

IMAP sync is bounded polling, not a full mailbox mirror. SMTP acceptance does not prove
delivery/read. Telegram is a bot connection, not personal chat login. MCP supports
Streamable HTTP and legacy SSE, not stdio; A2A supports SDK HTTP bindings, with executable
fixture evidence specifically for 1.0 JSON-RPC. OAuth consent/token refresh, MCP
sampling/elicitation, gRPC and A2A push subscriptions are outside this release.
