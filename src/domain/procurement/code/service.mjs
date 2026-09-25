import { randomUUID } from 'node:crypto'

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }) }
const text = (value) => String(value ?? '').trim()
const now = () => new Date().toISOString()
const newId = (kind) => `${kind}-${randomUUID().slice(0, 12)}`
const client = (user) => {
  if (!user || !['contractor', 'supplier'].includes(user.role)) fail('Sign in to a supplier or contractor workspace.', 403)
}
const role = (user, wanted) => { client(user); if (user.role !== wanted) fail(`This action belongs to the ${wanted} workspace.`, 403) }
const required = (value, label) => { const result = text(value); if (!result) fail(`${label} is required.`); return result }
const cents = (value, label = 'Amount') => {
  const input = text(value).replace(/,/g, '')
  if (!/^-?\d+(\.\d{1,2})?$/.test(input)) fail(`${label} must be a number with at most two decimal places.`)
  const negative = input.startsWith('-')
  const [whole, fraction = ''] = input.replace(/^-/, '').split('.')
  const result = Number(BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')))
  if (!Number.isSafeInteger(result)) fail(`${label} is too large.`)
  return negative ? -result : result
}
const quantity = (value) => {
  const input = text(value)
  if (!/^\d+(\.\d{1,6})?$/.test(input) || Number(input) <= 0 || Number(input) > 1e12) fail('Each quantity must be positive, with at most six decimal places.')
  return Number(input)
}
const lineCents = (unitCents, qty) => {
  const [whole, fraction = ''] = String(qty).split('.')
  const scale = 10n ** BigInt(fraction.length)
  const value = BigInt(unitCents) * BigInt(whole + fraction)
  const result = Number((value + scale / 2n) / scale)
  if (!Number.isSafeInteger(result)) fail('Line total is too large.')
  return result
}
const currencyOf = (value) => {
  const currency = text(value || 'USD').toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) fail('Use a three-letter currency code, such as USD or CNY.')
  return currency
}
const nameOf = (user) => user.company || user.name || user.email
const copy = (value) => structuredClone(value)
const publicQuote = (quote) => {
  const record = Object.fromEntries(['id', 'rfqId', 'supplierId', 'supplierName', 'ownerId', 'leadDays', 'paymentTerms',
    'notes', 'status', 'total', 'currency', 'revision', 'createdAt', 'updatedAt', 'submittedAt', 'supersededBy', 'demo']
    .filter((key) => quote[key] !== undefined).map((key) => [key, copy(quote[key])]))
  record.items = quote.items.map(({ id, description, quantity, unit, unitPrice, total }) => ({ id, description, quantity, unit, unitPrice, total }))
  return record
}
const publicRfq = (rfq, supplierId) => ({ ...Object.fromEntries(['id', 'title', 'description', 'deadline', 'currency', 'items',
  'status', 'ownerId', 'ownerName', 'revision', 'createdAt', 'updatedAt', 'publishedAt', 'demo']
  .filter((key) => rfq[key] !== undefined).map((key) => [key, copy(rfq[key])])), supplierIds: [supplierId] })

