/**
 * supplier-scorecard —— 供应商绩效记分卡的只读领域插件（T-247 候选产物，尚未进树）。
 *
 * 能力：吃调用方传入的**只读行**（账本投影后的行数组，本插件不自己去捞数据），按供应商聚合出一张记分卡：
 *   · `scorecard(rows)`  —— 对给定行集合（通常已按供应商筛过）算一次汇总：归属行数、涉及供应商数、
 *     报价次数、最低/中位/最高单价、平均交期天数、偏差标记数；
 *   · `bySupplier(rows)` —— 按供应商键分组，返回**键字典序排好**的记分卡数组（条目数受 `max_suppliers` 夹取）。
 *
 * 与已有插件的分工（为什么不是重复造轮子）：
 *   · `price-history`：单个供应商的**价格序列**描述统计 + 首尾趋势（不看交期、不看偏差标记、不给跨供应商面）；
 *   · `evidence-summary`：账本**按事件类型**计数与时间跨度（主键是事件类型，不是供应商）；
 *   · `sourcing`：RFQ 覆盖率与缺口（主键是包，回答「谁没报价」）；
 *   · 本插件补的是它们之间的空白：**以供应商为主键**，把「报价次数 / 价格分布 / 交期 / 偏差标记」并成
 *     一个可跨供应商比较的绩效面。只对调用方给的行做算术，**不引入新口径**：不归一化、不拟合、不排名打分、
 *     不做任何业务判定（评分若由模型自造就会变成不可审计的事实，故一律不产出）。
 *
 * 边界（纪律）：
 *   · **只读**：不写账本（H1）、不写文件、不订阅事件、不注册定时器、不读墙钟、不用随机数；
 *   · **确定性**：同输入两次输出字节一致（分组键显式字典序排序；输出里不含时间戳、不含自增序号）；
 *   · **不编造**：字段取不到就**跳过**——缺单价不进价格统计（记 null，不是 0），缺交期不进均值（记 null）；
 *     非有限数（NaN/Infinity）与字符串数字都按「取不到」处理（不猜、不解析）；行的供应商键缺失 → 该行不进
 *     任何分组（**不造 (unassigned) 占位桶**），只体现在 `scorecard` 的行计数里；
 *   · **不写调用方的数据**：绝不改写传入的行数组或行对象（对冻结输入同样可用）；
 *   · **有界输出**：`max_suppliers` 在 [1, 1000] 内夹取，越界配置不得让输出无界膨胀（夹取是显式契约，
 *     非有限数回落到默认值 200 —— 不静默放行、也不静默变成 0）。
 */
import { object, string, number } from '../lib/std-schema.mjs'

export const name = 'supplier-scorecard'
export const inject = []
export const builtin = []
export const usedServices = []
export const provides = ['supplierScorecard']

export const Config = object({
  // 行上的键名（默认与账本/投影行的既有写法一致）
  key_field: string().default('supplier_id'),
  // 单价字段名（输出字段名固定为 min/median/max_unit_price —— 配置只换**输入**字段，不改输出契约）
  price_field: string().default('unit_price'),
  // 交期字段名（天）；缺这个字段的供应商 `avg_lead_time_days` 记 null
  lead_time_field: string().default('lead_time_days'),
  // 偏差标记字段名（真值口径见 isFlagged）
  deviation_field: string().default('deviation'),
  // 一次返回的供应商条目上限（夹取区间 [1, 1000]）
  max_suppliers: number().default(200),
})

/** 夹取上界 / 下界 / 默认值（`max_suppliers` 的显式契约，越界夹取而不是忽略配置）。 */
const CEILING = 1000
const FLOOR = 1
const FALLBACK = 200

/** 显式字典序比较器：不依赖默认排序的隐含规则，也不受 locale 影响（确定性要求）。 */
const byLex = (left, right) => (left < right ? -1 : left > right ? 1 : 0)

const listOf = (rows) => (Array.isArray(rows) ? rows : [])

const isRow = (row) => Boolean(row) && typeof row === 'object' && !Array.isArray(row)

/**
 * 取值顺序是契约：先看行上的同名键，再看行 `body` 里的同名键（账本行形状是 `{seq,type,body}`）；
 * 两处都没有 → `undefined`（**不补默认值**）。别名/回退只在这一处识别，调用方不必各记一遍。
 */
const pick = (row, field) => {
  if (!isRow(row)) return undefined
  const direct = row[field]
  if (direct !== undefined && direct !== null) return direct
  const body = row.body
  if (isRow(body)) {
    const nested = body[field]
    if (nested !== undefined && nested !== null) return nested
  }
  return undefined
}

/** 只有有限数字才算一个值；NaN / ±Infinity / 字符串数字一律按「取不到」处理（不解析、不猜）。 */
const numOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/** 否定词表（偏差标记口径用）：字符串形式的「没有标记」写法。 */
const NEGATIVE_WORDS = ['false', '0', 'no', 'n', 'none', 'null']

