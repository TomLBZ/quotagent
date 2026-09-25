# Workspace persistence
<!-- budget: 4096 bytes, hard -->
Owns persistence requirements in [runtime contract](../../../../docs/product/runtime-contract.md).
Every record version appends through existing Python Ledger. Public record delivery uses existing QEP.
Projection rebuild after restart must reproduce all account records; unload terminates adapter.
Source: `code/index.mjs`, `code/bridge.py`. Product events are defined in `docs/product/events.md`.
