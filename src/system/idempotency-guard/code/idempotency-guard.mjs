/**
 * 宿主层**幂等守卫**（`idempotency-guard`）—— 运行期中间件：同一请求只做一次；重复请求**复用结果**，
 * 而不是把副作用重放一遍（追加型账本被重放是严重问题，这里挡的正是这一步）。
 *
 * 做什么（一次宿主请求的一生）：
 *   · `keyOf({method, params, correlation_id})`：把请求压成**确定性**稳定键 —— params 按键名排序做规范化、
 *     取 `sha256`，键形如 `${method}|${correlation_id}|sha256:<hex>`；与内核去重键**同形**
 *     （内核口径 `(type, correlation_id, body_hash)`）—— 只借用形状，不与内核共享存储、不改内核语义。
 *   · `begin(...)`：四选一判定 `fresh` / `duplicate-inflight` / `duplicate-done` / `replay`，
 *     **不返回裸 false**：每条都给 `reason` 与 `next_action`；可复用的那条还给 `result_digest`。
 *   · `finish({..., ok, result_digest})`：落完成态；此后同一请求再来即判 `duplicate-done`，
 *     调用方复用上次结果即可 —— 不必（也不该）再打一次下游。
 *
 * 边界与纪律（围栏门会静态扫描这些字样）：
 *   1) **不写账本、不写文件**：这里只有内存里的在途/完成标记（有界、进程结束即消失），
 *      它**不是第二本账**；要成为事实的东西仍由内核侧落账（H1）。本模块没有任何文件系统调用。
 *   2) **不订阅事件、不注册任何定时器**：窗口与在途 TTL 一律用**注入的时钟**判断
 *      （`setClock()` 可换掉默认的 Date.now；测试注入假时钟 → 同一序列两次判定字节一致），
 *      进程里不留等待中的回调，dispose 后零残留。
 *   3) **拒绝可解释**：四个判定都带 reason + next_action；在途超过 TTL 判"状态未知"（未知即未知，
 *      不许悄悄当成功）；失败过的请求**不得**被复用成成功。
 *   4) **有界**：窗口内保留的键数 ≤ `window_max`（配置越硬上界时被夹到 `window_max_limit`），
 *      "已见过"指纹表同样有上界 —— 内存上界与运行时长无关。
 */
import { number, object, string } from '../lib/std-schema.mjs'
import { createHash } from 'node:crypto'

export const name = 'idempotency-guard'

export const inject = []

export const builtin = []

export const usedServices = []

export const provides = ['idempotency']

export const Config = object({
  key: string().default('host'),               // 默认命名空间（仅出现在自省输出里，不参与键推导）
  window_ms: number().default(60000),          // 完成态**复用窗口**：窗口内重复请求复用结果，出窗口改判 replay
  inflight_ttl_ms: number().default(30000),    // 在途超过它就判"状态未知"（不静默当成功）
  window_max: number().default(256),           // 窗口内保留的键数量上限
  window_max_limit: number().default(1024),    // 硬上界：配置也不许超过（超了被夹住）
  replay_memory: number().default(64),         // "已见过"指纹表容量（条目被淘汰后仍认得出是重复意图）
  replay_memory_limit: number().default(256),  // 指纹表硬上界
})

const sha = (text) => 'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex')

/**
 * 单个槽位：读不出（getter 抛错 / 代理异常）只让**这个槽位**退化成固定标记，不把整份参数压成一个标记
 * —— 否则两份互不相同的畸形参数会算出同一把键，被误判成"同一请求"。
 * 每层自带一份祖先集合副本：某一层抛错也不会污染上层的环检测。
 */
const step = (value, seen) => {
  try {
    return canon(value, new Set(seen))
  } catch {
    return '"<unreadable>"'
  }
}

/**
 * 把任意值压成**确定性**字符串：键名排序、不含时间/随机/环境量；
 * 循环引用、BigInt、Symbol、读不出的 getter 都给**固定标记**而不是抛错（畸形输入不许拖崩宿主）。
 */