/**
 * 偏差标记的真值口径（**只在这一处**，写死避免各处各记一遍）：
 *   true 算标记；false / null / undefined 不算；非 0 有限数字算；
 *   非空且不在否定词表里的字符串算；非空数组算；其余不算。
 */
const isFlagged = (value) => {
  if (value === true) return true
  if (value === false || value === undefined || value === null) return false
  const amount = numOrNull(value)
  if (amount !== null) return amount !== 0
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    return text !== '' && !NEGATIVE_WORDS.includes(text)
  }
  if (Array.isArray(value)) return value.length > 0
  return false
}

/** 中位数：偶数个取中间两数的平均（空集合 → null，不编 0）。 */
const median = (values) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** 供应商键：只认非空字符串与有限数字（其余按「没有键」处理 → 不造占位桶）；统一成字符串再分组。 */
const keyOf = (row, field) => {
  const value = pick(row, field)
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : null
  }
  if (typeof value === 'string') {
    const text = value.trim()
    return text === '' ? null : text
  }
  return null
}

/** 纯函数：对一组行算记分卡（只读入参，不写回）。 */
export const scorecardOf = (rows, options) => {
  const list = listOf(rows)
  const keys = new Set()
  const prices = []
  const leadTimes = []
  let quotes = 0
  let flagged = 0
  for (const row of list) {
    if (!isRow(row)) continue
    const key = keyOf(row, options.key_field)
    if (key === null) continue          // 无键行不进分组统计（不造 (unassigned) 桶）
    keys.add(key)
    quotes += 1
    const price = numOrNull(pick(row, options.price_field))
    if (price !== null) prices.push(price)
    const lead = numOrNull(pick(row, options.lead_time_field))
    if (lead !== null) leadTimes.push(lead)
    if (isFlagged(pick(row, options.deviation_field))) flagged += 1
  }
  const leadSum = leadTimes.reduce((sum, value) => sum + value, 0)
  return {
    rows: list.length,
    suppliers: keys.size,
    quote_count: quotes,
    priced_count: prices.length,
    min_unit_price: prices.length ? Math.min(...prices) : null,
    median_unit_price: median(prices),
    max_unit_price: prices.length ? Math.max(...prices) : null,
    lead_time_count: leadTimes.length,
    avg_lead_time_days: leadTimes.length ? leadSum / leadTimes.length : null,
    deviation_count: flagged,
  }
}

/** 纯函数：按供应商分组（键字典序 → 输出顺序与入参顺序无关），并按 `max_suppliers` 截取前缀。 */
export const groupBySupplier = (rows, options) => {
  const buckets = new Map()
  for (const row of listOf(rows)) {
    if (!isRow(row)) continue
    const key = keyOf(row, options.key_field)
    if (key === null) continue
    const bucket = buckets.get(key)
    if (bucket) bucket.push(row)
    else buckets.set(key, [row])
  }
  return [...buckets.keys()].sort(byLex).slice(0, options.max_suppliers)
    .map((key) => ({ supplier_id: key, ...scorecardOf(buckets.get(key), options) }))
}

/** 配置夹取：有限数按 [1, 1000] 夹；非有限数/缺省 → 默认 200（不静默放行成无界，也不静默归 0）。 */
const clampLimit = (value) => {
  const amount = numOrNull(value)
  if (amount === null) return FALLBACK
  return Math.min(CEILING, Math.max(FLOOR, Math.floor(amount)))
}

const textOr = (value, fallback) => (typeof value === 'string' && value !== '' ? value : fallback)

export function apply(ctx, config) {
  const cfg = config ?? {}
  const options = Object.freeze({
    key_field: textOr(cfg.key_field, 'supplier_id'),
    price_field: textOr(cfg.price_field, 'unit_price'),
    lead_time_field: textOr(cfg.lead_time_field, 'lead_time_days'),
    deviation_field: textOr(cfg.deviation_field, 'deviation'),
    max_suppliers: clampLimit(cfg.max_suppliers),
  })
  ctx.provide('supplierScorecard', {
    scorecard: (rows) => scorecardOf(rows, options),
    bySupplier: (rows) => groupBySupplier(rows, options),
  })
}

/** fixture：纯读取（A5 会连跑两次比对字节，故不得有任何副作用）。 */
export const fixture = {
  sample: (handle) => ({
    all: handle.bySupplier([
      { supplier_id: 'sup-A', unit_price: 10, lead_time_days: 4, deviation: false },
      { supplier_id: 'sup-A', unit_price: 14, lead_time_days: 8, deviation: true },
      { supplier_id: 'sup-B', unit_price: 5, deviation: 1 },
      { unit_price: 999 },
      null,
    ]),
    one: handle.scorecard([
      { supplier_id: 'sup-A', unit_price: 10, lead_time_days: 4 },
      { supplier_id: 'sup-A', unit_price: 14, lead_time_days: 8 },
    ]),
  }),
}
