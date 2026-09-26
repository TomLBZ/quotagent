import { createHash } from 'node:crypto'
export const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }) }
export const text = value => String(value ?? '').trim()
export const required = (value, name) => text(value) || fail(`${name} is required.`)
export const clone = value => structuredClone(value)
export const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value
export const digest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
export const finite = (value, label, { min = 0, max = 1e12, integer = false } = {}) => {
  if (value === '' || value === null || value === undefined) fail(`${label} is required; enter zero explicitly if applicable.`)
  const number = Number(value)
  if (!Number.isFinite(number) || number < min || number > max || integer && !Number.isInteger(number)) fail(`Enter a valid ${label.toLowerCase()}.`)
  return number
}
export const cents = (value, label = 'Amount', { negative = false } = {}) => {
  const input = text(value)
  if (!(negative ? /^-?\d+(\.\d{1,2})?$/ : /^\d+(\.\d{1,2})?$/).test(input)) fail(`${label} needs at most two decimal places${negative ? '' : ' and cannot be negative'}.`)
  const sign = input.startsWith('-') ? -1n : 1n, [whole, fraction = ''] = input.replace('-', '').split('.')
  const result = Number(sign * (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))))
  if (!Number.isSafeInteger(result)) fail(`${label} is too large.`)
  return result
}
export const rounded = value => { if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) fail('Calculated amount is too large.'); return Math.round(value) }
export const money = value => rounded(value) / 100
export const quantity = (value, label = 'Quantity') => {
  if (!/^\d+(\.\d{1,6})?$/.test(text(value))) fail(`${label} needs a positive number with at most six decimal places.`)
  return finite(value, label, { min: 0.000001 })
}
export const multiply = (amount, factor) => {
  const raw = typeof factor === 'number' && Number.isFinite(factor) ? factor.toFixed(8).replace(/\.?0+$/, '') || '0' : text(factor)
  if (!/^\d+(\.\d{1,8})?$/.test(raw)) fail('Use a nonnegative factor with at most eight decimal places.')
  const [whole, fraction = ''] = raw.split('.'), scale = 10n ** BigInt(fraction.length)
  const sign = amount < 0 ? -1n : 1n, product = BigInt(Math.abs(amount)) * BigInt(whole + fraction)
  const result = Number(sign * ((product + scale / 2n) / scale))
  if (!Number.isSafeInteger(result)) fail('Calculated amount is too large.')
  return result
}
export const date = (value, label = 'Date') => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text(value)) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) fail(`${label} must be a valid YYYY-MM-DD date.`)
  return value
}
export const addDays = (value, days) => new Date(Date.parse(value + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10)
export const daysBetween = (from, to) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000)
export const currency = value => /^[A-Z]{3}$/.test(text(value).toUpperCase()) ? text(value).toUpperCase() : fail('Use a three-letter currency code.')
export const itemKey = item => `${text(item.description).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ')}|${text(item.unit).toLowerCase()}`
export const median = values => { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2 }
export const factors = ['material', 'labor', 'equipment', 'overhead', 'risk', 'tax', 'finance']