const canon = (value, seen = new Set()) => {
  if (value === null) return 'null'
  const kind = typeof value
  if (kind === 'string') return JSON.stringify(value)
  if (kind === 'boolean') return value ? 'true' : 'false'
  if (kind === 'number') return Number.isFinite(value) ? `n:${value}` : `n:<${String(value)}>`
  if (kind === 'bigint') return `n:<bigint:${value.toString()}>`
  if (kind === 'undefined') return '"<undefined>"'
  if (kind === 'symbol') return `"<symbol:${String(value.description)}>"`
  if (kind === 'function') return '"<function>"'
  if (value instanceof Date) {
    const at = value.getTime()
    return `"<date:${Number.isFinite(at) ? at : 'invalid'}>"`
  }
  if (seen.has(value)) return '"<circular>"'
  seen.add(value)
  let out
  try {
    if (Array.isArray(value)) {
      out = `[${value.map((item) => step(item, seen)).join(',')}]`
    } else if (value instanceof Map) {
      out = `{${[...value.entries()]
        .map(([k, v]) => [step(k, seen), step(v, seen)])
        .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
        .map(([k, v]) => `${k}:${v}`).join(',')}}`
    } else if (value instanceof Set) {
      out = `[${[...value].map((item) => step(item, seen)).sort().join(',')}]`
    } else {
      out = `{${Object.keys(value).sort()
        .map((k) => `${JSON.stringify(k)}:${step(value[k], seen)}`).join(',')}}`
    }
  } catch {
    out = '"<unreadable>"'          // 连键都列不出来（代理/敌意对象）：整份退化成固定标记，不抛
  }
  seen.delete(value)                // 只挡真正的环，重复出现的同一个子对象仍按值展开
  return out
}

/** 读字段：getter 抛错一律退化成默认值（畸形入参不许把判定路径炸掉）。 */
const fieldOf = (source, name, fallback) => {
  try {
    const value = source[name]
    return value === undefined ? fallback : value
  } catch {
    return fallback
  }
}

/** 把任意入参收敛成能安全读字段的记录（非对象输入当成 params 本身）。 */
const asRecord = (raw) => {
  if (raw === null || raw === undefined) return {}
  if (typeof raw !== 'object' && typeof raw !== 'function') return { params: raw }
  return raw
}

/** 键里的一段：字符串照抄，其它类型走 canon（并转义分隔符，避免两段拼出同一把键）。 */
const segment = (value) => {
  const text = typeof value === 'string' ? value : (value === null || value === undefined ? '' : canon(value))
  return text.split('|').join('\\u007c')
}

/** 规范化的三元组 `(method, correlation_id, params_hash)` —— 与内核去重键同形。 */
const partsOf = (raw) => {
  const input = asRecord(raw)
  let shaped = false
  try {
    shaped = ('method' in input) || ('params' in input) || ('correlation_id' in input)
  } catch {
    shaped = false
  }
  const params = shaped ? fieldOf(input, 'params', null) : input
  const canonical = canon(params)
  const method = segment(fieldOf(input, 'method', undefined))
  const correlationId = segment(fieldOf(input, 'correlation_id', ''))
  const paramsHash = sha(canonical)
  return { method, correlation_id: correlationId, params_hash: paramsHash, canonical,
    key: `${method}|${correlationId}|${paramsHash}` }
}

