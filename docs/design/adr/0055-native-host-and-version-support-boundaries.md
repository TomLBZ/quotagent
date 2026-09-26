# ADR-0055 Native host and version support boundaries
Status: accepted
<!-- budget: 6144 bytes, hard -->

## Problem

FR-INTEG-004 describes a historical untrusted host with a separately authoritative
Python identity boundary. NFR-COMPAT-003/004 promise indefinite old-version reading
and mixed-product-version rollout. Those mechanics were written before the native
account/plugin composition in ADR-0027 and native exchange adapter in ADR-0037.
The current user explicitly prioritizes the plugin application and says not to
maintain backward compatibility merely because an earlier implementation exists.
Leaving these older mechanisms as current promises would misdescribe the product.

## Decision

The native host and its installed application plugins are trusted application
code. Account sessions and accepted team membership select the human actor and
party workspace in their owning services. The private child-process NDJSON adapter
accepts that resolved identity from the host; it is not a public identity service
and does not independently authenticate arbitrary untrusted processes. Browser and
model callers use registered routes/tools, never a direct adapter connection.
Source: `accounts/code/product.mjs`, `teams/code/index.mjs`,
`workspace-store/code/index.mjs`, `workspace-store/code/bridge.py`.

Retain capability handshake, explicit incompatible protocol refusal, no generic
commit operation, kernel append-only facts, account-private projections, and
domain-owned human review. Existing account/team/approval and bridge tests prove
those narrower boundaries. Do not label them proof that a malicious native host
cannot forge an adapter actor. Native source changes remain administrator/developer
work; generated utilities retain their bounded installed-runtime interface.

Support the current declared ledger/QEP formats, not every historical application
schema or arbitrary mixed application revisions. Preserve original archive bytes;
generic ledger verification/read/export may retain events that no current business
projection interprets. Unknown application record metadata is explicitly counted.
An unsupported ledger cannot be silently rewritten or declared successfully
migrated. An incompatible QEP peer is explicitly refused; required signing and
approval semantics are never silently downgraded. Current files/package/HTTP and
mail adapters share the declared QEP compatibility boundary.

Independent party processes can run independently. That does not promise arbitrary
rolling upgrades of different domain field contracts. A deployment changing a
public domain contract must state its supported peers or coordinate that contract;
the old unconditional mixed-product-version promise is superseded. The existing
version intersection tests and explicit refusal remain required current behavior.

## Consequences

The documented trust boundary matches actual native code and the user's current
architecture. No new identity protocol, kernel change or compatibility shim is
introduced. Original source clauses remain in the requirement catalog with this
replacement and their retained outcomes. Historical documents are retrievable by
immutable source revision. Unsupported old applications may need an old read-only
release to interpret their business records; this is explicit rather than a claim
of an untested migration or perpetual compatibility.

## Alternatives rejected

- Rebuild the old separately authoritative host bridge: contradicts the current
  trusted native plugin composition and adds an unused application boundary.
- Claim an unlimited historical/mixed-version guarantee from same-version tests:
  misrepresents what was exercised.
- Rewrite old archives to fit current projections: destroys original evidence.

## Revisit conditions

Add a new supported format or migration decision when a concrete deployment needs
it. If untrusted native host code becomes a supported threat model, define a new
process authority boundary and its operational costs before implementing it.
