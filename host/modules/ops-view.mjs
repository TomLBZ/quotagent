/**
 * ops-view —— **运维视角**的只读视图插件（T-243，第四个自进化产出）。
 *
 * 为什么单独一个视角：本项目已有两个**业务视角**（contractor / supplier，各自只见自己的账本与投影）。
 * 运维要回答的是另一类问题："系统现在健康吗？谁在拦流量？账本证据面如何？"——这类视图**不属于任何一方**，
 * 混进业务视角既会污染对方可见面，也会让运维信息被业务权限的写法绑住。
 *
 * 分工（不重复造轮子）：
 *   · `observability`：运行期三源（governor/audit/canary）的只读聚合；
 *   · `breaker`      ：熔断状态与统计；
 *   · `evidenceSummary`：账本证据面（只吃调用方给的**已投影**行）；
 *   · 本模块         ：把上面三者**编排成一个运维快照** + 一段人类可读摘要。不自己做统计，只做组合。
 *
 * 纪律：只读（不写账本/文件）、不订阅事件、不注册定时器、不使用墙钟（同状态两次快照字节一致）、
 * 不输出任何条目正文（聚合只给数字与状态）。
 */
import { object, string } from '../lib/std-schema.mjs'

export const name = 'ops-view'
export const inject = ['observability', 'breaker', 'evidenceSummary']
export const builtin = []
export const usedServices = ['observability', 'breaker', 'evidenceSummary']
export const provides = ['opsView']

export const Config = object({
  view: string().default('ops'),
})

export function apply(ctx, config) {
  const obs = ctx.observability
  const breaker = ctx.breaker
  const evidence = ctx.evidenceSummary

  /** 运维快照：**只组合**，不产生新统计口径；`rows` 由调用方给（必须是已投影的公开行）。 */
  const snapshot = ({ rows = [] } = {}) => {
    const runtime = obs.snapshot()
    const breakerStats = breaker.stats()
    return {
      view: config.view,
      runtime: {
        governor: runtime.governor.stats,
        audit: runtime.audit.stats,
        canary: { state: runtime.canary.state, stats: runtime.canary.stats },
      },
      breaker: { stats: breakerStats, buckets: breakerStats.buckets },
      evidence: evidence.summarize(rows),
      sources: ['observability', 'breaker', 'evidenceSummary'],
      privacy: { entry_bodies_included: false, private_keys_included: false },
    }
  }

  /** 人类可读摘要（一眼看清"系统现在什么状态"） */
  const summary = ({ rows = [] } = {}) => {
    const snap = snapshot({ rows })
    const g = snap.runtime.governor
    const b = snap.breaker.stats
    const c = snap.runtime.canary
    return [
      `governor: admitted=${g.admitted ?? 0} refused=${g.refused ?? 0} timeouts=${g.timeouts ?? 0} failed=${g.failed ?? 0}`,
      `breaker: allowed=${b.allowed ?? 0} refused=${b.refused ?? 0} opened=${b.opened ?? 0} closed=${b.closed ?? 0}`,
      `canary: phase=${c.state?.phase ?? '?'} base=${c.stats?.base?.count ?? 0} cand=${c.stats?.canary?.count ?? 0}`,
      `evidence: rows=${snap.evidence.rows ?? 0} types=${snap.evidence.types ?? 0}`,
    ].join(' | ')
  }

  ctx.provide('opsView', { snapshot, summary })
}

/** fixture：纯读取（A5 连跑两次比对字节） */
export const fixture = {
  sample: (handle) => ({ summary: handle.summary({ rows: [] }), snap: handle.snapshot({ rows: [] }) }),
}
