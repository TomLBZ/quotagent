/**
 * 进树模块：`canary` —— 自进化产物的**真实路由分流 + 自动回滚判定**。
 *
 * 位置（`ADR-0016 §3` 留的余项）：产物过门并被人工引用晋升之后，还不能算"上线"。它在真实流量上要经过
 * canary：一小部分（按 realm 与 key 决定性地分桶）走新产物，其余走 base；两侧分别累计样本；
 * 判定器比较"错误率 / 延迟 p95 / 成本"三条，**退化即建议回滚**。
 *
 * 方向性纪律（`ADR-0017`，D-021）：
 *   · **进入 canary 需要人工 `approval_ref`**（它已经影响真实流量）；**退出/回滚不需要**——
 *     回滚是安全动作，越自动越好。机器人不得自行扩大自己的上线面，但可以自行缩小。
 *
 * 三条硬纪律（与其它进树模块同形）：
 *   1) `inject` 里不写内建 mixin（`events` 等）；本模块**不使用事件总线**，样本由调用方 `record()` 推入，
 *      因此 `builtin = []`、`usedServices = []`（A1 双向断言：声明即事实）。
 *   2) 零残留（A2）：不注册定时器、不订阅总线；`ctx.provide` 只在 apply 内。
 *   3) 确定性（A5）：分桶用 sha256，**不使用墙钟/随机数**；样本按插入顺序，统计量在同一批输入下字节一致。
 */
import { createHash } from 'node:crypto'
import { array, number, object, string } from '../lib/std-schema.mjs'

export const name = 'canary'

export const inject = []

export const builtin = []

export const usedServices = []

export const provides = ['canary']

export const Config = object({
  weight_bps: number().default(500),                 // canary 分桶比例（万分比）：500 = 5%
  realms: array(string()).default([]),               // 允许进 canary 的 realm；空数组 = 全部允许
  window: number().default(200),                     // 每侧保留样本数（环形）
  min_samples: number().default(20),                 // 判定前每侧最少样本数
  thresholds: object({
    error_rate_bps_up: number().default(200),        // canary 错误率高出 base 200bp 以上 → 回滚
    latency_p95_up_bps: number().default(2000),      // canary p95 延迟高出 base 20% 以上 → 回滚
    cost_up_bps: number().default(1000),             // canary 成本高出 base 10% 以上 → 回滚
  }).default({}),
})

const LANES = ['base', 'canary']

