# Procurement workspace
<!-- budget: 4096 bytes, hard -->

Owner of business capabilities in [the product architecture](../../../../docs/design/architecture.md): RFQ preparation/publication, item import, private costing, quote drafting/submission, exact comparison, clarifications/negotiation, human award/order/acknowledgment, changes, CSV and labelled demo data.

`code/index.mjs` registers the HTTP routes, navigation and assistant tools through Cordis effects. `code/service.mjs` implements account-owned business operations using the workspace store. Public exchanges contain explicitly selected fields; supplier costs and private notes stay in the supplier account.

Agent tools may create editable drafts and prepare review proposals. They cannot publish RFQs, submit quotes, send messages, award orders, acknowledge or approve changes. These operations require a signed-in person's UI action; commitments additionally require `confirmed: true` and append a human approval event.

`draft_message` and `prepare_commitment` save `procurement.commit` actions through the shared action center. Each proposal freezes the exact input, target records and recipients, retains its originating agent run, and opens Review actions from chat or workroom. The procurement-owned [preview](../client/proposal-preview.jsx) displays recipient, body, scope, price, terms and deadline. Approval rechecks the frozen records before calling the existing domain operation with human confirmation; a changed target requires a new review. Messages can be declined and redrafted; the ordinary business GUI remains editable. The execution receipt links back to the project result. Source: [registration and executor](../code/index.mjs).

Business events retain the `procurement/` namespace. `procurement/human-approved` is an approval **fact**, with the action, signed-in human, record ID and reviewed scope. QEP transport and ledger formats remain implemented by the workspace-store plugin and existing kernels.

Validation: `node src/domain/procurement/code/smoke.mjs` exercises two-party RFQ → quote → comparison → order → acknowledgment → approved change, private-cost non-disclosure, ownership and idempotent demo generation. Public-browser evidence is linked from the focused contracts below.

The [RFQ lifecycle contract](rfq-lifecycle.md) adds project/section context, private
amendments and immutable published revisions, quote version binding and rebids,
structured shared clarifications, and source-linked account FAQ. Its native module,
GUI/tools and focused real-ledger/browser checks implement the first G1 slice.

The [bilateral fulfillment contract](fulfillment.md) replaces instant award with
nonbinding selection, supplier confirmation and independently reviewed signing.
Sourced line changes need both parties and a scoped grant; delivery acceptance
and invoice reconciliation retain discrepancies and references without payment.
`fulfillment.mjs` owns these states; its GUI and real-ledger tests cover them.

The [draft defaults and paired-party contract](context-defaults-and-peers.md)
adds sourced account/workspace/project/section defaults and explicitly paired
external business contacts. New drafts retain their preparation basis locally;
two independent applications exchange reviewed RFQs and quotations through QEP.

The [scope, term and negotiation contract](scope-terms-negotiation.md) adds declared
measurement/interfaces, exact source-unit normalization, typed deviations, term
revision decisions and private bounded concessions requiring human action review.

The [public declaration contract](public-declarations.md) requires complete authored
measurement and responsibility for new publications, preserves named firm/indicative
milestones and qualifications through PO signing, and implements source-bound
structured FAQ publication, exact lookup, reviewed adaptation and deprecation.
