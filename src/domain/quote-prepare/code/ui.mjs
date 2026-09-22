/**
 * `domain/quote-prepare` 的 **GUI 贡献** —— 供应商侧「看包 → 备报价 → 人签提交 → 页面回读」这一条闭环。
 *
 * 注册的东西：
 *   · 视图 `quote.my`（挂 `supplier` 道）；
 *   · 面板 `quote.package`（**发给自己的** RFQ 包：只读投递信封里 `delivered_to` 含自己 realm 的那份；
 *     行项目表**可编辑**（单价整数分 / 交期天数）—— 这是"备报价"的交互面，批量提交就是「备这份草稿」）；
 *   · 面板 `quote.drafts`（本侧账本里 `quote/drafted` 的草稿：状态"待签署"，行内动作「人签提交」）；
 *   · 面板 `quote.submitted`（本侧账本里 `quote/submitted` 的事实行 —— **提交结果回读**）；
 *   · 动作 `quote.draft`（服务端一半：`validate()` 字段级校验 → 落 0600 待办件 →
 *     跑唯一写者 `src/domain/quote-prepare/tools/quote-draft.py` 落 `quote/drafted`（非签名动作））；
 *     支持**批量**（`input.rows`：来自可编辑表格的批量提交，一行一份草稿）；
 *   · 动作 `quote.submit`（**human-signature**：服务端一半跑唯一写者 `tools/quote-sign.py`，
 *     `--actor human:<署名>` → 落 `approval/requested` → `approval/granted` → `quote/submitted`，
 *     并在承包商账本登记一条「供应商已提交报价」）；
 *   · 快捷键 `d`、通知源（待签署草稿）、状态栏项。
 *
 * 纪律：本文件不写账本（只 spawn Python 侧唯一写者）；单价一律**整数分**；备注正文只进 0600 待办件。
 */
import { createHash } from 'node:crypto'
import { validate, LIMITS, FIELDS, MONEY_UNIT } from './quote-prepare.mjs'

/** 与唯一写者 `tools/quote-draft.py` 的 `canonical_lines()` **逐字节一致**的行项目规范化 JSON。 */
const canonicalLines = (record) => JSON.stringify({ currency: String(record.currency ?? ''),
  item_id: String(record.item_id ?? ''), lead_time_days: record.lead_time_days,
  rfq_id: String(record.rfq_id ?? ''), unit_price_cents: record.unit_price_cents })
const sha256 = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex')

export const plugin_id = 'domain/quote-prepare'

const asText = (value) => (typeof value === 'string' ? value.trim() : '')
const bodyOf = (row) => (row && typeof row.body === 'object' && row.body !== null ? row.body : {})
const typeRows = (rows, prefix) => rows.filter((row) => String(row?.type ?? '').startsWith(prefix))

/** 本视角投影事实行 → 插件要的白名单载荷（只有 `rfq/*`、`quote/*` 的类型，逐键白名单）。 */
const FACT_KEYS = ['item_id', 'item_ids', 'items', 'currency', 'package_id', 'rfq_id', 'quote_id', 'quote_by',
  'quote_draft_id', 'unit_price_cents', 'lead_time_days', 'supplier', 'ok', 'status', 'submitted_at']
const payloadOf = (host, view) => {
  const facts = []
  for (const row of typeRows(host.rows(view), 'rfq/').concat(typeRows(host.rows(view), 'quote/'))) {
    const body = bodyOf(row)
    const fact = { type: String(row?.type ?? ''), ts: row?.ts }
    for (const key of FACT_KEYS) if (body[key] !== undefined && body[key] !== null) fact[key] = body[key]
    if (String(row?.type ?? '').startsWith('quote/drafted') && fact.quote_draft_id === undefined
      && typeof row?.correlation_id === 'string') fact.quote_draft_id = row.correlation_id
    facts.push(fact)
    if (facts.length >= 256) break
  }
  return { view, as_of: facts.map((fact) => fact.ts).filter(Boolean).sort().pop() ?? null, facts }
}

