# Procurement workspace
<!-- budget: 4096 bytes, hard -->

Owner of business capabilities in [the product runtime contract](../../../../docs/product/runtime-contract.md): RFQ preparation/publication, item import, private costing, quote drafting/submission, exact comparison, clarifications/negotiation, human award/order/acknowledgment, changes, CSV and labelled demo data.

`code/index.mjs` registers the HTTP routes, navigation and assistant tools through Cordis effects. `code/service.mjs` implements account-owned business operations using the workspace store. Public exchanges contain explicitly selected fields; supplier costs and private notes stay in the supplier account.

Agent tools may create editable drafts and prepare review proposals. They cannot publish RFQs, submit quotes, send messages, award orders, acknowledge or approve changes. These operations require a signed-in person's UI action; commitments additionally require `confirmed: true` and append a human approval event.

`draft_message` and `prepare_commitment` save `procurement.commit` actions through the shared action center. Each proposal freezes the exact input, target records and recipients, retains its originating agent run, and opens Review actions from chat or workroom. The procurement-owned [preview](../client/proposal-preview.jsx) displays recipient, body, scope, price, terms and deadline. Approval rechecks the frozen records before calling the existing domain operation with human confirmation; a changed target requires a new review. Messages can be declined and redrafted; the ordinary business GUI remains editable. The execution receipt links back to the project result. Source: [registration and executor](../code/index.mjs).

`create-rfq` accepts an optional `id` to edit the account's unpublished draft, including items and invited supplier IDs. Quote revisions supersede previous submitted quotes only when submitted; comparison excludes superseded versions. Exact line totals round to cents, and margin is unknown until every quoted item has a private cost.

Business events retain the `procurement/` namespace. `procurement/human-approved` is an approval **fact**, with the action, signed-in human, record ID and reviewed scope. Draft/publication, quote submission/supersession, messages, order issue/acknowledgment and change proposal/approval each use their named event in `service.mjs`. QEP transport and ledger formats remain implemented by the workspace-store plugin and existing kernels.

Validation: `node src/domain/procurement/code/smoke.mjs` exercises two-party RFQ → quote → comparison → order → acknowledgment → approved change, private-cost non-disclosure, ownership and idempotent demo generation. Public-browser acceptance remains owned by the product runtime contract.
