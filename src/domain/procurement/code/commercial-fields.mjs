// Public declarations, never inferred defaults. Percentages use percentage points;
// monetary figures use the quote currency's major unit with two decimal places.
const fail = message => { throw new Error(message) }
const date = (value, field) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value)) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) fail(`${field} must be a valid ISO date (YYYY-MM-DD).`)
  return value
}
const number = (value, field, { min = 0, max = 1e12, integer = false, money = false } = {}) => {
  if (!['number', 'string'].includes(typeof value) || typeof value === 'string' && !value.trim()) fail(`${field} must be an explicit number.`)
  const result = Number(value)
  if (!Number.isFinite(result) || result < min || result > max || integer && !Number.isInteger(result) || money && Math.abs(result * 100 - Math.round(result * 100)) > 1e-5) fail(`${field} has an invalid numeric value${integer ? '; use whole units' : money ? '; use at most two decimal places' : ''}.`)
  return result
}
const merge = (prior, input, fields) => {
  if (input === undefined) return structuredClone(prior || {})
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Commercial fields must be an object.')
  const result = { ...(prior || {}) }
  for (const [key, value] of Object.entries(input)) {
    if (!fields[key]) fail(`Unsupported commercial field: ${key}`)
    if (value === null || value === '') delete result[key]
    else result[key] = fields[key](value, key)
  }
  return result
}
const percentage = (value, field) => {
  const result = number(value, field, { max: 100 })
  if (Math.abs(result * 1e6 - Math.round(result * 1e6)) > 1e-5) fail(`${field} supports at most six decimal places.`)
  return result
}
const whole = (value, field) => number(value, field, { max: 36500, integer: true })
const enumOf = allowed => (value, field) => allowed.includes(value) ? value : fail(`Unsupported ${field}.`)
export const commercialFields = (prior, input, itemIds = []) => merge(prior, input, {
  taxMode: enumOf(['inclusive', 'exclusive', 'unspecified']), taxRate: percentage,
  freight: (value, field) => number(value, field, { money: true }), validityUntil: date,
  advancePercent: percentage, paymentDays: whole, warrantyMonths: whole, penaltyPercent: percentage,
  deliveryBinding: enumOf(['firm', 'indicative']),
  deviations: value => {
    if (!Array.isArray(value) || value.length > 200) fail('Provide at most 200 structured deviations.')
    return value.map(row => {
      if (!row || typeof row !== 'object' || !String(row.description || '').trim()) fail('Each deviation needs a description.')
      if (row.itemId && !itemIds.includes(row.itemId)) fail('A deviation must reference a quoted item or the whole quotation.')
      return { ...(row.itemId ? { itemId: row.itemId } : {}), ...(row.category ? {category:enumOf(['technical','commercial','schedule','scope'])(row.category,'deviation category')} : {}), description: String(row.description).trim(),
        ...(row.priceImpact !== undefined && row.priceImpact !== null && row.priceImpact !== '' ? { priceImpact: number(row.priceImpact, 'Deviation price impact', { min: -1e12, money: true }) } : {}),
        ...(row.timeImpactDays !== undefined && row.timeImpactDays !== null && row.timeImpactDays !== '' ? { timeImpactDays: number(row.timeImpactDays, 'Deviation time impact', { min: -36500, max: 36500, integer: true }) } : {}) }
    })
  },
})
export const requirementFields = (prior, input) => merge(prior, input, { deliveryBy: date, paymentDays: whole, warrantyMonths: whole, penaltyPercent: percentage })

export function quotationAmounts(subtotalCents, commercial = {}) {
  if (!Number.isSafeInteger(subtotalCents) || subtotalCents < 0) fail('Quotation subtotal is outside the supported amount range.')
  const taxKnown = commercial.taxMode === 'inclusive' || commercial.taxMode === 'exclusive' && commercial.taxRate !== undefined
  const taxCents = commercial.taxMode === 'exclusive' && commercial.taxRate !== undefined
    ? Number((BigInt(subtotalCents) * BigInt(Math.round(commercial.taxRate * 1e6)) + 50000000n) / 100000000n) : 0
  const freightCents = commercial.freight === undefined ? 0 : Math.round(commercial.freight * 100)
  const totalCents = subtotalCents + taxCents + freightCents
  if (!Number.isSafeInteger(totalCents)) fail('Quotation total is outside the supported amount range.')
  return { subtotal: subtotalCents / 100, total: totalCents / 100, priceBreakdown: {
    subtotal: subtotalCents / 100, taxMode: commercial.taxMode || 'unspecified', taxRate: commercial.taxRate ?? null,
    taxAmount: taxKnown ? taxCents / 100 : null, freightAmount: commercial.freight ?? null,
    totalComplete: taxKnown && commercial.freight !== undefined,
    basis: 'Line subtotal + declared exclusive tax on line subtotal + declared freight. Inclusive tax is already in item prices. Missing components remain unstated.' } }
}
