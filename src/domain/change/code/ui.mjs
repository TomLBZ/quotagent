/**
 * `domain/change` 的 **GUI 贡献** —— 供应商侧「**变更单 ** + 新版作废与改报」这一块（本批 P1 供应商缺口）：
 *
 *   · **变更单可见 + 接受/异议（DEF-019）**：面板 `change.inbox`（逐行差异：原单价×原量 → 新量 → 差额，
 *     整数分口径）+ 动作 `change.respond`（服务端一半跑唯一写者 `tools/change-respond.py`）；
 *     承包商侧 `change.track` 会多一行「供应商回应：接受/异议 @ts」（双向可断言）。
 *   · **改报（DEF-017）**：面板 `requote.status`（报价状态轨 `active`/`superseded`/`requote-requested`
 *     + **rev 差异**：哪几行量变了）+ 动作 `quote.requote`（先落"作废 + 要按 revN 重报"两条事实，
 *     再用**既有写者** `src/domain/quote-prepare/tools/quote-draft.py` 生成**新 rev 的草稿**——预填、不自动提交；
 *     真正的报价提交仍要人签（`quote.submit`））。
 *   · **新版的来源（改动前置）**：动作 `pkg.amend-rev`（承包商侧，人签）——「把量改了，发 rev+1」，
 *     服务端一半跑唯一写者 `tools/amend-rev.py`（内部走既有服务 `RfqService.amend/distribute`）。
 *     本批没有它，供应商侧的「作废/改报」就没有真实前置（别的批次在动 `domain/rfq`，本批不碰它）。
 *
 * 纪律：本文件**不写账本**（写账本的是三个 Python 侧唯一写者）；不读别人的账本（只读本视角投影行 +
 * 共享目录里的投递信封/快照/意向信封）。一切注册可撤销（卸载后视图/动作/快捷键一起消失）。
 */
export const plugin_id = 'domain/change'

import { createHash } from 'node:crypto'

const asText = (value) => (typeof value === 'string' ? value.trim() : '')
const bodyOf = (row) => (row && typeof row.body === 'object' && row.body !== null ? row.body : {})
const typeRows = (rows, ...types) => rows.filter((row) => types.includes(String(row?.type ?? '')))
const prefixRows = (rows, prefix) => rows.filter((row) => String(row?.type ?? '').startsWith(prefix))
const sha = (text) => createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
const REV_EVENTS = ['rfq/published', 'rfq/distributed', 'rfq/amended']

/** 与唯一写者 `quote-draft.py` 的 `canonical_lines()` 逐字节一致的行项目规范化 JSON。 */
const canonicalLines = (record) => JSON.stringify({ currency: String(record.currency ?? ''),
  item_id: String(record.item_id ?? ''), lead_time_days: record.lead_time_days,
  rfq_id: String(record.rfq_id ?? ''), unit_price_cents: record.unit_price_cents })

/** 本视角看到的版本事实：`package_id → [{ts, rev, items}]`（只用 rfq/* 事实 + 投递信封）。 */
const revHistory = (host, view) => {
  const out = new Map()
  for (const row of typeRows(host.rows(view), ...REV_EVENTS)) {
    const body = bodyOf(row)
    const packageId = asText(body.package_id) || asText(row?.correlation_id)
    if (packageId === '') continue
    const rev = Number.isInteger(body.rev) ? body.rev : (Number.isInteger(row?.refs?.rfq_rev) ? row.refs.rfq_rev : null)
    if (rev === null) continue
    const list = out.get(packageId) ?? []
    const rawItems = Array.isArray(body.items) ? body.items
      : (Array.isArray(body.spec?.items) ? body.spec.items : [])
    list.push({ ts: String(row?.ts ?? ''), rev, kind: String(row.type),
      items: rawItems.filter((item) => item && item.item_id) })
    out.set(packageId, list)
  }
  const target = asText(host.config?.rfq_delivery)
  const envelope = target ? host.readJson(target) : null
  const spec = envelope && typeof envelope === 'object' ? (envelope.spec ?? {}) : {}
  const packageId = asText(spec.package_id)
  if (packageId && Number.isInteger(envelope.rev)) {
    const list = out.get(packageId) ?? []
    list.push({ ts: String(envelope.sent_at ?? ''), rev: envelope.rev, kind: 'delivery-envelope',
      items: (Array.isArray(spec.items) ? spec.items : []).filter((item) => item && item.item_id) })
    out.set(packageId, list)
  }
  for (const [key, list] of out) out.set(key, list.sort((left, right) => left.rev - right.rev))
  return out
}

