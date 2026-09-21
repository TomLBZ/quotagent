/**
 * price-history —— 价格历史的只读领域插件（**由自进化流程产出的第一个进树插件**，T-237）。
 *
 * 能力：拿"已经投影过的只读行"，按供应商聚合价格序列的描述统计：
 * 报价次数、最低/中位/最高、最新价、以及**离散**趋势方向（up/down/flat）。
 *
 * 边界（纪律）：
 *   · **只读**：不写账本（H1）、不写文件、不订阅事件、不注册定时器；
 *   · **不引入人工门**：不产生需要人签字的动作（晋升门"人工介入率不上升"据此）；
 *   · **确定性**：同一组行 → 同一份输出（排序固定、无墙钟、无随机）；
 *   · **不猜口径**：价格按调用方给的字段取，缺失即缺失（不在决策里做归一化，P6）。
 */
import { object, string } from '../lib/std-schema.mjs'

export const name = 'price-history'
export const inject = []
export const builtin = []
export const usedServices = []
export const provides = ['priceHistory']

export const Config = object({
  price_field: string().default('unit_price'),
  key_field: string().default('supplier_id'),
})

const num = (value) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** 纯函数：某供应商的价格序列（保持账本行序） */
export const seriesFor = (rows, supplierId, { price_field = 'unit_price', key_field = 'supplier_id' } = {}) =>
  (Array.isArray(rows) ? rows : [])
    .filter((row) => row && typeof row === 'object' && String(row[key_field] ?? '') === String(supplierId))
    .map((row) => num(row[price_field]))
    .filter((value) => value !== null)

const median = (values) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** 纯函数：描述统计 + 离散趋势（只比首尾，不做拟合——不猜模型、不编数值） */
export const describe = (values) => {
  if (!values.length) return { count: 0, min: null, median: null, max: null, latest: null, trend: 'unknown' }
  const first = values[0]
  const last = values[values.length - 1]
  const trend = values.length < 2 ? 'flat' : (last > first ? 'up' : (last < first ? 'down' : 'flat'))
  return { count: values.length, min: Math.min(...values), median: median(values), max: Math.max(...values),
    latest: last, trend }
}

export function apply(ctx, config) {
  const cfg = config ?? {}
  const opts = { price_field: cfg.price_field ?? 'unit_price', key_field: cfg.key_field ?? 'supplier_id' }
  ctx.provide('priceHistory', {
    forSupplier: (rows, supplierId) => describe(seriesFor(rows, supplierId, opts)),
    /** 全部供应商（键排序 → 确定性） */
    bySupplier: (rows) => {
      const keys = [...new Set((Array.isArray(rows) ? rows : [])
        .map((row) => (row && typeof row === 'object' ? row[opts.key_field] : null))
        .filter((key) => key !== null && key !== undefined)
        .map(String))].sort()
      return keys.map((key) => ({ supplier_id: key, ...describe(seriesFor(rows, key, opts)) }))
    },
  })
}

/** fixture：纯读取（不得有副作用——A5 连跑两次比对字节） */
export const fixture = {
  sample: (handle) => ({
    one: handle.forSupplier([{ supplier_id: 'sup-A', unit_price: 10 }, { supplier_id: 'sup-A', unit_price: 12 }], 'sup-A'),
    all: handle.bySupplier([{ supplier_id: 'sup-B', unit_price: 5 }, { supplier_id: 'sup-A', unit_price: 9 }]),
  }),
}
