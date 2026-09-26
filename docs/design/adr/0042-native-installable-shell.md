# ADR-0042 Installable native application shell
Status: accepted
<!-- budget: 4096 bytes, hard -->

## Problem

The current React application has no install manifest or truthful offline startup.
Historical `src/system/webui/docs/pwa-and-offline.md` describes a retired static
client. Its installable application and shell-only cache outcomes remain required
by SUPPLEMENT-018; its old route and no-framework mechanics do not.

## Decision

The native WebUI plugin owns a manifest, icons, a build-generated service worker
and a browser-device preference exposed in Settings. Users explicitly enable the
offline shell and can remove it, unregistering its worker and deleting its cache.
The cache contains only the static application HTML and exact build assets, never
API responses, business records, account profiles, cookies, files or credentials.
No writes are queued, replayed or fabricated while disconnected. There is no
background synchronization or offline business database.

Each build binds its worker/cache version to emitted asset content. Navigation to
the application root can fall back to its cached empty shell. Hash links retain
only the page's declared context. API requests always require the network. On an
already open page, previously read data may remain visible with an explicit stale
data banner. After offline reload, only the shell is available; identity and work
wait for connection. Request failures with an online browser are described as an
unreachable service, separately from browser-declared offline state.

The manifest provides standalone display and native-sized icons. An installation
button appears only when the browser supplies its install event; otherwise the
UI gives browser-menu guidance. Headless evidence establishes manifest, service
worker and cache behavior, not an actual operating-system installation.

## Consequences

The app can be launched as a standalone application and has an honest disconnected
state. Device storage and an explicitly installed worker outlive sessions until
the user removes them. Account data is never included in that persistent cache.
Offline work still requires a later connected session; no queued approvals exist.

## Alternatives rejected

| Alternative | Reason |
|---|---|
| Cache all successful requests | Retains private account data and can disguise stale facts |
| Queue offline write requests | Could replay an unintended business commitment |
| Claim actual installation from a headless test | Browser installability is a different observation |

## Revisit conditions

Any offline business editing, synchronization or private data cache needs a new
decision with explicit ownership, conflict and approval semantics.
