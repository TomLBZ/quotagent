# Human action review
<!-- budget: 4096 bytes, hard -->

Owner of durable external-effect and memory proposals in the [connected agent contract](../../../docs/product/connected-agent-contract.md). Source: `code/index.mjs`, `client/actions.jsx`.

A plugin registers an executor with a disposer. Proposals freeze their input; account owners inspect, approve or decline them in Review actions. Approval requires an explicit UI confirmation and workspace write permission. Concurrent/repeated approval executes once. Failures retain receipts; interrupted execution recovers as uncertain without automatic retry. A human can propose another attempt after inspecting the destination. Model tools cannot approve. Plugin-owned `action-preview:<kind>` slots render readable frozen content; complete JSON remains inspectable. Executors can provide result navigation cards.

Events: `actions/proposed`, `approved`, `succeeded`, `failed`, `rejected`, `delivery-uncertain`, `notification-failed`. All records belong to the current account. Registered handlers, routes, navigation and execution abort controllers dispose with the plugin. Notification failure must not turn a completed send into a failed action.

Acceptance: `node src/system/action-center/tests/state.mjs` verifies real ledger persistence, account settings, concurrent proposal/approval idempotence, unapproved/cross-account refusals, notification read state, policy boundaries and uncertain restart recovery. Transport and public GUI evidence belongs to each owning plugin and the connected-agent evidence report.