export function buildCosts(quote, input) {
  if (!Array.isArray(input.items) || !input.items.length) fail('Enter a cost breakdown for every quoted item.')
  if (new Set(input.items.map(row => row.itemId)).size !== input.items.length) fail('Each cost item must appear once.')
  const supplied = new Map(input.items.map(row => [row.itemId, row]))
  if (input.items.length !== quote.items.length) fail('The cost breakdown must match every quoted item.')
  const items = quote.items.map(item => {
    const row = supplied.get(item.id)
    if (!row) fail(`Enter costs for ${item.description}.`)
    const details = {}, qty = quantity(item.quantity), source = required(row.source, `Cost source for ${item.description}`)
    for (const key of factors) {
      if (['material', 'labor', 'equipment'].includes(key)) {
        const rate = cents(row[key], `${key} unit rate`)
        details[key] = { rate: rate / 100, base: qty, baseUnit: item.unit, amount: multiply(rate, qty) / 100, formula: 'unit rate × quantity', source }
      } else finite(row[key], `${key} percentage`, { max: 1000 })
    }
    const direct = ['material', 'labor', 'equipment'].reduce((sum, key) => sum + cents(details[key].amount), 0)
    const indirect = (key, base) => { const amount = rounded(base * Number(row[key]) / 100); details[key] = { rate: Number(row[key]), base: base / 100, baseUnit: quote.currency, amount: amount / 100, formula: 'base × percentage / 100', source }; return amount }
    const overhead = indirect('overhead', direct), base = direct + overhead
    const risk = indirect('risk', base), finance = indirect('finance', base), preTax = base + risk + finance, tax = indirect('tax', preTax)
    const total = preTax + tax
    return { itemId: item.id, description: item.description, unit: item.unit, quantity: qty, factors: details, preTax: preTax / 100, total: total / 100, unitCost: money(total / qty), source }
  })
  const total = items.reduce((sum, item) => sum + cents(item.total), 0)
  const quotedSubtotal = quote.subtotal ?? quote.items.reduce((sum, row) => sum + cents(row.total), 0) / 100
  return { quoteId: quote.id, quoteRevision: quote.revision, rfqId: quote.rfqId, rfqRevision: quote.rfqRevision, currency: quote.currency, items, total: total / 100,
    quotedTotal: quotedSubtotal, marginBasis: 'quoted item subtotal less fully burdened private cost', marginPercent: quotedSubtotal > 0 ? (cents(quotedSubtotal) - total) / cents(quotedSubtotal) * 100 : null }
}

export function proposePrices(quote, costs, marginPercent) {
  const margin = finite(marginPercent, 'Target margin', { min: -100, max: 95 })
  const items = costs.items.map(row => {
    const unitPrice = money(cents(row.total) / row.quantity / (1 - margin / 100))
    return { id: row.itemId, description: row.description, quantity: row.quantity, unit: row.unit, unitPrice, cost: row.unitCost,
      total: multiply(cents(unitPrice), row.quantity) / 100 }
  })
  const total = items.reduce((sum, row) => sum + cents(row.total), 0) / 100
  return { quoteId: quote.id, items, total, costTotal: costs.total, targetMarginPercent: margin,
    actualMarginPercent: total > 0 ? (cents(total) - cents(costs.total)) / cents(total) * 100 : null }
}

