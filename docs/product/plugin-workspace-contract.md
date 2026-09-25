# Configurable plugin workspace and ingestion
<!-- budget: 12288 bytes, hard -->

Source: user's five follow-up requirements, 2026-09-25. This extends the
[runtime contract](runtime-contract.md). Public acceptance passed; see the
[commands, reports and screenshots](../work/evidence/plugin-workspace-2026-09-25/README.md).

| Requirement | Owner | Observable acceptance |
|---|---|---|
| Stable studio and unique extensions | system/webui + system/plugin-studio | Background refresh preserves cards, input and focus; each extension lineage appears once per scope with clear owner/global labels |
| Installed marketplace state | system/plugin-studio | Owner/personal/global installation recognized; repeated install is idempotent; installed entries lead to management |
| Complete admin plugin inventory | system/plugin-manager | Actual runtime plugins including child services/engines listed; repository-only capabilities identified as available, never falsely active; real supported lifecycle changes reflected |
| Editable persistent configuration | system/settings + each plugin | Credentials/preferences/knobs saved through schema-driven UI; secret values masked; behavior changes and survives restart; personal theme uses color controls |
| Modular real ingestion | system/file-store + domain/ingestion + engine plugins | Upload exported email, Excel, CSV and documents; parse via traditional engines or actual AI extraction; inspect/edit data and create private business drafts in GUI |

## Configuration

`ctx.settings.define({id,name,scope,fields,defaults})` registers a schema through a
Cordis-owned effect and returns its disposer. Scope is `user` (account override on
top of global defaults) or `admin` (server setting). IDs are slash-free. Field types
are text/textarea/password/number/boolean/select/color. `get(user,id)` returns effective values
to the owning plugin; `view(user,id)` masks secrets and exposes schema; `list(user)`
returns accessible schemas. `GET/PATCH /settings/:id` display/save values. PATCH
accepts `{values,clearSecrets?,reset?}`; an empty password means keep the saved credential.

Non-secret settings versions append `settings/config-saved` events. Credentials are
persisted privately through the settings plugin, excluded from ledger/settings reads
and model prompts. AI connection resolution requires a personal key when the user
changes the inherited provider or endpoint; other preferences preserve shared access.
Actual model request parameters remain ledger recorded. Config
changes do not themselves execute external commitments. UI refresh reconciles saved
state without replacing a form being edited. Effective user values inherit server
defaults, and source/override state is visible rather than duplicated config knobs.

## Inventory and identity

The plugin manager registers actual Cordis fibers and inspects child registrations.
Admin sees infrastructure, business features and ingestion engines, alongside clearly
identified repository-only plugins. Available source is not proof of a running
capability. Essential bootstrap services explain why disabling would remove access.
Managed lifecycle acts on actual fibers, observes dependencies, and survives restart.

Generated plugin identity follows origin lineage. A personal copy can override a
global contribution without rendering duplicate widgets. Admin can inspect distinct
instances with explicit scope/owner. Publishing/installing/promoting does not clone
copies repeatedly. Marketplace cards expose installation and enablement separately.
Generated theme/widget/skill/tool settings can be edited; enabled modules are
remounted through Cordis so their UI and callable effects reflect saved configuration.

## Ingestion

File storage is a separate native plugin; uploads are account-owned and metadata is
recorded. Engines register parsers, accepted formats and configuration through effects.
Traditional parsing remains available without AI. Email headers/body, sheet names,
rows and document text retain source identity. Parsing errors are visible and do not
masquerade as empty success. Text extraction and AI results are durable account facts.

The ingestion UI owns file selection/upload, parser selection, preview, mapping and
editable line review. AI extraction calls the configured provider with the actual
source, leaves unspecified quantities/prices unresolved and creates drafts for human
review. Imports must not publish RFQs, submit quotes or make commitments. Supplier drafts
require explicit RFQ-line matches and matching quantities, units and currency; there
is no implicit currency or unit conversion. Exact format
support and tested fixtures are documented with evidence; scanned-image OCR or any
unimplemented format must not be implied by a generic file picker.

## Supported formats and limits

| Engine | Formats and behavior |
|---|---|
| Email | EML with MIME attachments; MBOX message archives; Outlook MSG plain/HTML bodies and attachments |
| Spreadsheet | XLSX and binary XLS, all sheets with individual heading aliases; saved formula results |
| Tabular | CSV/TSV with configured or detected delimiter, quoted fields/newlines, UTF-8 or BOM-marked UTF-16 |
| Documents | DOCX tables/text, PDF text layers, HTML tables/text, TXT/Markdown and structured JSON |
| AI | Actual configured provider extracts reviewed lines and source excerpts from persisted parsed content |

Sixteen generated real-format fixtures are covered by the parser command. XLSM/XLSB/ODS
are accepted by the spreadsheet library but not separately fixture-tested. Scanned PDFs
require external OCR; legacy Word `.doc` and RTF-only MSG bodies require another export.
PDF text extraction does not promise layout-perfect tables. Empty/unsupported attachments
warn without discarding usable parent content. Source: [engine requirements](../../src/domain/ingestion-engines/requirements/README.md).

File limits default to 10 MB per file, configurable to 20 MB. The preview preserves up
to 250,000 characters and configured rows (default 500, max 10,000); AI sees up to 80,000
characters and 250 rows/items. Truncation is reported. Parsed originals remain downloadable.
Sources: [file store](../../src/system/file-store/code/index.mjs),
[ingestion](../../src/domain/ingestion/code/index.mjs), [AI engine](../../src/domain/ingestion-engines/code/ai.mjs).

## Verification

Use public https://novara.remoteblossom.com/quotagent/ with separate client/admin
sessions. Observe more than two refresh intervals while typing in a configuration
form; confirm cards remain mounted and values/focus persist. Install/publish/promote
one lineage and verify no duplicated personal/global rendering or misleading install.
Inspect inventory against actual mounted fibers and repository manifests. Save and
reload a theme, AI credential/model setting and ingestion option; demonstrate changed
behavior and restart persistence. Upload real fixtures in each supported family,
inspect parsed source and resulting editable business draft; exercise actual AI
extraction and traditional parsing separately. Publish command/output/screenshot
summaries under docs/work/evidence before accepting these requirements.
