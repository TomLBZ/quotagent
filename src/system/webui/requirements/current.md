# Native GUI shell
<!-- budget: 6144 bytes, hard -->

Owner: `system/webui`; sources `code/product-server.mjs`, `client/core.jsx` and
`client/styles.css`. The React shell is a full GUI contribution mechanism. It owns
no domain decisions or hardcoded business plugin list. Host client composition
imports each plugin's own pages. Server contributions declare routes, navigation,
collections and disposable request interceptors. Client contributions declare
pages, slots, commands and safe deep-link context keys.

Authentication resolves before API interception. A handler delegation preserves
request bytes and does not require another listener. Banner slots render in normal
flow; plugin-owned sandbox boundaries remain visible on narrow screens.

Public `GET <prefix>/api/routes` describes the application's single sign-in entry
for the existing workspace dashboard. It does not enumerate private records or
encode a role in a URL. Account roles determine the registered pages after login.

Reusable controls supply loading/error/empty distinctions, accessible labels and
modal focus/escape/inert behavior. Resource requests are account/workspace keyed;
stale responses cannot overwrite newer queries. Open edits remain owned by their
form rather than resetting on background refresh.

Both a failed saved-view request and a failed row-source request block an empty
result claim and expose retry. Unknown totals must not be presented as a healthy
empty collection.

Fields link their visible label, hint and supplied or native validation error to
the control. Invalid state remains readable after the native tooltip closes and
clears on a valid edit. Tables preserve plugin-supplied captions/names; unnamed
tables inherit their nearest section heading through a disposed surface observer.
Acceptance: `node src/system/webui/tests/accessibility-browser.mjs` exercises real
required/email validation, hints, table names, retry states and keyboard focus.

Detailed contracts: [navigation](navigation.md), [collections](collections.md),
[offline shell](offline.md). Plugin-owned domain source readers authorize collection
rows before generic filtering/sorting/paging/export. Explicit personal view changes
are ledger-backed; list reads do not write.

Acceptance: native collection and browser navigation/collection/offline commands in
`tests/`. Runtime shell composition is tested by the public GUI journeys referenced
from the canonical requirement catalog. Historical SSR/no-script/read-only rules
are superseded by native product architecture, ADR-0027 and ADR-0048.
