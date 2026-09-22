/**
 * agent-context —— **一次 agent 轮的上下文装配**由插件提供（T-275 产物）。
 *
 * 契约：`docs/design/24-agent-runtime-plugins.md`（来源登记 / 上限与降级 / 不得成为第二条事实写路径）；
 * 规划来源：`docs/design/23-agent-runtime-and-storage-plugins.md` §1/§2；围栏门：`host/t275-runtime-gate.mjs`。
 *
 * 它是什么：`provides: ['agentContext']`，把"这一轮给模型看什么"变成**可核对的数据**：
 *   · `registerSource({id, kind, realm, visibility})` —— 上下文来源**先登记后使用**：未登记的来源一律拒；
 *   · `assemble({turn, entries})` —— 从**已登记来源**有界装配，返回
 *     `{items, counts, truncated, omitted, degraded, reason}`（降级与正常**同形状**）+
 *     `inputs[]`（引用列表 `<source>#<key>`，供输入重建路径逐条核对）；
 *   · `sources()` / `stats()` / `events()` —— 只读视图；留痕只在**宿主内存**（落账本由 Python 侧做，H1）。
 *
 * 纪律（每条都有 `host/t275-runtime-gate.mjs` 的断言看着）：
 *   · **私域与对手侧数据不进上下文**：本侧私域（`visibility:'private'`）、对手侧（`visibility:'peer'`）
 *     与来源 realm ≠ 本 realm 的条目一律拒 —— 有名 code + next_action，且**被拒内容的正文一个字都不出现在
 *     输出里**（只出现 code / 来源名 / 键名）；
 *   · **有界且计数诚实**：条数上限 `max_items`、单条正文按 UTF-8 字节夹到 `max_bytes`；超界**截断并报截断**
 *     （`truncated`/`omitted`/`clipped`），而 `counts.items` 与 `counts.bytes` 是**夹取前**的真值
 *     （展示可以有界，数字不许悄悄变小）；
 *   · **降级要如实报**：来源一件没登记 / 入参不是对象 / 插件已卸载 → `degraded:true` + 有名 reason +
 *     next_action；"确实没内容"与"没装配出来"必须可区分：前者 `degraded:false` 且 `reason='context-empty'`，
 *     后者 `degraded:true`；**两种情形都 `ok:false`**（空上下文不得报假绿）；
 *   · **确定性**：不读墙钟、不随机、不读环境变量；条目按来源→键稳定排序（与入参顺序无关），
 *     同输入两次 `assemble()` **字节一致**，入参不被改写；
 *   · **零写面**：不写文件、不落账本、不起子进程、不联网、不订阅事件、不注册定时器。
 */
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { number, object, string } from '../lib/std-schema.mjs'

export const name = 'agent-context'
export const inject = []            // 纯函数面：来源由调用方登记、条目由调用方给出（宿主不替 agent 取数）
export const builtin = []
export const usedServices = []
export const provides = ['agentContext']

export const Config = object({
  realm: string().default('contractor'),   // 本 realm：跨 realm 条目一律不进上下文
  max_items: number().default(8),          // 一次装配的条数上限（有界）
  max_bytes: number().default(2048),       // 单条正文的 UTF-8 字节上限（有界）
})

/** 上下文来源的种类（闭合集合：来源"是哪一类"必须显式声明，不从名字猜）。 */
export const SOURCE_KINDS = ['ledger-projection', 'project-knowledge', 'policy-patch', 'session']
/** 可见性三档：`own` 本 realm 可见面 / `private` 本侧私域 / `peer` 对手侧。 */
export const VISIBILITY = ['own', 'private', 'peer']
/** 来源名形状（小写字母开头，允许数字与连字符）。 */
export const SOURCE_RE = /^[a-z][a-z0-9-]{0,63}$/
/** 输出顶层键（**降级与正常同形状**：门断言两种情形的键集完全相同）。 */
export const OUTPUT_KEYS = ['turn', 'items', 'inputs', 'counts', 'truncated', 'omitted', 'clipped', 'refusals',
  'refusals_omitted', 'degraded', 'reason', 'next_action', 'ok']
/** 拒绝码（闭合集合；每个都有固定的 next_action —— 拒绝必须说得出下一步）。 */
export const REFUSAL_CODES = ['context-disposed', 'context-payload-invalid', 'context-no-sources',
  'context-source-invalid', 'context-source-duplicate', 'context-unregistered-source', 'context-item-invalid',
  'context-private-refused', 'context-cross-party-refused', 'context-missing-citations']
