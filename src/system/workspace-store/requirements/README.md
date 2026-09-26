# Workspace persistence
<!-- budget: 4096 bytes, hard -->
Owns persistence requirements in [runtime contract](../../../../docs/design/architecture.md).
Every record version appends through existing Python Ledger. Public record delivery uses existing QEP.
Projection rebuild after restart must reproduce all account records; unload terminates adapter.
Source: `code/index.mjs`, `code/bridge.py`. Current boundaries are defined in
`docs/design/data-and-exchange.md`; owner contracts define application events.

NFR-PERF-002/003 retain measurable durability/rebuild baselines. Run
`node src/system/workspace-store/tests/performance.mjs` for 10,000 actual serial
native writes (default kernel fsync), per-event percentiles/max and a full native
process remount with exact record/head comparison. Report hardware/filesystem,
record shape and sample scope. Historical 5ms/10s numbers are targets, not universal
claims; an observed miss must stay explicit rather than changing the measurement.

Current adapter `refresh_index` derives latest records and malformed metadata counts
from exact ledger sequences once; current lookups and delta responses do not copy
the full history on every write. Process disposal discards the index; remount
rebuilds it. [Measured baseline](../../../../docs/work/evidence/native-store-performance-2026-09-26/README.md):
10k writes 27.85 s, p95 3.08 ms, max 9.40 ms; full reconstruction 1.15 s. The historical
every-write 5 ms target was not met in this sample.