export function schedulePlan(calendar, input, reservations = []) {
  const startDate = date(input.startDate, 'Plan start'), targetDate = date(input.targetDate, 'Target delivery')
  if (targetDate < startDate) fail('Target delivery must be on or after the start date.')
  if (!Array.isArray(input.tasks) || !input.tasks.length || input.tasks.length > 60) fail('Add one to sixty capacity tasks.')
  const tasks = input.tasks.map((task, index) => ({ id: text(task.id) || `step-${index + 1}`, name: required(task.name, 'Task name'),
    effort: finite(task.effort, 'Required capacity'), minDays: finite(task.minDays, 'Minimum calendar days', { min: 1, max: 730, integer: true }),
    dependsOn: Array.isArray(task.dependsOn) ? [...new Set(task.dependsOn.map(text).filter(Boolean))] : text(task.dependsOn).split(',').map(text).filter(Boolean),
    ...(task.dueDate ? { dueDate: date(task.dueDate, 'Milestone date') } : {}) }))
  if (new Set(tasks.map(task => task.id)).size !== tasks.length) fail('Task identifiers must be unique.')
  const ids = new Set(tasks.map(task => task.id))
  if (tasks.some(task => task.dependsOn.some(id => !ids.has(id) || id === task.id))) fail('Dependencies must name other tasks in this plan.')
  const used = new Map(), allocation = new Map(), scheduled = new Map(), workingDays = new Set(calendar.workingDays)
  for (const prior of reservations) for (const row of prior.schedule?.allocations || []) used.set(row.date, (used.get(row.date) || 0) + row.units)
  const exceptions = new Map((calendar.exceptions || []).map(row => [row.date, row.units]))
  const capacity = day => exceptions.has(day) ? exceptions.get(day) : workingDays.has(new Date(day + 'T00:00:00Z').getUTCDay()) ? calendar.unitsPerDay : 0
  const ordered = []
  while (ordered.length < tasks.length) {
    const ready = tasks.find(task => !scheduled.has(task.id) && task.dependsOn.every(id => scheduled.has(id)))
    if (!ready) fail('Task dependencies contain a cycle.')
    const earliest = ready.dependsOn.reduce((latest, id) => { const next = addDays(scheduled.get(id).finishDate, 1); return next > latest ? next : latest }, startDate)
    let remaining = ready.effort, finishDate = addDays(earliest, ready.minDays - 1), effortFinish = earliest
    for (let offset = 0; remaining > 0.000001 && offset < 730; offset++) {
      const day = addDays(earliest, offset), available = Math.max(0, capacity(day) - (used.get(day) || 0)), amount = Math.min(remaining, available)
      if (amount) { used.set(day, (used.get(day) || 0) + amount); allocation.set(day, (allocation.get(day) || 0) + amount); remaining -= amount; effortFinish = day }
    }
    if (remaining > 0.000001) fail(`No sufficient declared capacity within two years for ${ready.name}. Add availability or reduce required work.`)
    if (effortFinish > finishDate) finishDate = effortFinish
    const result = { ...ready, startDate: earliest, finishDate, late: !!ready.dueDate && finishDate > ready.dueDate }
    scheduled.set(ready.id, result); ordered.push(result)
  }
  const finishDate = ordered.reduce((latest, task) => task.finishDate > latest ? task.finishDate : latest, startDate)
  const criticalPath = []
  let last = [...ordered].sort((a, b) => b.finishDate.localeCompare(a.finishDate) || a.id.localeCompare(b.id))[0]
  while (last) { criticalPath.unshift(last.id); last = last.dependsOn.map(id => scheduled.get(id)).sort((a, b) => b.finishDate.localeCompare(a.finishDate) || a.id.localeCompare(b.id))[0] }
  const flags = ordered.filter(task => task.late).map(task => ({ kind: 'milestone-conflict', message: `${task.name} finishes ${task.finishDate}, after its ${task.dueDate} milestone.`, taskId: task.id }))
  if (finishDate > targetDate) flags.push({ kind: 'capacity-conflict', message: `Declared availability and task dependencies finish ${finishDate}, after target ${targetDate}.` })
  return { startDate, targetDate, finishDate, criticalPath, tasks: ordered, allocations: [...allocation].sort(([a], [b]) => a.localeCompare(b)).map(([day, units]) => ({ date: day, units: Math.round(units * 1e6) / 1e6 })),
    feasible: flags.length === 0, flags, unit: calendar.unit, required: tasks.reduce((sum, task) => sum + task.effort, 0), assumption: 'Calendar availability is user-declared; this check does not change a quoted delivery date.' }
}

export function describeHistory(rows) {
  const groups = new Map()
  for (const row of rows) {
    const key = `${row.supplierId}|${itemKey(row)}|${row.currency}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, entries]) => {
    const ordered = [...entries].sort((a, b) => a.at.localeCompare(b.at) || a.quoteId.localeCompare(b.quoteId)), prices = ordered.map(row => row.unitPrice).filter(value => typeof value === 'number' && Number.isFinite(value)), leads = ordered.map(row => row.leadDays).filter(value => typeof value === 'number' && Number.isFinite(value))
    return { key, supplierId: entries[0].supplierId, supplierName: entries[0].supplierName, description: entries[0].description, unit: entries[0].unit, currency: entries[0].currency,
      count: prices.length, quoteCount: new Set(entries.map(row => `${row.quoteId}:${row.revision}`)).size, min: prices.length ? Math.min(...prices) : null, median: median(prices), max: prices.length ? Math.max(...prices) : null,
      latest: prices.at(-1) ?? null, trend: prices.length < 2 ? 'insufficient history' : prices.at(-1) > prices[0] ? 'up' : prices.at(-1) < prices[0] ? 'down' : 'flat',
      averageLeadDays: leads.length ? leads.reduce((sum, value) => sum + value, 0) / leads.length : null, deviationCount: entries.filter(row => row.hasDeviation).length,
      entries: ordered, notice: 'Read-only descriptive statistics. No rating, ranking or decision score.' }
  })
}

export const csv = rows => '\uFEFF' + rows.map(row => row.map(value => {
  let raw = String(value ?? '')
  if (/^[=+@\-\t\r]/.test(raw)) raw = "'" + raw
  return '"' + raw.replaceAll('"', '""') + '"'
}).join(',')).join('\r\n') + '\r\n'
