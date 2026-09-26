# Native persistence baseline
<!-- budget: 4096 bytes, hard -->

Owner: [workspace-store](../../../../src/system/workspace-store/requirements/README.md).
Command: `node src/system/workspace-store/tests/performance.mjs` — PASS,
2026-09-26. [Raw result](report.json) records hardware, filesystem and record shape.

10,000 distinct records pass through real native Cordis/NDJSON and the existing
Python Ledger with fsync enabled. Total append time 27.85 s; mean 2.78 ms,
p95 3.08 ms, p99 4.07 ms, maximum 9.40 ms. A complete adapter-process remount rebuilds
all 10,000 records and the exact head hash in 1.15 s. The sequence 5000 projection
returns exactly 5000 records in 6.69 ms. These numbers describe this local container
sample, not a production SLO or a remote/concurrent storage claim.

The old adapter deep-copied every event for current-record lookup, malformed-row
counts and incremental responses after each write. The [interrupted baseline](interrupted-baseline.json)
reached 4629 records after 5 m 56 s before it was deliberately stopped. No complete
before/after speedup ratio or baseline percentile is claimed. The adapter now
maintains a process-local record/metadata index solely from exact ledger sequences
and emits only newly appended events. Disposal discards this cache; remount
reconstructs it. Kernel append, fsync, hashes and QEP semantics are unchanged.

NFR-PERF-003's historical 10 s / 10k target passes for this sample. NFR-PERF-002's
historical 5 ms every-event target does **not**: maximum 9.40 ms. Preserve that target
as an assumption with this measurement rather than pretending it passed. The
first completed harness run used a nonexistent `historyAt` method after remount;
the corrected harness calls the actual `projection` service and reran in full.

Regression: `node src/system/workspace-store/tests/exchange.mjs` — PASS9 groups.
[Report](exchange-regression.json) covers atomic revision conflicts, malformed
metadata counts, exact historical projection, independent roots, ordering/replay,
real HTTP retry, interrupted append/receive recovery and corrupt realm isolation.