export function apply(ctx, config) {
  const lanes = { base: [], canary: [] }
  const state = { phase: 'base', proposal: null, approval_ref: null, entered_at_seq: 0 }
  let seq = 0

  const bucket = ({ realm, key }) => {
    if (config.realms.length && !config.realms.includes(String(realm))) return 'base'
    if (!config.weight_bps) return 'base'
    if (config.weight_bps >= 10000) return 'canary'
    const digest = createHash('sha256').update(`${realm}:${key}`).digest('hex').slice(0, 8)
    return (parseInt(digest, 16) % 10000) < config.weight_bps ? 'canary' : 'base'
  }

  const percentile = (values, q) => {
    if (!values.length) return 0
    const sorted = [...values].sort((a, b) => a - b)
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
    return sorted[idx]
  }

  const laneStats = (lane) => {
    const samples = lanes[lane]
    const errors = samples.filter((item) => item.ok === false).length
    const latencies = samples.map((item) => Number(item.latency_ms) || 0)
    const cost = samples.reduce((acc, item) => acc + (Number(item.cost) || 0), 0)
    const count = samples.length || 1
    return {
      count: samples.length,
      errors,
      error_rate_bps: Math.round((errors * 10000) / count),
      latency_p95_ms: percentile(latencies, 0.95),
      latency_mean_ms: Math.round(latencies.reduce((a, b) => a + b, 0) / count),
      cost_mean_bps: Math.round((cost * 10000) / count),
    }
  }

  const worse = (canaryValue, baseValue, limitBps) => {
    if (baseValue === 0) return canaryValue > 0
    return ((canaryValue - baseValue) * 10000) / baseValue > limitBps
  }

  const verdict = () => {
    const base = laneStats('base')
    const canary = laneStats('canary')
    const reasons = []
    if (base.count < config.min_samples || canary.count < config.min_samples) {
      return { recommendation: 'insufficient', reasons: [`样本不足（base ${base.count} / canary ${canary.count}，需 ${config.min_samples}）`],
        base, canary, computed_by: 'canary-router' }
    }
    if ((canary.error_rate_bps - base.error_rate_bps) > config.thresholds.error_rate_bps_up) {
      reasons.push(`错误率 ${base.error_rate_bps} → ${canary.error_rate_bps} bp（阈值 +${config.thresholds.error_rate_bps_up}）`)
    }
    if (worse(canary.latency_p95_ms, base.latency_p95_ms, config.thresholds.latency_p95_up_bps)) {
      reasons.push(`延迟 p95 ${base.latency_p95_ms} → ${canary.latency_p95_ms} ms（阈值 +${config.thresholds.latency_p95_up_bps} bp）`)
    }
    if (worse(canary.cost_mean_bps, base.cost_mean_bps, config.thresholds.cost_up_bps)) {
      reasons.push(`成本 ${base.cost_mean_bps} → ${canary.cost_mean_bps} bp（阈值 +${config.thresholds.cost_up_bps}）`)
    }
    if (reasons.length) return { recommendation: 'rollback', reasons, base, canary, computed_by: 'canary-router' }
    const better = canary.error_rate_bps < base.error_rate_bps
      || canary.latency_p95_ms < base.latency_p95_ms
      || canary.cost_mean_bps < base.cost_mean_bps
    return { recommendation: better ? 'promote' : 'hold',
      reasons: [better ? '三条指标均不退化且至少一条更优' : '三条指标均不退化但也没有更优'],
      base, canary, computed_by: 'canary-router' }
  }

  ctx.provide('canary', {
    /** 分流（纯函数、决定性）：同一 (realm, key) 永远落同一条道。 */
    bucket,
    /** 进入 canary：**必须**带人工引用（会影响真实流量）。 */
    enterCanary: ({ proposal_id, approval_ref }) => {
      if (!approval_ref || !/^ap-\d{4,}$/.test(String(approval_ref))) {
        throw new Error('[canary-needs-approval] 进入 canary 会影响真实流量，必须带形如 ap-0001 的人工引用')
      }
      if (state.phase === 'canary') throw new Error('[canary-already-active] 已在 canary 中')
      state.phase = 'canary'
      state.proposal = proposal_id ?? null
      state.approval_ref = approval_ref
      state.entered_at_seq = seq
      return { phase: state.phase, proposal_id: state.proposal, approval_ref, weight_bps: config.weight_bps }
    },
    /** 退出 canary（回滚）：**安全动作，不需要人工批准**；自动回滚就走这里。 */
    exitCanary: ({ reason }) => {
      if (state.phase !== 'canary') throw new Error('[canary-not-active] 当前不在 canary 中')
      const closed = { phase: 'base', proposal_id: state.proposal, reason: reason ?? 'manual',
        weight_bps: 0, approval_ref: state.approval_ref, samples_seen: seq - state.entered_at_seq }
      state.phase = 'base'
      state.proposal = null
      state.approval_ref = null
      return closed
    },
    record: ({ lane, ok, latency_ms, cost }) => {
      const target = LANES.includes(lane) ? lane : 'base'
      lanes[target].push({ ok, latency_ms, cost })
      seq += 1
      while (lanes[target].length > config.window) lanes[target].shift()
      return { lane: target, count: lanes[target].length, seq }
    },
    stats: () => ({ base: laneStats('base'), canary: laneStats('canary'), phase: state.phase, seq }),
    verdict,
    /** 自动回滚判定：退化即回滚（安全），更优也只是"建议晋升"（仍需人工）。 */
    decide: () => {
      const v = verdict()
      if (v.recommendation === 'rollback') {
        return { action: 'rollback', automatic: true, approval_required: false, verdict: v }
      }
      if (v.recommendation === 'promote') {
        return { action: 'promote', automatic: false, approval_required: true, verdict: v }
      }
      return { action: 'hold', automatic: false, approval_required: false, verdict: v }
    },
    state: () => ({ ...state, weight_bps: config.weight_bps, realms: config.realms }),
  })
}

/** A5 采样点：同一输入两次必须字节一致（分桶是纯哈希，统计量按插入序）。 */
export const fixture = {
  sample: (handle) => ({
    buckets: ['r-1|k-1', 'r-1|k-2', 'r-2|k-9'].map((pair) => {
      const [realm, key] = pair.split('|')
      return `${realm}|${key}=${handle.bucket({ realm, key })}`
    }),
    verdict: handle.decide().action,
  }),
}
