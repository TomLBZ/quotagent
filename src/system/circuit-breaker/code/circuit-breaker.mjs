/**
 * circuit-breaker —— 运行期**熔断**中间件（T-241，第三个自进化产出，第一个中间件）。
 *
 * 与既有中间件的分工（写清才不重复）：
 *   · `governor`：按**额度**限流 / 显式超时 / 有界重试 —— 管"放不放行、等多久、重试几次"；
 *   · `canary`  ：决定请求**去哪条道**（base 还是候选）+ 退化判定；
 *   · 本模块    ：按**失败**切断 —— 连续失败达阈值就打开断路器，期间**快速失败**（不再打下游），
 *                冷却后进入 half-open 试探，试探成功才合上。
 *
 * 纪律：
 *   · 不写账本（H1）、不写文件、不订阅事件、不注册定时器（冷却用**注入的时钟**判断，不用定时器）；
 *   · 不依赖墙钟：默认时钟可被 `setClock()` 替换 → 同序列可复现（判定与真实时间无关）；
 *   · 拒绝可解释：`allow()` 一律给出 `state` 与 `retry_after_ms`，不返回裸 false；
 *   · 有界：半开试探次数有硬上界，避免"半开"变成事实上的全开。
 */
import { number, object, string } from '../lib/std-schema.mjs'

export const name = 'circuit-breaker'
export const inject = []
export const builtin = []
export const usedServices = []
export const provides = ['breaker']

export const Config = object({
  key: string().default('host'),          // 默认熔断键（按 key 分桶：一个下游坏了不牵连其它）
  failure_threshold: number().default(5), // 连续失败多少条就打开
  cooldown_ms: number().default(1000),    // 打开后多久允许试探
  half_open_max: number().default(1),     // 半开态最多放几次试探（硬上界 3）
  half_open_limit: number().default(3),   // 配置也不许超过它
})

export function apply(ctx, config) {
  const halfOpenMax = Math.min(Math.max(1, config.half_open_max), config.half_open_limit)
  const buckets = new Map()   // key → {state, consecutive_failures, opened_at, half_open_used, opened_count}
  let clock = () => Date.now()
  const stats = { allowed: 0, refused: 0, opened: 0, closed: 0, half_open_tried: 0, half_open_ok: 0 }

  const bucketOf = (key) => {
    if (!buckets.has(key)) {
      buckets.set(key, { state: 'closed', consecutive_failures: 0, opened_at: null, half_open_used: 0, opened_count: 0 })
    }
    return buckets.get(key)
  }

  /** 到冷却时间就自动进入 half-open（用**注入的时钟**判断，不注册定时器） */
  const refresh = (bucket) => {
    if (bucket.state === 'open' && bucket.opened_at !== null && clock() - bucket.opened_at >= config.cooldown_ms) {
      bucket.state = 'half-open'
      bucket.half_open_used = 0
    }
    return bucket
  }

  const allow = ({ key = config.key } = {}) => {
    const bucket = refresh(bucketOf(key))
    if (bucket.state === 'open') {
      stats.refused += 1
      return { allowed: false, state: 'open', retry_after_ms: Math.max(0, config.cooldown_ms - (clock() - bucket.opened_at)),
        reason: 'circuit-open', next_action: '等冷却或改用降级路径' }
    }
    if (bucket.state === 'half-open') {
      if (bucket.half_open_used >= halfOpenMax) {
        stats.refused += 1
        return { allowed: false, state: 'half-open', retry_after_ms: 0, reason: 'half-open-budget-exhausted',
          next_action: '本次试探额度已用完，等下一次冷却' }
      }
      bucket.half_open_used += 1
      stats.half_open_tried += 1
      return { allowed: true, state: 'half-open', probe: true, retry_after_ms: 0 }
    }
    stats.allowed += 1
    return { allowed: true, state: 'closed', retry_after_ms: 0 }
  }

  const record = ({ key = config.key, ok }) => {
    const bucket = refresh(bucketOf(key))
    if (ok) {
      if (bucket.state === 'half-open') stats.half_open_ok += 1
      bucket.consecutive_failures = 0
      if (bucket.state !== 'closed') { bucket.state = 'closed'; stats.closed += 1 }
      bucket.opened_at = null
      bucket.half_open_used = 0
      return { state: bucket.state, consecutive_failures: 0 }
    }
    bucket.consecutive_failures += 1
    if (bucket.state === 'half-open') {
      // 试探失败 → 立刻重新打开（并重置冷却起点）
      bucket.state = 'open'
      bucket.opened_at = clock()
      bucket.opened_count += 1
      stats.opened += 1
      return { state: 'open', consecutive_failures: bucket.consecutive_failures, reason: 'probe-failed' }
    }
    if (bucket.consecutive_failures >= config.failure_threshold) {
      bucket.state = 'open'
      bucket.opened_at = clock()
      bucket.half_open_used = 0
      if (bucket.opened_count === 0) stats.opened += 1
      bucket.opened_count += 1
      return { state: 'open', consecutive_failures: bucket.consecutive_failures, reason: 'threshold-reached' }
    }
    return { state: bucket.state, consecutive_failures: bucket.consecutive_failures }
  }

  ctx.provide('breaker', {
    allow,
    record,
    state: ({ key = config.key } = {}) => {
      const bucket = refresh(bucketOf(key))
      return { key, state: bucket.state, consecutive_failures: bucket.consecutive_failures,
        half_open_used: bucket.half_open_used, opened_count: bucket.opened_count }
    },
    stats: () => ({ ...stats, buckets: Object.fromEntries([...buckets].map(([k, v]) => [k, v.state])) }),
    config: () => ({ key: config.key, failure_threshold: config.failure_threshold, cooldown_ms: config.cooldown_ms,
      half_open_max: halfOpenMax, half_open_limit: config.half_open_limit }),
    setClock: (impl) => { clock = impl ?? (() => Date.now()) },
  })
}

/** fixture：纯读取（A5 会连跑两次比对字节；这里只读状态，不下判定） */
export const fixture = {
  sample: (handle) => ({ state: handle.state(), config: handle.config() }),
}
