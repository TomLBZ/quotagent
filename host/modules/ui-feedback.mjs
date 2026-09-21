/**
 * 进树模块：`ui-feedback`（WebUI 自适应闭环的**宿主侧一半**）。
 *
 * 用户要求（2026-09-21）：**用户反馈 → agent 产新版本 → 自动重载 → 页面提示"请刷新"**。
 * 本插件只做四件事，别的都不做：
 *
 *   ① `GET /<prefix>/<view>/feedback` —— SSR 页（一个 `<textarea>` + 一个提交按钮）；
 *   ② `POST /<prefix>/<view>/feedback` —— 宿主**只**往 `<ui_shared>/ui-feedback/` 落**一条 0600 待办件**
 *      （含用户**原话正文** + 正文 sha256 + 视图名 + 提交时看到的版本号），**账本零新增**（H1）；
 *   ③ `GET /<prefix>/ops/ui-feedback/` 与 `GET /<prefix>/api/ui-feedback` —— **只读观察面**：
 *      待处理计数 / 最近一次处理结果与 `reason` / 各视图版本号 / `available` / `degraded`+`reason`；
 *      有界（`limit` + `omitted` 照实报）、确定性（同输入两次逐字节一致）。
 *   ④ 页面装饰：每页 `<html>` 上写 `data-ui-revision="rN"`；当**最新已应用版本 > 本视图版本**时，
 *      在页面顶部渲染 `data-ui-stale="true"` 横幅（含"已更新到 rM，请刷新页面"与一个
 *      `<form method=get>` 的"我已刷新"按钮，带上 `seen=rM` → 横幅消失）。版本号**只来自落盘事实**
 *      （`<ui_shared>/ui-feedback/versions.json`，由 Python 侧 `tools/ui-feedback-apply.py` 原子写），
 *      本插件**从不递增版本号**：读不到就当 `r0` 并诚实降级。
 *
 * 硬约束（本仓纪律）：
 *   · 页面 **0 行脚本 / 0 内联事件**：读用链接、写用 `<form method=post>`、翻页用 `<form method=get>`；
 *   · 宿主**不写账本**（本文件不 import 任何账本视图，也不 append 任何行）；
 *   · 不联网、不起子进程、不取墙钟、不取随机数（写面只有那条 0600 待办件）；
 *   · 拒绝路径一律给**具体 code** + `next_action`，不静默放行。
 */
import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { array, constant, number, object, string } from '../lib/std-schema.mjs'

export const name = 'ui-feedback'

export const inject = []              // 纯文件读写：不依赖任何别的服务（D-027：本地句柄即可）

export const builtin = []             // 本模块不使用事件：声明即事实（D-015 / A1 双向断言）

export const usedServices = []

export const provides = ['uiFeedback']

export const Config = object({
  route_prefix: string().default('/quotagent'),
  views: array(string()).default(['contractor', 'supplier']),
  ui_shared: string().default('tmp/ui-shared'),   // 与 webui 同一口径；`<ui_shared>/ui-feedback/` 是本插件的全部写面
  pending_limit: number().default(5),             // 观察面一次最多列出的待办件条数（有界）
  max_text_bytes: number().default(4096),         // 单条反馈正文的**字节**上界（超出即拒，不截断）
  deterministic: constant(true),                  // 翻转即拒：本插件没有任何非确定性来源
})

/** `degraded` 的**有名 reason 闭合集合**（门与观察面共用这一处真源）。 */
export const DEGRADED_REASONS = ['ui-shared-unresolved', 'versions-missing', 'versions-unreadable', 'pending-unreadable']

/** 提交被拒的**有名 code 闭合集合**。 */
export const SUBMISSION_CODES = ['accepted', 'view-unknown', 'empty-feedback', 'feedback-too-long',
  'ui-shared-unresolved', 'pending-write-failed']

/** 版本号零值：读不到事实时**就报零**（绝不凭空递增）。 */
export const REVISION_ZERO = 'r0'

const VERSIONS_FILE = 'versions.json'
const FEEDBACK_DIR = 'ui-feedback'
const PENDING_PREFIX = 'fb-'
const APPLIED_DIR = 'applied'
const ID_RE = /^fb-[A-Za-z0-9-]+-[0-9a-f]{12}$/

const esc = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

/** 版本号 → 数字（认不出就是 0：**不猜**）。 */
const revisionNumber = (revision) => {
  const match = /^r(\d+)$/.exec(String(revision ?? ''))
  return match ? Number(match[1]) : 0
}

