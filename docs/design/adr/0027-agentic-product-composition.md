# ADR-0027 Native Cordis product composition and account workspace
<!-- budget: 8192 bytes, hard -->
Status: accepted

## Problem

User goal (2026-09-25) requires a real model assistant, reusable frontend framework,
persistent accounts, personal extensions and separate server administration.
Current sources show a deterministic harness (`system/agent-runtime/code/agent-harness.mjs`),
name/side sessions (`system/webui/code/identity.mjs`), and UI scanning outside Cordis
(`system/webui/code/app-shell.mjs`). These do not meet that experience.

## Decision

Compose the product from native Cordis plugins with explicit injected services. WebUI
owns transport and reusable React rendering only. Procurement, accounts, assistant,
and extension studio own their routes, actions and components. Generated extensions
are actual Cordis child plugins with reversible account-scoped contributions.
Use current Cordis 4.0.0-rc.10 (npm dist-tag verified 2026-09-25), React and Vite.

Preserve existing Python Ledger/QEP semantics through a persistent adapter; add
plugin-owned events, never rewrite kernel event meaning. A projection record event
carries collection and record; only explicitly public records travel in QEP messages.
Complete model requests, tool results and outputs are recorded in the calling account
realm. Cost models/preferences remain private. A model can draft but cannot perform
external commitment actions; a named logged-in user confirms those in the UI.

Account type is selected in settings/onboarding and determines one client experience;
admin is a separate account with server management. This supersedes FR-ADMIN-002/003's
client elevation/side-switch interpretation for the product composition.

Local handover, progress and state files are ignored per latest user instruction.
Feature specifications and results remain versioned; every functional slice gets its
own normal commit/push and remote readback.

## Consequences

Positive: agent tasks and extensions become usable; ownership is explicit; source
components can be reused; disposal handles actual UI effects.
Negative: new frontend build step; old panel UI is not maintained for compatibility;
advanced old modules require explicit integration before their capabilities can be
claimed in the new experience. Model responses depend on configured provider availability.

## Alternatives rejected

| Option | Reason |
|---|---|
| Reskin old imperative UI | Does not supply framework components or remove lifecycle mismatch |
| Label deterministic advice as AI | Does not meet real agent requirement |
| Replace ledger/QEP kernel | Unnecessary semantic migration; existing kernels suffice |

## Revisit conditions

Revisit if Cordis changes lifecycle interfaces, account realms require separate
process deployment, or generated extensions need unrestricted frontend code.