/** 降级原因码（降级必须有名，不得含糊）。 */
export const DEGRADED_REASONS = ['context-disposed', 'context-payload-invalid', 'context-no-sources']
/** "确实没内容"的诊断码：**不是**降级。 */
export const EMPTY_REASON = 'context-empty'
/** 假设标记：以它开头的条目可以存在，但**不进决策链**（对齐 06 §5 的幻觉处置）。 */
export const ASSUMPTION_PREFIX = '[假设]'
/** 留痕种类（宿主内存；落账本由 Python 侧做，H1）。 */
export const EVENT_KINDS = ['agentrt/source-registered', 'agentrt/context-assembled', 'agentrt/context-truncated',
  'agentrt/context-refused', 'agentrt/context-disposed', 'agentrt/degraded']
/** 留痕条数上界（留痕也有界；超出即丢最旧，见 `stats().resume.events_dropped`）。 */
export const MAX_EVENTS = 512
/** 拒绝明细条数上界（`counts.refused` 仍是真值，只夹"明细列表"）。 */
export const MAX_REFUSALS = 64

/** 每个拒绝/降级码对应的下一步（固定映射 → 输出确定，门断言映射覆盖闭合集合）。 */
const NEXT_ACTIONS = {
  'context-disposed': '上下文插件已被卸载：重新装配本插件后再装配上下文（已装配过的轮次不受影响）',
  'context-payload-invalid': 'assemble 的入参必须是对象且带 entries 数组：修好调用方再装配',
  'context-no-sources': '先 registerSource 登记来源（账本投影/项目知识/策略 patch/会话），再 assemble',
  'context-source-invalid': '来源形状：{id: 小写名, kind ∈ SOURCE_KINDS, realm, visibility}',
  'context-source-duplicate': '同一来源只登记一次：要改属性先换新 id（登记不可原地改）',
  'context-unregistered-source': '条目只能来自已登记来源：先 registerSource，不要从别处直接取数',
  'context-item-invalid': '条目形状：{source, key, payload: 字符串, citations[]}',
  'context-private-refused': '私域数据不进上下文：本侧私域只能在产出它的 agent 内使用（不要装箱给别人）',
  'context-cross-party-refused': '对手侧数据不走上下文：跨方内容只经 QEP 协议与本 realm 的账本投影',
  'context-missing-citations': '上下文条目必须带 citations[]：无引用的内容一律不进提示词',
  'context-empty': '确实没有可装配的条目：确认本轮任务是否真的不需要上下文',
}

const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const byName = (left, right) => (left < right ? -1 : (left > right ? 1 : 0))
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const utf8 = (text) => Buffer.byteLength(text, 'utf8')

/** 配置夹取：非有限数回落到默认值，越界夹到区间内（确定性，不抛错）。 */
const clampInt = (value, fallback, lower, upper) => {
  const size = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(upper, Math.max(lower, size))
}

/** 按 UTF-8 字节夹取（整码点步进：不劈开多字节字符，结果字节数必然 ≤ maxBytes）。 */
const clip = (text, maxBytes) => {
  if (utf8(text) <= maxBytes) return text
  let out = ''
  let used = 0
  for (const char of text) {
    const size = utf8(char)
    if (used + size > maxBytes) break
    out += char
    used += size
  }
  return out
}

