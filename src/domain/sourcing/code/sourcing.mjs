/**
 * 进树模块：`sourcing`（领域插件 —— RFQ 覆盖率与缺口分析）。
 *
 * 用户 2026-09-21 指令：「项目的每个功能都应被插件提供」→ 本文件是一个 **cordis 插件**：
 * manifest 与其它进树模块同形（`host/modules/norm.mjs` 为最简范本），
 * 只允许 node 内建 / `cordis` / `../lib/std-schema.mjs`（A6：不得 import 别的模块目录）。
 *
 * 业务边界：**纯函数、零副作用**地读账本行做 RFQ 覆盖率与缺口分析 —— 只读账本、不写账本、
 * 不改内核状态。账本行形状 `{seq, type, correlation_id, actor, ts, body}`。
 *   · `coverage(rows)` —— 按 `rfq/published` 的包分组，统计「被邀请的供应商」与「已提交报价的供应商」，
 *     给出覆盖率 `coverage_bps`（已响应 / 邀请 × 10000，**四舍五入到整数**）与未应标名单 `missing`；
 *   · `gaps(rows)` —— 只回「未应标 / 无报价」的清单（按包分组，包名与供应商名都按字典序）；
 *   · `expiring(rows, as_of)` —— 按 `default_horizon_days` 标出临期/逾期（`as_of` 由**调用方**给）。
 *
 * 确定性纪律（A5：同输入两次输出字节一致）：不取墙钟、不取随机、不带自增序号进输出。
 * 推断纪律：账本里没有对应事件就返回空数组，**不补默认值、不猜名单**。
 * 文案纪律：中文字符串里不内嵌 ASCII 双引号（用「」），避免本仓踩过的转义坑。
 */
import { constant, number, object } from '../lib/std-schema.mjs'

export const name = 'sourcing'

// 无外部依赖（`events`/`logger`/`timer`/`registry` 是 cordis 内建 mixin，**不进 inject**：
// 写进 inject 会让插件永远停在 pending —— 本仓实测过）。
export const inject = []

// 内建 mixin 只走 builtin 声明，不进 inject（A1 负控按这一条断言）。
export const builtin = []   // 本模块不使用事件：声明即事实（D-015 / A1 双向断言）

// 对外只提供 `sourcing` 一个服务句柄（apply 里 `ctx.provide('sourcing', ...)`）。
export const provides = ['sourcing']

// 声明即事实：实际用到的服务与 `inject` 完全相等（A1）。
export const usedServices = []

export const Config = object({
  // 临期口径：距 `quote_by` 还有几天算「临期」（`expiring` 默认用它）
  default_horizon_days: number().default(7),
  // 覆盖率下限：低于此值的包进 `below_floor`（缺口排序入口）
  coverage_floor_bps: number().default(8000),
  // const 键：不得翻转（A3 负控）
  deterministic: constant(true),
})

const DAY_MS = 86400000
/** 包标识在账本里彻底缺失时的占位（**不是**编造的包名，只是一个显式标记）。 */
const UNASSIGNED = '(unassigned)'

/** 一切取值都转成字符串再比较，避免 1 与「1」在分组里分裂。 */
const text = (value) => (value === undefined || value === null ? '' : String(value))

/** `invited`/`suppliers` 兼容数组与单值两种写法；无法识别的形状按「没有名单」处理。 */
const ids = (value) => {
  if (Array.isArray(value)) return value.map(text).filter((item) => item !== '')
  if (typeof value === 'string' && value !== '') return [value]
  return []
}

/** 字典序比较（不给 sort 传比较器时 V8 按 UTF-16 码元排，这里显式写出来以免读者误解）。 */
const byLex = (left, right) => (left < right ? -1 : left > right ? 1 : 0)

const listOf = (rows) => (Array.isArray(rows) ? rows : [])

const bodyOf = (row) => (row.body && typeof row.body === 'object' && !Array.isArray(row.body) ? row.body : {})