export function apply(ctx, config) {
  // 配置**夹在上界内**：window_max / replay_memory 都不许无界（有界性是本模块的纪律之一）
  const windowMax = Math.min(Math.max(1, Math.floor(config.window_max)), Math.max(1, Math.floor(config.window_max_limit)))
  const replayMax = Math.min(Math.max(1, Math.floor(config.replay_memory)), Math.max(1, Math.floor(config.replay_memory_limit)))
  const windowMs = Math.max(1, Math.floor(config.window_ms))
  const inflightTtl = Math.max(1, Math.floor(config.inflight_ttl_ms))
  const live = new Map()        // key → 条目（Map 插入序 = 淘汰序；有界：windowMax）
  const seen = new Set()        // "已见过"指纹（有界：replayMax，配一个 FIFO 队列做淘汰）
  const seenQueue = []
  let clock = () => Date.now()
  const stats = { fresh: 0, duplicate_inflight: 0, duplicate_done: 0, replay: 0, finished: 0, failed: 0,
    expired: 0, evicted: 0, seen_evicted: 0, unknown: 0 }

  const remember = (key) => {
    if (seen.has(key)) return false
    seen.add(key)
    seenQueue.push(key)
    while (seenQueue.length > replayMax) {
      seen.delete(seenQueue.shift())
      stats.seen_evicted += 1
    }
    return true
  }

  /** 写入并可淘汰：先删再插刷新淘汰序，随后把窗口压回上界内。 */
  const put = (key, entry) => {
    live.delete(key)
    live.set(key, entry)
    while (live.size > windowMax) {
      live.delete(live.keys().next().value)
      stats.evicted += 1
    }
    return entry
  }

  const freshEntry = (key, parts, now, previous) => ({ key, method: parts.method,
    params_hash: parts.params_hash, state: 'inflight', started_at: now, finished_at: null,
    ok: null, result_digest: null, attempt: (previous?.attempt ?? 0) + 1 })

  /** key 的最终取法：调用方可用显式 key（例如内核侧已经算好的键），否则用同形推导。 */
  const keyOfInput = (input, parts) => {
    const explicit = fieldOf(input, 'key', null)
    return (typeof explicit === 'string' && explicit.length > 0) ? explicit : parts.key
  }

  /**
   * 判定一次请求该怎么走。**永远返回可解释对象**（含 reason + next_action），不返回裸 false。
   */
  const begin = (raw) => {
    const input = asRecord(raw)
    const parts = partsOf(input)
    const key = keyOfInput(input, parts)
    const now = clock()
    const base = { key, method: parts.method, correlation_id: parts.correlation_id,
      params_hash: parts.params_hash, window_ms: windowMs }
    const entry = live.get(key) ?? null

    if (entry && entry.state === 'inflight') {
      const age = now - entry.started_at
      if (age > inflightTtl) {
        stats.unknown += 1
        return { ...base, decision: 'duplicate-inflight', allowed: false, in_flight: true,
          inflight_since: entry.started_at, inflight_ms: age, inflight_ttl_exceeded: true,
          reason: 'inflight-ttl-exceeded',
          next_action: `同一请求在途已 ${age}ms 超过 TTL ${inflightTtl}ms：状态**未知**（不得当成功）。人工确认后再决定是否重试` }
      }
      stats.duplicate_inflight += 1
      return { ...base, decision: 'duplicate-inflight', allowed: false, in_flight: true,
        inflight_since: entry.started_at, inflight_ms: age,
        reason: 'in-flight',
        next_action: `同一请求正在执行（已 ${age}ms）：等它 finish 后复用结果，不要并发再打一次` }
    }

    if (entry && entry.state === 'done' && now - entry.finished_at <= windowMs) {
      const age = now - entry.finished_at
      if (entry.ok === true && entry.result_digest !== null) {
        stats.duplicate_done += 1
        return { ...base, decision: 'duplicate-done', allowed: false, reusable: true, replay: false,
          result_digest: entry.result_digest, finished_at: entry.finished_at, age_ms: age,
          reason: 'already-completed',
          next_action: '直接复用 result_digest（已完成的同一请求），不要重放副作用' }
      }
      if (entry.ok === true) {
        stats.replay += 1
        put(key, freshEntry(key, parts, now, entry))
        return { ...base, decision: 'replay', allowed: true, reusable: false, replay: true,
          previous: { ok: true, result_digest: null, finished_at: entry.finished_at },
          reason: 'completed-without-result-digest',
          next_action: '上次完成时没给 result_digest，无法复用：允许再执行一次；要复用请让调用方补上 result_digest' }
      }
      stats.replay += 1
      put(key, freshEntry(key, parts, now, entry))
      return { ...base, decision: 'replay', allowed: true, reusable: false, replay: true,
        previous: { ok: false, finished_at: entry.finished_at },
        reason: 'last-attempt-failed',
        next_action: '同一请求上次失败（失败结果**不得**被复用成成功）：允许重试，这次是一次新的执行' }
    }

    if (entry && entry.state === 'done') {          // 完成态但已出复用窗口 → 移入"已见过"指纹表
      live.delete(key)
      remember(key)
      stats.expired += 1
    }

    if (seen.has(key)) {
      stats.replay += 1
      put(key, freshEntry(key, parts, now, entry))
      return { ...base, decision: 'replay', allowed: true, reusable: false, replay: true,
        reason: 'seen-before-window-expired',
        next_action: `这是**曾经完成过**的同一请求（复用窗口 ${windowMs}ms 已过）：允许执行，但请确认是有意的重复而不是重放；要复用请提高 window_ms` }
    }

    stats.fresh += 1
    put(key, freshEntry(key, parts, now, null))
    return { ...base, decision: 'fresh', allowed: true, reusable: false, replay: false,
      reason: 'first-seen',
      next_action: '正常执行；结束时调用 finish(result_digest)，让重复投递能复用结果而不是重放副作用' }
  }

  /**
   * 落完成态（含 result_digest）。失败**不**留可复用结果：ok=false 时 result_digest 一律为 null，
   * 否则"上次失败"会被后来的重复请求当成成功结果复用 —— 这正是幂等中间件最危险的错法。
   */
  const finish = (raw) => {
    const input = asRecord(raw)
    const parts = partsOf(input)
    const key = keyOfInput(input, parts)
    const now = clock()
    const ok = fieldOf(input, 'ok', false) === true
    const entry = live.get(key) ?? null
    let digest = fieldOf(input, 'result_digest', null)
    if (ok && (digest === null || digest === undefined) && fieldOf(input, 'result', undefined) !== undefined) {
      digest = sha(canon(fieldOf(input, 'result', null)))
    }
    const resultDigest = ok && typeof digest === 'string' && digest.length > 0 ? digest : null
    const startedAt = entry?.started_at ?? now
    put(key, { key, method: parts.method, params_hash: parts.params_hash, state: 'done',
      started_at: startedAt, finished_at: now, ok, result_digest: resultDigest,
      attempt: entry?.attempt ?? 1 })
    remember(key)                       // 完成过的请求即使条目被淘汰，也还能被认成"曾见过"
    if (ok) stats.finished += 1
    else stats.failed += 1
    return { recorded: true, key, method: parts.method, params_hash: parts.params_hash,
      state: 'done', ok, result_digest: resultDigest, reusable: resultDigest !== null,
      latency_ms: now - startedAt, updated: entry !== null,
      note: entry === null ? 'created-without-begin（没先 begin 也照样挡住重复）' : 'updated',
      next_action: '同一请求再次 begin 时会判 duplicate-done 并复用 result_digest' }
  }

  ctx.provide('idempotency', {
    keyOf: (raw) => keyOfInput(asRecord(raw), partsOf(raw)),
    partsOf,
    canonicalOf: (params) => canon(params ?? null),
    begin,
    finish,
    /** 纯读取：某个键现在处于什么状态（不改任何计数、不建条目）。 */
    peek: (raw = {}) => {
      const input = asRecord(raw)
      const parts = partsOf(input)
      const key = keyOfInput(input, parts)
      const entry = live.get(key) ?? null
      return { key, present: entry !== null, state: entry?.state ?? null, ok: entry?.ok ?? null,
        result_digest: entry?.result_digest ?? null, finished_at: entry?.finished_at ?? null,
        seen: seen.has(key) }
    },
    stats: () => ({ ...stats, entries: live.size, seen: seen.size, window_max: windowMax,
      replay_memory: replayMax }),
    config: () => ({ key: config.key, window_ms: windowMs, inflight_ttl_ms: inflightTtl,
      window_max: windowMax, window_max_limit: config.window_max_limit,
      replay_memory: replayMax, replay_memory_limit: config.replay_memory_limit }),
    clear: () => {
      const cleared = live.size
      const seenCleared = seen.size
      live.clear()
      seen.clear()
      seenQueue.length = 0
      return { cleared, seen_cleared: seenCleared }
    },
    /** 注入时钟：默认 Date.now，可替换 → 窗口/TTL 判定可复现（不注册任何定时器）。 */
    setClock: (impl) => { clock = typeof impl === 'function' ? impl : () => Date.now() },
  })
}

/** fixture 采样点：**纯读取**（A5 会连跑两次比对字节；这里只读配置/统计 + 一次纯函数键推导）。 */
export const fixture = {
  sample: (handle) => ({
    config: handle.config(),
    stats: handle.stats(),
    sample_key: handle.keyOf({ method: 'quote/submit', params: { rfq_rev: 'r1', amount: 120 } }),
  }),
}
