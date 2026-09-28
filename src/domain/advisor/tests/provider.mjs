import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { Context } from '../../../../host/node_modules/cordis/lib/index.js'
import * as storePlugin from '../../../system/workspace-store/code/index.mjs'
import * as settingsPlugin from '../../../system/settings/code/index.mjs'
import * as controlsPlugin from '../../../system/agent-runtime/code/provider-controls.mjs'
import * as usagePlugin from '../../../system/agent-runtime/code/product-usage.mjs'
import * as providerPlugin from '../code/provider.mjs'
import * as advisorPlugin from '../code/index.mjs'
import { stable } from '../../../system/agent-runtime/code/provider-policy.mjs'

mkdirSync('tmp', { recursive: true })
const root = mkdtempSync(resolve('tmp/jev-provider-')), checks = [], received = [], deferred = new Map(), assistantTools = new Map()
const user = { id: 'jev-buyer', role: 'contractor', name: 'Jev buyer' }, other = { id: 'jev-supplier', role: 'supplier', name: 'Other' }, admin = { id: 'jev-admin', role: 'admin', name: 'Admin' }, users = [user, other, admin]
const sharedKey = 'fixture-shared-jev-secret', ownKey = 'fixture-personal-jev-secret'
// Observed jev-1.13.0 response, 2026-09-28 diagnostic replay: independently
// rounded score1.14 and probabilities with weighted sum1.13. Values stay raw.
const observedScore = { type: 'score', score: 1.14, confidence: 0.11, legend: { '0': 'No deviation', '1': 'Minor', '2': 'Material', '3': 'Severe' }, probabilities: { '0': 0.28, '1': 0.32, '2': 0.39, '3': 0.01 } }
const fixture = createServer(async (request, response) => {
  let raw = ''; for await (const part of request) raw += part
  const body = JSON.parse(raw), mode = body.state?.fixture || (String(body.state?.text || '').startsWith('hold-') ? body.state.text : 'valid')
  received.push({ raw, body, authorization: request.headers.authorization, url: request.url })
  if (deferred.has(mode)) deferred.get(mode)()
  response.setHeader('content-type', 'application/json')
  if (mode.startsWith('hold-')) return
  if (mode === 'http-error') { response.writeHead(429); response.end(JSON.stringify({ error: { message: `fixture error ${sharedKey}` } })); return }
  if (mode === 'not-json') { response.end('not json'); return }
  const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => [id, question.type === 'noul' ? { type: 'noul', noul: 0.55 } : question.type === 'choice' ? { type: 'choice', choice: Object.keys(question.criteria)[0], confidence: 0.1, probabilities: Object.fromEntries(Object.keys(question.criteria).map((key, i) => [key, i === 0 ? 0.55 : 0.45 / (Object.keys(question.criteria).length - 1)])) } : { type: 'score', score: 0.7, confidence: 0.12, legend: Object.fromEntries(question.criteria.map((value, i) => [String(i), value])), probabilities: Object.fromEntries(question.criteria.map((_, i) => [String(i), i === 0 ? 0.3 : i === 1 ? 0.7 : 0])) }]))
  if (mode === 'bad-probability') answers.topic.probabilities.price = 1.5
  if (mode === 'bad-distribution') answers.topic.probabilities = { price: 0.9, delivery: 0.9 }
  if (mode === 'bad-choice') answers.topic.choice = 'not-a-requested-option'
  if (mode === 'bad-choice-rank') { answers.topic.choice = 'delivery'; answers.topic.probabilities = { price: 0.9, delivery: 0.1 } }
  if (mode === 'bad-score') answers.severity.score = 2
  if (['observed-rounding', 'bad-rounded-score', 'finer-precision'].includes(mode)) answers.severity = structuredClone(observedScore)
  if (mode === 'bad-rounded-score') answers.severity.score = 1.18
  if (mode === 'finer-precision') { answers.severity.probabilities = { '0': 0.2801, '1': 0.3199, '2': 0.3901, '3': 0.0099 }; answers.severity.score = 1.14 }
  if (mode === 'rounded-sum') answers.topic = { type: 'choice', choice: 'price', confidence: 0.01, probabilities: { price: 0.34, delivery: 0.34, scope: 0.33 } }
  if (mode === 'bad-legend') delete answers.severity.legend['0']
  if (mode === 'missing-answer') delete answers.topic
  if (mode === 'extra-answer') answers.unrequested = { type: 'noul', noul: 0.99 }
  if (mode === 'bad-noul') answers.urgent.noul = -0.2
  if (mode === 'missing-confidence') delete answers.topic.confidence
  if (mode === 'bad-type') answers.severity.type = 'choice'
  if (mode === 'bad-confidence') answers.topic.confidence = '0.8'
  response.end(JSON.stringify({ model: mode === 'secret-response' ? sharedKey : 'jev-protocol-fixture', answers, ...(mode === 'unknown-usage' ? {} : { usage: { input_tokens: 140, output_tokens: 20 } }) }))
})
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${fixture.address().port}/v1`, configFile = join(root, 'operator.yaml')
writeFileSync(configFile, `api_keys:\n  typesafe:\n    value: ${sharedKey}\n    base_url: ${baseUrl}\n    default_model: jev-protocol-fixture\n`, { mode: 0o600 })
const questions = { topic: { type: 'choice', instructions: 'Classify this clarification.', criteria: { price: 'Quoted price', delivery: 'Delivery schedule' } }, urgent: { type: 'noul', instructions: 'Is there an explicit urgent deadline?' }, severity: { type: 'score', instructions: 'Assess review urgency.', criteria: ['routine', 'review soon', 'urgent review'] } }
const sources = [{ collection: 'rfqs', recordId: 'labelled-fixture', revision: 1, ref: { realm: user.id, seq: 1, hash: 'labelled-fixture-reference' } }]
const input = (fixture = 'valid', extra = {}) => ({ state: { fixture, question: '请确认报价是否包含运费。\nExact retained source.' }, questions, sources, purpose: 'advisor:provider-fixture', ...extra })
let ctx, fibers, provider
async function mount(options = {}) {
  ctx = new Context(); fibers = []
  const add = async (module, config) => { const fiber = await ctx.plugin(module, config); assert.equal(fiber.state, 2); fibers.push(fiber); return fiber }
  await add({ name: 'jev-fixture-services', apply(child) {
    child.provide('accounts', { list: () => users, get: id => users.find(row => row.id === id), can: () => true })
    child.provide('web', { route: () => () => {}, contribute: () => () => {} })
    child.provide('procurement', { snapshot: person => ({ realmId: person.id, rfqs: ctx.store.list(person.id, 'rfqs'), quotes: [] }) })
    child.provide('assistant', { tool(definition) { assert(!assistantTools.has(definition.name)); assistantTools.set(definition.name, definition); return () => assistantTools.delete(definition.name) } })
  } })
  await add(storePlugin, { root }); await add(settingsPlugin); await add(controlsPlugin); await add(usagePlugin)
  provider = await add(options.parent ? advisorPlugin : providerPlugin, { configFile, ...options })
}
const dispose = async () => { for (const fiber of fibers.reverse()) await fiber.dispose() }
const waitForDispatch = mode => new Promise(resolve => deferred.set(mode, resolve))
try {
  await mount()
  assert.equal(ctx.jev.status(user).available, true)
  assert.deepEqual(ctx.jev.settings(user), { enabled: true, timeoutSeconds: 30, confidenceThreshold: 0.65, maxContextBytes: 100000 })
  assert(!JSON.stringify(ctx.jev.status(user)).includes(sharedKey)); assert(!JSON.stringify(ctx.settings.view(user, 'advisor')).includes(sharedKey))
  for (const values of [{ confidenceThreshold: 0.49 }, { confidenceThreshold: 1.01 }, { timeoutSeconds: 0 }, { maxContextBytes: 1000.5 }]) await assert.rejects(ctx.settings.save(user, 'advisor', { values }))
  const value = await ctx.jev.evaluate(user, input('valid', { requestKey: 'once' })), repeated = await ctx.jev.evaluate(user, input('valid', { requestKey: 'once' }))
  assert.equal(repeated.callId, value.callId); assert.equal(received.length, 1); assert.equal(received[0].url, '/v1/systemone'); assert.equal(received[0].authorization, `Bearer ${sharedKey}`)
  assert.equal(value.answers.topic.confidence, 0.1); assert.equal(value.answers.urgent.noul, 0.55); assert.equal(value.answers.urgent.confidence, undefined)
  assert.deepEqual(value.tokens, { input: 140, output: 20, total: 160, cachedInput: null, uncachedInput: null, cacheWriteInput: null, reasoningOutput: null })
  const events = ctx.store.events(user.id), requested = events.find(row => row.type === 'advisor/model-requested'), completed = events.find(row => row.type === 'advisor/model-completed')
  assert.equal(JSON.stringify(stable(requested.body.request)), received[0].raw); assert.deepEqual(requested.body.sources, sources)
  assert.equal(requested.body.requestSha256, createHash('sha256').update(received[0].raw).digest('hex')); assert.equal(requested.body.requestBytes, Buffer.byteLength(received[0].raw)); assert.equal(completed.body.response.model, 'jev-protocol-fixture')
  assert.equal(events.filter(row => row.type === 'advisor/model-requested').length, 1); assert.equal(events.filter(row => row.type === 'agent/model-usage').length, 1); assert(!events.some(row => row.type === 'agent/model-requested'))
  assert.equal(ctx.usage.stats(user).summary.tokens.total.value, 160); assert.equal(ctx.usage.stats(other).summary.calls, 0)
  checks.push('Real Cordis/settings/store and loopback typed HTTP: exact Unicode request bytes/hash/source reconstruction, actual full response, low confidence preserved distinctly from Noul probability, input+output usage total160, account isolation and durable request replay without a duplicate call or usage record')

  await ctx.settings.save(user, 'advisor', { values: { baseUrl: baseUrl.replace('127.0.0.1', 'localhost') } })
  assert.equal(ctx.jev.status(user).available, false)
  let before = received.length
  await assert.rejects(ctx.jev.evaluate(user, input()), { code: 'jev-unavailable' }); assert.equal(received.length, before)
  await ctx.settings.save(user, 'advisor', { values: { apiKey: ownKey } })
  await ctx.jev.evaluate(user, input()); assert.equal(received.at(-1).authorization, `Bearer ${ownKey}`)
  await ctx.jev.evaluate(other, input()); assert.equal(received.at(-1).authorization, `Bearer ${sharedKey}`)
  await ctx.settings.save(user, 'advisor', { reset: true })
  assert.equal(ctx.jev.status(user).available, true)
  assert(!JSON.stringify([...ctx.store.events(user.id), ...ctx.store.events(other.id)]).includes(sharedKey)); assert(!JSON.stringify(ctx.store.events(user.id)).includes(ownKey))
  checks.push('File-backed shared credentials remain masked; a personal endpoint change clears inherited authentication until an explicit personal key is supplied, while another account keeps the shared connection; missing key never dispatches')

  const roundedQuestions = { ...questions, severity: { ...questions.severity, criteria: Object.values(observedScore.legend) } }
  const rounded = await ctx.jev.evaluate(user, input('observed-rounding', { questions: roundedQuestions }))
  assert.deepEqual(rounded.answers.severity, observedScore)
  assert.equal(rounded.answers.severity.probabilities['1'] + rounded.answers.severity.probabilities['2'] * 2 + rounded.answers.severity.probabilities['3'] * 3, 1.1300000000000001)
  const roundedEvent = ctx.store.events(user.id).find(row => row.type === 'advisor/model-completed' && row.body.callId === rounded.callId)
  assert.deepEqual(roundedEvent.body.response.answers.severity, observedScore)
  const roundedSum = await ctx.jev.evaluate(user, input('rounded-sum', { questions: { ...questions, topic: { ...questions.topic, criteria: { price: 'Price', delivery: 'Delivery', scope: 'Scope' } } } }))
  assert.deepEqual(roundedSum.answers.topic.probabilities, { price: 0.34, delivery: 0.34, scope: 0.33 })
  for (const mode of ['bad-rounded-score', 'finer-precision']) {
    await ctx.settings.save(user, 'advisor', { values: { model: mode } })
    await assert.rejects(ctx.jev.evaluate(user, input(mode, { questions: roundedQuestions })), error => error.code === 'jev-invalid-response' && error.detail.validation.path === 'answers.severity.score')
    const failed = ctx.store.events(user.id).filter(row => row.type === 'advisor/model-failed').at(-1).body
    assert.equal(failed.response.answers.severity.score, mode === 'bad-rounded-score' ? 1.18 : 1.14)
    assert.match(failed.validation.reason, /beyond reported rounding precision/)
    assert.match(failed.error, /answers.severity.score/)
  }
  checks.push('Actual Jev1.13.0 numeric regression: score1.14 with reported [0.28,0.32,0.39,0.01] and confidence0.11 is accepted within normalized two-decimal rounding intervals, without changing values; rounded sum1.01 is accepted, while impossible score1.18 and finer-precision inconsistency fail with exact response and field-specific cause retained')

  before = received.length
  for (const data of [input('valid', { state: '' }), input('valid', { state: {} }), input('valid', { questions: {} }), input('valid', { questions: { x: { type: 'text', instructions: 'Generate prose' } } }), input('valid', { state: { secret: sharedKey } })]) await assert.rejects(ctx.jev.evaluate(user, data))
  await ctx.settings.save(user, 'advisor', { values: { maxContextBytes: 1000 } })
  await assert.rejects(ctx.jev.evaluate(user, input('valid', { state: '中'.repeat(1000) })), { code: 'jev-context-too-large' })
  assert.equal(received.length, before)
  await ctx.settings.save(user, 'advisor', { values: { maxContextBytes: 100000 } })
  for (const mode of ['bad-probability', 'bad-distribution', 'bad-choice', 'bad-choice-rank', 'bad-score', 'bad-legend', 'missing-answer', 'extra-answer', 'bad-noul', 'missing-confidence', 'bad-type', 'bad-confidence', 'not-json', 'secret-response']) {
    // Give each malformed-response case a separate connection circuit identity.
    await ctx.settings.save(user, 'advisor', { values: { model: mode } })
    await assert.rejects(ctx.jev.evaluate(user, input(mode)), { code: 'jev-invalid-response' })
    const failed = ctx.store.events(user.id).filter(row => row.type === 'advisor/model-failed').at(-1).body
    if (mode === 'not-json') assert.equal(failed.response, undefined)
    else { assert(failed.response); assert(failed.validation?.path); assert(failed.validation?.reason) }
    if (mode === 'secret-response') assert.equal(failed.response.model, '[redacted]')
  }
  await ctx.settings.save(user, 'advisor', { values: { model: 'http-error' } }); before = received.length
  await assert.rejects(ctx.jev.evaluate(user, input('http-error')), { code: 'jev-http-429' }); assert.equal(received.length, before + 1)
  assert.equal(ctx.store.events(user.id).filter(row => row.type === 'advisor/model-failed').at(-1).body.response.error.message, 'fixture error [redacted]')
  assert(!JSON.stringify(ctx.store.events(user.id)).includes(sharedKey))
  await ctx.settings.save(user, 'advisor', { values: { model: 'jev-protocol-fixture' } })
  const unknown = await ctx.jev.evaluate(user, input('unknown-usage')); assert.equal(unknown.tokens.total, null); assert.equal(unknown.cost.amountMicros, null)
  checks.push('Empty/malformed/oversized sources refuse without dispatch or truncation; malformed type/options/probability/normalization/score/legend/JSON and credential-echo responses fail explicitly with sanitized rejected response and field-specific validation where JSON exists; HTTP429 makes one attempt and retains a redacted failure body, with no authentication data in events; absent usage/cost remains unknown')

  await ctx.settings.save(user, 'advisor', { values: { timeoutSeconds: 1 } })
  const beforeFailures = ctx.store.events(user.id).filter(row => row.type === 'advisor/model-failed').length
  const beforeUsage = ctx.store.events(user.id).filter(row => row.type === 'agent/model-usage').length
  const timeoutInput = input('hold-timeout', { requestKey: 'shared-failure' })
  const failedTogether = await Promise.allSettled([ctx.jev.evaluate(user, timeoutInput), ctx.jev.evaluate(user, timeoutInput)])
  assert(failedTogether.every(row => row.status === 'rejected' && row.reason.code === 'jev-timeout'))
  assert.equal(ctx.store.events(user.id).filter(row => row.type === 'advisor/model-failed').length, beforeFailures + 1)
  assert.equal(ctx.store.events(user.id).filter(row => row.type === 'agent/model-usage').length, beforeUsage + 1)
  const controller = new AbortController(), dispatched = waitForDispatch('hold-cancel'), canceled = ctx.jev.evaluate(user, input('hold-cancel', { signal: controller.signal }))
  canceled.catch(() => {}); await dispatched; controller.abort(); await assert.rejects(canceled, { code: 'canceled' })
  assert.equal(ctx.aiRuntime.stats(user).circuits.find(row => row.model === 'jev-protocol-fixture').failures, 1)
  await ctx.settings.save(user, 'ai-runtime', { values: { accountConcurrency: 1 } })
  const hold = waitForDispatch('hold-unload'), active = ctx.jev.evaluate(user, input('hold-unload')); active.catch(() => {}); await hold
  const queued = ctx.jev.evaluate(user, input('valid')); queued.catch(() => {}); before = received.length
  await provider.dispose(); await assert.rejects(active, { code: 'canceled' }); await assert.rejects(queued, { code: 'canceled' }); assert.equal(received.length, before)
  assert.equal(ctx.get('jev'), undefined); assert(!ctx.settings.list(user).some(row => row.id === 'advisor'))
  assert(ctx.store.events(user.id).some(row => row.type === 'advisor/model-failed' && row.body.code === 'jev-timeout'))
  assert(ctx.store.events(user.id).filter(row => row.type === 'advisor/model-failed' && row.body.status === 'canceled').length >= 3)
  checks.push('Actual HTTP timeout and cancellation abort transport; concurrent callers sharing a failed identity retain one failure/usage receipt, cancellation does not increment the provider circuit; unloading drains active/queued calls without late dispatch and removes service/schema')

  await dispose(); await mount()
  const restored = await ctx.jev.evaluate(user, input('valid', { requestKey: 'once' }))
  assert.equal(restored.callId, value.callId); assert.equal(received.length, before)
  assert.equal(ctx.usage.stats(user).calls.filter(row => row.callId === value.callId).length, 1)
  await assert.rejects(ctx.jev.evaluate(user, input('valid', { requestKey: 'once', sources: [{ ...sources[0], revision: 2 }] })), { code: 'idempotency-conflict' })
  assert.equal(received.length, before)
  checks.push('Native remount preserves the original typed result/source and one usage record; reusing its identity with different source provenance refuses rather than misattributing the old assessment')
  await dispose(); await mount({ parent: true })
  await ctx.store.put(user.id, 'rfqs', { id: 'parent-request', title: 'Parent unload protocol fixture', revision: 1, publishedRevision: 1, status: 'draft', items: [{ id: 'unit', description: 'Authored unit', quantity: 1, unit: 'each' }] }, { event: 'fixture/request-created', actor: 'human:fixture' })
  const tool = assistantTools.get('assess_quotation')
  assert(tool); assert.equal(tool.effect, 'draft'); assert.equal(tool.sourceTrust, 'external'); assert.deepEqual(tool.roles, ['contractor', 'supplier'])
  const businessBefore = structuredClone(ctx.procurement.snapshot(user)), toolRunId = 'workflow:jev-advisory-tool-fixture', toolController = new AbortController()
  const delegated = await tool.execute(user, { mode: 'clarification', rfqId: 'parent-request', text: 'Please confirm the stated delivery timing.' }, { runId: toolRunId, signal: toolController.signal })
  assert.equal(delegated.advisoryOnly, true); assert.equal(delegated.action.action, 'navigate'); assert.equal(delegated.action.input.view, 'advisor')
  assert.deepEqual(ctx.procurement.snapshot(user), businessBefore)
  const delegatedReceipts = ctx.store.events(user.id).filter(row => row.body.callId === delegated.callId)
  for (const type of ['advisor/model-requested', 'advisor/model-completed', 'agent/model-usage']) {
    const receipt = delegatedReceipts.find(row => row.type === type)
    assert(receipt, `Missing delegated ${type}`); assert.equal(receipt.body.runId, toolRunId)
  }
  assert(!delegatedReceipts.some(row => /human-approved|commitment|order-signed/.test(row.type)))
  checks.push('Actual parent registers assess_quotation as a contractor/supplier draft tool with external source trust; invoking its registered execute entry with workflow context retains the exact runId in request/completion/usage receipts, returns only advisory navigation, and leaves business records unchanged')
  const parentRunId = 'workflow:jev-parent-unload-fixture', parentController = new AbortController()
  const parentDispatched = waitForDispatch('hold-parent'), assessment = tool.execute(user, { mode: 'clarification', rfqId: 'parent-request', text: 'hold-parent' }, { runId: parentRunId, signal: parentController.signal })
  assessment.catch(() => {}); await parentDispatched; before = received.length
  await provider.dispose()
  const terminal = await assessment
  assert.equal(terminal.status, 'interrupted'); assert.equal(ctx.store.get(user.id, 'advisor-assessments', terminal.id).status, 'interrupted')
  assert.equal(ctx.get('advisor'), undefined); assert.equal(ctx.get('jev'), undefined); assert.equal(received.length, before)
  assert.equal(assistantTools.size, 0)
  const parentRequest = ctx.store.events(user.id).find(row => row.type === 'advisor/model-requested' && row.body.runId === parentRunId)
  assert(parentRequest)
  const parentFailure = ctx.store.events(user.id).find(row => row.type === 'advisor/model-failed' && row.body.callId === parentRequest.body.callId)
  assert.equal(parentFailure.body.runId, parentRunId); assert.equal(parentFailure.body.status, 'canceled')
  assert.equal(ctx.store.events(user.id).filter(row => row.type === 'advisor/assessment-interrupted' && row.body.record?.id === terminal.id).length, 1)
  checks.push('Actual advisor parent unload aborts its in-flight registered tool assessment, drains both domain/provider work, retains its workflow runId and one durable interrupted assessment, and unregisters the tool plus both services without a late dispatch or inactive-context write')
  const report = { ok: true, root, checks, actualHttpCalls: received.length, requestSha256: value.requestSha256, limitation: 'Local synthetic protocol responses prove adapter behavior, not Jev semantic quality or production latency.', at: new Date().toISOString() }
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2))
} finally { await dispose().catch(() => {}); fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)) }
