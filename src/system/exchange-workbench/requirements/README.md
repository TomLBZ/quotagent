# Durable exchange workbench
<!-- budget: 12288 bytes, hard -->

Owner: native `system/exchange-workbench` and `system/workspace-store` adapter.
Decision: [ADR-0037](../../../../docs/design/adr/0037-native-durable-qep-exchange.md).
Automatic gap recovery: [ADR-0052](../../../../docs/design/adr/0052-native-qep-resend-control.md).
Historical kernel/stdio/relay implementation details are references; acceptance
checks the native GUI and durable delivery outcomes, not obsolete operator-only
routes or fixed shared-folder layouts.

## Mapped outcomes and executable acceptance

| Existing clause | Native result | Required executable assertion |
|---|---|---|
| FR-LEDGER-002 | Effective projection by sequence/time, current replay parity | Full and incremental historical cuts match recorded versions |
| FR-QEP-002 | Domain-selected commitment envelope bound to human ledger proof and public semantic revision | Missing/tampered approval cannot project a commitment; draft facts create no obligation |
| FR-QEP-003, FR-QEP-004, FR-QEP-008 | Durable pending/held outbox/inbox, stable-byte retry, no sequence skip, receipt recovery | Crash after send and after receive; duplicate and missing-sequence transfer; restart still applies once |
| FR-INTEG-001, FR-INTEG-002, DOMAIN-012 | Atomic portable package and real HTTP handoff, signed receipt | Independent store roots transport actual QEP bytes; file and HTTP paths produce verified delivery |
| FR-QEP-007 | Base/mine/theirs, field authority, explained conflict and bilateral human decision | Ordinary authority merge keeps provenance; commitment conflict cannot resolve unilaterally |
| FR-INTEG-004 | Self-described bridge version/capabilities and actionable typed errors | Incompatible handshake adds zero events; unsupported commit is unavailable and diagnosed |
| SUPPLEMENT-008 | Atomic expected-revision write and domain GUI adoption | Two clients editing one revision: second receives current conflict, no silent overwrite |
| SUPPLEMENT-026 | Honest storage/integrity/malformed metadata diagnosis | Corrupt or inaccessible realm never appears healthy/empty; valid realms remain usable |
| SUPPLEMENT-033 | Account-owned delivery state, retry, gap and conflict GUI | Both parties inspect pending/delivered/rejected states and retained receipts |

Preserve existing FR-LEDGER-001/003/004 and FR-QEP-001/005/006 invariants: append-only
hash chain, kernel dedup/signature/version checks, no silent mandatory-feature
removal. Existing native email transport already owns FR-INTEG-003; attaching a
QEP package does not change its approval or retry semantics.

Service checks: `node src/system/workspace-store/tests/exchange.mjs` must mount real
native store instances and QEP/Python ledger kernels, exercise the policy callback,
real loopback HTTP, canonical package tampering, commitment proof, outage/restart,
missing sequence replay, CAS, conflict states, snapshots and complete disposal.

GUI checks: `BASE_URL=http://127.0.0.1:8646/quotagent/ EVIDENCE_DIR=tmp/agent-experience/exchange
node src/system/exchange-workbench/tests/browser.mjs` must configure account-owned
fixture peers, download/upload exact packages, retry a failed delivery, inspect
receipts, propose/decide a conflict and revisit retained results after reload.
All business writes must originate from visible controls. Independent reviewer
integration is tested with the G1/G3 composition, never a bypass.

## Ownership and interfaces

The store owns append/replay, bridge capability/error handling, atomic optimistic
writes and durable signed transfer staging. The exchange plugin owns account peer
configuration, public transport receiver, authenticated workspace routes, delivery
GUI, notifications and optional assistant read/proposal tools. Registered domain
policies own public whitelists, meaningful approval/record binding, field authority
and version validation. The host only mounts plugins and imports client modules.

