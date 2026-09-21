/**
 * agent-memory —— **记忆分层**由插件提供（T-275 产物）。四层按 `06 §4` 的既定设计，逐层封死谁能写：
 *
 *   ① `session`      —— 进程内、随 fiber 卸载回收：**永不落盘**（任何 persist 请求一律拒）；
 *   ② `project`      —— **只读**：它是**账本的可重建投影**，本插件不接收写入（写它的唯一路径 = Python 侧往账本追加）；
 *   ③ `policy`       —— **只人类可写**：`actor` 不以 `human:` 开头即拒；agent 只能 `propose`（产提案载荷，不落 patch）；
 *   ④ `cross_party`  —— **只走协议**：直接读/写另一侧数据一律拒，只有 `applyProtocol(envelope)`（带 QEP 信封）能进。
 *
 * 契约：`docs/design/24-agent-runtime-plugins.md`（四层边界表 + 被否决方案 + 未决项）；
 * 规划来源：`docs/design/23-agent-runtime-and-storage-plugins.md` §1/§2；围栏门：`host/t275-runtime-gate.mjs`。
 *
 * 纪律（每条都有门里的断言看着）：
 *   · **记忆写入必须带 `citations`**：无引用即拒（`memory-missing-citations`）；
 *   · **假设不进决策链**：以 `[假设]` 开头的条目可以存在，但 `in_decision_chain:false`；
 *   · **跨 realm 不可见**：条目/账本行声明的 realm ≠ 本 realm（或声明私域）→ 拒/排除，不静默混入；
 *   · **不得成为第二条事实写路径**：本插件不写文件、不落账本、不起子进程、不联网、不订阅事件、不注册定时器；
 *     策略 patch 与项目投影的**落地**都只能由 Python 侧（唯一账本写者）做；
 *   · **有界**：各层条目数上限 `max_items`、单条正文按 UTF-8 字节夹到 `max_bytes`；满了就报
 *     `memory-session-full`（**不驱逐、不静默丢**）；留痕条数上界内有界累积。
 */
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { number, object, string } from '../lib/std-schema.mjs'

export const name = 'agent-memory'
export const inject = []            // 记忆不消费平台服务：账本投影的行由调用方给（Python 侧已投影）
export const builtin = []
export const usedServices = []
export const provides = ['agentMemory']

export const Config = object({
  realm: string().default('contractor'),             // 本 realm：别的 realm 的行与条目一律排除
  max_items: number().default(8),                    // 每层条目数上限（有界）
  max_bytes: number().default(1024),                 // 单条正文的 UTF-8 字节上限（有界）
  policy_actor_prefix: string().default('human:'),    // 策略层的人类写入者前缀（只有它能写）
})

/** 四层（顺序即文档与门里的顺序）。 */
export const LAYERS = ['session', 'project', 'policy', 'cross_party']
/** 每层**谁能写**（闭合声明：门断言这份表与实现一致）。 */
export const WRITERS = { session: 'agent', project: 'ledger-projection', policy: 'human-only',
  cross_party: 'protocol' }
/** 拒绝码（闭合集合；每个都有固定 next_action）。 */
export const REFUSAL_CODES = ['memory-disposed', 'memory-unknown-layer', 'memory-entry-invalid',
  'memory-missing-citations', 'memory-session-persist-refused', 'memory-disk-write-refused', 'memory-session-full',
  'memory-project-readonly', 'memory-policy-human-only', 'memory-cross-party-direct-read-refused',
  'memory-cross-party-direct-write-refused', 'memory-cross-realm-refused', 'memory-protocol-envelope-invalid']
/** 留痕种类（宿主内存；落账本由 Python 侧做，H1）。 */
export const EVENT_KINDS = ['agentrt/memory-written', 'agentrt/memory-refused', 'agentrt/memory-rebuilt',
  'agentrt/memory-proposed', 'agentrt/memory-disposed']
/** 假设标记：可以存在，但**不进决策链**。 */
export const ASSUMPTION_PREFIX = '[假设]'
export const MAX_EVENTS = 512