/** 投递信封里**发给自己的**那一份（`delivered_to` 含本侧 realm；只出自己的包）。 */
const myPackage = (host, realm) => {
  const file = asText(host.config?.rfq_delivery)
  if (file === '') return { ok: false, code: 'delivery-unconfigured',
    reason: '宿主未配置投递信封位置（rfq_delivery）',
    next_action: '发布方（承包商）发布 RFQ 时会写这份信封；配置见 ./run 的 QUOTAGENT_UI_RFQ_DELIVERY' }
  const envelope = host.readJson(file)
  if (!envelope) return { ok: false, code: 'delivery-missing', reason: `读不到投递信封：${file}`,
    next_action: '等对方发布（或本机跑一次 APP 承包商道的「发布 RFQ」）' }
  const delivered = Array.isArray(envelope.delivered_to) ? envelope.delivered_to.map(String) : []
  if (realm && delivered.length && !delivered.includes(realm)) {
    return { ok: false, code: 'not-addressed-to-me', reason: `这份包发给了 ${delivered.join(' / ')}，不是 ${realm}`,
      next_action: '只出自己的那份：确认本侧 realm 与邀请名单' }
  }
  return { ok: true, envelope }
}

export async function register(surface, host) {
  const me = plugin_id
  const out = []
  const supplierLedger = () => asText(host.config?.ledger_supplier)
  const contractorLedger = () => asText(host.config?.ledger_contractor)
  const realmOf = (view) => {
    const rows = host.rows(view)
    const found = rows.find((row) => asText(row?.realm) !== '')
    return found ? asText(found.realm) : ''
  }

  out.push(surface.view({ plugin_id: me, id: 'quote.my', title: '我的 RFQ 与报价', order: 10, view: 'supplier',
    hint: '看发给自己的包 → 备报价（草稿可续）→ 人签提交 → 回读提交结果' }))

  out.push(surface.panel({ plugin_id: me, id: 'quote.package', title: '发给我的 RFQ 包（只出自己那份）',
    view: 'supplier', order: 10, kind: 'table',
    data: (ctx) => {
      const realm = realmOf('supplier')
      const mine = myPackage(host, realm)
      if (!mine.ok) {
        return { ok: true, kind: 'table', degraded: true, reason: mine.code, next_action: mine.next_action,
          columns: [{ key: 'item_id', label: '行项目' }], rows: [] }
      }
      const envelope = mine.envelope
      const spec = envelope.spec && typeof envelope.spec === 'object' ? envelope.spec : {}
      const items = Array.isArray(spec.items) ? spec.items : []
      const drafts = new Map(typeRows(host.rows('supplier'), 'quote/drafted')
        .map((row) => [asText(bodyOf(row).item_id), bodyOf(row)]))
      return { ok: true, kind: 'table',
        columns: [
          { key: 'item_id', label: '行项目', type: 'code' },
          { key: 'description', label: '描述' },
          { key: 'qty', label: '数量' },
          { key: 'unit', label: '单位' },
          { key: 'unit_price_cents', label: '单价（整数分，可直接改）', editable: true, type: 'number' },
          { key: 'lead_time_days', label: '交期（天，可直接改）', editable: true, type: 'number' },
          { key: 'draft', label: '已备草稿' },
        ],
        rows: items.map((item) => {
          const draft = drafts.get(String(item.item_id))
          return { id: String(item.item_id), item_id: String(item.item_id), description: item.description ?? '',
            qty: item.qty, unit: item.unit,
            unit_price_cents: draft?.unit_price_cents ?? '', lead_time_days: draft?.lead_time_days ?? '',
            draft: draft ? `${draft.quote_draft_id}（待签署）` : '' }
        }),
        editable_action: 'quote.draft',
        editable_defaults: { rfq_id: String(spec.package_id ?? ''), currency: String(spec.currency ?? 'CNY'),
          prepared_by: 'human:（请改成你的名字）' },
        bulk: 'quote.draft',
        counts: { items: items.length, rev: envelope.rev },
        note: `包 ${spec.package_id ?? '—'} rev${envelope.rev ?? '—'} · 报价截止 ${(spec.deadlines ?? {}).quote_by ?? '—'}`
          + ` · 报价一律**整数分**（8600 = 86.00）；改完单价/交期后点「备这份草稿」（可逐条，也可批量）` }
    } }))

  out.push(surface.panel({ plugin_id: me, id: 'quote.drafts', title: '我的草稿（待签署）', view: 'supplier',
    order: 20, kind: 'table', actions: ['quote.submit'],
    data: () => {
      const drafts = new Map()
      for (const row of typeRows(host.rows('supplier'), 'quote/drafted')) {
        const body = bodyOf(row)
        const id = asText(body.quote_draft_id) || asText(row?.correlation_id)
        if (!id) continue
        drafts.set(id, { id, quote_draft_id: id, rfq_id: body.rfq_id ?? body.package_id ?? '',
          item_id: body.item_id ?? '', unit_price_cents: body.unit_price_cents ?? '',
          lead_time_days: body.lead_time_days ?? '', prepared_by: body.prepared_by ?? '',
          ts: row.ts ?? '' })
      }
      const submitted = new Set(typeRows(host.rows('supplier'), 'quote/submitted')
        .map((row) => asText(bodyOf(row).quote_draft_id)))
      const rows = [...drafts.values()].map((draft) => ({ ...draft,
        status: submitted.has(draft.quote_draft_id) ? '已签署提交' : '待签署' }))
      if (!rows.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-drafts',
          next_action: '在上面的「发给我的 RFQ 包」里填单价与交期，然后「备这份草稿」',
          columns: [{ key: 'quote_draft_id', label: '草稿' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        columns: [{ key: 'quote_draft_id', label: '草稿', type: 'code' }, { key: 'rfq_id', label: '包', type: 'code' },
          { key: 'item_id', label: '行项目', type: 'code' }, { key: 'unit_price_cents', label: '单价（整数分）' },
          { key: 'lead_time_days', label: '交期（天）' }, { key: 'status', label: '状态' }],
        rows, row_actions: ['quote.submit'], counts: { drafts: rows.length },
        note: '草稿**不是报价**：只有人签提交（quote/submit）之后才算对外报价（AGENTS.md 规则 3）' }
    } }))

  out.push(surface.panel({ plugin_id: me, id: 'quote.submitted', title: '已提交的报价（提交结果回读）',
    view: 'supplier', order: 30, kind: 'table',
    data: () => {
      const rows = typeRows(host.rows('supplier'), 'quote/submitted').map((row) => bodyOf(row))
      if (!rows.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-submitted-quotes',
          next_action: '把草稿签了：行内「人签提交」→ 填 human:<你的名字>',
          columns: [{ key: 'quote_id', label: '报价' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        columns: [{ key: 'quote_id', label: '报价', type: 'code' }, { key: 'package_id', label: '包', type: 'code' },
          { key: 'item_id', label: '行项目', type: 'code' }, { key: 'unit_price_cents', label: '单价（整数分）' },
          { key: 'lead_time_days', label: '交期（天）' }, { key: 'approved_by', label: '签署人', type: 'code' },
          { key: 'approval_id', label: '人工门', type: 'code' }, { key: 'submitted_at', label: '提交时刻' }],
        rows: rows.map((row) => ({ id: row.quote_id, ...row })), counts: { quotes: rows.length },
        note: '每一行都对应一次人签的人工门（approval/requested → granted → quote/submitted，顺序不可颠倒）' }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'quote.draft', title: '备报价草稿（可批量）', views: ['supplier'],
    group: '报价', order: 10, input: {
      bulk: 'rows',
      fields: [
        { name: 'rfq_id', label: 'RFQ 引用', type: 'text', required: true, help: '必须出现在本侧事实里' },
        { name: 'item_id', label: '行项目', type: 'text', help: '批量提交时每行自带 item_id（可留空）' },
        { name: 'unit_price_cents', label: '单价（整数分）', type: 'number',
          min: LIMITS.unit_price_cents_min, max: LIMITS.unit_price_cents_max,
          help: '8600 = 86.00 元；批量时每行自带（单条提交时必填）' },
        { name: 'lead_time_days', label: '交期（天）', type: 'number',
          min: LIMITS.lead_time_days_min, max: LIMITS.lead_time_days_max,
          help: '批量时每行自带（单条提交时必填）' },
        { name: 'currency', label: '币种', type: 'text', default: 'CNY' },
        { name: 'prepared_by', label: '发言人', type: 'text', required: true, help: 'human:<你的名字>' },
        { name: 'note', label: '备注（可选）', type: 'textarea' },
      ] },
    hint: '草稿是**非签名动作**：它只表示"报价已准备好"，不产生对外义务；签名提交另一步（人签）',
    server: async (ctx, input) => {
      const rows = Array.isArray(input.rows) && input.rows.length ? input.rows : [input]
      const payload = payloadOf(host, 'supplier')
      const rows0 = (host.rows('supplier') ?? []).find((row) => asText(row?.realm) !== '') ?? null
      const preparedBy = asText(input.prepared_by)
      if (!preparedBy.startsWith('human:')) {
        return { ok: false, code: 'human-required', reason: '草稿也要有人认领：prepared_by 必须以 human: 开头',
          next_action: '写 human:<你的名字>' }
      }
      const applied = []
      const failures = []
      for (const row of rows.slice(0, LIMITS.max_items)) {
        const itemId = asText(row.item_id ?? row.id)
        const form = { get: (key) => ({ rfq_id: asText(input.rfq_id), item_id: itemId,
          unit_price_cents: String(row.unit_price_cents ?? input.unit_price_cents ?? ''),
          lead_time_days: String(row.lead_time_days ?? input.lead_time_days ?? ''),
          prepared_by: preparedBy, currency: asText(input.currency) || 'CNY',
          note: String(input.note ?? '') }[key]) }
        const verdict = validate({ view: 'supplier', form, payload }, { views: ['supplier'], ...LIMITS })
        if (!verdict.ok) {
          failures.push({ item_id: itemId, code: verdict.errors?.[0]?.code ?? 'validation-failed',
            reason: (verdict.errors ?? []).map((item) => `${item.field}:${item.message}`).join('；'),
            next_action: verdict.errors?.[0]?.next_action ?? '按字段错误改后重提' })
          continue
        }
        // 草稿 id / 行哈希 / 备注哈希：与宿主既有那条路由（`webui.mjs` 的 `submitDraft`）**同一算法**，
        // 唯一写者 `tools/quote-draft.py` 会对它们逐字节重算复核（对不上就拒、账本零新增）。
        const supplierRealm = asText(rows0?.realm) || 'supplier:gui'
        const prepared = { ...verdict.record, supplier: supplierRealm, view: 'supplier', submitted_at: '' }
        prepared.note_sha256 = sha256(prepared.note ?? '')
        prepared.lines_sha256 = sha256(canonicalLines(prepared))
        prepared.bytes = Buffer.byteLength(String(prepared.note ?? ''), 'utf8')
        const draftId = `qd-supplier-` + sha256([prepared.view, supplierRealm, canonicalLines(prepared),
          String(prepared.note ?? ''), String(prepared.prepared_by ?? '')].join('\n')).slice(0, 12)
        prepared.quote_draft_id = draftId
        const staged = host.stage('quote-drafts', prepared, { name: `${draftId}.json` })
        if (!staged.ok) { failures.push({ item_id: itemId, ...staged }); continue }
        const run = host.runPython('src/domain/quote-prepare/tools/quote-draft.py',
          ['--inbox', `${host.sharedDir}/quote-drafts`, '--ui-shared', host.sharedDir, '--view', 'supplier',
            '--ledger-supplier', supplierLedger(), '--ledger-contractor', contractorLedger(),
            '--now', host.now()])
        const json = run.json ?? {}
        const appliedRow = (json.applied ?? [])[0] ?? {}
        applied.push({ item_id: itemId, quote_draft_id: draftId,
          pending: staged.file, ledger_added: json.ledger_added ?? 0,
          event: appliedRow.event ?? (run.ok ? 'quote/drafted' : null), ok: run.ok && json.ok === true,
          refusal: json.refusal ?? null, writer_stdout: run.stdout ? run.stdout.slice(-240) : '' })
      }
      const okAll = applied.length > 0 && applied.every((row) => row.ok) && failures.length === 0
      return { ok: okAll, code: okAll ? 'drafted' : (failures.length ? 'partial-failure' : 'writer-refused'),
        reason: failures.length ? failures.map((item) => `${item.item_id}: ${item.reason}`).join('；') : '',
        next_action: okAll
          ? '草稿已落账（quote/drafted，两侧各一条）：在「我的草稿」里点「人签提交」把它签成真报价'
          : '看 failures 里每条的 next_action；被拒时账本零新增',
        result: { applied, failures, drafts: applied.filter((row) => row.ok).length } }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'quote.submit', title: '人签提交报价', views: ['supplier'],
    group: '报价', order: 20, permission: 'human-signature',
    confirm: { required: true, message: '提交报价是**对外承诺**：确认以你的署名提交？' },
    hint: '人工门：署名会写进批准记录；落账本的是唯一写者 tools/quote-sign.py（界面不代签、不写账本）',
    input: { fields: [
      { name: 'draft_id', label: '草稿 id', type: 'text', required: true,
        pattern: '^qd-[A-Za-z0-9-]+-[0-9a-f]{12}$', help: '从「我的草稿」一列复制（qd-supplier-…）' },
      { name: 'signature', label: '署名（人签）', type: 'signature', required: true, help: 'human:<你的名字>' },
      { name: 'comment', label: '批注（进批准记录，不进报价正文）', type: 'text' },
      { name: 'timeout_policy', label: '超时策略', type: 'select', options: ['remind', 'escalate', 'abort'],
        default: 'remind' },
    ] },
    server: async (ctx, input) => {
      const run = host.runPython('src/domain/quote-prepare/tools/quote-sign.py',
        ['--ui-shared', host.sharedDir, '--draft-id', asText(input.draft_id),
          '--actor', asText(input.signature), '--now', host.now(),
          '--comment', String(input.comment ?? ''), '--timeout-policy', asText(input.timeout_policy) || 'remind',
          '--ledger-supplier', supplierLedger(), '--ledger-contractor', contractorLedger()])
      const json = run.json ?? {}
      return { ok: run.ok && json.ok === true, code: json.refusal?.code ?? (run.ok ? 'submitted' : 'writer-failed'),
        reason: json.refusal?.reason ?? run.reason ?? '',
        next_action: json.refusal?.next_action ?? (run.ok
          ? '已提交：本侧账本多了 approval/requested、approval/granted、quote/submitted 三条；'
            + '承包商账本多了「供应商已提交报价」一条（下面两个面板都能回读）'
          : '看 stdout/stderr 定位唯一写者的拒绝原因（拒绝时账本零新增）'),
        result: { quote_id: json.quote_id ?? null, approval_id: json.approval_id ?? null,
          applied: json.applied ?? [], ledger_added: json.ledger_added ?? 0,
          duplicates: json.duplicates ?? [], supplier: json.supplier ?? null,
          contractor: json.contractor ?? null, writer: json } }
    } }))

  out.push(surface.shortcut({ plugin_id: me, id: 'shortcut.quote-draft', keys: 'd', action: 'quote.draft',
    title: '备报价草稿', order: 20 }))

  out.push(surface.statusItem({ plugin_id: me, id: 'status.quote', title: '报价', order: 20, read: () => {
    const rows = host.rows('supplier')
    const drafts = new Set(typeRows(rows, 'quote/drafted').map((row) => asText(bodyOf(row).quote_draft_id)))
    const submitted = typeRows(rows, 'quote/submitted').length
    return { text: `${drafts.size} 份草稿 · ${submitted} 条已提交`, level: submitted ? 'ok' : 'warn',
      next_action: submitted ? '' : '草稿要人签提交才算对外报价' }
  } }))

  out.push(surface.notificationSource({ plugin_id: me, id: 'notify.quote', title: '报价待办', order: 20,
    poll: () => {
      const rows = host.rows('supplier')
      const drafts = new Map()
      for (const row of typeRows(rows, 'quote/drafted')) {
        const body = bodyOf(row)
        const id = asText(body.quote_draft_id) || asText(row?.correlation_id)
        if (id) drafts.set(id, body)
      }
      const signed = new Set(typeRows(rows, 'quote/submitted').map((row) => asText(bodyOf(row).quote_draft_id)))
      const items = []
      for (const [id, body] of drafts) {
        if (signed.has(id)) continue
        items.push({ id: `q:pending:${id}`, level: 'warn', at: String(body.submitted_at ?? ''),
          title: `草稿待签署：${id}`, body: `行项目 ${body.item_id ?? '—'} · 单价 ${body.unit_price_cents ?? '—'} 分`,
          next_action: '人签到「人签提交报价」（human:<你的名字>）' })
      }
      return items
    } }))

  // ---- 工作台（首屏「我今天要做什么」）：只有"我现在该做什么"与一键入口，不是报告列表 -----------------
  out.push(surface.panel({ plugin_id: me, id: 'home.quote-todo', title: '供应商侧：我今天要做什么',
    view: 'home', order: 10, kind: 'list',
    data: () => {
      const rows = host.rows('supplier')
      const drafts = new Map()
      for (const row of typeRows(rows, 'quote/drafted')) {
        const body = bodyOf(row)
        const id = asText(body.quote_draft_id) || asText(row?.correlation_id)
        if (id) drafts.set(id, body)
      }
      const signed = new Set(typeRows(rows, 'quote/submitted').map((row) => asText(bodyOf(row).quote_draft_id)))
      const pending = [...drafts.entries()].filter(([id]) => !signed.has(id))
      const mine = myPackage(host, realmOf('supplier'))
      const items = []
      items.push({ level: pending.length ? 'warn' : 'info',
        title: pending.length ? `${pending.length} 份草稿待你人签提交` : '没有待签署的草稿',
        body: '提交报价是对外承诺：要人签（human:<你的名字>）',
        next_action: pending.length ? `深链 ${host.prefix}/app/supplier/` : '先在供应商道「发给我的 RFQ 包」里备草稿' })
      items.push({ level: mine.ok ? 'info' : 'warn',
        title: mine.ok ? `发给我的包：${(mine.envelope.spec?.items ?? []).length} 条行项目（rev${mine.envelope.rev}）`
          : '还没有发给我的 RFQ 包',
        body: mine.ok ? `报价截止 ${(mine.envelope.spec?.deadlines ?? {}).quote_by ?? '—'}` : mine.reason,
        next_action: mine.ok ? '去填单价与交期 → 备草稿' : (mine.next_action ?? '') })
      return { ok: true, kind: 'list', items }
    } }))

  // 字段与校验规则的只读自述（让人在界面上能看到规则，而不是靠猜）
  out.push(surface.panel({ plugin_id: me, id: 'quote.rules', title: '草稿字段与校验规则（自述）',
    view: 'supplier', order: 40, kind: 'kv', placement: 'side',
    data: () => ({ ok: true, kind: 'kv', items: FIELDS.map((field) => ({ key: `${field.label}${field.required ? ' *' : ''}`,
      value: field.rule })).concat([{ key: '金额单位', value: `整数分（unit=${prepare({}, { views: ['supplier'] }).limits?.money_unit ?? 'cents'}）`, code: true },
      { key: '数值范围', value: `单价 ${LIMITS.unit_price_cents_min}..${LIMITS.unit_price_cents_max} 分；`
        + `交期 ${LIMITS.lead_time_days_min}..${LIMITS.lead_time_days_max} 天；备注 ≤ ${LIMITS.note_bytes_max} 字节` }]) }) }))

  return out
}
