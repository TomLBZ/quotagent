import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { AdmissionError, stable } from '../../../system/agent-runtime/code/provider-policy.mjs'
import { normalizeUsage } from '../../../system/agent-runtime/code/product-usage.mjs'

const require = createRequire(new URL('../../../../host/package.json', import.meta.url))
const { parse } = require('yaml')
export const name = 'jev-provider'
export const inject = ['store', 'settings', 'aiRuntime', 'usage']
export const provides = ['jev']
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value)
const probability = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
const fail = (code, message, status = 400, detail = {}) => { throw new AdmissionError(code, message, { status, ...detail }) }
const sha256 = value => createHash('sha256').update(value).digest('hex')
const typed = value => typeof value === 'string' || Array.isArray(value) || plain(value)
const jsonSafe = value => {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (Array.isArray(value)) { for (const item of value) jsonSafe(item); return }
  if (plain(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))) { for (const item of Object.values(value)) jsonSafe(item); return }
  fail('jev-invalid-input', 'Evaluation inputs must contain only finite JSON values.')
}
const endpointOf = base => {
  let url
  try { url = new URL(base) } catch { fail('jev-invalid-endpoint', 'Enter a valid TypeSafe API base URL.') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('jev-invalid-endpoint', 'Use an HTTP(S) API base URL without embedded credentials, query or fragment.')
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = path.endsWith('/systemone') ? path : `${path || '/v1'}/systemone`
  return url.href
}

function validateRequest(state, questions) {
  try { jsonSafe(state); jsonSafe(questions) } catch (error) {
    if (error instanceof AdmissionError) throw error
    fail('jev-invalid-input', 'Evaluation inputs must be finite, non-circular JSON values.')
  }
  if (!typed(state) || (typeof state === 'string' ? !state.trim() : !Object.keys(state).length)) fail('jev-empty-state', 'Choose source content before requesting an assessment.')
  if (!plain(questions) || !Object.keys(questions).length || Object.keys(questions).length > 32) fail('jev-invalid-questions', 'Provide between one and 32 typed questions.')
  for (const question of Object.values(questions)) {
    if (!plain(question) || !['noul', 'choice', 'score'].includes(question.type) || !typed(question.instructions) || (typeof question.instructions === 'string' ? !question.instructions.trim() : !Object.keys(question.instructions).length)) fail('jev-invalid-questions', 'Every question needs a supported type and explicit instructions.')
    if (Object.keys(question).some(key => !['type', 'instructions', 'criteria'].includes(key))) fail('jev-invalid-questions', 'A typed question accepts only type, instructions and criteria.')
    if (question.type === 'choice' && (!plain(question.criteria) || Object.keys(question.criteria).length < 2 || Object.keys(question.criteria).length > 255 || Object.values(question.criteria).some(value => value !== null && !typed(value)))) fail('jev-invalid-questions', 'Choice questions need two to 255 explicitly described options.')
    if (question.type === 'score' && (!Array.isArray(question.criteria) || question.criteria.length < 2 || question.criteria.length > 10 || question.criteria.some(value => !typed(value)))) fail('jev-invalid-questions', 'Score questions need two to ten ordered rubric levels.')
    if (question.type === 'noul' && question.criteria !== undefined && (!plain(question.criteria) || Object.keys(question.criteria).some(key => !['true', 'false'].includes(key)) || Object.values(question.criteria).some(value => !typed(value)))) fail('jev-invalid-questions', 'Noul criteria may describe only true and false.')
  }
}

// Jev 1.13.0 reports independently rounded scores and probabilities (observed
// two-decimal precision). Preserve them; test whether a normalized distribution
// inside their rounding intervals can explain the reported score. Finer reported
// precision narrows each interval, and integer/one-decimal JSON still uses .005.
const roundingRadius = value => {
  const [mantissa, exponent = '0'] = String(value).toLowerCase().split('e')
  const decimals = (mantissa.split('.')[1]?.length || 0) - Number(exponent)
  return 0.5 * 10 ** -Math.max(2, decimals)
}
const epsilon = 1e-10
const probabilityInterval = value => [Math.max(0, value - roundingRadius(value)), Math.min(1, value + roundingRadius(value))]
const weightedBound = (intervals, reverse) => {
  let remaining = 1 - intervals.reduce((sum, [low]) => sum + low, 0)
  let weighted = intervals.reduce((sum, [low], index) => sum + low * index, 0)
  for (let step = 0; step < intervals.length; step++) {
    const index = reverse ? intervals.length - step - 1 : step
    const extra = Math.min(Math.max(0, remaining), intervals[index][1] - intervals[index][0])
    weighted += extra * index; remaining -= extra
  }
  return weighted
}

function validateAnswers(payload, questions) {
  const invalid = (path, reason) => fail('jev-invalid-response', `TypeSafe returned an invalid typed response at ${path}: ${reason}. No advice was inferred.`, 502, { validation: { path, reason } })
  if (!plain(payload) || typeof payload.model !== 'string' || !payload.model.trim() || !plain(payload.answers)) invalid('response', 'model and answers are required')
  const ids = Object.keys(questions)
  if (Object.keys(payload.answers).length !== ids.length || ids.some(id => !Object.hasOwn(payload.answers, id))) invalid('answers', 'question identifiers must exactly match the request')
  for (const id of ids) {
    const answer = payload.answers[id], question = questions[id], path = `answers.${id}`
    if (!plain(answer) || answer.type !== question.type) invalid(`${path}.type`, 'answer type must match the requested type')
    if (answer.type === 'noul') { if (!probability(answer.noul)) invalid(`${path}.noul`, 'probability must be a finite number from 0 to 1'); continue }
    if (!probability(answer.confidence)) invalid(`${path}.confidence`, 'confidence must be a finite number from 0 to 1')
    if (!plain(answer.probabilities)) invalid(`${path}.probabilities`, 'a probability distribution is required')
    const keys = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index))
    if (Object.keys(answer.probabilities).length !== keys.length || keys.some(key => !Object.hasOwn(answer.probabilities, key) || !probability(answer.probabilities[key]))) invalid(`${path}.probabilities`, 'every requested option needs one finite probability from 0 to 1, without extra options')
    const probabilities = keys.map(key => answer.probabilities[key])
    const intervals = probabilities.map(probabilityInterval)
    if (intervals.reduce((sum, [low]) => sum + low, 0) > 1 + epsilon || intervals.reduce((sum, [, high]) => sum + high, 0) < 1 - epsilon) invalid(`${path}.probabilities`, 'probabilities cannot sum to 1 within their reported rounding precision')
    if (answer.type === 'choice') {
      if (!keys.includes(answer.choice)) invalid(`${path}.choice`, 'selected option was not requested')
      if (intervals[keys.indexOf(answer.choice)][1] + epsilon < Math.max(...intervals.map(([low]) => low))) invalid(`${path}.choice`, 'selected option cannot be most probable within reported rounding precision')
    } else {
      if (typeof answer.score !== 'number' || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > keys.length - 1) invalid(`${path}.score`, 'score must be a finite number within the requested rubric levels')
      if (!plain(answer.legend) || Object.keys(answer.legend).length !== keys.length || keys.some(key => !Object.hasOwn(answer.legend, key) || !typed(answer.legend[key]))) invalid(`${path}.legend`, 'every requested rubric level needs a description')
      const radius = roundingRadius(answer.score)
      if (answer.score + radius < weightedBound(intervals, false) - epsilon || answer.score - radius > weightedBound(intervals, true) + epsilon) invalid(`${path}.score`, 'score disagrees with the normalized probability distribution beyond reported rounding precision')
    }
  }
}