const NEXT_ACTIONS = {
  'memory-disposed': '记忆插件已被卸载：重新装配本插件后再写记忆（已写过的内存内容随 fiber 回收）',
  'memory-unknown-layer': `层必须是 ${LAYERS.join(' / ')} 之一`,
  'memory-entry-invalid': '条目形状：{layer, key, text, citations[]}（键非空、行是数组）',
  'memory-missing-citations': '记忆写入必须带 citations[]：无引用的内容不许进记忆',
  'memory-session-persist-refused': '会话记忆永不落盘：需要留痕的事实请写账本事件（Python 侧），会话内容随 fiber 回收',
  'memory-disk-write-refused': '宿主不写文件也不写账本（H1）：落盘/落账本一律由 Python 侧做，本插件只给内存视图',
  'memory-session-full': '会话记忆已到上限：clear 或覆盖已有键，不要让会话无限长大',
  'memory-project-readonly': '项目记忆是账本投影：要写就写账本（Python 侧唯一写者），再 rebuild 投影',
  'memory-policy-human-only': '策略 patch 只能人写：agent 走 propose 产提案，由人确认后以 human:<id> 写入',
  'memory-cross-party-direct-read-refused': '对方的记忆取不到（跨 realm 不可见）：跨方共识只经 QEP 协议与本 realm 账本',
  'memory-cross-party-direct-write-refused': '不得直接写对方可见的记忆：跨方内容只经 QEP 协议发送',
  'memory-cross-realm-refused': '跨 realm 条目不进本 realm 记忆（INV-008 在宿主侧同样成立）',
  'memory-protocol-envelope-invalid': '协议信封形状：{message_id, base_revision, entries[]}',
}

const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const byName = (left, right) => (left < right ? -1 : (left > right ? 1 : 0))
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const utf8 = (text) => Buffer.byteLength(text, 'utf8')

const clampInt = (value, fallback, lower, upper) => {
  const size = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(upper, Math.max(lower, size))
}

/** 按 UTF-8 字节夹取（整码点步进：不劈开多字节字符）。 */
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

