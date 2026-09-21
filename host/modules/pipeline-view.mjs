/**
 * pipeline-view —— **P2 三域流水线（谈判 / FAQ / 邮件）的只读运维视图**（T-260 候选产物；
 * 与 `ops-view`、`retention-view` 同族：**只组合、不自算**）。契约：`docs/design/20-pipeline-snapshot-contract.md` §2/§3。
 *
 * 为什么需要它：谈判轮次（T-256）、FAQ 沉淀（T-257）、邮件（无凭据的一半，T-258）落地后**运维道看不到它们**
 * —— `ops-view` 只聚合运行期的三源与熔断。本模块把 Python 侧写好的快照（`tmp/ui-shared/pipeline.json`）
 * 变成运维可读的聚合视图：不改判定、不碰账本、不落任何痕。
 *
 * 分工（不重复造轮子）：
 *   · Python 侧 `tools/refresh-ui-snapshots.py`：从三个服务的账本行**重建**计数与最近事件（复用服务的 replay），
 *     只读账本、不写账本 —— **唯一事实来源**（判定在事实层，宿主只展示：ADR-0012）；
 *   · 本模块：吃该快照，做**有界的只读聚合** + 一行人类可读摘要。数字照抄快照，标识（视角名 / 域 id / 序号）
 *     照抄条目里**白名单**内的键。
 *   · `/api/pipeline` 路由与端到端（`verify.sh pipeline-route`）不在本模块；本模块只提供句柄。
 *
 * 纪律（每条都有 `host/t260-pipeline-gate.mjs` 的断言看着；ADR-0012 / D-052 / D-053）：
 *   · **只组合、不自算**：不判定「该不该拒绝」「能不能发信」，也不拿视角明细重算快照**已声明**的合计
 *     （不一致时照抄快照：重算等于另立口径，且会把"上游错了"这件事抹平）；快照没给合计时才做
 *     **跨视角相加**，并在 `totals_source` 里明示 `summed`（聚合是宿主的活，判定不是）；
 *   · **降级优先**：`payload` 非对象 / 缺 `views` / `views` 为空 / 任一视角三域缺失或计数类型错 /
 *     顶层合计类型错 → **全零 + `degraded:true`**（形状与正常输出一致），绝不抛异常，
 *     也不给一个"看起来健康的零"——宁可让运维看到"不可用"并去查上游；
 *   · **通道三档一致**：`transport.available:true` 只在**所有**声明位（快照顶层 `transport`、
 *     顶层 `mail.transport`、各视角 `mail.transport`）都说 true 时给出；任一档说 false 或声明畸形 →
 *     `false` + **第一处非空 `reason`** + 对应 `next_action`（D-052：做不到的事要在接口上显式拒绝）；
 *   · **不出正文与私域键**：只读白名单键（视角名 + `negotiate`/`faq`/`mail` 三域 + 各自计数 +
 *     `last` 的 id / 序号 / kind + `transport` 三件）；其余键**不读也不记事名**（名字泄漏本身就是踩过的坑）。
 *     保留字段里一旦出现私域标记（`private:` / `body` / `subject` / `attachment` / `reserve_price` /
 *     `cost_model` / `signature`）或控制字符，整段替换为 `(redacted)`；也不输出任何绝对时刻
 *     （连 `generated_at` 都不转发——它是"这份快照何时生成"的元数据，不是看板要展示的事实）；
 *   · **确定性**：不读墙钟（不取任何时间值）、不随机；视角顺序按视角名排序（与写入顺序无关）→
 *     同一份快照两次 `snapshot()` **字节一致**；
 *   · **有界**：`views` 至多 `max_views` 条（超出在 `omitted_views` 报数）、`recent` 与每视角 `revs`
 *     至多 `max_recent` 条（超出在 `omitted_recent` 报数）、`headline` 按 UTF-8 字节夹取到 `max_bytes`；
 *   · **零 I/O、零事件**：不订阅事件、不注册定时器、不读写文件、不 import 任何运行时内建模块。
 */
import { number, object } from '../lib/std-schema.mjs'

export const name = 'pipeline-view'
export const inject = []                 // 纯函数插件：快照由调用方给（宿主一律"Python 写文件、宿主只读"）
export const builtin = []
export const usedServices = []
export const provides = ['pipelineView']

export const Config = object({
  max_views: number().default(4),        // 展示的视角数上限（有界，避免大快照把看板变成全量转储）
  max_recent: number().default(3),       // `recent` 与每视角 `revs` 的条数上限
  max_bytes: number().default(512),      // headline 的 UTF-8 字节上限
})

