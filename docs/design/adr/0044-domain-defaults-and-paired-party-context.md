# ADR-0044 Sourced draft defaults and explicitly paired business parties
Status: accepted
<!-- budget: 8192 bytes, hard -->

## Problem

The generic settings hierarchy (ADR-0041) cannot determine which projects and
sections a business user owns. Existing native procurement draft forms always
start with fixed values, and configured independent QEP peers (ADR-0037) cannot
be invited because recipient validation accepts only local accounts. Configuration
and transport alone therefore do not complete the corresponding business workflow.

## Decision

Procurement registers reversible workspace/project/section scope providers and a
non-secret draft-default schema through settings. Scope resolution uses the active
authorized party, verifies project ownership and section parentage, and preserves
the actual human actor. A selected foreign party or arbitrary project ID cannot
read or alter configuration. Approved explicit team membership is required for a
shared workspace; ordinary role similarity never grants access.

New RFQ and quote drafts may consume configured currency, brief, lead-time,
payment-text and note defaults. Existing records and explicit input, including an
empty field, take precedence. The draft records its applied values and per-key
source provenance so its preparation can be reconstructed. A changed setting does
not rewrite old drafts, submitted quotations or reviewed proposals. No date is
guessed. Suppliers consume their own configuration, never the buyer's project
settings merely because a received RFQ carries a project ID. GUI users can inspect
and explicitly apply applicable defaults; typed form values survive refreshes.

The domain also consumes a callback exposing only the selected party's enabled,
paired exchange metadata. Such a peer has an explicit business role, realm ID,
human-configured name and pairing-record source. It appears as an external contact
and can be selected for RFQ/message delivery through the existing QEP adapter.
It never becomes a local login/account, a team member or an implicit authorization
grant. Disabled/unpaired routes cannot be used for a new invitation. Existing
records remain readable when a pairing is later unavailable; transmission reports
pending/refused honestly and does not fall back to another realm.

Public procurement projections continue to contain only reviewed business fields.
Configuration provenance and private contact/credential details remain local.
Incoming signed records still undergo the domain's participant, source, revision
and exact arithmetic checks. Local service fixtures and two independent complete
applications verify actual RFQ and quote delivery; a synthetic transport packet
alone is insufficient business evidence.

## Consequences

Settings, peer management and business validation retain distinct native owners.
Optional service callbacks keep isolated domain checks possible without a hard
composition cycle. New preparation/provenance records are additive application
data; ledger and QEP kernel formats and commitment gates do not change.

The feature does not discover unpaired internet parties, infer their identity from
an email address, copy secrets, share private costs or automatically commit a
default/template. Structured scope, negotiation and response promises remain
separately tracked G1 requirements.

## Alternatives rejected

| Alternative | Reason |
|---|---|
| Generic settings infers business ownership | Couples settings to procurement and bypasses explicit team authority. |
| Create local accounts for remote peers | Confuses transport identity with login permission and party membership. |
| Apply changed defaults to existing records | Rewrites authored or reviewed business terms without a human edit. |

## Revisit conditions

Revisit when another native domain needs shared scope providers, a paired-party
directory has a separate owner, or an explicit template/version workflow replaces
simple starting values. Preserve source provenance and human-reviewed commitments.
