/**
 * 进树模块：`mail-view` —— **邮件域（SMTP / IMAP）的只读运维视图**。
 *
 * 为什么单独一个视图：`services/mail.py` + `services/mail_transport.py` 落地后，"邮件到底接没接上、
 * 上一次真发/真收的结果是什么、下一步该做什么"只活在 Python 侧的进程里与账本里，**运维道看不见**。
 * 本模块把 Python 侧写好的**状态快照**（`tmp/ui-shared/mail.json`）投影成有界、确定性的只读视图。
 *
 * 硬边界（每条都有门看着）：
 *   · **零写面**：本模块只 `readFileSync` 一个文件，不写文件、不写账本（H1）、不订阅事件、不注册定时器；
 *   · **不联网、不起子进程**：真收发只能在 Python 侧（本模块连 `net`/`child_process` 都不 import）；
 *   · **凭据不出现在这里**：本模块不读配置、不读凭据；快照里也**没有**值（写入器只写布尔/来源/计数/原因码），
 *     这一层再兜一遍——原因串里的私域/正文标记与控制字符一律替换成 `(redacted)`；
 *   · **降级优先**：快照文件缺失/读不到/不是 JSON/形状非法 → 全零形状 + `degraded:true` + **有名的** reason
 *     （绝不抛异常，也不给一个"看起来健康的零"）；
 *   · **确定性**：不读墙钟（不转发快照的 `generated_at`：它是"什么时候生成的"元数据，不是看板要展示的事实）、
 *     不随机；同一份快照两次 `snapshot()` **字节一致**；
 *   · **有界**：视角列表至多 `max_views` 条、尝试列表至多 `max_attempts` 条（超出在 `omitted_*` 报数）、
 *     `headline` 按 UTF-8 字节夹到 `max_bytes`。
 *
 * 契约：`provides: ['mailView']`，`inject: []`（纯函数 + 一个有界只读 I/O），`builtin: []`（不使用事件）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { number, object, string } from '../lib/std-schema.mjs'

export const name = 'mail-view'

export const inject = []
export const builtin = []
export const usedServices = []
export const provides = ['mailView']

export const Config = object({
  // Python 侧写的**邮件状态快照**绝对路径（'' = 未配置 → 走 `ui_shared` 兜底；两者都取不到 → degraded）
  mail_state: string().default(''),
  // 兜底共享目录（与 webui 的 `pipeline.json`/`retention-plan.json` 同一处；生产由 CLI 传绝对路径）
  ui_shared: string().default('tmp/ui-shared'),
  max_views: number().default(8),
  max_attempts: number().default(5),
  max_bytes: number().default(512),
})

/** 四个计数键（**键名即契约**：快照里就叫这四个）。 */
export const COUNT_KEYS = ['queued', 'refused', 'sent', 'parsed']
/** 降级原因码（闭合集合；门据此断言"降级是有名的，不是含糊的"）。 */
export const DEGRADED_REASONS = ['mail-snapshot-unconfigured', 'mail-snapshot-unreadable',
  'mail-snapshot-unparsable', 'mail-snapshot-not-an-object', 'mail-snapshot-shape-invalid']
/** 私域/正文标记：值里一旦出现，整段替换（不回显、不截断式泄漏）。 */
const MARKERS = [/private:/i, /\bbody\b/i, /\bsubject\b/i, /\battachment\b/i, /\breserve_price\b/i,
  /\bcost_model\b/i, /\bsignature\b/i, /[\u0000-\u001f\u007f]/]
const REDACTED = '(redacted)'
const DEGRADED_HEADLINE = '邮件状态快照不可用：不猜，队列与传输都不展示'
const DEGRADED_NEXT_ACTION = '让 Python 侧跑 src/system/mail/tools/mail-snapshot.py 写出 <shared>/mail.json'
const NOTE = '队列计数与最近一次尝试来自 Python 侧快照（mail_transport 的状态文件 + mail/* 账本行）；'
  + '本视图只读文件，不联网、不发信、不写账本，也不含任何凭据值与邮件正文'

const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** 计数：有限、非负的整数才收；NaN/Infinity/字符串/负数/缺失一律判为「形状非法」。 */
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

/** 一个服务（smtp/imap）的声明读数：`available` 必须是布尔（形状不对 → 整份快照降级）。 */
const readService = (raw) => {
  if (!isPlain(raw) || typeof raw.available !== 'boolean') return null
  return {
    configured: raw.configured === true,
    connected: raw.connected === true,
    available: raw.available,
    reason: scrub(raw.reason) ?? (raw.available ? '' : 'mail-transport-unavailable'),
    next_action: scrub(raw.next_action) ?? '',
  }
}

