# Ingestion engines
<!-- budget: 4096 bytes, hard -->

Each module under `code/` is an independently mountable native Cordis plugin. Its engine is registered
with `ctx.effect(() => ctx.ingestion.engine(...))`; unloading removes it from the catalog and selection.
`code/index.mjs` also offers a reusable composite. The product mounts the five engines separately.

| Module / engine | Implemented source handling |
| --- | --- |
| `spreadsheet.mjs` / spreadsheet | XLSX and binary XLS, all worksheets, header discovery, saved formula results. SheetJS also accepts XLSM/XLSB/ODS. Original sheet and row data retained. |
| `tabular.mjs` / tabular | CSV/TSV, auto or configured delimiter, quoted delimiters/newlines, UTF-8 and BOM-marked UTF-16. |
| `email.mjs` / email | MIME EML, MBOX messages, Outlook MSG plain/HTML bodies, headers, tables and attached documents. Parent ingestion recursively parses supported attachments. |
| `documents.mjs` / documents | DOCX tables/text, PDF text layers, HTML tables/text, TXT/Markdown, JSON arrays or items/rows/lineItems/data arrays. |
| `ai.mjs` / ai | Optional real `ctx.ai.complete` extraction over persisted parsed source. Returns editable structured line items and source excerpts; never commits. Account-specific provider availability controls catalog state. |

Limits are explicit in source and GUI: scanned/image-only PDFs have no OCR; encrypted PDFs require an
unlocked export; legacy `.doc` is unsupported; RTF-only Outlook bodies need EML/text export; spreadsheet
formulas use saved values rather than recalculation. PDF extraction reads at most 200 pages, MBOX at most
100 messages. Ambiguous prose needs manual editing or AI; traditional parsers do not guess missing quantities.
PDF layout extraction is textual, not a promise of perfect table reconstruction. HTML/Word tables can
be mapped traditionally. AI is optional and its suggestions always require review.

Traditional parsers use pinned host dependencies: SheetJS xlsx, csv-parse, mailparser, @kenjiuno/msgreader,
mammoth, pdfjs-dist and html-to-text. Source APIs:
[SheetJS input](https://docs.sheetjs.com/docs/solutions/input/),
[SheetJS table utilities](https://docs.sheetjs.com/docs/api/utilities/),
[Mammoth](https://github.com/mwilliamson/mammoth.js),
[PDF.js Node example](https://github.com/mozilla/pdf.js/blob/master/examples/node/getinfo.mjs),
[MSG reader](https://hiraokahypertools.github.io/msgreader/typedoc/classes/MsgReader.default.html).

Engine settings belong to shared `ingestion` schema (CSV delimiter, row limit and AI instructions);
provider/model settings belong to `ai`. No unrelated per-engine configuration is invented.

Run `node src/domain/ingestion-engines/tests/parsers.mjs` to generate and read actual binary XLS/XLSX,
OOXML DOCX, PDF, UTF-16 TSV, multiline CSV, HTML/JSON/text, MIME attachment email, MBOX and CFB MSG fixtures.
The mixed-heading workbook checks two sheets with different common aliases. Scanned PDF has an explicit
no-text warning. Additional accepted XLSM/XLSB/ODS variants are library-supported but are not separately
covered by these fixtures. `node src/domain/ingestion/tests/smoke.mjs` exercises account-owned ingestion,
the real ledger, private drafts and engine disposal.
