import { cents, money, multiply, finite, text, digest, median, itemKey, daysBetween } from './arithmetic.mjs'
export const components = ['price', 'delivery', 'payment', 'warranty', 'deviation']
export const defaultPolicy = { weights: { price: 60, delivery: 15, payment: 10, warranty: 5, deviation: 10 }, allowedLeadDays: 30, timeCostPerDay: 800,
  capitalRatePercent: 8, warrantyMonths: 12, warrantyCostPerMonth: 2000, paymentDays: 30, maxAdvancePercent: 30, penaltyPercent: 0, lowPricePercent: 60 }
const stated = value => value !== undefined && value !== null && value !== ''
const unique = refs => [...new Map(refs.filter(Boolean).map(ref => [JSON.stringify(ref), ref])).values()]
const measure = (value, citations, formula, inputs = {}) => ({ value, citations: unique(citations), formula, inputs })

export function calculateEvaluation(basis) {
  const { rfq, quotes, policy, asOf, currency, sources, fx = [], references = [], assumptions = {} } = basis
  const asOfDate = asOf.slice(0, 10), asOfTime = Date.parse(asOf)
  const policyRefs = [sources.policy], rfqRefs = [sources.rfq]
  const rows = [], excluded = []
  for (const quote of [...quotes].sort((a, b) => a.id.localeCompare(b.id))) {
    const quoteRefs = [sources.quotes[quote.id]], common = [...quoteRefs, ...rfqRefs, ...policyRefs]
    if (quote.stale || quote.rfqRevision !== (rfq.publishedRevision || rfq.revision)) {
      excluded.push({ quoteId: quote.id, supplierName: quote.supplierName, reason: 'RFQ revision mismatch. Request a reviewed rebid against the current scope.', quoteRevision: quote.rfqRevision, currentRevision: rfq.publishedRevision || rfq.revision, citations: unique([...quoteRefs, ...rfqRefs]) }); continue
    }
    const savedAssumption = assumptions[quote.id], operator = savedAssumption?.quoteRevision === quote.revision ? savedAssumption : null, terms = { ...(quote.commercial || {}), ...(operator?.commercial || {}) }
    const termRefs = unique([...quoteRefs, operator?.sourceRef]), flags = [], missing = [], amounts = {}
    const addFlag = (kind, message, citations = common) => flags.push({ kind, message, citations: unique(citations) })
    const markMissing = (name, target) => { missing.push(name); addFlag('missing-term', `${name} was not declared or supplied as a sourced assumption.`, target || termRefs) }
    if (savedAssumption && !operator) addFlag('stale-assumptions', 'Saved assumptions refer to an older quotation revision and were not applied.', [savedAssumption.sourceRef, ...quoteRefs])
    const activeRate = quote.currency === currency ? null : fx.filter(row => row.from === quote.currency && row.to === currency && Date.parse(row.effectiveAt) <= asOfTime && Date.parse(row.expiresAt) >= asOfTime).sort((a, b) => b.effectiveAt.localeCompare(a.effectiveAt) || a.id.localeCompare(b.id))[0]
    const convert = value => quote.currency === currency ? value : activeRate ? multiply(value, activeRate.rate) : null
    const priceRefs = unique([...quoteRefs, ...termRefs, activeRate?.sourceRef])
    if (quote.currency !== currency && !activeRate) markMissing(`Current ${quote.currency}/${currency} exchange rate`, [...quoteRefs, ...policyRefs])
    const lineItems = quote.items.map(item => ({ id: item.id, description: item.description, quantity: item.quantity, unit: item.unit, unitPrice: item.unitPrice, total: item.total,
      citations: quoteRefs.map(ref => ({ ...ref, path: `items/${item.id}` })) }))
    const taxKnown = ['inclusive', 'exclusive'].includes(terms.taxMode) && (terms.taxMode !== 'exclusive' || stated(terms.taxRate))
    if (!taxKnown) markMissing('Tax treatment')
    if (!stated(terms.freight)) markMissing('Freight charge')
    const quoted = quote.subtotal !== undefined ? cents(quote.subtotal) : quote.items.reduce((sum, item) => sum + cents(item.total), 0), tax = terms.taxMode === 'exclusive' && stated(terms.taxRate) ? Math.round(quoted * terms.taxRate / 100) : 0
    const knownSubtotal = quoted + tax + (stated(terms.freight) ? cents(terms.freight) : 0), normalized = convert(knownSubtotal)
    amounts.price = measure(taxKnown && stated(terms.freight) && normalized !== null ? normalized / 100 : null, priceRefs,
      'quoted line total + exclusive tax on line total + freight; convert once to analysis currency', { quotedSubtotal: quoted / 100, taxMode: terms.taxMode ?? null, taxRate: terms.taxRate ?? null, taxAmount: taxKnown ? tax / 100 : null, freight: terms.freight ?? null, fxRate: quote.currency === currency ? 1 : activeRate?.rate ?? null })
    const allowedLead = stated(rfq.requirements?.deliveryBy) ? Math.max(0, daysBetween(asOfDate, rfq.requirements.deliveryBy)) : policy.allowedLeadDays
    const late = Math.max(0, quote.leadDays - allowedLead)
    amounts.delivery = measure(money(late * cents(policy.timeCostPerDay)), common, 'max(0, quoted lead days − allowed lead days) × policy daily cost', { quotedLeadDays: quote.leadDays, allowedLeadDays: allowedLead, costPerDay: policy.timeCostPerDay })
    if (late) addFlag('delivery-conflict', `Quoted delivery is ${late} days beyond the selected requirement.`)
    if (!stated(terms.advancePercent)) markMissing('Advance percentage')
    if (!stated(terms.paymentDays)) markMissing('Net payment days')
    amounts.payment = measure(amounts.price.value !== null && stated(terms.advancePercent) && stated(terms.paymentDays) ? money(cents(amounts.price.value) * (1 - terms.advancePercent / 100) * terms.paymentDays / 365 * policy.capitalRatePercent / 100) : null,
      [...priceRefs, ...termRefs, ...policyRefs], 'policy financing exposure = normalized price × (1 − advance fraction) × net days / 365 × annual capital rate', { advancePercent: terms.advancePercent ?? null, paymentDays: terms.paymentDays ?? null, capitalRatePercent: policy.capitalRatePercent })
    const requiredPayment = rfq.requirements?.paymentDays ?? policy.paymentDays
    if (stated(terms.paymentDays) && terms.paymentDays < requiredPayment) addFlag('payment-conflict', `Net payment ${terms.paymentDays} days is shorter than the requested ${requiredPayment} days.`, [...common, ...termRefs])
    if (stated(terms.advancePercent) && terms.advancePercent > policy.maxAdvancePercent) addFlag('advance-conflict', `Advance payment ${terms.advancePercent}% exceeds the selected ${policy.maxAdvancePercent}% threshold.`, [...termRefs, ...policyRefs])
    const requiredWarranty = rfq.requirements?.warrantyMonths ?? policy.warrantyMonths
    if (!stated(terms.warrantyMonths)) markMissing('Warranty months')
    amounts.warranty = measure(stated(terms.warrantyMonths) ? money(Math.max(0, requiredWarranty - terms.warrantyMonths) * cents(policy.warrantyCostPerMonth)) : null,
      [...common, ...termRefs], 'max(0, required months − offered warranty months) × policy cost per month', { requiredMonths: requiredWarranty, offeredMonths: terms.warrantyMonths ?? null, costPerMonth: policy.warrantyCostPerMonth })
    if (stated(terms.warrantyMonths) && terms.warrantyMonths < requiredWarranty) addFlag('warranty-conflict', `Warranty ${terms.warrantyMonths} months is below the required ${requiredWarranty} months.`, [...common, ...termRefs])
    const requiredPenalty = rfq.requirements?.penaltyPercent ?? policy.penaltyPercent
    if (!stated(terms.penaltyPercent)) markMissing('Penalty percentage')
    else if (terms.penaltyPercent < requiredPenalty) addFlag('penalty-conflict', `Offered penalty ${terms.penaltyPercent}% is below the selected ${requiredPenalty}% requirement.`, [...common, ...termRefs])
    const deviations = Array.isArray(terms.deviations) ? terms.deviations : null
    if (!deviations) markMissing('Deviation declaration')
    const quantified = deviations?.filter(row => stated(row.priceImpact)) || [], unquantified = deviations?.filter(row => !stated(row.priceImpact)) || []
    const impact = convert(quantified.reduce((sum, row) => sum + cents(row.priceImpact, 'Deviation impact', { negative: true }), 0))
    amounts.deviation = measure(deviations && impact !== null ? impact / 100 : null, [...termRefs, activeRate?.sourceRef], 'sum of explicitly quantified deviation impacts, converted to analysis currency', { quantified, unquantified })
    for (const deviation of unquantified) addFlag('unquantified-deviation', `Impact not quantified: ${deviation.description}`, termRefs)
    if (terms.validityUntil && terms.validityUntil < asOfDate) addFlag('expired-quote', `Quotation validity ended ${terms.validityUntil}.`, termRefs)
    else if (!terms.validityUntil) markMissing('Quotation validity date')
    const quotedIds = new Set(quote.items.map(item => item.id)), missingLines = rfq.items.filter(item => !quotedIds.has(item.id))
    if (missingLines.length) addFlag('missing-lines', `Unpriced scope: ${missingLines.map(item => item.description).join('; ')}.`)
    for (const line of quote.items) {
      const reference = references.filter(ref => itemKey(ref) === itemKey(line) && ref.currency === quote.currency && Date.parse(ref.observedAt) <= asOfTime && (!ref.expiresAt || Date.parse(ref.expiresAt) >= asOfTime)).sort((a, b) => b.observedAt.localeCompare(a.observedAt) || a.id.localeCompare(b.id))[0]
      if (reference && line.unitPrice < reference.unitPrice * policy.lowPricePercent / 100) addFlag('reference-price-anomaly', `${line.description}: ${line.unitPrice} ${quote.currency}/${line.unit} is below ${policy.lowPricePercent}% of sourced reference ${reference.unitPrice}.`, [...quoteRefs.map(ref => ({ ...ref, path: `items/${line.id}/unitPrice` })), reference.sourceRef, ...policyRefs])
    }
    const knownTco = components.reduce((sum, key) => sum + (amounts[key].value === null ? 0 : cents(amounts[key].value, key, { negative: true })), 0)
    rows.push({ quoteId: quote.id, supplierId: quote.supplierId, supplierName: quote.supplierName, currency, originalCurrency: quote.currency, quoteRevision: quote.revision, rfqRevision: quote.rfqRevision,
      items: lineItems, amounts, knownSubtotal: measure(normalized === null ? null : normalized / 100, priceRefs, 'Known declared price components only; missing charges are not assumed zero'),
      tco: measure(components.every(key => amounts[key].value !== null) ? knownTco / 100 : null, unique(components.flatMap(key => amounts[key].citations)), 'sum of the five monetary components; unquantified deviation impacts remain excluded'),
      quantifiedSubtotal: measure(knownTco / 100, unique(components.flatMap(key => amounts[key].citations)), 'sum of known monetary components only'),
      assumptions: operator ? { source: operator.source, commercial: operator.commercial, citations: [operator.sourceRef] } : null, missing, unquantifiedDeviations: unquantified, flags, score: null, rank: null })
  }
  const comparable = rows.filter(row => components.every(key => !policy.weights[key] || row.amounts[key].value !== null))
  const priceMedian = median(rows.map(row => row.amounts.price.value).filter(value => value !== null))
  for (const row of rows) if (priceMedian !== null && row.amounts.price.value !== null && row.amounts.price.value < priceMedian * policy.lowPricePercent / 100)
    row.flags.push({ kind: 'relative-price-anomaly', message: `Normalized price is below ${policy.lowPricePercent}% of this received quote set's median. Confirm scope.`, citations: unique([...rows.flatMap(other => other.amounts.price.citations), ...policyRefs]) })
  for (const row of comparable) {
    const contributions = components.map(key => {
      const values = comparable.map(other => other.amounts[key].value).filter(value => value !== null), low = values.length ? Math.min(...values) : null, high = values.length ? Math.max(...values) : null
      const normalized = !policy.weights[key] || low === high ? 0 : (row.amounts[key].value - low) / (high - low)
      return { component: key, weight: policy.weights[key], normalized, contribution: normalized * policy.weights[key], citations: unique([...comparable.flatMap(other => other.amounts[key].citations), ...policyRefs]) }
    })
    row.score = measure(contributions.reduce((sum, value) => sum + value.contribution, 0), unique(contributions.flatMap(value => value.citations)), 'sum of component min/max normalized value × percentage weight; lower is preferred under this policy', { contributions })
  }
  comparable.sort((a, b) => a.score.value - b.score.value || a.quoteId.localeCompare(b.quoteId)).forEach((row, index) => { row.rank = measure(index + 1, row.score.citations, 'ascending policy score; exact ties ordered by quote ID') })
  const result = { formulaVersion: 'commercial-tco/1', rfqId: rfq.id, rfqRevision: rfq.publishedRevision || rfq.revision, currency, asOf, weights: policy.weights, rows, excluded,
    warning: 'Decision support only. Flags do not veto or change scores. Missing terms and unquantified impacts remain visible. Supplier history does not contribute to scoring.' }
  return { id: `evaluation-${digest({ basis, result }).slice(0, 24)}`, ...result }
}

export function validatePolicy(input) {
  const policy = { weights: {} }
  for (const key of components) policy.weights[key] = finite(input.weights?.[key], `${key} weight`, { max: 100 })
  if (Math.abs(Object.values(policy.weights).reduce((sum, value) => sum + value, 0) - 100) > 0.000001) throw new Error('Comparison weights must add up to 100%.')
  for (const key of ['allowedLeadDays', 'warrantyMonths', 'paymentDays']) policy[key] = finite(input[key], key, { max: 36500, integer: true })
  for (const key of ['timeCostPerDay', 'warrantyCostPerMonth']) policy[key] = cents(input[key], key) / 100
  for (const key of ['capitalRatePercent', 'maxAdvancePercent', 'penaltyPercent', 'lowPricePercent']) policy[key] = finite(input[key], key, { max: 100 })
  policy.source = text(input.source) || 'Human-selected analysis policy'
  return policy
}
