/**
 * `domain/rfq` 的 **GUI 贡献**（把自己搬上界面）—— 承包商侧「发包」这一块。
 *
 * 它注册的东西（全部经注册面：`src/system/webui/code/ui-surface.mjs`）：
 *   · 视图容器 `rfq.workspace`（挂到 `contractor` 道）；
 *   · 面板 `rfq.published`（已发布的包：版本/条目数/截止/收件人 —— 只读本侧账本行 + 本侧包快照）；
 *   · 面板 `rfq.responses`（本侧收到的报价登记行，逐行给 quote_id/item_id/整数分单价/交期/供应商）；
 *   · 面板 `rfq.received`（发给自己的包：**供应商侧**）/ 面板 `rfq.my_drafts` 不在本文件（供应商侧归 quote-prepare）；
 *   · 动作 `rfq.publish`（**服务端一半**：落 0600 待办件 → 跑 `src/domain/rfq/tools/rfq-publish.py`
 *     这个唯一写者去落 `rfq/published` + `rfq/distributed`，并把投递信封写给被邀供应商）；
 *   · 快捷键 `p`、通知源、状态栏项。
 *
 * 纪律：本文件**不写账本**（`host.runPython` 只是 spawn；写账本的是 Python 侧唯一写者），
 * 也不读别人的账本（只读 `host.rows(...)` 给的本视角公开投影行）。
 */
export const plugin_id = 'domain/rfq'

const asText = (value) => (typeof value === 'string' ? value.trim() : '')
const bodyOf = (row) => (row && typeof row.body === 'object' && row.body !== null ? row.body : {})
const rowsOfType = (rows, prefix) => rows.filter((row) => String(row?.type ?? '').startsWith(prefix))

/** 表单里的「行项目」文本 → items[]：每行 `item_id,描述,单位,数量`（逗号分隔；空行忽略）。 */
const parseItems = (text) => {
  const items = []
  const problems = []
  for (const [index, line] of String(text ?? '').split('\n').entries()) {
    const raw = line.trim()
    if (raw === '') continue
    const parts = raw.split(',').map((piece) => piece.trim())
    if (parts.length < 4) {
      problems.push({ line: index + 1, code: 'item-needs-4-fields',
        message: `第 ${index + 1} 行只给了 ${parts.length} 段：要写 \`item_id,描述,单位,数量\`` })
      continue
    }
    const qty = Number(parts[3])
    if (!Number.isFinite(qty) || qty <= 0) {
      problems.push({ line: index + 1, code: 'item-qty-invalid', message: `第 ${index + 1} 行的数量不是正数：${parts[3]}` })
      continue
    }
    items.push({ item_id: parts[0], description: parts[1], unit: parts[2], qty })
  }
  return { items, problems }
}

const parseList = (text) => String(text ?? '').split(/[,\s\n]+/).map((piece) => piece.trim())
  .filter((piece) => piece !== '')