export function apply(ctx, config = {}) {
  // Capture services while the fiber is active; disposal drains calls after abort.
  const store = ctx.store, settingsService = ctx.settings, runtime = ctx.aiRuntime, usageService = ctx.usage
  const jobs = new Set(), controllers = new Set()
  let disposed = false
  const inherited = () => {
    const filename = config.configFile || process.env.QUOTAGENT_CONFIG || '/workspace/config.yaml'
    let document = {}
    if (config.inheritDefaults !== false && existsSync(filename)) {
      try { document = parse(readFileSync(filename, 'utf8')) || {} } catch { fail('jev-invalid-config', 'The operator configuration could not be read as YAML. Check the TypeSafe connection settings.', 503) }
    }
    const entry = document.api_keys?.typesafe || {}, variable = entry.env || 'TYPESAFE_API_KEY'
    const environment = config.inheritDefaults !== false ? process.env[variable] : ''
    const defaults = { enabled: true, model: String(entry.default_model || 'jev-latest'), baseUrl: String(entry.base_url || 'https://api.typesafe.ai/v1'), apiKey: String(environment || entry.value || ''), timeoutSeconds: 30, confidenceThreshold: 0.65, maxContextBytes: 100000 }
    const origins = Object.fromEntries(Object.keys(defaults).map(key => [key, { source: 'default', reference: 'Jev provider defaults' }]))
    for (const [key, field] of [['model', 'default_model'], ['baseUrl', 'base_url'], ['apiKey', 'value']]) if (entry[field]) origins[key] = { source: 'file', reference: `${filename}#api_keys.typesafe.${field}` }
    if (environment) origins.apiKey = { source: 'environment', reference: variable }
    return { defaults, origins }
  }
  ctx.effect(() => settingsService.define({ id: 'advisor', name: 'Jev structured advice', scope: 'user',
    description: 'Use the shared TypeSafe evaluator or your own connection. A different API endpoint requires your own key. Assessments are advisory; confidence never approves a quotation or order.',
    defaults: () => inherited().defaults, origins: () => inherited().origins,
    fields: [
      { key: 'enabled', label: 'Enable Jev assessments', type: 'boolean' },
      { key: 'model', label: 'Jev model', type: 'text', required: true },
      { key: 'baseUrl', label: 'TypeSafe API base URL', type: 'text', required: true },
      { key: 'apiKey', label: 'TypeSafe API key', type: 'password' },
      { key: 'timeoutSeconds', label: 'Assessment timeout (seconds)', type: 'number', min: 1, max: 300 },
      { key: 'confidenceThreshold', label: 'Human review confidence threshold', type: 'number', min: 0.5, max: 1, description: 'An operational review threshold, not a measured accuracy guarantee.' },
      { key: 'maxContextBytes', label: 'Maximum typed request bytes', type: 'number', min: 1000, max: 1000000, description: 'Oversized input is refused; no source is silently truncated.' },
    ],
    resolve: (values, { user, globalValues, overriddenKeys }) => user && user.role !== 'admin' && endpointOf(values.baseUrl) !== endpointOf(globalValues.baseUrl) && !overriddenKeys.includes('apiKey') ? { ...values, apiKey: '' } : values,
    validate: values => {
      endpointOf(values.baseUrl)
      if (!String(values.model).trim()) fail('jev-invalid-config', 'Choose a Jev model.')
      if (typeof values.confidenceThreshold !== 'number' || !Number.isFinite(values.confidenceThreshold) || values.confidenceThreshold < 0.5 || values.confidenceThreshold > 1) fail('jev-invalid-config', 'Human review confidence threshold must be from 0.5 to 1.')
      if (typeof values.timeoutSeconds !== 'number' || !Number.isFinite(values.timeoutSeconds) || values.timeoutSeconds < 1 || values.timeoutSeconds > 300) fail('jev-invalid-config', 'Assessment timeout must be from one to 300 seconds.')
      if (!Number.isSafeInteger(values.maxContextBytes) || values.maxContextBytes < 1000 || values.maxContextBytes > 1000000) fail('jev-invalid-config', 'Maximum typed request bytes must be a whole number from 1000 to 1000000.')
    },
  }))
  const connection = user => { const values = settingsService.get(user, 'advisor'); return { ...values, provider: 'typesafe', key: values.apiKey, endpoint: endpointOf(values.baseUrl) } }
  const safeSettings = user => { const { enabled, timeoutSeconds, confidenceThreshold, maxContextBytes } = connection(user); return { enabled, timeoutSeconds, confidenceThreshold, maxContextBytes } }
  const status = user => { const values = connection(user); return { available: !disposed && values.enabled && !!(values.key && values.model), provider: 'typesafe', model: values.model,
    reason: disposed ? 'Jev provider is unloaded.' : !values.enabled ? 'Jev assessments are disabled in your settings.' : !values.key ? 'Add a TypeSafe API key in Plugin settings → Jev structured advice, or use configured shared defaults.' : null } }

  const perform = async (user, input, controller) => {
    const callId = randomUUID(), startedAt = new Date().toISOString(), purpose = input.purpose || 'advisor', runId = input.runId || null
    let values, result, failure, response, attempted = false, request, sources, requestSha256, requestBytes
    const redact = value => values?.key ? String(value).replaceAll(values.key, '[redacted]') : String(value)
    const sanitize = value => typeof value === 'string' ? redact(value) : Array.isArray(value) ? value.map(sanitize) : plain(value)
      ? Object.fromEntries(Object.entries(value).map(([key, child]) => [redact(key), /^(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret)$/i.test(key) ? '[redacted]' : sanitize(child)])) : value
    try {
      values = connection(user)
      if (!values.enabled || !values.key) fail('jev-unavailable', status(user).reason || 'The TypeSafe evaluator is unavailable.', 503)
      validateRequest(input.state, input.questions); jsonSafe(input.sources || [])
      request = stable({ model: values.model, state: input.state, questions: input.questions }); sources = structuredClone(input.sources || [])
      const wire = JSON.stringify(request), sourceBytes = JSON.stringify(sources)
      if (wire.includes(values.key) || sourceBytes.includes(values.key)) fail('jev-secret-in-source', 'Source content contains connection authentication data; remove it before assessment.')
      requestSha256 = sha256(wire); requestBytes = Buffer.byteLength(wire)
      if (requestBytes > values.maxContextBytes) fail('jev-context-too-large', 'This complete typed request exceeds the Jev context byte limit. Narrow the source or deliberately increase the limit; nothing was truncated.', 413)
      result = await runtime.run(user, { callId, connection: values, request: { typedRequest: request, sources }, purpose, signal: controller.signal, runId,
        requestKey: input.requestKey ? `advisor:${input.requestKey}` : null }, async lease => {
        if (requestBytes > lease.config.maxContextBytes) fail('jev-context-too-large', 'This typed request exceeds your AI runtime context limit. Nothing was truncated.', 413)
        await store.append(user.id, 'advisor/model-requested', { callId, runId, purpose, provider: 'typesafe', endpoint: values.endpoint, request, sources, serialization: 'json-key-sorted/v1', requestSha256, requestBytes }, { actor: `agent:${user.id}` })
        await lease.attempt()
        if (lease.signal.aborted) fail('canceled', 'The Jev assessment was canceled before dispatch.', 409)
        const transport = new AbortController(), abort = () => transport.abort(lease.signal.reason)
        let timedOut = false
        lease.signal.addEventListener('abort', abort, { once: true })
        const timer = setTimeout(() => { timedOut = true; transport.abort() }, values.timeoutSeconds * 1000)
        try {
          attempted = true
          const http = await fetch(values.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${values.key}` }, body: wire, signal: transport.signal })
          try { response = await http.json() } catch { fail('jev-invalid-response', 'TypeSafe did not return valid JSON.', 502) }
          if (!http.ok) fail(`jev-http-${http.status}`, `TypeSafe returned HTTP ${http.status}. ${[401, 403].includes(http.status) ? 'Review your connection credentials.' : 'Inspect the provider status and retry explicitly.'}`, http.status, { waitingHelps: [429, 529, 503].includes(http.status), nextAction: 'No automatic retry was made.' })
          if (JSON.stringify(response).includes(values.key)) fail('jev-invalid-response', 'The provider response unexpectedly contained authentication data; only a redacted failure receipt was retained.', 502, { validation: { path: 'response', reason: 'authentication data in provider response' } })
          validateAnswers(response, request.questions)
          if (lease.signal.aborted) fail('canceled', 'The Jev assessment was canceled.', 409)
          const tokens = normalizeUsage(response.usage)
          if (tokens.total === null && tokens.input !== null && tokens.output !== null && Number.isSafeInteger(tokens.input + tokens.output)) tokens.total = tokens.input + tokens.output
          lease.attemptOutcome(true)
          await store.append(user.id, 'advisor/model-completed', { callId, runId, response, requestSha256, requestBytes }, { actor: `agent:${user.id}` })
          return { callId, model: response.model, answers: response.answers, usage: response.usage || null, tokens,
            completeUsage: tokens.input !== null && tokens.output !== null && tokens.total !== null,
            usageCoverage: { attempts: 1, knownAttempts: tokens.total !== null ? 1 : 0, unknownAttempts: tokens.total === null ? 1 : 0, totalSource: Number.isSafeInteger(response.usage?.total_tokens) ? 'provider' : tokens.total !== null ? 'sum-of-reported-input-output' : 'unknown' },
            requestSha256, requestBytes, sources, serialization: 'json-key-sorted/v1' }
        } catch (error) {
          if (lease.signal.aborted) fail('canceled', 'The Jev assessment was canceled.', 409)
          lease.attemptOutcome(false)
          if (timedOut) fail('jev-timeout', 'TypeSafe exceeded the configured assessment timeout. No automatic retry was made.', 504)
          if (error instanceof AdmissionError) throw error
          fail('jev-network-error', redact(error.message || 'TypeSafe connection failed.'), 502)
        } finally { clearTimeout(timer); lease.signal.removeEventListener('abort', abort) }
      })
      return result
    } catch (error) {
      failure = error
      if (!error.detail?.replayed && (!error.callId || error.callId === callId)) await store.append(user.id, 'advisor/model-failed', { callId, runId, purpose, code: error.code || 'jev-error', error: redact(error.message), status: controller.signal.aborted || error.code === 'canceled' ? 'canceled' : 'failed', attempted, requestSha256: requestSha256 || null,
        ...(response !== undefined ? { response: sanitize(response) } : {}), ...(error.detail?.validation ? { validation: sanitize(error.detail.validation) } : {}) }, { actor: `agent:${user.id}` })
      throw error
    } finally {
      if (!failure?.detail?.replayed && (!failure?.callId || failure.callId === callId) && (!result || result.callId === callId)) await usageService.record(user, { callId, provider: 'typesafe', model: redact(response?.model || values?.model || 'unknown'), purpose, status: result ? 'completed' : controller.signal.aborted || failure?.code === 'canceled' ? 'canceled' : 'failed', startedAt, finishedAt: new Date().toISOString(), tokens: result?.tokens || normalizeUsage(response?.usage), usage: response?.usage || null, cost: result?.cost || null, runId, attempts: result?.attempts || failure?.attempts || (attempted ? 1 : 0), stopReason: failure?.code || null, usageCoverage: result?.usageCoverage || null })
    }
  }
  const evaluate = (user, input = {}) => {
    if (disposed) return Promise.reject(new AdmissionError('jev-unavailable', 'The Jev provider is unloaded.', { status: 503 }))
    if (!user?.id) return Promise.reject(new AdmissionError('jev-unauthorized', 'Sign in before requesting an assessment.', { status: 401 }))
    const controller = new AbortController(), abort = () => controller.abort(input.signal?.reason)
    controllers.add(controller)
    if (input.signal?.aborted) abort(); else input.signal?.addEventListener('abort', abort, { once: true })
    const task = perform(user, input, controller)
    jobs.add(task)
    task.finally(() => { jobs.delete(task); controllers.delete(controller); input.signal?.removeEventListener('abort', abort) }).catch(() => {})
    return task
  }
  ctx.provide('jev', { status, settings: safeSettings, evaluate })
  ctx.effect(() => async () => { disposed = true; for (const controller of controllers) controller.abort(); await Promise.allSettled([...jobs]); controllers.clear(); jobs.clear() })
}
