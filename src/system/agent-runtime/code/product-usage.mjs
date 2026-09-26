/** Token statistics are a projection of account ledgers, never an estimated bill. */
export const name = 'product-usage'
export const inject = ['store', 'web', 'accounts']
export const provides = ['usage']
export const tokenFields = ['input', 'output', 'total', 'cachedInput', 'uncachedInput', 'cacheWriteInput', 'reasoningOutput']
const statuses = ['completed', 'failed', 'canceled', 'pending']
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }) }
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null
const first = (...values) => values.map(count).find(value => value !== null) ?? null
const text = (value, fallback = 'unknown') => String(value || fallback).slice(0, 200)
const instant = (value, fallback = null) => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : fallback
const dateOf = value => value?.slice(0, 10)
const purposeOf = value => {
  if (String(value).startsWith('workflow:')) {
    const phase = String(value).split(':').at(-1)
    return `workflow:${['planner', 'agent', 'report', 'synthesis'].includes(phase) ? phase : 'other'}`
  }
  return text(value)
}
export const normalizeUsage = (usage = {}) => ({
  input: first(usage?.prompt_tokens, usage?.input_tokens),
  output: first(usage?.completion_tokens, usage?.output_tokens),
  total: count(usage?.total_tokens),
  cachedInput: first(usage?.prompt_tokens_details?.cached_tokens, usage?.prompt_cache_hit_tokens, usage?.input_tokens_details?.cached_tokens),
  uncachedInput: count(usage?.prompt_cache_miss_tokens),
  cacheWriteInput: first(usage?.prompt_tokens_details?.cache_write_tokens, usage?.input_tokens_details?.cache_write_tokens),
  reasoningOutput: first(usage?.completion_tokens_details?.reasoning_tokens, usage?.output_tokens_details?.reasoning_tokens),
})
const normalizedCounts = tokens => Object.fromEntries(tokenFields.map(key => [key, count(tokens?.[key])]))

export function projectUsage(events, accountId) {
  const calls = new Map(), metadata = new Map()
  for (const event of events) {
    if (!['agent/model-requested', 'agent/model-completed', 'agent/model-failed', 'agent/model-usage'].includes(event.type)) continue
    const body = event.body || {}, id = body.callId
    if (typeof id !== 'string' || !id) continue
    if (event.type === 'agent/model-usage') { metadata.set(id, body); continue }
    const call = calls.get(id) || { callId: id, accountId, provider: 'unknown', model: 'unknown', purpose: 'unknown', status: 'pending', startedAt: instant(event.ts), finishedAt: null, tokens: normalizeUsage() }
    if (event.type === 'agent/model-requested') {
      call.provider = text(body.provider); call.model = text(body.request?.model)
      call.purpose = purposeOf(body.purpose); call.startedAt = instant(event.ts, call.startedAt)
    } else if (event.type === 'agent/model-completed') {
      call.tokens = normalizeUsage(body.response?.usage)
      call.model = text(body.response?.model, call.model); call.status = 'completed'; call.finishedAt = instant(event.ts)
    } else {
      call.status = body.canceled === true || body.status === 'canceled' ? 'canceled' : 'failed'
      call.finishedAt = instant(event.ts)
    }
    calls.set(id, call)
  }
  for (const [id, body] of metadata) {
    const old = calls.get(id)
    calls.set(id, { callId: id, accountId, provider: text(body.provider, old?.provider), model: text(body.model, old?.model),
      purpose: purposeOf(body.purpose || old?.purpose), status: statuses.includes(body.status) ? body.status : old?.status || 'pending',
      startedAt: instant(body.startedAt, old?.startedAt), finishedAt: instant(body.finishedAt, old?.finishedAt),
      tokens: normalizedCounts(body.tokens),cost:body.cost||null,runId:body.runId||null,attempts:count(body.attempts),stopReason:body.stopReason||null,usageCoverage:body.usageCoverage||null })
  }
  return [...calls.values()].map(call => ({ ...call, date: dateOf(call.startedAt),
    durationMs: call.startedAt && call.finishedAt ? Math.max(0, Date.parse(call.finishedAt) - Date.parse(call.startedAt)) : null }))
}

