# ADR-0047 — Native isolated demonstration runtime
<!-- budget: 8192 bytes, hard -->
Status: accepted

## Problem

The historical sandbox contract (`docs/design/29-webui-gui-app.md` §11 and `src/system/webui/docs/sandbox-and-demo.md`) requires a complete example, visible boundaries, the same business writers, and reset without changing real records. Legacy SSR path switching and its old CLI bus are not the current Cordis/React application. Labelled sample records in normal demo accounts do not provide this isolation.

## Decision

A native `system/sandbox` plugin owns per-authenticated-account selection, lifecycle, private state and GUI start/reset/exit. A disposable scenario registration supplies a name, declared steps and an isolated runtime factory. Domain scenario plugins own business sequencing; WebUI knows neither scenario names nor domain actions.

The current WebUI exposes a generic disposable request interceptor and its existing handler. After real session resolution, an active sandbox delegates every application API request into its isolated native Cordis composition before ordinary bootstrap, route lookup or request-body consumption. Parent `/sandbox/*` controls and `/auth/*` authentication remain explicit exclusions owned by the sandbox plugin. Same-path delegation includes existing download URLs and leaves static assets shared. It opens no additional port. Unavailable child runtime refuses application requests; it never silently falls back to live services. Its minimal bootstrap retains the Sandbox page and Exit control. All tabs of the same account share this mode, which the GUI states plainly.

Each runtime has a separate workspace-store adapter/root and freshly constructed native services; no real ledger, settings, credentials, files, preferences or team members are copied. Synthetic signed-in identity preserves one client perspective (contractor or supplier), with clearly fictitious counterparties and a separate same-party reviewer. The child account facade cannot edit real accounts or change its role. Domain exchange remains local to this composition; outbound mailbox/chat/remote-agent/remote-QEP transport plugins are absent. AI defaults do not inherit operator YAML/environment credentials; optional separately configured model access operates on the isolated records. File imports use the sandbox-owned storage, superseding the old attachment prohibition that existed because legacy attachments shared the real directory.

`domain/procurement-sandbox` declares and runs a quotation-to-order example through current procurement/teams/actions services. Scenario start is an explicit human choice to generate simulated actions and approvals, labelled in its receipt and ledger. It does not claim that simulated reviewers are real people. Current independent approval, public/private projection and QEP rules remain active. The scenario provides a completed example plus an open RFQ for experimentation; ordinary GUI edits use the same native services as live work.

Start/reset serializes per owner, disposes the old composition, deletes only the generated account sandbox root and builds a fresh instance. Exit restores the live API selection while preserving the demo for inspection; Clear stops the child, removes its root and exits. State and credentials use private modes and atomic replacement. Plugin unload removes interception, routes, controls and running children, leaving durable scenario data available for deliberate re-entry; no timers or external transports survive. Mode state stays explicit across restart. Active runtime creation failures remain inspectable and exit stays reachable.

## Consequences

Newcomers can inspect both a realistic flow from their own perspective and the precise simulated step results, then edit/reset in the full GUI without live-record writes. Isolation costs another local ledger adapter and native composition per active account; active instances/state are bounded. This is single-host demonstration isolation, not a general hosted-code execution boundary. Root account authentication still updates its normal session metadata; no business or credential record is copied or altered by seed/reset. Static assets are shared, while every application API and download follows selected runtime ownership.

## Alternatives rejected

| Alternative | Reason |
|---|---|
| Demo flag on live records | Does not isolate writes or permit byte-preserving reset. |
| Separate public host or second application | Adds deployment and navigation complexity without reusing the current gateway. |
| Copy real credentials and contacts | Makes a demonstration capable of affecting live relationships. |
| Fake PO records that bypass procurement/actions | Conceals actual business validation and independent review requirements. |
| Fall back to live routes when demo fails | Can turn an apparent demo action into a real write. |
| Hardcode scenario business steps in WebUI | Violates plugin ownership. |

## Revisit conditions

Revisit multi-node persistence, higher concurrency, additional domain scenario modules or outbound demonstration transports through a new explicit scope decision. Neither synthetic approvals nor isolated model tests establish real-user procurement outcomes.
