# Native product composition and launch
<!-- budget: 4096 bytes, hard -->

Owner: `system/runtime` for composition/launch outcomes. The current entry is the
root `run` launcher and `host/product.mjs`; every product service is mounted through
native Cordis. `host/client.mjs` composes plugin-owned React contributions. Pinned
runtime dependencies live in `host/package.json` and its lockfile.

`./run up|down|status|logs|build` operates the current product. Data survives process
restart under the configured product-data root. Host teardown disposes mounted
fibers in reverse order. Native Cordis owns service injection and event semantics;
product code does not clone its plugin lifecycle. Application plugin management
belongs to `system/plugin-manager`.

Historical standalone runtime/CLI modules remain repository assets. Their manifests
do not imply they are mounted by the current host. Kernel ledger/QEP semantics
remain separate from mutable plugin/configuration/prompt/policy surfaces.

Acceptance: `npm --prefix host run build`, native plugin-manager lifecycle check,
source inspection of host composition and recorded public release startup/restart.
Native smoke/effect evidence is retained in the canonical catalog. This contract
does not require old global FR/AC tables or Python-only application hosting.

`node src/system/runtime/tests/native-events.mjs` exercises the installed Cordis
emit/parallel/serial/bail/waterfall methods, listener disposal and consumer
inactivation/remount. Waterfall stops when a listener omits `next()`; repeated
`next()` is rejected. Current product request interception instead uses the
documented disposable `web.intercept` mechanism: a true result ends dispatch.
The sandbox interceptor is its active short-circuit owner; it delegates the whole
request to an isolated native host or returns an explicit unavailable result.
