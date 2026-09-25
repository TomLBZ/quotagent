import { createProcurement } from './service.mjs'
import { createHash } from 'node:crypto'

export const name = 'procurement'
export const inject = ['store', 'accounts', 'web']
export const provides = ['procurement']

const string = (description) => ({ type: 'string', description })
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const item = object({ id: string('RFQ item ID, e.g. item-1'), description: string('Exact item specification'),
  quantity: { type: 'number', description: 'Positive required quantity' }, unit: string('Unit of measure'),
  unitPrice: { type: 'number', description: 'Quoted unit price, up to two decimal places' },
  cost: { type: 'number', description: 'Optional PRIVATE supplier unit cost; never sent to buyer' } }, ['description', 'quantity', 'unit'])

export async function apply(ctx) {
  const procurement = createProcurement({ store: ctx.store, accounts: ctx.accounts })
  let reviews = null
  const labels = { 'send-message': 'Send project message', 'publish-rfq': 'Publish request', 'submit-quote': 'Submit quotation', award: 'Award and issue order', 'acknowledge-order': 'Acknowledge order', 'approve-change': 'Approve order change' }
  const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value
  const fingerprint = value => createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex')
  const reviewInput = (user, action, input) => {
    const data = procurement.snapshot(user)
    const allowed = user.role === 'contractor' ? ['send-message', 'publish-rfq', 'award', 'approve-change'] : ['send-message', 'submit-quote', 'acknowledge-order']
    if (!allowed.includes(action)) throw new Error('This action belongs to the other party.')
    const id = action === 'award' ? input.quoteId || input.id : action === 'send-message' ? input.rfqId : input.id
    const collection = { 'send-message': data.rfqs, 'publish-rfq': data.rfqs, 'submit-quote': data.quotes, award: data.quotes, 'acknowledge-order': data.orders, 'approve-change': data.changes }[action]
    const record = collection?.find(row => row.id === id)
    if (!record) throw new Error('That record is not available in this account.')
    const wantedStatus = { 'publish-rfq': 'draft', 'submit-quote': 'draft', award: 'submitted', 'acknowledge-order': 'issued', 'approve-change': 'proposed' }[action]
    if (wantedStatus && record.status !== wantedStatus) throw new Error(`This ${action === 'approve-change' ? 'change' : 'record'} is no longer ${wantedStatus}. Review its current state.`)
    const order = record.orderId ? data.orders.find(row => row.id === record.orderId) : action === 'acknowledge-order' ? record : null
    const rfq = data.rfqs.find(row => row.id === (record.rfqId || order?.rfqId || record.id))
    const recipientIds = action === 'publish-rfq' ? record.supplierIds : [action === 'send-message' ? input.toId : user.role === 'supplier' ? rfq?.ownerId || record.ownerId : record.supplierId || order?.supplierId]
    const recipients = recipientIds.map(recipientId => data.contacts.find(row => row.id === recipientId))
    if (!recipients.length || recipients.some(person => !person)) throw new Error('Choose active counterparties from this project before preparing the action.')
    let payload = action === 'award' ? { quoteId: id } : { id }
    if (action === 'send-message') {
      if (user.role === 'supplier' ? input.toId !== rfq.ownerId : rfq.ownerId !== user.id || !rfq.supplierIds.includes(input.toId)) throw new Error('Choose a counterparty invited to this request.')
      const text = String(input.text || '').trim()
      if (!text) throw new Error('Write the message to review.')
      payload = { rfqId: id, toId: input.toId, text, kind: ['message', 'clarification', 'negotiation'].includes(input.kind) ? input.kind : 'message' }
    }
    const targets = { record, rfq: rfq || null, order, recipients }
    const amount = action === 'approve-change' ? record.amount : record.total
    const preview = { title: record.title || rfq?.title || order?.title || 'Project commitment', label: labels[action], recipients: recipients.map(person => ({ id: person.id, name: person.company || person.name, email: person.email })),
      ...(typeof amount === 'number' ? { amount } : {}), currency: record.currency || rfq?.currency || order?.currency || 'USD',
      ...(action === 'send-message' ? { text: payload.text, kind: payload.kind } : { items: (record.items || []).map(({ id, description, quantity, unit, unitPrice, total }) => ({ id, description, quantity, unit, ...(unitPrice !== undefined ? { unitPrice } : {}), ...(total !== undefined ? { total } : {}) })),
        description: record.description || '', notes: record.notes || '', paymentTerms: record.paymentTerms || '', leadDays: record.leadDays, deadline: action === 'publish-rfq' ? record.deadline : undefined }) }
    return { action, payload, reviewed: targets, preview, fingerprint: fingerprint(targets) }
  }
  const propose = async (user, action, input, context = {}) => {
    if (!reviews) throw new Error('Enable Review actions to prepare this commitment.')
    const frozen = reviewInput(user, action, input)
    const amount = typeof frozen.preview.amount === 'number' ? ` · ${new Intl.NumberFormat('en-US', { style: 'currency', currency: frozen.preview.currency }).format(frozen.preview.amount)}` : ''
    const proposal = await reviews.propose(user, { kind: 'procurement.commit', title: `${labels[action]}: ${frozen.preview.title}`, summary: `${frozen.preview.recipients.map(person => person.name).join(', ')}${amount}`, input: frozen,
      source: { kind: context.source || 'assistant', plugin: 'procurement', ...(context.stepId ? { stepId: context.stepId } : {}) }, runId: context.runId || null })
    return { ok: true, reviewRequired: true, proposal, action: { type: 'navigate', label: 'Review procurement action', input: { view: 'approvals', actionId: proposal.id } }, message: 'Saved for human review. Nothing has been sent or committed.' }
  }
  ctx.inject(['actions'], inner => {
    reviews = inner.actions
    inner.effect(() => () => { reviews = null })
    inner.effect(() => inner.actions.register({ kind: 'procurement.commit', label: 'Procurement commitment', execute: async (user, input, action, { signal } = {}) => {
      if (signal?.aborted) throw new Error('This action was canceled before execution.')
      const current = reviewInput(user, input.action, input.payload)
      if (current.fingerprint !== input.fingerprint) throw new Error('This project, quotation, recipient or order changed after the proposal. Prepare a new review of its current details.')
      const result = await procurement.execute(user, input.action, { ...input.payload, confirmed: true })
      const target = result.order ? { view: 'orders', orderId: result.order.id, rfqId: result.order.rfqId } : input.action === 'send-message' ? { view: 'messages', rfqId: input.payload.rfqId } : result.quote ? { view: 'quotes', quoteId: result.quote.id, rfqId: result.quote.rfqId } : { view: 'rfqs', rfqId: result.rfq?.id || input.payload.id }
      return { ...result, approvalId: action.id, action: { type: 'navigate', label: 'Open project result', input: target } }
    } }))
  })
  // The advertised demo opens on useful, labelled data. Seed only the built-in
  // identities; the existing idempotent action preserves their later work.
  const demoAccounts = [
    ['contractor-demo', 'contractor@demo.local', 'contractor'],
    ['supplier-demo', 'supplier@demo.local', 'supplier'],
    ['supplier2-demo', 'supplier2@demo.local', 'supplier'],
  ].map(([id, email, role]) => {
    const account = ctx.accounts.get(id)
    return account?.email === email && account.role === role && !account.disabled ? account : null
  })
  if (demoAccounts.every(Boolean) && !demoAccounts[0].permissions?.includes('workspace:read-only')) {
    await procurement.execute(demoAccounts[0], 'seed-demo')
  }
  ctx.provide('procurement', procurement)
  ctx.effect(() => ctx.web.route('GET', '/workspace', ({ user }) => procurement.snapshot(user)))
  ctx.effect(() => ctx.web.route('GET', '/workspace/export', ({ user, query, res }) => {
    const rfqId = typeof query?.get === 'function' ? query.get('rfqId') : query?.rfqId
    const csv = procurement.exportCsv(user, rfqId)
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="quotation-comparison.csv"' })
    res.end(csv)
  }))
  ctx.effect(() => ctx.web.route('POST', '/workspace/:action', ({ user, params, body }) => procurement.execute(user, params.action, body), { capability: 'workspace:write' }))
  for (const [id, label, icon, roles, order] of [
    ['workspace', 'Overview', 'LayoutDashboard', ['contractor', 'supplier'], 10],
    ['rfqs', 'Requests', 'ClipboardList', ['contractor', 'supplier'], 20],
    ['quotes', 'Quotes', 'FileText', ['contractor', 'supplier'], 30],
    ['orders', 'Orders', 'Package', ['contractor', 'supplier'], 40],
    ['messages', 'Messages', 'MessageSquare', ['contractor', 'supplier'], 50],
  ]) ctx.effect(() => ctx.web.contribute({ id, label, icon, roles, order }))

  // Deferred injection avoids a cycle: the assistant may itself depend on procurement.
  ctx.inject(['assistant'], (inner) => {
    const register = (tool) => inner.effect(() => inner.assistant.tool(tool))
    register({ name: 'procurement_workspace', description: 'Read the signed-in account\'s RFQs, current quotes, orders, messages and comparison. Supplier private costs are visible only to that supplier. Use this before grounded recommendations.',
      roles: ['contractor', 'supplier'], parameters: object({ rfqId: string('Optional RFQ to focus on') }),
      execute(user, args) {
        const data = procurement.snapshot(user)
        if (!args.rfqId) return data
        return { ...data, rfqs: data.rfqs.filter((row) => row.id === args.rfqId), quotes: data.quotes.filter((row) => row.rfqId === args.rfqId),
          orders: data.orders.filter((row) => row.rfqId === args.rfqId), messages: data.messages.filter((row) => row.rfqId === args.rfqId),
          comparison: data.comparison.filter((row) => row.rfqId === args.rfqId) }
      } })
    register({ name: 'draft_rfq', description: 'Create an editable PRIVATE RFQ draft from extracted requirements. Cite uncertainties in the description; never invent quantities. This does not publish or contact suppliers.',
      roles: ['contractor'], parameters: object({ id: string('Optional existing unpublished RFQ draft ID to edit'), title: string('RFQ title'), description: string('Scope and unresolved assumptions'),
        deadline: string('Optional ISO date'), currency: string('Three-letter currency code'), items: { type: 'array', items: item },
        supplierIds: { type: 'array', items: string('Supplier account ID from contacts') } }, ['title', 'items']),
      async execute(user, args) {
        const result = await procurement.execute(user, 'create-rfq', args, { agent: true })
        return { ...result, action: { action: 'navigate', label: 'Review RFQ draft', input: { view: 'rfqs', rfqId: result.rfq.id } } }
      } })
    register({ name: 'draft_quote', description: 'Prepare an editable PRIVATE supplier quote using actual RFQ item IDs and the user\'s authorized prices/costs. Never send it; human review is required. Missing price guidance should be discussed first.',
      roles: ['supplier'], parameters: object({ id: string('Optional existing draft ID'), rfqId: string('Invited RFQ ID'), items: { type: 'array', items: item },
        leadDays: { type: 'integer' }, paymentTerms: string('Payment terms'), notes: string('Public quote notes'), privateNotes: string('Private supplier notes') }, ['rfqId', 'items']),
      async execute(user, args) {
        const result = await procurement.execute(user, 'save-quote', args, { agent: true })
        return { ...result, action: { action: 'navigate', label: 'Review quote draft', input: { view: 'quotes', quoteId: result.quote.id, rfqId: result.quote.rfqId } } }
      } })
    register({ name: 'compare_quotes', description: 'Get exact arithmetic and explicit risks for current submitted quotes, with source quote and RFQ references. Does not award or change data.',
      roles: ['contractor'], parameters: object({ rfqId: string('RFQ ID to compare') }, ['rfqId']),
      execute(user, args) {
        const data = procurement.snapshot(user)
        return { rfq: data.rfqs.find((row) => row.id === args.rfqId), quotes: data.comparison.filter((row) => row.rfqId === args.rfqId),
          note: 'Compare complete scope, delivery and payment terms. Cheapest total alone does not establish best value.' }
      } })
    register({ name: 'draft_message', effect: 'proposal', description: 'Save an exact clarification or negotiation message in the durable human review queue. Does NOT send or make a price concession. The user can decline and request a revision before approving.',
      roles: ['contractor', 'supplier'], parameters: object({ rfqId: string('RFQ ID'), toId: string('Recipient account ID'),
        text: string('Draft message text'), kind: { type: 'string', enum: ['message', 'clarification', 'negotiation'] } }, ['rfqId', 'toId', 'text']),
      execute: (user, args, context) => propose(user, 'send-message', args, context) })
    register({ name: 'prepare_commitment', effect: 'proposal', description: 'Save an exact durable human review proposal for publishing, quote submission, award, order acknowledgment or change approval. Nothing is committed until a person approves; changed target records require a fresh review.',
      roles: ['contractor', 'supplier'], parameters: object({ action: { type: 'string', enum: ['publish-rfq', 'submit-quote', 'award', 'acknowledge-order', 'approve-change'] },
        id: string('RFQ, quote, order or change ID'), quoteId: string('Quote ID for award') }, ['action']),
      execute: (user, args, context) => propose(user, args.action, args, context) })
  })
}
