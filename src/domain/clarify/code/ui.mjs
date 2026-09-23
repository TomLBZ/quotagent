/**
 * `domain/clarify` 的 **GUI 贡献** —— 供应商侧「与承包商的**往来**」这一块（本批 P1 供应商缺口）：
 *
 *   · **提问澄清（DEF-015）**：面板 `exchange.threads`（我的工单 + **问答串**：问题、条目引用、答复正文）
 *     + 动作 `exchange.ask`（服务端一半跑唯一写者 `tools/clarify-apply.py --action ask`）；
 *   · **承包商侧答疑（DEF-014 的写面一半）**：面板 `exchange.queue`（待答队列）+ 动作 `exchange.answer`
 *     （`--action answer`）——作答后**供应商侧看得见答复正文**（双向可断言）；
 *   · **认收（DEF-016）**：面板 `exchange.inbox` 的行/工具栏按钮「我已收到 @revN」→ 动作 `exchange.ack`
 *     （`tools/package-ops.py --action ack`）。

 *   · **回文承诺（DEF-024）**：动作 `exchange.promise`（`--action promise`）——**同一个包，首页看得见就必须
 *     承诺得了**：唯一写者按"本人账本事实 ∪ 投递信封"两种口径找包（见该脚本头部的口径说明），
 *     承包商侧的 `due_ts` 读的就是它落的 `rfq/promised`。
 *   · **中标 / 落标 / PO 确认（DEF-022）**：面板 `exchange.awards` / `exchange.lost` + 动作
 *     `exchange.declare-outcome`（承包商：告知结果，**落标必须有明确告知**）、`exchange.confirm-award`
 *     （确认中标 + 能否按期）、`exchange.confirm-po`（确认收到 PO）、`exchange.ack-lost`（我知道未中选）；
 *     服务端一半跑 `tools/outcome-ops.py`。
 *
 * 纪律：本文件**不写账本**（`host.runPython` 只 spawn 唯一写者；写账本的是插件自己的 Python 侧），
 * 也不读别人的账本（只读 `host.rows(本视角)` 的公开投影行 + 共享目录里的**投递信封**）。
 * 一切注册都经注册面（`code/ui-surface.mjs`），卸载即全部消失（AGENTS.md 规则 1）。
 */
export const plugin_id = 'domain/clarify'

import { createHash } from 'node:crypto'

const asText = (value) => (typeof value === 'string' ? value.trim() : '')

/**
 * 工作台的卡头那句「有 N 件需要你处理」**只该算本侧**（P13 可用性修）：卡片把两侧插件贡献的待办并在一起，
 * 而"需要你处理"必须是**你能真去办**的 —— 对面侧的条目照旧列出来（带侧标），但降级成"信息"，
 * 并说清"这一步由哪一侧的人办"。未登录 ⇒ 没有"本侧"，一律按"信息"算（协作面会在卡上留一条"先登录"）。
 */
const mySideOf = (ctx) => asText(ctx?.identity?.side)
const sideScoped = (ctx, itemSide, item) => {
  const mine = mySideOf(ctx)
  if (mine === itemSide) return item
  const label = itemSide === 'contractor' ? '承包商侧' : '供应商侧'
  const why = mine === ''
    ? `（未登录：登录${label}之后这一条才算"需要你处理"）`
    : `（不是你要办的：这一步由${label}的人做 —— 卡头「有 N 件需要你处理」只算本侧）`
  const body = asText(item.body)
  return { ...item, level: (item.level === 'warn' || item.level === 'bad') ? 'info' : item.level,
    body: `${body}${body ? ' ' : ''}${why}` }
}
const bodyOf = (row) => (row && typeof row.body === 'object' && row.body !== null ? row.body : {})
const typeRows = (rows, ...types) => rows.filter((row) => types.includes(String(row?.type ?? '')))
const prefixRows = (rows, prefix) => rows.filter((row) => String(row?.type ?? '').startsWith(prefix))
const truthy = (value) => value === true || value === 'true' || value === '1'
/** 「行」的最小形状：非 null 的**对象**（数组不是行）。 */
const isRow = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
/**
 * **行数组的唯一读数入口**（`lines[]` / 包的行项目：坏行逐条计数、好行照列）。
 * 为什么必须有它（P27 实测的根因）：数组里混进一条 `null`/字符串时读 `line.item_id` 就抛 `TypeError`，
 * 而外壳对 `panel.data()` 抛错的处理是**整块面板判 `data-failed`** —— 一条坏行打崩一整块。
 */
const readRows = (value) => {
  if (!Array.isArray(value)) return { list: false, all: 0, rows: [], dropped: 0 }
  const rows = value.filter((row) => isRow(row))
  return { list: true, all: value.length, rows, dropped: value.length - rows.length }
}
/**
 * 逐行文本：`read` 由 `readRows(...)` 给（**调用口径：把 `readRows(...)` 写在参数上**）；
 * `max > 0` 时超长截断并**带省略号**（不静默截断）。
 */
const linesTextOf = (read, render, { sep = '、', max = 0 } = {}) => {
  if (!read.list) return ''
  const text = read.rows.map(render).join(sep)
  const clipped = max > 0 && text.length > max ? `${text.slice(0, max)}…` : text
  if (!read.dropped) return clipped
  return `${clipped || '（没有行明细）'}${clipped ? ' · ' : ''}另有 ${read.dropped} 条读不出来（形状异常，已跳过并计数）`
}
/**
 * 名单字段（`delivered_to` 这类"给谁"的标量列表）：**不是数组 ⇒ 空名单**（不猜、不抛）。
 * 修前是 `(item.delivered_to ?? []).map(String)`：`item` 是 `null` 时直接 TypeError，
 * 整块面板判 `data-failed`（P30 坏行注入实测：意向信封里混一条 `null` 就把面板打崩）。
 */
const nameListOf = (value) => (Array.isArray(value) ? value : [])
  .filter((item) => item !== null && item !== undefined).map(String)
const PACKAGE_TYPES = ['rfq/published', 'rfq/distributed', 'rfq/amended']

/** 投递信封（首页「我收到的包」用的同一份；文件或目录，插件的只读来源）。 */
const envelopesOf = (host) => {
  const target = asText(host.config?.rfq_delivery)
  if (target === '') return []
  const one = host.readJson(target)
  if (Array.isArray(one)) return one
  if (one && typeof one === 'object') return [one]
  return []
}

