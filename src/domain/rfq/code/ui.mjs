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

  return out
}
