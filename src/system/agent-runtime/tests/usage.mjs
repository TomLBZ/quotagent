import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import * as store from '../../workspace-store/code/index.mjs'
import * as settings from '../../settings/code/index.mjs'
import * as provider from '../code/product-ai.mjs'
import * as usage from '../code/product-usage.mjs'
const require = createRequire(new URL('../../../../host/package.json', import.meta.url)), { Context } = require('cordis')
const users = [{ id: 'usage-buyer', name: 'Buyer', role: 'contractor' }, { id: 'usage-supplier', name: 'Supplier', role: 'supplier' }, { id: 'usage-admin', name: 'Admin', role: 'admin' }]
const [buyer, supplier, admin] = users, today = new Date().toISOString().slice(0, 10), range = { from: today, to: today }
const reported = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 10 }, prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 90, completion_tokens_details: { reasoning_tokens: 8 } }
const historical = [
  { type: 'agent/model-requested', ts: '2026-09-25T10:00:00Z', body: { callId: 'historical', purpose: 'workflow:run-a:step-a:agent', provider: 'deepseek', request: { model: 'deepseek-flash', messages: [{ role: 'user', content: 'private quote facts' }] } } },
  { type: 'agent/model-completed', ts: '2026-09-25T10:00:03Z', body: { callId: 'historical', response: { model: 'deepseek-flash', usage: reported, choices: [] } } },
  { type: 'agent/model-failed', ts: '2026-09-25T10:00:04Z', body: { callId: 'historical', error: 'no response' } },
]
const legacy = usage.projectUsage(historical, buyer.id)[0]
assert.equal(legacy.status, 'failed'); assert.equal(legacy.tokens.total, 120); assert.equal(legacy.tokens.cachedInput, 10)
assert.equal(legacy.purpose, 'workflow:agent'); assert.equal(legacy.durationMs, 4000)
assert.equal(usage.normalizeUsage({}).total, null); assert.equal(usage.normalizeUsage({ total_tokens: 0 }).total, 0)
assert.deepEqual(usage.normalizeUsage({ prompt_tokens: '9', completion_tokens: -1, total_tokens: Infinity }), usage.normalizeUsage())
assert.equal(usage.normalizeUsage({ input_tokens: 30, output_tokens: 7, total_tokens: 37, input_tokens_details: { cached_tokens: 4, cache_write_tokens: 6 } }).cacheWriteInput, 6)