/** 本视角可见的包（**两种口径**：本人账本事实 ∪ 投递信封）——与唯一写者同一口径。 */
const visiblePackages = (host, view) => {
  const realm = realmOf(host, view)
  const out = new Map()
  for (const row of typeRows(host.rows(view), ...PACKAGE_TYPES)) {
    const body = bodyOf(row)
    const packageId = asText(body.package_id) || asText(row?.correlation_id)
    if (packageId === '') continue
    const entry = out.get(packageId) ?? { package_id: packageId, revs: new Set(), items: [], sources: new Set(),
      quote_by: '', subject: '', seen_at: '' }
    if (Number.isInteger(body.rev)) entry.revs.add(body.rev)
    // `items` 在不同事实行里语义不同（`rfq/published` 给的是**条目数**，投递登记给的是数组）——
    // 只认数组，数字不当数组迭代（否则面板会 data-failed）
    for (const item of (Array.isArray(body.items) ? body.items : [])) {
      if (item && item.item_id) entry.items.push(item)
    }
    for (const item of (Array.isArray(body.spec?.items) ? body.spec.items : [])) {
      if (item && item.item_id) entry.items.push(item)
    }
    entry.quote_by = asText(body.quote_by) || asText(body.spec?.deadlines?.quote_by) || entry.quote_by
    entry.subject = asText(body.subject) || asText(body.spec?.subject) || entry.subject
    entry.seen_at = String(row?.ts ?? '') > entry.seen_at ? String(row?.ts ?? '') : entry.seen_at
    entry.sources.add(String(row.type))
    out.set(packageId, entry)
  }
  for (const envelope of envelopesOf(host)) {
    const spec = envelope.spec && typeof envelope.spec === 'object' ? envelope.spec : {}
    const packageId = asText(spec.package_id)
    if (packageId === '') continue
    const delivered = (envelope.delivered_to ?? []).map(String)
    if (delivered.length && realm && !delivered.includes(realm)) continue
    const entry = out.get(packageId) ?? { package_id: packageId, revs: new Set(), items: [], sources: new Set(),
      quote_by: '', subject: '', seen_at: '' }
    if (Number.isInteger(envelope.rev)) entry.revs.add(envelope.rev)
    for (const item of (Array.isArray(spec.items) ? spec.items : [])) {
      if (item && item.item_id) entry.items.push(item)
    }
    entry.quote_by = asText(spec.deadlines?.quote_by) || entry.quote_by
    entry.subject = asText(spec.subject) || entry.subject
    entry.seen_at = String(envelope.sent_at ?? '') > entry.seen_at ? String(envelope.sent_at ?? '')
      : entry.seen_at
    entry.sources.add('delivery-envelope')
    out.set(packageId, entry)
  }
  return [...out.values()].map((entry) => {
    // 行项目去重：账本事实与投递信封都会带 items，同一条目只留一份（不重复渲染、不重复计数）
    const seen = new Map()
    for (const item of entry.items) {
      const key = String(item?.item_id ?? '')
      if (key !== '' && !seen.has(key)) seen.set(key, item)
    }
    return { ...entry, items: [...seen.values()], revs: [...entry.revs].sort((a, b) => a - b),
      sources: [...entry.sources] }
  })
}

const realmOf = (host, view) => {
  const found = host.rows(view).find((row) => asText(row?.realm) !== '')
  return found ? asText(found.realm) : ''
}

/** 本视角的澄清工单（账本重放：open / answered / closed + 答复正文）。 */
const ticketsOf = (host, view) => {
  const tickets = new Map()
  for (const row of prefixRows(host.rows(view), 'clarification/')) {
    const body = bodyOf(row)
    const ticketId = asText(body.ticket_id)
    if (ticketId === '') continue
    const entry = tickets.get(ticketId) ?? { ticket_id: ticketId, package_id: asText(body.package_id),
      rfq_rev: body.rfq_rev ?? null, item_ids: body.refs?.item_ids ?? [], question: asText(body.question),
      asker: asText(body.asker_realm) || asText(body.by), status: 'open', answer: '', answered_by: '',
      answered_at: '', at: '' }
    if (String(row.type) === 'clarification/asked') {
      entry.question = asText(body.question) || entry.question
      entry.item_ids = body.refs?.item_ids ?? entry.item_ids
      entry.rfq_rev = body.rfq_rev ?? entry.rfq_rev
      entry.package_id = asText(body.package_id) || entry.package_id
      entry.asker = asText(body.asker_realm) || entry.asker
      entry.at = String(row.ts ?? '')
      if (asText(body.status) === 'closed') entry.status = 'closed'
    }
    if (String(row.type) === 'clarification/answered') {
      if (asText(body.by) !== '') {
        entry.status = 'answered'
        entry.answer = asText(body.text)
        entry.answered_by = asText(body.by)
        entry.answered_at = String(row.ts ?? '')
      }
    }
    if (String(row.type) === 'clarification/reopened') {
      entry.status = 'open'
      entry.answer = `${entry.answer}（注意：包已升到 rev${body.to_rev}，上面的答复只对旧版本有效）`
    }
    tickets.set(ticketId, entry)
  }
  return [...tickets.values()].sort((left, right) => (left.ticket_id < right.ticket_id ? -1 : 1))
}

/** 结果告知信封（承包商「告知结果」写的；供应商侧据此看到中标/落标/PO）。 */
const outcomesOf = (host) => {
  const path = `${host.sharedDir}/exchange/award-outcomes.json`
  const raw = host.readJson(path)
  const read = readRows(Array.isArray(raw) ? raw : (Array.isArray(raw?.outcomes) ? raw.outcomes : []))
  const items = read.rows
  const realm = realmOf(host, 'supplier')
  const mine = items.filter((item) => {
    const delivered = nameListOf(item.delivered_to)
    return delivered.length === 0 || realm === '' || delivered.includes(realm)
  })
  const mismatch = mine.length === 0 && items.length > 0
  return { items, mine, mismatch, path, dropped: read.dropped, all: read.all }
}

/** 授标意向信封（`exchange/award-intents.json`；既有通道，承包商提意向时写）。
 *  可见性判据（与唯一写者同一口径）：**引用的报价是我自己提交过的那份**（本侧 `quote/submitted` 事实），
 *  或信封的 `delivered_to` 含我的 realm；两者都不满足 ⇒ 不是给我的（如实报 mismatch，不猜）。 */
const intentsOf = (host) => {
  const path = `${host.sharedDir}/exchange/award-intents.json`
  const raw = host.readJson(path)
  const read = readRows(Array.isArray(raw) ? raw : [])
  const items = read.rows
  const realm = realmOf(host, 'supplier')
  const mine = ownQuoteIds(host)
  const visible = items.filter((item) => {
    const delivered = nameListOf(item.delivered_to)
    return mine.has(asText(item.quote_id)) || (delivered.length > 0 && realm && delivered.includes(realm))
  })
  const mismatch = visible.length === 0 && items.length > 0
  return { items, mine: visible, mismatch, path, dropped: read.dropped, all: read.all }
}

/** 我自己提交过的报价 id（本侧 `quote/submitted` 事实）。 */
const ownQuoteIds = (host) => new Set(typeRows(host.rows('supplier'), 'quote/submitted')
  .map((row) => asText(bodyOf(row).quote_id)).filter((id) => id !== ''))

