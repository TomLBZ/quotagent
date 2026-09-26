# Account files
<!-- budget: 4096 bytes, hard -->

`code/index.mjs` provides `ctx.files.list/get/read/put`; all operations require an account.
Content is stored by SHA-256 within an account-specific directory under the workspace-store root.
Metadata enters the account ledger through `files/uploaded`; removal from the library uses
`files/removed-from-library`. Original bytes remain available for recorded extraction provenance.

HTTP: `GET/POST /files`, `GET /files/:id/download`, `DELETE /files/:id`.
Upload body: `{filename,mime,contentBase64}`. The user setting `file-store.maxFileMb` defaults to 10 MB,
with an upper limit of 20 MB. Read-only accounts cannot upload or remove files.

All service, route and settings registrations are Cordis-owned and disposable. File content is durable
account data, not plugin process state; unloading the service leaves user documents intact.

Executable evidence: `node src/domain/ingestion/tests/smoke.mjs` uploads and reads actual original bytes,
checks owner-only retrieval, parses attachment files and creates private drafts through the real ledger.

Artifact lifecycle, capacity, read-only observations, shared-content disposal and
bounded previews extend this API; see [lifecycle acceptance](lifecycle.md). The
`maxTotalMb` setting defaults to 1024 MB. Archive preserves original bytes; physical
disposal requires the separate retention review and records a distinct tombstone.