export function apply(ctx, config) {
  const prefix = String(config.route_prefix ?? '/quotagent').replace(/\/$/, '')
  const views = [...(config.views ?? [])]
  const limit = Math.max(0, Math.floor(Number(config.pending_limit) || 0))
  const maxBytes = Math.max(1, Math.floor(Number(config.max_text_bytes) || 0))
  const shared = String(config.ui_shared ?? '').trim()

  const feedbackDir = () => join(shared, FEEDBACK_DIR)
  const versionsPath = () => join(feedbackDir(), VERSIONS_FILE)

  /** 路由 → 装饰作用域：`/<view>/…` 用该视图的版本号；其余页面（运维/管理/上手/根）用 `ops`。 */
  const scopeOf = (path) => {
    const first = String(path ?? '/').split('/').filter(Boolean)[0] ?? ''
    return views.includes(first) ? first : 'ops'
  }

  /**
   * 读**落盘的版本事实**（`versions.json`，唯一写者是 Python 侧 `tools/ui-feedback-apply.py`）。
   * 读不到/读不懂 → `degraded:true` + **有名 reason**（不是"看起来像没有数据"）。
   */
  const readState = () => {
    if (shared === '') return { degraded: true, reason: 'ui-shared-unresolved', versions: null }
    let text = ''
    try {
      text = readFileSync(versionsPath(), 'utf8')
    } catch (err) {
      return { degraded: true, reason: err && err.code === 'ENOENT' ? 'versions-missing' : 'versions-unreadable', versions: null }
    }
    try {
      const parsed = JSON.parse(text)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('versions-not-an-object')
      return { degraded: false, reason: null, versions: parsed }
    } catch (err) {
      return { degraded: true, reason: 'versions-unreadable', versions: null }
    }
  }

  const viewsMap = (versions) => {
    const raw = versions && typeof versions === 'object' ? versions.views : null
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  }

  /** 某视图的版本号（只认 `r<数字>`；认不出就是 `r0`）。 */
  const revisionOf = (view) => {
    const entry = viewsMap(readState().versions)[view]
    const revision = entry && typeof entry === 'object' ? entry.revision : null
    return typeof revision === 'string' && /^r\d+$/.test(revision) ? revision : REVISION_ZERO
  }

  /** **最新已应用版本**：逐个视图按配置顺序取版本号，取最大者（facts；不读自述的 `latest` 字段）。 */
  const latestOf = () => {
    let best = { view: '', revision: REVISION_ZERO, number: 0 }
    for (const view of views) {
      const revision = revisionOf(view)
      const num = revisionNumber(revision)
      if (num > best.number) best = { view, revision, number: num }
    }
    return best
  }

  /**
   * `ops` 作用域：观察面**就是当前状态的投影**（它每次现读落盘事实）→ 永远与最新版本同版，
   * 因此运维/管理/上手页不会出现"请刷新"横幅；横幅只对**业务视图页**有意义。
   */
  const scopeRevision = (scope) => (scope === 'ops' ? latestOf().revision : revisionOf(scope))

  const pendingIds = () => {
    try {
      return readdirSync(feedbackDir())
        .filter((item) => item.startsWith(PENDING_PREFIX) && item.endsWith('.json'))
        .map((item) => item.slice(0, -'.json'.length))
        .filter((item) => ID_RE.test(item))
        .sort()
    } catch (err) {
      return []
    }
  }

  const appliedIds = () => {
    try {
      return readdirSync(join(feedbackDir(), APPLIED_DIR))
        .filter((item) => item.endsWith('.json')).map((item) => item.slice(0, -'.json'.length)).sort()
    } catch (err) {
      return []
    }
  }

  /** 最近一次**已应用**记录（来自 `versions.json#applied` 的最后一条；读不到就是 null）。 */
  const lastApplied = () => {
    const rows = readState().versions?.applied
    if (!Array.isArray(rows) || rows.length === 0) return null
    const row = rows[rows.length - 1]
    if (!row || typeof row !== 'object') return null
    return {
      view: String(row.view ?? ''), revision: String(row.revision ?? ''),
      prev_revision: String(row.prev_revision ?? ''), ok: row.ok === true,
      reason: typeof row.reason === 'string' ? row.reason : '',
    }
  }

  /** 观察面：确定性 + 有界（ids 只列前 `limit` 条，`omitted` 照实报数）。 */
  const snapshot = () => {
    const state = readState()
    const ids = pendingIds()
    const shown = ids.slice(0, limit)
    const rows = shown.map((id) => {
      const file = join(feedbackDir(), `${id}.json`)
      let bytes = 0
      let digest = ''
      try {
        const record = JSON.parse(readFileSync(file, 'utf8'))
        bytes = Number.isFinite(record?.bytes) ? record.bytes : 0
        digest = String(record?.text_sha256 ?? '')
      } catch (err) { bytes = -1 }
      return { id, view: id.split('-')[1] ?? '', bytes, text_sha256: digest, file: `${FEEDBACK_DIR}/${id}.json` }
    })
    return {
      service: 'ui-feedback',
      available: !state.degraded,
      degraded: state.degraded,
      reason: state.reason,
      next_action: state.degraded
        ? '落盘事实缺失：由 Python 侧 `tools/ui-feedback-apply.py` 消费待办件后写 `<ui_shared>/ui-feedback/versions.json`'
        : '',
      scope: { ops: latestOf().revision, views: Object.fromEntries(views.map((view) => [view, revisionOf(view)])) },
      latest: latestOf(),
      queue: { pending: ids.length, applied: appliedIds().length, limit, omitted: Math.max(0, ids.length - shown.length), items: rows },
      last_applied: lastApplied(),
      counts_source: `${FEEDBACK_DIR}/${VERSIONS_FILE}`,
      bounded: true,
      privacy: { feedback_bodies_included: false },
    }
  }

  // ---------------------------------------------------------------------------
  // 页面（SSR；**0 行脚本 / 0 内联事件**）
  // ---------------------------------------------------------------------------
  const navHtml = (view) => `<nav><a href="${prefix}/">总览</a>`
    + `<a href="${prefix}/${esc(view)}/">${esc(view)} 视角</a>`
    + `<a href="${prefix}/ops/ui-feedback/">反馈观察面</a>`
    + `<a href="${prefix}/start/">上手</a></nav>`

  const feedbackPage = (view, query = '') => {
    const state = readState()
    const revision = scopeRevision(view)
    const accepted = String(query).includes('submitted=1')
    return '<!doctype html><html lang="zh"><head><meta charset="utf-8">'
      + `<title>${esc(view)} 视角 · 反馈</title><style>body{font:14px/1.6 system-ui,sans-serif;margin:2rem;max-width:60rem}`
      + 'code{background:#f3f3f3;padding:.1em .3em;border-radius:3px}nav a{margin-right:1rem}'
      + 'table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:.35rem .5rem;text-align:left;font-size:13px}</style>'
      + `</head><body>${navHtml(view)}<h1>给这一屏提反馈</h1>`
      + `<p>当前版本号：<code data-ui-revision-at="${esc(view)}">${esc(revision)}</code>`
      + `（只读事实，来自 <code>${FEEDBACK_DIR}/${VERSIONS_FILE}</code>；本插件**不递增**版本号）</p>`
      + (accepted ? '<p data-ui-feedback="accepted">已收到：待办件已落盘（0600），由 Python 侧消费后产出新版本。</p>' : '')
      + '<p>把你在这一屏上遇到的问题**用自己的话**写下来。提交只做一件事：在 '
      + `<code>${esc(feedbackDir())}/</code> 落**一条 0600 待办件**（含你的原话正文与 sha256）——`
      + '宿主**不写账本、不改页面**；改这一屏由 agent 产新版本，落地后你会看到"请刷新"提示。</p>'
      + `<form method="post" action="${prefix}/${esc(view)}/feedback">`
      + '<p><textarea name="text" rows="6" cols="72" placeholder="例如：报价表里看不到交期，得来回翻页"></textarea></p>'
      + '<p><button type="submit">提交反馈</button></p></form>'
      + (state.degraded
        ? `<p><b>降级</b>：<code>${esc(state.reason ?? '')}</code>（版本事实缺失 ⇒ 当前一律显示 `
          + `<code>${REVISION_ZERO}</code>，不猜）</p>` : '')
      + `<p><small>本页 **0 行脚本、0 内联事件**：写用 <code>form method=post</code>，读用链接。</small></p>`
      + '</body></html>'
  }

  const opsPage = () => {
    const snap = snapshot()
    const items = snap.queue.items.map((item) => `<tr><td><code>${esc(item.id)}</code></td>`
      + `<td>${esc(item.view)}</td><td>${item.bytes < 0 ? '（读不到）' : item.bytes}</td>`
      + `<td><code>${esc(item.text_sha256).slice(0, 19)}…</code></td></tr>`).join('')
    const last = snap.last_applied
    const viewRows = views.map((view) => `<tr><td>${esc(view)}</td>`
      + `<td><code>${esc(revisionOf(view))}</code></td></tr>`).join('')
    return '<!doctype html><html lang="zh"><head><meta charset="utf-8">'
      + '<title>WebUI 反馈观察面</title><style>body{font:14px/1.6 system-ui,sans-serif;margin:2rem;max-width:60rem}'
      + 'code{background:#f3f3f3;padding:.1em .3em;border-radius:3px}nav a{margin-right:1rem}'
      + 'table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:.35rem .5rem;text-align:left;font-size:13px}</style>'
      + `</head><body>${navHtml(views[0] ?? 'contractor')}<h1>WebUI 反馈观察面（只读）</h1>`
      + '<p>本面**只读**：待处理计数 / 最近一次处理结果与原因 / 各视图版本号。'
      + '反馈**正文只留在 0600 待办件里**，不出现在任何页面。</p>'
      + `<p>JSON：<code>${prefix}/api/ui-feedback</code></p>`
      + (snap.degraded
        ? `<p data-ui-feedback="degraded"><b>降级</b>：<code>${esc(snap.reason ?? '')}</code> → ${esc(snap.next_action)}</p>`
        : '<p data-ui-feedback="available">可用：版本事实已落盘（读它不改状态）</p>')
      + `<h3 id="queue">待处理 / 已处理</h3>`
      + `<table data-ui-feedback="queue"><tr><th>待处理</th><th>已处理</th><th>上限</th><th>未列出</th></tr>`
      + `<tr><td data-ui-feedback-pending="${snap.queue.pending}">${snap.queue.pending}</td>`
      + `<td>${snap.queue.applied}</td><td>${snap.queue.limit}</td><td>${snap.queue.omitted}</td></tr></table>`
      + `<h3 id="last">最近一次处理结果</h3>`
      + (last
        ? `<table data-ui-feedback="last"><tr><th>视图</th><th>新版本</th><th>上一版本</th><th>结果</th><th>原因</th></tr>`
          + `<tr><td>${esc(last.view)}</td><td><code>${esc(last.revision)}</code></td>`
          + `<td><code>${esc(last.prev_revision)}</code></td><td>${last.ok ? '已应用' : '被拒'}</td>`
          + `<td><code>${esc(last.reason || '—')}</code></td></tr></table>`
        : '<p data-ui-feedback="last-applied-none">还没有处理过任何反馈（reason=<code>no-applied-yet</code>）。</p>')
      + `<h3 id="versions">各视图版本号（页面上的 <code>data-ui-revision</code> 就是它）</h3>`
      + `<table data-ui-feedback="versions"><tr><th>视图</th><th>版本号</th></tr>${viewRows}</table>`
      + `<p>最新已应用版本：<code>${esc(snap.latest.revision)}</code>`
      + `${snap.latest.view ? `（来自 ${esc(snap.latest.view)}）` : '（还没有任何已应用版本）'}`
      + `；观察面自身版本：<code>${esc(snap.scope.ops)}</code>。</p>`
      + `<h3 id="pending">待处理清单（有界：最多 ${snap.queue.limit} 条；正文不出）</h3>`
      + (items ? `<table data-ui-feedback="pending"><tr><th>待办件 id</th><th>视图</th><th>字节</th><th>正文 sha256（前 19）</th></tr>`
        + `${items}</table>` : '<p data-ui-feedback="pending-none">当前没有待处理件。</p>')
      + '<p><small>本页 **0 行脚本、0 内联事件**；宿主不写账本、不取墙钟、不联网。</small></p>'
      + '</body></html>'
  }

  // ---------------------------------------------------------------------------
  // 提交：**只**落一条 0600 待办件（不写账本、不改版本号）
  // ---------------------------------------------------------------------------
  const submitFeedback = (view, rawText) => {
    const text = typeof rawText === 'string' ? rawText : ''
    const digest = `sha256:${sha256(text)}`
    const bytes = Buffer.byteLength(text, 'utf8')
    const refuse = (code, next_action) => ({ ok: false, code, next_action, view, bytes, text_sha256: digest })
    if (!views.includes(view)) {
      return refuse('view-unknown', `视图名必须是 ${views.join(' / ')} 之一（不认识的视图一律拒，不猜）`)
    }
    if (text.trim() === '') {
      return refuse('empty-feedback', '把问题用原话写进 textarea 再提交（空反馈不落盘：没有内容就没有事实）')
    }
    if (bytes > maxBytes) {
      return refuse('feedback-too-long', `正文 ${bytes} 字节 > 上限 ${maxBytes}：请拆分后重提（宿主不截断、不静默丢）`)
    }
    if (shared === '') return refuse('ui-shared-unresolved', '宿主未配置 ui_shared：无法确定待办件目录，拒绝写任何地方')
    const id = `${PENDING_PREFIX}${view}-${sha256(text).slice(0, 12)}`
    const record = {
      schema: 1, kind: 'ui-feedback', view, text,
      text_sha256: digest, bytes, revision_at_submit: scopeRevision(view), submitted_at: '',
      note: '宿主只落本条 0600 待办件（含用户原话）；不写账本、不改版本号；时间由 Python 侧按 --now 落账',
    }
    const dir = feedbackDir()
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      // 幂等：同一份正文 → 同一个 id（sha256 决定）；已存在就是同一件事，不重复落
      try {
        statSync(join(dir, `${id}.json`))
        return { ok: true, code: 'accepted', duplicate: true, id, view, bytes, text_sha256: digest,
          revision_at_submit: record.revision_at_submit,
          next_action: `待办件已存在（同一份正文）：跑 tools/ui-feedback-apply.py --view ${view} --now <ISO8601> 消费它（唯一落账本者）` }
      } catch (err) { /* 不存在：继续写 */ }
      const tmp = join(dir, `.${id}.tmp.${process.pid}`)
      writeFileSync(tmp, JSON.stringify(record, null, 1) + '\n', { encoding: 'utf8', mode: 0o600 })
      chmodSync(tmp, 0o600)                      // 显式 chmod：不受 umask 影响（待办件必须**恰为** 0600）
      renameSync(tmp, join(dir, `${id}.json`))
    } catch (err) {
      return refuse('pending-write-failed', `待办件写失败（${String(err && err.code ? err.code : err).slice(0, 40)}）：先修目录权限再重提`)
    }
    return { ok: true, code: 'accepted', duplicate: false, id, view, bytes, text_sha256: digest,
      revision_at_submit: record.revision_at_submit,
      next_action: `跑 tools/ui-feedback-apply.py --view ${view} --now <ISO8601> 消费待办件（唯一落账本者）；`
        + '产出新版本后本页面会显示"请刷新"' }
  }

  /** 页面装饰（webui 在发送 HTML 时调用）：`data-ui-revision` + 顶部的"请刷新"横幅。 */
  const decorate = (path, seen = '') => {
    const scope = scopeOf(path)
    const state = readState()
    const revision = scopeRevision(scope)
    const latest = latestOf()
    const stale = !state.degraded && scope !== 'ops'
      && latest.number > revisionNumber(revision) && String(seen ?? '') !== latest.revision
    return {
      scope, revision, latest: { view: latest.view, revision: latest.revision },
      stale, degraded: state.degraded, reason: state.reason,
      banner: stale
        ? '<div data-ui-stale="true" style="border:2px solid #b00020;background:#fff4f4;padding:.7rem .9rem;margin:.8rem 0">'
          + `<b>这一屏（${esc(scope)}）还是 <code>${esc(revision)}</code>：已更新到 ${esc(latest.revision)}，请刷新页面。</b> `
          + `<form method="get" action="${prefix}${esc(path)}">`
          + `<input type="hidden" name="seen" value="${esc(latest.revision)}">`
          + '<button type="submit">我已刷新</button></form></div>'
        : '',
    }
  }

  const handle = {
    requests: ['submitFeedback'],   // 只声明事实：别的都不是服务面
    prefix, views, feedbackDir: feedbackDir(), limit, maxTextBytes: maxBytes,
    revisionOf, scopeOf, scopeRevision, latestOf, snapshot, decorate,
    feedbackPage, opsPage, submitFeedback, pendingIds, appliedIds, lastApplied,
  }
  ctx.provide('uiFeedback', handle)
}

/** A5 采样点（**纯读取**：同输入两次逐字节一致）。 */
export const fixture = {
  sample: (handle) => JSON.stringify({
    service: handle?.snapshot?.().service, queue: handle?.snapshot?.().queue.pending,
    scope: handle?.snapshot?.().scope, degraded: handle?.snapshot?.().degraded,
    revision: handle?.revisionOf?.('contractor'),
  }),
}