export function createProcurement({ store, accounts }) {
  const get = (user, collection, id) => store.get(user.id, collection, required(id, 'Record ID'))
    || fail('That record is not available in your workspace.', 404)
  const save = async (user, collection, record, event, actor = `human:${user.id}`) => {
    const next = { ...record, updatedAt: now(), createdAt: record.createdAt || now() }
    await store.put(user.id, collection, next, { actor, event })
    return next
  }
  const exchange = async (user, recipient, collection, record, event) => {
    if (!accounts.get(recipient)) fail('The recipient account no longer exists.', 404)
    await store.exchange(user.id, recipient, collection, copy(record), { actor: `human:${user.id}`, event })
  }
  const approval = async (user, action, id, input, record) => {
    if (input.confirmed !== true) fail('Review this commitment and confirm it before sending.')
    await store.append(user.id, 'procurement/human-approved', { action, recordId: id, confirmed: true,
      humanId: user.id, scope: copy(record), approvedAt: now() }, { actor: `human:${user.id}`, eventClass: 'fact' })
  }
  const rfqItems = (raw) => {
    if (!Array.isArray(raw) || !raw.length) fail('Add at least one item to the RFQ.')
    const ids = new Set()
    return raw.map((item, i) => {
      const id = text(item.id) || `item-${i + 1}`
      if (ids.has(id)) fail(`Item ID ${id} is repeated.`)
      ids.add(id)
      return { id, description: required(item.description, `Item ${i + 1} description`),
        quantity: quantity(item.quantity), unit: required(item.unit || 'each', `Item ${i + 1} unit`) }
    })
  }
  const suppliers = (ids) => [...new Set(Array.isArray(ids) ? ids.map(String) : [])].map((id) => {
    const supplier = accounts.get(id)
    if (!supplier || supplier.role !== 'supplier') fail('Choose supplier accounts from the contact list.')
    return id
  })
  const quoteItems = (items, rfq) => {
    if (!Array.isArray(items) || !items.length) fail('Add quoted prices for the RFQ items.')
    const known = new Map(rfq.items.map((item) => [item.id, item]))
    const seen = new Set()
    return items.map((item) => {
      const source = known.get(text(item.id))
      if (!source) fail(`Quoted item ${text(item.id)} is not in this RFQ.`)
      if (seen.has(source.id)) fail(`Item ${source.id} is repeated.`)
      seen.add(source.id)
      const price = cents(item.unitPrice, `Price for ${source.description}`)
      if (price < 0) fail('Quoted unit prices cannot be negative.')
      const result = { ...source, unitPrice: price / 100, total: lineCents(price, source.quantity) / 100 }
      if (item.cost !== undefined && item.cost !== null && item.cost !== '') {
        const cost = cents(item.cost, 'Private unit cost')
        if (cost < 0) fail('Private costs cannot be negative.')
        result.cost = cost / 100
        result.costTotal = lineCents(cost, source.quantity) / 100
      }
      return result
    })
  }
  const comparison = (rfqs, quotes, competitive = true) => {
    const result = []
    for (const rfq of rfqs) {
      const candidates = quotes.filter((quote) => quote.rfqId === rfq.id && ['submitted', 'awarded'].includes(quote.status))
      const highest = Math.max(0, ...candidates.map((quote) => quote.total))
      const sorted = [...candidates].sort((a, b) => a.total - b.total || a.leadDays - b.leadDays)
      for (const [index, quote] of sorted.entries()) {
        const risks = []
        const present = new Set(quote.items.map((item) => item.id))
        const missing = rfq.items.filter((item) => !present.has(item.id))
        if (missing.length) risks.push(`${missing.length} unpriced RFQ item${missing.length === 1 ? '' : 's'}: ${missing.map((item) => item.description).join(', ')}`)
        if (quote.currency !== rfq.currency) risks.push('Currency differs from RFQ; totals are not comparable without an agreed FX rate.')
        if (!quote.paymentTerms) risks.push('Payment terms need clarification.')
        if (quote.leadDays > 30) risks.push(`Long lead time: ${quote.leadDays} days.`)
        if (/100\s*%|full.*advance|advance.*full/i.test(quote.paymentTerms)) risks.push('Full advance payment increases cash exposure.')
        if (competitive && candidates.length > 1 && quote.total < highest * 0.7) risks.push('Price is more than 30% below the highest quote; confirm scope and exclusions.')
        result.push({ quoteId: quote.id, rfqId: rfq.id, supplierId: quote.supplierId, supplierName: quote.supplierName,
          total: quote.total, currency: quote.currency, leadDays: quote.leadDays, paymentTerms: quote.paymentTerms,
          items: copy(quote.items), risks,
          ...(competitive ? { rank: index + 1, savingsVsHighest: (cents(highest) - cents(quote.total)) / 100 } : {}),
          complete: missing.length === 0, rationale: competitive
            ? 'Sorted by submitted total, then lead time. Review scope and payment terms before award.'
            : 'Only your own quote is visible. Competitor prices, competitive rank and savings against other suppliers are unknown. These checks review your scope and terms only.' })
      }
    }
    return result
  }

  function snapshot(user) {
    client(user)
    const newest = (rows) => rows.sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))
    const rfqs = newest(store.list(user.id, 'rfqs')).filter((rfq) => user.role === 'contractor' ? rfq.ownerId === user.id : rfq.supplierIds.includes(user.id))
    const visible = new Set(rfqs.map((rfq) => rfq.id))
    const quotes = newest(store.list(user.id, 'quotes')).filter((quote) => visible.has(quote.rfqId) && (user.role === 'contractor' || quote.supplierId === user.id))
      .map((quote) => ({ ...quote, ...(store.get(user.id, 'quote-status', quote.id) || {}) }))
    const orders = newest(store.list(user.id, 'orders')).filter((order) => user.role === 'contractor' ? order.ownerId === user.id : order.supplierId === user.id)
    const orderIds = new Set(orders.map((order) => order.id))
    const messages = newest(store.list(user.id, 'messages')).filter((message) => message.fromId === user.id || message.toId === user.id)
    const changes = newest(store.list(user.id, 'changes')).filter((change) => orderIds.has(change.orderId))
    const contacts = accounts.list().filter((person) => !person.disabled && person.role === (user.role === 'contractor' ? 'supplier' : 'contractor'))
      .map(({ id, name, company, email, role }) => ({ id, name, company, email, role }))
    const activity = store.events(user.id).filter(event => {
      const body = event.body
      return body?.schema === 'quotagent/workspace-record/v1' && ['rfqs','quotes','orders','messages','changes'].includes(body.collection)
    }).slice(-20).reverse().map(event => {
      const {collection,record} = event.body
      const source = rfqs.find(rfq => rfq.id === (record.rfqId || record.id))
      const labels = {rfqs:{draft:'Request draft saved',published:'Request published',awarded:'Request awarded'},
        quotes:{draft:'Quote draft saved',submitted:'Quote received',superseded:'Quote revised',awarded:'Supplier selected'},
        orders:{issued:'Order issued',acknowledged:'Order acknowledged'},changes:{proposed:'Change proposed',approved:'Change approved'}}
      const label = collection === 'messages' ? (record.fromId === user.id ? 'Message sent' : 'Message received') : labels[collection]?.[record.status] || 'Project updated'
      const person = event.actor?.startsWith('human:') ? accounts.get(event.actor.slice(6)) : null
      return {id:String(event.seq),type:label,createdAt:event.ts,
        actor:event.actor?.startsWith('agent:') ? 'AI assistant' : person?.name || record.fromName || record.supplierName || record.ownerName || 'Project update',
        summary:`${label} · ${record.title || source?.title || record.supplierName || 'Project conversation'}`}
    })
    return { rfqs, quotes, orders, messages, changes, activity, contacts, comparison: comparison(rfqs, quotes, user.role === 'contractor'),
      comparisonScope: user.role === 'contractor'
        ? 'Submitted offers received by this contractor account; ranking covers those received offers only.'
        : 'Own supplier quotes only. Other suppliers\' bids are not visible, so no competitive rank, lowest-price claim or savings comparison can be inferred.',
      stats: { rfqs: rfqs.length, openRfqs: rfqs.filter((rfq) => rfq.status === 'published').length,
        quotes: quotes.filter((quote) => ['submitted', 'awarded'].includes(quote.status)).length,
        draftQuotes: quotes.filter((quote) => quote.status === 'draft').length, orders: orders.length,
        pendingOrders: orders.filter((order) => order.status === 'issued').length,
        spend: orders.reduce((sum, order) => sum + cents(order.total), 0) / 100,
        pendingChanges: changes.filter((change) => change.status === 'proposed').length,
        unreadMessages: messages.filter((message) => message.toId === user.id).length } }
  }

  async function execute(user, action, input = {}, { agent = false } = {}) {
    client(user)
    if (user.permissions?.includes('workspace:read-only')) fail('This account has read-only workspace access. Ask your administrator to enable editing.', 403)
    if (agent && !['create-rfq', 'save-quote'].includes(action)) fail('The assistant can prepare this action for human review but cannot commit it.', 403)
    const actor = `${agent ? 'agent' : 'human'}:${user.id}`
    if (action === 'create-rfq') {
      role(user, 'contractor')
      const existing = input.id ? get(user, 'rfqs', input.id) : null
      if (existing && (existing.ownerId !== user.id || existing.status !== 'draft')) fail('Only your own unpublished RFQ draft can be edited.', 403)
      const fields = { ...existing, ...input }
      const deadline = text(fields.deadline)
      if (deadline && !Number.isFinite(Date.parse(deadline))) fail('Choose a valid deadline.')
      const rfq = await save(user, 'rfqs', { ...existing, id: existing?.id || newId('rfq'), title: required(fields.title, 'RFQ title'),
        description: text(fields.description), deadline, currency: currencyOf(fields.currency), items: rfqItems(fields.items),
        status: 'draft', ownerId: user.id, ownerName: nameOf(user), supplierIds: suppliers(fields.supplierIds), revision: (existing?.revision || 0) + 1 }, 'procurement/rfq-drafted', actor)
      return { ok: true, rfq, message: 'RFQ draft saved. Review the items and invited suppliers before publishing.' }
    }
    if (action === 'publish-rfq') {
      role(user, 'contractor')
      const rfq = get(user, 'rfqs', input.id)
      if (rfq.ownerId !== user.id) fail('Only the RFQ owner can publish it.', 403)
      if (rfq.status === 'published') return { ok: true, rfq, duplicate: true }
      if (!rfq.supplierIds.length) fail('Choose at least one supplier before publishing.')
      await approval(user, action, rfq.id, input, rfq)
      const published = await save(user, 'rfqs', { ...rfq, status: 'published', publishedAt: now() }, 'procurement/rfq-published')
      for (const supplierId of published.supplierIds) await exchange(user, supplierId, 'rfqs', publicRfq(published, supplierId), 'procurement/rfq-delivered')
      return { ok: true, rfq: published, message: `RFQ delivered to ${published.supplierIds.length} supplier(s).` }
    }
    if (action === 'save-quote') {
      role(user, 'supplier')
      const rfq = get(user, 'rfqs', input.rfqId)
      if (!rfq.supplierIds.includes(user.id) || rfq.status !== 'published') fail('This RFQ is not open for your quotation.')
      const existing = input.id ? get(user, 'quotes', input.id) : null
      if (existing && (existing.supplierId !== user.id || existing.rfqId !== rfq.id)) fail('This is not your quote for this RFQ.', 403)
      if (existing?.status === 'awarded') fail('Use an order change for an awarded quote.')
      const items = quoteItems(input.items, rfq)
      const leadDays = Number(input.leadDays ?? 14)
      if (!Number.isInteger(leadDays) || leadDays < 0 || leadDays > 3650) fail('Lead time must be a whole number of days from 0 to 3650.')
      const total = items.reduce((sum, item) => sum + cents(item.total), 0) / 100
      const costTotal = items.reduce((sum, item) => sum + cents(item.costTotal || 0), 0) / 100
      const costComplete = items.every((item) => item.cost !== undefined)
      const quote = await save(user, 'quotes', { ...existing, id: existing?.id || newId('quote'), rfqId: rfq.id,
        supplierId: user.id, supplierName: nameOf(user), ownerId: rfq.ownerId, items, leadDays,
        paymentTerms: text(input.paymentTerms), notes: text(input.notes), privateNotes: text(input.privateNotes ?? existing?.privateNotes),
        status: 'draft', total, costTotal, costComplete, margin: costComplete ? (cents(total) - cents(costTotal)) / 100 : null,
        currency: rfq.currency, revision: existing ? (existing.revision || 0) + 1
          : Math.max(0, ...store.list(user.id, 'quotes').filter((row) => row.rfqId === rfq.id).map((row) => row.revision || 1)) + 1 }, 'procurement/quote-drafted', actor)
      return { ok: true, quote, message: 'Private quote draft saved. Costs stay in your workspace.' }
    }
    if (action === 'submit-quote') {
      role(user, 'supplier')
      const quote = get(user, 'quotes', input.id)
      if (quote.supplierId !== user.id) fail('Only the quote owner can submit it.', 403)
      if (quote.status === 'submitted') return { ok: true, quote, duplicate: true }
      if (quote.status !== 'draft') fail('Only a draft quote can be submitted.')
      const rfq = get(user, 'rfqs', quote.rfqId)
      if (rfq.status !== 'published') fail('This RFQ is no longer open.')
      await approval(user, action, quote.id, input, publicQuote(quote))
      const submitted = await save(user, 'quotes', { ...quote, status: 'submitted', submittedAt: now() }, 'procurement/quote-submitted')
      await exchange(user, rfq.ownerId, 'quotes', publicQuote(submitted), 'procurement/quote-received')
      for (const prior of store.list(user.id, 'quotes').filter((row) => row.rfqId === rfq.id && row.id !== quote.id && row.status === 'submitted')) {
        const superseded = await save(user, 'quotes', { ...prior, status: 'superseded', supersededBy: submitted.id }, 'procurement/quote-superseded')
        await exchange(user, rfq.ownerId, 'quotes', publicQuote(superseded), 'procurement/quote-superseded')
      }
      return { ok: true, quote: submitted, message: 'Quote sent. Private costs and internal notes were excluded.' }
    }
    if (action === 'send-message') {
      const rfq = get(user, 'rfqs', input.rfqId)
      const toId = required(input.toId || (user.role === 'supplier' ? rfq.ownerId : ''), 'Recipient')
      if (user.role === 'supplier' && toId !== rfq.ownerId) fail('Reply to the contractor who invited you.', 403)
      if (user.role === 'contractor' && (rfq.ownerId !== user.id || !rfq.supplierIds.includes(toId))) fail('Choose an invited supplier.', 403)
      const kind = ['message', 'clarification', 'negotiation'].includes(input.kind) ? input.kind : 'message'
      const message = await save(user, 'messages', { id: newId('msg'), rfqId: rfq.id, fromId: user.id,
        fromName: nameOf(user), toId, text: required(input.text, 'Message'), kind, binding: false }, 'procurement/message-sent')
      await exchange(user, toId, 'messages', message, 'procurement/message-received')
      return { ok: true, message, notice: 'Message delivered. A message does not replace an approved quote or order.' }
    }
    if (action === 'award') {
      role(user, 'contractor')
      const quote = get(user, 'quotes', input.quoteId)
      const rfq = get(user, 'rfqs', quote.rfqId)
      if (rfq.ownerId !== user.id) fail('Only the RFQ owner can issue this order.', 403)
      const existing = store.list(user.id, 'orders').find((order) => order.rfqId === rfq.id)
      if (existing) {
        if (existing.quoteId !== quote.id) fail('This RFQ already has an order. Use a change request to revise it.')
        return { ok: true, order: existing, duplicate: true }
      }
      if (quote.status !== 'submitted') fail('Choose a submitted quote.')
      if (quote.items.length !== rfq.items.length) fail('Resolve unpriced RFQ items before issuing an order.')
      await approval(user, action, quote.id, input, publicQuote(quote))
      const order = await save(user, 'orders', { id: newId('po'), rfqId: rfq.id, quoteId: quote.id,
        title: rfq.title, ownerId: user.id, ownerName: nameOf(user), supplierId: quote.supplierId,
        supplierName: quote.supplierName, total: quote.total, originalTotal: quote.total, currency: quote.currency,
        status: 'issued', items: copy(quote.items), leadDays: quote.leadDays, paymentTerms: quote.paymentTerms,
        awardedBy: user.id }, 'procurement/order-issued')
      const awarded = await save(user, 'quotes', { ...quote, status: 'awarded' }, 'procurement/quote-awarded')
      const closed = await save(user, 'rfqs', { ...rfq, status: 'awarded' }, 'procurement/rfq-awarded')
      await exchange(user, quote.supplierId, 'orders', order, 'procurement/order-received')
      // Preserve the supplier's private costs when updating its copy of the quote.
      await exchange(user, quote.supplierId, 'quote-status', { id: quote.id, status: 'awarded', orderId: order.id }, 'procurement/award-notified')
      for (const supplierId of closed.supplierIds) await exchange(user, supplierId, 'rfqs', publicRfq(closed, supplierId), 'procurement/rfq-closed')
      return { ok: true, order, quote: awarded, message: 'Order issued to the supplier for acknowledgment.' }
    }
    if (action === 'acknowledge-order') {
      role(user, 'supplier')
      const order = get(user, 'orders', input.id)
      if (order.supplierId !== user.id) fail('This order belongs to another supplier.', 403)
      if (order.status === 'acknowledged') return { ok: true, order, duplicate: true }
      await approval(user, action, order.id, input, order)
      const acknowledged = await save(user, 'orders', { ...order, status: 'acknowledged', acknowledgedAt: now(), acknowledgedBy: user.id }, 'procurement/order-acknowledged')
      await exchange(user, order.ownerId, 'orders', acknowledged, 'procurement/acknowledgment-received')
      return { ok: true, order: acknowledged, message: 'Order acknowledged. Both parties now have the same confirmed order.' }
    }
    if (action === 'propose-change') {
      const order = get(user, 'orders', input.orderId)
      if (user.id !== order.ownerId && user.id !== order.supplierId) fail('This order is not yours.', 403)
      const amount = cents(input.amount)
      const change = await save(user, 'changes', { id: newId('change'), orderId: order.id, rfqId: order.rfqId,
        title: required(input.title, 'Change title'), description: text(input.description), amount: amount / 100,
        currency: order.currency, status: 'proposed', proposedBy: user.id, ownerId: order.ownerId, supplierId: order.supplierId }, 'procurement/change-proposed')
      await exchange(user, user.id === order.ownerId ? order.supplierId : order.ownerId, 'changes', change, 'procurement/change-received')
      return { ok: true, change, message: 'Change proposed. Order value stays unchanged until the contractor approves.' }
    }
    if (action === 'approve-change') {
      role(user, 'contractor')
      const change = get(user, 'changes', input.id)
      const order = get(user, 'orders', change.orderId)
      if (order.ownerId !== user.id) fail('Only the contractor who owns the order can approve this change.', 403)
      if (change.status === 'approved') return { ok: true, change, order, duplicate: true }
      const total = cents(order.total) + cents(change.amount)
      if (total < 0) fail('This change would make the order value negative.')
      await approval(user, action, change.id, input, change)
      const approved = await save(user, 'changes', { ...change, status: 'approved', approvedBy: user.id, approvedAt: now() }, 'procurement/change-approved')
      const updated = await save(user, 'orders', { ...order, total: total / 100 }, 'procurement/order-revised')
      await exchange(user, order.supplierId, 'changes', approved, 'procurement/approved-change-received')
      await exchange(user, order.supplierId, 'orders', updated, 'procurement/revised-order-received')
      return { ok: true, change: approved, order: updated, message: 'Change approved and the order total updated for both parties.' }
    }
    if (action === 'seed-demo') return seedDemo(user)
    fail(`Unknown procurement action: ${action}`, 404)
  }

  async function seedDemo(user) {
    const all = accounts.list()
    const contractor = user.role === 'contractor' ? user : all.find((person) => person.email === 'contractor@demo.local')
    const supplier = user.role === 'supplier' ? user : all.find((person) => person.email === 'supplier@demo.local')
    const second = all.find((person) => person.email === 'supplier2@demo.local' && person.id !== supplier?.id)
      || all.find((person) => person.role === 'supplier' && person.id !== supplier?.id)
    if (!contractor || !supplier || !second) fail('Demo accounts are not ready yet. Try again after account initialization.')
    const demoId = `demo-${contractor.id}-${supplier.id}`
    if (store.get(user.id, 'demo-seeds', demoId)) return { ok: true, duplicate: true, message: 'The labelled demo is already in your workspace.' }
    const definitions = [
      { suffix: 'lighting', title: '[Demo] Riverside office lighting', description: 'Compare complete delivered LED lighting packages. Confirm lead time and payment terms before award.',
        items: [{ id: 'panel', description: '36 W LED panel, 4000 K, 3-year warranty', quantity: 120, unit: 'each' },
          { id: 'sensor', description: 'Ceiling occupancy sensor with commissioning', quantity: 24, unit: 'each' }], prices: [[42.5, 18], [39.8, 21.5]] },
      { suffix: 'cabling', title: '[Demo] Riverside structured cabling', description: 'New request ready for the supplier to prepare a quotation. Quote supply, installation and testing.',
        items: [{ id: 'cable', description: 'CAT6 cable, installed and tested', quantity: 1500, unit: 'm' },
          { id: 'outlet', description: 'Dual data outlet with faceplate', quantity: 48, unit: 'each' }] },
    ]
    for (const definition of definitions) {
      const id = `${demoId}-${definition.suffix}`
      let rfq = store.get(contractor.id, 'rfqs', id)
      if (!rfq) rfq = await save(contractor, 'rfqs', { id, title: definition.title, description: definition.description,
        deadline: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10), currency: 'USD', items: definition.items,
        status: 'published', ownerId: contractor.id, ownerName: nameOf(contractor), supplierIds: [supplier.id, second.id], revision: 1,
        demo: true }, 'procurement/demo-rfq-created')
      for (const recipient of [supplier, second]) if (!store.get(recipient.id, 'rfqs', id)) await exchange(contractor, recipient.id, 'rfqs', publicRfq(rfq, recipient.id), 'procurement/demo-rfq-delivered')
      if (definition.prices) for (const [index, bidder] of [supplier, second].entries()) {
        const quoteId = `${id}-quote-${index + 1}`
        let quote = store.get(bidder.id, 'quotes', quoteId)
        if (!quote) {
          const items = quoteItems(definition.items.map((item, i) => ({ ...item, unitPrice: definition.prices[index][i],
            cost: Number((definition.prices[index][i] * 0.72).toFixed(2)) })), rfq)
          quote = await save(bidder, 'quotes', { id: quoteId, rfqId: id, supplierId: bidder.id, supplierName: nameOf(bidder),
            ownerId: contractor.id, items, leadDays: index ? 35 : 14, paymentTerms: index ? '100% advance payment' : '30% deposit; 70% after delivery',
            notes: index ? 'Freight included. Confirm delivery window.' : 'Freight and three-year warranty included.',
            privateNotes: 'Demo-only internal costing. Never shared with the buyer.', status: 'submitted', demo: true,
            total: items.reduce((sum, item) => sum + cents(item.total), 0) / 100,
            costTotal: items.reduce((sum, item) => sum + cents(item.costTotal), 0) / 100,
            currency: rfq.currency, revision: 1 }, 'procurement/demo-quote-created')
        }
        if (!store.get(contractor.id, 'quotes', quoteId)) await exchange(bidder, contractor.id, 'quotes', publicQuote(quote), 'procurement/demo-quote-delivered')
      }
    }
    for (const account of [contractor, supplier, second]) await save(account, 'demo-seeds', { id: demoId, label: 'Riverside labelled demo' }, 'procurement/demo-loaded')
    return { ok: true, message: 'Labelled demo loaded: compare two lighting quotes or prepare a new cabling quote. These records belong to the demo participants.' }
  }

  function exportCsv(user, rfqId) {
    const data = snapshot(user)
    const rows = data.comparison.filter((row) => !rfqId || row.rfqId === rfqId)
    const cell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`
    return '\uFEFF' + [['RFQ', 'Supplier', 'Currency', 'Total', 'Lead days', 'Payment terms', 'Risks', 'Quote reference'],
      ...rows.map((row) => [data.rfqs.find((rfq) => rfq.id === row.rfqId)?.title || row.rfqId,
        row.supplierName, row.currency, row.total.toFixed(2), row.leadDays, row.paymentTerms, row.risks.join(' | '), row.quoteId])]
      .map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n'
  }

  return { snapshot, execute, exportCsv }
}