/** 三域（键名即契约，§2）。 */
export const VIEW_DOMAINS = ['negotiate', 'faq', 'mail']
/** 谈判域被读的计数键。 */
export const NEGOTIATE_KEYS = ['threads', 'open', 'closed', 'rounds', 'rejected']
/** 合计口径（§3：只这六项跨视角汇总；`open`/`closed`/`revs` 不在合计里）。 */
export const TOTAL_KEYS = ['threads', 'rounds', 'rejected', 'entries', 'queued', 'refused']
/** 通道声明的**三档位置**（顺序＝取 `reason`/`next_action` 的优先级顺序）。 */
export const TRANSPORT_TIERS = ['transport', 'mail.transport', 'views.<view>.mail.transport']
/** 降级原因码（闭合集合；门据此断言"降级是有名的，不是含糊的"）。 */
export const DEGRADED_REASONS = ['snapshot-not-an-object', 'snapshot-views-missing', 'snapshot-views-empty',
  'snapshot-view-shape-invalid', 'snapshot-totals-invalid']

/** 最近事件条目的来源键（negotiate/faq 各一条；mail 域 §2 不提供 `last`，故不猜）。 */
const RECENT_SPECS = [
  { domain: 'negotiate', refKeys: ['thread_id'], kindKey: 'kind', seqKey: 'attempt_no' },
  { domain: 'faq', refKeys: ['entry_id'], kindKey: null, seqKey: 'rfq_rev' },
]
/** 私域/正文标记：值里一旦出现，整段替换（不回显、不截断式泄漏）。 */
const MARKERS = [/private:/i, /\bbody\b/i, /\bsubject\b/i, /\battachment\b/i, /\breserve_price\b/i,
  /\bcost_model\b/i, /\bsignature\b/i, /[\u0000-\u001f\u007f]/]
const REDACTED = '(redacted)'
/** 降级时的说明（**无数字**，避免被当成一份"零的"统计读）。 */
const DEGRADED_HEADLINE = '管道快照不可用（形状非法）：不猜，三个域都不展示'
const DEGRADED_NEXT_ACTION = '检查 Python 快照写入器（tools/refresh-ui-snapshots.py）的输出文件'

const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** 快照里的计数：有限、非负的整数才收；NaN/Infinity/字符串/负数/缺失一律判为「不可用」。 */
const asCount = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0
  ? Math.trunc(value) : null)

/** 配置夹取：非有限数回落到默认值，越界夹到区间内（确定性，不抛错）。 */
const clampInt = (value, fallback, lower, upper) => {
  const size = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(upper, Math.max(lower, size))
}

/** 只放行**单行、无标记**的标识串；命中私域标记或控制字符 → 统一 `(redacted)`；非字符串/空串 → null。 */
const scrub = (value) => {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  return MARKERS.some((pattern) => pattern.test(text)) ? REDACTED : text
}

/** 按 UTF-8 字节夹取（整码点步进：不劈开多字节字符，结果字节数必然 ≤ maxBytes）。 */
const clip = (text, maxBytes) => {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let out = ''
  let used = 0
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (used + size > maxBytes) break
    out += char
    used += size
  }
  return out
}

const byName = (left, right) => (left < right ? -1 : (left > right ? 1 : 0))

/** 读一条**通道声明**（视角内与快照顶层同一个读法）。缺位＝未声明（不是畸形）。 */
const readDeclaration = (raw) => {
  if (raw === undefined || raw === null) {
    return { declared: false, ok: true, available: false, reason: '', next_action: '' }
  }
  if (!isPlain(raw) || typeof raw.available !== 'boolean') {
    return { declared: true, ok: false, available: false, reason: '', next_action: '' }
  }
  return { declared: true, ok: true, available: raw.available,
    reason: scrub(raw.reason) ?? '', next_action: scrub(raw.next_action) ?? '' }
}

/** 三档一致：**所有**声明位都说 true 才 true；否则 false + 第一处非空 reason / next_action（按档位顺序）。 */
export const reconcileTransport = (declarations) => {
  const found = declarations.filter((item) => item.declared)
  if (found.some((item) => !item.ok)) {
    return { available: false, reason: 'transport-declaration-malformed', next_action: '' }
  }
  if (found.length === 0) return { available: false, reason: 'transport-undeclared', next_action: '' }
  if (found.every((item) => item.available === true)) return { available: true, reason: '', next_action: '' }
  const reason = found.map((item) => item.reason).find((text) => text) ?? 'transport-unavailable'
  const next_action = found.map((item) => item.next_action).find((text) => text) ?? ''
  return { available: false, reason, next_action }
}

