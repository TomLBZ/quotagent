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

/** 与唯一写者 `tools/quote-draft.py` 的 `canonical_lines()` **逐字节一致**的行项目规范化 JSON。
 *
 * 两种形态（与写者同一口径）：**单行**（无 `lines`）5 键；**多行**（`lines` 非空）`{currency, lines[], rfq_id}`。
 * 键序必须是**排序后**的顺序（写者用 `json.dumps(sort_keys=True)`；`JSON.stringify` 只保留插入顺序）。
 */
const canonicalLines = (record) => {
  const rows = Array.isArray(record.lines) && record.lines.length ? record.lines : null
  if (rows) {
    // **键序 = 字典序**（`currency` < `lines` < `rfq_id`；行内 `item_id` < `lead_time_days` <
    // `unit_price_cents`）：写者用 `json.dumps(sort_keys=True)`，而 `JSON.stringify` **只保留插入顺序** ——
    // 顺序写错就会算出另一个哈希（实测：写成 currency/rfq_id/lines 会被唯一写者按 `pending-tampered` 拒）。
    return JSON.stringify({ currency: String(record.currency ?? ''),
      lines: rows.map((line) => ({ item_id: String(line.item_id ?? ''), lead_time_days: line.lead_time_days,
        unit_price_cents: line.unit_price_cents })),
      rfq_id: String(record.rfq_id ?? '') })
  }
  return JSON.stringify({ currency: String(record.currency ?? ''), item_id: String(record.item_id ?? ''),
    lead_time_days: record.lead_time_days, rfq_id: String(record.rfq_id ?? ''),
    unit_price_cents: record.unit_price_cents })
}
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
          { key: 'item_id', label: '行项目', type: 'code', pin: 'left' },
          { key: 'description', label: '描述' },
          { key: 'qty', label: '数量' },
          { key: 'unit', label: '单位' },
          { key: 'unit_price_cents', label: '单价（整数分，可直接改）', editable: true, type: 'number',
            line_total_of: 'qty', help: '8600 = 86.00 元' },
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
        // 实时小计（外壳在编辑时立刻重算：Σ 单价×数量）；Tab/Enter 走格、Esc 还原、Ctrl+Enter 提交
        totals: [{ label: '报价小计（整数分）', key: 'unit_price_cents', factor: 'qty', unit: '分' },
          { label: '已填条数', key: 'unit_price_cents', count: true, skip_empty: true }],
        editable_action: 'quote.draft',
        editable_defaults: { rfq_id: String(spec.package_id ?? ''), currency: String(spec.currency ?? 'CNY'),
          prepared_by: '' },
        bulk: 'quote.draft',
        ref: spec.package_id ? { kind: 'package', id: String(spec.package_id),
          title: `包 ${spec.package_id} rev${envelope.rev ?? '—'}` } : null,
        counts: { items: items.length, rev: envelope.rev },
        note: `包 ${spec.package_id ?? '—'} rev${envelope.rev ?? '—'} · 报价截止 ${(spec.deadlines ?? {}).quote_by ?? '—'}`
          + ` · 报价一律**整数分**（8600 = 86.00）；改单价时右边实时算"×量 = 行合计"，底部编辑栏给小计`
          + ` · 键盘：Tab 走格 / Enter 走同列下一行 / Esc 还原 / Ctrl+Enter 提交 —— 备多行报价不用鼠标`
          + ` · **表里填几行就交几行**：一次「备这份草稿」= 一条草稿（多行），随后**一次人签**提交整份`
          + ` · 标题旁的「打开对象 →」是这个包的深链（可复制分享、刷新不丢）` }
    } }))

  // ---- **对象页**：`/app/supplier/package/<pkg-id>/`（我收到的那个包：条目 + 我的草稿进度） ----
  out.push(surface.panel({ plugin_id: me, id: 'package.mine', title: '我收到的包（对象页）', view: 'supplier',
    order: 11, kind: 'table', object_kind: 'package',
    data: (ctx) => {
      const wanted = asText(ctx.route?.id)
      const realm = realmOf('supplier')
      const mine = myPackage(host, realm)
      const spec = mine.ok ? (mine.envelope.spec ?? {}) : {}
      const packageId = String(spec.package_id ?? '')
      if (!mine.ok || (wanted && packageId !== wanted)) {
        return { ok: true, kind: 'table', object: { found: false, title: `包 ${wanted}`,
          reason: mine.ok ? 'package-not-addressed-to-me' : mine.code,
          next_action: mine.ok
            ? `这份包不是发给 ${realm || '本侧'} 的（投递名单：${((mine.envelope.delivered_to ?? [])).join(' ') || '—'}）：`
              + '只出自己的那份，回供应商道首页看「发给我的 RFQ 包」'
            : (mine.next_action ?? '') },
          columns: [{ key: 'item_id', label: '行项目' }], rows: [] }
      }
      const items = Array.isArray(spec.items) ? spec.items : []
      const drafts = new Map(typeRows(host.rows('supplier'), 'quote/drafted')
        .map((row) => [asText(bodyOf(row).item_id), bodyOf(row)]))
      return { ok: true, kind: 'table',
        object: { title: `包 ${packageId} rev${mine.envelope.rev ?? '—'}`, found: true,
          subtitle: `发给 ${((mine.envelope.delivered_to ?? []).map(String).join(' ') || realm || '本侧')}`
            + ` · 报价截止 ${(spec.deadlines ?? {}).quote_by ?? '—'}`,
          facts: [
            { key: '条目数', value: String(items.length) },
            { key: '版本 rev', value: String(mine.envelope.rev ?? '—') },
            { key: '澄清截止', value: String((spec.deadlines ?? {}).clarify_by ?? '—') },
            { key: '已备草稿', value: `${drafts.size} / ${items.length}` },
          ], links: [] },
        columns: [
          { key: 'item_id', label: '行项目', type: 'code', pin: 'left' }, { key: 'description', label: '描述' },
          { key: 'qty', label: '数量' }, { key: 'unit', label: '单位' },
          { key: 'unit_price_cents', label: '单价（整数分，可直接改）', editable: true, type: 'number',
            line_total_of: 'qty', help: '8600 = 86.00 元' },
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
        totals: [{ label: '报价小计（整数分）', key: 'unit_price_cents', factor: 'qty', unit: '分' },
          { label: '已填条数', key: 'unit_price_cents', count: true, skip_empty: true }],
        editable_action: 'quote.draft',
        editable_defaults: { rfq_id: packageId, currency: String(spec.currency ?? 'CNY'),
          prepared_by: '' },
        bulk: 'quote.draft',
        counts: { items: items.length, rev: mine.envelope.rev },
        note: '这一页是那个包的**对象地址**（刷新不丢、可复制）：改单价/交期 → 「备这份草稿」→ 再去「我的草稿」人签提交' }
    } }))

  out.push(surface.panel({ plugin_id: me, id: 'quote.object', title: '报价逐行明细（承包商收到的）',
    view: 'contractor', order: 36, kind: 'table', object_kind: 'quote',
    data: (ctx) => {
      const wanted = asText(ctx.route?.id)
      const { json } = inboxOf()
      const bagOf = (json.packages ?? []).find((bag) => (bag.quotes ?? [])
        .some((quote) => asText(quote.quote_id) === wanted))
      const quote = bagOf ? (bagOf.quotes ?? []).find((row) => asText(row.quote_id) === wanted) : null
      if (!quote) {
        return { ok: true, kind: 'table', object: { found: false, title: `报价 ${wanted}`,
          reason: json.ok ? 'quote-not-in-my-view' : (json.reason ?? json.refusal?.code ?? 'inbox-failed'),
          next_action: json.ok
            ? '这份报价不在承包商侧收件箱里：回「报价收件箱」（承包商道）点行内「打开 →」用真实存在的深链'
            : (json.next_action ?? json.refusal?.next_action ?? '看只读工具的输出') },
          columns: [{ key: 'item_id', label: '行项目' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        object: { title: `报价 ${asText(quote.quote_id)}`, found: true,
          subtitle: `供应商 ${asText(quote.supplier)} · 包 ${asText(bagOf.package_id)} rev${bagOf.rev ?? '—'}`
            + ` · ${asText(quote.vs_current_rev)}`,
          facts: [
            { key: '行合计（整数分）', value: String(quote.total_cents ?? '') },
            { key: '提交时刻', value: String(quote.submitted_at ?? '') },
            { key: '受理状态', value: String(quote.review_status ?? '') },
            { key: '签署人（人签）', value: String(quote.approved_by ?? '—') },
            { key: '人工门', value: String(quote.approval_id ?? '—'), code: true },
          ],
          links: [
            { kind: 'package', id: asText(bagOf.package_id), title: `包 ${asText(bagOf.package_id)}` },
          ].filter((link) => link.id !== '') },
        columns: [{ key: 'item_id', label: '行项目', type: 'code' }, { key: 'qty', label: '量' },
          { key: 'unit_price_cents', label: '单价（整数分）' }, { key: 'lead_time_days', label: '交期（天）' }],
        rows: (quote.items ?? []).map((line) => ({ id: String(line.item_id), item_id: line.item_id,
          qty: line.qty, unit_price_cents: line.unit_price_cents, lead_time_days: line.lead_time_days })),
        counts: { lines: (quote.items ?? []).length },
        note: '受理 / 退回 / 要求补件是人工门：本页工具栏上的那个动作直接对**这份**报价发起（id 已按地址预填，'
          + '不必手抄）；逐行单价与量的对账口径见「报价收件箱」面板的备注' }
    } }))

  out.push(surface.panel({ plugin_id: me, id: 'quote.drafts', title: '我的草稿（待签署）', view: 'supplier',
    order: 20, kind: 'table', actions: ['quote.submit'],
    data: () => {
      const drafts = new Map()
      for (const row of typeRows(host.rows('supplier'), 'quote/drafted')) {
        const body = bodyOf(row)
        const id = asText(body.quote_draft_id) || asText(row?.correlation_id)
        if (!id) continue
        const lines = Array.isArray(body.lines) ? body.lines : []
        drafts.set(id, { id, quote_draft_id: id, draft_id: id, rfq_id: body.rfq_id ?? body.package_id ?? '',
          item_id: body.item_id ?? '', unit_price_cents: body.unit_price_cents ?? '',
          lead_time_days: body.lead_time_days ?? '', prepared_by: body.prepared_by ?? '',
          line_count: lines.length || 1,
          lines_text: lines.length > 1 ? lines.map((line) => `${line.item_id}@${line.unit_price_cents}分`).join(' ')
            : '', ts: row.ts ?? '' })
      }
      const submitted = new Set(typeRows(host.rows('supplier'), 'quote/submitted')
        .map((row) => asText(bodyOf(row).quote_draft_id)))
      const rows = [...drafts.values()].map((draft) => ({ ...draft,
        status: submitted.has(draft.quote_draft_id) ? '已签署提交' : '待签署' }))
      if (!rows.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-drafts',
          next_action: '在上面的「发给我的 RFQ 包」里填单价与交期，然后「备这份草稿」（整张表一次提交）',
          columns: [{ key: 'quote_draft_id', label: '草稿' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        columns: [{ key: 'quote_draft_id', label: '草稿', type: 'code' }, { key: 'rfq_id', label: '包', type: 'code' },
          { key: 'line_count', label: '行数' }, { key: 'item_id', label: '首行项目', type: 'code' },
          { key: 'lines_text', label: '逐行（条目@单价分）' },
          { key: 'unit_price_cents', label: '首行单价（整数分）' },
          { key: 'lead_time_days', label: '首行交期（天）' }, { key: 'status', label: '状态' }],
        rows, row_actions: ['quote.submit'], counts: { drafts: rows.length },
        note: '草稿**不是报价**：只有人签提交（quote/submit）之后才算对外报价（AGENTS.md 规则 3）；'
          + '**一份草稿 = 一整张表**（行数 > 1 的草稿签一次就提交全部行）' }
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
          { key: 'line_count', label: '行数' }, { key: 'item_id', label: '首行项目', type: 'code' },
          { key: 'lines_text', label: '逐行（条目@单价分）' },
          { key: 'unit_price_cents', label: '首行单价（整数分）' },
          { key: 'lead_time_days', label: '首行交期（天）' }, { key: 'approved_by', label: '签署人', type: 'code' },
          { key: 'approval_id', label: '人工门', type: 'code' }, { key: 'submitted_at', label: '提交时刻' }],
        rows: rows.map((row) => {
          const lines = Array.isArray(row.lines) ? row.lines : []
          return { id: row.quote_id, ...row, line_count: lines.length || 1,
            item_id: asText(row.item_id) || asText(lines[0]?.item_id),
            lines_text: lines.length > 1 ? lines.map((line) => `${line.item_id}@${line.unit_price_cents}分`).join(' ')
              : '',
            ref: { kind: 'quote', id: asText(row.quote_id), title: `报价 ${asText(row.quote_id)}` } }
        }),
        counts: { quotes: rows.length },
        note: '每一行都对应一次人签的人工门（approval/requested → granted → quote/submitted，顺序不可颠倒）；'
          + '**一份报价 = 一次人签**：行数 > 1 的报价是一次签完整份的（逐行在 `lines` 里，标量列只是首行）' }
    } }))

  // ---- **对象页**：`/app/supplier/quote/<q-…>/`（我提交的那份报价的全链事实） ----
  out.push(surface.panel({ plugin_id: me, id: 'quote.mine', title: '我的报价（对象页：提交与批准记录）',
    view: 'supplier', order: 31, kind: 'kv', object_kind: 'quote',
    data: (ctx) => {
      const wanted = asText(ctx.route?.id)
      const rows = typeRows(host.rows('supplier'), 'quote/submitted').map((row) => bodyOf(row))
      const quote = rows.find((row) => asText(row.quote_id) === wanted)
      if (!quote) {
        return { ok: true, kind: 'kv', object: { found: false, title: `报价 ${wanted}`,
          reason: 'quote-not-in-my-view',
          next_action: '这份报价不在供应商侧账本里：回「已提交的报价」面板，点行内「打开 →」用真实存在的深链' },
          items: [] }
      }
      const gates = typeRows(host.rows('supplier'), 'approval/').map((row) => bodyOf(row))
        .filter((row) => asText(row.ref) === wanted)
      return { ok: true, kind: 'kv',
        object: { title: `报价 ${asText(quote.quote_id)}`, found: true,
          subtitle: `包 ${asText(quote.package_id)} · rev${asText(quote.rfq_rev) || '—'}`
            + ` · ${asText(quote.currency)}`,
          facts: [
            { key: '行数', value: String((quote.lines ?? []).length) },
            { key: '签署人（人签）', value: asText(quote.approved_by), code: true },
            { key: '人工门', value: asText(quote.approval_id), code: true },
            { key: '提交时刻', value: asText(quote.submitted_at) },
          ],
          links: [{ kind: 'package', id: asText(quote.package_id),
            title: `包 ${asText(quote.package_id)}` }].filter((link) => link.id !== '') },
        items: [
          { key: '逐行', value: (quote.lines ?? []).map((line) => `${line.item_id}: `
            + `${line.unit_price_cents} 分 / ${line.lead_time_days} 天`).join('；') || '（没有行明细）' },
          { key: '人工门记录', value: gates.map((gate) => `${gate.status ?? ''} ${gate.decided_by ?? ''}`
            + ` ${gate.comment ?? ''}`.trim()).join(' | ') || '（没有批准记录）' },
          { key: '对账口径', value: '金额一律整数分；这一页只读，改报要按新版重填（人签提交）' },
        ],
        note: '这一页是那份报价的**对象地址**：刷新不丢、可复制；对外承诺类动作只有人签提交那一步'
          + `（提交入口在「我的草稿」面板）。` }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'quote.draft', title: '备报价草稿（整张表一次提交）', views: ['supplier'],
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
        { name: 'prepared_by', label: '发言人', type: 'text', required: true, identity: true,
          help: 'human:<你的名字>（登录后会按会话身份自动填）' },
        { name: 'note', label: '备注（可选）', type: 'textarea' },
      ] },
    hint: '**一份草稿 = 一整张表**：表里填几行就交几行，落**一条**草稿（`lines`）；'
      + '草稿是**非签名动作**（不产生对外义务），随后「人签提交」一次签完整份',
    server: async (ctx, input) => {
      const rows = Array.isArray(input.rows) && input.rows.length ? input.rows : [input]
      const payload = payloadOf(host, 'supplier')
      const rows0 = (host.rows('supplier') ?? []).find((row) => asText(row?.realm) !== '') ?? null
      const preparedBy = asText(input.prepared_by)
      if (!preparedBy.startsWith('human:')) {
        return { ok: false, code: 'human-required', reason: '草稿也要有人认领：prepared_by 必须以 human: 开头',
          next_action: '写 human:<你的名字>' }
      }
      // ① 逐行字段校验（沿用插件自己的字段级规则与拒绝码；行号进 `field` 让人知道是哪一行错）
      const lines = []
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
            reason: (verdict.errors ?? []).map((item) => `第 ${lines.length + failures.length + 1} 行 ${item.field}:`
              + `${item.message}`).join('；'),
            next_action: verdict.errors?.[0]?.next_action ?? '按字段错误改后重提' })
          continue
        }
        lines.push({ item_id: asText(verdict.record.item_id), unit_price_cents: verdict.record.unit_price_cents,
          lead_time_days: verdict.record.lead_time_days })
      }
      // ② 结构门：重复行项目会让「这份报价总共多少」没有唯一答案 ⇒ 明确拒（不悄悄去重）
      const seen = new Set()
      for (const line of lines) {
        if (seen.has(line.item_id)) {
          failures.push({ item_id: line.item_id, code: 'line-duplicate',
            reason: `行项目 ${line.item_id} 在表里出现了两次`,
            next_action: '同一个行项目只留一行（重复会让总价没有唯一答案）' })
        }
        seen.add(line.item_id)
      }
      if (failures.length || !lines.length) {
        return { ok: false, code: failures.length ? 'validation-failed' : 'no-lines',
          reason: failures.map((item) => `${item.item_id}: ${item.reason}`).join('；')
            || '表里没有可提交的行（一行都没有 ⇒ 不落任何草稿）',
          next_action: '按每条的 next_action 改后重提（本次**什么都没落盘**）',
          result: { applied: [], failures, drafts: 0, lines: 0 } }
      }
      // ③ **一整张表 → 一条草稿**：多行带 `lines`（标量三键写第一行，供既有读者兜底），单行沿用旧形状
      const supplierRealm = asText(rows0?.realm) || 'supplier:gui'
      const first = lines[0]
      const prepared = { schema: 1, kind: 'quote-draft', view: 'supplier', requested_action: 'draft',
        rfq_id: asText(input.rfq_id), item_id: first.item_id, unit_price_cents: first.unit_price_cents,
        lead_time_days: first.lead_time_days, currency: asText(input.currency) || 'CNY',
        prepared_by: preparedBy, note: String(input.note ?? ''), supplier: supplierRealm, submitted_at: '' }
      if (lines.length > 1) prepared.lines = lines
      // 草稿 id / 行哈希 / 备注哈希：与宿主既有那条路由（`webui.mjs` 的 `submitDraft`）**同一算法**，
      // 唯一写者 `tools/quote-draft.py` 会对它们逐字节重算复核（对不上就拒、账本零新增）。
      prepared.note_sha256 = sha256(prepared.note ?? '')
      prepared.lines_sha256 = sha256(canonicalLines(prepared))
      prepared.bytes = Buffer.byteLength(String(prepared.note ?? ''), 'utf8')
      const draftId = `qd-supplier-` + sha256([prepared.view, supplierRealm, canonicalLines(prepared),
        String(prepared.note ?? ''), String(prepared.prepared_by ?? '')].join('\n')).slice(0, 12)
      prepared.quote_draft_id = draftId
      const staged = host.stage('quote-drafts', prepared, { name: `${draftId}.json` })
      if (!staged.ok) {
        return { ok: false, code: staged.code ?? 'pending-write-failed', reason: staged.reason ?? '',
          next_action: staged.next_action ?? '先修待办件目录权限（宿主只落 0600 待办件）',
          result: { applied: [], failures: [], drafts: 0, lines: 0 } }
      }
      const run = host.runPython('src/domain/quote-prepare/tools/quote-draft.py',
        ['--inbox', `${host.sharedDir}/quote-drafts`, '--ui-shared', host.sharedDir, '--view', 'supplier',
          '--ledger-supplier', supplierLedger(), '--ledger-contractor', contractorLedger(),
          '--now', host.now()])
      const json = run.json ?? {}
      const appliedRow = (json.applied ?? [])[0] ?? {}
      const ok = run.ok && json.ok === true && Number(appliedRow.line_count ?? 0) === lines.length
      const refused = (json.refused ?? [])[0] ?? null
      return { ok, code: ok ? 'drafted' : (refused?.code ?? 'writer-refused'),
        reason: refused?.reason ?? (ok ? '' : (run.reason ?? '')),
        next_action: ok
          ? `草稿已落账（quote/drafted，**${lines.length} 行**，两侧各一条）：在「我的草稿」里点「人签提交」`
            + '一次签完整份（不必一行签一次）'
          : (refused?.next_action ?? '看 files/failures 里每条的 next_action；被拒时账本零新增'),
        result: { applied: [{ item_id: first.item_id, quote_draft_id: draftId, line_count: lines.length,
          lines, pending: staged.file, ledger_added: json.ledger_added ?? 0,
          event: appliedRow.event ?? (run.ok ? 'quote/drafted' : null), ok,
          refusal: refused, writer_stdout: run.stdout ? run.stdout.slice(-240) : '' }],
        failures, drafts: ok ? 1 : 0, lines: lines.length } }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'quote.submit', title: '人签提交报价', views: ['supplier'],
    group: '报价', order: 20, permission: 'human-signature',
    confirm: { required: true, message: '提交报价是**对外承诺**：确认以你的署名提交？' },
    hint: '人工门：**一份草稿签一次**就提交整份（草稿里有几行就提交几行，不必一行签一次）；'
      + '服务端会校验**署名 == 会话身份**，不一致一律拒（`signer-mismatch`，账本零新增）；'
      + '落账本的是唯一写者 tools/quote-sign.py（界面不代签、不写账本）',
    input: { fields: [
      { name: 'draft_id', label: '草稿 id', type: 'text', required: true,
        pattern: '^qd-[A-Za-z0-9-]+-[0-9a-f]{12}$', help: '从「我的草稿」一列复制（qd-supplier-…）' },
      { name: 'signature', label: '署名（人签）', type: 'signature', required: true, help: 'human:<你的名字>' },
      { name: 'comment', label: '批注（进批准记录，不进报价正文）', type: 'text' },
      { name: 'timeout_policy', label: '超时策略', type: 'select', options: ['remind', 'escalate', 'abort'],
        default: 'remind' },
    ] },
    server: async (ctx, input) => {
      // 服务端一半**再核一遍**署名 == 会话身份（机制层已在动作总线上拦一次；这里在插件侧留痕，
      // 免得有人绕过外壳直接调这个服务端一半时少一道门）。
      const session = ctx.session && typeof ctx.session === 'object' ? ctx.session : null
      const typed = asText(input.signature)
      if (session && session.human && typed !== session.human) {
        return { ok: false, code: 'signer-mismatch',
          reason: `署名 ${typed} 与会话身份 ${session.human} 不一致`,
          next_action: `人签只能本人签：用 ${session.human} 署名，或切换到该身份的会话（账本零新增）` }
      }
      const run = host.runPython('src/domain/quote-prepare/tools/quote-sign.py',
        ['--ui-shared', host.sharedDir, '--draft-id', asText(input.draft_id),
          '--actor', typed, '--now', host.now(),
          '--comment', String(input.comment ?? ''), '--timeout-policy', asText(input.timeout_policy) || 'remind',
          '--ledger-supplier', supplierLedger(), '--ledger-contractor', contractorLedger()])
      const json = run.json ?? {}
      const applied = json.applied ?? []
      const lines = Number((applied[0] ?? {}).line_count ?? 0)
      return { ok: run.ok && json.ok === true, code: json.refusal?.code ?? (run.ok ? 'submitted' : 'writer-failed'),
        reason: json.refusal?.reason ?? run.reason ?? '',
        next_action: json.refusal?.next_action ?? (run.ok
          ? `已提交：本侧账本多了 approval/requested、approval/granted、quote/submitted 三条`
            + `${lines > 1 ? `（这一份报价 **${lines} 行**，一次签完）` : ''}；`
            + '承包商账本多了「供应商已提交报价」一条（下面两个面板都能回读）'
          : '看 stdout/stderr 定位唯一写者的拒绝原因（拒绝时账本零新增）'),
        result: { quote_id: json.quote_id ?? null, approval_id: json.approval_id ?? null,
          applied, ledger_added: json.ledger_added ?? 0,
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
        const lines = Array.isArray(body.lines) ? body.lines : []
        items.push({ id: `q:pending:${id}`, level: 'warn', at: String(body.submitted_at ?? ''),
          title: `草稿待签署：${id}${lines.length > 1 ? `（${lines.length} 行）` : ''}`,
          body: lines.length > 1
            ? `${lines.length} 行：` + lines.slice(0, 3).map((line) => `${line.item_id}@${line.unit_price_cents}分`)
              .join(' / ') + (lines.length > 3 ? ' …' : '')
            : `行项目 ${body.item_id ?? '—'} · 单价 ${body.unit_price_cents ?? '—'} 分`,
          next_action: lines.length > 1
            ? `人签提交报价（**一次签完整份 ${lines.length} 行**；署名 = 你的会话身份）`
            : '人签提交报价（署名 = 你的会话身份）',
          action: 'quote.submit', preset: { draft_id: id },
          ref: asText(body.rfq_id) === '' ? null : { view: 'supplier', kind: 'package',
            id: asText(body.rfq_id), title: `包 ${asText(body.rfq_id)}` } })
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
        body: '提交报价是对外承诺：要人签（human:<你的名字>）；**一份草稿签一次就提交整份**',
        action: pending.length ? 'quote.submit' : 'quote.draft',
        label: pending.length ? '人签提交报价' : '备一份草稿',
        next_action: pending.length ? '点按钮直接开签名弹层（一次签完整份）；也可以在「我的草稿」里逐条签'
          : '先把表里的单价与交期填完，再「备这份草稿」（整张表一次提交）' })
      items.push({ level: mine.ok ? 'info' : 'warn',
        title: mine.ok ? `发给我的包：${(mine.envelope.spec?.items ?? []).length} 条行项目（rev${mine.envelope.rev}）`
          : '还没有发给我的 RFQ 包',
        body: mine.ok ? `报价截止 ${(mine.envelope.spec?.deadlines ?? {}).quote_by ?? '—'}` : mine.reason,
        action: mine.ok ? 'quote.draft' : '', label: '备这份草稿',
        next_action: mine.ok ? '去填单价与交期 → 备草稿' : (mine.next_action ?? ''),
        ref: mine.ok ? { kind: 'package', id: String(mine.envelope.spec?.package_id ?? '') } : null })
      return { ok: true, kind: 'list', items }
    } }))

  // 字段与校验规则的只读自述（让人在界面上能看到规则，而不是靠猜）
  out.push(surface.panel({ plugin_id: me, id: 'quote.rules', title: '草稿字段与校验规则（自述）',
    view: 'supplier', order: 40, kind: 'kv', placement: 'side',
    data: () => {
      // 金额单位：`prepare()` 在没有事实可读时会抛错 —— 自述面板不该因此整块变红（如实降级成 'cents'）
      let moneyUnit = 'cents'
      try {
        moneyUnit = prepare({}, { views: ['supplier'] }).limits?.money_unit ?? 'cents'
      } catch (err) {
        moneyUnit = `cents（兜底：prepare() 抛 ${String(err).slice(0, 40)}）`
      }
      return { ok: true, kind: 'kv', items: FIELDS.map((field) => ({ key: `${field.label}${field.required ? ' *' : ''}`,
        value: field.rule })).concat([{ key: '金额单位', value: `整数分（unit=${moneyUnit}）`, code: true },
        { key: '数值范围', value: `单价 ${LIMITS.unit_price_cents_min}..${LIMITS.unit_price_cents_max} 分；`
          + `交期 ${LIMITS.lead_time_days_min}..${LIMITS.lead_time_days_max} 天；备注 ≤ ${LIMITS.note_bytes_max} 字节` }]) }
    } }))

  // ------------------------------------------------------------------ 承包商侧：报价收件箱 + 受理（DEF-011）
  const inboxTool = 'src/domain/quote-prepare/tools/quote-inbox.py'
  const reviewTool = 'src/domain/quote-prepare/tools/quote-review.py'
  const reviewsFile = () => `${host.sharedDir}/exchange/quote-reviews.json`
  const inboxOf = () => {
    // `{read:true}`：quote-inbox.py 是只读收件箱（写者在别处）⇒ 同一批参数在一次渲染里只 spawn 一次
    // （收件箱面板、待受理通知源、状态栏三处读的是同一份结果）。
    const run = host.runPython(inboxTool, ['--ui-shared', host.sharedDir,
      '--ledger-contractor', contractorLedger()], { read: true })
    return { run, json: run.json ?? {} }
  }
  const reviewNotices = () => {
    const data = host.readJson(reviewsFile())
    const items = data && Array.isArray(data.reviews) ? data.reviews : []
    return items
  }

  out.push(surface.panel({ plugin_id: me, id: 'quotes.inbox', title: '报价收件箱（按包分组 · 可受理 · 可退回 · 可要补件）',
    view: 'contractor', order: 35, kind: 'table', actions: ['quote.review'],
    data: () => {
      const { json, run } = inboxOf()
      if (!json.ok || json.degraded) {
        return { ok: true, kind: 'table', degraded: true, reason: json.reason ?? json.refusal?.code ?? 'inbox-failed',
          next_action: json.next_action ?? json.refusal?.next_action ?? (run.reason || '看只读工具的输出'),
          columns: [{ key: 'quote_id', label: '报价' }], rows: [] }
      }
      const rows = []
      for (const bag of json.packages ?? []) {
        for (const quote of bag.quotes ?? []) {
          rows.push({ id: quote.quote_id, quote_id: quote.quote_id, package_id: bag.package_id, rev: bag.rev,
            supplier: quote.supplier, currency: quote.currency,
            items: (quote.items ?? []).map((line) => `${line.item_id}×${line.qty ?? '?'}@${line.unit_price_cents}分`).join(' '),
            total_cents: quote.total_cents, vs_current_rev: quote.vs_current_rev,
            submitted_at: quote.submitted_at, review_status: quote.review_status,
            reviewed_by: quote.reviewed_by ?? '', review_comment: quote.review_comment ?? '',
            approved_by: quote.approved_by ?? '', lead_time: (quote.items ?? []).map((line) => line.lead_time_days).join('/'),
            ref: { kind: 'quote', id: asText(quote.quote_id), title: `报价 ${asText(quote.quote_id)}` } })
        }
      }
      return { ok: true, kind: 'table',
        columns: [
          { key: 'quote_id', label: '报价', type: 'code', pin: 'left' },
          { key: 'package_id', label: '包', type: 'code' },
          { key: 'rev', label: 'rev' },
          { key: 'supplier', label: '供应商', type: 'code' },
          { key: 'items', label: '行级明细（条目×量@单价分）' },
          { key: 'total_cents', label: '行合计（整数分）' },
          { key: 'lead_time', label: '交期（天）' },
          { key: 'submitted_at', label: '提交时刻' },
          { key: 'vs_current_rev', label: '版本状态' },
          { key: 'review_status', label: '受理状态' },
          { key: 'reviewed_by', label: '受理人', type: 'code' },
        ],
        rows, row_actions: ['quote.review'], bulk: 'quote.review',
        counts: { ...(json.counts ?? {}) },
        note: `事实时刻 ${json.as_of || '—'} · 逐条「受理/退回/要求补件」（人签，按行内或勾选批量）；`
          + '受理状态读账本 `approval/*` 的 `scope=quote-review:<decision>`；作废的报价不允许受理（`quote-superseded`）' }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'quote.review', title: '受理 / 退回 / 要求补件（人签）',
    views: ['contractor'], group: '报价', order: 5, permission: 'human-signature', inline: true,
    object_kind: 'quote',
    confirm: { required: true, message: '这是**人签判定**：受理后对方会看到「已受理」；确认以你的署名执行？' },
    hint: '受理=approval/granted、退回/要补件=approval/denied（scope 带判定）；退回/补件必须给理由；'
      + '通知对方只含判定与披露理由，**不含内部备注**',
    input: { bulk: 'ids', fields: [
      { name: 'quote_id', label: '报价 id', type: 'text', required: true, from_route: true,
        help: '从收件箱行里取（批量时每行自带）；在报价对象页上会自动填当前这一份' },
      { name: 'decision', label: '判定', type: 'select', options: ['accepted', 'returned', 'need-info'],
        default: 'accepted', help: '受理 / 退回 / 要求补件' },
      { name: 'signature', label: '受理人（人签）', type: 'signature', required: true, help: 'human:<你的名字>' },
      { name: 'comment', label: '理由（退回/补件必填；受理可空）', type: 'textarea',
        help: '退回 / 要求补件时必须写清楚要对方改什么（会披露给对方）；受理时留空即可' },
    ] },
    server: async (ctx, input) => {
      const decision = asText(input.decision) || 'accepted'
      const comment = String(input.comment ?? '')
      if (decision !== 'accepted' && comment.trim() === '') {
        return { ok: false, code: 'reason-required', reason: '退回/要求补件必须给理由（对方要知道改什么）',
          next_action: '在「理由」里写清楚：哪一条不对、要补什么' }
      }
      const quoteIds = Array.isArray(input.ids) && input.ids.length
        ? input.ids.map(asText) : [asText(input.quote_id)]
      const results = []
      for (const quoteId of quoteIds) {
        const staged = host.stage('quote-review', { kind: 'quote-review', action: 'review', view: 'contractor',
          quote_id: quoteId, decision, actor: asText(input.signature), note: comment })
        if (!staged.ok) { results.push({ quote_id: quoteId, ok: false, code: staged.code, reason: staged.reason }); continue }
        const run = host.runPython(reviewTool, ['--request', staged.path, '--ui-shared', host.sharedDir,
          '--ledger-contractor', contractorLedger(), '--ledger-supplier', supplierLedger(), '--now', host.now()])
        const json = run.json ?? {}
        results.push({ quote_id: quoteId, ok: run.ok && json.ok === true,
          code: json.refusal?.code ?? (json.ok ? decision : 'writer-failed'),
          reason: json.refusal?.reason ?? run.reason ?? '',
          next_action: json.refusal?.next_action ?? json.next_action_runtime ?? '',
          approval_id: json.approval_id ?? null, ledger_added: json.ledger_added ?? 0,
          pending: staged.file, notices: json.notices ?? null })
      }
      const okAll = results.every((row) => row.ok)
      const failed = results.filter((row) => !row.ok)
      return { ok: okAll && results.length > 0,
        code: okAll ? decision : (results.length > 1 ? 'partial-failure' : (failed[0]?.code ?? 'refused')),
        reason: failed.map((row) => `${row.quote_id}: ${row.reason}`).join('；'),
        next_action: okAll
          ? `判定已落账（approval/requested + granted|denied，scope=quote-review:${decision}）：`
            + '对方侧看到「已受理/已退回/要求补件」（不含内部备注）；邮件通道不可用时通知未发出，可复制通知正文'
          : failed.map((row) => `${row.quote_id}：${row.next_action}`).join('；'),
        result: { results, accepted: results.filter((row) => row.ok).length, failed: failed.length,
          notices: reviewsFile() } }
    } }))

  out.push(surface.validator({ plugin_id: me, id: 'validator.quote-review', title: '受理/退回/补件的理由规则',
    actions: ['quote.review'], order: 5,
    validate: (input) => (String(input.decision ?? 'accepted') !== 'accepted'
      && String(input.comment ?? '').trim() === '')
      ? [{ field: 'comment', code: 'reason-required',
        message: '退回 / 要求补件必须给理由（对方要知道改什么）',
        next_action: '在「理由」里写清楚：哪一条不对、要补什么' }]
      : [] }))

  out.push(surface.panel({ plugin_id: me, id: 'quotes.review-notices', title: '承包商对我报价的判定（对方通知）',
    view: 'supplier', order: 45, kind: 'table',
    data: () => {
      const rows = []
      const letters = reviewNotices()
      const letterOf = (subject) => {
        const match = /\s(q-[\w.-]+)\s*$/.exec(String(subject))
        const quoteId = match ? match[1] : ''
        return (letters.filter((item) => item.quote_id === quoteId).slice(-1)[0] ?? {}).letter ?? ''
      }
      for (const row of typeRows(host.rows('supplier'), 'mail/') ) {
        const body = bodyOf(row)
        const subject = asText(body.subject)
        if (!subject.startsWith('报价评审：')) continue
        rows.push({ id: `${body.message_id ?? ''}-${row.ts ?? ''}`, at: row.ts ?? '', subject,
          to: (body.to ?? []).join(' '), body_sha256: asText(body.body_sha256),
          disclosed: letterOf(subject) })
      }
      if (!rows.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-quote-review-notice',
          next_action: '等承包商在收件箱里受理/退回你的报价（判定会通过通知信封送到本侧）',
          columns: [{ key: 'subject', label: '通知' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        columns: [{ key: 'at', label: '收到时刻' }, { key: 'subject', label: '判定' },
          { key: 'disclosed', label: '承包商披露的理由' }, { key: 'body_sha256', label: '正文哈希', type: 'code' }],
        rows, counts: { notices: rows.length },
        note: '只含判定与承包商愿意披露的理由（**不含**内部备注）；通知是"入队"事实，不代表邮件真的发出' }
    } }))

  out.push(surface.notificationSource({ plugin_id: me, id: 'notify.quote-review', title: '待受理的报价',
    order: 8, poll: () => {
      const { json } = inboxOf()
      const items = []
      for (const bag of json.packages ?? []) {
        for (const quote of bag.quotes ?? []) {
          if (quote.review_status !== '待审') continue
          items.push({ id: `quote:review:${quote.quote_id}`, level: 'warn', at: quote.submitted_at,
            ref: { view: 'contractor', kind: 'quote', id: asText(quote.quote_id),
              title: `报价 ${asText(quote.quote_id)}` },
            title: `待受理：${quote.quote_id}（${bag.package_id} · ${quote.supplier}）`,
            body: `行合计 ${quote.total_cents} 分 · ${(quote.items ?? []).length} 行 · ${quote.vs_current_rev}`,
            next_action: '点下面的按钮受理/退回/要补件（人签）', action: 'quote.review',
            preset: { quote_id: asText(quote.quote_id) } })
        }
      }
      return items
    } }))

  out.push(surface.statusItem({ plugin_id: me, id: 'status.quote-review', title: '报价收件箱', order: 6, read: () => {
    const { json } = inboxOf()
    if (!json.ok) return { text: '收件箱读不到', level: 'warn', next_action: json.refusal?.next_action ?? '' }
    const pending = json.counts?.pending ?? 0
    return { text: `${json.counts?.quotes ?? 0} 条报价 · 待受理 ${pending}`,
      level: pending ? 'warn' : 'ok', next_action: pending ? '去收件箱受理/退回（人签）' : '' }
  } }))

  return out
}
