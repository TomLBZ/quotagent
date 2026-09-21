/**
 * 进树模块（**中间件式**）：`timeline` —— 按 realm 维护的事件时间线环形缓冲。
 *
 * 用户要求（2026-09-21）：「项目的每个功能都应被插件提供……可以用 subagents 制作一些
 * domain based 插件或者中间件满足一些具体业务逻辑」。本文件是**中间件**：它不产生业务事实
 * （事实仍以 Python 账本为准，ADR-0012），只把宿主事件流**按 realm 归档成有界时间线**，
 * 供 UI / 诊断 / 事后复盘读取。
 *
 * 三条纪律（与其它进树模块同形，见 host/README.md 与 check-modules.mjs）：
 *   1) `events` 是 cordis **内建 mixin**：写进 `inject` 会让插件永远 pending（实测），
 *      故只写进 `builtin`；`usedServices` 必须与 `inject` 完全相等（A1）。
 *   2) 零残留（A2）：订阅在 `ctx.effect()` 里登记并显式注销；缓冲/去重索引在 disposer 里清空；
 *      **不使用任何定时器**（本模块不需要时间驱动——环形缓冲由容量约束，不由墙钟驱动）。
 *   3) 确定性（A5）：输出里不得出现墙钟时间或自增序号。入参 `ts` 原样保留（可按它排序），
 *      绝不用 `Date.now()`；内部只有「插入顺序」这一稳定次序。
 *
 * 幂等：同一 `(realm, seq)` 重复投递不产生第二条（QEP 重发/重放是常态）；
 * 载荷缺 `seq` 时退回按「(realm, type, 载荷签名, ts)」去重，签名是**键排序**的稳定序列化。
 */
import { array, constant, number, object, string } from '../lib/std-schema.mjs'

export const name = 'timeline'

export const inject = []                 // 无外部依赖（`events` 是内建 mixin，不进 inject）

export const builtin = ['events']

export const provides = ['timeline']

export const usedServices = []           // 必须与 inject 完全相等（A1）

/** 默认订阅的宿主事件（名字取自 Python 侧事件表，真源只有一处）。 */
const DEFAULT_SUBSCRIBE = [
  'kernel/qep-received',
  'kernel/qep-duplicate-dropped',
  'kernel/ledger-appended',
  'rfq/published',
  'quote/submitted',
  'quote/normalized',
  'compare/rank-computed',
  'award/committed',
  'po/issued',
  'change/proposed',
  'clarification/asked',
  'approval/requested',
]

export const Config = object({
  capacity: number().default(32),                                   // 每个 realm 保留的条数（环形缓冲）
  realms: array(string()).default(['contractor:con-B', 'supplier:sup-A', 'relay:r-1']),
  subscribe: array(string()).default(DEFAULT_SUBSCRIBE),            // 要镜像进时间线的事件名；空数组 = 只用手写 record
  deterministic: constant(true),                                    // const 键：不得翻转（A3 负控）
})

