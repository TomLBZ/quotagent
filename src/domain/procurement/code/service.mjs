import {createFaq} from './faq.mjs'
import {quoteDeclarations,protectFirmSchedule} from './quote-declarations.mjs'
import {createNegotiation} from './negotiation.mjs'
import {clarificationDeadline} from './response-fields.mjs'
import {createTerms,termFields} from './terms.mjs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { commercialFields, requirementFields, quotationAmounts } from './commercial-fields.mjs'
import { createFulfillment } from './fulfillment.mjs'
import { createRfqLifecycle, rfqRevision, quoteRevision, staleQuote } from './rfq-lifecycle.mjs'
import {scopeFields,scopeItemFields,validatePublishedScope,normalizeQuoteLines,publicQuoteLine} from './structured-scope.mjs'

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
    'notes', 'terms', 'assumptions', 'exclusions', 'schedule', 'status', 'total', 'currency', 'revision', 'rfqRevision', 'commercial', 'subtotal', 'priceBreakdown', 'createdAt', 'updatedAt', 'submittedAt', 'supersededBy', 'withdrawnReason', 'withdrawnAt', 'demo']
    .filter((key) => quote[key] !== undefined).map((key) => [key, copy(quote[key])]))
  record.terms = termFields(quote.terms)
  record.items = quote.items.map(publicQuoteLine)
  return record
}
const publicRfq = (rfq, supplierId) => ({ ...Object.fromEntries(['id', 'title', 'description', 'deadline', 'clarifyDeadline', 'currency', 'items', 'scope', 'scopePolicy', 'terms',
  'status', 'ownerId', 'ownerName', 'revision', 'publishedRevision', 'initialRevision', 'projectId', 'projectName', 'sectionId', 'sectionName', 'amendmentReason', 'requirements', 'createdAt', 'updatedAt', 'publishedAt', 'closedReason', 'closedAt', 'demo']
  .filter((key) => rfq[key] !== undefined).map((key) => [key, copy(rfq[key])])), supplierIds: [supplierId] })