/** 稳定字符串化（对象键排序）→ 同内容必然同字节（确定性：不依赖插入顺序）。 */
const stable = (value) => {
  if (Array.isArray(value)) return `[${value.map((item) => stable(item)).join(',')}]`
  if (isPlain(value)) {
    return `{${Object.keys(value).sort(byName).map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value === undefined ? null : value)
}

export function apply(ctx, config) {
  const realm = typeof config?.realm === 'string' && config.realm.trim() !== '' ? config.realm.trim() : 'contractor'
  const maxItems = clampInt(config?.max_items, 8, 0, 4096)
  const maxBytes = clampInt(config?.max_bytes, 2048, 0, 262144)
  const registered = new Map()      // id → {id, kind, realm, visibility}
  const events = []                 // 留痕（有界）：落账本由 Python 侧做（H1）
  const counters = { registered: 0, assembled: 0, admitted: 0, refused: 0, truncated: 0, degraded: 0,
    events_dropped: 0 }
  let disposed = false

  /** 留痕：只在**宿主内存**里有界累积（不写文件、不写账本）。 */
  const record = (event) => {
    if (events.length >= MAX_EVENTS) {
      events.shift()
      counters.events_dropped += 1
    }
    events.push(event)
    return event
  }
  const nextOf = (code) => NEXT_ACTIONS[code] ?? ''
  /** 拒绝载荷：`{ok:false, code, reason, next_action}` 三件套是契约（其余是给门的证据）。 */
  const refuse = (code, reason, extra = {}) => {
    counters.refused += 1
    record({ kind: 'agentrt/context-refused', code, reason: reason || code, next_action: nextOf(code),
      ...(extra.source === undefined ? {} : { source: extra.source }),
      ...(extra.key === undefined ? {} : { key: extra.key }) })
    return { ok: false, code, reason: reason || code, next_action: nextOf(code), ...extra }
  }

  /** 来源登记：形状 + 种类 + 可见性；**重复登记一律拒**（登记不可原地改）。 */
  const registerSource = (request) => {
    if (disposed) return refuse('context-disposed', 'agent-context-disposed')
    const id = isPlain(request) ? String(request.id ?? '') : ''
    if (!SOURCE_RE.test(id)) return refuse('context-source-invalid', `source-id-invalid:${id}`)
    if (registered.has(id)) return refuse('context-source-duplicate', `source-already-registered:${id}`, { source: id })
    const kind = isPlain(request) ? String(request.kind ?? '') : ''
    if (!SOURCE_KINDS.includes(kind)) {
      return refuse('context-source-invalid', `source-kind-invalid:${kind}`, { source: id })
    }
    const sourceRealm = String(request.realm ?? realm)
    const visibility = String(request.visibility ?? (sourceRealm === realm ? 'own' : 'peer'))
    if (!VISIBILITY.includes(visibility)) {
      return refuse('context-source-invalid', `source-visibility-invalid:${visibility}`, { source: id })
    }
    registered.set(id, { id, kind, realm: sourceRealm, visibility })
    counters.registered = registered.size
    record({ kind: 'agentrt/source-registered', source: id, source_kind: kind, visibility })
    return { ok: true, code: '', reason: '', next_action: '', source: id, kind, realm: sourceRealm, visibility }
  }

  /**
   * 私域 / 对手侧 / 跨 realm 一律不进上下文（返回拒绝块或 null）。
   * **结构性拒绝**（不是文档纪律）：判定只看条目与来源的声明，不看内容像不像。
   */
  const inadmissible = (entry, source) => {
    const visibility = String(entry.visibility ?? source.visibility)
    const entryRealm = String(entry.realm ?? source.realm)
    if (visibility === 'private') {
      return { code: 'context-private-refused', reason: `private-source:${source.id}` }
    }
    if (visibility === 'peer') {
      return { code: 'context-cross-party-refused', reason: `peer-side:${source.id}` }
    }
    if (entryRealm !== realm) {
      return { code: 'context-cross-party-refused', reason: `cross-realm:${entryRealm}` }
    }
    return null
  }

  /** 视图装配（**固定键集**：降级与正常同形状，门据此断言可区分而不是"看着像"）。 */
  const view = ({ turn, items, counts, omitted, clipped, refusals, degraded, reason }) => ({
    turn: String(turn ?? ''),
    items,
    inputs: items.map((item) => item.ref),
    counts,
    truncated: omitted > 0 || clipped > 0,
    omitted,
    clipped,
    refusals,
    refusals_omitted: Math.max(0, counts.refused - refusals.length),
    degraded,
    reason,
    next_action: nextOf(reason),
    ok: !degraded && items.length > 0,
  })

  const assemble = (payload) => {
    const turn = isPlain(payload) ? String(payload.turn ?? '') : ''
    const emptyView = (reason, degraded) => {
      if (degraded) counters.degraded += 1
      record({ kind: degraded ? 'agentrt/degraded' : 'agentrt/context-assembled', reason, turn, items: 0, degraded })
      return view({ turn, items: [], counts: { sources: registered.size, entries: 0, admitted: 0, refused: 0,
        items: 0, bytes: 0 }, omitted: 0, clipped: 0, refusals: [], degraded, reason })
    }
    if (disposed) return emptyView('context-disposed', true)
    if (!isPlain(payload) || !Array.isArray(payload.entries)) return emptyView('context-payload-invalid', true)
    if (registered.size === 0) return emptyView('context-no-sources', true)

    const entries = payload.entries
    const admitted = []
    const refusals = []
    let refused = 0
    let clipped = 0
    const reject = (entry, source, code, reason) => {
      refused += 1
      record({ kind: 'agentrt/context-refused', code, reason, next_action: nextOf(code),
        source: String(source ?? ''), key: isPlain(entry) ? String(entry.key ?? '') : '' })
      if (refusals.length < MAX_REFUSALS) {
        refusals.push({ code, reason, next_action: nextOf(code), source: String(source ?? ''),
          key: isPlain(entry) ? String(entry.key ?? '') : '' })
      }
    }

    entries.forEach((entry, index) => {
      if (!isPlain(entry)) {
        reject(null, '', 'context-item-invalid', `entry-not-object:${index}`)
        return
      }
      const sourceId = String(entry.source ?? '')
      const source = registered.get(sourceId)
      if (!source) {
        reject(entry, sourceId, 'context-unregistered-source', `source-not-registered:${sourceId}`)
        return
      }
      const blocked = inadmissible(entry, source)
      if (blocked) {
        reject(entry, source.id, blocked.code, blocked.reason)
        return
      }
      const citations = Array.isArray(entry.citations)
        ? entry.citations.filter((item) => typeof item === 'string' && item.trim() !== '').sort(byName)
        : []
      if (citations.length === 0) {
        reject(entry, source.id, 'context-missing-citations', `no-citations:${String(entry.key ?? '')}`)
        return
      }
      const key = String(entry.key ?? '')
      if (key.trim() === '') {
        reject(entry, source.id, 'context-item-invalid', `key-empty:${index}`)
        return
      }
      if (typeof entry.payload !== 'string') {
        reject(entry, source.id, 'context-item-invalid', `payload-not-string:${index}`)
        return
      }
      const text = entry.payload
      const shown = clip(text, maxBytes)
      if (shown !== text) clipped += 1
      const assumption = text.startsWith(ASSUMPTION_PREFIX)
      admitted.push({ source: source.id, kind: source.kind, key, ref: `${source.id}#${key}`, bytes: utf8(text),
        clipped_bytes: utf8(shown), citations, assumption, in_decision_chain: !assumption, digest: sha256(text),
        payload: shown, order: index })
    })

    admitted.sort((left, right) => byName(left.source, right.source) || byName(left.key, right.key)
      || left.order - right.order)
    const items = admitted.slice(0, maxItems).map(({ order, ...item }) => item)
    const counts = { sources: registered.size, entries: entries.length, admitted: admitted.length, refused,
      items: admitted.length, bytes: admitted.reduce((sum, item) => sum + item.bytes, 0) }
    const omitted = admitted.length - items.length
    const truncated = omitted > 0 || clipped > 0
    counters.assembled += 1
    counters.admitted += admitted.length
    if (truncated) counters.truncated += 1
    record({ kind: truncated ? 'agentrt/context-truncated' : 'agentrt/context-assembled', turn, items: items.length,
      admitted: admitted.length, omitted, refused, assumptions: items.filter((item) => item.assumption).length })
    return view({ turn, items, counts, omitted, clipped, refusals, degraded: false,
      reason: items.length === 0 ? EMPTY_REASON : '' })
  }

  const stats = () => ({
    realm,
    sources: [...registered.values()].sort((left, right) => byName(left.id, right.id))
      .map((item) => ({ ...item })),
    digests: [...registered.values()].sort((left, right) => byName(left.id, right.id))
      .map((item) => ({ id: item.id, digest: sha256(stable(item)) })),
    limits: { max_items: maxItems, max_bytes: maxBytes },
    output_keys: OUTPUT_KEYS,
    disk_written: 0,
    ledger_written: 0,
    resume: { ...counters, disposed },
    events: events.length,
  })

  ctx.provide('agentContext', {
    config: () => ({ realm, max_items: maxItems, max_bytes: maxBytes }),
    registerSource,
    sources: () => [...registered.values()].sort((left, right) => byName(left.id, right.id))
      .map((item) => ({ ...item })),
    assemble,
    stats,
    /** 留痕视图（Python 侧据此落账本：`agentrt/context-*` 带 reason/next_action）。 */
    events: () => events.map((item) => ({ ...item })),
  })
  // 插件被卸载：本实例的后续装配一律拒（已装配过的轮次已交到调用方手里，不受影响）
  ctx.effect(() => () => {
    disposed = true
    record({ kind: 'agentrt/context-disposed', assembled: counters.assembled })
  })
}

/** fixture：纯读取（挂载一次、连跑两次比对字节；零写面、零状态变更）。 */
export const fixture = {
  sample: (handle) => ({
    sources: handle.sources(),
    assembled: handle.assemble({ turn: 't275-sample', entries: [] }),
    stats_keys: Object.keys(handle.stats()).sort(),
  }),
}
