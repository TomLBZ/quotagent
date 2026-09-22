/**
 * evolve-journal —— "自进化流水"的只读归纳插件（T-245，第五个自进化产出）。
 *
 * 它归纳的是**自进化账本**（`evolve/*` 事件）的内容：一共提过多少案、影子多少次、门过了几次/拒了几次、
 * 晋升几次、回滚几次、canary 进/出几次，以及**最近一次**是什么。
 *
 * 为什么需要它：canary 的决策与自动回滚是本项目最重要的安全机制，但目前只能在命令输出里看到。
 * 运维视角要能回答"最近有没有东西被门拦下？有没有自动回滚过？"——这就是它的职责。
 *
 * 边界（纪律）：
 *   · 只读：不写账本（H1）、不写文件、不订阅事件、不注册定时器；
 *   · **只输出计数与类型**，绝不输出条目正文（对账本内容的"聚合"同样不能变成侧信道）；
 *   · 判定不依赖墙钟（只比较 `ts` 字符串，不解析时间）；
 *   · 确定性：键排序、无随机 → 同输入两次字节一致。
 */
import { number, object } from '../lib/std-schema.mjs'

export const name = 'evolve-journal'
export const inject = []
export const builtin = []
export const usedServices = []
export const provides = ['evolveJournal']

export const Config = object({
  recent_limit: number().default(3),   // 最近决策保留条数（有界，避免摘要变成全量转储）
})

/** 关注的自进化事件（与 Python 侧 `tools/evolve-record.py` 的白名单一致；出现新事件不影响计数正确性） */
export const KNOWN = ['evolve/proposed', 'evolve/shadowed', 'evolve/gated', 'evolve/promoted',
  'evolve/rolled-back', 'evolve/canary-entered', 'evolve/canary-exited']

export function apply(ctx, config) {
  const limit = Math.max(0, Math.min(Number(config.recent_limit ?? 3), 10))

  const summarize = (rows) => {
    const list = Array.isArray(rows) ? rows.filter((row) => row && typeof row === 'object') : []
    const counts = new Map()
    for (const row of list) {
      const type = String(row.type ?? '(unknown)')
      counts.set(type, (counts.get(type) ?? 0) + 1)
    }
    const byType = [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0)))
      .map(([type, count]) => ({ type, count }))
    const countOf = (type) => counts.get(type) ?? 0
    // 门的两态：passed / rejected（只取 verdict，不取正文）
    const gated = list.filter((row) => row.type === 'evolve/gated')
    const verdicts = { passed: 0, rejected: 0 }
    const rejections = []
    for (const row of gated) {
      const verdict = String(row.body?.verdict ?? 'unknown')
      if (verdict === 'passed') verdicts.passed += 1
      else {
        verdicts.rejected += 1
        rejections.push({ verdict, reasons: Array.isArray(row.body?.reasons) ? row.body.reasons.length : 0 })
      }
    }
    // 最近 N 条（按行序取尾部；不解析时间、不排序 → 顺序即账本顺序，确定性）
    const recent = list.slice(-limit).map((row) => ({ type: String(row.type ?? '(unknown)') }))
    const last = list.length ? String(list[list.length - 1].type ?? '(unknown)') : null
    return {
      rows: list.length,
      by_type: byType,
      proposed: countOf('evolve/proposed'),
      shadowed: countOf('evolve/shadowed'),
      gated: { total: gated.length, ...verdicts, recent_rejections: rejections.slice(-limit) },
      promoted: countOf('evolve/promoted'),
      rolled_back: countOf('evolve/rolled-back'),
      canary: { entered: countOf('evolve/canary-entered'), exited: countOf('evolve/canary-exited') },
      unknown_types: byType.filter((item) => !KNOWN.includes(item.type)).map((item) => item.type),
      recent,
      last_event: last,
      privacy: { entry_bodies_included: false },
    }
  }

  ctx.provide('evolveJournal', { summarize })
}

/** fixture：纯读取（A5 连跑两次比对字节） */
export const fixture = {
  sample: (handle) => handle.summarize([
    { type: 'evolve/proposed', body: { id: 'p1' } },
    { type: 'evolve/gated', body: { verdict: 'rejected', reasons: ['a', 'b'] } },
    { type: 'evolve/canary-exited', body: { automatic: true } },
  ]),
}
