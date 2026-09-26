# Award-intent view correction
<!-- budget: 2048 bytes, hard -->

Public command on immutable `bf2cb4bd7f15eaec3201a0fc49077e7c7ea20288`:
`BASE_URL=https://novara.remoteblossom.com/quotagent/ node src/domain/procurement/tests/public-declarations-browser.mjs`.
The [retained failure](public-failure.json) reached two declaration groups, then the
Orders award-intent view threw `order is not defined`, preventing supplier
confirmation. A late source-line display used an order variable inside the
award-intent row renderer.

`src/domain/procurement/client/fulfillment.jsx` now supplies the existing intent
row’s currency to `QuoteLineBasis`. The finalized OrderCard retains its own order
context. No backend, record, protocol or price calculation changes.
`git diff --check` passed. Actual public replay of the same meaningful GUI journey
on a new committed build is required; it is not claimed passed at this fix checkpoint.