const money = (cents) => (Number.isFinite(Number(cents)) ? `${Number(cents)} 分` : '—')

export async function register(surface, host) {
  const me = plugin_id
  const out = []
  const ledgerC = () => asText(host.config?.ledger_contractor)
  const ledgerS = () => asText(host.config?.ledger_supplier)
  const delivery = () => asText(host.config?.rfq_delivery)
  const sha = (text) => createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')

  /** 服务端一半的公共段：落 0600 待办件 → spawn 唯一写者 → 回执（next_action / 失败原因）。 */
  const runWriter = async ({ kind, tool, record, args, okNext, label }) => {
    const staged = host.stage(kind, record)
    if (!staged.ok) return staged
    const run = host.runPython(tool, args(staged))
    const json = run.json ?? {}
    const refusal = json.refusal ?? (Array.isArray(json.refused) ? json.refused[0] : null)
    const ok = run.ok && refusal == null && json.ok !== false
    return { ok, code: refusal?.code ?? (ok ? 'accepted' : 'writer-failed'),
      reason: refusal?.reason ?? run.reason ?? '',
      next_action: refusal?.next_action ?? (ok ? okNext : '看 stdout/stderr 定位唯一写者的拒绝原因（拒绝时账本零新增）'),
      result: { pending: staged.file, ledger_added: json.ledger_added ?? 0, applied: json.applied ?? [],
        duplicates: json.duplicates ?? [], refused: json.refused ?? [], writer: label,
        stdout: run.stdout ? run.stdout.slice(-600) : '', stderr: run.stderr ? run.stderr.slice(-300) : '' } }
  }

  const clarifyArgs = (staged) => ['--request', staged.path, '--ui-shared', host.sharedDir,
    '--ledger-contractor', ledgerC(), '--ledger-supplier', ledgerS(), '--delivery', delivery(),
    '--now', host.now()]
  const packageArgs = (staged) => ['--request', staged.path, '--ui-shared', host.sharedDir,
    '--view', 'supplier', '--ledger-supplier', ledgerS(), '--ledger-contractor', ledgerC(),
    '--delivery', delivery(), '--now', host.now()]
  const outcomeArgs = (staged) => ['--request', staged.path, '--ui-shared', host.sharedDir,
    '--ledger-contractor', ledgerC(), '--ledger-supplier', ledgerS(), '--now', host.now()]

  // ================================================================== 视图
  out.push(surface.view({ plugin_id: me, id: 'exchange.workspace', title: '澄清与往来', order: 20,
    view: 'supplier', hint: '提问澄清 / 已收到 / 我要晚点回 / 授标与落标结果 / PO 确认' }))

  // ================================================================== 供应商侧：我的包（认收 / 回文承诺）
  out.push(surface.panel({ plugin_id: me, id: 'exchange.inbox', title: '我收到的包（认收 · 回文承诺）',
    view: 'supplier', order: 5, kind: 'table',
    actions: ['exchange.ack', 'exchange.promise', 'exchange.ask'],
    hint: '认收（DEF-016）与回文承诺（DEF-024）都在这里真落账：承包商侧的「谁没回 / due_ts」随之变化',
    data: () => {
      const packages = visiblePackages(host, 'supplier')
      const rows = host.rows('supplier')
      const acked = new Map(typeRows(rows, 'rfq/acknowledged').map((row) => [asText(bodyOf(row).package_id),
        bodyOf(row)]))
      const promised = new Map(typeRows(rows, 'rfq/promised').map((row) => [asText(bodyOf(row).rfq_id),
        bodyOf(row)]))
      const quotes = new Map()
      for (const row of typeRows(rows, 'quote/submitted')) {
        const body = bodyOf(row)
        quotes.set(asText(body.package_id), (quotes.get(asText(body.package_id)) ?? 0) + 1)
      }
      if (!packages.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-package-visible',
          next_action: '等承包商发布 RFQ（页面首页「我收到的包」用的同一份投递信封）；发布后这里会出现',
          columns: [{ key: 'package_id', label: '包' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        columns: [{ key: 'package_id', label: '包', type: 'code' }, { key: 'rev', label: '最新 rev' },
          { key: 'items', label: '行项目' }, { key: 'qty', label: '数量（rev 明细）', filter: 'number' },
          { key: 'quote_by', label: '报价截止' }, { key: 'ack', label: '我认收了吗' },
          { key: 'promise', label: '我承诺的回文时限' }, { key: 'quotes', label: '我已提交报价' },
          { key: 'sources', label: '可见口径' }],
        rows: packages.map((entry) => {
          const rev = entry.revs.length ? entry.revs[entry.revs.length - 1] : null
          const ack = acked.get(entry.package_id)
          const promise = promised.get(entry.package_id)
          return { id: entry.package_id, package_id: entry.package_id, rev: rev ?? '—',
            // P15：行内动作（认收 `exchange.ack` 要 `seen_rev`、提问 `exchange.ask` 要 `rfq_rev`）
            // 的字段名与**行里的键名**对齐 —— 这一行已经显示「最新 rev」了，不该再让用户手抄一个数字。
            // （外壳的预填机制就是「按字段名在行里取值」：名字对不上 = 表单空白。）
            seen_rev: rev ?? '', rfq_rev: rev ?? '',
            items: entry.items.length,
            qty: linesTextOf(readRows(entry.items), (item) =>
              `${item.item_id}×${item.qty}${item.unit ?? ''}`, { max: 120 }),
            quote_by: entry.quote_by || '—',
            ack: ack ? `${asText(ack.acknowledged_by)} @ rev${ack.seen_rev}` : '未认收',
            promise: promise ? `${asText(promise.due_at)}（${asText(promise.actor)}）` : '未承诺',
            quotes: quotes.get(entry.package_id) ?? 0,
            sources: entry.sources.join('+') }
        }),
        row_actions: ['exchange.ack', 'exchange.promise', 'exchange.ask'],
        counts: { packages: packages.length, acknowledged: acked.size, promised: promised.size },
        note: '认收 = 「我已收到 @revN」（可断言：对方账本同时多一条同名登记）；回文承诺 = 「我周五前一定回」'
          + '（对方 due_ts 的取值就是这条事实）' }
    } }))

  // ================================================================== 供应商侧：澄清问答串
  out.push(surface.panel({ plugin_id: me, id: 'exchange.threads', title: '我的澄清工单（问答串）',
    view: 'supplier', order: 15, kind: 'table', actions: ['exchange.ask'],
    hint: '提问要带版本与条目引用（缺一即拒）；答复由承包商侧作答后镜像回来，这里能看到正文',
    data: () => {
      const tickets = ticketsOf(host, 'supplier')
      if (!tickets.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-ticket',
          next_action: '点「提问澄清」：选包 → 填版本 → 勾条目 → 写问题（≤500 字）',
          columns: [{ key: 'ticket_id', label: '工单' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        columns: [{ key: 'ticket_id', label: '工单', type: 'code' }, { key: 'package_id', label: '包', type: 'code' },
          { key: 'rfq_rev', label: '版本' }, { key: 'item_ids', label: '条目引用', type: 'code' },
          { key: 'question', label: '我的问题' }, { key: 'status', label: '状态' },
          { key: 'answer', label: '承包商答复' }, { key: 'answered_by', label: '答复人', type: 'code' }],
        rows: tickets.map((ticket) => ({ id: ticket.ticket_id, ...ticket,
          item_ids: (ticket.item_ids ?? []).join(' '), question: ticket.question.slice(0, 160),
          answer: ticket.answer ? ticket.answer.slice(0, 240) : '（等待承包商作答）',
          status: ticket.status === 'answered' ? '已答复' : (ticket.status === 'closed' ? '已关闭' : '待答复') })),
        counts: { tickets: tickets.length,
          open: tickets.filter((ticket) => ticket.status === 'open').length },
        note: '工单绑定「包 + 版本 + 条目」：包升版后旧答复会被标记为只对旧版本有效（不冒充对新版的有效回答）' }
    } }))

  // ================================================================== 供应商侧：中标 / 落标 / PO
  out.push(surface.panel({ plugin_id: me, id: 'exchange.awards', title: '我的授标与 PO（结果）',
    view: 'supplier', order: 25, kind: 'table',
    actions: ['exchange.confirm-award', 'exchange.confirm-po'],
    data: () => {
      const rows = host.rows('supplier')
      const confirmed = new Map(typeRows(rows, 'award/confirmed').map((row) => [asText(bodyOf(row).intent_id),
        bodyOf(row)]))
      const poConfirmed = new Map(typeRows(rows, 'po/confirmed').map((row) => [asText(bodyOf(row).po_id),
        bodyOf(row)]))
      const intents = intentsOf(host)
      const outcomes = outcomesOf(host)
      const poNotices = outcomes.mine.filter((item) => asText(item.kind) === 'po-issued')
      if (!intents.mine.length && !poNotices.length) {
        return { ok: true, kind: 'table', degraded: true, reason: intents.mismatch ? 'delivery-mismatch' : 'no-award',
          next_action: intents.mismatch
            ? `投递名单与我的 realm 不一致（信封 ${intents.path} 里有 ${intents.items.length} 条，但不含我）——`
              + '如实报，不假装没有；让承包商核对邀请名单'
            : '等承包商在 APP 里提出授标意向 / 告知结果（意向不产生义务）',
          columns: [{ key: 'intent_id', label: '意向' }], rows: [] }
      }
      const table = intents.mine.map((intent) => {
        const intentId = asText(intent.intent_id)
        const record = confirmed.get(intentId)
        const po = poNotices.find((item) => asText(item.award_id) === intentId || asText(item.award_id) === intentId)
        const poId = po ? asText(po.po_id) : ''
        return { id: intentId, intent_id: intentId, package_id: asText(intent.package_id),
          quote_id: asText(intent.quote_id),
          lines: linesTextOf(readRows(intent.lines), (line) => `${line.item_id}×${line.qty}@${money(line.unit_price_cents)}`, { sep: ' ' }),
          confirmed: record ? `已确认（${asText(record.confirmed_by)}，能否按期=${
            record.can_meet_due === true ? '能' : (record.can_meet_due === false ? '不能' : '未声明')}）` : '待确认',
          // `po_id` 留空（缺 PO 时）而不是填 "—"：行内动作按**同名字段**预填，填 "—" 会把一个占位符
          // 当成真 id 送出去（P3 走查实测：po-id-malformed）。显示用 `po` 列，动作只长在真有 PO 的行上。
          po_id: poId, po: poId || '—',
          po_ack: po ? (poConfirmed.has(poId) ? '已确认收到' : '待确认收到') : '—',
          row_actions: [`exchange.confirm-award`, ...(poId ? ['exchange.confirm-po'] : [])] }
      })
      for (const notice of poNotices) {
        const poId = asText(notice.po_id)
        if (table.some((row) => row.po_id === poId)) continue
        table.push({ id: poId, intent_id: asText(notice.award_id) || '—',
          package_id: asText(notice.package_id), quote_id: '—', lines: '—',
          confirmed: '已授标', po_id: poId, po: poId,
          po_ack: poConfirmed.has(poId) ? '已确认收到' : '待确认收到',
          row_actions: ['exchange.confirm-po'] })
      }
      return { ok: true, kind: 'table',
        columns: [{ key: 'intent_id', label: '意向/授标', type: 'code' }, { key: 'package_id', label: '包', type: 'code' },
          { key: 'quote_id', label: '我的报价', type: 'code' }, { key: 'lines', label: '中标行' },
          { key: 'confirmed', label: '我确认了吗' }, { key: 'po', label: 'PO', type: 'code' },
          { key: 'po_ack', label: 'PO 确认' }],
        rows: table, row_actions: ['exchange.confirm-award', 'exchange.confirm-po'],
        counts: { intents: table.length, confirmed: confirmed.size, po: poNotices.length,
          dropped: intents.dropped + outcomes.dropped },
        // **坏形状如实降级**（信封数组里混进不是对象的值）：好行照列、坏行逐条计数，不静默丢
        ...(intents.dropped + outcomes.dropped
          ? { degraded: true,
            reason: `award-envelope-partly-unreadable：意向/结果信封里有 ${intents.dropped + outcomes.dropped}`
              + ' 条读不出来（形状异常：不是对象）—— 好行照常列出，坏行已跳过并计数' }
          : {}),
        note: '确认中标要声明「能否按期」；不能按期时备注必填（避免确认了又交不了货）。'
          + 'PO 确认只表示"我收到这张单"，不改变任何金额；没有 PO 的行不会长出「确认收到 PO」按钮' }
    } }))

  out.push(surface.panel({ plugin_id: me, id: 'exchange.lost', title: '落标告知（本次未中选必须明确告知）',
    view: 'supplier', order: 30, kind: 'table', actions: ['exchange.ack-lost'],
    hint: '落标不是"默默消失"：这里给出一句话 + 原因类别，并给「我知道了」的回执入口（不含别家的报价信息）',
    data: () => {
      const outcomes = outcomesOf(host)
      const lost = outcomes.mine.filter((item) => asText(item.kind) === 'lost')
      const acked = new Set(typeRows(host.rows('supplier'), 'award/lost-acknowledged')
        .map((row) => asText(bodyOf(row).outcome_id)))
      if (!lost.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-lost-notice',
          next_action: '目前没有落标告知（有告知时这里会明确写出来；没有被选中不会静默消失）',
          columns: [{ key: 'outcome_id', label: '告知' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        columns: [{ key: 'outcome_id', label: '告知', type: 'code' }, { key: 'package_id', label: '包', type: 'code' },
          { key: 'reason_category', label: '原因类别' }, { key: 'notice', label: '对方原话' },
          { key: 'declared_by', label: '告知人', type: 'code' }, { key: 'at', label: '告知时刻' },
          { key: 'ack', label: '我的回执' }],
        rows: lost.map((item) => ({ id: asText(item.outcome_id), outcome_id: asText(item.outcome_id),
          package_id: asText(item.package_id), reason_category: asText(item.reason_category) || '—',
          notice: asText(item.notice), declared_by: asText(item.declared_by), at: asText(item.at),
          ack: acked.has(asText(item.outcome_id)) ? '已知悉' : '待知悉' })),
        row_actions: ['exchange.ack-lost'], counts: { lost: lost.length, acknowledged: acked.size },
        note: '落标告知只含一句话与原因类别：不含其他供应商的代号、报价与比价基准（规则 4）' }
    } }))

  // ================================================================== 承包商侧：待答队列 + 往来回读
  out.push(surface.panel({ plugin_id: me, id: 'exchange.queue', title: '供应商提问工单（待我回答）',
    view: 'contractor', order: 15, kind: 'table', actions: ['exchange.answer'],
    hint: '作答者必须是 human:<名字>；作答后供应商侧看得见答复正文（问答串双向）',
    data: () => {
      const tickets = ticketsOf(host, 'contractor')
      const published = visiblePackages(host, 'contractor')
      if (!tickets.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-open-ticket',
          next_action: `等供应商在 APP 里提问（供应商侧「我的澄清工单」）；本视角已有 ${published.length} 个包`,
          columns: [{ key: 'ticket_id', label: '工单' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        columns: [{ key: 'ticket_id', label: '工单', type: 'code' }, { key: 'package_id', label: '包', type: 'code' },
          { key: 'rfq_rev', label: '版本' }, { key: 'item_ids', label: '条目引用', type: 'code' },
          { key: 'asker', label: '提问方', type: 'code' }, { key: 'question', label: '问题' },
          { key: 'status', label: '状态' }, { key: 'answer', label: '我的答复' }],
        rows: tickets.map((ticket) => ({ id: ticket.ticket_id, ...ticket,
          item_ids: (ticket.item_ids ?? []).join(' '), question: ticket.question.slice(0, 160),
          answer: ticket.answer ? ticket.answer.slice(0, 200) : '（待回答）',
          status: ticket.status === 'answered' ? '已答复' : (ticket.status === 'closed' ? '已关闭' : '待回答') })),
        row_actions: ['exchange.answer'],
        counts: { tickets: tickets.length, open: tickets.filter((ticket) => ticket.status === 'open').length },
        note: '广播与关闭（FR-CLARIFY-002 / INV-006）不在本批能力面里：本批只做「提问 → 作答 → 答复可见」' }
    } }))

  out.push(surface.panel({ plugin_id: me, id: 'exchange.board', title: '供应商的往来登记（谁收到 / 谁回话）',
    view: 'contractor', order: 25, kind: 'table',
    data: () => {
      const rows = host.rows('contractor')
      const ack = prefixRows(rows, 'rfq/acknowledged')
      const promise = prefixRows(rows, 'rfq/promised')
      const confirmed = prefixRows(rows, 'award/confirmed')
      const lost = prefixRows(rows, 'award/lost')
      const lostAck = prefixRows(rows, 'award/lost-acknowledged')
      const poConfirmed = prefixRows(rows, 'po/confirmed')
      const table = ack.map((row) => {
        const body = bodyOf(row)
        const promiseRow = promise.find((item) => asText(bodyOf(item).rfq_id) === asText(body.package_id))
        return { id: `${asText(body.package_id)}#ack`, package_id: asText(body.package_id),
          rev: body.seen_rev, supplier: asText(body.supplier), ack_by: asText(body.acknowledged_by),
          at: asText(body.acknowledged_at),
          promise: promiseRow ? asText(bodyOf(promiseRow).due_at) : '未承诺',
          promise_by: promiseRow ? asText(bodyOf(promiseRow).actor) : '—' }
      })
      if (!table.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-supplier-response',
          next_action: '等供应商在 APP 里点「我已收到 @revN」或「我要晚点回」（两侧账本各留一条，这里回读对方那条）',
          columns: [{ key: 'package_id', label: '包' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        columns: [{ key: 'package_id', label: '包', type: 'code' }, { key: 'rev', label: '认收版本' },
          { key: 'supplier', label: '供应商', type: 'code' }, { key: 'ack_by', label: '认收人', type: 'code' },
          { key: 'at', label: '认收时刻' }, { key: 'promise', label: '回文承诺' },
          { key: 'promise_by', label: '承诺人', type: 'code' }],
        rows: table, counts: { acknowledged: ack.length, promised: promise.length,
          award_confirmed: confirmed.length, lost_notified: lost.length, lost_ack: lostAck.length,
          po_confirmed: poConfirmed.length },
        note: `结果类回执：中标确认 ${confirmed.length} · 落标告知 ${lost.length} · 落标知悉 ${lostAck.length} ·`
          + ` PO 确认 ${poConfirmed.length}（这些都在对方账本各有一条 —— 双向可断言）` }
    } }))

  // ================================================================== 动作（每个 = 一个真能点的按钮）
  out.push(surface.action({ plugin_id: me, id: 'exchange.ack', title: '我已收到 @revN（认收）', views: ['supplier'],
    group: '包往来', order: 10, confirm: { required: true,
      message: '认收是给对方的明确回执（「我收到了，会报」）：确认以你的名义登记？' },
    hint: '落自己账本 rfq/acknowledged + 承包商账本同名登记（对方「谁没回」名单随之变化）；可再认收新版本',
    input: { fields: [
      { name: 'package_id', label: '包 id', type: 'text', required: true, help: '从「我收到的包」表里复制' },
      { name: 'seen_rev', label: '我看到的版本（rev）', type: 'number', required: true, min: 1,
        help: '必须是本视角已知版本之一（不夹取）' },
      { name: 'actor', label: '发言人', type: 'text', required: true, identity: true, help: 'human:<你的名字>' },
      { name: 'note', label: '备注（可选，只留 sha256 进账本）', type: 'textarea' },
    ] },
    server: async (ctx, input) => {
      const actor = asText(input.actor)
      if (!actor.startsWith('human:')) {
        return { ok: false, code: 'human-required', reason: '认收要以具名的人的名义（收到 agent 署名）',
          next_action: '写 human:<你的名字>（agent 不得代人认收）' }
      }
      const note = String(input.note ?? '')
      return runWriter({ kind: 'package-ops', tool: 'src/domain/clarify/tools/package-ops.py',
        record: { kind: 'package-ops', action: 'ack', view: 'supplier', package_id: asText(input.package_id),
          seen_rev: Number(input.seen_rev), actor, note, note_sha256: sha(note) },
        args: packageArgs, label: 'package-ops.py',
        okNext: '已认收：对方账本多了一条同名登记（未回名单里你变成「已认收」）；备报价与提交照旧' })
    } }))

  out.push(surface.action({ plugin_id: me, id: 'exchange.promise', title: '我要晚点回（承诺回文时限）',
    views: ['supplier'], group: '包往来', order: 11,
    hint: '同一份包：首页看得见就承诺得了（唯一写者按「本人账本事实 ∪ 投递信封」两种口径找包）',
    input: { fields: [
      { name: 'package_id', label: '包 id', type: 'text', required: true, help: '从「我收到的包」表里复制' },
      { name: 'due_at', label: '承诺回文时限（ISO8601 UTC）', type: 'text', required: true,
        help: '如 2026-09-26T00:00:00Z（形状由唯一写者校验：非 ISO ⇒ due-at-malformed，账本零新增）' },
      { name: 'actor', label: '发言人', type: 'text', required: true, identity: true, help: 'human:<你的名字>' },
      { name: 'note', label: '原话（必填；只留 sha256 进账本）', type: 'textarea', required: true },
    ] },
    server: async (ctx, input) => {
      const note = String(input.note ?? '')
      const actor = asText(input.actor)
      if (!actor.startsWith('human:')) {
        return { ok: false, code: 'human-required',
          reason: '对对方的回文承诺要有人署名（agent 不得代供应商承诺时限）',
          next_action: '写 human:<你的名字>' }
      }
      if (note.trim() === '') {
        return { ok: false, code: 'empty-note', reason: '原话为空：没有内容就没有承诺事实',
          next_action: '写清「我什么时候一定回」（例如：周五下班前一定回）' }
      }
      return runWriter({ kind: 'package-ops', tool: 'src/domain/clarify/tools/package-ops.py',
        record: { kind: 'package-ops', action: 'promise', view: 'supplier', package_id: asText(input.package_id),
          due_at: asText(input.due_at), actor, note, note_sha256: sha(note) },
        args: packageArgs, label: 'package-ops.py',
        okNext: '已登记承诺：对方截止看板的 due_ts 现在来自这条事实（rfq/promised）；它不发信，只落事实' })
    } }))

  out.push(surface.action({ plugin_id: me, id: 'exchange.ask', title: '提问澄清（带版本与条目引用）',
    views: ['supplier'], group: '澄清', order: 20,
    hint: '缺版本或缺条目引用一律拒（FR-CLARIFY-001）；工单绑定包版本，升版后旧答复只对旧版有效',
    input: { fields: [
      { name: 'package_id', label: '包 id', type: 'text', required: true, help: '从「我收到的包」表里复制' },
      { name: 'rfq_rev', label: '提问时的版本（rev）', type: 'number', required: true, min: 1 },
      { name: 'item_ids', label: '条目引用（逗号分隔，至少 1 项）', type: 'text',
        help: '例：L-001,L-002（必须真的在这个包里）；留空 ⇒ 服务端以 clarify-ref-missing 明确拒绝' },
      { name: 'question', label: '问题（≤500 字）', type: 'textarea', required: true },
      { name: 'actor', label: '提问人', type: 'text', required: true, identity: true, help: 'human:<你的名字>' },
    ] },
    server: async (ctx, input) => {
      const itemIds = String(input.item_ids ?? '').split(/[,\s]+/).map((piece) => piece.trim())
        .filter((piece) => piece !== '')
      if (!itemIds.length) {
        return { ok: false, code: 'clarify-ref-missing', reason: '缺条目引用：无引用的工单不得建立（FR-CLARIFY-001）',
          next_action: '勾/填至少一条行项目 id（例：L-001）' }
      }
      const question = asText(input.question)
      if (question.length > 500) {
        return { ok: false, code: 'question-too-long', reason: `问题 ${question.length} 字超过 500：不截断（截断会合成另一句话）`,
          next_action: '把问题改短后重提' }
      }
      return runWriter({ kind: 'clarify-apply', tool: 'src/domain/clarify/tools/clarify-apply.py',
        record: { kind: 'clarify-apply', action: 'ask', view: 'supplier', package_id: asText(input.package_id),
          rfq_rev: Number(input.rfq_rev), item_ids: itemIds, question, actor: asText(input.actor),
          note: '', note_sha256: sha('') },
        args: clarifyArgs, label: 'clarify-apply.py',
        okNext: '工单已建：承包商侧「供应商提问工单」里出现「待回答」；答复后本面板的问答串会显示答复正文' })
    } }))

  out.push(surface.action({ plugin_id: me, id: 'exchange.answer', title: '回答供应商的提问', views: ['contractor'],
    group: '澄清', order: 30,
    hint: '作答者必须 human:<名字>（解答责任在人）；作答后供应商侧看得见答复正文',
    input: { fields: [
      { name: 'ticket_id', label: '工单 id', type: 'text', required: true,
        pattern: '^cl-[A-Za-z0-9._:-]+$', help: '从「供应商提问工单」表里复制' },
      { name: 'answer_text', label: '答复正文', type: 'textarea', required: true },
      { name: 'actor', label: '答复人', type: 'text', required: true, identity: true, help: 'human:<你的名字>' },
    ] },
    server: async (ctx, input) => {
      const actor = asText(input.actor)
      if (!actor.startsWith('human:')) {
        return { ok: false, code: 'human-required', reason: '答复责任在人：署名必须是 human:<名字>',
          next_action: '写 human:<你的名字>（agent 不得代答）' }
      }
      return runWriter({ kind: 'clarify-apply', tool: 'src/domain/clarify/tools/clarify-apply.py',
        record: { kind: 'clarify-apply', action: 'answer', view: 'contractor', ticket_id: asText(input.ticket_id),
          answer_text: String(input.answer_text ?? ''), actor, note: '', note_sha256: sha('') },
        args: clarifyArgs, label: 'clarify-apply.py',
        okNext: '已作答：供应商侧的问答串里现在能看到答复正文（两侧账本各一条）' })
    } }))

  out.push(surface.action({ plugin_id: me, id: 'exchange.confirm-award', title: '确认中标（并声明能否按期）',
    views: ['supplier'], group: '结果', order: 40, permission: 'human-signature',
    confirm: { required: true, message: '确认中标＝对外承认这条授标：确认以你的署名确认？' },
    hint: 'can_meet_due=false 时备注必填（避免"确认了又交不了货"）；落本侧 award/confirmed + 承包商侧同名登记',
    input: { fields: [
      { name: 'intent_id', label: '意向 id', type: 'text', required: true, help: '从「我的授标与 PO」表里复制' },
      { name: 'signature', label: '署名（人签）', type: 'signature', required: true, help: 'human:<你的名字>' },
      { name: 'can_meet_due', label: '能否按期', type: 'select', options: ['true', 'false'], default: 'true' },
      { name: 'note', label: '备注（不能按期时必填）', type: 'textarea' },
    ] },
    server: async (ctx, input) => {
      const canMeet = truthy(input.can_meet_due)
      const note = String(input.note ?? '')
      if (!canMeet && note.trim() === '') {
        return { ok: false, code: 'note-required-when-cannot-meet-due',
          reason: '声明"不能按期"时备注必填：不能只说确认、不说怎么交',
          next_action: '写清最早能什么时候交 / 差在哪里' }
      }
      return runWriter({ kind: 'outcome-ops', tool: 'src/domain/clarify/tools/outcome-ops.py',
        record: { kind: 'outcome-ops', action: 'confirm-award', view: 'supplier',
          intent_id: asText(input.intent_id), award_id: asText(input.intent_id), actor: asText(input.signature),
          can_meet_due: canMeet, note, note_sha256: sha(note) },
        args: outcomeArgs, label: 'outcome-ops.py',
        okNext: '已确认中标：承包商侧的授标轨道现在有「供应商已确认」这条事实（承诺与 PO 才走得下去）' })
    } }))

  out.push(surface.action({ plugin_id: me, id: 'exchange.confirm-po', title: '确认收到 PO', views: ['supplier'],
    group: '结果', order: 41, permission: 'human-signature',
    confirm: { required: true, message: '确认收到这张采购单（不改变任何金额）：确认？' },
    hint: '落本侧 po/confirmed + 承包商侧同名登记；PO 只能由承诺派生，界面不提供"我自己发 PO"',
    input: { fields: [
      { name: 'po_id', label: 'PO id', type: 'text', required: true, help: '从「我的授标与 PO」表里复制' },
      { name: 'signature', label: '署名（人签）', type: 'signature', required: true, help: 'human:<你的名字>' },
      { name: 'note', label: '备注', type: 'text' },
    ] },
    server: async (ctx, input) => {
      const note = String(input.note ?? '')
      return runWriter({ kind: 'outcome-ops', tool: 'src/domain/clarify/tools/outcome-ops.py',
        record: { kind: 'outcome-ops', action: 'confirm-po', view: 'supplier', po_id: asText(input.po_id),
          actor: asText(input.signature), note, note_sha256: sha(note) },
        args: outcomeArgs, label: 'outcome-ops.py',
        okNext: '已确认收到 PO：承包商侧看到你的回执（po/confirmed）' })
    } }))

  out.push(surface.action({ plugin_id: me, id: 'exchange.ack-lost', title: '我知道了（落标回执）', views: ['supplier'],
    group: '结果', order: 42, permission: 'human-signature',
    confirm: { required: true, message: '对"本次未中选"给出回执（对方据此知道你已收到）：确认？' },
    hint: '落 award/lost-acknowledged 并镜像给对方 —— 落标告知因此不是单向通知',
    input: { fields: [
      { name: 'outcome_id', label: '告知 id', type: 'text', required: true, help: '从「落标告知」表里复制' },
      { name: 'signature', label: '署名（人签）', type: 'signature', required: true, help: 'human:<你的名字>' },
      { name: 'note', label: '备注', type: 'text' },
    ] },
    server: async (ctx, input) => {
      const note = String(input.note ?? '')
      return runWriter({ kind: 'outcome-ops', tool: 'src/domain/clarify/tools/outcome-ops.py',
        record: { kind: 'outcome-ops', action: 'ack-lost', view: 'supplier', outcome_id: asText(input.outcome_id),
          actor: asText(input.signature), note, note_sha256: sha(note) },
        args: outcomeArgs, label: 'outcome-ops.py',
        okNext: '已回执：对方账本多了 award/lost-acknowledged（告知已送达）' })
    } }))

  out.push(surface.action({ plugin_id: me, id: 'exchange.declare-outcome', title: '告知结果（落标必须明确告知）',
    views: ['contractor'], group: '结果', order: 50, permission: 'human-signature',
    confirm: { required: true, message: '告知结果是对外的正式通知（落标也要说清楚）：确认？' },
    hint: '落 contractor 账本 award/lost 或 po/notified，并把结果写进投递信封（对方侧的「落标告知」/「我的 PO」）',
    input: { fields: [
      { name: 'outcome_kind', label: '结果', type: 'select', options: ['lost', 'po-issued'], default: 'lost' },
      { name: 'package_id', label: '包 id', type: 'text', required: true },
      { name: 'supplier', label: '告知对象（realm）', type: 'text', required: true, help: '如 supplier:g1' },
      { name: 'reason_category', label: '原因类别（落标必填）', type: 'select',
        options: ['price', 'lead-time', 'scope', 'compliance', 'terms', 'other'], default: 'price' },
      { name: 'po_id', label: 'PO id（po-issued 必填）', type: 'text' },
      { name: 'award_id', label: '授标 id（可空）', type: 'text' },
      { name: 'notice', label: '一句话告知（落标必填）', type: 'textarea' },
      { name: 'signature', label: '署名（人签）', type: 'signature', required: true, help: 'human:<你的名字>' },
    ] },
    server: async (ctx, input) => {
      const kind = asText(input.outcome_kind) || 'lost'
      const note = String(input.notice ?? '')
      if (kind === 'lost' && note.trim() === '') {
        return { ok: false, code: 'notice-required', reason: '落标告知必须有一句话（不能只给类别）',
          next_action: '写一句：例如「本次未中选：价格超出预算」（不含别家的报价信息）' }
      }
      return runWriter({ kind: 'outcome-ops', tool: 'src/domain/clarify/tools/outcome-ops.py',
        record: { kind: 'outcome-ops', action: 'declare-outcome', view: 'contractor', outcome_kind: kind,
          package_id: asText(input.package_id), supplier: asText(input.supplier),
          reason_category: asText(input.reason_category), po_id: asText(input.po_id),
          award_id: asText(input.award_id), actor: asText(input.signature), note,
          note_sha256: sha(note) },
        args: outcomeArgs, label: 'outcome-ops.py',
        okNext: '已告知：对方的「落标告知」/「我的 PO」里出现这条结果（明确告知，不默默消失）；两侧账本各一条' })
    } }))

  // ================================================================== 工作台 / 通知 / 状态 / 快捷键
  out.push(surface.panel({ plugin_id: me, id: 'exchange.home-todo', title: '往来与结果：我今天要做什么',
    view: 'home', order: 15, kind: 'list', not_data: true,
    data: (ctx) => {
      const supplierRows = host.rows('supplier')
      const contractorRows = host.rows('contractor')
      const items = []
      const packages = visiblePackages(host, 'supplier')
      const acked = new Set(typeRows(supplierRows, 'rfq/acknowledged').map((row) => asText(bodyOf(row).package_id)))
      const tokens = packages.filter((entry) => !acked.has(entry.package_id))
      if (tokens.length) {
        items.push(sideScoped(ctx, 'supplier', { level: 'warn',
          title: `供应商侧：${tokens.length} 个包还没认收`,
          body: tokens.map((entry) => entry.package_id).join(' '),
          next_action: '在「我收到的包」里点「我已收到 @revN」（对方据此知道你不是没看见）' }))
      }
      const openTickets = ticketsOf(host, 'supplier').filter((ticket) => ticket.status === 'open')
      if (openTickets.length) {
        items.push(sideScoped(ctx, 'supplier', { level: 'warn',
          title: `供应商侧：${openTickets.length} 个澄清工单还没有答复`,
          body: openTickets.map((ticket) => `${ticket.ticket_id}（${ticket.question.slice(0, 40)}）`).join('；'),
          next_action: '看「我的澄清工单」；答复由承包商侧作答后镜像回来' }))
      }
      const lost = outcomesOf(host).mine.filter((item) => asText(item.kind) === 'lost')
      if (lost.length) {
        items.push(sideScoped(ctx, 'supplier', { level: 'info',
          title: `供应商侧：有 ${lost.length} 条落标告知（本次未中选）`,
          body: lost.map((item) => `${item.package_id}：${item.reason_category} — ${item.notice}`).join('；'),
          next_action: '在「落标告知」里点「我知道了」（回执让对方知道已送达）' }))
      }
      const outcomeOpen = outcomesOf(host).mine.filter((item) => asText(item.kind) === 'po-issued')
      if (outcomeOpen.length) {
        items.push(sideScoped(ctx, 'supplier', { level: 'info',
          title: `供应商侧：${outcomeOpen.length} 张 PO 待确认收到`,
          body: outcomeOpen.map((item) => item.po_id).join(' '),
          next_action: '在「我的授标与 PO」里人签确认收到 PO' }))
      }
      const contractorTickets = ticketsOf(host, 'contractor').filter((ticket) => ticket.status === 'open')
      if (contractorTickets.length) {
        items.push(sideScoped(ctx, 'contractor', { level: 'warn',
          title: `承包商侧：${contractorTickets.length} 个供应商提问待回答`,
          body: contractorTickets.map((ticket) => `${ticket.ticket_id}（${ticket.package_id}）`).join('；'),
          next_action: '在承包商道「供应商提问工单」里作答（必须以 human:<名字>）' }))
      }
      const contractorAcks = typeRows(contractorRows, 'rfq/acknowledged').length
      const contractorPromises = typeRows(contractorRows, 'rfq/promised').length
      if (contractorAcks || contractorPromises) {
        items.push(sideScoped(ctx, 'contractor', { level: 'ok',
          title: `承包商侧：收到 ${contractorAcks} 条认收 / ${contractorPromises} 条回文承诺`,
          body: '「谁没回」名单与 due_ts 都来自这些事实（不是墙钟）',
          next_action: '看「供应商的往来登记」' }))
      }
      if (!items.length) {
        items.push({ level: 'info', title: '现在没有需要你处理的往来或结果',
          body: '认收 / 提问 / 回文承诺 / 中标确认 / 落标回执都在「澄清与往来」视图里',
          next_action: '等对方发布新版或作答' })
      }
      return { ok: true, kind: 'list', items }
    } }))

  out.push(surface.notificationSource({ plugin_id: me, id: 'exchange.notify', title: '往来与结果待办',
    order: 15, poll: () => {
      const items = []
      for (const ticket of ticketsOf(host, 'contractor')) {
        if (ticket.status !== 'open') continue
        items.push({ id: `c:${ticket.ticket_id}`, level: 'warn', at: ticket.at,
          title: `供应商提问待回答：${ticket.ticket_id}`,
          body: `${ticket.package_id} rev${ticket.rfq_rev} · ${ticket.question.slice(0, 60)}`,
          next_action: '用「回答供应商的提问」（human:<你的名字>）' })
      }
      for (const ticket of ticketsOf(host, 'supplier')) {
        if (ticket.status !== 'answered') continue
        items.push({ id: `c:ans:${ticket.ticket_id}`, level: 'ok', at: ticket.answered_at,
          title: `澄清已答复：${ticket.ticket_id}`,
          body: `${ticket.answered_by}：${ticket.answer.slice(0, 60)}`,
          next_action: '看「我的澄清工单」的问答串' })
      }
      for (const item of outcomesOf(host).mine) {
        if (asText(item.kind) === 'lost') {
          items.push({ id: `lost:${item.outcome_id}`, level: 'warn', at: asText(item.at),
            title: `落标告知：${item.package_id} 本次未中选`,
            body: `${item.reason_category} — ${item.notice}`,
            next_action: '在「落标告知」里点「我知道了」（human:<你的名字>）' })
        }
        if (asText(item.kind) === 'po-issued') {
          items.push({ id: `po:${item.po_id}`, level: 'info', at: asText(item.at),
            title: `PO 已签发：${item.po_id}`, body: `包 ${item.package_id}`,
            next_action: '在「我的授标与 PO」里确认收到 PO' })
        }
      }
      const acked = new Set(typeRows(host.rows('supplier'), 'rfq/acknowledged')
        .map((row) => asText(bodyOf(row).package_id)))
      for (const entry of visiblePackages(host, 'supplier')) {
        if (acked.has(entry.package_id)) continue
        items.push({ id: `pkg:${entry.package_id}`, level: 'info', at: entry.seen_at,
          title: `包 ${entry.package_id} 还没认收`, body: `rev${entry.revs.join('/')} · ${entry.items.length} 条行项目`,
          next_action: '点「我已收到 @revN」' })
      }
      return items
    } }))

  out.push(surface.statusItem({ plugin_id: me, id: 'exchange.status', title: '往来', order: 15, read: () => {
    const tickets = ticketsOf(host, 'supplier')
    const open = tickets.filter((ticket) => ticket.status === 'open').length
    const answered = tickets.filter((ticket) => ticket.status === 'answered').length
    const ack = typeRows(host.rows('supplier'), 'rfq/acknowledged').length
    const promise = typeRows(host.rows('supplier'), 'rfq/promised').length
    return { text: `工单 ${open} 待答复 / ${answered} 已答复 · 认收 ${ack} · 回文承诺 ${promise}`,
      level: open ? 'warn' : 'ok', next_action: open ? '等待承包商答复（答复会镜像回来）' : '' }
  } }))

  out.push(surface.shortcut({ plugin_id: me, id: 'exchange.shortcut-ack', keys: 'i', action: 'exchange.ack',
    title: '我已收到（认收）', order: 15 }))
  out.push(surface.shortcut({ plugin_id: me, id: 'exchange.shortcut-promise', keys: 'w', action: 'exchange.promise',
    title: '我要晚点回', order: 16 }))
  out.push(surface.shortcut({ plugin_id: me, id: 'exchange.shortcut-ask', keys: 'c', action: 'exchange.ask',
    title: '提问澄清', order: 17 }))

  return out
}
