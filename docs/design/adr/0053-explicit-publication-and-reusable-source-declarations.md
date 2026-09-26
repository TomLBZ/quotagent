# ADR-0053 Explicit publication and reusable source declarations
Status: accepted
<!-- budget: 8192 bytes, hard -->

## Source requirements and problem

Canonical catalog retains FR-RFQ-002 and DOMAIN-002: admitted measurement units,
one interface responsibility owner and source specifications. Original domain
model §2.3 retains quote assumptions/exclusions and firm/indicative named delivery
milestones (DOMAIN-003). Original FAQ contract §2–4 retains human publication of
explicit reusable fields, exact package/revision lookup, provenance and private
realm isolation (SUPPLEMENT-031). FR-DEV-002 requires human adoption of an offered
alternative. Current native modules lack these complete outcomes; this is not an
obsolete-host waiver. Source text is preserved in `docs/requirements/catalog.json`.

## Decision

All newly performed RFQ publication and amendment publication require complete
structured scope. Private incomplete drafts remain editable. UI starters copy only
entered unit spellings and identity factors; dimension, owner, deliverables and
exclusions need explicit author input. Existing published legacy records remain
readable as unknown, without fabricated ownership. New public versions declare the
scope policy so received copies validate it; replay of old signed facts is unchanged.

Public quote declarations add explicit assumptions/exclusions and named milestones
with ISO date, binding mode and optional quoted-item refs. They are draft proposals
until normal human submission; submitted firm milestones within the offer's validity
cannot be changed by agent tools. Human revisions retain the original offer and use
normal submission, bilateral intent/confirmation and independent sign. Public
projections, frozen offer fingerprints and derived PO preserve these declarations.
A complete offer may fulfill a source line with an explicit alternative and may add
labelled extra lines; no source requirement may disappear. Human award review shows
these qualifications and freezes the exact accepted item list.

FAQ has its own additive module within procurement. A candidate selects a fully
broadcast source ticket and explicit allowed reusable fields. Human publication
freezes source package/revision, normalized question hash, values, actor and exact
ledger refs. Only published, nondeprecated, same-package/same-revision lookup returns
content; mismatch returns no entry plus reason/next action. Repeated lookup is read
only and deterministic. Separate, explicitly labelled adaptation may use a historical
FAQ as source for a new private answer draft, retaining provenance and requiring the
existing full human broadcast. It never claims an exact lookup hit or silently changes
a ticket's version. Private field names/metadata cannot be published as reusable keys.
Legacy prose FAQs remain labelled historical sources, not validated structured entries.

All changes use native disposable registrations and append-only business events.
Ledger/QEP kernel formats remain unchanged. Generic action-center remains executor
for reviewed commitments; procurement owns business selection and source checks.

## Acceptance

Actual Ledger/QEP tests and GUI journeys must show incomplete new publication refusal,
explicit authored scope publication, unchanged legacy facts, additional/alternative
human adoption, milestone/qualification roundtrip through signed PO, agent refusal
of valid firm changes, structured FAQ candidate→human publication→exact lookup and
wrong-version empty refusal→reviewed adaptation→deprecation/replay. Existing native
fixtures must supply explicit authored scope rather than disable publication checks.

SUPPLEMENT-019 is separately assessed: native multi-quotation selection must prepare
independent frozen actions and show per-quote preparation failures; generic review
batches alone do not satisfy the business preparation GUI. No aggregate success may
hide an item failure.