`store.exchangePolicy({id,collections,prepare,validate,authority})` returns a disposer.
`prepare({from,to,collection,record,options})` returns type, eventClass, refs and real
ledger-sourced approvals. `validate({from,to,collection,record,local,base,metadata,peer})`
returns `{ok:true}` or `{ok:false,code,message,nextAction}`. `authority` receives
collection/path/record/from/to and returns `{owner,commitment}`. Approval scopes are
bound to the canonical record hash by the adapter; caller assertions never replace
ledger-derived human decisions. Private costs and scoring are not portable fields.

Peer routing metadata belongs to the explicitly selected party and is visible to its
accepted members. Only that workspace owner can change routes; its credential owner
is explicit, and members cannot create hidden competing routes. Peer secret schemas
are account-owned settings with credential fields; no inherited
shared provider defaults apply. Server routes derive the signed-in realm or an
explicitly authorized party scope. Public HTTP input is authenticated by configured
QEP pairing, then domain validation. Historical raw packages are shown as external
source evidence; only accepted effective records enter workspace projections.

The current QEP kernel signs with HMAC-SHA256 and supports QEP1.0. Pairing trust is
symmetric; this implementation does not claim Ed25519 or independent human-key
signatures. Local protocol fixtures are labelled fixtures, not external production
integrations. No acceptance is marked passed until its evidence is recorded.

## Recorded local verification

2026-09-26: service command above passed nine groups in
`tmp/exchange-smoke-T6jwJN/report.json`.
Two independent native stores exchange real QEP packages over loopback HTTP;
crash-prefix fixtures test recovery after send and raw receipt separately. Real
team invite/accept/select checks route visibility and owner-only configuration.

Browser command above passed four groups at 03:04:12 UTC in
`tmp/agent-experience/exchange/local/report.json`, with zero JavaScript errors and
no mobile horizontal overflow. Request creation, publication, peer settings,
package/receipt import/export, outage endpoint correction and retry, historical
rebuild, conflict acceptance and admin diagnostics use visible controls. The
conflicting quotation branches come from the explicitly labelled independent
`tests/protocol-fixture.mjs`, not an external production supplier. Screenshots
include `06-conflict-before-decision.png`, `07-conflict-reviewed.png` and
`07-mobile-delivery.png`. This is local evidence; final public integration remains
owned by the root deployment task.

HTTP handoff batches still-pending earlier signed packages before the requested
message, then returns retained signed receipts in stream order. No envelope is
modified, and receiver deduplication remains authoritative. Background HTTP retries
use bounded exponential delay (five attempts) and a retained attention notification;
manual imports/downloads never start background delivery. Clearing a pairing secret
also removes its live adapter key. Unload removes routes/schemas/timer/transports and
aborts HTTP requests; restart reconstructs durable metadata and pending streams.

## Automatic missing-message recovery

FR-QEP-003 additionally requires a real signed resend-request/replay round trip.
The adapter prepares durable bounded requests for held gaps, and the paired HTTP
transport returns the exact original signed messages even if previously marked
delivered. Requests and returned messages use the existing kernel sequence and
signature rules; no new commercial approval or body is manufactured. Fulfillment
requires actual receipt of the missing sequences. Duplicates, unavailable source
messages, large gaps and transport failures remain explicit. Work is bounded to
64 requested messages per range and eight HTTP recovery rounds per attempt.

Required acceptance: actual independent native stores and loopback HTTP must
recover a missing already-acknowledged predecessor from a signed control request,
survive request restart, keep original envelope bytes/approval, apply each business
record once, refuse malformed/foreign control, expose unavailable sequences, and
stop bounded cycles. GUI must show the request and recovery receipts after reload.
Commands: `node src/system/workspace-store/tests/resend.mjs` and
`node src/system/exchange-workbench/tests/resend-browser.mjs`. Local native six
groups and GUI three groups passed; scoped results and limits are in
[recovery evidence](../../../../docs/work/evidence/qep-resend-2026-09-26/README.md).
Final public verification remains pending.
