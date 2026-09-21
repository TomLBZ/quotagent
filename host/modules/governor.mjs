/**
 * 进树模块：`governor` —— 运行期**准入与等待**中间件（限流/背压 + 超时 + 有界重试）。
 *
 * 与 `canary` 的分工（互补，各自独立演进）：
 *   · `canary` 决定一次请求**去哪条道**（base / 候选）；
 *   · `governor` 决定**放不放行、等多久、失败重试几次**。
 *
 * 三条纪律：
 *   1) **拒绝必须可解释**：`admit()` 被拒时给出 `reason` 与 `retry_after_ms`（不返回裸 false）。
 *   2) **超时必须显式**：超时是**错误**（`timeout`），不是"静默重试到成功"；重试次数有上界（配置）。
 *   3) **不写任何东西**：本模块只做准入与等待，不碰账本、不写文件（H1 与"运行不写仓库外文件"）。
 *      也**不使用墙钟做决策**：默认时钟可被 `setClock()` 替换，测试用假时钟 → 判定可复现。
 */
import { number, object, string } from '../lib/std-schema.mjs'

export const name = 'governor'

export const inject = []

export const builtin = []

export const usedServices = []

export const provides = ['governor']

export const Config = object({
  key: string().default('host'),          // 默认限流桶的键（按 key 分桶：不同接口互不挤占）
  capacity: number().default(64),         // 每个桶的容量（credits）
  timeout_ms: number().default(5000),     // 单次调用的默认超时
  max_retries: number().default(0),       // 默认不重试（要重试必须显式声明，且受上界约束）
  retry_backoff_ms: number().default(50), // 重试间隔（确定性：固定间隔，不用随机退避）
  retry_limit: number().default(3),       // 硬上界：配置也不许超过它
})

export class GovernorError extends Error {
  constructor(code, message, detail = {}) {
    super(`[${code}] ${message}`)
    this.name = 'GovernorError'
    this.code = code
    this.detail = detail
  }
}

export function apply(ctx, config) {
  const buckets = new Map()
  const stats = { admitted: 0, refused: 0, timeouts: 0, retries: 0, completed: 0, failed: 0 }
  let clock = () => Date.now()
  const sleep = (ms) => new Promise((resolve) => { clock.__sleep ? clock.__sleep(ms, resolve) : setTimeout(resolve, ms) })

  const bucketOf = (key) => {
    if (!buckets.has(key)) buckets.set(key, { credits: config.capacity, capacity: config.capacity })
    return buckets.get(key)
  }

  ctx.provide('governor', {
    /** 准入：拿不到 credit 就拒绝，并说清"什么时候再来"（不是裸 false）。 */
    admit: ({ key = config.key, cost = 1 } = {}) => {
      const bucket = bucketOf(key)
      if (bucket.credits >= cost) {
        bucket.credits -= cost
        stats.admitted += 1
        return { admitted: true, key, remaining: bucket.credits, capacity: bucket.capacity }
      }
      stats.refused += 1
      return { admitted: false, key, remaining: bucket.credits, capacity: bucket.capacity,
        reason: 'credit-exhausted', retry_after_ms: config.retry_backoff_ms,
        next_action: `等待 ${config.retry_backoff_ms}ms 后重试，或先 release() 归还额度` }
    },
    /** 归还额度（调用方结束一次占用的调用；幂等：多个 release 不会超容量）。 */
    release: ({ key = config.key, cost = 1 } = {}) => {
      const bucket = bucketOf(key)
      bucket.credits = Math.min(bucket.capacity, bucket.credits + cost)
      return { key, remaining: bucket.credits }
    },
    /**
     * 包一次调用：准入 → 超时 → （有界）重试。
     * `fn` 拿到一个 `signal`（AbortSignal 语义的 `{aborted}`）以便协作式中断；不遵守也不会让超时失效（本函数直接返回/抛出）。
     */
    run: async ({ key = config.key, fn, timeout_ms = config.timeout_ms, retries = config.max_retries,
      on_timeout_ms } = {}) => {
      if (typeof fn !== 'function') throw new GovernorError('governor-needs-fn', 'run 需要 fn 函数')
      const allowed = Math.max(0, Math.min(Number(retries) || 0, config.retry_limit))
      if (Number(retries) > config.retry_limit) {
        throw new GovernorError('retry-limit-exceeded',
          `请求重试 ${retries} 次超过硬上界 ${config.retry_limit}（不许无界重试）`)
      }
      const admission = ctx.governor.admit({ key })
      if (!admission.admitted) {
        const err = new GovernorError('backpressure', `额度耗尽（key=${key}）`, admission)
        err.detail = admission
        throw err
      }
      let attempt = 0
      let lastError = null
      while (attempt <= allowed) {
        attempt += 1
        const signal = { aborted: false }
        let timer = null
        try {
          const result = await new Promise((resolve, reject) => {
            timer = setTimeout(() => {
              signal.aborted = true
              reject(new GovernorError('timeout', `调用超时（${timeout_ms}ms，key=${key}）`,
                { key, timeout_ms, attempt }))
            }, timeout_ms)
            Promise.resolve().then(() => fn(signal)).then(resolve, reject)
          })
          clearTimeout(timer)
          stats.completed += 1
          ctx.governor.release({ key })
          return { ok: true, attempts: attempt, result }
        } catch (err) {
          clearTimeout(timer)
          lastError = err
          if (err?.code === 'timeout') {
            stats.timeouts += 1
            if (attempt > allowed) {
              ctx.governor.release({ key })
              stats.failed += 1
              throw err                                    // 超时且重试用尽 → **显式**抛出
            }
          } else if (attempt > allowed) {
            ctx.governor.release({ key })
            stats.failed += 1
            throw err
          }
          stats.retries += 1
          await sleep(config.retry_backoff_ms)
        }
      }
      ctx.governor.release({ key })
      throw lastError ?? new GovernorError('governor-unreachable', 'run 走到了不可达分支')
    },
    stats: () => ({ ...stats, buckets: Object.fromEntries([...buckets].map(([k, v]) => [k, v.credits])) }),
    /** 测试钩子：替换时钟（默认 Date.now）与 sleep 实现 → 判定可复现（不依赖真实时间）。 */
    setClock: (impl, sleepImpl) => { clock = impl ?? (() => Date.now()); clock.__sleep = sleepImpl ?? null },
    config: () => ({ key: config.key, capacity: config.capacity, timeout_ms: config.timeout_ms,
      max_retries: config.max_retries, retry_limit: config.retry_limit, retry_backoff_ms: config.retry_backoff_ms }),
  })
}

/** A5 采样点：只回配置与初始额度（不含时间/随机 → 字节可复现）。 */
export const fixture = {
  // 必须**纯读取**：采样会连着跑两次并要求字节一致，任何"顺手扣一次额度"都会让第二次不同（实测踩到）
  sample: (handle) => ({ config: handle.config(), stats: handle.stats() }),
}
