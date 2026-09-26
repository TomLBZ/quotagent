# Document ingestion
<!-- budget: 4096 bytes, hard -->

Owner: native Cordis `ingestion` plugin, `code/index.mjs`; GUI `client/ingestion.jsx` with its own CSS.
Contract: `docs/design/architecture.md`. Requires store, files, web, procurement and settings;
assistant tools are installed through deferred injection. No provider is required for traditional parsing.

The one-click **Ingest documents** page supports multi-file upload, automatic or explicit parser choice,
original downloads, source text/rows/attachments, editable column mapping and line items, optional live AI
extraction, and private draft creation. Contractors create RFQs; suppliers match an invited RFQ and create
their own quotes. Quantity, unit and currency mismatches require explicit review. No currency/unit
conversion occurs. No import publishes, submits or makes a commercial commitment.

`ctx.ingestion` exposes `engine(definition) => disposer`, `catalog(user)`, `list/get`, `parse`, `extract`,
`update`, and `importDraft`. Engines receive buffers and return text, rows, metadata, warnings and optional
attachment buffers. Automatic mapping recognizes different heading aliases per table; explicit mapping
uses the chosen columns. Missing values stay blank. Recognized explicit currency codes and £/€ symbols
are preserved; unspecified currency uses the account preference and is editable before import.

Routes: `GET /ingestion`, `GET/PATCH /ingestion/:id`, `POST /ingestion/upload`, `POST /ingestion/parse`,
`POST /ingestion/:id/extract`, `POST /ingestion/:id/import`. Upload accepts `{engine,files:[{filename,mime,
contentBase64}]}`. All writes check workspace write access.
`ingestion_list`, `ingestion_read`, `ingestion_extract` give the assistant account-owned document context
and editable AI results with a review action.

The account ledger stores complete preview text, source rows, original hash/file ID, mapping, edited
items, model extraction and resulting draft IDs. Events: `ingestion/document-parsed`,
`ingestion/extraction-edited`, `ingestion/ai-extracted`, `ingestion/imported-to-private-draft`.
Sources and private costs remain account-owned.

Retained FR-INTAKE-001/002/003: each item retains its stable ID and source row or
an exact excerpt found in the stored source. Missing or unmatched references are
labelled **Assumption — needs confirmation**. Human confirmation is bound to the
exact item digest, retained in `ingestion/assumptions-reviewed`, and invalidated
by subsequent edits. An unconfirmed assumption cannot enter a private draft.
Missing description/quantity/unit/offer price generates a private, source-linked
question list. The GUI can discuss it with the assistant; outbound clarification
still uses procurement's human review. Extraction never sends those questions.

User configuration ID `ingestion`: defaultEngine, currency, delimiter, maxRows and aiInstructions.
Limits with explicit warnings: 250,000 preview characters, configurable 1–10,000 rows (default 500),
30 attachments per message source and two nested attachment levels. Original bytes remain stored.
AI reads up to 80,000 text characters and 250 rows/items; requires an available account/global AI provider.
An empty or unsupported attachment produces a warning while retaining the usable parent document.

Evidence commands:

- `node src/domain/ingestion/tests/smoke.mjs`: real Cordis + Python Ledger, email attachment, mixed-sheet
  headings, account ownership, private RFQ/quote, exact total, currency/unit refusals, empty attachment,
  optional AI and disposable engines/routes/tools.
- `node src/domain/ingestion-engines/tests/parsers.mjs`: real format fixtures.
- `BASE_URL=https://novara.remoteblossom.com/quotagent/ node src/domain/ingestion/tests/browser.mjs`:
  GUI-only email + live AI → private RFQ and XLSX → private supplier quote. Requires demo accounts/provider;
  creates private demo drafts. Screenshots and observations go to `tmp/product-evidence/ingestion`.

Application events retain existing ledger formats. All registrations use disposable Cordis effects.