/** 稳定序列化：对象键排序、无墙钟、无序号——同一载荷任何一次调用都得到同一字符串。 */
function stableText(value) {
  if (value === null || value === undefined) return String(value)
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableText).join(',')}]`
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableText(value[key])}`).join(',')}}`
  }
  return JSON.stringify(String(value))
}

/** 一行摘要（只取前若干个键；私域键只在这里被**读数**，本模块不做视角投影——那是 webui 的职责）。 */
function summarize(body) {
  if (!body || typeof body !== 'object') return ''
  return Object.keys(body).sort().slice(0, 6).map((key) => {
    const value = body[key]
    const text = (value !== null && typeof value === 'object') ? stableText(value) : String(value)
    return `${key}=${text.slice(0, 40)}`
  }).join(' ')
}

export function apply(ctx, config) {
  const capacity = Math.max(0, Math.floor(Number(config.capacity)))
  /** realm → { entries（插入序 = 时间线序）, seen（去重索引）, dropped }。Map 保持插入序 → stats 确定性。 */
  const stores = new Map()

  const newStore = () => ({ entries: [], seen: new Set(), dropped: 0 })

  /** 去重键：有 `seq` 就用 `(realm, seq)`（契约口径）；没有就用 `(realm, type, 载荷签名, ts)`。 */
  const keyOf = (entry) => {
    const head = `${entry.realm}\u0000${entry.type}\u0000`
    if (entry.seq === undefined || entry.seq === null) {
      return `${head}sig\u0000${stableText(entry.summary)}\u0000${stableText(entry.ts)}`
    }
    return `${entry.realm}\u0000seq\u0000${String(entry.seq)}`
  }

  const storeOf = (realm) => {
    let store = stores.get(realm)
    if (!store) {
      store = newStore()
      stores.set(realm, store)
    }
    return store
  }

  /** 配置里的 realm 先占位（count=0）——让 stats 的形状与配置一致，且**确定**。 */
  const seedConfigured = () => {
    for (const realm of config.realms) if (!stores.has(realm)) stores.set(realm, newStore())
  }
  seedConfigured()

  const viewOf = (entry) => ({
    realm: entry.realm,
    type: entry.type,
    seq: entry.seq === undefined ? null : entry.seq,
    ts: entry.ts === undefined ? null : entry.ts,
    summary: entry.summary === undefined ? '' : String(entry.summary),
  })

  /** 时间线序（新→旧）：`ts` 都是有限数字时按它降序，否则按插入序（稳定排序 → 确定性）。 */
  const orderedEntries = (store) => store.entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const a = left.entry.ts
      const b = right.entry.ts
      if (typeof a === 'number' && typeof b === 'number' && isFinite(a) && isFinite(b) && a !== b) return b - a
      return right.index - left.index
    })
    .map((pair) => pair.entry)

  const record = (input) => {
    const source = (input && typeof input === 'object') ? input : {}
    const realm = source.realm
    const type = source.type
    // 不静默通过：坏输入必须显式拒绝（本仓纪律）
    if (typeof realm !== 'string' || !realm) throw new Error('[timeline] record 需要非空的 realm 字段')
    if (typeof type !== 'string' || !type) throw new Error('[timeline] record 需要非空的 type 字段')

    const store = storeOf(realm)
    const key = keyOf({ realm, type, seq: source.seq, ts: source.ts, summary: source.summary })
    if (store.seen.has(key)) {
      // 幂等：重复投递不产生第二条，但计入 dropped（可见、可审计）
      store.dropped += 1
      return { accepted: false, reason: 'duplicate', realm, seq: source.seq ?? null, count: store.entries.length }
    }
    const entry = {
      realm,
      type,
      seq: source.seq ?? null,
      ts: source.ts ?? null,
      summary: source.summary === undefined || source.summary === null ? '' : String(source.summary),
    }
    store.seen.add(keyOf(entry))
    store.entries.push(entry)
    if (store.entries.length > capacity) {
      const evicted = store.entries.shift()          // 环形缓冲：超容量丢最旧
      store.seen.delete(keyOf(evicted))
      store.dropped += 1
    }
    return { accepted: true, reason: 'recorded', realm, seq: entry.seq, count: store.entries.length }
  }

  const slice = (query) => {
    const source = (query && typeof query === 'object') ? query : {}
    const realm = source.realm
    if (typeof realm !== 'string' || !realm) throw new Error('[timeline] slice 需要非空的 realm 字段')
    const store = stores.get(realm)
    if (!store) return []
    const wanted = Number(source.limit)
    const limit = Number.isFinite(wanted) && wanted >= 0 ? Math.floor(wanted) : store.entries.length
    return orderedEntries(store).slice(0, limit).map(viewOf)   // 新 → 旧
  }

  const stats = () => {
    const realms = {}
    let total = 0
    for (const [realm, store] of stores) {
      realms[realm] = { count: store.entries.length, capacity, dropped: store.dropped }
      total += store.entries.length
    }
    return { realms, total }
  }

  /** 清空（测试/运维用）。不写任何外部文件；配置里的 realm 清空后仍占位，保证 stats 形状稳定。 */
  const reset = (realm) => {
    if (realm === undefined) {
      stores.clear()
      seedConfigured()
      return { cleared: 'all' }
    }
    if (typeof realm !== 'string' || !realm) throw new Error('[timeline] reset 的 realm 必须是非空字符串')
    const store = storeOf(realm)
    store.entries = []
    store.seen = new Set()
    store.dropped = 0
    return { cleared: realm }
  }

  ctx.provide('timeline', {
    config: () => ({ ...config }),
    capacity,
    record,
    slice,
    stats,
    reset,
  })

  // 中间件语义：自己订阅事件总线（订阅即 effect，dispose 即注销——cordis 把 on() 登记为 fiber effect；
  // 这里再包一层显式 disposer，保证「注销一次、零残留」不依赖实现细节）。
  if (config.subscribe.length) {
    ctx.effect(() => {
      const offs = config.subscribe.map((eventName) => ctx.events.on(eventName, (payload) => {
        const body = (payload && typeof payload === 'object') ? payload : {}
        record({
          realm: (typeof body.realm === 'string' && body.realm) ? body.realm : (config.realms[0] ?? 'local'),
          type: eventName,
          seq: body.seq,
          ts: body.ts,
          summary: body.summary ?? summarize(body),
        })
      }))
      return () => { for (const off of offs) off() }
    })
  } else {
    ctx.effect(() => () => { /* 未订阅：仍登记一个 effect，卸载语义一致 */ })
  }

  // 零残留：卸载即清空缓冲与去重索引（不写外部文件，故无需回滚 I/O）
  ctx.effect(() => () => { stores.clear() })
}

export function disposer() {
  return () => {}
}

/**
 * A5 采样点：**不能**依赖墙钟或自增序号，且两次调用必须字节一致。
 * 做法：每次先把固定 realm `fixture:timeline` 复位（reset 会一并清空去重索引），
 * 再投一组固定条目（含一次故意的重复投递，用来覆盖幂等分支）——因此第二次采样
 * 得到的 count/dropped/顺序与第一次**完全相同**。`ts` 乱序投递用来证明按 ts 排序生效。
 */
export const fixture = {
  sample: (handle) => {
    const realm = 'fixture:timeline'
    handle.reset(realm)
    handle.record({ realm, type: 'rfq/published', seq: 101, ts: 30, summary: '发布 RFQ' })
    handle.record({ realm, type: 'quote/submitted', seq: 102, ts: 10, summary: '提交报价' })
    handle.record({ realm, type: 'compare/rank-computed', seq: 103, ts: 20, summary: '算完排序' })
    const duplicate = handle.record({ realm, type: 'quote/submitted', seq: 102, ts: 10, summary: '提交报价（重发）' })
    return {
      realm,
      duplicate_accepted: duplicate.accepted,
      duplicate_reason: duplicate.reason,
      stats: handle.stats().realms[realm],
      total: handle.stats().total,
      newest_first: handle.slice({ realm, limit: 3 }),
    }
  },
}
