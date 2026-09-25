# ADR-0029 Configurable runtime inventory and modular ingestion
<!-- budget: 8192 bytes, hard -->
Status: accepted

## Problem

The current studio lists generated extensions only, confuses copied/global instances,
and has no configuration surface. Background resource refresh unmounts content.
Pasted-text-only intake leaves common source documents outside the quotation flow.
Source: user's five follow-up requirements and current studio/webui implementations.

## Decision

Add native configuration, runtime inventory and file-storage services. Each plugin
registers its own schema and consumes effective settings. Admin manages server
settings/runtime lifecycle; clients configure their own overrides/extensions. Runtime
inventory reflects actual Cordis fibers and distinguishes repository-only sources.
Generated extension lineage identifies personal/global overrides. Configuration edits
remount effects instead of creating extra live registrations.

Create ingestion and format-engine plugins with upload/preview/review contributions.
Traditional parsing and real-model extraction retain account/source provenance and
produce editable drafts. Files and extracted source are account-local; public exchange
still uses the existing QEP adapter. Add settings/file/ingestion event families without
changing existing ledger or QEP semantics. Credentials stay outside event payloads.
The [product contract](../../product/plugin-workspace-contract.md) defines service and
acceptance interfaces. Existing runtime ADR-0027 and utility ADR-0028 remain valid.

## Consequences

Users can customize actual behavior and import common business documents through GUI.
Admin can distinguish running capabilities from source packages. More plugin services
introduce lifecycle/dependency ordering; parsing quality and unsupported file forms
must be explicit. Generated or AI-extracted content still needs user review.

## Alternatives rejected

| Alternative | Reason |
|---|---|
| Show source manifests as enabled plugins | A file does not prove a live service |
| Edit a second config copy in each UI | Creates divergent values and persistence |
| One monolithic upload parser in WebUI | Couples the generic shell to business formats |
| Rebuild the page during periodic polling | Destroys user input and causes visible flashing |

## Revisit conditions

Revisit when configuration needs external secret synchronization, ingestion needs
streaming huge files/OCR, or runtime lifecycle requires coordinated rolling restarts.