/** 承包商侧的已发布快照（`rfq-ops.json` 给出包与版本；快照文件给出行项目数量）。 */
const snapshotsOf = (host) => {
  const ops = host.readJson(`${host.sharedDir}/contractor/rfq-ops.json`)
  const list = Array.isArray(ops?.ops) ? ops.ops : []
  const latest = new Map()
  for (const op of list) {
    const packageId = asText(op?.package_id)
    const rev = Number.isInteger(op?.rev) ? op.rev : null
    if (packageId === '' || rev === null) continue
    const current = latest.get(packageId)
    if (!current || rev > current) latest.set(packageId, rev)
  }
  const out = new Map()
  for (const [packageId, rev] of latest) {
    const snapshot = host.readJson(`${host.sharedDir}/contractor/rfq-${packageId}-rev${rev}.json`)
    out.set(packageId, { rev, spec: snapshot?.spec ?? null, snapshot_hash: snapshot?.snapshot_hash ?? '' })
  }
  return out
}

const quotesOf = (host, view) => {
  const out = new Map()
  for (const row of typeRows(host.rows(view), 'quote/submitted')) {
    const body = bodyOf(row)
    const quoteId = asText(body.quote_id)
    if (quoteId === '') continue
    const entry = out.get(quoteId) ?? { quote_id: quoteId, package_id: asText(body.package_id),
      item_id: asText(body.item_id), unit_price_cents: body.unit_price_cents,
      lead_time_days: body.lead_time_days, supplier: asText(body.supplier),
      submitted_at: asText(body.submitted_at) || String(row?.ts ?? ''), approved_by: asText(body.approved_by) }
    out.set(quoteId, entry)
  }
  return [...out.values()]
}

/** 报价绑定的版本：提交时刻之前最近一次版本事实（与唯一写者 `requote.py` 同一推断）。 */
const basedOnRev = (history, submittedAt) => {
  let rev = 1
  for (const entry of history ?? []) if (entry.ts <= String(submittedAt)) rev = entry.rev
  return rev
}

const supersededKeys = (host, view) => {
  const rows = typeRows(host.rows(view), 'quote/superseded')
  return new Set(rows.map((row) => `${asText(bodyOf(row).quote_id)}#${bodyOf(row).superseded_by_rev ?? ''}`))
}

