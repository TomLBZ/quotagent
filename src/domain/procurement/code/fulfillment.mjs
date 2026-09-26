import { createHash } from 'node:crypto'
import { rfqRevision, quoteRevision, staleQuote } from './rfq-lifecycle.mjs'
import { quotationAmounts } from './commercial-fields.mjs'

const copy = value => structuredClone(value)
const now = () => new Date().toISOString()
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value
const digest = value => createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex')
export const offerBasis = quote => Object.fromEntries(['id', 'rfqId', 'rfqRevision', 'supplierId', 'revision', 'items', 'currency', 'total', 'subtotal', 'priceBreakdown', 'commercial', 'leadDays', 'paymentTerms', 'notes'].map(key => [key, quote[key] ?? null]))

export function createFulfillment(h) {
  const { store, accounts, get, save, exchange, approval, fail, required, text, role, newId, cents, quantity, lineCents, publicQuote, publicRfq } = h
  const actor = user => user.actorId || user.id
  const other = (user, record) => user.id === record.ownerId ? record.supplierId : record.ownerId
  const party = (user, record) => { if (![record.ownerId, record.supplierId].includes(user.id)) fail('This agreement belongs to another party.', 403) }
  const currentOrder = (user, id) => { const order = get(user, 'orders', id); party(user, order); return order }
  const version = order => Number(order.orderRevision || 1)
  const checkOffer = (quote, rfq) => {
    if (rfq.status !== 'published') fail('This request is no longer open for an award.')
    if (quote.status !== 'submitted') fail('Choose a current submitted quotation.')
    if (staleQuote(quote, rfq)) fail('This quotation uses an older request revision. Ask the supplier to rebid.')
    if (quote.items.length !== rfq.items.length || rfq.items.some(item => !quote.items.some(row => row.id === item.id))) fail('Resolve unpriced scope before proposing an award.')
    const amounts = quotationAmounts(quote.items.reduce((sum,item) => sum + lineCents(cents(item.unitPrice),item.quantity),0),quote.commercial || {})
    if (quote.items.some(item => lineCents(cents(item.unitPrice),item.quantity) !== cents(item.total)) || amounts.total !== quote.total) fail('The source quotation arithmetic is inconsistent. Request a corrected quotation before selection.')
    if (quote.commercial?.validityUntil && quote.commercial.validityUntil < now().slice(0, 10)) fail('This quotation has expired. Request a new quotation.')
    if (quote.commercial?.taxMode === 'exclusive' && quote.commercial.taxRate === undefined) fail('Clarify the exclusive tax rate before proceeding.')
  }
  const acceptedQuantities = (user, orderId) => {
    const amounts = new Map()
    for (const record of store.list(user.id, 'acceptances').filter(row => row.orderId === orderId)) for (const line of record.lines) amounts.set(line.itemId, (amounts.get(line.itemId) || 0) + line.quantity)
    return amounts
  }
  const changePlan = (user, order, raw) => {
    if (!Array.isArray(raw) || !raw.length) fail('Add a change line referencing an original ordered item.')
    const original = order.originalItems || order.items, seen = new Set(), accepted = acceptedQuantities(user, order.id)
    const lines = raw.map(input => {
      const item = order.items.find(row => row.id === input.itemId), source = original.find(row => row.id === input.itemId)
      if (!item || !source || source.unitPrice === undefined) fail('Each change needs an original quoted item and unit rate. New unquoted scope needs its own request.')
      if (seen.has(item.id)) fail('Each item may appear only once in a change.'); seen.add(item.id)
      if (!['number', 'string'].includes(typeof input.deltaQuantity) || !String(input.deltaQuantity).trim()) fail('State an explicit quantity change, including zero for a price-only change.')
      const delta = Number(input.deltaQuantity)
      if (!Number.isFinite(delta) || Math.abs(delta) > 1e12 || Math.abs(delta * 1e6 - Math.round(delta * 1e6)) > 1e-5) fail('Quantity changes need a signed number with at most six decimal places.')
      const newQuantity = Math.round((item.quantity + delta) * 1e6) / 1e6
      if (newQuantity < 0) fail('A change cannot make an ordered quantity negative.')
      if (newQuantity < (accepted.get(item.id) || 0)) fail('Ordered quantity cannot fall below recorded delivery acceptance.')
      const rate = input.newUnitPrice === undefined || input.newUnitPrice === '' ? cents(item.unitPrice) : cents(input.newUnitPrice)
      if (rate < 0) fail('A unit price cannot be negative.')
      const rateReason = rate !== cents(item.unitPrice) ? required(input.rateReason, 'Reason for changing the quoted rate') : text(input.rateReason)
      const beforeCents = lineCents(cents(item.unitPrice), item.quantity), afterCents = lineCents(rate, newQuantity)
      return { itemId: item.id, description: item.description, unit: item.unit, sourceQuoteId: order.quoteId,
        originalQuantity: source.quantity, originalUnitPrice: source.unitPrice, beforeQuantity: item.quantity, beforeUnitPrice: item.unitPrice,
        deltaQuantity: delta, newQuantity, newUnitPrice: rate / 100, rateReason, beforeTotal: beforeCents / 100, newTotal: afterCents / 100,
        deltaAmount: (afterCents - beforeCents) / 100, basis: { quoteId: order.quoteId, itemId: source.id, orderRevision: version(order) } }
    })
    if (lines.every(row => row.deltaQuantity === 0 && row.newUnitPrice === row.beforeUnitPrice)) fail('Change a quantity or a unit rate.')
    const items = order.items.map(item => { const line = lines.find(row => row.itemId === item.id); return line ? { ...item, quantity: line.newQuantity, unitPrice: line.newUnitPrice, total: line.newTotal } : item })
    const amounts = quotationAmounts(items.reduce((sum, item) => sum + lineCents(cents(item.unitPrice), item.quantity), 0), order.commercial || {})
    return { lines, items, amounts, amount: (cents(amounts.total) - cents(order.total)) / 100 }
  }
  const actions = new Set(['propose-award', 'confirm-award', 'decline-award', 'withdraw-award', 'sign-order', 'award', 'close-rfq', 'withdraw-quote',
    'propose-change', 'confirm-change', 'reject-change', 'approve-change', 'settle-change', 'record-acceptance', 'record-invoice', 'reconcile-invoice'])
  async function execute(user, action, input) {
    if (action === 'propose-award') {
      role(user, 'contractor')
      const quote = get(user, 'quotes', input.quoteId), rfq = get(user, 'rfqs', quote.rfqId)
      if (rfq.ownerId !== user.id) fail('Only the request owner may propose an award.', 403)
      checkOffer(quote, rfq)
      if (store.list(user.id, 'orders').some(row => row.rfqId === rfq.id)) fail('This request already has an order.')
      if (store.list(user.id, 'award-intents').some(row => row.rfqId === rfq.id && ['proposed', 'confirmed'].includes(row.status))) fail('Withdraw or complete the existing award intent before selecting again.')
      const source = publicQuote({ ...quote, rfqRevision: quoteRevision(quote, rfq) })
      const record = { id: newId('award'), rfqId: rfq.id, quoteId: quote.id, ownerId: user.id, ownerName: rfq.ownerName,
        supplierId: quote.supplierId, supplierName: quote.supplierName, title: rfq.title, status: 'proposed', binding: false,
        quote: source, quoteDigest: digest(offerBasis(source)), rfqRevision: rfqRevision(rfq), total: quote.total, currency: quote.currency,
        reason: required(input.reason, 'Selection reason'), proposedBy: actor(user) }
      await approval(user, action, quote.id, input, record)
      const intent = await save(user, 'award-intents', record, 'procurement/award-intent-proposed')
      await exchange(user, intent.supplierId, 'award-intents', intent, 'procurement/award-intent-received')
      return { ok: true, awardIntent: intent, message: 'Nonbinding award intent sent. The supplier must confirm before order signing.' }
    }
    if (['confirm-award', 'decline-award', 'withdraw-award'].includes(action)) {
      const intent = get(user, 'award-intents', input.id); party(user, intent)
      if (action === 'withdraw-award') role(user, 'contractor'); else role(user, 'supplier')
      if (intent.status === 'committed') fail('This award is already committed. Use an order change.')
      const status = { 'confirm-award': 'confirmed', 'decline-award': 'declined', 'withdraw-award': 'withdrawn' }[action]
      if (intent.status === status) return { ok: true, awardIntent: intent, duplicate: true }
      if (!['proposed', 'confirmed'].includes(intent.status)) fail('This award intent is already closed.')
      if (action === 'confirm-award') {
        const rfq = get(user, 'rfqs', intent.rfqId), quote = get(user, 'quotes', intent.quoteId)
        if (quote.status !== 'submitted' || digest(offerBasis(publicQuote({ ...quote, rfqRevision: quoteRevision(quote, rfq) }))) !== intent.quoteDigest) fail('Your quotation changed after this intent. Request a new selection against your current submitted offer.')
        if (rfq.status !== 'published' || rfqRevision(rfq) !== intent.rfqRevision) fail('Scope changed after this intent. Ask for a new selection.')
        if (intent.quote.commercial?.validityUntil && intent.quote.commercial.validityUntil < now().slice(0, 10)) fail('The proposed quotation has expired.')
      }
      const reason = action === 'confirm-award' ? '' : required(input.reason, 'Decision reason')
      await approval(user, action, intent.id, input, { ...intent, decisionReason: reason })
      const updated = await save(user, 'award-intents', { ...intent, status, decisionReason: reason, decidedBy: actor(user),
        ...(status === 'confirmed' ? { confirmedBy: actor(user), confirmedAt: now() } : {}) }, `procurement/award-intent-${status}`)
      await exchange(user, other(user, intent), 'award-intents', updated, `procurement/award-intent-${status}`)
      return { ok: true, awardIntent: updated, message: status === 'confirmed' ? 'Supplier confirmation recorded. The contractor still needs independent review and order signing.' : 'Award intent closed without an order.' }
    }
    if (action === 'sign-order' || action === 'award') {
      role(user, 'contractor')
      const intent = action === 'sign-order' ? get(user, 'award-intents', input.id) : store.list(user.id, 'award-intents').find(row => row.quoteId === input.quoteId && ['confirmed', 'committed'].includes(row.status))
      if (!intent) fail('Propose an award and obtain supplier confirmation before signing an order.')
      if (intent.ownerId !== user.id) fail('This award belongs to another contractor.', 403)
      const existing = store.list(user.id, 'orders').find(row => row.awardId === intent.id)
      if (existing) return { ok: true, order: existing, awardIntent: intent, duplicate: true }
      if (intent.status !== 'confirmed' || !intent.confirmedBy) fail('The supplier must confirm this award intent before signing.')
      const quote = get(user, 'quotes', intent.quoteId), rfq = get(user, 'rfqs', intent.rfqId)
      checkOffer(quote, rfq)
      if (digest(offerBasis(publicQuote({ ...quote, rfqRevision: quoteRevision(quote, rfq) }))) !== intent.quoteDigest) fail('The selected offer changed after supplier confirmation. Prepare a new award intent.')
      if (rfqRevision(rfq) !== intent.rfqRevision) fail('The scope changed after supplier confirmation.')
      if (store.list(user.id, 'orders').some(row => row.rfqId === rfq.id)) fail('This request already has an order.')
      await approval(user, action, intent.id, input, intent)
      const orderId = `po-${intent.id}`
      const order = await save(user, 'orders', { id: orderId, rfqId: rfq.id, quoteId: quote.id, awardId: intent.id, rfqRevision: intent.rfqRevision,
        title: rfq.title, ownerId: user.id, ownerName: rfq.ownerName, supplierId: quote.supplierId, supplierName: quote.supplierName,
        ...quotationAmounts(quote.items.reduce((sum, item) => sum + lineCents(cents(item.unitPrice), item.quantity), 0), quote.commercial || {}),
        originalTotal: quote.total, currency: quote.currency, status: 'issued', orderRevision: 1, commercial: copy(quote.commercial || {}),
        items: copy(quote.items), originalItems: copy(quote.items), leadDays: quote.leadDays, paymentTerms: quote.paymentTerms,
        supplierConfirmedBy: intent.confirmedBy, supplierConfirmedAt: intent.confirmedAt, signedBy: actor(user), signedAt: now(), reviewActionId: input.reviewActionId || null }, 'procurement/order-issued')
      const committed = await save(user, 'award-intents', { ...intent, status: 'committed', binding: true, orderId, signedBy: actor(user), reviewActionId: input.reviewActionId || null }, 'procurement/award-committed')
      const awarded = await save(user, 'quotes', { ...quote, status: 'awarded' }, 'procurement/quote-awarded')
      const closed = await save(user, 'rfqs', { ...rfq, status: 'awarded' }, 'procurement/rfq-awarded')
      await exchange(user, quote.supplierId, 'orders', order, 'procurement/order-received')
      await exchange(user, quote.supplierId, 'award-intents', committed, 'procurement/award-committed')
      await exchange(user, quote.supplierId, 'quote-status', { id: quote.id, status: 'awarded', orderId }, 'procurement/award-notified')
      for (const supplierId of rfq.supplierIds) await exchange(user, supplierId, 'rfqs', publicRfq(closed, supplierId), 'procurement/rfq-closed')
      return { ok: true, order, quote: awarded, awardIntent: committed, message: 'Confirmed award signed and the purchase order delivered.' }
    }
    if (action === 'close-rfq') {
      role(user, 'contractor'); const rfq = get(user, 'rfqs', input.id)
      if (rfq.ownerId !== user.id || rfq.status !== 'published') fail('Only your open published request can be closed.')
      if (store.list(user.id, 'award-intents').some(row => row.rfqId === rfq.id && ['proposed', 'confirmed'].includes(row.status))) fail('Withdraw the active award intent before closing the request.')
      const reason = required(input.reason, 'Closure reason'); await approval(user, action, rfq.id, input, { ...rfq, reason })
      const closed = await save(user, 'rfqs', { ...rfq, status: 'closed', closedReason: reason, closedAt: now() }, 'procurement/rfq-closed')
      for (const id of rfq.supplierIds) await exchange(user, id, 'rfqs', publicRfq(closed, id), 'procurement/rfq-closed')
      return { ok: true, rfq: closed }
    }
    if (action === 'withdraw-quote') {
      role(user, 'supplier'); const quote = get(user, 'quotes', input.id), rfq = get(user, 'rfqs', quote.rfqId)
      if (quote.supplierId !== user.id || quote.status !== 'submitted' || rfq.status !== 'published') fail('Only your submitted, unawarded quotation can be withdrawn.')
      const reason = required(input.reason, 'Withdrawal reason'); await approval(user, action, quote.id, input, { ...publicQuote(quote), reason })
      const updated = await save(user, 'quotes', { ...quote, status: 'withdrawn', withdrawnReason: reason, withdrawnAt: now() }, 'procurement/quote-withdrawn')
      await exchange(user, rfq.ownerId, 'quotes', publicQuote(updated), 'procurement/quote-withdrawn')
      return { ok: true, quote: updated }
    }
    if (action === 'propose-change') {
      const order = currentOrder(user, input.orderId)
      if (input.expectedOrderRevision !== undefined && Number(input.expectedOrderRevision) !== version(order)) fail('The order changed. Review its current quantities and rates first.', 409)
      const plan = changePlan(user, order, input.lines)
      const record = { id: newId('change'), orderId: order.id, rfqId: order.rfqId, title: required(input.title, 'Change title'), description: text(input.description),
        ownerId: order.ownerId, supplierId: order.supplierId, proposedBy: user.id, proposedByActor: actor(user), status: 'proposed', baseOrderRevision: version(order),
        lines: plan.lines, proposedItems: plan.items, proposedAmounts: plan.amounts, amount: plan.amount, currency: order.currency, settledBy: [] }
      await approval(user, action, order.id, input, record)
      const change = await save(user, 'changes', record, 'procurement/change-proposed')
      await exchange(user, other(user, order), 'changes', change, 'procurement/change-received')
      return { ok: true, change, message: 'Sourced change sent for the other party to confirm. The order remains unchanged.' }
    }
    if (['confirm-change', 'reject-change'].includes(action)) {
      const change = get(user, 'changes', input.id); party(user, change)
      if (user.id === change.proposedBy) fail('The other party must confirm or reject this proposed change.')
      if (change.status !== 'proposed') fail('This change is no longer awaiting counterparty confirmation.')
      const order = currentOrder(user, change.orderId)
      if (version(order) !== change.baseOrderRevision) fail('The order changed after this proposal. Prepare a new change.', 409)
      const reason = action === 'reject-change' ? required(input.reason, 'Rejection reason') : ''
      await approval(user, action, change.id, input, { ...change, decisionReason: reason })
      const status = action === 'confirm-change' ? 'confirmed' : 'rejected'
      const updated = await save(user, 'changes', { ...change, status, counterpartyConfirmedBy: actor(user), decisionReason: reason, confirmedAt: now() }, `procurement/change-${status}`)
      await exchange(user, other(user, change), 'changes', updated, `procurement/change-${status}`)
      return { ok: true, change: updated }
    }
    if (action === 'approve-change') {
      role(user, 'contractor'); let change = get(user, 'changes', input.id), order = currentOrder(user, change.orderId)
      if (change.ownerId !== user.id) fail('Only the owning contractor can approve the change.', 403)
      if (['applied', 'settled'].includes(change.status)) return { ok: true, change, order, duplicate: true }
      if (!change.lines?.length) fail('This historical lump-sum proposal needs a new change with quoted-line basis before approval.')
      if (!['confirmed', 'approved'].includes(change.status) || !change.counterpartyConfirmedBy) fail('The other party must confirm this change before approval.')
      if (version(order) !== change.baseOrderRevision && order.lastChangeId !== change.id) fail('The order changed since this proposal. Prepare a new change.', 409)
      // Re-evaluate acceptance limits before any commitment, not just when proposed.
      const accepted = acceptedQuantities(user, order.id)
      if (change.proposedItems.some(item => item.quantity < (accepted.get(item.id) || 0))) fail('This change would reduce scope below accepted delivery quantities.')
      await approval(user, action, change.id, input, change)
      if (change.status !== 'approved') change = await save(user, 'changes', { ...change, status: 'approved', approvedBy: actor(user), approvedAt: now(), reviewActionId: input.reviewActionId || null }, 'procurement/change-approved')
      if (order.lastChangeId !== change.id) order = await save(user, 'orders', { ...order, ...change.proposedAmounts, originalItems: order.originalItems || order.items,
        items: change.proposedItems, orderRevision: change.baseOrderRevision + 1, lastChangeId: change.id }, 'procurement/order-revised')
      await exchange(user, order.supplierId, 'orders', order, 'procurement/revised-order-received')
      change = await save(user, 'changes', { ...change, status: 'applied', appliedOrderRevision: version(order), appliedAt: now() }, 'procurement/change-applied')
      await exchange(user, order.supplierId, 'changes', change, 'procurement/change-applied')
      return { ok: true, change, order, message: 'Approved line changes applied to both parties’ order scope.' }
    }
    if (action === 'settle-change') {
      const change = get(user, 'changes', input.id); party(user, change)
      if (!['applied', 'settled'].includes(change.status)) fail('Apply the approved change before recording its closure.')
      if ((change.settledBy || []).some(row => row.partyId === user.id)) return { ok: true, change, duplicate: true }
      await approval(user, action, change.id, input, change)
      const settledBy = [...(change.settledBy || []), { partyId: user.id, humanId: actor(user), note: text(input.note), at: now() }]
      const updated = await save(user, 'changes', { ...change, settledBy, status: settledBy.length === 2 ? 'settled' : 'applied' }, 'procurement/change-settlement-recorded')
      await exchange(user, other(user, change), 'changes', updated, 'procurement/change-settlement-recorded')
      return { ok: true, change: updated, message: 'Change closure recorded. This is not a payment receipt.' }
    }
    if (action === 'record-acceptance') {
      role(user, 'contractor'); const order = currentOrder(user, input.orderId), accepted = acceptedQuantities(user, order.id), seen = new Set()
      const reference = required(input.reference, 'Delivery reference')
      const prior = store.list(user.id, 'acceptances').find(row => row.orderId === order.id && row.reference === reference)
      if (prior) fail('This delivery reference is already recorded. Open its existing receipt to avoid double-counting.')
      if (!Array.isArray(input.lines) || !input.lines.length) fail('Enter at least one received item quantity.')
      const lines = input.lines.map(raw => {
        const item = order.items.find(row => row.id === raw.itemId)
        if (!item || seen.has(raw.itemId)) fail('Choose each ordered item at most once.'); seen.add(raw.itemId)
        const qty = quantity(raw.quantity)
        if (Math.round(((accepted.get(item.id) || 0) + qty) * 1e6) > Math.round(item.quantity * 1e6)) fail(`${item.description}: receipt exceeds approved ordered quantity. Approve a scope change first.`)
        return { itemId: item.id, description: item.description, unit: item.unit, quantity: qty }
      })
      const acceptedAt = input.acceptedAt ? required(input.acceptedAt, 'Delivery date') : now().slice(0, 10)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(acceptedAt) || !Number.isFinite(Date.parse(acceptedAt)) || new Date(acceptedAt).toISOString().slice(0, 10) !== acceptedAt) fail('Choose a valid delivery date.')
      const record = { id: newId('acceptance'), orderId: order.id, rfqId: order.rfqId, ownerId: order.ownerId, supplierId: order.supplierId,
        reference, acceptedAt, lines, deficiencies: text(input.deficiencies), orderRevision: version(order), recordedBy: actor(user) }
      await approval(user, action, order.id, input, record)
      const acceptance = await save(user, 'acceptances', record, 'procurement/acceptance-recorded')
      await exchange(user, order.supplierId, 'acceptances', acceptance, 'procurement/acceptance-received')
      return { ok: true, acceptance }
    }
    if (action === 'record-invoice') {
      const order = currentOrder(user, input.orderId), invoiceNumber = required(input.invoiceNumber, 'Invoice reference'), seen = new Set()
      if (store.list(user.id, 'invoices').some(row => row.orderId === order.id && row.invoiceNumber === invoiceNumber)) fail('That invoice reference is already recorded. Use a distinct corrected source reference; prior records remain in history.')
      if (!Array.isArray(input.lines) || !input.lines.length) fail('Enter the invoice lines as stated in the source.')
      const lines = input.lines.map(raw => {
        const itemId = required(raw.itemId, 'Invoice item reference')
        if (seen.has(itemId)) fail('Combine duplicate invoice item references before recording.'); seen.add(itemId)
        const qty = quantity(raw.quantity), rate = cents(raw.unitPrice)
        if (rate < 0) fail('Negative invoice prices/credit notes are not supported by this matching workflow.')
        return { itemId, description: text(raw.description) || order.items.find(row => row.id === itemId)?.description || itemId,
          quantity: qty, unitPrice: rate / 100, total: lineCents(rate, qty) / 100 }
      })
      const tax = cents(input.taxAmount), freight = cents(input.freightAmount)
      if (tax < 0 || freight < 0) fail('Enter nonnegative stated tax and freight.')
      const currency = required(input.currency, 'Invoice currency').toUpperCase()
      if (!/^[A-Z]{3}$/.test(currency)) fail('Use a three-letter invoice currency.')
      const statedTotal = cents(input.statedTotal, 'Stated invoice total')
      if (statedTotal < 0) fail('The stated invoice total cannot be negative.')
      const record = { id: newId('invoice'), orderId: order.id, rfqId: order.rfqId, ownerId: order.ownerId, supplierId: order.supplierId,
        invoiceNumber, invoiceDate: required(input.invoiceDate, 'Invoice date'), currency, lines, taxAmount: tax / 100, freightAmount: freight / 100,
        total: statedTotal / 100, computedTotal: (lines.reduce((sum, line) => sum + cents(line.total), 0) + tax + freight) / 100, status: 'unmatched', recordedBy: actor(user), recordedByParty: user.id }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(record.invoiceDate) || !Number.isFinite(Date.parse(record.invoiceDate)) || new Date(record.invoiceDate).toISOString().slice(0, 10) !== record.invoiceDate) fail('Choose a valid invoice date.')
      await approval(user, action, order.id, input, record)
      const invoice = await save(user, 'invoices', record, 'procurement/invoice-recorded')
      await exchange(user, other(user, order), 'invoices', invoice, 'procurement/invoice-received')
      return { ok: true, invoice, message: 'Source invoice recorded for matching. No invoice was issued and no payment was made.' }
    }
    if (action === 'reconcile-invoice') {
      role(user, 'contractor'); const invoice = get(user, 'invoices', input.id), order = currentOrder(user, invoice.orderId)
      const accepted = acceptedQuantities(user, order.id), previous = store.list(user.id, 'invoices').filter(row => row.orderId === order.id && row.id !== invoice.id && row.status === 'matched')
      const already = new Map(); let freightUsed = 0
      for (const prior of previous) { freightUsed += cents(prior.freightAmount); for (const line of prior.lines) already.set(line.itemId, (already.get(line.itemId) || 0) + line.quantity) }
      const differences = []
      const add = (kind, message, itemId) => differences.push({ kind, message, ...(itemId ? { itemId } : {}) })
      if (cents(invoice.total) !== invoice.lines.reduce((sum,line) => sum + lineCents(cents(line.unitPrice),line.quantity),0) + cents(invoice.taxAmount) + cents(invoice.freightAmount)) add('arithmetic', 'The stated invoice total differs from its entered lines, tax and freight.')
      if (invoice.currency !== order.currency) add('currency', `Invoice currency ${invoice.currency} differs from order currency ${order.currency}.`)
      for (const line of invoice.lines) {
        const item = order.items.find(row => row.id === line.itemId)
        if (!item) { add('unknown-item', `Item ${line.itemId} is not in approved order scope.`, line.itemId); continue }
        if (cents(line.unitPrice) !== cents(item.unitPrice)) add('unit-price', `${item.description}: invoiced unit price differs from the approved rate.`, item.id)
        if (Math.round(line.quantity * 1e6) > Math.round((item.quantity - (already.get(item.id) || 0)) * 1e6)) add('ordered-quantity', `${item.description}: invoice exceeds remaining approved order quantity.`, item.id)
        if (Math.round(line.quantity * 1e6) > Math.round(((accepted.get(item.id) || 0) - (already.get(item.id) || 0)) * 1e6)) add('accepted-quantity', `${item.description}: received and accepted quantity is insufficient.`, item.id)
      }
      const subtotal = invoice.lines.reduce((sum, row) => sum + cents(row.total), 0), price = quotationAmounts(subtotal, { ...order.commercial, freight: 0 })
      if (price.priceBreakdown.taxAmount === null) add('tax-basis-missing', 'The order does not state a verifiable tax treatment.')
      else if (cents(invoice.taxAmount) !== cents(price.priceBreakdown.taxAmount)) add('tax', 'Invoice added tax does not match the approved treatment on these line amounts.')
      if (order.commercial?.freight === undefined) add('freight-basis-missing', 'The order does not state its freight charge.')
      else if (cents(invoice.freightAmount) + freightUsed > cents(order.commercial.freight)) add('freight', 'Cumulative invoiced freight exceeds the approved charge.')
      const sources = { orderId: order.id, orderRevision: version(order), invoiceId: invoice.id,
        acceptanceIds: store.list(user.id, 'acceptances').filter(row => row.orderId === order.id).map(row => row.id), previousInvoiceIds: previous.map(row => row.id) }
      const status = differences.length ? 'mismatch' : 'matched'
      await approval(user, action, invoice.id, input, { invoice, sources, status, differences })
      const match = await save(user, 'invoice-matches', { id: newId('invoice-match'), ...sources, ownerId: order.ownerId, supplierId: order.supplierId,
        status, differences, invoiceTotal: invoice.total, currency: invoice.currency, checkedBy: actor(user), checkedAt: now() }, status === 'matched' ? 'procurement/invoice-matched' : 'procurement/invoice-mismatch-recorded')
      const updated = await save(user, 'invoices', { ...invoice, status, lastMatchId: match.id }, status === 'matched' ? 'procurement/invoice-matched' : 'procurement/invoice-mismatch-recorded')
      await exchange(user, order.supplierId, 'invoice-matches', match, status === 'matched' ? 'procurement/invoice-matched' : 'procurement/invoice-mismatch-recorded')
      await exchange(user, order.supplierId, 'invoices', updated, 'procurement/invoice-received')
      return { ok: true, invoice: updated, match, message: status === 'matched' ? 'Order, accepted delivery and invoice quantities/rates match.' : 'Differences recorded. Correct the source or record missing delivery before checking again.' }
    }
  }
  const snapshot = user => ({ awardIntents: store.list(user.id, 'award-intents').filter(row => row.ownerId === user.id || row.supplierId === user.id),
    acceptances: store.list(user.id, 'acceptances').filter(row => row.ownerId === user.id || row.supplierId === user.id),
    invoices: store.list(user.id, 'invoices').filter(row => row.ownerId === user.id || row.supplierId === user.id),
    invoiceMatches: store.list(user.id, 'invoice-matches').filter(row => row.ownerId === user.id || row.supplierId === user.id) })
  return { actions, execute, snapshot, changePlan, acceptedQuantities }
}
