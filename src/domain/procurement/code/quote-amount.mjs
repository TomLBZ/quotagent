const fail = (message, status = 400, code = 'QUOTE_AMOUNT_INPUT') => {
  throw Object.assign(new Error(message), { status, code })
}

const decimal = (value, places, label) => {
  if (!['string', 'number'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) fail(`${label} must be an explicit decimal number.`)
  const text = String(value).trim()
  if (!new RegExp(`^\\d+(?:\\.\\d{1,${places}})?$`).test(text) || text.length > 30) fail(`${label} must be nonnegative with at most ${places} decimal places.`)
  const [whole, fraction = ''] = text.split('.')
  return { units: BigInt(whole + fraction), scale: 10n ** BigInt(fraction.length), text: `${BigInt(whole)}${fraction.replace(/0+$/, '') ? `.${fraction.replace(/0+$/, '')}` : ''}` }
}
const money = units => `${units / 100n}.${String(units % 100n).padStart(2, '0')}`

export function quoteAmountTool({ procurement, store }) {
  return {
    name: 'calculate_quote_amount', effect: 'read', roles: ['contractor', 'supplier'],
    description: 'Calculate an exact percentage of a current authorized quotation total. Read procurement_workspace first for quoteId and quote revision; supply a percentage explicitly stated by the user or source. The stored total is loaded by the tool. Returns source-bound illustrative amount and exact remainder, not an agreed deposit or payment schedule. Never guess a rate or do quotation percentage arithmetic in prose.',
    parameters: { type: 'object', additionalProperties: false, required: ['quoteId', 'quoteRevision', 'percentage'], properties: {
      quoteId: { type: 'string', description: 'Authorized source quotation ID from procurement_workspace.' },
      quoteRevision: { type: 'integer', minimum: 1, description: 'Current quotation revision (quote.revision), not the RFQ revision.' },
      percentage: { type: 'string', description: 'Explicit decimal percentage from 0 to 100, up to six decimal places; e.g. "30" or "12.5". Never infer an unstated percentage.' },
    } },
    execute(user, input = {}) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['quoteId', 'quoteRevision', 'percentage'].includes(key))) fail('Only quoteId, quoteRevision and percentage are accepted. The calculation base must come from the stored quotation.')
      const data = procurement.snapshot(user)
      const quote = data.quotes.find(row => row.id === input.quoteId)
      if (!quote) fail('That quotation is not available in this workspace.', 404, 'QUOTE_AMOUNT_UNAVAILABLE')
      if (!Number.isSafeInteger(input.quoteRevision) || input.quoteRevision < 1) fail('Read the quotation and supply its current quotation revision.')
      if (quote.revision !== input.quoteRevision || quote.stale || ['superseded', 'withdrawn'].includes(quote.status)) fail('This quotation or its request scope changed. Read the current quotation and revision before calculating.', 409, 'QUOTE_AMOUNT_STALE')
      const percent = decimal(input.percentage, 6, 'Percentage')
      if (percent.units > 100n * percent.scale) fail('Percentage must be from 0 to 100 inclusive.')
      const base = decimal(quote.total, 2, 'Stored quotation total')
      const total = base.units * 100n / base.scale
      const denominator = 100n * percent.scale
      const amount = (total * percent.units + denominator / 2n) / denominator
      const remainder = total - amount
      const event = store.events(data.realmId).findLast(row => row.body?.collection === 'quotes' && row.body.record?.id === quote.id)
      if (!event || event.body.record.revision !== quote.revision || event.body.record.total !== quote.total || event.body.record.currency !== quote.currency) fail('The quotation source cannot be resolved to its current ledger record. Refresh the workspace before calculating.', 409, 'QUOTE_AMOUNT_SOURCE')
      const source = { quoteId: quote.id, quoteRevision: quote.revision, rfqId: quote.rfqId, rfqRevision: quote.rfqRevision,
        ref: { realm: data.realmId, seq: event.seq, hash: event.entry_hash } }
      return { currency: quote.currency, base: money(total), percentage: percent.text, amount: money(amount), remainder: money(remainder),
        baseMinorUnits: String(total), amountMinorUnits: String(amount), remainderMinorUnits: String(remainder), scale: 2, rounding: 'half-up',
        interpretation: 'illustrative-calculation', source,
        summary: `${percent.text}% of ${quote.currency} ${money(total)} is ${quote.currency} ${money(amount)}; the remainder is ${quote.currency} ${money(remainder)}. Derived from quotation revision ${quote.revision}; this calculation does not establish an agreed deposit or payment schedule.`,
        action: { action: 'navigate', label: 'View source quotation', input: { view: 'quotes', workspaceId: data.realmId, quoteId: quote.id, rfqId: quote.rfqId } },
      }
    },
  }
}