/** 一条尝试读数：只要键白名单里的键（键名/值都洗过），**不出**任何配置值。 */
const readAttempt = (raw) => {
  if (!isPlain(raw)) return null
  return {
    kind: scrub(raw.kind) ?? '(unknown)',
    service: scrub(raw.service) ?? '(unknown)',
    ok: raw.ok === true,
    reason: scrub(raw.reason) ?? '',
    next_action: scrub(raw.next_action) ?? '',
    message_id: scrub(raw.message_id),
  }
}

export function apply(ctx, config) {
  const cfg = isPlain(config) ? config : {}
  const stateFile = String(cfg.mail_state ?? '')
  const uiShared = String(cfg.ui_shared ?? 'tmp/ui-shared')
  const maxViews = clampInt(cfg.max_views, 8, 0, 64)
  const maxAttempts = clampInt(cfg.max_attempts, 5, 0, 64)
  const maxBytes = clampInt(cfg.max_bytes, 512, 0, 1048576)

  /** 快照文件落点：显式绝对路径优先；否则 `<ui_shared>/mail.json`（cwd 相对，生产必须传绝对路径）；
   *  两者都为空 → 返回 `''`（= **未配置**：视图给 `mail-snapshot-unconfigured`，而不是去猜一个相对路径）。 */
  const fileOf = () => {
    if (stateFile.trim() !== '') return stateFile
    if (uiShared.trim() === '') return ''
    return join(uiShared, 'mail.json')
  }

  /** 全零形状：字段与正常输出**同一个形状**，只是数字全 0、列表全空、`degraded:true`。 */
  const degradedShape = (reason, omittedViews = 0) => ({
    service: 'mail-view',
    source: 'Python 侧快照（宿主只读）',
    state_file_configured: stateFile.trim() !== '',
    counts: Object.fromEntries(COUNT_KEYS.map((key) => [key, 0])),
    totals_source: 'none',
    views: [],
    omitted_views: omittedViews,
    smtp: { configured: false, connected: false, available: false, reason, next_action: DEGRADED_NEXT_ACTION },
    imap: { configured: false, connected: false, available: false, reason, next_action: DEGRADED_NEXT_ACTION },
    last_attempt: null,
    attempts: [],
    omitted_attempts: 0,
    bounded: false,
    degraded: true,
    reason,
    next_action: DEGRADED_NEXT_ACTION,
    headline: DEGRADED_HEADLINE,
    privacy: { credentials_included: false, bodies_included: false },
    note: DEGRADED_HEADLINE,
  })

  /**
   * 快照 → 运维视图（**纯函数**：不做任何"应该怎样"的判断，只做形状门 + 白名单投影 + 夹取）。
   * 形状门槛（宁可不判）：三处任一不合规 → 全零 + `mail-snapshot-shape-invalid`。
   */
  const snapshot = (payload) => {
    if (!isPlain(payload)) return degradedShape('mail-snapshot-not-an-object')
    if (!isPlain(payload.views)) return degradedShape('mail-snapshot-shape-invalid')
    const names = Object.keys(payload.views).sort(byName)
    if (names.length === 0) return degradedShape('mail-snapshot-shape-invalid')
    const rows = []
    for (const rawName of names) {
      const raw = payload.views[rawName]
      if (!isPlain(raw)) return degradedShape('mail-snapshot-shape-invalid')
      const row = { view: scrub(rawName) ?? REDACTED }
      for (const key of COUNT_KEYS) {
        const value = asCount(raw[key])
        if (value === null) return degradedShape('mail-snapshot-shape-invalid')
        row[key] = value
      }
      rows.push(row)
    }
    // 合计：快照给了就**照抄**（与各视角之和是否一致不是本视图的事）；没给才跨视角相加并明示来源
    let totals = null
    if (payload.totals !== undefined && payload.totals !== null) {
      if (!isPlain(payload.totals)) return degradedShape('mail-snapshot-shape-invalid')
      totals = {}
      for (const key of COUNT_KEYS) {
        const value = asCount(payload.totals[key])
        if (value === null) return degradedShape('mail-snapshot-shape-invalid')
        totals[key] = value
      }
    }
    if (!isPlain(payload.transport)) return degradedShape('mail-snapshot-shape-invalid')
    const smtp = readService(payload.transport.smtp)
    const imap = readService(payload.transport.imap)
    if (smtp === null || imap === null) return degradedShape('mail-snapshot-shape-invalid')
    const lastRaw = payload.transport.last_attempt
    const last = (lastRaw === undefined || lastRaw === null) ? null : readAttempt(lastRaw)
    if (lastRaw !== undefined && lastRaw !== null && last === null) return degradedShape('mail-snapshot-shape-invalid')
    const rawAttempts = Array.isArray(payload.transport.attempts) ? payload.transport.attempts : []
    const attempts = []
    for (const item of rawAttempts) {
      const attempt = readAttempt(item)
      if (attempt === null) return degradedShape('mail-snapshot-shape-invalid')
      attempts.push(attempt)
    }
    const shown = rows.slice(0, maxViews)
    const omittedViews = rows.length - shown.length
    const keptAttempts = attempts.slice(0, maxAttempts)
    const projection = {
      service: 'mail-view',
      source: 'Python 侧快照（宿主只读：mail_transport 状态 + mail/* 账本计数）',
      state_file_configured: stateFile.trim() !== '',
      counts: totals ?? COUNT_KEYS.reduce((acc, key) => ({ ...acc, [key]: rows.reduce((sum, row) => sum + row[key], 0) }), {}),
      totals_source: totals ? 'payload' : 'summed',
      views: shown,
      omitted_views: omittedViews,
      smtp,
      imap,
      last_attempt: last,
      attempts: keptAttempts,
      omitted_attempts: attempts.length - keptAttempts.length,
      bounded: omittedViews > 0 || attempts.length > keptAttempts.length,
      degraded: false,
      reason: '',
      next_action: '',
      privacy: { credentials_included: false, bodies_included: false },
      note: NOTE,
    }
    return { ...projection, headline: summarize(projection) }
  }

  /** 读快照文件 → 视图（**唯一**的 I/O；任何失败都变成有名的 `degraded`，不抛）。 */
  const read = () => {
    const file = fileOf()
    if (String(file).trim() === '') {
      return { ...degradedShape('mail-snapshot-unconfigured'), state_file: null }
    }
    let text = null
    try {
      text = readFileSync(file, 'utf8')
    } catch (err) {
      return { ...degradedShape('mail-snapshot-unreadable'), state_file: file,
        detail: `code=${String(err?.code ?? 'unknown')}` }
    }
    let payload = null
    try {
      payload = JSON.parse(text)
    } catch (err) {
      return { ...degradedShape('mail-snapshot-unparsable'), state_file: file, bytes: Buffer.byteLength(text, 'utf8') }
    }
    return { ...snapshot(payload), state_file: file }
  }

  /** 一行摘要（从**投影**算：`headline(payload)` 与 `snapshot()` 走同一个口径，不另立第二套）。 */
  const summarize = (snap) => {
    if (snap.degraded) return clip(DEGRADED_HEADLINE, maxBytes)
    const counts = snap.counts
    const channel = `SMTP ${snap.smtp.available ? '可用' : `不可用(${snap.smtp.reason})`}`
      + ` · IMAP ${snap.imap.available ? '可用' : `不可用(${snap.imap.reason})`}`
    const last = snap.last_attempt
      ? `最近尝试 ${snap.last_attempt.kind}/${snap.last_attempt.service} ${snap.last_attempt.ok ? '成功' : `失败(${snap.last_attempt.reason})`}`
      : '还没有尝试记录'
    return clip(['邮件', `排队 ${counts.queued}`, `拒 ${counts.refused}`, `已发 ${counts.sent}`,
      `入站 ${counts.parsed}`, channel, last].join(' · '), maxBytes)
  }

  /** 一行人类可读摘要（收**快照 payload**；形状非法时给降级摘要，不抛）。 */
  const headline = (payload) => summarize(snapshot(payload))

  const stats = () => ({
    mail_state: stateFile, resolved_file: fileOf(), ui_shared: uiShared,
    limits: { max_views: maxViews, max_attempts: maxAttempts, max_bytes: maxBytes },
    counts: Object.fromEntries(COUNT_KEYS.map((key) => [key, key])),
    note: '只读：不写文件、不写账本、不联网、不取墙钟；不含凭据值（快照里也没有）',
  })

  ctx.provide('mailView', { read, snapshot, headline, stats })

  // 零残留：本模块不持有任何外部资源（无定时器、无 socket、无缓存），dispose 只做一次显式声明
  ctx.effect(() => () => {
    const released = maxViews + maxAttempts
    return released
  })
}

/** fixture（A5 确定性采样）：**只调纯函数**（不读文件、不依赖本机任何状态）——连跑两次比对字节。 */
const SAMPLE_PAYLOAD = {
  schema: 1,
  generated_at: '2026-09-21T12:00:00Z',
  service: 'mail',
  totals: { queued: 3, refused: 2, sent: 1, parsed: 1 },
  views: {
    contractor: { queued: 2, refused: 2, sent: 1, parsed: 1 },
    supplier: { queued: 1, refused: 0, sent: 0, parsed: 0 },
  },
  transport: {
    smtp: { configured: true, connected: true, available: true, reason: '', next_action: '' },
    imap: { configured: false, connected: false, available: false,
      reason: 'mail-imap-unconfigured', next_action: '把 IMAP 接入点配置：mail.imap.host / port' },
    last_attempt: { kind: 'send', service: 'smtp', ok: true, reason: '', next_action: '',
      message_id: 'ml-0001' },
    attempts: [{ kind: 'send', service: 'smtp', ok: false, reason: 'smtp-unreachable', next_action: '确认端口' },
      { kind: 'fetch', service: 'imap', ok: true, reason: '', next_action: '' }],
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