/** 稳定字符串化（对象键排序）→ 同内容必然同字节（投影可逐字节复校）。 */
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
  const maxBytes = clampInt(config?.max_bytes, 1024, 0, 262144)
  const policyPrefix = typeof config?.policy_actor_prefix === 'string' && config.policy_actor_prefix !== ''
    ? config.policy_actor_prefix : 'human:'
  const session = new Map()      // ① 只在内存
  const policyPatches = new Map() // ③ 只由人写（内存视图；落地由 Python 侧）
  const crossAgreed = new Map()   // ④ 只经协议
  let projection = null           // ② 账本投影缓存（可随时清掉，事实在账本里）
  const events = []
  const counters = { session_writes: 0, policy_writes: 0, cross_writes: 0, rebuilds: 0, proposals: 0,
    refusals: 0, persist_refused: 0, events_dropped: 0 }
  let disposed = false

  const record = (event) => {
    if (events.length >= MAX_EVENTS) {
      events.shift()
      counters.events_dropped += 1
    }
    events.push(event)
    return event
  }
  const nextOf = (code) => NEXT_ACTIONS[code] ?? ''
  const refuse = (code, reason, extra = {}) => {
    counters.refusals += 1
    record({ kind: 'agentrt/memory-refused', code, reason: reason || code, next_action: nextOf(code),
      ...(extra.layer === undefined ? {} : { layer: extra.layer }) })
    return { ok: false, code, reason: reason || code, next_action: nextOf(code), ...extra }
  }

  /** 引用列表（写入的记忆必须带引用；没有即 null，由调用点拒）。 */
  const citationsOf = (request) => {
    const raw = Array.isArray(request?.citations) ? request.citations : []
    const clean = raw.filter((item) => typeof item === 'string' && item.trim() !== '').sort(byName)
    return clean.length === 0 ? null : clean
  }
  /** 跨 realm / 私域条目一律不进本 realm 记忆（INV-008 在宿主侧同样成立）。 */
  const foreign = (request, layer) => {
    const declaredRealm = String(request.realm ?? realm)
    const visibility = String(request.visibility ?? 'own')
    if (visibility !== 'own' || declaredRealm !== realm) {
      return refuse('memory-cross-realm-refused', `cross-realm:${declaredRealm}:${visibility}`, { layer })
    }
    return null
  }

  // ---------------------------------------------------------------- ① 会话记忆（只在内存）
  const sessionSet = (request) => {
    if (disposed) return refuse('memory-disposed', 'agent-memory-disposed')
    if (!isPlain(request)) return refuse('memory-entry-invalid', 'request-not-object', { layer: 'session' })
    const key = String(request.key ?? '')
    if (key.trim() === '') return refuse('memory-entry-invalid', 'key-empty', { layer: 'session' })
    if (request.persist === true) {
      return refuse('memory-session-persist-refused', `session-never-persisted:${key}`,
        { layer: 'session', disk_written: false, ledger_written: false })
    }
    const blocked = foreign(request, 'session')
    if (blocked) return blocked
    const citations = citationsOf(request)
    if (citations === null) {
      return refuse('memory-missing-citations', `session-write-without-citations:${key}`, { layer: 'session' })
    }
    if (!session.has(key) && session.size >= maxItems) {
      return refuse('memory-session-full', `session-items:${session.size}/${maxItems}`, { layer: 'session' })
    }
    const text = typeof request.text === 'string' ? request.text : ''
    const assumption = text.startsWith(ASSUMPTION_PREFIX)
    session.set(key, { key, payload: clip(text, maxBytes), bytes: utf8(text), citations, assumption,
      in_decision_chain: !assumption, in_memory: true, persisted: false })
    counters.session_writes += 1
    record({ kind: 'agentrt/memory-written', layer: 'session', key, citations: citations.length, in_memory: true })
    return { ok: true, code: '', reason: '', next_action: '', layer: 'session', key, stored: true, in_memory: true,
      persisted: false, bytes: utf8(text), assumption, in_decision_chain: !assumption }
  }
  const sessionRead = (key) => (session.has(key) ? { ...session.get(key) } : null)

  // ---------------------------------------------------------------- ② 项目记忆（只读投影）
  const projectRebuild = (rows) => {
    if (disposed) return refuse('memory-disposed', 'agent-memory-disposed')
    if (!Array.isArray(rows)) return refuse('memory-entry-invalid', 'rows-not-array', { layer: 'project' })
    const excluded = { cross_realm: 0, private: 0, invalid: 0 }
    const byType = new Map()
    const correlations = []
    let included = 0
    for (const row of rows) {
      if (!isPlain(row)) {
        excluded.invalid += 1
        continue
      }
      const visibility = String(row.visibility ?? 'own')
      if (visibility === 'private') {
        excluded.private += 1
        continue
      }
      if (String(row.realm ?? realm) !== realm) {
        excluded.cross_realm += 1
        continue
      }
      included += 1
      const type = String(row.type ?? '(unknown)')
      byType.set(type, (byType.get(type) ?? 0) + 1)
      if (typeof row.correlation_id === 'string' && row.correlation_id !== '') correlations.push(row.correlation_id)
    }
    const body = { realm, rows_in: rows.length, rows_included: included, excluded,
      by_type: [...byType.entries()].sort((left, right) => byName(left[0], right[0]))
        .map(([type, count]) => ({ type, count })),
      correlations: [...new Set(correlations)].sort(byName) }
    projection = { ...body, readonly: true, source: 'ledger-projection', digest: sha256(stable(body)) }
    counters.rebuilds += 1
    record({ kind: 'agentrt/memory-rebuilt', layer: 'project', rows: included,
      excluded_cross_realm: excluded.cross_realm, excluded_private: excluded.private })
    return { ok: true, code: '', reason: '', next_action: '', layer: 'project', readonly: true,
      projection: { ...projection } }
  }
  const projectRead = () => (projection === null ? null : { ...projection })
  /** 项目记忆**不接收写入**：它是账本投影，写它的唯一路径是 Python 侧往账本追加。 */
  const projectWrite = (request) => refuse('memory-project-readonly',
    `project-write-refused:${String(request?.key ?? '')}`, { layer: 'project' })

  // ---------------------------------------------------------------- ③ 策略记忆（只人类可写）
  const policyWrite = (request) => {
    if (disposed) return refuse('memory-disposed', 'agent-memory-disposed')
    if (!isPlain(request)) return refuse('memory-entry-invalid', 'request-not-object', { layer: 'policy' })
    const key = String(request.key ?? '')
    const actor = String(request.actor ?? '')
    if (key.trim() === '') return refuse('memory-entry-invalid', 'key-empty', { layer: 'policy' })
    if (!actor.startsWith(policyPrefix)) {
      return refuse('memory-policy-human-only', `actor-not-human:${actor}`, { layer: 'policy' })
    }
    const blocked = foreign(request, 'policy')
    if (blocked) return blocked
    const citations = citationsOf(request)
    if (citations === null) {
      return refuse('memory-missing-citations', `policy-write-without-citations:${key}`, { layer: 'policy' })
    }
    const value = isPlain(request.value) || Array.isArray(request.value) ? request.value : (request.value ?? null)
    policyPatches.set(key, { key, value, actor, citations, written_by: 'human', pending_ledger: true,
      in_memory: true })
    counters.policy_writes += 1
    record({ kind: 'agentrt/memory-written', layer: 'policy', key, actor, citations: citations.length })
    return { ok: true, code: '', reason: '', next_action: '', layer: 'policy', key, stored: true, written_by: actor,
      in_memory: true, ledger_pending: true }
  }
  /** agent 只能**提案**：产待办载荷（不落 patch、不落账本），由人确认后再以 `human:` 写入。 */
  const policyPropose = (request) => {
    if (disposed) return refuse('memory-disposed', 'agent-memory-disposed')
    if (!isPlain(request)) return refuse('memory-entry-invalid', 'request-not-object', { layer: 'policy' })
    const key = String(request.key ?? '')
    if (key.trim() === '') return refuse('memory-entry-invalid', 'key-empty', { layer: 'policy' })
    const citations = citationsOf(request)
    if (citations === null) {
      return refuse('memory-missing-citations', `proposal-without-citations:${key}`, { layer: 'policy' })
    }
    counters.proposals += 1
    record({ kind: 'agentrt/memory-proposed', layer: 'policy', key, citations: citations.length })
    return { ok: true, code: '', reason: '', next_action: '', kind: 'policy-patch-proposal', layer: 'policy', key,
      actor: String(request.actor ?? 'agent'), value_digest: sha256(stable(request.value ?? null)), citations,
      written: false, in_memory: true }
  }
  const policyRead = (key) => (policyPatches.has(key) ? { ...policyPatches.get(key) } : null)

  // ---------------------------------------------------------------- ④ 跨方共识（只走协议）
  const crossRead = () => refuse('memory-cross-party-direct-read-refused',
    'cross-party-read-must-go-through-protocol', { layer: 'cross_party' })
  const crossWrite = (request) => refuse('memory-cross-party-direct-write-refused',
    `cross-party-write-refused:${String(request?.key ?? '')}`, { layer: 'cross_party' })
  const crossApply = (envelope) => {
    if (disposed) return refuse('memory-disposed', 'agent-memory-disposed')
    if (!isPlain(envelope)) {
      return refuse('memory-protocol-envelope-invalid', 'envelope-not-object', { layer: 'cross_party' })
    }
    const messageId = String(envelope.message_id ?? '')
    const baseRevision = envelope.base_revision
    const entries = envelope.entries
    if (messageId === '' || (typeof baseRevision !== 'string' && typeof baseRevision !== 'number')
      || !Array.isArray(entries)) {
      return refuse('memory-protocol-envelope-invalid',
        'envelope-missing:message_id|base_revision|entries', { layer: 'cross_party' })
    }
    const refusedEntries = []
    let stored = 0
    for (const entry of entries) {
      if (!isPlain(entry) || String(entry.key ?? '').trim() === '') {
        refusedEntries.push({ code: 'memory-protocol-envelope-invalid', key: '',
          next_action: nextOf('memory-protocol-envelope-invalid') })
        continue
      }
      const key = String(entry.key)
      if (String(entry.visibility ?? 'own') !== 'own') {
        refusedEntries.push({ code: 'memory-cross-realm-refused', key, next_action: nextOf('memory-cross-realm-refused') })
        continue
      }
      crossAgreed.set(`${messageId}:${key}`, { message_id: messageId, base_revision: baseRevision, key,
        payload: clip(String(entry.payload ?? ''), maxBytes), via: 'qep', in_memory: true })
      stored += 1
    }
    counters.cross_writes += stored
    record({ kind: 'agentrt/memory-written', layer: 'cross_party', via: 'qep', message_id: messageId, stored,
      refused: refusedEntries.length })
    return { ok: true, code: '', reason: '', next_action: '', layer: 'cross_party', via: 'qep', stored,
      refused_entries: refusedEntries, in_memory: true, ledger_written: false }
  }

  // ---------------------------------------------------------------- 统一入口（层不在表里即拒）
  const write = (request) => {
    const layer = isPlain(request) ? String(request.layer ?? '') : ''
    if (!LAYERS.includes(layer)) return refuse('memory-unknown-layer', `layer-invalid:${layer}`)
    if (layer === 'session') return sessionSet(request)
    if (layer === 'project') return projectWrite(request)
    if (layer === 'policy') return policyWrite(request)
    return crossWrite(request)
  }
  const read = (request) => {
    const layer = isPlain(request) ? String(request.layer ?? '') : ''
    const key = isPlain(request) ? String(request.key ?? '') : ''
    if (!LAYERS.includes(layer)) return refuse('memory-unknown-layer', `layer-invalid:${layer}`)
    if (layer === 'session') {
      return { ok: true, code: '', reason: '', next_action: '', layer, key, entry: sessionRead(key), in_memory: true }
    }
    if (layer === 'project') {
      return { ok: true, code: '', reason: '', next_action: '', layer, key: '', projection: projectRead(),
        readonly: true }
    }
    if (layer === 'policy') {
      return { ok: true, code: '', reason: '', next_action: '', layer, key, patch: policyRead(key),
        written_by: 'human' }
    }
    return crossRead()
  }

  /** **任何 persist 请求一律拒**（会话层尤其：永不落盘）；落盘/落账本只由 Python 侧做（H1）。 */
  const persist = (request) => {
    const layer = isPlain(request) ? String(request.layer ?? '') : ''
    counters.persist_refused += 1
    if (layer === 'session') {
      return refuse('memory-session-persist-refused', 'session-memory-never-persisted',
        { layer, disk_written: false, ledger_written: false })
    }
    return refuse('memory-disk-write-refused', `layer-persist-refused:${layer}`,
      { layer, disk_written: false, ledger_written: false })
  }

  const stats = () => ({
    realm,
    layers: LAYERS,
    writable_by: { ...WRITERS },
    counts: { session: session.size, policy: policyPatches.size, cross_party: crossAgreed.size,
      project_rows: projection === null ? 0 : projection.rows_included },
    keys: { session: [...session.keys()].sort(byName), policy: [...policyPatches.keys()].sort(byName),
      cross_party: [...crossAgreed.keys()].sort(byName) },
    project_digest: projection === null ? '' : projection.digest,
    limits: { max_items: maxItems, max_bytes: maxBytes, policy_actor_prefix: policyPrefix },
    disk_written: 0,
    ledger_written: 0,
    resume: { ...counters, persisted: 0, disposed },
    events: events.length,
  })

  ctx.provide('agentMemory', {
    config: () => ({ realm, max_items: maxItems, max_bytes: maxBytes, policy_actor_prefix: policyPrefix }),
    session: { set: sessionSet, get: sessionRead, size: () => session.size,
      list: () => [...session.values()].sort((left, right) => byName(left.key, right.key)).map((item) => ({ ...item })) },
    project: { readonly: true, rebuild: projectRebuild, read: projectRead, clearCache: () => { projection = null } },
    policy: { write: policyWrite, read: policyRead, propose: policyPropose,
      list: () => [...policyPatches.values()].sort((left, right) => byName(left.key, right.key)).map((item) => ({ ...item })) },
    cross_party: { read: crossRead, write: crossWrite, applyProtocol: crossApply,
      list: () => [...crossAgreed.values()].sort((left, right) => byName(left.key, right.key)).map((item) => ({ ...item })) },
    write,
    read,
    persist,
    stats,
    /** 留痕视图（Python 侧据此落账本：`agentrt/memory-*` 带 layer/reason/next_action）。 */
    events: () => events.map((item) => ({ ...item })),
  })
  // 插件被卸载：内存四层随 fiber 回收（事实在账本里，投影可重建；策略 patch 的落地在 Python 侧）
  ctx.effect(() => () => {
    disposed = true
    record({ kind: 'agentrt/memory-disposed', session: session.size, policy: policyPatches.size,
      cross_party: crossAgreed.size })
  })
}

/** fixture：纯读取（挂载一次、连跑两次比对字节；不写任何层，只做"持久化被拒 + 投影重建"两次采样）。 */
export const fixture = {
  sample: (handle) => ({
    persist_refused: handle.persist({ layer: 'session' }),
    rebuild: handle.project.rebuild(SAMPLE_ROWS),
    rebuild_again: handle.project.rebuild(SAMPLE_ROWS),
    stats_keys: Object.keys(handle.stats()).sort(),
  }),
}

/** 夹具行：本 realm 两行 + 一行私域 + 一行别的 realm（投影必须排除后两者）。 */
export const SAMPLE_ROWS = [
  { type: 'rfq/published', realm: 'contractor', correlation_id: 'c-1' },
  { type: 'quote/submitted', realm: 'contractor', correlation_id: 'c-1' },
  { type: 'cost/model', realm: 'contractor', visibility: 'private', correlation_id: 'c-2' },
  { type: 'quote/submitted', realm: 'supplier:sup-A', correlation_id: 'c-3' },
]
