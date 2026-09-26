# Uncertain storage outcomes
<!-- budget: 2048 bytes, hard -->

Owner: [workspace-store](../../../../src/system/workspace-store/requirements/README.md).
Retained SUPPLEMENT-026. `python3 src/system/workspace-store/tests/io-failures.py`
— [five groups PASS](report.json), 2026-09-26.

Controlled ENOSPC, EACCES and fsync errors surround actual temporary ledger writes.
An actual partial JSON tail remains untouched and fails verified reopen. A complete
append whose fsync response failed reappears as the exact recorded value after
restart. The affected realm refuses subsequent writes; a separate healthy realm
continues. An actual NDJSON subprocess confirms503, explicit uncertain outcome,
unhealthy realm metadata, later-write refusal and other-realm success.

The adapter pauses access following an OS failure instead of allowing another append
past a possibly partial tail. Existing kernel write/hash/fsync semantics are unchanged.
No bytes are automatically repaired or deleted. These are injected OS faults against
real local files, not a claim that the production filesystem was exhausted or its
permissions changed. The earlier corruption/CAS/exchange evidence remains separate.