/** 包标识：优先 `body.package_id`，缺失才退到行的 `correlation_id`（两者都没有就标 UNASSIGNED）。 */
const packageOf = (row, body) => text(body.package_id) || text(row.correlation_id) || UNASSIGNED

/**
 * RFQ 覆盖率：按包分组。
 * 邀请方 = `rfq/published` 的 `body.invited`（缺失时用 `body.suppliers`）—— 两者都试，取存在的那个；
 * 已响应 = `quote/submitted` 的 `body.supplier`（缺失时用行的 `actor`）。
 * 分母为 0 时覆盖率记 0 并在 `note` 写 `no-invitees`（没有邀请名单 ≠ 覆盖率 100%）。
 */
export function coverage(rows) {
  const buckets = new Map()
  for (const row of listOf(rows)) {
    if (!row || typeof row !== 'object') continue
    const body = bodyOf(row)
    const pkg = packageOf(row, body)
    if (!buckets.has(pkg)) buckets.set(pkg, { invited: new Set(), responded: new Set() })
    const bucket = buckets.get(pkg)
    if (row.type === 'rfq/published') {
      // 「两者都试，取存在的那个」：`invited` 在场就用它，否则退到 `suppliers`
      const raw = body.invited === undefined || body.invited === null ? body.suppliers : body.invited
      for (const supplier of ids(raw)) bucket.invited.add(supplier)
    } else if (row.type === 'quote/submitted') {
      const supplier = text(body.supplier) || text(row.actor)
      if (supplier) bucket.responded.add(supplier)
    }
  }
  return [...buckets.entries()]
    .sort((left, right) => byLex(left[0], right[0]))
    .map(([package_id, bucket]) => {
      const invited = [...bucket.invited].sort(byLex)
      const responded = [...bucket.responded].sort(byLex)
      const coverage_bps = invited.length === 0
        ? 0
        : Math.round(responded.length * 10000 / invited.length)   // 整数 bps，不留浮点尾巴
      return {
        package_id,
        invited,
        responded,
        coverage_bps,
        missing: invited.filter((supplier) => !bucket.responded.has(supplier)),
        note: invited.length === 0 ? 'no-invitees' : '',
      }
    })
}

/**
 * 缺口：只回「未应标 / 无报价」的清单 —— 被邀请但账本里没有 `quote/submitted` 的供应商，
 * 按包分组；包间按 package_id 字典序、组内按供应商名排序（A5 确定性）。
 * 没有邀请名单的包（`note: no-invitees`）在缺口清单里没有可列的供应商，因此**不出现**
 * —— 宁可不列，也不编造一份名单。
 */
export function gaps(rows) {
  return coverage(rows)
    .filter((entry) => entry.missing.length > 0)
    .map((entry) => ({ package_id: entry.package_id, missing: [...entry.missing] }))
}

/**
 * 临期/逾期一览：`default_horizon_days` 的真正用处。
 * `as_of` 必须由**调用方**给出（模块内不取墙钟）→ 同一 (rows, as_of) 永远同一输出（A5）。
 * 截止时间取自 `rfq/published` 的 `body.quote_by`；没有截止时间就标 `unknown-deadline`，不猜。
 */
export function expiring(rows, as_of = '', horizon_days = 7) {
  const asOf = Date.parse(text(as_of))
  const horizon = Number(horizon_days)
  const deadlines = new Map()
  for (const row of listOf(rows)) {
    if (!row || typeof row !== 'object' || row.type !== 'rfq/published') continue
    const body = bodyOf(row)
    const pkg = packageOf(row, body)
    const quoteBy = text(body.quote_by)
    // 同一包多次发布：首个带截止时间的版本生效（rev 只增，账本顺序即时间顺序）
    if (!deadlines.has(pkg) || (quoteBy && !deadlines.get(pkg))) deadlines.set(pkg, quoteBy)
  }
  return [...deadlines.entries()]
    .sort((left, right) => byLex(left[0], right[0]))
    .map(([package_id, quote_by]) => {
      const at = quote_by ? Date.parse(quote_by) : Number.NaN
      let state = 'unknown-deadline'
      let days_left = null
      if (!Number.isNaN(at) && !Number.isNaN(asOf)) {
        days_left = Math.ceil((at - asOf) / DAY_MS)
        state = days_left < 0 ? 'overdue' : (days_left <= horizon ? 'due-soon' : 'scheduled')
      }
      return { package_id, quote_by, state, days_left }
    })
}