export async function register(surface, host) {
  const me = plugin_id
  const out = []
  const ledgerC = () => asText(host.config?.ledger_contractor)
  const ledgerS = () => asText(host.config?.ledger_supplier)
  const delivery = () => asText(host.config?.rfq_delivery)
  const realmOf = (view) => {
    const found = host.rows(view).find((row) => asText(row?.realm) !== '')
    return found ? asText(found.realm) : ''
  }

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
        stdout: run.stdout ? run.stdout.slice(-800) : '', stderr: run.stderr ? run.stderr.slice(-300) : '' } }
  }

  // ================================================================== 视图
  out.push(surface.view({ plugin_id: me, id: 'exchange.change-workspace', title: '变更与改报', order: 25,
    view: 'supplier', hint: '看变更单（逐行差异）→ 接受/异议；看新版 → 旧报价作废 → 按新版重报' }))

  // ================================================================== 供应商侧：变更单
  out.push(surface.panel({ plugin_id: me, id: 'exchange.changes', title: '变更单（逐行差异 · 我能否接受）',
    view: 'supplier', order: 20, kind: 'table', actions: ['exchange.change-respond'],
    hint: '原单价×原量只读 → 新量 → 差额（整数分）；回应会镜像到承包商侧（对方多一行「供应商回应 @ts」）',
    data: () => {
      const rows = host.rows('supplier')
      const proposed = typeRows(rows, 'change/proposed')
      const responded = new Map(typeRows(rows, 'change/responded')
        .map((row) => [asText(bodyOf(row).change_id), bodyOf(row)]))
      const approved = new Set(typeRows(rows, 'change/approved')
        .map((row) => asText(bodyOf(row).change_id)))
      if (!proposed.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-change-proposed',
          next_action: '等承包商在 APP 里提出变更（变更单会镜像到你这一侧）；现在没有任何待回应的变更',
          columns: [{ key: 'change_id', label: '变更单' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        columns: [{ key: 'change_id', label: '变更单', type: 'code' }, { key: 'package_id', label: '包', type: 'code' },
          { key: 'quote_id', label: '原报价', type: 'code' }, { key: 'lines', label: '逐行差异（原量 → 新量）' },
          { key: 'delta_amount', label: '差额' }, { key: 'status', label: '状态' },
          { key: 'response', label: '我的回应' }],
        rows: proposed.map((row) => {
          const body = bodyOf(row)
          const changeId = asText(body.change_id)
          const response = responded.get(changeId)
          return { id: changeId, change_id: changeId, package_id: asText(body.package_id),
            quote_id: asText(body.quote_id),
            lines: (body.lines ?? []).map((line) => `${line.ref_line}: ${line.old_qty} → ${line.new_qty}`
              + `（单价基准 ${line.old_unit_price} 元，行差额 ${Number(line.line_delta).toFixed(2)}）`).join('；').slice(0, 240),
            delta_amount: body.delta_amount ?? '—',
            status: approved.has(changeId) ? '已生效' : (response ? '已回应' : '待我回应'),
            response: response ? `${asText(response.decision) === 'accept' ? '接受' : '异议'}：${asText(response.note)}`
              : '（待回应）' }
        }),
        row_actions: ['exchange.change-respond'],
        counts: { changes: proposed.length, responded: responded.size, approved: approved.size },
        note: '未批准的变更**一分钱都不计**；缺单价基准的行不可勾选（服务拒绝 `basis-mismatch` 时账本零新增）' }
    } }))

  // ================================================================== 供应商侧：改报
  out.push(surface.panel({ plugin_id: me, id: 'exchange.requote-rail', title: '我的报价状态轨（新版作废与改报）',
    view: 'supplier', order: 22, kind: 'table', actions: ['exchange.requote-now'],
    hint: '新版一到，基于旧版的报价就被标为 superseded；「按 revN 重报」会落事实并生成新草稿（仍需人签提交）',
    data: () => {
      const rows = host.rows('supplier')
      const history = revHistory(host, 'supplier')
      const quotes = quotesOf(host, 'supplier')
      const superseded = supersededKeys(host, 'supplier')
      const requotes = typeRows(rows, 'quote/requote-open').map((row) => bodyOf(row))
      if (!quotes.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-submitted-quote',
          next_action: '先在「备报价」里备一份并人签提交 —— 改报要有"旧报价"才有对象',
          columns: [{ key: 'quote_id', label: '报价' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        columns: [{ key: 'quote_id', label: '报价', type: 'code' }, { key: 'item_id', label: '行项目', type: 'code' },
          { key: 'unit_price_cents', label: '单价（整数分）' }, { key: 'based_on_rev', label: '基于 rev' },
          { key: 'latest_rev', label: '最新 rev' }, { key: 'status', label: '状态' },
          { key: 'rev_diff', label: 'rev 差异（本包行项目）' }, { key: 'requote', label: '重报登记' }],
        rows: quotes.map((quote) => {
          const list = history.get(quote.package_id) ?? []
          const latest = list.length ? list[list.length - 1] : null
          const base = basedOnRev(list, quote.submitted_at)
          const oldItems = (list.find((entry) => entry.rev === base) ?? {}).items ?? []
          const newItems = latest ? latest.items : []
          const oldMap = new Map(oldItems.map((item) => [String(item.item_id), item]))
          const diff = newItems.map((item) => {
            const before = oldMap.get(String(item.item_id))
            return `${item.item_id}: ${before ? before.qty : '（旧版无此条目）'} → ${item.qty}`
          }).join('；')
          const stale = latest !== null && base < latest.rev
          const done = superseded.has(`${quote.quote_id}#${latest?.rev ?? ''}`)
          const open = requotes.find((entry) => (entry.quotes ?? []).includes(quote.quote_id))
          return { id: quote.quote_id, quote_id: quote.quote_id, item_id: quote.item_id,
            unit_price_cents: quote.unit_price_cents, based_on_rev: base, latest_rev: latest ? latest.rev : '—',
            status: stale ? (done ? '已被新版作废（superseded）' : '需作废（待落账）') : 'active',
            rev_diff: diff || '（无可比版本：只有一版）',
            requote: open ? `已登记按 rev${open.superseded_by_rev} 重报 @${asText(open.at)}` : '' }
        }),
        row_actions: ['exchange.requote-now'],
        counts: { quotes: quotes.length, stale: quotes.filter((quote) => {
          const list = history.get(quote.package_id) ?? []
          const latest = list.length ? list[list.length - 1] : null
          return latest !== null && basedOnRev(list, quote.submitted_at) < latest.rev
        }).length },
        note: '状态轨口径来自既有服务 `QuoteBook.on_amended`（`requires_requote` / `superseded_by_rev`）；'
          + '重报只生成**草稿**，提交必须人签（本 APP 不代签）' }
    } }))

  out.push(surface.panel({ plugin_id: me, id: 'exchange.prefill', title: '按最新 rev 重报：预填值（我看到的）',
    view: 'supplier', order: 23, kind: 'kv', placement: 'side',
    data: () => {
      const history = revHistory(host, 'supplier')
      const quotes = quotesOf(host, 'supplier')
      const items = []
      for (const [packageId, list] of history) {
        const latest = list[list.length - 1]
        const mine = quotes.filter((quote) => quote.package_id === packageId)
        items.push({ key: `包 ${packageId} @rev${latest.rev}`, value: `我的报价：${mine.length
          ? mine.map((quote) => `${quote.item_id}@${quote.unit_price_cents}分/${quote.lead_time_days}天`).join('、')
          : '（还没有报价）'}`, code: true })
        items.push({ key: ' 该版行项目（数量）', value: latest.items.map((item) => `${item.item_id}×${item.qty}${item.unit ?? ''}`)
          .join('、') || '—' })
      }
      for (const quote of quotes) {
        items.push({ key: `旧单价 ${quote.quote_id}/${quote.item_id}`, value: `${quote.unit_price_cents} 分`
          + `（交期 ${quote.lead_time_days} 天）——重报时可直接沿用或改写`, code: true })
      }
      if (!items.length) items.push({ key: '（无）', value: '还没有可见的包或报价' })
      return { ok: true, kind: 'kv', items,
        note: '重报表单的默认值就是这些数字（预填、不自动提交）；改完仍需人签提交（quote.submit）' }
    } }))

  // ================================================================== 承包商侧：变更轨道 / 改报看板 / 发新版
  out.push(surface.panel({ plugin_id: me, id: 'exchange.change-track', title: '变更轨道（提出 → 供应商回应 → 生效）',
    view: 'contractor', order: 35, kind: 'table',
    data: () => {
      const rows = host.rows('contractor')
      const proposed = typeRows(rows, 'change/proposed').map((row) => bodyOf(row))
      const priced = new Map(typeRows(rows, 'change/priced')
        .map((row) => [asText(bodyOf(row).change_id), bodyOf(row)]))
      const responded = new Map(typeRows(rows, 'change/responded')
        .map((row) => [asText(bodyOf(row).change_id), bodyOf(row)]))
      const approved = new Set(typeRows(rows, 'change/approved')
        .map((row) => asText(bodyOf(row).change_id)))
      if (!proposed.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-change',
          next_action: '在「可提变更的报价行」里对某一行提变更（提出变更不产生义务，未批准不影响金额）',
          columns: [{ key: 'change_id', label: '变更单' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        columns: [{ key: 'change_id', label: '变更单', type: 'code' }, { key: 'quote_id', label: '原报价', type: 'code' },
          { key: 'lines', label: '逐行差异' }, { key: 'delta_amount', label: '差额' },
          { key: 'status', label: '状态' }, { key: 'response', label: '供应商回应' }, { key: 'owed_by', label: '谁欠动作' }],
        rows: proposed.map((entry) => {
          const changeId = asText(entry.change_id)
          const response = responded.get(changeId)
          return { id: changeId, change_id: changeId, quote_id: asText(entry.quote_id),
            lines: (entry.lines ?? entry.delta ?? []).map((line) => `${line.ref_line ?? line.item_id}: `
              + `${line.old_qty} → ${line.new_qty}`).join('；'),
            delta_amount: priced.get(changeId)?.delta_amount ?? entry.delta_amount ?? '—',
            status: approved.has(changeId) ? '已批准（生效）' : (response ? '供应商已回应' : '待供应商回应'),
            response: response ? `${asText(response.decision) === 'accept' ? '接受' : '异议'} @${asText(response.at)}`
              + `${response.note ? `：${asText(response.note)}` : ''}` : '（等对方回应）',
            owed_by: approved.has(changeId) ? '—'
              : (response ? (asText(response.decision) === 'accept' ? 'contractor（批准是人工门）' : 'contractor（回应异议）')
                : 'supplier（回应变更）') }
        }),
        counts: { changes: proposed.length, responded: responded.size, approved: approved.size },
        note: '`owed_by` 指出谁欠动作：等你回应 ⇒ supplier；等批准/改量重提 ⇒ contractor。'
          + '批准是人工门（`ChangeService.approve`，`approved_by` 须 human:*），不在本批能力面里' }
    } }))

  out.push(surface.panel({ plugin_id: me, id: 'exchange.change-candidates', title: '可提变更的报价行（本侧收到的报价）',
    view: 'contractor', order: 36, kind: 'table', actions: ['exchange.change-propose'],
    hint: '原单价来自本侧 `quote/submitted` 事实、原数量来自已发布快照；提出变更**不产生义务**',
    data: () => {
      const quotes = quotesOf(host, 'contractor')
      const snapshots = snapshotsOf(host)
      const rows = []
      for (const quote of quotes) {
        const snapshot = snapshots.get(quote.package_id)
        const item = (snapshot?.spec?.items ?? []).find((entry) => String(entry.item_id) === quote.item_id)
        rows.push({ id: `${quote.quote_id}:${quote.item_id}`, quote_id: quote.quote_id,
          package_id: quote.package_id, item_id: quote.item_id,
          unit_price_cents: quote.unit_price_cents, qty: item ? item.qty : '',
          unit: item ? (item.unit ?? '') : '', basis: `${quote.quote_id}#${quote.item_id}:unit_price`,
          has_basis: Boolean(item) })
      }
      if (!rows.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-quote-received',
          next_action: '等供应商人签提交报价（会同时在本侧登记一条），再提变更',
          columns: [{ key: 'quote_id', label: '报价' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        columns: [{ key: 'quote_id', label: '报价', type: 'code' }, { key: 'package_id', label: '包', type: 'code' },
          { key: 'item_id', label: '行项目', type: 'code' }, { key: 'unit_price_cents', label: '原单价（整数分）' },
          { key: 'qty', label: '原数量（快照）' }, { key: 'unit', label: '单位' },
          { key: 'basis', label: '单价基准引用', type: 'code' }
        ],
        rows, row_actions: ['exchange.change-propose'],
        counts: { lines: rows.length, without_basis: rows.filter((row) => !row.has_basis).length },
        note: '缺基准（快照里没有这一行的数量）⇒ 该行**不可提变更**（服务会以 `basis-qty-missing`/`unknown-line` 拒绝）' }
    } }))

  out.push(surface.panel({ plugin_id: me, id: 'exchange.requote-board', title: '改报看板（对方登记：作废 / 待重报）',
    view: 'contractor', order: 37, kind: 'table',
    data: () => {
      const rows = host.rows('contractor')
      const superseded = typeRows(rows, 'quote/superseded').map((row) => bodyOf(row))
      const requotes = typeRows(rows, 'quote/requote-open').map((row) => bodyOf(row))
      if (!superseded.length && !requotes.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-supersede-yet',
          next_action: '发新版（改量）后，基于旧版的报价会被标为作废；供应商侧可以一键"按 revN 重报"',
          columns: [{ key: 'quote_id', label: '报价' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        columns: [{ key: 'quote_id', label: '报价', type: 'code' }, { key: 'supplier', label: '供应商', type: 'code' },
          { key: 'based_on_rev', label: '基于 rev' }, { key: 'superseded_by_rev', label: '被 rev 作废' },
          { key: 'requires_requote', label: '需要重报' }, { key: 'status', label: '对方状态' }],
        rows: superseded.map((entry) => ({ id: `${entry.quote_id}#${entry.superseded_by_rev}`,
          quote_id: asText(entry.quote_id), supplier: asText(entry.supplier),
          based_on_rev: entry.based_on_rev, superseded_by_rev: entry.superseded_by_rev,
          requires_requote: entry.requires_requote === true ? '是' : '—',
          status: requotes.some((item) => (item.quotes ?? []).includes(asText(entry.quote_id)))
            ? `已登记重报（@${asText(requotes.find((item) => (item.quotes ?? []).includes(asText(entry.quote_id))).at)}）`
            : '待对方重报' })),
        counts: { superseded: superseded.length, requote_open: requotes.length },
        note: '这些行是**对方侧**登记后镜像过来的（双向可断言）：供应商不是默默消失，而是明确"我需要按新版重报"' }
    } }))

  out.push(surface.panel({ plugin_id: me, id: 'exchange.rev-versions', title: '已发布的包（改量 → 发新版 rev+1）',
    view: 'contractor', order: 38, kind: 'table', actions: ['exchange.rev-amend'],
    hint: '改数量后提交即发新版：既有服务 RfqService.amend + distribute；新版会投递给被邀供应商，旧版报价随之作废',
    data: () => {
      const snapshots = snapshotsOf(host)
      const rows = []
      for (const [packageId, info] of snapshots) {
        for (const item of (info.spec?.items ?? [])) {
          rows.push({ id: `${packageId}:${item.item_id}`, package_id: packageId, rev: info.rev,
            item_id: String(item.item_id), description: item.description ?? '', unit: item.unit ?? '',
            qty: item.qty, snapshot_hash: info.snapshot_hash })
        }
      }
      if (!rows.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-published-snapshot',
          next_action: '先在承包商道「发布 RFQ」发布一个包（发布写者会写快照 rfq-<包>-rev<N>.json）',
          columns: [{ key: 'item_id', label: '行项目' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        columns: [{ key: 'package_id', label: '包', type: 'code' }, { key: 'rev', label: '当前 rev' },
          { key: 'item_id', label: '行项目', type: 'code' }, { key: 'description', label: '描述' },
          { key: 'unit', label: '单位' }, { key: 'qty', label: '数量（可直接改）', editable: true, type: 'number' }],
        rows, editable_action: 'exchange.rev-amend',
        editable_defaults: { package_id: rows[0].package_id, signature: 'human:（请改成你的名字）', from_rev: rows[0].rev },
        counts: { packages: snapshots.size, lines: rows.length },
        note: '只改数量即发新版（增删条目/改截止不在本批能力面里）；发新版=对外可见，需人签' }
    } }))

  // ================================================================== 动作
  out.push(surface.action({ plugin_id: me, id: 'exchange.change-respond', title: '回应变更（接受 / 异议）',
    views: ['supplier'], group: '变更', order: 10,
    confirm: { required: true, message: '回应会镜像给承包商（对方看得到接受或异议）：确认？' },
    input: { fields: [
      { name: 'change_id', label: '变更单 id', type: 'text', required: true, help: '从「变更单」表里复制' },
      { name: 'decision', label: '我的回应', type: 'select', options: ['accept', 'dispute'], default: 'accept' },
      { name: 'note', label: '理由（异议时必填）', type: 'textarea' },
      { name: 'actor', label: '回应人', type: 'text', required: true, help: 'human:<你的名字>' },
    ] },
    server: async (ctx, input) => {
      const decision = asText(input.decision) || 'accept'
      const note = String(input.note ?? '')
      if (decision === 'dispute' && note.trim() === '') {
        return { ok: false, code: 'note-required', reason: '异议必须附理由（只报"不接受"没有可行动的下一步）',
          next_action: '写清异议理由（例如：新增量需重新核价）后重提' }
      }
      return runWriter({ kind: 'change-respond', tool: 'src/domain/change/tools/change-respond.py',
        record: { kind: 'change-respond', action: 'respond', view: 'supplier', change_id: asText(input.change_id),
          decision, actor: asText(input.actor), note, note_sha256: sha(note) },
        args: (staged) => ['--request', staged.path, '--ui-shared', host.sharedDir,
          '--ledger-contractor', ledgerC(), '--ledger-supplier', ledgerS(), '--now', host.now()],
        label: 'change-respond.py',
        okNext: '已回应：承包商侧变更轨道多一行「供应商回应：接受/异议 @ts」（owed_by 随之改变）' })
    } }))

  out.push(surface.action({ plugin_id: me, id: 'exchange.change-propose', title: '提出变更（改量，不产生义务）',
    views: ['contractor'], group: '变更', order: 20,
    hint: '只改量、单价基准引用原报价（缺引用即拒）；提出变更不产生义务，未批准不影响任何金额',
    input: { fields: [
      { name: 'package_id', label: '包', type: 'text', required: true },
      { name: 'quote_id', label: '原报价', type: 'text', required: true, help: '本侧收到的报价 id' },
      { name: 'item_id', label: '行项目', type: 'text', help: '批量（选中多行）时每行自带' },
      { name: 'new_qty', label: '新数量', type: 'number', min: 0, help: '批量时每行自带' },
      { name: 'reason', label: '原因（进变更正文）', type: 'text' },
      { name: 'actor', label: '发言人', type: 'text', required: true, help: 'human:<你的名字>' },
    ] },
    server: async (ctx, input) => {
      const rows = Array.isArray(input.rows) && input.rows.length ? input.rows : [input]
      const items = rows.map((row) => ({ item_id: asText(row.item_id ?? row.id),
        new_qty: Number(row.new_qty ?? row.qty) })).filter((row) => row.item_id !== '')
      if (!items.length) {
        return { ok: false, code: 'empty-delta', reason: '没有可改的行（批量时要先勾选行）',
          next_action: '在「可提变更的报价行」里勾选要改的行并填新数量' }
      }
      const note = ''
      return runWriter({ kind: 'change-respond', tool: 'src/domain/change/tools/change-respond.py',
        record: { kind: 'change-respond', action: 'propose', view: 'contractor',
          package_id: asText(input.package_id), quote_id: asText(input.quote_id), items,
          reason: String(input.reason ?? ''), actor: asText(input.actor), note, note_sha256: sha(note) },
        args: (staged) => ['--request', staged.path, '--ui-shared', host.sharedDir,
          '--ledger-contractor', ledgerC(), '--ledger-supplier', ledgerS(), '--now', host.now()],
        label: 'change-respond.py',
        okNext: '变更单已提出并投递给对方（供应商侧「变更单」里能看到逐行差异，等它回应）' })
    } }))

  out.push(surface.action({ plugin_id: me, id: 'exchange.requote-now', title: '按最新 rev 重报（预填，不自动提交）',
    views: ['supplier'], group: '改报', order: 30,
    confirm: { required: true, message: '重报会先作废旧报价登记、并生成新 rev 的**草稿**（草稿不算对外报价，仍需人签提交）：确认？' },
    hint: '两步：① 唯一写者 requote.py 落 quote/superseded + quote/requote-open；② 既有写者 quote-draft.py 生成新草稿',
    input: { fields: [
      { name: 'package_id', label: '包 id', type: 'text', required: true },
      { name: 'quote_id', label: '被作废的报价 id', type: 'text', required: true, help: '从「报价状态轨」里复制' },
      { name: 'item_id', label: '行项目（新 rev 里的）', type: 'text', required: true },
      { name: 'unit_price_cents', label: '单价（整数分，预填旧价可改）', type: 'number', required: true, min: 1 },
      { name: 'lead_time_days', label: '交期（天）', type: 'number', required: true, min: 1 },
      { name: 'prepared_by', label: '备报价人', type: 'text', required: true, help: 'human:<你的名字>' },
      { name: 'currency', label: '币种', type: 'text', default: 'CNY' },
      { name: 'note', label: '备注（可选，只留 sha256 进账本）', type: 'textarea' },
    ] },
    server: async (ctx, input) => {
      const preparedBy = asText(input.prepared_by)
      if (!preparedBy.startsWith('human:')) {
        return { ok: false, code: 'human-required', reason: '重报也要有人认领：prepared_by 必须以 human: 开头',
          next_action: '写 human:<你的名字>' }
      }
      const facts = await runWriter({ kind: 'requote', tool: 'src/domain/change/tools/requote.py',
        record: { kind: 'requote', action: 'requote', view: 'supplier', package_id: asText(input.package_id),
          quote_id: asText(input.quote_id), actor: preparedBy, note: '', note_sha256: sha('') },
        args: (staged) => ['--request', staged.path, '--ui-shared', host.sharedDir,
          '--ledger-supplier', ledgerS(), '--ledger-contractor', ledgerC(), '--delivery', delivery(),
          '--now', host.now()],
        label: 'requote.py',
        okNext: '旧报价已作废（superseded）并登记重报；接着生成新 rev 的草稿' })
      if (!facts.ok) return facts
      // ---- 第二步：新 rev 的草稿（复用既有唯一写者 quote-draft.py，不自造写路径） --------------------
      const note = String(input.note ?? '')
      const record = { schema: 1, kind: 'quote-draft', requested_action: 'draft', view: 'supplier',
        // 供应商身份**不猜**：留空则由唯一写者从本视角账本的 realm 读出（不写死一个假 realm）
        supplier: realmOf('supplier'), rfq_id: asText(input.package_id),
        item_id: asText(input.item_id), unit_price_cents: Number(input.unit_price_cents),
        lead_time_days: Number(input.lead_time_days), currency: asText(input.currency) || 'CNY',
        prepared_by: preparedBy, note }
      record.note_sha256 = sha(note)
      record.lines_sha256 = sha(canonicalLines(record))
      const draftId = `qd-supplier-` + sha([record.view, record.supplier, canonicalLines(record), note,
        preparedBy].join('\n')).slice(0, 12)
      record.quote_draft_id = draftId
      const stagedDraft = host.stage('quote-drafts', record, { name: `${draftId}.json` })
      if (!stagedDraft.ok) {
        return { ok: true, code: 'draft-stage-failed', reason: stagedDraft.reason,
          next_action: '作废与重报登记已落账；草稿没生成（看 reason），可在「备报价」里手工备一份',
          result: { facts: facts.result, draft: stagedDraft } }
      }
      const run = host.runPython('src/domain/quote-prepare/tools/quote-draft.py',
        ['--inbox', `${host.sharedDir}/quote-drafts`, '--ui-shared', host.sharedDir, '--view', 'supplier',
          '--ledger-supplier', ledgerS(), '--ledger-contractor', ledgerC(), '--now', host.now()])
      const json = run.json ?? {}
      return { ok: facts.ok && run.ok, code: run.ok ? 'requoted' : 'draft-failed',
        reason: run.ok ? '' : (run.reason ?? '草稿写者没有输出 JSON'),
        next_action: run.ok
          ? '新 rev 的草稿已落账（quote/drafted）：在「我的草稿」里人签提交（quote.submit）才算对外报价'
          : '作废/重报登记已落账，但草稿生成失败：看失败原因，或手工在「备报价」里备一份',
        result: { facts: facts.result, draft_id: draftId, pending: stagedDraft.file,
          ledger_added: json.ledger_added ?? 0, applied: json.applied ?? [], refused: json.refused ?? [],
          writer: 'quote-draft.py', stdout: run.stdout ? run.stdout.slice(-500) : '' } }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'exchange.rev-amend', title: '发新版（改量 → rev+1，人签）',
    views: ['contractor'], group: '变更', order: 40, permission: 'human-signature',
    confirm: { required: true, message: '发新版会让所有基于旧版的报价作废（对方必须重报）：确认？' },
    hint: '只改数量；走既有服务 RfqService.amend + distribute，并把新版投递给被邀供应商（对方侧看到 rev 差异与"需重报"）',
    input: { fields: [
      { name: 'package_id', label: '包 id', type: 'text', required: true },
      { name: 'from_rev', label: '从哪个版本改（from_rev）', type: 'number', min: 1 },
      { name: 'item_id', label: '行项目', type: 'text', help: '批量（改表格）时每行自带' },
      { name: 'qty', label: '新数量', type: 'number', min: 1, help: '批量时每行自带' },
      { name: 'note', label: '备注（可选）', type: 'textarea' },
      { name: 'signature', label: '署名（人签）', type: 'signature', required: true, help: 'human:<你的名字>' },
    ] },
    server: async (ctx, input) => {
      const rows = Array.isArray(input.rows) && input.rows.length ? input.rows : [input]
      const items = rows.map((row) => ({ item_id: asText(row.item_id ?? row.id),
        qty: Number(row.qty) })).filter((row) => row.item_id !== '' && Number.isFinite(row.qty))
      const packageId = asText(input.package_id || rows[0]?.package_id)
      if (!packageId || !items.length) {
        return { ok: false, code: 'items-required', reason: '没有可发的新版内容（要至少一条 {行项目, 新数量}）',
          next_action: '在「已发布的包」表里改数量后提交' }
      }
      const note = String(input.note ?? '')
      return runWriter({ kind: 'amend-rev', tool: 'src/domain/change/tools/amend-rev.py',
        record: { kind: 'amend-rev', action: 'amend-rev', view: 'contractor', package_id: packageId,
          from_rev: Number(input.from_rev) || null, items, actor: asText(input.signature),
          note, note_sha256: sha(note) },
        args: (staged) => ['--request', staged.path, '--ui-shared', host.sharedDir,
          '--ledger-contractor', ledgerC(), '--ledger-supplier', ledgerS(), '--delivery', delivery(),
          '--now', host.now()],
        label: 'amend-rev.py',
        okNext: '新版已发布并投递：供应商侧的「报价状态轨」会显示旧报价作废 + rev 差异，并可一键重报' })
    } }))

  // ================================================================== 工作台 / 通知 / 状态 / 快捷键
  out.push(surface.panel({ plugin_id: me, id: 'exchange.change-home', title: '变更与改报：我今天要做什么',
    view: 'home', order: 17, kind: 'list',
    data: () => {
      const items = []
      const sRows = host.rows('supplier')
      const cRows = host.rows('contractor')
      const waiting = typeRows(sRows, 'change/proposed').filter((row) => !typeRows(sRows, 'change/responded')
        .some((other) => asText(bodyOf(other).change_id) === asText(bodyOf(row).change_id)))
      if (waiting.length) {
        items.push({ level: 'warn', title: `${waiting.length} 份变更单待我回应`,
          body: waiting.map((row) => `${asText(bodyOf(row).change_id)}（${asText(bodyOf(row).package_id)}）`).join('；'),
          next_action: '看逐行差异 → 接受或异议（`change.respond`）' })
      }
      const history = revHistory(host, 'supplier')
      const quotes = quotesOf(host, 'supplier')
      const stale = quotes.filter((quote) => {
        const list = history.get(quote.package_id) ?? []
        const latest = list.length ? list[list.length - 1] : null
        return latest !== null && basedOnRev(list, quote.submitted_at) < latest.rev
      })
      if (stale.length) {
        items.push({ level: 'warn', title: `${stale.length} 份报价已被新版作废，需要重报`,
          body: stale.map((quote) => `${quote.quote_id}（基于 rev${basedOnRev(history.get(quote.package_id), quote.submitted_at)}）`).join('；'),
          next_action: '在「报价状态轨」里点「按最新 rev 重报」（预填旧价 → 生成新草稿 → 人签提交）' })
      }
      const responses = typeRows(cRows, 'change/responded')
      if (responses.length) {
        items.push({ level: 'ok', title: `承包商侧：供应商回应了 ${responses.length} 份变更单`,
          body: responses.map((row) => `${asText(bodyOf(row).change_id)}：${asText(bodyOf(row).decision)}`).join('；'),
          next_action: '看「变更轨道」的 owed_by（接受 ⇒ 走批准；异议 ⇒ 改量重提）' })
      }
      if (!items.length) {
        items.push({ level: 'info', title: '现在没有待回应的变更或需要重报的报价',
          body: '变更单、报价状态轨、发新版都在「变更与改报」视图里', next_action: '等承包商发新版或提变更' })
      }
      return { ok: true, kind: 'list', items }
    } }))

  out.push(surface.notificationSource({ plugin_id: me, id: 'exchange.change-notify', title: '变更与改报待办',
    order: 17, poll: () => {
      const items = []
      for (const row of typeRows(host.rows('supplier'), 'change/proposed')) {
        const changeId = asText(bodyOf(row).change_id)
        const responded = typeRows(host.rows('supplier'), 'change/responded')
          .some((other) => asText(bodyOf(other).change_id) === changeId)
        if (responded) continue
        items.push({ id: `chg:${changeId}`, level: 'warn', at: String(row?.ts ?? ''),
          title: `变更单待回应：${changeId}`,
          body: `包 ${asText(bodyOf(row).package_id)} · 差额 ${bodyOf(row).delta_amount ?? '—'}`,
          next_action: '在「变更单」里接受或异议（dispute 必须附理由）' })
      }
      const history = revHistory(host, 'supplier')
      for (const quote of quotesOf(host, 'supplier')) {
        const list = history.get(quote.package_id) ?? []
        const latest = list.length ? list[list.length - 1] : null
        if (latest === null || basedOnRev(list, quote.submitted_at) >= latest.rev) continue
        items.push({ id: `stale:${quote.quote_id}`, level: 'warn', at: latest.ts,
          title: `报价 ${quote.quote_id} 已被 rev${latest.rev} 作废`,
          body: `它基于 rev${basedOnRev(list, quote.submitted_at)}；新版数量：`
            + latest.items.map((item) => `${item.item_id}×${item.qty}`).join('、'),
          next_action: '点「按最新 rev 重报」（预填 → 生成草稿 → 人签提交）' })
      }
      return items
    } }))

  out.push(surface.statusItem({ plugin_id: me, id: 'exchange.change-status', title: '变更', order: 17, read: () => {
    const sRows = host.rows('supplier')
    const proposed = typeRows(sRows, 'change/proposed').length
    const responded = typeRows(sRows, 'change/responded').length
    const superseded = typeRows(sRows, 'quote/superseded').length
    const requotes = typeRows(sRows, 'quote/requote-open').length
    return { text: `变更 ${proposed}（已回应 ${responded}）· 作废报价 ${superseded} · 重报登记 ${requotes}`,
      level: proposed > responded ? 'warn' : 'ok',
      next_action: proposed > responded ? '有变更单还没回应' : '' }
  } }))

  out.push(surface.shortcut({ plugin_id: me, id: 'exchange.shortcut-respond', keys: 'm', action: 'exchange.change-respond',
    title: '回应变更（接受/异议）', order: 30 }))
  out.push(surface.shortcut({ plugin_id: me, id: 'exchange.shortcut-requote', keys: 'n', action: 'exchange.requote-now',
    title: '按最新 rev 重报', order: 31 }))

  return out
}