mkdirSync('tmp', { recursive: true }); const root = mkdtempSync(resolve('tmp/usage-smoke-')), ctx = new Context(), fibers = [], routes = [], navigation = []
const add = (items, value) => { items.push(value); return () => { const index = items.indexOf(value); if (index >= 0) items.splice(index, 1) } }
const mount = async (...args) => { const fiber = await ctx.plugin(...args); assert.equal(fiber.state, 2); fibers.push(fiber); return fiber }
let slowStarted, fixture
try {
  await mount({ name: 'usage-fixture-services', apply(child) {
    child.provide('accounts', { get: id => users.find(user => user.id === id), list: () => structuredClone(users), can: () => true })
    child.provide('web', { route: (...args) => add(routes, args), contribute: item => add(navigation, item) })
  } })
  let storeFiber = await mount(store, { root }), usageFiber = await mount(usage)
  const append = (who, type, body) => ctx.store.append(who.id, type, body, { actor: who.id })
  const request = async (who, id, model = 'model-a', purpose = 'workspace-assistant') => append(who, 'agent/model-requested', { callId: id, purpose, provider: 'example', request: { model, messages: [{ content: 'PRIVATE_INPUT_SHOULD_NOT_APPEAR' }] } })
  await request(buyer, 'legacy', 'model-a', 'workflow:abc:analysis:agent')
  await append(buyer, 'agent/model-completed', { callId: 'legacy', response: { model: 'model-a', usage: reported, choices: [{ message: { content: 'PRIVATE_OUTPUT_SHOULD_NOT_APPEAR' } }] } })
  await request(buyer, 'partial'); await append(buyer, 'agent/model-completed', { callId: 'partial', response: { usage: { prompt_tokens: 3 } } })
  await request(buyer, 'failed'); await append(buyer, 'agent/model-failed', { callId: 'failed', error: 'PRIVATE_ERROR_SHOULD_NOT_APPEAR' })
  await request(buyer, 'zero', 'model-zero'); await append(buyer, 'agent/model-completed', { callId: 'zero', response: { usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } } })
  await request(buyer, 'malformed'); await append(buyer, 'agent/model-completed', { callId: 'malformed', response: { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, choices: [] } }); await append(buyer, 'agent/model-failed', { callId: 'malformed', error: 'Invalid completion' })
  await request(buyer, 'pending')
  await ctx.usage.record(buyer, { callId: 'canceled', provider: 'example', model: 'model-a', purpose: 'workspace-assistant', status: 'canceled', startedAt: `${today}T02:00:00Z`, finishedAt: `${today}T02:00:01Z`, usage: null })
  for (let i = 0; i < 2; i++) await ctx.usage.record(buyer, { callId: 'legacy', provider: 'example', model: 'model-a', purpose: 'workflow:abc:analysis:agent', status: 'completed', startedAt: `${today}T01:00:00Z`, finishedAt: `${today}T01:00:03Z`, usage: reported, ignoredSecret: 'PRIVATE_EXTRA_SHOULD_NOT_APPEAR' })
  await request(supplier, 'supplier', 'other-model'); await append(supplier, 'agent/model-completed', { callId: 'supplier', response: { usage: { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000 } } })
  const mine = ctx.usage.stats(buyer, range)
  assert.equal(mine.summary.calls, 7); assert.equal(mine.summary.tokens.total.value, 135); assert.equal(mine.summary.tokens.total.knownCalls, 3); assert.equal(mine.summary.tokens.total.unknownCalls, 4)
  assert.equal(mine.summary.tokens.input.value, 113); assert.equal(mine.summary.tokens.cachedInput.value, 10); assert.equal(mine.summary.tokens.cacheWriteInput.value, null)
  assert.deepEqual(mine.summary.statuses, { completed: 3, failed: 2, canceled: 1, pending: 1 })
  assert.equal(ctx.usage.stats(buyer, { ...range, model: 'model-zero' }).summary.tokens.total.value, 0)
  assert.equal(ctx.usage.stats(buyer, { ...range, status: 'failed' }).summary.tokens.total.value, 15)
  assert.equal(ctx.usage.stats(buyer, { ...range, purpose: 'workflow:agent', provider: 'example' }).summary.calls, 1)
  assert.equal(ctx.usage.stats(buyer, { from: '2000-01-01', to: '2000-01-02' }).summary.calls, 0)
  assert.throws(() => ctx.usage.stats(buyer, { from: '2026-02-30' }), /valid UTC date/)
  assert.throws(() => ctx.usage.stats(buyer, { scope: 'all' }), error => error.status === 403)
  assert.throws(() => ctx.usage.stats({ ...buyer, role: 'admin' }, { scope: 'all' }), error => error.status === 403)
  assert.throws(() => ctx.usage.stats(buyer, { accountId: supplier.id }), error => error.status === 403)
  assert.equal(ctx.usage.stats(admin, { ...range, scope: 'all' }).summary.tokens.total.value, 1135)
  assert.equal(ctx.usage.stats(admin, { ...range, scope: 'all', accountId: supplier.id }).summary.calls, 1)
  assert.equal(ctx.usage.stats(supplier, range).summary.tokens.total.value, 1000)
  assert.ok(!JSON.stringify(ctx.usage.stats(admin, { ...range, scope: 'all' })).includes('PRIVATE_'))
  assert.ok(!JSON.stringify(ctx.store.events(buyer.id).filter(event => event.type === 'agent/model-usage')).includes('PRIVATE_EXTRA'))
  const route = routes.find(([, path]) => path === '/usage')
  assert.equal(route[2]({ user: buyer, query: new URLSearchParams(range) }).summary.calls, 7)

  // Actual provider integration: no production credentials or outgoing internet.
  for (const key of ['QUOTAGENT_AI_MODEL', 'QUOTAGENT_AI_URL', 'QUOTAGENT_AI_KEY']) delete process.env[key]
  fixture = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part
    const mode = JSON.parse(raw).messages[0].content
    if (mode === 'slow') { slowStarted?.(); return }
    const payload = mode === 'malformed' ? { choices: [], usage: reported } : mode === 'http-error' ? { error: { message: 'fixture refused' }, usage: reported } : { model: 'fixture-model', choices: [{ message: { role: 'assistant', content: 'Local fixture response' } }], ...(mode === 'unreported' ? {} : { usage: reported }) }
    res.writeHead(mode === 'http-error' ? 429 : 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload))
  })
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))
  const configFile = join(root, 'provider.json')
  writeFileSync(configFile, JSON.stringify({ llm: { provider: 'local-usage-fixture', model: 'fixture-model' }, api_keys: { 'local-usage-fixture': { value: 'local-usage-fixture-key', base_url: `http://127.0.0.1:${fixture.address().port}/v1`, env: 'QUOTAGENT_UNUSED_USAGE_FIXTURE_KEY' } } }))
  const settingsFiber = await mount(settings), providerFiber = await mount(provider, { configFile })
  const call = (mode, signal) => ctx.ai.complete(buyer, { purpose: 'usage-fixture', messages: [{ role: 'user', content: mode }], signal })
  await call('success'); await call('unreported'); await assert.rejects(call('malformed'), /no response/); await assert.rejects(call('http-error'), /429/)
  const controller = new AbortController(), started = new Promise(resolve => { slowStarted = resolve }), canceled = call('slow', controller.signal)
  await started; controller.abort(); await assert.rejects(canceled, /cancel/i)
  const hooked = ctx.usage.stats(buyer, { ...range, purpose: 'usage-fixture' })
  assert.equal(hooked.summary.calls, 5); assert.equal(hooked.summary.tokens.total.value, 360)
  assert.equal(hooked.summary.unknownCalls, 2); assert.equal(hooked.summary.statuses.canceled, 1); assert.equal(hooked.summary.statuses.failed, 2)
  const providerRecords = ctx.store.events(buyer.id).filter(event => event.type === 'agent/model-usage' && event.body.purpose === 'usage-fixture')
  assert.equal(providerRecords.length, 5, 'Provider writes one usage event per terminal outcome')
  assert.ok(!JSON.stringify(providerRecords).includes('local-usage-fixture-key'))
  await providerFiber.dispose(); await settingsFiber.dispose(); await usageFiber.dispose()
  assert.equal(ctx.get('usage'), undefined); assert.ok(!routes.some(([, path]) => path === '/usage')); assert.ok(!navigation.some(item => item.id === 'ai-usage'))
  await storeFiber.dispose(); storeFiber = await mount(store, { root }); usageFiber = await mount(usage)
  assert.equal(ctx.usage.stats(buyer, range).summary.calls, 12); assert.equal(ctx.usage.stats(buyer, range).summary.tokens.total.value, 495)
  const report = { ok: true, root, checks: ['real historical schema and malformed completion usage preserved', 'unknown versus zero and cache aliases', 'filters, account isolation and admin-only aggregate', 'five actual local HTTP provider outcomes and once-only usage hook', 'real ledger restart reconstruction', 'native service/route/navigation disposal'] }
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report))
} finally {
  for (const fiber of fibers.reverse()) await fiber.dispose()
  if (fixture) { fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)) }
}