export function apply(ctx, config) {
  // 本模块没有定时器/端口/子进程；仍然登记 effect —— 停机时把进程内派生状态清零，
  // A2 断言 dispose 后 effect 数为 0、timer/listener 计数差分全 0。
  let analyses = 0
  ctx.effect(() => () => { analyses = 0 })

  /** 低于覆盖率下限的包（缺口分析的排序入口）。 */
  const belowFloor = (rows) => coverage(rows)
    .filter((entry) => entry.coverage_bps < Number(config.coverage_floor_bps))
    .map((entry) => ({ package_id: entry.package_id, coverage_bps: entry.coverage_bps }))

  ctx.provide('sourcing', {
    config: () => ({ ...config }),
    coverage,
    gaps,
    expiring: (rows, as_of, horizon_days = config.default_horizon_days) => expiring(rows, as_of, horizon_days),
    belowFloor,
    /**
     * 一次算全（消费方一次调用拿到全景）。
     * `analyses` 只进 `stats()`，**绝不进派生输出** —— 自增计数落进输出会当场破 A5。
     */
    analyze: (rows, as_of = '') => {
      analyses += 1
      return {
        coverage: coverage(rows),
        gaps: gaps(rows),
        below_floor: belowFloor(rows),
        expiring: expiring(rows, as_of, config.default_horizon_days),
      }
    },
    stats: () => ({ analyses }),
  })
}

/**
 * A5 采样点：检查器对同一句柄连调两次并要求**字节级一致**。
 * 输入是写死的小账本（ts 全是常量，不取墙钟），覆盖三种情形：
 * 邀请名单在 `invited`、在 `suppliers`、以及**没有邀请名单**（`no-invitees`）。
 */
const FIXTURE_ROWS = [
  { seq: 1, type: 'rfq/published', correlation_id: 'corr-001', actor: 'contractor', ts: '2026-09-01T00:00:00+00:00',
    body: { package_id: 'pkg-014', quote_by: '2026-09-10T00:00:00+00:00', invited: ['sup-a', 'sup-b', 'sup-c'] } },
  { seq: 2, type: 'quote/submitted', correlation_id: 'corr-001', actor: 'sup-a', ts: '2026-09-02T00:00:00+00:00',
    body: { package_id: 'pkg-014', supplier: 'sup-a' } },
  { seq: 3, type: 'quote/submitted', correlation_id: 'corr-001', actor: 'sup-b', ts: '2026-09-03T00:00:00+00:00',
    body: { package_id: 'pkg-014' } },
  { seq: 4, type: 'rfq/published', correlation_id: 'corr-002', actor: 'contractor', ts: '2026-09-04T00:00:00+00:00',
    body: { package_id: 'pkg-015', quote_by: '2026-09-30T00:00:00+00:00', suppliers: ['sup-a', 'sup-d'] } },
  { seq: 5, type: 'quote/submitted', correlation_id: 'corr-002', actor: 'sup-z', ts: '2026-09-05T00:00:00+00:00',
    body: { supplier: 'sup-z' } },
  { seq: 6, type: 'rfq/published', correlation_id: 'corr-003', actor: 'contractor', ts: '2026-09-06T00:00:00+00:00',
    body: { package_id: 'pkg-016' } },
  { seq: 7, type: 'clarification/asked', correlation_id: 'corr-001', actor: 'sup-c', ts: '2026-09-07T00:00:00+00:00',
    body: { package_id: 'pkg-014' } },
]

const FIXTURE_AS_OF = '2026-09-08T00:00:00+00:00'

export const fixture = {
  sample: (handle) => handle.analyze(FIXTURE_ROWS, FIXTURE_AS_OF),
}

export function disposer() {
  return () => {}
}
