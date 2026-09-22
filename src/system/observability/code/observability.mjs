/**
 * observability —— **运行期观测**的只读聚合插件（T-236）。
 *
 * 它做什么：把三个**运行期**中间件的状态聚成一个只读视图，供 WebUI / CLI 回读：
 *   · `governor`：准入统计与每桶剩余额度（放不放行）
 *   · `audit`   ：留痕流水统计（记了多少、去重多少、丢了多少）
 *   · `canary`  ：分流阶段与两侧样本（去哪条道、是否该回滚）
 *
 * 它**不做什么**（都是纪律，不是偷懒）：
 *   · **不写账本**（H1：账本唯一写入者是 Python 侧）——观测是观测，不是第二本账；
 *   · **不写文件**、不注册定时器、不订阅事件（A2 零残留）；
 *   · **不输出条目正文**：只给聚合数字与阶段，避免把私域/业务细节从"观测"这条侧信道漏出去；
 *   · **不依赖墙钟**：`snapshot()` 本身不产生时间戳 → 同状态下两次调用**字节一致**（可机检）。
 *
 * 为什么独立成插件：观测是横切关注点，`webui`（界面）与 CLI（运维）都要用；
 * 独立插件才能各自演进（用户要求"每个功能都应由插件提供"）。
 */
import { object, string } from '../lib/std-schema.mjs'

export const name = 'observability'
export const inject = ['governor', 'audit', 'canary']   // 三个来源都必须已挂载（CLI 保证挂载顺序）
export const builtin = []
export const usedServices = ['governor', 'audit', 'canary']
export const provides = ['observability']

export const Config = object({
  /** 视图标识：写进快照，便于前端区分数据来源 */
  view: string().default('runtime-observability'),
})

export function apply(ctx, config) {
  const sources = { governor: ctx.governor, audit: ctx.audit, canary: ctx.canary }

  /** 只读快照：没有任何写入、没有时间戳、没有条目正文。 */
  const snapshot = () => ({
    view: config.view,
    sources: Object.keys(sources),
    governor: { stats: sources.governor.stats() },
    audit: { stats: sources.audit.stats() },
    canary: { state: sources.canary.state(), stats: sources.canary.stats() },
    privacy: { private_keys_included: false, entry_bodies_included: false },
  })

  /** 人类可读摘要（CLI 里直接看） */
  const summary = () => {
    const snap = snapshot()
    const g = snap.governor.stats
    const a = snap.audit.stats
    const c = snap.canary.stats
    return [
      `governor: admitted=${g.admitted ?? 0} refused=${g.refused ?? 0} timeouts=${g.timeouts ?? 0} completed=${g.completed ?? 0} failed=${g.failed ?? 0}`,
      `audit: captured=${a.captured ?? 0} deduped=${a.deduped ?? 0} skipped=${a.skipped ?? 0} dropped=${a.dropped ?? 0}`,
      `canary: phase=${snap.canary.state.phase} base=${c.base?.count ?? 0} cand=${c.canary?.count ?? 0}`,
    ].join(' | ')
  }

  ctx.provide('observability', { snapshot, summary })
}

/** fixture：给门用（不参与运行期路径） */
export const fixture = {
  sample: (handle) => ({ view: handle.snapshot().view, sources: handle.snapshot().sources }),
}
