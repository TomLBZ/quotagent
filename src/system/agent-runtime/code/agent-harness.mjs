/**
 * agent-harness —— **有界确定性的 harness 骨架**由插件提供（T-275 产物）。
 *
 * 契约：`docs/design/24-agent-runtime-plugins.md`；规划来源：`docs/design/23-agent-runtime-and-storage-plugins.md`
 * §1/§2；围栏门：`host/t275-runtime-gate.mjs`。
 *
 * 它是什么：`provides: ['agentHarness']`，只承载"这一轮打算做几步、每步多大、记录了什么"：
 *   · `plan({objective, steps})` —— 把意图变成**有界计划**：步数按 `max_steps` 夹取（超界报 `omitted`），
 *     每步登记动作名与载荷字节数（**载荷正文不入计划**，只入摘要与字节数）；
 *   · `step(index, payload)` —— 走一步：校验步号在计划内、载荷不超 `max_bytes`、**载荷里不得有凭据**，
 *     然后往**宿主内存的环缓冲**里追加一条决策日志；返回 `{ok, seq, logged, ring}`；
 *   · `log()` / `stats()` / `reset()` —— 只读视图 + 复位（日志**不落盘、不落账本**：`persisted:false`）。
 *
 * 纪律（每条都有门里的断言看着）：
 *   · **硬上限**：`max_steps`（步数）与 `max_bytes`（单步载荷）是硬上限 —— 超步数即拒
 *     （`harness-max-steps-reached`）、超字节即拒（`harness-payload-too-large`，报出 bytes 与 limit）；
 *   · **决策日志在宿主内存的环缓冲里**：容量固定 `ring_size`，满了丢最旧并计 `dropped`（**不静默丢**）；
 *     `log()` 返回的是内存副本，条目上一律 `in_memory:true` / `persisted:false` / `ledger_written:false`；
 *   · **日志里不得出现凭据**：载荷出现凭据形状（键名如 token/secret/api_key，或 `cred:<ns>/<plugin>:*`、
 *     `sk-…` 这类值）→ 整步拒（`harness-credential-refused`），日志条目**只记字段名**、绝不记值；
 *   · **确定性**：不读墙钟、不随机、不读环境变量；同输入两次 `plan()` 的 `objective_digest` 与步表字节一致；
 *   · **零写面**：不写文件、不落账本、不起子进程、不联网、不订阅事件、不注册定时器 ——
 *     本插件**只产内存视图与待办载荷**，落盘与落账本由 Python 侧做（H1）。
 */
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { number, object, string } from '../lib/std-schema.mjs'

export const name = 'agent-harness'
export const inject = []
export const builtin = []
export const usedServices = []
export const provides = ['agentHarness']

export const Config = object({
  max_steps: number().default(8),      // 硬上限：一轮最多走这么多步
  max_bytes: number().default(512),    // 硬上限：单步载荷的 UTF-8 字节数
  ring_size: number().default(16),     // 决策日志环缓冲容量（宿主内存）
})

/** 拒绝码（闭合集合；每个都有固定 next_action）。 */
export const REFUSAL_CODES = ['harness-disposed', 'harness-payload-invalid', 'harness-objective-missing',
  'harness-steps-invalid', 'harness-plan-empty', 'harness-step-not-planned', 'harness-max-steps-reached',
  'harness-payload-too-large', 'harness-credential-refused']
/** 留痕种类（宿主内存；落账本由 Python 侧做，H1）。 */
export const EVENT_KINDS = ['agentrt/harness-planned', 'agentrt/harness-step', 'agentrt/harness-refused',
  'agentrt/harness-disposed']
/** 凭据形状的**键名**（大小写不敏感；命中即整步拒，绝不把值写进日志）。 */
export const CREDENTIAL_KEYS = ['token', 'secret', 'password', 'passwd', 'api_key', 'api-key', 'apikey',
  'credential', 'credentials', 'authorization', 'auth', 'private_key', 'access_key', 'smtp_password']
