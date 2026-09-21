/**
 * evidence-summary —— 账本"证据面"的只读统计插件（T-239，第二次自进化产出）。
 *
 * 与 observability 的分工（避免造轮子/重复）：
 *   · `observability` 聚合的是**运行期中间件状态**（内存里的准入/留痕/分流统计）；
 *   · 本插件聚合的是**账本内容本身**（落盘的事实）：各事件类型计数、时间跨度、涉及多少个关联、
 *     以及"有多少条被引用（refs）"——用来一眼回答"这本账里到底发生了什么、够不够审计"。
 *
 * 边界（纪律）：
 *   · 只读：不写账本（H1）、不写文件、不订阅事件、不注册定时器；
 *   · 不输出条目正文，只输出**计数与跨度**（聚合不得成为侧信道）；
 *   · 确定性：键排序、无墙钟、无随机 → 同输入两次字节一致。
 */
import { object, string } from '../lib/std-schema.mjs'

export const name = 'evidence-summary'
export const inject = []
export const builtin = []
export const usedServices = []
export const provides = ['evidenceSummary']

export const Config = object({
  time_field: string().default('ts'),
})

/** 纯函数：按事件类型计数（键排序 → 确定性） */
export const byType = (rows) => {
  const counts = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue
    const type = String(row.type ?? '(unknown)')
    counts.set(type, (counts.get(type) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0)))
    .map(([type, count]) => ({ type, count }))
}

/** 纯函数：时间跨度（只比较字符串序，**不解析时间**——不猜时区、不引入墙钟） */
export const span = (rows, timeField = 'ts') => {
  const stamps = (Array.isArray(rows) ? rows : [])
    .map((row) => (row && typeof row === 'object' ? row[timeField] : null))
    .filter((value) => typeof value === 'string' && value.length > 0)
    .sort()
  if (!stamps.length) return { count: 0, first: null, last: null }
  return { count: stamps.length, first: stamps[0], last: stamps[stamps.length - 1] }
}

export function apply(ctx, config) {
  const timeField = config?.time_field ?? 'ts'
  const summarize = (rows) => {
    const list = Array.isArray(rows) ? rows : []
    const correlations = new Set(list.map((row) => (row && typeof row === 'object' ? String(row.correlation_id ?? '') : ''))
      .filter((value) => value.length > 0))
    const withRefs = list.filter((row) => row && typeof row === 'object'
      && Array.isArray(row.refs) && row.refs.length > 0).length
    return {
      rows: list.length,
      types: byType(list).length,
      by_type: byType(list),
      correlations: correlations.size,
      rows_with_refs: withRefs,
      span: span(list, timeField),
    }
  }
  ctx.provide('evidenceSummary', { summarize, byType: (rows) => byType(rows) })
}

/** fixture：纯读取（A5 会连跑两次比对字节） */
export const fixture = {
  sample: (handle) => ({
    out: handle.summarize([
      { type: 'rfq/published', correlation_id: 'c-1', ts: '2026-09-21T00:00:00Z', refs: [] },
      { type: 'quote/submitted', correlation_id: 'c-1', ts: '2026-09-21T01:00:00Z', refs: ['ledger:1'] },
    ]),
    byType: handle.byType([{ type: 'b' }, { type: 'a' }, { type: 'a' }]),
  }),
}