export function apply(ctx, config) {
  const maxViews = clampInt(config?.max_views, 4, 0, 64)
  const maxRecent = clampInt(config?.max_recent, 3, 0, 64)
  const maxBytes = clampInt(config?.max_bytes, 512, 0, 1048576)

  /** 全零形状：字段与正常输出**同一个形状**，只是数字全 0、列表全空、`degraded:true`。 */
  const degradedShape = (reason, omittedViews) => ({
    views: [],
    totals: Object.fromEntries(TOTAL_KEYS.map((key) => [key, 0])),
    totals_source: 'none',
    transport: { available: false, reason, next_action: DEGRADED_NEXT_ACTION },
    recent: [],
    omitted_views: omittedViews,
    omitted_recent: 0,
    bounded: false,
    degraded: true,
    source: 'pipeline-view',
    privacy: { entry_bodies_included: false, private_keys_included: false },
  })

  /**
   * 读一个视角：**形状门槛（宁可不判）**。三域缺失 / 非对象 / 计数类型错 / `revs` 含非数字 /
   * `transport.available` 非布尔 / `last` 存在但不是对象 → 返回 null（该视角被拒 → 整份快照降级）。
   * 展示型字段（id / 序号 / kind）只清洗、不降级：缺 id 记 `(unknown)`，不猜、不补 0。
   */
  const readView = (rawName, raw) => {
    if (!isPlain(raw)) return null
    const domains = {}
    for (const domain of VIEW_DOMAINS) {
      if (!isPlain(raw[domain])) return null
      domains[domain] = raw[domain]
    }
    const negotiate = {}
    for (const key of NEGOTIATE_KEYS) {
      const value = asCount(domains.negotiate[key])
      if (value === null) return null
      negotiate[key] = value
    }
    const entries = asCount(domains.faq.entries)
    if (entries === null || !Array.isArray(domains.faq.revs)) return null
    const revs = []
    for (const item of domains.faq.revs) {
      const value = asCount(item)
      if (value === null) return null
      revs.push(value)
    }
    const queued = asCount(domains.mail.queued)
    const refused = asCount(domains.mail.refused)
    if (queued === null || refused === null) return null
    const declaration = readDeclaration(domains.mail.transport)
    if (!declaration.ok) return null
    const recent = []
    for (const spec of RECENT_SPECS) {
      const last = domains[spec.domain].last
      if (last === undefined || last === null) continue      // 空域就是没有最近事件（不补一条假事件）
      if (!isPlain(last)) return null
      recent.push({
        view: scrub(rawName) ?? REDACTED,
        domain: spec.domain,
        ref: spec.refKeys.map((key) => scrub(last[key])).find((value) => value !== null) ?? '(unknown)',
        kind: spec.kindKey ? (scrub(last[spec.kindKey]) ?? '') : '',
        seq: asCount(spec.seqKey ? last[spec.seqKey] : null),
      })
    }
    return { name: scrub(rawName) ?? REDACTED, negotiate, entries, revs, queued, refused, declaration, recent }
  }

  /** 只读快照 → 运维视图。**全部数字来自快照**；本函数不做任何「应该怎样」的判断。 */
  const snapshot = (payload) => {
    if (!isPlain(payload)) return degradedShape('snapshot-not-an-object', 0)
    if (!isPlain(payload.views)) return degradedShape('snapshot-views-missing', 0)
    // 视角顺序＝视角名排序：与写入顺序无关（确定性），也避免"谁先写谁上头条"
    const names = Object.keys(payload.views).sort(byName)
    if (names.length === 0) return degradedShape('snapshot-views-empty', 0)   // 空 views 不是"健康的零"
    const declared = payload.totals === undefined || payload.totals === null ? null : payload.totals
    let totalsDecl = null
    if (declared !== null) {
      if (!isPlain(declared)) return degradedShape('snapshot-totals-invalid', 0)
      totalsDecl = {}
      for (const key of TOTAL_KEYS) {
        const value = asCount(declared[key])
        if (value === null) return degradedShape('snapshot-totals-invalid', 0)
        totalsDecl[key] = value
      }
    }
    const rows = []
    let rejected = 0
    for (const rawName of names) {
      const row = readView(rawName, payload.views[rawName])
      if (row === null) rejected += 1
      else rows.push(row)
    }
    if (rejected > 0) return degradedShape('snapshot-view-shape-invalid', rejected)
    const shown = rows.slice(0, maxViews)
    const omittedViews = rows.length - shown.length
    const recentAll = rows.flatMap((row) => row.recent)
    const recent = maxRecent === 0 ? [] : recentAll.slice(0, maxRecent)
    let omittedRecent = recentAll.length - recent.length
    const views = shown.map((row) => {
      const kept = maxRecent === 0 ? [] : row.revs.slice(-maxRecent)
      omittedRecent += row.revs.length - kept.length
      return {
        view: row.name,
        negotiate: { ...row.negotiate },
        faq: { entries: row.entries, revs: kept },
        mail: {
          queued: row.queued,
          refused: row.refused,
          transport_available: row.declaration.available,
          transport_reason: row.declaration.declared
            ? (row.declaration.reason || (row.declaration.available ? '' : 'transport-unavailable'))
            : 'transport-undeclared',
        },
      }
    })
    // 声明位顺序＝档位顺序；**被夹掉的视角也算**（有界只影响展示，不让通道声明悄悄变健康）
    const topMail = isPlain(payload.mail) ? readDeclaration(payload.mail.transport) : null
    const transport = reconcileTransport([readDeclaration(payload.transport), topMail,
      ...rows.map((row) => row.declaration)].filter((item) => item !== null))
    // 合计：快照给了就**照抄**（与视角之和是否一致不是本视图的事）；没给才跨视角相加并明示来源
    const totals = totalsDecl ?? summedTotals(rows)
    return {
      views,
      totals,
      totals_source: totalsDecl ? 'payload' : 'summed',
      transport,
      recent,
      omitted_views: omittedViews,
      omitted_recent: omittedRecent,
      bounded: omittedViews > 0 || omittedRecent > 0,
      degraded: false,
      source: 'pipeline-view',
      privacy: { entry_bodies_included: false, private_keys_included: false },
    }
  }

  /** 跨视角相加（只在快照**没给**合计时用；聚合是宿主的活，不跨出展示层）。 */
  const summedTotals = (rows) => {
    const totals = Object.fromEntries(TOTAL_KEYS.map((key) => [key, 0]))
    for (const row of rows) {
      totals.threads += row.negotiate.threads
      totals.rounds += row.negotiate.rounds
      totals.rejected += row.negotiate.rejected
      totals.entries += row.entries
      totals.queued += row.queued
      totals.refused += row.refused
    }
    return totals
  }

  /** 一行人类可读摘要（每视角三域 + 通道一格）；受 `max_bytes` 字节夹取。 */
  const headline = (payload) => {
    const snap = snapshot(payload)
    if (snap.degraded) return clip(DEGRADED_HEADLINE, maxBytes)
    const body = snap.views.map((row) => `${row.view}: 谈判 ${row.negotiate.threads}线程/`
      + `${row.negotiate.rounds}轮/拒 ${row.negotiate.rejected} · FAQ ${row.faq.entries}条`
      + ` · 邮件 排队 ${row.mail.queued}/拒 ${row.mail.refused}`).join(' | ')
    const channel = snap.transport.available ? '通道可用' : `通道不可用(${snap.transport.reason})`
    const omitted = snap.omitted_views > 0 ? `省略 ${snap.omitted_views} 视角` : ''
    return clip(['管道', body, channel, omitted].filter((part) => part !== '').join(' · '), maxBytes)
  }

  ctx.provide('pipelineView', { snapshot, headline })
}