/** 凭据形状的**值**（作用域凭据引用 / 常见密钥前缀）。 */
export const CREDENTIAL_RE = /cred:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+:|sk-[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/
export const MAX_EVENTS = 512
/** 载荷摘要的深度上界（凭据扫描也在这个深度内，避免深结构拖垮一次 step）。 */
export const SCAN_DEPTH = 6

const NEXT_ACTIONS = {
  'harness-disposed': 'harness 插件已被卸载：重新装配本插件后再起一轮（已记录的日志随 fiber 回收）',
  'harness-payload-invalid': '先 plan() 再 step()；载荷（若有）必须是对象',
  'harness-objective-missing': 'plan 必须给非空 objective（本轮目标一句话）',
  'harness-steps-invalid': 'plan 的 steps 必须是数组，且每步有非空 action',
  'harness-plan-empty': 'plan 至少要有一步：空计划不是"做完了"，是没计划',
  'harness-step-not-planned': '步号必须在已计划的步表内：先 plan 再按计划走',
  'harness-max-steps-reached': '到硬上限了：一轮步数不得超过 max_steps（要更多步就换一轮，别放宽上限）',
  'harness-payload-too-large': '载荷超单步上限：只放引用与结构化字段（正文不进 harness）',
  'harness-credential-refused': '凭据不进 harness：用作用域服务取值，不要把它装进载荷/日志',
}

const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const byName = (left, right) => (left < right ? -1 : (left > right ? 1 : 0))
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const utf8 = (text) => Buffer.byteLength(text, 'utf8')

const clampInt = (value, fallback, lower, upper) => {
  const size = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(upper, Math.max(lower, size))
}

/** 稳定字符串化（对象键排序）→ 同输入必然同字节（计划摘要可复校）。 */
const stable = (value) => {
  if (Array.isArray(value)) return `[${value.map((item) => stable(item)).join(',')}]`
  if (isPlain(value)) {
    return `{${Object.keys(value).sort(byName).map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value === undefined ? null : value)
}

/**
 * 凭据扫描：只回**字段路径**（键名或值的路径），绝不回值。
 * 键名命中 CREDENTIAL_KEYS，或字符串值命中 CREDENTIAL_RE，即视为凭据。
 */
const credentialPaths = (value, path = [], out = [], depth = 0) => {
  if (depth > SCAN_DEPTH || out.length > 64) return out
  if (Array.isArray(value)) {
    value.forEach((item, index) => credentialPaths(item, [...path, `[${index}]`], out, depth + 1))
    return out
  }
  if (!isPlain(value)) return out
  for (const key of Object.keys(value).sort(byName)) {
    const at = [...path, key]
    if (CREDENTIAL_KEYS.includes(key.toLowerCase()) || CREDENTIAL_RE.test(key)) {
      out.push(at.join('.'))
      continue
    }
    const item = value[key]
    if (typeof item === 'string' && CREDENTIAL_RE.test(item)) {
      out.push(at.join('.'))
      continue
    }
    credentialPaths(item, at, out, depth + 1)
  }
  return out
}

export function apply(ctx, config) {
  const maxSteps = clampInt(config?.max_steps, 8, 0, 4096)
  const maxBytes = clampInt(config?.max_bytes, 512, 0, 262144)
  const ringSize = clampInt(config?.ring_size, 16, 0, 4096)
  const state = { plan: null, runs: 0, ring: [], seq: 0 }
  const events = []
  const counters = { plans: 0, steps: 0, refused: 0, dropped: 0, events_dropped: 0 }
  let disposed = false

  const record = (event) => {
    if (events.length >= MAX_EVENTS) {
      events.shift()
      counters.events_dropped += 1
    }
    events.push(event)
    return event
  }
  const nextOf = (code) => NEXT_ACTIONS[code] ?? ''
  const refuse = (code, reason, extra = {}) => {
    counters.refused += 1
    record({ kind: 'agentrt/harness-refused', code, reason: reason || code, next_action: nextOf(code) })
    return { ok: false, code, reason: reason || code, next_action: nextOf(code), ...extra }
  }
  const ringView = () => ({ size: state.ring.length, capacity: ringSize, dropped: counters.dropped })
  /** 环缓冲：满了丢最旧并**计数**（丢了多少看得见，不静默）。条目只放元数据，不放载荷正文。 */
  const ringPush = (entry) => {
    state.seq += 1
    const full = { seq: state.seq, ...entry, in_memory: true, persisted: false, ledger_written: false }
    state.ring.push(full)
    while (state.ring.length > ringSize) {
      state.ring.shift()
      counters.dropped += 1
    }
    return full
  }
  const stepBytes = (payload) => utf8(stable(payload ?? {}))

  const plan = (request) => {
    if (disposed) return refuse('harness-disposed', 'agent-harness-disposed')
    if (!isPlain(request)) return refuse('harness-payload-invalid', 'plan-request-not-object')
    const objective = typeof request.objective === 'string' ? request.objective.trim() : ''
    if (objective === '') return refuse('harness-objective-missing', 'objective-empty')
    const steps = request.steps
    if (!Array.isArray(steps)) return refuse('harness-steps-invalid', 'steps-not-array')
    if (steps.length === 0) return refuse('harness-plan-empty', 'steps-empty')
    const bad = steps.findIndex((item) => !isPlain(item) || String(item.action ?? '').trim() === '')
    if (bad >= 0) return refuse('harness-steps-invalid', `step-invalid:${bad}`)
    const sizes = steps.map((item) => stepBytes(item.payload))
    const planned = steps.slice(0, maxSteps)
    const omitted = steps.length - planned.length
    state.plan = { objective, steps: planned.map((item, index) => ({ index, action: String(item.action),
      bytes: sizes[index] })) }
    state.runs = 0
    counters.plans += 1
    const counts = { steps: steps.length, bytes: sizes.reduce((sum, size) => sum + size, 0) }
    record({ kind: 'agentrt/harness-planned', objective_digest: sha256(objective), planned: planned.length,
      omitted })
    return { ok: true, code: '', reason: '', next_action: '', objective_digest: sha256(objective),
      steps: state.plan.steps.map((item) => ({ ...item })), counts, truncated: omitted > 0, omitted,
      limits: { max_steps: maxSteps, max_bytes: maxBytes }, ring: ringView() }
  }

  const step = (index, payload) => {
    if (disposed) return refuse('harness-disposed', 'agent-harness-disposed')
    if (state.plan === null) return refuse('harness-payload-invalid', 'no-plan')
    const at = Number.isInteger(index) ? index : -1
    if (at < 0 || at >= state.plan.steps.length) {
      return refuse('harness-step-not-planned', `step-not-planned:${String(index)}`)
    }
    if (state.runs >= maxSteps) return refuse('harness-max-steps-reached', `max-steps:${maxSteps}`)
    if (payload !== undefined && !isPlain(payload)) return refuse('harness-payload-invalid', 'payload-not-object')
    const bytes = stepBytes(payload)
    if (bytes > maxBytes) {
      return refuse('harness-payload-too-large', `payload-bytes:${bytes}>${maxBytes}`, { bytes, limit: maxBytes })
    }
    const credential = credentialPaths(payload ?? {})
    const action = state.plan.steps[at].action
    if (credential.length > 0) {
      // 整步拒：日志条目**只记字段名与字节数**（值不进内存日志，也不进返回值）
      const entry = ringPush({ index: at, action, outcome: 'refused', code: 'harness-credential-refused', bytes,
        redacted_fields: credential })
      return refuse('harness-credential-refused', `credential-fields:${credential.join(',')}`,
        { seq: entry.seq, logged: true, redacted_fields: credential, bytes, ring: ringView() })
    }
    state.runs += 1
    counters.steps += 1
    const entry = ringPush({ index: at, action, outcome: 'logged', code: '', bytes, redacted_fields: [] })
    record({ kind: 'agentrt/harness-step', index: at, action, bytes })
    return { ok: true, code: '', reason: '', next_action: '', seq: entry.seq, logged: true, index: at, action,
      bytes, in_memory: true, persisted: false, ledger_written: false, ring: ringView() }
  }

  const log = () => state.ring.map((entry) => ({ ...entry }))
  const reset = () => {
    if (disposed) return refuse('harness-disposed', 'agent-harness-disposed')
    state.plan = null
    state.runs = 0
    state.ring = []
    return { ok: true, code: '', reason: '', next_action: '', plan: null, ring: ringView() }
  }

  const stats = () => ({
    objective_digest: state.plan === null ? '' : sha256(state.plan.objective),
    planned_steps: state.plan === null ? 0 : state.plan.steps.length,
    runs: state.runs,
    ring: ringView(),
    log_entries: state.ring.length,
    limits: { max_steps: maxSteps, max_bytes: maxBytes, ring_size: ringSize },
    disk_written: 0,
    ledger_written: 0,
    log_persistent: false,
    credential_values_in_log: 0,
    resume: { ...counters, disposed },
    events: events.length,
  })

  ctx.provide('agentHarness', {
    config: () => ({ max_steps: maxSteps, max_bytes: maxBytes, ring_size: ringSize }),
    plan,
    step,
    log,
    reset,
    stats,
    /** 留痕视图（Python 侧据此落账本：`agentrt/harness-*` 带 reason/next_action）。 */
    events: () => events.map((item) => ({ ...item })),
  })
  // 插件被卸载：环缓冲随 fiber 回收（日志本就不落盘；账本里没有它的一行）
  ctx.effect(() => () => {
    disposed = true
    record({ kind: 'agentrt/harness-disposed', steps: counters.steps, ring: state.ring.length })
  })
}

/** fixture：纯读取（挂载一次、连跑两次比对字节；只 plan 不走步 —— step 会推进序号，不属于"纯读"）。 */
export const fixture = {
  sample: (handle) => {
    const planned = handle.plan({ objective: '核对比价口径并排出下一步', steps: [
      { action: 'read-projection' },
      { action: 'rank-quotes', payload: { top: 3 } },
    ] })
    return {
      plan: { ...planned, ring: undefined },
      log: handle.log(),
      limits: handle.stats().limits,
    }
  },
}
