// Frozen public commercial inputs. No private supplier cost or contractor scoring.
export const fulfillmentLabels = { 'propose-award': 'Propose nonbinding award', 'confirm-award': 'Confirm award intent', 'decline-award': 'Decline award intent', 'withdraw-award': 'Withdraw award intent', 'sign-order': 'Sign purchase order', award: 'Sign purchase order', 'confirm-change': 'Confirm sourced change', 'reject-change': 'Reject sourced change', 'approve-change': 'Approve and apply order change', 'settle-change': 'Record change closure', 'close-rfq': 'Close request', 'withdraw-quote': 'Withdraw quotation' }
export function fulfillmentReview(user, action, input, data) {
  if (!fulfillmentLabels[action]) return null
  const fail = message => { throw new Error(message) }
  const contractor = user.role === 'contractor'
  if (['propose-award','sign-order','award','withdraw-award','approve-change','close-rfq'].includes(action) && !contractor) fail('This decision belongs to the contractor.')
  if (['confirm-award','decline-award','withdraw-quote'].includes(action) && contractor) fail('This decision belongs to the supplier.')
  let record, payload = { id: input.id }, order = null, quote = null
  if (action === 'propose-award') {
    quote = record = data.quotes.find(row => row.id === input.quoteId)
    payload = { quoteId: input.quoteId, reason: String(input.reason || '').trim() }
  } else if (['confirm-award','decline-award','withdraw-award','sign-order','award'].includes(action)) {
    record = data.awardIntents.find(row => action === 'award' ? row.quoteId === input.quoteId && row.status === 'confirmed' : row.id === input.id)
    quote = data.quotes.find(row => row.id === record?.quoteId)
    payload = action === 'award' ? { quoteId: input.quoteId } : { id: input.id }
  } else if (action.endsWith('-change')) {
    record = data.changes.find(row => row.id === input.id)
    order = data.orders.find(row => row.id === record?.orderId)
  } else record = (action === 'close-rfq' ? data.rfqs : data.quotes).find(row => row.id === input.id)
  if (!record) fail('The source record is not available in this workspace.')
  const rfq = data.rfqs.find(row => row.id === (record.rfqId || record.id))
  if (record.ownerId !== user.id && record.supplierId !== user.id) fail('This decision belongs to another workspace.')
  if (['propose-award','withdraw-quote'].includes(action) && (record.status !== 'submitted' || action === 'propose-award' && record.stale)) fail('Choose a current submitted quotation.')
  if (['sign-order','award'].includes(action) && (record.status !== 'confirmed' || !record.confirmedBy)) fail('Obtain supplier confirmation of this award intent before preparing the signature.')
  if (action === 'approve-change' && (record.status !== 'confirmed' || !record.counterpartyConfirmedBy || !record.lines?.length)) fail('Confirm a change with quoted-line sources before requesting approval.')
  if (['confirm-change','reject-change'].includes(action) && (record.status !== 'proposed' || record.proposedBy === user.id)) fail('Only the other party may respond to a proposed change.')
  if (['decline-award','withdraw-award','reject-change','close-rfq','withdraw-quote'].includes(action)) payload.reason = String(input.reason || '').trim()
  if (['decline-award','withdraw-award','reject-change','close-rfq','withdraw-quote','propose-award'].includes(action) && !payload.reason) fail('State the reason for this decision.')
  if (action === 'settle-change') payload.note = String(input.note || '').trim()
  const recipientIds = action === 'close-rfq' ? record.supplierIds : [contractor ? record.supplierId : record.ownerId]
  const recipients = recipientIds.map(id => data.contacts.find(row => row.id === id)).map(person => person && ({ id: person.id, name: person.company || person.name, email: person.email }))
  if (!recipients.length || recipients.some(row => !row)) fail('The counterparty is no longer available.')
  const commercial = record.quote || quote || record
  const targets = { record, rfq: rfq || null, quote, order, recipients }
  const preview = { title: record.title || rfq?.title || order?.title || 'Project decision', label: fulfillmentLabels[action], recipients,
    currency: record.currency || rfq?.currency || order?.currency, amount: record.amount ?? record.total,
    description: payload.reason || record.reason || record.description || '', text: record.quote ? `Supplier confirmation: ${record.confirmedAt || 'awaiting supplier'}. Request revision ${record.rfqRevision}.` : '',
    items: commercial.items || [], changes: record.lines || [], priceBreakdown: commercial.priceBreakdown,
    paymentTerms: commercial.paymentTerms || '', leadDays: commercial.leadDays, commercial: commercial.commercial || {}, terms:commercial.terms||[], requiredTerms:record.requiredTerms||[], termExceptions:record.termExceptions||[],
    ...(order ? { orderRevision: order.orderRevision || 1, resultingTotal: record.proposedAmounts?.total } : {}) }
  return { action, payload, reviewed: targets, preview }
}