/** fixture：纯读取（连跑两次比对字节；形状与 §2 的快照文件一致，只留视图会读的键） */
const SAMPLE_PAYLOAD = {
  generated_at: '2026-09-21T12:02:00Z',
  totals: { threads: 5, rounds: 7, rejected: 3, entries: 3, queued: 2, refused: 1 },
  views: {
    contractor: {
      negotiate: { threads: 3, open: 1, closed: 2, rounds: 4, rejected: 2,
        last: { thread_id: 'nt-0001', kind: 'round', attempt_no: 2 } },
      faq: { entries: 2, revs: [1, 2], last: { entry_id: 'fq-0001', rfq_rev: 2 } },
      mail: { queued: 1, refused: 1,
        transport: { available: false, reason: 'mail-transport-unavailable', next_action: '配置 SMTP/IMAP 凭据后接入' } },
    },
    supplier: {
      negotiate: { threads: 2, open: 1, closed: 1, rounds: 3, rejected: 1,
        last: { thread_id: 'nt-0002', kind: 'round-rejected', attempt_no: 3 } },
      faq: { entries: 1, revs: [3], last: { entry_id: 'fq-0002', rfq_rev: 3 } },
      mail: { queued: 1, refused: 0,
        transport: { available: false, reason: 'mail-transport-unavailable', next_action: '配置 SMTP/IMAP 凭据后接入' } },
    },
  },
}

export const fixture = {
  payload: SAMPLE_PAYLOAD,
  sample: (handle) => ({
    snap: handle.snapshot(SAMPLE_PAYLOAD),
    again: handle.snapshot(SAMPLE_PAYLOAD),
    text: handle.headline(SAMPLE_PAYLOAD),
  }),
}
