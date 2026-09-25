import { createProcurement } from './service.mjs'

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
    register({ name: 'draft_message', description: 'Prepare a clarification or negotiation message for review. Returns an editable send action; does NOT send or make a price concession.',
      roles: ['contractor', 'supplier'], parameters: object({ rfqId: string('RFQ ID'), toId: string('Recipient account ID'),
        text: string('Draft message text'), kind: { type: 'string', enum: ['message', 'clarification', 'negotiation'] } }, ['rfqId', 'toId', 'text']),
      execute(user, args) {
        const rfq = procurement.snapshot(user).rfqs.find((row) => row.id === args.rfqId)
        if (!rfq) throw new Error('Choose an RFQ from your workspace.')
        return { draft: args, reviewRequired: true, action: { action: 'send-message', label: 'Review message', input: args },
          message: 'Draft only. The user must review and send it.' }
      } })
    register({ name: 'prepare_commitment', description: 'Prepare a review button for publishing, quote submission, award, order acknowledgment or change approval. Never commits, sends, confirms or changes the record.',
      roles: ['contractor', 'supplier'], parameters: object({ action: { type: 'string', enum: ['publish-rfq', 'submit-quote', 'award', 'acknowledge-order', 'approve-change'] },
        id: string('RFQ, quote, order or change ID'), quoteId: string('Quote ID for award') }, ['action']),
      execute(user, args) {
        const data = procurement.snapshot(user)
        const collection = { 'publish-rfq': data.rfqs, 'submit-quote': data.quotes, award: data.quotes,
          'acknowledge-order': data.orders, 'approve-change': data.changes }[args.action]
        const id = args.action === 'award' ? args.quoteId || args.id : args.id
        const record = collection?.find((row) => row.id === id)
        if (!record) throw new Error('That record is not available in this account.')
        const allowed = user.role === 'contractor' ? ['publish-rfq', 'award', 'approve-change'] : ['submit-quote', 'acknowledge-order']
        if (!allowed.includes(args.action)) throw new Error('This action belongs to the other party.')
        const rfq = data.rfqs.find((row) => row.id === (record.rfqId || record.id))
        const order = record.orderId ? data.orders.find((row) => row.id === record.orderId) : null
        const title = record.title || rfq?.title || order?.title || 'Procurement commitment'
        const supplierName = record.supplierName || order?.supplierName || ''
        const amount = args.action === 'approve-change' ? record.amount : record.total
        const currency = record.currency || rfq?.currency || order?.currency || 'USD'
        const amountLabel = typeof amount === 'number'
          ? new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount) : ''
        const recipients = args.action === 'publish-rfq'
          ? record.supplierIds.map((supplierId) => data.contacts.find((row) => row.id === supplierId))
            .filter(Boolean).map((contact) => contact.company || contact.name).join(', ') : supplierName
        const summary = [title, recipients && `Supplier${args.action === 'publish-rfq' && record.supplierIds.length > 1 ? 's' : ''}: ${recipients}`,
          amountLabel && `${args.action === 'approve-change' ? 'Price adjustment' : 'Total'}: ${amountLabel}`].filter(Boolean).join(' · ')
        return { reviewRequired: true, record, summary, actions: [{ action: args.action, label: 'Review and confirm',
          record, summary, title, supplierName, amount, currency,
          input: args.action === 'award' ? { quoteId: id } : { id } }], message: 'Awaiting the signed-in person\'s confirmation. Nothing has been committed.' }
      } })
  })
}
