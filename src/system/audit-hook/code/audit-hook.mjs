/**
 * 进树模块：`audit-hook` —— 运行期**决策留痕**中间件（观测用，不是账本）。
 *
 * 定位（与账本的分工必须写清楚，否则会被误当成"第二本账"）：
 *   · **账本**（Python 侧，唯一写入者，append-only + 哈希链）是**事实**；
 *   · 本模块的审计流水是**宿主运行期的观测**：内存环形缓冲，进程结束即消失，**不写文件、不写账本**。
 *   它是"刚才这台机器上发生了什么决策"的现场记录，用于排障与 UI 展示；任何需要成为事实的东西
 *   必须由 Python 侧落账（H1）。
 *
 * 三条纪律：
 *   1) 去重键与账本同形 `(type, correlation_id, body_hash)` —— 同一件事不会记两条；
 *   2) 有界（环形缓冲，容量来自配置）——不会随运行时长无限增长；
 *   3) 零残留（A2）：事件订阅在 `ctx.effect()` 里登记，dispose 即注销。
 */
import { array, number, object, string } from '../lib/std-schema.mjs'
import { createHash } from 'node:crypto'

export const name = 'audit-hook'

export const inject = []

export const builtin = ['events']          // 订阅事件总线（内建 mixin：**不写进 inject**，写进去插件会永远 pending）

export const usedServices = []

export const provides = ['audit']

export const Config = object({
  capacity: number().default(200),                  // 全局环形容量（有界）
  realms: array(string()).default([]),              // 关注哪些 realm；空 = 全部
  types: array(string()).default([                 // 关注哪些事件前缀（决策类）
    'approval/', 'award/', 'po/', 'change/', 'evolve/', 'canary/',
  ]),
})

const bodyHash = (body) => 'sha256:' + createHash('sha256')
  .update(JSON.stringify(body ?? null)).digest('hex')

export function apply(ctx, config) {
  const entries = []
  const seen = new Set()
  const stats = { captured: 0, deduped: 0, skipped: 0, dropped: 0 }

  const interesting = (type) => config.types.some((prefix) => String(type).startsWith(prefix))
  const inScope = (realm) => config.realms.length === 0 || config.realms.includes(String(realm))

  const record = ({ type, correlation_id = '', actor = '', ts = '', realm = '', body = null, source = 'event' }) => {
    if (!inScope(realm)) { stats.skipped += 1; return { recorded: false, reason: 'realm-out-of-scope' } }
    if (source === 'event' && !interesting(type)) { stats.skipped += 1; return { recorded: false, reason: 'type-not-interested' } }
    const key = `${type}|${correlation_id}|${bodyHash(body)}`
    if (seen.has(key)) { stats.deduped += 1; return { recorded: false, reason: 'duplicate' } }
    seen.add(key)
    entries.push({ seq: entries.length + 1, type, correlation_id, actor, ts, realm, source,
      body_hash: bodyHash(body), summary: summarize(body) })
    while (entries.length > config.capacity) { entries.shift(); stats.dropped += 1 }
    stats.captured += 1
    return { recorded: true, seq: entries.length }
  }

  const summarize = (body) => {
    if (!body || typeof body !== 'object') return ''
    return Object.keys(body).slice(0, 6).map((key) => {
      const value = body[key]
      const text = (value !== null && typeof value === 'object') ? '{…}' : String(value).slice(0, 40)
      return `${key}=${text}`
    }).join(' ')
  }

  // 订阅：只关心配置里的前缀（effect 注销 → 零残留）
  ctx.effect(() => {
    const handler = (payload) => {
      const type = payload?.type ?? payload?.name ?? ''
      record({ type, correlation_id: payload?.correlation_id ?? '', actor: payload?.actor ?? '',
        ts: payload?.ts ?? '', realm: payload?.realm ?? '', body: payload?.body ?? payload })
    }
    ctx.events.on?.('*', handler)
    return () => { ctx.events.off?.('*', handler) }
  })

  ctx.provide('audit', {
    record,
    /** 决策类流水（source=decision 或前缀命中）——UI/排障只看这个。 */
    decisions: ({ realm = '', limit = 20 } = {}) => entries
      .filter((item) => inScope(realm) && (item.source === 'decision' || interesting(item.type)))
      .slice(-limit),
    slice: ({ realm = '', limit = 20 } = {}) => entries.filter((item) => inScope(realm)).slice(-limit),
    stats: () => ({ ...stats, size: entries.length, capacity: config.capacity }),
    types: () => [...config.types],
    clear: () => { const n = entries.length; entries.length = 0; seen.clear(); return { cleared: n } },
  })
}

/** A5 采样点：纯读取（不写入任何记录）。 */
export const fixture = {
  sample: (handle) => ({ types: handle.types(), stats: handle.stats(), capacity: handle.stats().capacity }),
}