export async function register(surface, host) {
  const me = plugin_id
  const out = []
  const ledger = () => asText(host.config?.ledger_contractor)
  const shared = () => asText(host.sharedDir)

  out.push(surface.view({ plugin_id: me, id: 'rfq.workspace', title: '发包工作区', order: 10,
    view: 'contractor', hint: '发布 RFQ / 看谁收到了 / 看回应' }))

  out.push(surface.panel({ plugin_id: me, id: 'rfq.published', title: '已发布的 RFQ（本侧账本事实）',
    view: 'contractor', order: 10, kind: 'table', placement: 'main',
    data: (ctx) => {
      const rows = host.rows('contractor')
      const published = rowsOfType(rows, 'rfq/published').map((row) => ({ type: row.type, ts: row.ts,
        ...bodyOf(row) }))
      const distributed = rowsOfType(rows, 'rfq/distributed')
      const recipientsOf = (packageId) => {
        const out2 = new Set()
        for (const row of distributed) {
          const body = bodyOf(row)
          if (asText(body.package_id) !== packageId) continue
          for (const who of body.recipients ?? []) out2.add(String(who))
        }
        return [...out2].sort()
      }
      const table = published.map((row) => {
        const packageId = asText(row.package_id)
        const rev = Number(row.rev ?? 0)
        return { id: `${packageId}#r${rev}`, package_id: packageId, rev, items: row.items,
          quote_by: row.quote_by ?? '', published_at: row.ts,
          recipients: recipientsOf(packageId).join(' '), snapshot_hash: row.hash ?? '' }
      })
      if (!table.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-published-rfq',
          next_action: '用「发布 RFQ」动作发布第一个包（发布是不产生对外义务的动作）',
          columns: [{ key: 'package_id', label: '包' }, { key: 'rev', label: '版本' }], rows: [],
          note: '本侧账本里还没有 rfq/published 行' }
      }
      return { ok: true, kind: 'table',
        columns: [{ key: 'package_id', label: '包', type: 'code' }, { key: 'rev', label: '版本' },
          { key: 'items', label: '条目数' }, { key: 'quote_by', label: '报价截止' },
          { key: 'recipients', label: '已分发（谁收到了）' }, { key: 'snapshot_hash', label: '快照哈希', type: 'code' }],
        rows: table, counts: { published: table.length },
        note: '收件人来自 rfq/distributed 的 recipients 字段（「谁在何时收到哪个版本」按版本锚定）' }
    } }))

  out.push(surface.panel({ plugin_id: me, id: 'rfq.responses', title: '收到的报价（本侧登记行）',
    view: 'contractor', order: 20, kind: 'table',
    actions: ['compare.rank', 'award.propose'],
    data: () => {
      const rows = rowsOfType(host.rows('contractor'), 'quote/submitted').map((row) => bodyOf(row))
      if (!rows.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-quote-submitted',
          next_action: '等供应商在 APP 里备报价并**人签提交**（提交会同时在本侧登记一条）',
          columns: [{ key: 'quote_id', label: '报价' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        columns: [{ key: 'quote_id', label: '报价', type: 'code' }, { key: 'supplier', label: '供应商' },
          { key: 'item_id', label: '行项目', type: 'code' }, { key: 'unit_price_cents', label: '单价（整数分）' },
          { key: 'lead_time_days', label: '交期（天）' }, { key: 'submitted_at', label: '提交时刻' }],
        rows: rows.map((row) => ({ id: row.quote_id, quote_id: row.quote_id, supplier: row.supplier ?? '',
          package_id: row.package_id ?? '', item_id: row.item_id, unit_price_cents: row.unit_price_cents,
          lead_time_days: row.lead_time_days, submitted_at: row.submitted_at })), bulk: 'compare.rank',
        counts: { quotes: rows.length } }
    } }))

  // ---- 工作台（首屏「我今天要做什么」）----------------------------------------------------------
  out.push(surface.panel({ plugin_id: me, id: 'home.rfq-todo', title: '承包商侧：我今天要做什么',
    view: 'home', order: 20, kind: 'list',
    data: () => {
      const rows = host.rows('contractor')
      const packages = rowsOfType(rows, 'rfq/published').map((row) => bodyOf(row))
      const quotes = rowsOfType(rows, 'quote/submitted').map((row) => bodyOf(row))
      const items = []
      items.push({ level: packages.length ? 'info' : 'warn',
        title: packages.length ? `已发布 ${packages.length} 个包` : '还没有发布任何 RFQ',
        body: packages.slice(-1).map((row) => `${row.package_id} rev${row.rev}（截止 ${row.quote_by ?? '—'}）`).join(''),
        next_action: packages.length ? `深链 ${host.prefix}/app/contractor/` : '用「发布 RFQ」发一包（不产生对外义务）' })
      items.push({ level: quotes.length ? 'ok' : 'warn',
        title: quotes.length ? `收到 ${quotes.length} 条报价登记` : '还没有收到报价',
        body: quotes.slice(0, 3).map((row) => `${row.quote_id}：${row.item_id} @ ${row.unit_price_cents} 分`).join('；'),
        next_action: quotes.length ? '去比价（可调权重，贡献可解释）→ 授标（人签）' : '等供应商人签提交' })
      return { ok: true, kind: 'list', items }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'rfq.publish', title: '发布 RFQ', views: ['contractor'],
    group: '发包', order: 10, icon: 'rocket', confirm: { required: true,
      message: '发布即对受邀供应商可见（可再发新版修订）；确认发布？' },
    hint: '行项目一行一条：`item_id,描述,单位,数量`；邀请对象写 realm（如 supplier:g1）',
    input: { fields: [
      { name: 'package_id', label: '包 id', type: 'text', required: true, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$',
        help: '字母数字开头，可含 . _ -' },
      { name: 'subject', label: '标题', type: 'text', required: true, help: '一句话说明这一包是什么' },
      { name: 'currency', label: '币种', type: 'text', default: 'CNY' },
      { name: 'quote_by', label: '报价截止（ISO8601）', type: 'text', required: true,
        pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$', help: '如 2026-09-30T00:00:00Z' },
      { name: 'clarify_by', label: '澄清截止（可空）', type: 'text', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$' },
      { name: 'items', label: '行项目（每行：item_id,描述,单位,数量）', type: 'textarea', required: true,
        help: '例：L-001,DN100 管道,m,120' },
      { name: 'invited', label: '邀请对象（逗号分隔的 realm）', type: 'text', required: true,
        help: '例：supplier:g1' },
      { name: 'note', label: '备注（可选；只留 sha256 进待办件）', type: 'textarea' },
      { name: 'actor', label: '发言人', type: 'text', required: true, help: 'human:<你的名字>（发包也要有人认领）' },
    ] },
    server: async (ctx, input) => {
      const parsed = parseItems(input.items)
      if (parsed.problems.length) {
        return { ok: false, code: 'validation-failed', errors: parsed.problems.map((item) => ({
          field: 'items', code: item.code, message: item.message, next_action: '按每行的正确写法改后重提' })),
          next_action: '行项目每行要写 `item_id,描述,单位,数量`（4 段）' }
      }
      const invited = parseList(input.invited)
      const actor = asText(input.actor)
      if (!actor.startsWith('human:')) {
        return { ok: false, code: 'human-required', reason: '发包的发言人必须以 human: 开头（agent 不得代人发包）',
          next_action: '写 human:<你的名字>' }
      }
      const staged = host.stage('rfq-publish', { kind: 'rfq-publish', action: 'publish', view: 'contractor',
        package_id: asText(input.package_id), subject: asText(input.subject),
        currency: asText(input.currency) || 'CNY', quote_by: asText(input.quote_by),
        clarify_by: asText(input.clarify_by), items: parsed.items, invited,
        actor, note: String(input.note ?? '') })
      if (!staged.ok) return staged
      const args = ['--request', staged.path, '--ui-shared', host.sharedDir,
        '--ledger-contractor', ledger(), '--ledger-supplier', asText(host.config?.ledger_supplier),
        '--now', host.now(), '--actor', actor]
      if (asText(host.config?.rfq_delivery)) args.push('--delivery', asText(host.config.rfq_delivery))
      const run = host.runPython('src/domain/rfq/tools/rfq-publish.py', args)
      const json = run.json ?? {}
      return { ok: run.ok && json.ok === true, code: json.refusal?.code ?? (run.ok ? 'published' : 'writer-failed'),
        reason: json.refusal?.reason ?? run.reason ?? '',
        next_action: json.next_action ?? (run.ok ? '包已发布并被分发：供应商道的「我的 RFQ 包」能看到它'
          : '看 stdout/stderr 定位唯一写者的拒绝原因（账本零新增）'),
        result: { pending: staged.file, package_id: json.package_id ?? staged.record.package_id,
          rev: json.rev ?? null, applied: json.applied ?? [], duplicates: json.duplicates ?? [],
          ledger_added: json.ledger_added ?? 0, delivery: json.delivery ?? null, writer: run.json ?? null,
          stdout: run.stdout ? run.stdout.slice(-500) : '' } }
    } }))

  out.push(surface.shortcut({ plugin_id: me, id: 'shortcut.rfq-publish', keys: 'p', action: 'rfq.publish',
    title: '发布 RFQ', order: 10 }))

  out.push(surface.statusItem({ plugin_id: me, id: 'status.rfq', title: '发包', order: 10, read: () => {
    const rows = host.rows('contractor')
    const packages = new Set(rowsOfType(rows, 'rfq/published').map((row) => asText(bodyOf(row).package_id)))
    const quotes = rowsOfType(rows, 'quote/submitted').length
    return { text: `${packages.size} 个包 · ${quotes} 条报价登记`, level: packages.size ? 'ok' : 'warn',
      next_action: packages.size ? '' : '还没有发布任何 RFQ' }
  } }))

  out.push(surface.notificationSource({ plugin_id: me, id: 'notify.rfq', title: '发包与回应', order: 10,
    poll: () => {
      const rows = host.rows('contractor')
      const published = rowsOfType(rows, 'rfq/published').map((row) => bodyOf(row))
      const quotes = rowsOfType(rows, 'quote/submitted').map((row) => bodyOf(row))
      const items = []
      for (const row of published) {
        items.push({ id: `rfq:${row.package_id}`, level: 'info', at: String(row.ts ?? ''),
          title: `包 ${row.package_id} 已发布（rev${row.rev}）`,
          body: `报价截止 ${row.quote_by ?? '—'}；条目 ${row.items ?? '—'}`,
          next_action: '等回应；催报见「回文时限」页' })
      }
      if (!quotes.length && published.length) {
        items.push({ id: 'rfq:no-quotes', level: 'warn', at: '',
          title: '还没有收到任何报价登记', body: '被邀供应商尚未提交',
          next_action: '在供应商道确认对方能看到包（「我的 RFQ 包」面板）' })
      }
      return items
    } }))

  // ------------------------------------------------------------------ 催报（DEF-013）
  const remindTool = 'src/domain/rfq/tools/rfq-remind.py'
  const clarifyTool = 'src/domain/rfq/tools/rfq-clarify-apply.py'
  const REMIND_PREFIX = '催报：'

  const packageFacts = (view) => {
    const rows = host.rows(view)
    const published = rowsOfType(rows, 'rfq/published').map((row) => ({ ...bodyOf(row), ts: row.ts }))
    const distributed = rowsOfType(rows, 'rfq/distributed')
    const quotes = rowsOfType(rows, 'quote/submitted').map((row) => bodyOf(row))
    const reminders = rowsOfType(rows, 'mail/queued').map((row) => ({ ...bodyOf(row), ts: row.ts }))
      .filter((row) => asText(row.subject).startsWith(REMIND_PREFIX))
    return { rows, published, distributed, quotes, reminders }
  }
  const recipientsOf = (distributed, packageId) => {
    const out2 = new Set()
    for (const row of distributed) {
      const body = bodyOf(row)
      if (asText(body.package_id) !== packageId) continue
      for (const who of body.recipients ?? []) out2.add(String(who))
    }
    return [...out2].sort()
  }
  const snapshotOfPackage = (packageId) => {
    for (const rev of [5, 4, 3, 2, 1]) {
      const data = host.readJson(`${host.sharedDir}/contractor/rfq-${packageId}-rev${rev}.json`)
      if (data) return data
    }
    return null
  }
  const remindNotices = () => {
    const data = host.readJson(`${host.sharedDir}/exchange/reminders.json`)
    return data && Array.isArray(data.reminders) ? data.reminders : []
  }

  out.push(surface.panel({ plugin_id: me, id: 'rfq.remind-board', title: '回文时限与催报（谁没回 / 已催几次）',
    view: 'contractor', order: 15, kind: 'table', actions: ['rfq.remind'],
    data: () => {
      const { published, distributed, quotes, reminders } = packageFacts('contractor')
      if (!published.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-published-rfq',
          next_action: '先用「发布 RFQ」发一包（发布不产生对外义务）', columns: [{ key: 'package_id', label: '包' }], rows: [] }
      }
      const moment = published.map((row) => String(row.ts ?? '')).sort().pop() ?? ''
      const rows = published.map((row) => {
        const packageId = asText(row.package_id)
        const snapshot = snapshotOfPackage(packageId)
        const deadlines = (snapshot && snapshot.spec ? snapshot.spec.deadlines : null) ?? snapshot?.deadlines ?? {}
        const quoteBy = asText(row.quote_by) || asText(deadlines.quote_by)
        const hoursLeft = quoteBy && moment
          ? Math.round(((Date.parse(quoteBy) - Date.parse(moment)) / 3600000) * 100) / 100 : null
        const invited = (snapshot?.invited ?? recipientsOf(distributed, packageId)).map(String)
        const answered = new Set(quotes.filter((quote) => asText(quote.package_id) === packageId)
          .map((quote) => asText(quote.supplier)))
        const mine = reminders.filter((item) => asText(item.package_id) === packageId)
        const notReplied = invited.filter((who) => !answered.has(who))
        return { id: `${packageId}#r${row.rev}`, package_id: packageId, rev: row.rev, quote_by: quoteBy,
          hours_left: hoursLeft, invited: invited.join(' '), replied: [...answered].join(' ') || '（还没人回）',
          not_replied: notReplied.join(' ') || '（都回了）', recipients: notReplied.join(' '),
          remind_count: mine.length, last_remind_at: mine.map((item) => String(item.ts ?? '')).sort().pop() ?? '',
          mail_kind: mine.length ? asText(mine[mine.length - 1].kind) : '' }
      })
      return { ok: true, kind: 'table',
        columns: [
          { key: 'package_id', label: '包', type: 'code' }, { key: 'rev', label: 'rev' },
          { key: 'quote_by', label: '报价截止' }, { key: 'hours_left', label: '距截止（小时，按事实时刻）' },
          { key: 'invited', label: '邀请' }, { key: 'replied', label: '已回' },
          { key: 'not_replied', label: '还没回' }, { key: 'remind_count', label: '已催次数' },
          { key: 'last_remind_at', label: '最后一次催报 @ts' },
        ],
        rows, row_actions: ['rfq.remind'], counts: { packages: rows.length,
          not_replied: rows.reduce((sum, row) => sum + (row.not_replied.startsWith('（') ? 0 : row.not_replied.split(' ').length), 0) },
        note: `事实时刻 ${moment || '—'} · 勾选若干行（或行内）点「催报」：落本侧 \`mail/queued\`（催报本体）+`
          + `对方账本 \`mail/queued\`（对方可见）；临近/已过截止会另落 \`rfq/due-soon\`|\`rfq/overdue\`；`
          + `邮件通道不可用时**绝不假装已发**（如实报 mail-smtp-unconfigured，可复制正文文件）` }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'rfq.remind', title: '催报（一键 · 真落账 · 给对方出通知）',
    views: ['contractor'], group: '发包', order: 20, permission: 'human-signature', inline: true,
    confirm: { required: true, message: '催报会落账并给对方出通知（不是承诺、也不假装已发信）：确认？' },
    hint: '收件人默认「还没回的」；落 mail/queued（两侧）+ 临近/已过截止时落 rfq/due-soon|overdue；'
      + '通知正文只留 sha256 进账本，可读的一份在 exchange/reminders.json',
    input: { bulk: 'ids', fields: [
      { name: 'package_id', label: '包 id', type: 'text', required: true, help: '从表格行里取' },
      { name: 'rev', label: '版本 rev', type: 'number', min: 1, help: '空=最新已发布版本' },
      { name: 'recipients', label: '收件人（逗号分隔 realm；空=表格里「还没回」那几位）', type: 'text' },
      { name: 'subject', label: '主题', type: 'text', help: '默认「催报：<包 id>」' },
      { name: 'soon_hours', label: '临近阈值（小时）', type: 'number', min: 0, max: 8760, default: 48,
        help: '距截止小于它才算「临近」，会另落 rfq/due-soon' },
      { name: 'letter', label: '催报正文', type: 'textarea', required: true,
        help: '只留 sha256 进账本；不得含凭据/私域字段' },
      { name: 'signature', label: '催报人（人签）', type: 'signature', required: true, help: 'human:<你的名字>' },
    ] },
    server: async (ctx, input) => {
      const recipients = String(input.recipients ?? '').split(/[,\s]+/).map((item) => item.trim()).filter(Boolean)
      const letter = String(input.letter ?? '')
      if (letter.trim() === '') {
        return { ok: false, code: 'empty-note', reason: '催报正文为空：对方要能看懂你要他做什么',
          next_action: '写一句话再催' }
      }
      const staged = host.stage('rfq-remind', { kind: 'rfq-remind', action: 'remind', view: 'contractor',
        package_id: asText(input.package_id), rev: input.rev === undefined || input.rev === '' ? null : Number(input.rev),
        recipients, subject: asText(input.subject), soon_hours: Number(input.soon_hours ?? 48),
        actor: asText(input.signature), note: letter })
      if (!staged.ok) return staged
      const run = host.runPython(remindTool, ['--request', staged.path, '--ui-shared', host.sharedDir,
        '--ledger-contractor', asText(host.config?.ledger_contractor),
        '--ledger-supplier', asText(host.config?.ledger_supplier), '--now', host.now()])
      const json = run.json ?? {}
      return { ok: run.ok && json.ok === true, code: json.refusal?.code ?? (json.ok ? 'reminded' : 'writer-failed'),
        reason: json.refusal?.reason ?? run.reason ?? '',
        next_action: json.refusal?.next_action ?? json.next_action_runtime ?? '看 result 里的落账与传输状态',
        result: { pending: staged.file, package_id: json.package_id ?? null, rev: json.rev ?? null,
          recipients: json.recipients ?? [], applied: json.applied ?? [], fired: json.fired ?? [],
          ledger_added: json.ledger_added ?? 0, mail_transport: json.mail_transport ?? null,
          notices: json.notices ?? null, supplier_notice: json.supplier_notice ?? null } }
    } }))

  out.push(surface.panel({ plugin_id: me, id: 'rfq.remind-notices', title: '承包商给我的催报（对方通知）',
    view: 'supplier', order: 55, kind: 'table',
    data: () => {
      const letters = remindNotices()
      const rows = []
      for (const row of rowsOfType(host.rows('supplier'), 'mail/')) {
        const body = bodyOf(row)
        const subject = asText(body.subject)
        if (!subject.startsWith(REMIND_PREFIX)) continue
        const letter = (letters.filter((item) => asText(item.package_id) === asText(body.package_id)
          && asText(item.subject) === subject).slice(-1)[0] ?? {}).letter ?? ''
        rows.push({ id: `${body.message_id ?? ''}-${row.ts ?? ''}`, at: row.ts ?? '', subject,
          package_id: asText(body.package_id), rfq_rev: body.rfq_rev, letter,
          body_sha256: asText(body.body_sha256) })
      }
      if (!rows.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-reminder',
          next_action: '还没收到催报；快到截止还没回时对方会催', columns: [{ key: 'subject', label: '通知' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        columns: [{ key: 'at', label: '收到时刻' }, { key: 'subject', label: '主题', type: 'code' },
          { key: 'package_id', label: '包', type: 'code' }, { key: 'rfq_rev', label: 'rev' },
          { key: 'letter', label: '对方原话' }, { key: 'body_sha256', label: '正文哈希', type: 'code' }],
        rows, counts: { reminders: rows.length },
        note: '通知是"入队"事实（`mail/queued`）：**不代表邮件真的发出**（本机没有 SMTP 凭据时如实为 refused）' }
    } }))

  // ------------------------------------------------------------------ 澄清单据（DEF-014）
  const ticketsOf = (rows) => {
    const map = new Map()
    const order = []
    for (const row of rows) {
      const type = String(row?.type ?? '')
      if (!type.startsWith('clarification/')) continue
      const body = bodyOf(row)
      const id = asText(body.ticket_id)
      if (!id) continue
      if (!map.has(id)) order.push(id)
      const previous = map.get(id) ?? { ticket_id: id, status: 'open', question: '', refs: [], rfq_rev: null,
        package_id: '', asker_realm: '', answer: null, broadcast_to: [], created_at: String(row.ts ?? ''),
        answered_at: '', closed_at: '', mirror: false }
      const next = { ...previous }
      if (type === 'clarification/asked') {
        if (body.question) next.question = String(body.question)
        if (body.refs) next.refs = body.refs.item_ids ?? previous.refs
        if (body.rfq_rev) next.rfq_rev = body.rfq_rev
        if (body.package_id) next.package_id = String(body.package_id)
        if (body.asker_realm) next.asker_realm = String(body.asker_realm)
        if (asText(body.status) === 'closed') { next.status = 'closed'; next.closed_at = String(row.ts ?? '') }
        else if (asText(body.status) === 'open' && body.question) next.status = 'open'
      } else if (type === 'clarification/answered') {
        if (body.text !== undefined && body.text !== null) {
          next.answer = String(body.text)
          next.answered_at = String(row.ts ?? '')
          if (next.status !== 'closed') next.status = 'answered'
        }
        if (body.broadcast_to) { next.broadcast_to = body.broadcast_to.map(String) }
      } else if (type === 'clarification/reopened') {
        next.status = 'open'
        next.answer = previous.answer
      }
      next.mirror = body.mirror === true
      map.set(id, next)
    }
    return order.map((id) => map.get(id))
  }

  out.push(surface.panel({ plugin_id: me, id: 'clarify.queue', title: '澄清单据队列（待答 / 已答 / 已关闭）',
    view: 'contractor', order: 18, kind: 'table', actions: ['clarify.answer', 'clarify.broadcast', 'clarify.close'],
    data: () => {
      const rowsIn = host.rows('contractor')
      const tickets = ticketsOf(rowsIn)
      const moment = rowsIn.map((row) => String(row?.ts ?? '')).filter(Boolean).sort().pop() ?? ''
      if (!tickets.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-ticket',
          next_action: '供应商提问后这里会出现工单（提问方在供应商道的「我的澄清」里提）',
          columns: [{ key: 'ticket_id', label: '工单' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        columns: [
          { key: 'ticket_id', label: '工单', type: 'code' }, { key: 'package_id', label: '包', type: 'code' },
          { key: 'rfq_rev', label: 'rev' }, { key: 'refs', label: '引用条目', type: 'code' },
          { key: 'question', label: '问题' }, { key: 'status_label', label: '状态' },
          { key: 'waited', label: '未答时长（按事实时刻）' }, { key: 'answer', label: '我的答复' },
          { key: 'broadcast_label', label: '广播' }, { key: 'created_at', label: '提问 @ts' },
        ],
        rows: tickets.map((ticket) => ({ id: ticket.ticket_id, ...ticket,
          refs: (ticket.refs ?? []).join(' '),
          status_label: ticket.status === 'open' ? '待答' : (ticket.status === 'answered' ? '已答（未广播=只有提问方可见）' : '已关闭'),
          waited: ticket.status === 'open'
            ? `${Math.round((Date.parse(moment) - Date.parse(ticket.created_at)) / 3600000 * 100) / 100} 小时`
            : '—',
          broadcast_label: (ticket.broadcast_to ?? []).length ? `已广播给 ${ticket.broadcast_to.join(' ')}` : '未广播' })),
        row_actions: ['clarify.answer', 'clarify.broadcast', 'clarify.close'],
        counts: { tickets: tickets.length,
          open: tickets.filter((ticket) => ticket.status === 'open').length,
          answered: tickets.filter((ticket) => ticket.status === 'answered').length,
          closed: tickets.filter((ticket) => ticket.status === 'closed').length },
        note: `事实时刻 ${moment || '—'} · 答复必须署名 \`human:*\`；**广播必须覆盖全部在册投标人**`
          + `（缺一家就落 \`clarification/broadcast-incomplete\` 并拒绝），未完整广播的工单不得关闭（INV-006）` }
    } }))

  out.push(surface.panel({ plugin_id: me, id: 'clarify.mine', title: '我的澄清（我提的问题与答复）',
    view: 'supplier', order: 50, kind: 'table', actions: ['clarify.ask', 'clarify.broadcast'],
    data: () => {
      const rowList = host.rows('supplier')
      const tickets = ticketsOf(rowList)
      if (!tickets.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-ticket',
          next_action: '用「提问澄清」对某几条行项目提问（必须绑定包版本 rev 与 ≥1 个条目引用）',
          columns: [{ key: 'ticket_id', label: '工单' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        columns: [{ key: 'ticket_id', label: '工单', type: 'code' }, { key: 'package_id', label: '包', type: 'code' },
          { key: 'rfq_rev', label: 'rev' }, { key: 'refs', label: '引用条目', type: 'code' },
          { key: 'question', label: '我问的' }, { key: 'status_label', label: '状态' },
          { key: 'answer', label: '承包商答复' }],
        rows: tickets.map((ticket) => ({ id: ticket.ticket_id, ...ticket, refs: (ticket.refs ?? []).join(' '),
          status_label: ticket.status === 'open' ? '待回答' : (ticket.status === 'answered' ? '已答复' : '已关闭'),
          answer: ticket.answer ?? '（还没答）' })),
        counts: { tickets: tickets.length,
          answered: tickets.filter((ticket) => ticket.answer).length },
        note: '答复在承包商侧「回答」并「广播」之后全员可见；未广播前只有提问方看得见' }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'clarify.ask', title: '提问澄清（绑定版本与条目）',
    views: ['supplier'], group: '澄清', order: 5, permission: 'human-signature',
    confirm: { required: true, message: '提问会落账并让对方看到：确认以你的署名提问？' },
    hint: '必须给包版本（rev）与 ≥1 个条目引用（FR-CLARIFY-001）；问题 ≤500 字',
    input: { fields: [
      { name: 'package_id', label: '包 id', type: 'text', required: true },
      { name: 'rfq_rev', label: '包版本 rev', type: 'number', required: true, min: 1, default: 1 },
      { name: 'item_ids', label: '引用条目（逗号分隔，至少 1 个）', type: 'text', required: true,
        help: '如 L-001,L-002' },
      { name: 'question', label: '问题（≤500 字）', type: 'textarea', required: true },
      { name: 'signature', label: '提问人（人签）', type: 'signature', required: true },
    ] },
    server: async (ctx, input) => {
      const itemIds = String(input.item_ids ?? '').split(/[,\s]+/).map((item) => item.trim()).filter(Boolean)
      const question = String(input.question ?? '')
      const staged = host.stage('clarify-apply', { kind: 'clarify-apply', action: 'ask', view: 'supplier',
        package_id: asText(input.package_id), rfq_rev: Number(input.rfq_rev ?? 1), item_ids: itemIds,
        actor: asText(input.signature), note: question })
      if (!staged.ok) return staged
      const run = host.runPython(clarifyTool, ['--step', 'ask', '--request', staged.path, '--view', 'supplier',
        '--ui-shared', host.sharedDir, '--ledger-contractor', asText(host.config?.ledger_contractor),
        '--ledger-supplier', asText(host.config?.ledger_supplier), '--now', host.now()])
      const json = run.json ?? {}
      return { ok: run.ok && json.ok === true, code: json.refusal?.code ?? (json.ok ? 'asked' : 'writer-failed'),
        reason: json.refusal?.reason ?? run.reason ?? '',
        next_action: json.refusal?.next_action ?? json.next_action_runtime ?? '看 result 里的工单号与双向登记',
        result: { pending: staged.file, ticket_id: json.ticket_id ?? null, applied: json.applied ?? [],
          ledger_added: json.ledger_added ?? 0, counterpart_notice: json.counterpart_notice ?? null } }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'clarify.answer', title: '回答澄清（人签）',
    views: ['contractor'], group: '澄清', order: 10, permission: 'human-signature', inline: true,
    confirm: { required: true, message: '答复会落 `clarification/answered`（未广播前只有提问方可见）：确认？' },
    hint: '回答人必须 human:*；答复要广播给在册投标人才算完成（INV-006）',
    input: { fields: [
      { name: 'ticket_id', label: '工单 id', type: 'text', required: true },
      { name: 'text', label: '答复正文', type: 'textarea', required: true },
      { name: 'signature', label: '回答人（人签）', type: 'signature', required: true },
    ] },
    server: async (ctx, input) => {
      const staged = host.stage('clarify-apply', { kind: 'clarify-apply', action: 'answer', view: 'contractor',
        ticket_id: asText(input.ticket_id), actor: asText(input.signature), note: String(input.text ?? '') })
      if (!staged.ok) return staged
      const run = host.runPython(clarifyTool, ['--step', 'answer', '--request', staged.path, '--view', 'contractor',
        '--ui-shared', host.sharedDir, '--ledger-contractor', asText(host.config?.ledger_contractor),
        '--ledger-supplier', asText(host.config?.ledger_supplier), '--now', host.now()])
      const json = run.json ?? {}
      return { ok: run.ok && json.ok === true, code: json.refusal?.code ?? (json.ok ? 'answered' : 'writer-failed'),
        reason: json.refusal?.reason ?? run.reason ?? '',
        next_action: json.refusal?.next_action ?? json.next_action_runtime ?? '下一步：广播（覆盖全部在册投标人）',
        result: { pending: staged.file, ticket_id: json.ticket_id ?? null, status: json.status ?? null,
          ledger_added: json.ledger_added ?? 0, counterpart_notice: json.counterpart_notice ?? null } }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'clarify.broadcast', title: '广播答复（覆盖在册投标人）',
    views: ['contractor', 'supplier'], group: '澄清', order: 20, permission: 'human-signature', inline: true,
    confirm: { required: true, message: '广播后**在册投标人全员**可见（缺一家会被拒，工单不得关闭）：确认？' },
    hint: '默认广播给全部在册投标人（本包邀请名单）；名单不全即 `broadcast-incomplete` 并拒绝',
    input: { fields: [
      { name: 'ticket_id', label: '工单 id', type: 'text', required: true },
      { name: 'to', label: '广播名单（逗号分隔；空=全部在册投标人）', type: 'text' },
      { name: 'signature', label: '发言人（人签）', type: 'signature', required: true },
    ] },
    server: async (ctx, input) => {
      const to = String(input.to ?? '').split(/[,\s]+/).map((item) => item.trim()).filter(Boolean)
      const staged = host.stage('clarify-apply', { kind: 'clarify-apply', action: 'broadcast',
        view: String(ctx.view ?? 'contractor'), ticket_id: asText(input.ticket_id), to,
        actor: asText(input.signature), note: '' })
      if (!staged.ok) return staged
      const run = host.runPython(clarifyTool, ['--step', 'broadcast', '--request', staged.path,
        '--view', String(ctx.view ?? 'contractor'), '--ui-shared', host.sharedDir,
        '--ledger-contractor', asText(host.config?.ledger_contractor),
        '--ledger-supplier', asText(host.config?.ledger_supplier), '--now', host.now()])
      const json = run.json ?? {}
      return { ok: run.ok && json.ok === true, code: json.refusal?.code ?? (json.ok ? 'broadcast' : 'writer-failed'),
        reason: json.refusal?.reason ?? run.reason ?? '',
        next_action: json.refusal?.next_action ?? json.next_action_runtime ?? '广播完成后才能「关闭工单」',
        result: { pending: staged.file, ticket_id: json.ticket_id ?? null,
          broadcast_to: json.broadcast_to ?? [], registered: json.registered_bidders ?? [],
          ledger_added: json.ledger_added ?? 0 } }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'clarify.close', title: '关闭工单（前置：已完整广播）',
    views: ['contractor'], group: '澄清', order: 30, permission: 'human-signature', inline: true,
    confirm: { required: true, message: '关闭工单：未完整广播的工单会被拒（INV-006）：确认？' },
    hint: '关闭前置是"答案已完整广播给在册投标人"，否则落 broadcast-incomplete 并拒绝',
    input: { fields: [
      { name: 'ticket_id', label: '工单 id', type: 'text', required: true },
      { name: 'signature', label: '关闭人（人签）', type: 'signature', required: true },
    ] },
    server: async (ctx, input) => {
      const staged = host.stage('clarify-apply', { kind: 'clarify-apply', action: 'close', view: 'contractor',
        ticket_id: asText(input.ticket_id), actor: asText(input.signature), note: '' })
      if (!staged.ok) return staged
      const run = host.runPython(clarifyTool, ['--step', 'close', '--request', staged.path, '--view', 'contractor',
        '--ui-shared', host.sharedDir, '--ledger-contractor', asText(host.config?.ledger_contractor),
        '--ledger-supplier', asText(host.config?.ledger_supplier), '--now', host.now()])
      const json = run.json ?? {}
      return { ok: run.ok && json.ok === true, code: json.refusal?.code ?? (json.ok ? 'closed' : 'writer-failed'),
        reason: json.refusal?.reason ?? run.reason ?? '',
        next_action: json.refusal?.next_action ?? json.next_action_runtime ?? '工单已关闭',
        result: { pending: staged.file, ticket_id: json.ticket_id ?? null, status: json.status ?? null,
          ledger_added: json.ledger_added ?? 0 } }
    } }))

  out.push(surface.notificationSource({ plugin_id: me, id: 'notify.clarify', title: '澄清单据待办', order: 12,
    poll: () => {
      const items = []
      for (const ticket of ticketsOf(host.rows('contractor'))) {
        if (ticket.status !== 'open') continue
        items.push({ id: `clarify:${ticket.ticket_id}`, level: 'warn', at: ticket.created_at, ref: ticket.ticket_id,
          title: `待回答：${ticket.ticket_id}（${ticket.package_id} rev${ticket.rfq_rev}）`,
          body: `引用 ${(ticket.refs ?? []).join(' ')} · ${String(ticket.question).slice(0, 80)}`,
          next_action: '去「澄清单据队列」回答（人签），然后广播给在册投标人' })
      }
      for (const row of rowsOfType(host.rows('supplier'), 'mail/')) {
        const body = bodyOf(row)
        const subject = asText(body.subject)
        if (!subject.startsWith('报价评审：')) continue
        items.push({ id: `review:${body.message_id ?? ''}`, level: 'info', at: String(row.ts ?? ''),
          title: `承包商判定：${subject}`, body: '看「承包商对我报价的判定」面板',
          next_action: '按判定处理：退回/要补件时改后重报（人签提交）' })
      }
      return items
    } }))

  return out
}