export function createProcurement({ store, accounts, resolveUser = user => user, authorizeCommitment = async () => null, parties = () => [], draftDefaults = () => ({values:{},provenance:{},context:{}}), commercialCostBasis = () => null, proposeNegotiation = () => {throw new Error('Enable Review actions before proposing concessions.')}, negotiationReview = () => null }) {
  const deliveries = new AsyncLocalStorage()
  const directory = user => [...new Map([...accounts.list().filter(person=>!person.disabled).map(({id,name,company,email,role})=>({id,name,company,email,role})),...parties(user)].map(person=>[person.id,person])).values()]
  const party = (user,id) => directory(user).find(person=>person.id===id)
  const deliveryParty = (user,id) => directory(user).find(person=>person.id===id)||parties(user,{includeDisabled:true}).find(person=>person.id===id)
  const defaults = (user,context={}) => { const scoped=resolveUser(user,'snapshot',{});healthy(scoped.id);return draftDefaults(scoped,context) }
  const prepare = (user,input,kind) => {
    const basis=defaults(user,kind==='rfq'?{projectId:input.projectId,sectionId:input.sectionId}:{})
    const mapping=kind==='rfq'?{description:'requestBrief',currency:'currency'}:{leadDays:'quoteLeadDays',paymentTerms:'quotePaymentTerms',notes:'quoteNotes'}
    const fields={...input},applied={}
    for(const [field,key]of Object.entries(mapping))if(input[field]===undefined&&basis.values[key]!==undefined){fields[field]=basis.values[key];applied[field]={value:copy(basis.values[key]),source:copy(basis.provenance[key]||{source:'default',layer:'schema'})}}
    return {fields,basis:Object.keys(applied).length?{context:copy(basis.context),applied,preparedAt:now()}:undefined}
  }
  const healthy = realm => { const state = store.health?.()[realm]; if (state?.healthy === false) throw Object.assign(new Error(state.message || 'This workspace needs ledger recovery before it can be read or changed.'), { status: 503, code: state.code || 'LEDGER_INTEGRITY', nextAction: state.nextAction }) }
  const get = (user, collection, id) => { healthy(user.id); return store.get(user.id, collection, required(id, 'Record ID')) || fail('That record is not available in your workspace.', 404) }
  const save = async (user, collection, record, event, actor = `human:${user.actorId || user.id}`, options = {}) => {
    const next = { ...record, updatedAt: now(), createdAt: record.createdAt || now() }
    await store.put(user.id, collection, next, { actor, event, ...options })
    return next
  }
  const exchange = async (user, recipient, collection, record, event) => {
    if (!deliveryParty(user,recipient)) fail('This recipient is unavailable. Check its account or explicitly enabled paired delivery route.', 404)
    const result = await store.exchange(user.id, recipient, collection, copy(record), { actor: `human:${user.actorId || user.id}`, event })
    if (result?.status) deliveries.getStore()?.push({ recipient, collection, recordId: record.id, ...result })
    return result
  }
  const approval = async (user, action, id, input, record) => {
    if (input.confirmed !== true) fail('Review this commitment and confirm it before sending.')
    for(const recipient of new Set([...(record.supplierIds||[]),record.ownerId,record.supplierId,record.toId].filter(id=>id&&id!==user.id))) if(!deliveryParty(user,recipient)) fail('A counterparty delivery route or account is unavailable. Restore its explicit pairing before confirming this operation.',409)
    const authority = await authorizeCommitment(user, { action, id, record: copy(record), input: copy(input) })
    await store.append(user.id, 'procurement/human-approved', { action, recordId: id, confirmed: true,
      humanId: user.actorId || user.id, authority: authority || null, scope: copy(record), approvedAt: now() }, { actor: `human:${user.actorId || user.id}`, eventClass: 'fact' })
  }
  const rfqItems = (raw) => {
    if (!Array.isArray(raw) || !raw.length) fail('Add at least one item to the RFQ.')
    const ids = new Set()
    return raw.map((item, i) => {
      const id = text(item.id) || `item-${i + 1}`
      if (ids.has(id)) fail(`Item ID ${id} is repeated.`)
      ids.add(id)
      return { id, description: required(item.description, `Item ${i + 1} description`),
        quantity: quantity(item.quantity), unit: required(item.unit || 'each', `Item ${i + 1} unit`), ...scopeItemFields(item) }
    })
  }
  const suppliers = (ids, user) => [...new Set(Array.isArray(ids) ? ids.map(String) : [])].map((id) => {
    const supplier = party(user,id)
    if (!supplier || supplier.role !== 'supplier') fail('Choose an active supplier account or explicitly paired supplier from the contact list.')
    return id
  })
  const quoteItems = (items, rfq) => normalizeQuoteLines(items,rfq,{cents,quantity,lineCents})
  const faq=createFaq({store,get,save,fail,required,newId,approval})
  const negotiation=createNegotiation({store,get,save,fail,required,text,newId,cents,proposeReview:proposeNegotiation,getReview:negotiationReview,costBasis:(user,quote,item,kind)=>{if(kind==='commercial')return commercialCostBasis(user,quote,item);if(item.cost===undefined)return null;const event=store.events(user.id).findLast(row=>row.body?.collection==='quotes'&&row.body.record?.id===quote.id);return{unitCost:item.cost,kind:'quoted-private-unit-cost',sourceRef:event?{realm:user.id,seq:event.seq,hash:event.entry_hash}:null}},applyQuote:(user,input)=>executeInner(user,'save-quote',input),sendMessage:(user,input)=>executeInner(user,'send-message',input)})
  const terms = createTerms({store,get,save,role,fail,required,text,newId,approval})
  const lifecycle = createRfqLifecycle({ store, accounts, get, save, exchange, approval, fail, required, text, role, newId, rfqItems, suppliers, currencyOf, publicRfq })
  const fulfillment = createFulfillment({ store, accounts, get, save, exchange, approval, fail, required, text, role, newId, cents, quantity, lineCents, publicQuote, publicRfq, terms })
  const comparison = (rfqs, quotes, competitive = true) => {
    const result = []
    for (const rfq of rfqs) {
      const candidates = quotes.filter((quote) => quote.rfqId === rfq.id && ['submitted', 'awarded'].includes(quote.status) && !staleQuote(quote, rfq))
      const highest = Math.max(0, ...candidates.map((quote) => quote.total))
      const sorted = [...candidates].sort((a, b) => a.total - b.total || a.leadDays - b.leadDays)
      for (const [index, quote] of sorted.entries()) {
        const risks = []
        const present = new Set(quote.items.map((item) => item.id))
        const missing = rfq.items.filter((item) => !present.has(item.id))
        if (missing.length) risks.push(`${missing.length} unpriced RFQ item${missing.length === 1 ? '' : 's'}: ${missing.map((item) => item.description).join(', ')}`)
        for(const item of quote.items.filter(item=>item.classification==='additional'||item.classification==='alternative'))risks.push(`${item.classification==='additional'?'Additional scope':'Alternative scope'}: ${item.description}. ${item.scopeReason}`)
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
    user = resolveUser(user, 'snapshot', {})
    healthy(user.id)
    client(user)
    const newest = (rows) => rows.sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))
    const rfqs = newest(store.list(user.id, 'rfqs')).map(rfq => ({ ...rfq, publishedRevision: rfqRevision(rfq) })).filter((rfq) => user.role === 'contractor' ? rfq.ownerId === user.id : rfq.supplierIds.includes(user.id))
    const visible = new Set(rfqs.map((rfq) => rfq.id))
    const quotes = newest(store.list(user.id, 'quotes')).filter((quote) => visible.has(quote.rfqId) && (user.role === 'contractor' || quote.supplierId === user.id))
      .map((quote) => { const rfq = rfqs.find(row => row.id === quote.rfqId); const stale = staleQuote(quote, rfq); return { ...quote, ...(store.get(user.id, 'quote-status', quote.id) || {}), rfqRevision: quoteRevision(quote, rfq), currentRfqRevision: rfqRevision(rfq), stale, staleReason: stale ? `Prepared against request revision ${quoteRevision(quote, rfq)}; current revision is ${rfqRevision(rfq)}. Review the new scope and prepare a rebid.` : '' } })
    const orders = newest(store.list(user.id, 'orders')).filter((order) => user.role === 'contractor' ? order.ownerId === user.id : order.supplierId === user.id)
    const orderIds = new Set(orders.map((order) => order.id))
    const messages = newest(store.list(user.id, 'messages')).filter((message) => message.fromId === user.id || message.toId === user.id)
    const changes = newest(store.list(user.id, 'changes')).filter((change) => orderIds.has(change.orderId))
    const contacts = directory(user).filter(person => person.role === (user.role === 'contractor' ? 'supplier' : 'contractor'))
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
    return { realmId: user.id, deliveries: store.list(user.id, 'exchange-outbox').filter(row => !row.control && row.collection && row.type?.startsWith('procurement/')).map(({id,collection,recordId,title,status,to,error,nextAction,updatedAt}) => ({id,collection,recordId,title,status,to,error,nextAction,updatedAt})), rfqs, quotes, orders, messages, changes, activity, contacts, ...lifecycle.snapshot(user, rfqs), ...fulfillment.snapshot(user), ...terms.state(user,rfqs,quotes),...faq.state(user), ...negotiation.state(user), comparison: comparison(rfqs, quotes, user.role === 'contractor'),
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

  async function executeInner(user, action, input = {}, context = {}) {
    const {agent=false}=context
    client(user)
    if (user.permissions?.includes('workspace:read-only')) fail('This account has read-only workspace access. Ask your administrator to enable editing.', 403)
    if (agent && !['create-rfq', 'save-quote', 'save-amendment', 'save-clarification-answer', 'request-negotiation','prepare-faq','adapt-faq'].includes(action)) fail('The assistant can prepare this action for human review but cannot commit it.', 403)
    const actor = `${agent ? 'agent' : 'human'}:${user.actorId || user.id}`
    if (negotiation.actions.has(action)) return negotiation.execute(user,action,input,context)
    if (terms.actions.has(action)) return terms.execute(user,action,input)
    if (faq.actions.has(action)) return faq.execute(user,action,input,context)
    if (fulfillment.actions.has(action)) return fulfillment.execute(user, action, input)
    if (lifecycle.actions.has(action)) return lifecycle.execute(user, action, input, actor)
    if (action === 'create-rfq') {
      role(user, 'contractor')
      const existing = input.id ? get(user, 'rfqs', input.id) : null
      if (existing && (existing.ownerId !== user.id || existing.status !== 'draft')) fail('Only your own unpublished RFQ draft can be edited.', 403)
      const prepared = existing ? {fields:input,basis:existing.draftDefaults} : prepare(user,input,'rfq')
      const fields = { ...existing, ...prepared.fields }
      const initialTerms=existing?{terms:termFields(input.terms,existing.terms,fail),basis:existing.termsBasis}:terms.applyDefaults(user,'request',input.terms)
      const deadline = text(fields.deadline)
      if (deadline && !Number.isFinite(Date.parse(deadline))) fail('Choose a valid deadline.')
      const rfq = await save(user, 'rfqs', { ...existing, id: existing?.id || newId('rfq'), title: required(fields.title, 'RFQ title'),
        description: text(fields.description), scope:scopeFields(fields.scope,existing?.scope), terms:initialTerms.terms, termsBasis:initialTerms.basis, draftDefaults: prepared.basis, deadline, clarifyDeadline:clarificationDeadline(fields.clarifyDeadline,deadline), currency: currencyOf(fields.currency || (fields.projectId ? get(user, 'projects', fields.projectId).currency : undefined)), items: rfqItems(fields.items),
        requirements: requirementFields(existing?.requirements, input.requirements), ...lifecycle.contextFields(user, fields), status: 'draft', ownerId: user.id, ownerName: nameOf(user), supplierIds: suppliers(fields.supplierIds,user), revision: (existing?.revision || 0) + 1 }, 'procurement/rfq-drafted', actor, input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {})
      return { ok: true, rfq, message: 'RFQ draft saved. Review the items and invited suppliers before publishing.' }
    }
    if (action === 'publish-rfq') {
      role(user, 'contractor')
      const rfq = get(user, 'rfqs', input.id)
      if (rfq.ownerId !== user.id) fail('Only the RFQ owner can publish it.', 403)
      if (rfq.status === 'published') return { ok: true, rfq, duplicate: true }
      if (!rfq.supplierIds.length) fail('Choose at least one supplier before publishing.')
      validatePublishedScope(rfq,{requireDeclarations:true})
      await approval(user, action, rfq.id, input, rfq)
      const published = await save(user, 'rfqs', { ...rfq, scopePolicy:'declared/v1', status: 'published', publishedRevision: 1, initialRevision: 1, publishedAt: now() }, 'procurement/rfq-published')
      await lifecycle.version(user, published)
      for (const supplierId of published.supplierIds) {
        await exchange(user, supplierId, 'rfqs', publicRfq(published, supplierId), 'procurement/rfq-delivered')
        const record = store.get(user.id, 'rfq-versions', `${published.id}:v${rfqRevision(published)}`)
        await exchange(user, supplierId, 'rfq-versions', lifecycle.publicVersion(record, supplierId), 'procurement/rfq-version-recorded')
      }
      return { ok: true, rfq: published, message: `RFQ delivered to ${published.supplierIds.length} supplier(s).` }
    }
    if (action === 'save-quote') {
      role(user, 'supplier')
      const rfq = get(user, 'rfqs', input.rfqId)
      if (!rfq.supplierIds.includes(user.id) || rfq.status !== 'published') fail('This RFQ is not open for your quotation.')
      if (rfqRevision(rfq) > (rfq.initialRevision || 1) && input.rfqRevision === undefined) fail('Specify the current request revision when preparing a rebid; review the amended scope first.', 409)
      lifecycle.checkExpected(rfq, input.rfqRevision)
      const existing = input.id ? get(user, 'quotes', input.id) : null
      if (existing && (existing.supplierId !== user.id || existing.rfqId !== rfq.id)) fail('This is not your quote for this RFQ.', 403)
      if (existing?.status === 'awarded') fail('Use an order change for an awarded quote.')
      const prepared = existing ? {fields:{...existing,...input},basis:existing.draftDefaults} : prepare(user,input,'quote')
      input = prepared.fields
      const initialTerms=existing?{terms:termFields(input.terms,existing.terms,fail),basis:existing.termsBasis}:terms.applyDefaults(user,'quote',input.terms)
      let items
      try{items=quoteItems(input.items,rfq)}catch(error){if(error.code==='SCOPE_NORMALIZATION')await store.append(user.id,'procurement/normalization-refused',{rfqId:rfq.id,rfqRevision:rfqRevision(rfq),quoteId:existing?.id||null,code:error.code,reason:error.message,nextAction:error.nextAction},{actor,eventClass:'fact'});throw error}
      if(input.leadDays === '') fail('State the lead time in whole days; an empty value is unknown.')
      const leadDays = Number(input.leadDays ?? 14)
      if (!Number.isInteger(leadDays) || leadDays < 0 || leadDays > 3650) fail('Lead time must be a whole number of days from 0 to 3650.')
      const commercial = commercialFields(existing?.commercial, input.commercial, items.map(item => item.id))
      const amounts = quotationAmounts(items.reduce((sum, item) => sum + cents(item.total), 0), commercial)
      const total = amounts.total
      const costTotal = items.reduce((sum, item) => sum + cents(item.costTotal || 0), 0) / 100
      const costComplete = items.every((item) => item.cost !== undefined)
      const declarations=quoteDeclarations(existing,input,items.map(item=>item.id))
      const activeOffer=store.list(user.id,'quotes').filter(row=>row.rfqId===rfq.id&&row.supplierId===user.id&&['submitted','awarded'].includes(row.status)).sort((a,b)=>(b.revision||0)-(a.revision||0))[0]
      protectFirmSchedule({agent,prior:activeOffer,next:declarations,asOf:now().slice(0,10)})
      const quote = await save(user, 'quotes', { ...existing, id: existing?.id || newId('quote'), rfqId: rfq.id, rfqRevision: rfqRevision(rfq),
        supplierId: user.id, supplierName: nameOf(user), ownerId: rfq.ownerId, items, leadDays, draftDefaults: prepared.basis,
        ...declarations, paymentTerms: text(input.paymentTerms), terms:initialTerms.terms, termsBasis:initialTerms.basis, notes: text(input.notes), privateNotes: text(input.privateNotes ?? existing?.privateNotes),
        status: 'draft', ...amounts, costTotal, costComplete, margin: costComplete ? (cents(amounts.subtotal) - cents(costTotal)) / 100 : null, marginBasis: 'Quoted item subtotal minus private item costs; excludes separately declared tax, freight and other costs',
        commercial, currency: currencyOf(input.currency || existing?.currency || rfq.currency), revision: existing ? (existing.revision || 0) + 1
          : Math.max(0, ...store.list(user.id, 'quotes').filter((row) => row.rfqId === rfq.id).map((row) => row.revision || 1)) + 1 }, 'procurement/quote-drafted', actor, input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {})
      return { ok: true, quote, message: 'Private quote draft saved. Costs stay in your workspace.' }
    }
    if (action === 'submit-quote') {
      role(user, 'supplier')
      const quote = get(user, 'quotes', input.id)
      if (quote.supplierId !== user.id) fail('Only the quote owner can submit it.', 403)
      const rfq = get(user, 'rfqs', quote.rfqId)
      if (staleQuote(quote, rfq)) fail(`This quote is based on request revision ${quoteRevision(quote, rfq)}. Rebid against revision ${rfqRevision(rfq)} before submitting.`, 409)
      if (quote.status === 'submitted') return { ok: true, quote, duplicate: true }
      if (quote.status !== 'draft') fail('Only a draft quote can be submitted.')
      if (rfq.status !== 'published') fail('This RFQ is no longer open.')
      if (quote.commercial?.taxMode === 'exclusive' && quote.commercial.taxRate === undefined) fail('State the tax rate for this tax-exclusive quotation before submitting.')
      if (quote.commercial?.validityUntil && quote.commercial.validityUntil < now().slice(0, 10)) fail('This quotation has expired. Prepare a current revision before submitting.')
      await approval(user, action, quote.id, input, publicQuote(quote))
      const submitted = await save(user, 'quotes', { ...quote, status: 'submitted', submittedAt: now() }, 'procurement/quote-submitted')
      await exchange(user, rfq.ownerId, 'quotes', publicQuote(submitted), 'procurement/quote-received')
      for (const prior of store.list(user.id, 'quotes').filter((row) => row.rfqId === rfq.id && row.id !== quote.id && row.status === 'submitted')) {
        const superseded = await save(user, 'quotes', { ...prior, status: 'superseded', supersededBy: submitted.id }, 'procurement/quote-superseded')
        await exchange(user, rfq.ownerId, 'quotes', publicQuote(superseded), 'procurement/quote-superseded')
      }
      for (const request of store.list(user.id, 'rebid-requests').filter(row => row.rfqId === rfq.id && row.rfqRevision === rfqRevision(rfq) && row.status === 'requested')) {
        const completed = await save(user, 'rebid-requests', { ...request, status: 'submitted', quoteId: submitted.id }, 'procurement/rebid-submitted')
        await exchange(user, rfq.ownerId, 'rebid-requests', completed, 'procurement/rebid-submitted')
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
    if (action === 'acknowledge-order') {
      role(user, 'supplier')
      const order = get(user, 'orders', input.id)
      if (order.supplierId !== user.id) fail('This order belongs to another supplier.', 403)
      if (order.status === 'acknowledged') return { ok: true, order, duplicate: true }
      await approval(user, action, order.id, input, order)
      const acknowledged = await save(user, 'orders', { ...order, status: 'acknowledged', acknowledgedAt: now(), acknowledgedBy: user.actorId || user.id }, 'procurement/order-acknowledged')
      await exchange(user, order.ownerId, 'orders', acknowledged, 'procurement/acknowledgment-received')
      return { ok: true, order: acknowledged, message: 'Order acknowledged. Both parties now have the same confirmed order.' }
    }
    if (action === 'seed-demo') return seedDemo(user)
    fail(`Unknown procurement action: ${action}`, 404)
  }

  const writes = new Map()
  function execute(user, action, input = {}, options = {}) {
    client(user)
    if (user.permissions?.includes('workspace:read-only')) return Promise.reject(Object.assign(new Error('This account has read-only workspace access.'), { status: 403 }))
    if (options.agent && !['create-rfq', 'save-quote', 'save-amendment', 'save-clarification-answer', 'request-negotiation','prepare-faq','adapt-faq'].includes(action)) return Promise.reject(Object.assign(new Error('The assistant can prepare this action for human review but cannot commit it.'), { status: 403 }))
    user = resolveUser(user, action, input)
    healthy(user.id)
    const target = input.id ? ['quotes', 'rfq-amendments', 'clarifications', 'orders', 'changes', 'award-intents', 'invoices', 'acceptances','negotiation-threads','faqs'].map(collection => store.get(user.id, collection, input.id)).find(Boolean) : input.quoteId ? store.get(user.id, 'quotes', input.quoteId) : input.orderId ? store.get(user.id, 'orders', input.orderId) : input.threadId ? store.get(user.id,'negotiation-threads',input.threadId) : null
    const key = input.rfqId || (input.clarificationId?store.get(user.id,'clarifications',input.clarificationId)?.rfqId:null) || target?.rfqId || target?.source?.rfqId || input.id || user.id
    const prior = writes.get(key) || Promise.resolve()
    const job = prior.catch(() => {}).then(() => deliveries.run([], async () => { const result = await executeInner(user, action, input, options), rows = deliveries.getStore(); const pending = rows.filter(row => row.status !== 'delivered'); return rows.length ? { ...result, deliveries: rows.map(({recipient,collection,recordId,msgId,received,status,error,nextAction}) => ({recipient,collection,recordId,msgId,received,status,error,nextAction})), deliveryPending: pending.length > 0, ...(pending.length ? { message: `Your decision is recorded. ${pending.length} transfer(s) still need delivery or conflict resolution; the counterparty may not yet have this update. Open Deliveries to review the signed message.` } : {}) } : result }))
    writes.set(key, job)
    job.finally(() => { if (writes.get(key) === job) writes.delete(key) }).catch(() => {})
    return job
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

  const previewChange = (user, orderId, lines, expectedRevision) => { client(user); user = resolveUser(user, 'snapshot', {}); const order = get(user, 'orders', orderId); if (expectedRevision !== undefined && Number(expectedRevision) !== (order.orderRevision || 1)) fail('The order changed while you were editing. Reopen the change form to review the current quantities and rates.', 409); if (![order.ownerId, order.supplierId].includes(user.id)) fail('This agreement belongs to another party.', 403); return { orderId, orderRevision: order.orderRevision || 1, ...fulfillment.changePlan(user, order, lines) } }
  return { snapshot, execute, exportCsv, faqLookup:(user,input)=>faq.lookup(resolveUser(user,'snapshot',input),input), previewChange, defaults, termDefaults:(user,kind,values)=>terms.applyDefaults(resolveUser(user,'snapshot',{}),kind,values), parties: user => directory(resolveUser(user,'snapshot',{})), realm: user => { const owner = resolveUser(user, 'snapshot', {}).id; healthy(owner); return owner }, normalizeQuoteItems:(items,rfq)=>quoteItems(items,rfq).map(publicQuoteLine), normalizeCommercial: commercialFields, normalizeRequirements: requirementFields,normalizeQuoteDeclarations:quoteDeclarations, normalizeQuotePrice: (items, commercial = {}) => quotationAmounts(items.reduce((sum, item) => sum + lineCents(cents(item.unitPrice), quantity(item.quantity)), 0), commercialFields({}, commercial, items.map(item => item.id))) }
}