const summarize = calls => ({
  costs: [...new Set(calls.map(call=>call.cost?.currency).filter(Boolean))].map(currency=>({currency,amountMicros:calls.filter(call=>call.cost?.currency===currency&&call.cost?.amountMicros!==null).reduce((sum,call)=>sum+(call.cost?.amountMicros||0),0),pricedCalls:calls.filter(call=>call.cost?.currency===currency&&Number.isSafeInteger(call.cost?.amountMicros)).length,unknownCalls:calls.filter(call=>!Number.isSafeInteger(call.cost?.amountMicros)).length})),unknownCostCalls:calls.filter(call=>!Number.isSafeInteger(call.cost?.amountMicros)).length,
  calls: calls.length,
  reportedCalls: calls.filter(call => call.tokens.total !== null).length,
  unknownCalls: calls.filter(call => call.tokens.total === null).length,
  statuses: Object.fromEntries(statuses.map(status => [status, calls.filter(call => call.status === status).length])),
  tokens: Object.fromEntries(tokenFields.map(key => {
    const known = calls.filter(call => call.tokens[key] !== null)
    return [key, { value: known.length ? known.reduce((sum, call) => sum + call.tokens[key], 0) : null, knownCalls: known.length, unknownCalls: calls.length - known.length }]
  })),
})
const group = (calls, key) => {
  const groups = new Map()
  for (const call of calls) { const value = call[key] || 'unknown'; if (!groups.has(value)) groups.set(value, []); groups.get(value).push(call) }
  return [...groups].map(([value, rows]) => ({ key: value, ...summarize(rows) })).sort((a, b) => a.key.localeCompare(b.key))
}
const day = (value, fallback) => {
  if (!value) return fallback
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || dateOf(instant(`${value}T00:00:00Z`)) !== value) fail('Choose a valid UTC date.')
  return value
}

export function apply(ctx) {
  const record = async (user, value) => {
    if (!user?.id || !value?.callId) fail('Usage needs an account and call identifier.')
    if (!statuses.slice(0, 3).includes(value.status)) fail('Usage needs a terminal provider status.')
    const body = { schema: 'quotagent/model-usage/v1', callId: text(value.callId), provider: text(value.provider), model: text(value.model),
      purpose: purposeOf(value.purpose), status: value.status, startedAt: instant(value.startedAt),
      finishedAt: instant(value.finishedAt, new Date().toISOString()), tokens: value.tokens?normalizedCounts(value.tokens):normalizeUsage(value.usage),cost:value.cost||null,runId:value.runId||null,attempts:count(value.attempts),stopReason:value.stopReason||null,usageCoverage:value.usageCoverage||null }
    await ctx.store.append(user.id, 'agent/model-usage', body, { actor: `agent:${user.id}` })
    return body
  }
  const stats = (user, input = {}) => {
    const account = user?.id && ctx.accounts.get(user.id)
    if (!account || account.disabled) fail('Please sign in.', 401)
    const scope = input.scope || 'mine'
    if (!['mine', 'all'].includes(scope)) fail('Choose your account or all accounts.')
    if ((scope === 'all' || input.accountId) && account.role !== 'admin') fail('Only administrators can view aggregate account usage.', 403)
    if (input.accountId && scope !== 'all') fail('Select all accounts before filtering an account.')
    const today = new Date().toISOString().slice(0, 10), monthAgo = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10)
    const filters = { scope, from: day(input.from, monthAgo), to: day(input.to, today), provider: input.provider || '', model: input.model || '', purpose: input.purpose || '', status: input.status || '', accountId: input.accountId || '' }
    if (filters.from > filters.to) fail('Start date must be on or before end date.')
    if (filters.status && !statuses.includes(filters.status)) fail('Choose a valid call status.')
    const accounts = scope === 'all' ? ctx.accounts.list() : [account]
    if (filters.accountId && !accounts.some(row => row.id === filters.accountId)) fail('Account not found.', 404)
    const unavailableAccounts=[]
    const range = accounts.flatMap(owner => {try{return projectUsage(ctx.store.events(owner.id), owner.id)}catch(error){if(scope!=='all'||error.status!==503)throw error;unavailableAccounts.push({accountId:owner.id,name:owner.name||owner.id,code:error.code||'LEDGER_UNAVAILABLE'});return[]}})
      .filter(call => call.date && call.date >= filters.from && call.date <= filters.to)
    const rows = range.filter(call => ['provider', 'model', 'purpose', 'status', 'accountId'].every(key => !filters[key] || call[key] === filters[key]))
    const options = Object.fromEntries(['provider', 'model', 'purpose', 'status'].map(key => [key, [...new Set(range.map(call => call[key]))].sort()]))
    if (scope === 'all') options.accounts = accounts.map(({ id, name, email }) => ({ id, name: name || email || id }))
    return { coverage:{complete:!unavailableAccounts.length,unavailableAccounts},filters, summary: summarize(rows), daily: group(rows, 'date'), byModel: group(rows, 'model'), byProvider: group(rows, 'provider'),
      byPurpose: group(rows, 'purpose'), byStatus: group(rows, 'status'), ...(scope === 'all' ? { byAccount: group(rows, 'accountId') } : {}),
      calls: rows.sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || '')).slice(0, 200), options,
      updatedAt: new Date().toISOString(), timeZone: 'UTC', recentLimit: 200 }
  }
  ctx.provide('usage', { record, stats })
  ctx.effect(() => ctx.web.route('GET', '/usage', ({ user, query }) => stats(user, Object.fromEntries(query))))
  ctx.effect(() => ctx.web.contribute({ id: 'ai-usage', label: 'AI usage', icon: 'spark', roles: ['contractor', 'supplier', 'admin'], order: 65 }))
}
