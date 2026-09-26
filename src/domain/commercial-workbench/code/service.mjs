import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fail, text, required, finite, cents, quantity, currency, date, clone, digest, itemKey, buildCosts, proposePrices, schedulePlan, describeHistory, csv, addDays } from './arithmetic.mjs'
import { calculateEvaluation, validatePolicy, defaultPolicy } from './evaluation.mjs'
const require = createRequire(new URL('../../../../host/package.json', import.meta.url)), { parse } = require('csv-parse/sync')
const now = () => new Date().toISOString()
const id = kind => `${kind}-${randomUUID()}`
const collection = key => `commercial-${key}`

export function createCommercial(ctx, getReviews) {
  const account = (user, role) => {
    const current = user?.id && ctx.accounts.get(user.id)
    if (!current || current.disabled || !['contractor', 'supplier'].includes(current.role) || role && current.role !== role) fail(role ? `This action belongs to the ${role} workspace.` : 'Open a supplier or contractor workspace.', 403)
    return current
  }
  const snapshot = user => ctx.procurement.snapshot(account(user))
  const list = (user, key) => ctx.store.list(user.id, collection(key))
  const get = (user, key, recordId) => ctx.store.get(user.id, collection(key), required(recordId, 'Record ID')) || fail('That record is not in your account.', 404)
  const businessRealm = user => ctx.procurement.realm(user)
  const ref = (user, name, recordId, path = '') => {
    const realm = name.startsWith('commercial-') ? user.id : businessRealm(user)
    const event = ctx.store.events(realm).findLast(event => event.body?.schema === 'quotagent/workspace-record/v1' && event.body.collection === name && event.body.record.id === recordId)
    if (!event) fail(`The source record ${recordId} has no ledger reference.`)
    return { realm, seq: event.seq, hash: event.entry_hash, collection: name, recordId, revision: event.body.record.revision ?? null, path }
  }
  const annotated = (user, key) => list(user, key).map(record => ({ ...record, sourceRef: ref(user, collection(key), record.id) }))
  const save = async (user, key, record, event, context = {}) => {
    const before = record.id && ctx.store.get(user.id, collection(key), record.id)
    const next = { ...clone(record), id: record.id || id(key), ownerId: user.id, revision: (before?.revision || 0) + 1, createdAt: before?.createdAt || now(), updatedAt: now() }
    await ctx.store.put(user.id, collection(key), next, { actor: `${context.agent ? 'agent' : 'human'}:${user.id}`, event: `commercial/${event}` })
    return { ...next, sourceRef: ref(user, collection(key), next.id) }
  }
  const quoteFor = (user, quoteId) => snapshot(user).quotes.find(row => row.id === quoteId) || fail('Choose a quotation available in this account.', 404)
  const rfqFor = (user, rfqId) => snapshot(user).rfqs.find(row => row.id === rfqId) || fail('Choose a request available in this account.', 404)
  const history = user => {
    const data = snapshot(user), realm = businessRealm(user), visible = new Set(data.rfqs.map(row => row.id)), versions = new Map()
    for (const event of ctx.store.events(realm)) {
      const body = event.body, quote = body?.record
      if (body?.collection !== 'quotes' || !quote || !visible.has(quote.rfqId) || !['submitted', 'awarded'].includes(quote.status) || user.role === 'supplier' && quote.supplierId !== realm) continue
      const key = `${quote.id}:${quote.revision}`
      if (!versions.has(key)) versions.set(key, { quote, event })
    }
    const rows = [...versions.values()].flatMap(({ quote, event }) => quote.items.map(item => ({ quoteId: quote.id, revision: quote.revision, rfqId: quote.rfqId, supplierId: quote.supplierId, supplierName: quote.supplierName,
      description: item.description, unit: item.unit, currency: quote.currency, unitPrice: item.unitPrice, leadDays: quote.leadDays, at: quote.submittedAt || event.ts,
      hasDeviation: !!quote.commercial?.deviations?.some(row => !row.itemId || row.itemId === item.id), sourceRef: { realm, seq: event.seq, hash: event.entry_hash, collection: 'quotes', recordId: quote.id, revision: quote.revision, path: `items/${item.id}` } })))
    return describeHistory(rows)
  }
  const references = user => {
    const manual = annotated(user, 'references')
    const awards = snapshot(user).orders.flatMap(order => (order.items || []).map(item => ({ id: `${order.id}:${item.id}`, description: item.description, unit: item.unit, currency: order.currency, unitPrice: item.unitPrice,
      source: `Local awarded order ${order.title || order.id}`, observedAt: order.createdAt, kind: 'award', sourceRef: ref(user, 'orders', order.id, `items/${item.id}`) })))
    return [...manual, ...awards]
  }
  const state = (user, rfqId) => {
    user = account(user); const data = snapshot(user)
    const records = Object.fromEntries(['costs', 'plans', 'fx', 'references', 'policies', 'assumptions', 'evaluations', 'prices', 'erp-imports', 'reports'].map(key => [key, annotated(user, key)]))
    return { ...data, ...records, calendars: annotated(user, 'calendars'), mappings: annotated(user, 'erp-mappings'), history: history(user), referencePrices: references(user),
      defaults: { policy: defaultPolicy, minimumMarginPercent: ctx.settings.get(user, 'commercial').minimumMarginPercent }, selectedRfqId: rfqId || null,
      scope: user.role === 'supplier' ? 'Your own quotations, private costs and capacity only.' : 'Received quotations and your private evaluation assumptions only.' }
  }
  const evaluate = async (user, input, context = {}) => {
    account(user, 'contractor')
    const data = snapshot(user), rfq = data.rfqs.find(row => row.id === input.rfqId) || fail('Choose an RFQ.'), policy = get(user, 'policies', `policy-${rfq.id}`)
    const assumptions = Object.fromEntries(annotated(user, 'assumptions').filter(row => row.rfqId === rfq.id).map(row => [row.quoteId, row]))
    const quotes = data.quotes.filter(row => row.rfqId === rfq.id && ['submitted', 'awarded'].includes(row.status))
    if (!quotes.length) fail('This request has no received quotations to evaluate.')
    const sources = { rfq: ref(user, 'rfqs', rfq.id), policy: ref(user, collection('policies'), policy.id), quotes: Object.fromEntries(quotes.map(row => [row.id, ref(user, 'quotes', row.id)])) }
    const asOf = input.asOf || now(); if (!Number.isFinite(Date.parse(asOf))) fail('Enter a valid evaluation time.')
    const basis = { rfq, quotes, policy: policy.policy, asOf: new Date(asOf).toISOString(), currency: currency(input.currency || rfq.currency), sources, fx: annotated(user, 'fx'), references: references(user), assumptions }
    const result = calculateEvaluation(basis), existing = ctx.store.get(user.id, collection('evaluations'), result.id)
    if (existing) return { ok: true, evaluation: { ...existing, sourceRef: ref(user, collection('evaluations'), result.id) }, duplicate: true }
    return { ok: true, evaluation: await save(user, 'evaluations', { ...result, rfqTitle: rfq.title, basis }, 'evaluation-computed', context) }
  }
  const pricingBasis = (user, quoteId) => {
    const quote = quoteFor(user, quoteId), costs = get(user, 'costs', `cost-${quote.id}`)
    if (quote.status !== 'draft' || quote.stale) fail('Prepare a current private quote draft before applying proposed prices.')
    if (quote.revision !== costs.quoteRevision) fail('The quote changed. Rebuild its private costs before preparing prices.')
    return { quote, costs, minimumMarginPercent: ctx.settings.get(user, 'commercial').minimumMarginPercent }
  }
  const propose = async (user, input, context = {}) => {
    account(user, 'supplier'); const reviews = getReviews()
    if (!reviews) fail('Enable Review actions before preparing a price proposal.')
    const basis = pricingBasis(user, input.quoteId), proposed = proposePrices(basis.quote, basis.costs, input.targetMarginPercent)
    Object.assign(proposed, ctx.procurement.normalizeQuotePrice(proposed.items, basis.quote.commercial || {}))
    proposed.marginBasis = 'item subtotal less fully burdened private costs; excludes separately declared sales tax and freight'
    const proposal = await save(user, 'prices', { id: id('pricing'), ...proposed, rfqId: basis.quote.rfqId, currency: basis.quote.currency,
      minimumMarginPercent: basis.minimumMarginPercent, belowFloor: proposed.actualMarginPercent === null || proposed.actualMarginPercent < basis.minimumMarginPercent,
      basisDigest: digest(basis), basis, status: 'proposed', sourceRefs: [ref(user, 'quotes', basis.quote.id), ref(user, collection('costs'), basis.costs.id)] }, 'pricing-proposed', context)
    const approval = await reviews.propose(user, { kind: 'commercial.apply-prices', title: `Review draft prices: ${basis.quote.supplierName || 'Your quotation'}`, summary: `${proposed.total} ${basis.quote.currency}; ${proposal.belowFloor ? 'below your margin floor — explicit exception review required' : 'within your configured margin floor'}. This only updates the private draft.`,
      input: { proposalId: proposal.id, basisDigest: proposal.basisDigest, preview: { rfqId: proposal.rfqId, items: proposal.items, currency: proposal.currency, total: proposal.total, subtotal: proposal.subtotal, priceBreakdown: proposal.priceBreakdown, marginBasis: proposal.marginBasis, costTotal: proposal.costTotal, actualMarginPercent: proposal.actualMarginPercent, minimumMarginPercent: proposal.minimumMarginPercent, belowFloor: proposal.belowFloor } },
      source: { kind: context.source || 'human', plugin: 'commercial-workbench' }, runId: context.runId || null })
    return { ok: true, proposal, approval, action: { type: 'navigate', label: 'Review proposed prices', input: { view: 'approvals', actionId: approval.id } } }
  }
  const applyPrices = async (user, input, action, { signal } = {}) => {
    account(user, 'supplier'); if (signal?.aborted) fail('Price application was canceled.')
    const proposal = get(user, 'prices', input.proposalId)
    if (proposal.status === 'applied') return { ok: true, quoteId: proposal.quoteId, duplicate: true }
    const basis = pricingBasis(user, proposal.quoteId)
    if (digest(basis) !== proposal.basisDigest || proposal.basisDigest !== input.basisDigest) fail('The quote, costs or margin policy changed after review. Prepare a new pricing proposal.')
    const result = await ctx.procurement.execute(user, 'save-quote', { ...basis.quote, id: basis.quote.id, items: proposal.items, rfqRevision: basis.quote.rfqRevision })
    await save(user, 'prices', { ...proposal, status: 'applied', approvalId: action.id, appliedQuoteRevision: result.quote.revision }, 'pricing-applied')
    return { ok: true, quoteId: result.quote.id, message: 'Reviewed prices applied to your private draft. The quotation has not been submitted.', action: { type: 'navigate', label: 'Review quote draft', input: { view: 'quotes', quoteId: result.quote.id, rfqId: result.quote.rfqId } } }
  }
  const saveMapping = async (user, input) => {
    const columns = input.columns || {}, requiredColumns = ['poNumber', 'itemId', 'quantity', 'unitPrice']
    for (const key of requiredColumns) columns[key] = required(columns[key], `${key} CSV column`)
    if (new Set(requiredColumns.map(key => columns[key])).size !== requiredColumns.length) fail('Each required CSV field needs a distinct column.')
    const data = snapshot(user)
    const orderMap = (input.orderMap || []).map(row => { if (!data.orders.some(order => order.id === row.orderId)) fail('Map PO numbers to your own existing orders.'); return { externalNumber: required(row.externalNumber, 'External PO number'), orderId: row.orderId } })
    const itemMap = (input.itemMap || []).map(row => ({ externalItemId: required(row.externalItemId, 'External item ID'), itemId: required(row.itemId, 'Internal item ID') }))
    return save(user, 'erp-mappings', { id: 'mapping', columns, orderMap, itemMap, identityIds: input.identityIds === true }, 'erp-mapping-saved')
  }
  const importErp = async (user, input) => {
    const raw = required(input.csv, 'CSV content'); if (raw.length > 2_000_000) fail('Use a CSV file below 2 MB.')
    const mapping = get(user, 'erp-mappings', 'mapping'), data = snapshot(user), output = []
    let rows = [], parseError = ''
    try { rows = parse(raw, { columns: true, bom: true, skip_empty_lines: true, trim: true }); if (rows.length > 10000) fail('Import at most 10,000 rows at once.') } catch (error) { parseError = error.message; rows = [] }
    for (const [index, row] of rows.entries()) {
      try {
        for (const name of ['poNumber', 'itemId', 'quantity', 'unitPrice']) if (!Object.hasOwn(row, mapping.columns[name]) || text(row[mapping.columns[name]]) === '') fail(`Missing mapped ${name} column/value: ${mapping.columns[name]}`)
        const externalNumber = text(row[mapping.columns.poNumber]), externalItem = text(row[mapping.columns.itemId])
        const orderId = mapping.orderMap.find(item => item.externalNumber === externalNumber)?.orderId || (mapping.identityIds ? externalNumber : '')
        const itemId = mapping.itemMap.find(item => item.externalItemId === externalItem)?.itemId || (mapping.identityIds ? externalItem : '')
        const order = data.orders.find(order => order.id === orderId), item = order?.items.find(item => item.id === itemId)
        if (!order || !item) fail('PO or item mapping did not match an existing order line; no mapping was guessed.')
        const qty = quantity(row[mapping.columns.quantity]), price = cents(row[mapping.columns.unitPrice]) / 100
        const incomingCurrency = mapping.columns.currency && row[mapping.columns.currency] ? currency(row[mapping.columns.currency]) : order.currency
        const differences = []
        if (qty !== item.quantity) differences.push(`Quantity ${qty} differs from recorded ${item.quantity}.`)
        if (price !== item.unitPrice) differences.push(`Unit price ${price} differs from recorded ${item.unitPrice}.`)
        if (incomingCurrency !== order.currency) differences.push(`Currency ${incomingCurrency} differs from ${order.currency}.`)
        output.push({ row: index + 2, raw: row, status: differences.length ? 'difference' : 'matched', orderId, itemId, poNumber: externalNumber, quantity: qty, unitPrice: price, currency: incomingCurrency, currencySource: mapping.columns.currency && row[mapping.columns.currency] ? 'CSV column' : 'Mapped order currency', differences, sourceRef: ref(user, 'orders', orderId, `items/${itemId}`) })
      } catch (error) { output.push({ row: index + 2, raw: row, status: 'mapping-error', error: error.message }) }
    }
    return save(user, 'erp-imports', { id: id('erp-import'), filename: text(input.filename) || 'manual-import.csv', raw, mapping: clone(mapping), rows: output, parseError,
      status: parseError || output.some(row => row.status !== 'matched') ? 'needs-review' : 'matched', note: 'Manual ERP staging only. No order, invoice or payment was changed.' }, 'erp-import-recorded')
  }
  const report = async (user, input, context = {}) => {
    const to = date(input.to || now().slice(0, 10)), from = date(input.from || addDays(to, -6)); if (from > to) fail('Report start must be before its end.')
    const data = snapshot(user), inRange = record => { const day = (record.submittedAt || record.createdAt || '').slice(0, 10); return day >= from && day <= to }
    const quotes = data.quotes.filter(row => ['submitted', 'awarded'].includes(row.status) && inRange(row)), orders = data.orders.filter(inRange)
    const valueByCurrency = Object.entries(orders.reduce((totals, order) => { totals[order.currency] = (totals[order.currency] || 0) + cents(order.total); return totals }, {})).map(([currency, amount]) => ({ currency, value: amount / 100, citations: orders.filter(order => order.currency === currency).map(order => ref(user, 'orders', order.id, 'total')) }))
    const body = { from, to, quoteCount: quotes.length, orderCount: orders.length, valueByCurrency,
      quotes: quotes.map(row => ({ id: row.id, rfqId: row.rfqId, supplierName: row.supplierName, total: row.total, currency: row.currency, status: row.status, sourceRef: ref(user, 'quotes', row.id) })),
      orders: orders.map(row => ({ id: row.id, title: row.title, total: row.total, currency: row.currency, status: row.status, sourceRef: ref(user, 'orders', row.id) })),
      statement: 'Recorded activity only. Different currencies are never added together. This report does not assert savings, delivery acceptance or payments.' }
    return save(user, 'reports', { id: `report-${digest(body).slice(0, 24)}`, ...body }, 'report-created', context)
  }
  const execute = async (caller, action, input = {}, context = {}) => {
    const user = account(caller)
    if (!ctx.accounts.can(user, 'workspace:write')) fail('Your account has read-only workspace access.', 403)
    if (context.agent && !['evaluate', 'propose-prices', 'create-report'].includes(action)) fail('This private configuration needs human input.', 403)
    if (action === 'save-costs') { account(user, 'supplier'); const quote = quoteFor(user, input.quoteId), costs = buildCosts(quote, input); return { ok: true, costs: await save(user, 'costs', { id: `cost-${quote.id}`, ...costs, quoteRef: ref(user, 'quotes', quote.id), entered: clone(input.items) }, 'cost-model-saved') } }
    if (action === 'save-terms') { account(user, 'supplier'); const quote = quoteFor(user, input.quoteId); const result = await ctx.procurement.execute(user, 'save-quote', { ...quote, id: quote.id, commercial: input.commercial, currency: input.currency || quote.currency }); return { ...result, message: 'Commercial terms saved in the private draft. Review and submit it separately to share the declaration.' } }
    if (action === 'save-calendar') {
      account(user, 'supplier'); const workingDays = [...new Set(input.workingDays || [])].map(value => finite(value, 'Weekday', { max: 6, integer: true }))
      if (!workingDays.length) fail('Choose at least one working weekday; exceptions may still close a day.')
      const calendar = { id: 'calendar', unit: required(input.unit, 'Capacity unit'), unitsPerDay: finite(input.unitsPerDay, 'Daily capacity'), workingDays, source: required(input.source, 'Calendar source'),
        exceptions: (input.exceptions || []).map(row => ({ date: date(row.date), units: finite(row.units, 'Exception capacity') })) }
      if (new Set(calendar.exceptions.map(row => row.date)).size !== calendar.exceptions.length) fail('Each calendar exception date must appear once.')
      return { ok: true, calendar: await save(user, 'calendars', calendar, 'calendar-saved') }
    }
    if (action === 'save-plan') {
      account(user, 'supplier'); const quote = quoteFor(user, input.quoteId), calendar = get(user, 'calendars', 'calendar'), prior = input.id ? get(user, 'plans', input.id) : null
      if (prior && prior.quoteId !== quote.id) fail('A saved plan must keep its original quotation.')
      const reservations = list(user, 'plans').filter(row => !row.archived && row.id !== prior?.id)
      if (reservations.some(row => row.schedule.unit !== calendar.unit)) fail('Archive or update plans with a different capacity unit before scheduling.')
      const schedule = schedulePlan(calendar, input, reservations)
      return { ok: true, plan: await save(user, 'plans', { id: prior?.id || id('capacity-plan'), quoteId: quote.id, rfqId: quote.rfqId, binding: quote.commercial?.deliveryBinding || 'indicative', entered: clone(input), schedule, calendarRef: ref(user, collection('calendars'), calendar.id), quoteRef: ref(user, 'quotes', quote.id), reservationRefs: reservations.map(row => ref(user, collection('plans'), row.id)), archived: false }, 'capacity-plan-saved') }
    }
    if (action === 'archive-plan') { account(user, 'supplier'); return { ok: true, plan: await save(user, 'plans', { ...get(user, 'plans', input.id), archived: true }, 'capacity-plan-archived') } }
    if (action === 'save-fx') {
      const effectiveAt = required(input.effectiveAt, 'Rate effective time'), expiresAt = required(input.expiresAt, 'Rate expiry time')
      if (!Number.isFinite(Date.parse(effectiveAt)) || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) < Date.parse(effectiveAt)) fail('Enter valid effective and expiry timestamps.')
      return { ok: true, fx: await save(user, 'fx', { id: id('fx'), from: currency(input.from), to: currency(input.to), rate: finite(input.rate, 'Exchange rate', { min: 0.00000001, max: 1e6 }), effectiveAt: new Date(effectiveAt).toISOString(), expiresAt: new Date(expiresAt).toISOString(), source: required(input.source, 'Rate source') }, 'fx-recorded') }
    }
    if (action === 'save-reference') {
      const observedAt = required(input.observedAt, 'Reference observation time'); if (!Number.isFinite(Date.parse(observedAt))) fail('Enter a valid observation time.')
      const expiresAt = input.expiresAt ? new Date(input.expiresAt).toISOString() : null
      if (expiresAt && expiresAt < new Date(observedAt).toISOString()) fail('Reference expiry must follow its observation.')
      return { ok: true, reference: await save(user, 'references', { id: id('reference'), description: required(input.description, 'Item description'), unit: required(input.unit, 'Unit'), unitPrice: cents(input.unitPrice, 'Reference unit price') / 100, currency: currency(input.currency), observedAt: new Date(observedAt).toISOString(), expiresAt, source: required(input.source, 'Reference source'), kind: 'manual' }, 'reference-recorded') }
    }
    if (action === 'save-policy') { account(user, 'contractor'); const rfq = rfqFor(user, input.rfqId); return { ok: true, policy: await save(user, 'policies', { id: `policy-${rfq.id}`, rfqId: rfq.id, policy: validatePolicy(input.policy) }, 'policy-saved') } }
    if (action === 'save-assumptions') {
      account(user, 'contractor'); const quote = quoteFor(user, input.quoteId), commercial = ctx.procurement.normalizeCommercial({}, input.commercial, quote.items.map(row => row.id))
      return { ok: true, assumptions: await save(user, 'assumptions', { id: `assumption-${quote.id}`, rfqId: quote.rfqId, quoteId: quote.id, quoteRevision: quote.revision, commercial, source: required(input.source, 'Assumption source'), sourceQuoteRef: ref(user, 'quotes', quote.id) }, 'assumptions-recorded') }
    }
    if (action === 'evaluate') return evaluate(user, input, context)
    if (action === 'propose-prices') return propose(user, input, context)
    if (action === 'save-erp-mapping') return { ok: true, mapping: await saveMapping(user, input) }
    if (action === 'import-erp') return { ok: true, import: await importErp(user, input) }
    if (action === 'create-report') return { ok: true, report: await report(user, input, context) }
    fail('Choose an available commercial workbench action.', 404)
  }
  const exportCsv = (user, kind, recordId) => {
    user = account(user)
    if (kind === 'orders') return csv([['po_number', 'item_id', 'description', 'quantity', 'unit', 'unit_price', 'currency'], ...snapshot(user).orders.flatMap(order => order.items.map(item => [order.id, item.id, item.description, item.quantity, item.unit, item.unitPrice, order.currency]))])
    if (kind === 'evaluation') { account(user, 'contractor'); const evaluation = get(user, 'evaluations', recordId); return csv([['quote_id', 'supplier', 'currency', 'price', 'delivery', 'payment', 'warranty', 'deviation', 'tco', 'policy_score', 'rank', 'flags', 'source_sequences'], ...evaluation.rows.map(row => [row.quoteId, row.supplierName, row.currency, ...['price', 'delivery', 'payment', 'warranty', 'deviation'].map(key => row.amounts[key].value ?? 'unknown'), row.tco.value ?? 'unknown', row.score?.value ?? 'unknown', row.rank?.value ?? '', row.flags.map(flag => flag.message).join(' | '), row.tco.citations.map(ref => ref.seq).join(';')]), ...evaluation.excluded.map(row => [row.quoteId, row.supplierName, '', '', '', '', '', '', '', '', '', row.reason, row.citations.map(ref => ref.seq).join(';')])]) }
    if (kind === 'report') { const report = get(user, 'reports', recordId); return csv([['type', 'record_id', 'label', 'amount', 'currency', 'source_sequence'], ...report.quotes.map(row => ['quote', row.id, row.supplierName, row.total, row.currency, row.sourceRef.seq]), ...report.orders.map(row => ['order', row.id, row.title, row.total, row.currency, row.sourceRef.seq])]) }
    fail('Choose orders, evaluation or report CSV.')
  }
  return { state, execute, evaluate, propose, applyPrices, exportCsv, history }
}
