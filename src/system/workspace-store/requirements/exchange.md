# Native adapter durable exchange
<!-- budget: 4096 bytes, hard -->

Implementation and executable acceptance are defined once in the
[exchange workbench requirements](../../exchange-workbench/requirements/README.md).
Protocol/ledger extension rationale is [ADR-0037](../../../../docs/design/adr/0037-native-durable-qep-exchange.md).
The Python Ledger/QEP kernels remain unchanged. New adapter events and transfer
body schema are additive; old workspace-record/v1 projection semantics remain.

The store service must remain compatible for current get/list/events/put/append
callers. Existing `exchange` calls acquire durable identity/retry/receipt behavior
through domain-owned policy registrations. All registrations return disposers and
adapter shutdown rejects pending requests without leaving workers/timers alive.
