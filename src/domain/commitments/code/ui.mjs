/**
 * `domain/commitments` 的 **GUI 贡献** —— 授标链（意向 → 供应商确认 → **人签承诺** → **人签发 PO**）。
 *
 * 注册的东西（承包商侧）：
 *   · 面板 `award.chain`：意向 / 供应商确认 / 承诺 / PO 四种事实行一屏（状态、批准人、追溯链）；
 *   · 动作 `award.propose`（服务端一半跑 `src/domain/commitments/tools/commitment-apply.py --step propose`：
 *     落 `award/intent-proposed`，**不产生义务**；也可从「收到的报价」行内点击预填）；
 *   · 动作 `award.commit`（**human-signature**）：--step commit（要求①意向 ②供应商确认 ③人工批准三样齐备）；
 *   · 动作 `po.issue`（**human-signature**）：--step po（PO 只能由承诺派生、逐行引用中标条目、不得改价）。
 *
 * 注册的东西（供应商侧）：
 *   · 面板 `award.inbox`：**发给自己的**授标意向（只读投递信封 `<ui-shared>/exchange/award-intents.json` 里
 *     `delivered_to` 含自己 realm 的那几条）；
 *   · 动作 `award.confirm`（**human-signature**）：--step confirm（写自己账本 `award/confirmed` +
 *     承包商账本一条同名登记 —— 与 `quote-sign.py` 的双向登记同一模式）。
 *
 * 纪律：本文件不写账本（只 spawn 唯一写者）；**承诺与 PO 都必须人签**，且必须带人工批准记录（INV-005）。
 */
export const plugin_id = 'domain/commitments'

const asText = (value) => (typeof value === 'string' ? value.trim() : '')
const bodyOf = (row) => (row && typeof row.body === 'object' && row.body !== null ? row.body : {})
const typeRows = (rows, type) => rows.filter((row) => String(row?.type ?? '') === type)

export async function register(surface, host) {
  const me = plugin_id
  const out = []
  const ledgerC = () => asText(host.config?.ledger_contractor)
  const ledgerS = () => asText(host.config?.ledger_supplier)
  const intentFile = () => `${host.sharedDir}/exchange/award-intents.json`
  const realmOf = (view) => {
    const found = host.rows(view).find((row) => asText(row?.realm) !== '')
    return found ? asText(found.realm) : ''
  }

  // ------------------------------------------------------------------ 承包商侧
  out.push(surface.view({ plugin_id: me, id: 'award.workspace', title: '授标与订单', order: 30,
    view: 'contractor', hint: '意向 → 供应商确认 → 人签承诺 → 人签发 PO（逐行可追溯）' }))

  out.push(surface.panel({ plugin_id: me, id: 'award.chain', title: '授标链（四种事实行一屏）',
    view: 'contractor', order: 40, kind: 'table', actions: ['award.commit', 'po.issue'],
    data: () => {
      const rows = host.rows('contractor')
      const intents = typeRows(rows, 'award/intent-proposed').map((row) => bodyOf(row))
      const confirmed = new Map(typeRows(rows, 'award/confirmed').map((row) => [asText(bodyOf(row).intent_id), bodyOf(row)]))
      const awards = typeRows(rows, 'award/committed').map((row) => bodyOf(row))
      const pos = typeRows(rows, 'po/issued').map((row) => bodyOf(row))
      const table = []
      for (const intent of intents) {
        const intentId = asText(intent.intent_id)
        const award = awards.find((item) => asText(item.intent_id) === intentId)
        const po = award ? pos.find((item) => asText(item.award_id) === asText(award.award_id)) : null
        table.push({ id: intentId, intent_id: intentId, quote_id: intent.quote_id ?? '',
          package_id: intent.package_id ?? '', lines: (intent.lines ?? []).length,
          confirmed: confirmed.has(intentId) ? `${asText(confirmed.get(intentId).confirmed_by)} @ ${confirmed.get(intentId).confirmed_at}` : '未确认',
          award_id: award?.award_id ?? '', approved_by: award?.approved_by ?? '',
          po_id: po?.po_id ?? '', chain: po?.chain ?? '' })
      }
      if (!table.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-award-intent',
          next_action: '在「收到的报价」表里点某一行「提出授标意向」（意向不产生义务）',
          columns: [{ key: 'intent_id', label: '意向' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        columns: [{ key: 'intent_id', label: '意向', type: 'code' }, { key: 'quote_id', label: '报价', type: 'code' },
          { key: 'lines', label: '条目' }, { key: 'confirmed', label: '供应商确认' },
          { key: 'award_id', label: '承诺', type: 'code' }, { key: 'approved_by', label: '承诺批准人', type: 'code' },
          { key: 'po_id', label: 'PO', type: 'code' }, { key: 'chain', label: '追溯链' }],
        rows: table, counts: { intents: intents.length, awards: awards.length, po: pos.length },
        note: '承诺与 PO 两列只有在**人签并过人工门**之后才会有值（没签就是空 —— 不假装已承诺）' }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'award.propose', title: '提出授标意向（不产生义务）',
    views: ['contractor'], group: '授标', order: 10,
    hint: '意向可撤回、可重提；承诺不可凭空产生（FR-AWARD-001/002）',
    input: { fields: [
      { name: 'package_id', label: '包', type: 'text', required: true },
      { name: 'quote_id', label: '报价', type: 'text', required: true, help: '本侧账本里已收到的报价 id' },
      { name: 'item_id', label: '行项目', type: 'text', help: '批量（选中多行）时每行自带' },
      { name: 'qty', label: '数量', type: 'number', min: 1, help: '批量时每行自带' },
      { name: 'unit_price_cents', label: '中标单价（整数分）', type: 'number', min: 1, help: '批量时每行自带' },
      { name: 'reason', label: '理由（进意向正文）', type: 'text' },
    ] },
    server: async (ctx, input) => {
      const lines = Array.isArray(input.rows) && input.rows.length
        ? input.rows.map((row) => ({ item_id: asText(row.item_id ?? row.id), qty: Number(row.qty),
          unit_price_cents: Number(row.unit_price_cents ?? input.unit_price_cents) }))
        : [{ item_id: asText(input.item_id), qty: Number(input.qty),
          unit_price_cents: Number(input.unit_price_cents) }]
      const staged = host.stage('commitment-apply', { kind: 'commitment-apply', action: 'propose',
        view: 'contractor', package_id: asText(input.package_id), quote_id: asText(input.quote_id), lines,
        reason: String(input.reason ?? ''), note: '', actor: 'agent:commitment-apply' })
      if (!staged.ok) return staged
      const run = host.runPython('src/domain/commitments/tools/commitment-apply.py',
        ['--step', 'propose', '--request', staged.path, '--ui-shared', host.sharedDir,
          '--ledger-contractor', ledgerC(), '--ledger-supplier', ledgerS(),
          '--intent-out', intentFile(), '--now', host.now()])
      const json = run.json ?? {}
      return { ok: run.ok && json.ok === true, code: json.refusal?.code ?? (json.ok ? 'proposed' : 'writer-failed'),
        reason: json.refusal?.reason ?? run.reason ?? '',
        next_action: json.refusal?.next_action ?? json.next_action ?? '看 stdout 定位唯一写者的拒绝原因',
        result: { intent_id: json.intent_id ?? null, applied: json.applied ?? [], envelope: json.envelope ?? null,
          ledger_added: json.ledger_added ?? 0, duplicates: json.duplicates ?? [] } }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'award.commit', title: '授标承诺（人签）', views: ['contractor'],
    group: '授标', order: 20, permission: 'human-signature',
    confirm: { required: true, message: '授标承诺＝对外义务：确认以你的署名承诺？' },
    hint: '三样门齐备才落账：意向 + 供应商确认 + 人工批准（approval/requested → granted → award/committed）',
    input: { fields: [
      { name: 'intent_id', label: '意向 id', type: 'text', required: true, help: '从「授标链」表里复制（awin-…）' },
      { name: 'signature', label: '署名（人签）', type: 'signature', required: true, help: 'human:<你的名字>' },
      { name: 'reason', label: '批准理由', type: 'text' },
      { name: 'comment', label: '批注（进批准记录）', type: 'text' },
    ] },
    server: async (ctx, input) => {
      const staged = host.stage('commitment-apply', { kind: 'commitment-apply', action: 'commit',
        view: 'contractor', intent_id: asText(input.intent_id), reason: String(input.reason ?? ''),
        comment: String(input.comment ?? ''), note: '', actor: asText(input.signature) })
      if (!staged.ok) return staged
      const run = host.runPython('src/domain/commitments/tools/commitment-apply.py',
        ['--step', 'commit', '--request', staged.path, '--ui-shared', host.sharedDir,
          '--ledger-contractor', ledgerC(), '--ledger-supplier', ledgerS(), '--now', host.now()])
      const json = run.json ?? {}
      return { ok: run.ok && json.ok === true, code: json.refusal?.code ?? (json.ok ? 'committed' : 'writer-failed'),
        reason: json.refusal?.reason ?? run.reason ?? '',
        next_action: json.refusal?.next_action ?? json.next_action ?? '看 stdout 定位唯一写者的拒绝原因',
        result: { award_id: json.award_id ?? null, approval_id: json.approval_id ?? null,
          applied: json.applied ?? [], ledger_added: json.ledger_added ?? 0, duplicates: json.duplicates ?? [] } }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'po.issue', title: '发 PO（人签）', views: ['contractor'],
    group: '授标', order: 30, permission: 'human-signature',
    confirm: { required: true, message: '发 PO 是承诺类动作：确认以你的署名发出？' },
    hint: 'PO 只能由承诺派生；行与价都从中标条目派生（不得在界面上自由改价）',
    input: { fields: [
      { name: 'award_id', label: '承诺 id', type: 'text', required: true, help: '从「授标链」表里复制（aw-…）' },
      { name: 'signature', label: '署名（人签）', type: 'signature', required: true, help: 'human:<你的名字>' },
      { name: 'reason', label: '批准理由', type: 'text' },
      { name: 'comment', label: '批注（进批准记录）', type: 'text' },
    ] },
    server: async (ctx, input) => {
      const staged = host.stage('commitment-apply', { kind: 'commitment-apply', action: 'po', view: 'contractor',
        award_id: asText(input.award_id), reason: String(input.reason ?? ''), comment: String(input.comment ?? ''),
        note: '', actor: asText(input.signature) })
      if (!staged.ok) return staged
      const run = host.runPython('src/domain/commitments/tools/commitment-apply.py',
        ['--step', 'po', '--request', staged.path, '--ui-shared', host.sharedDir,
          '--ledger-contractor', ledgerC(), '--ledger-supplier', ledgerS(), '--now', host.now()])
      const json = run.json ?? {}
      return { ok: run.ok && json.ok === true, code: json.refusal?.code ?? (json.ok ? 'issued' : 'writer-failed'),
        reason: json.refusal?.reason ?? run.reason ?? '',
        next_action: json.refusal?.next_action ?? json.next_action ?? '看 stdout 定位唯一写者的拒绝原因',
        result: { po_id: json.po_id ?? null, award_id: json.award_id ?? null, chain: json.chain ?? null,
          trace_mode: json.trace_mode ?? null, total_amount: json.total_amount ?? null,
          applied: json.applied ?? [], ledger_added: json.ledger_added ?? 0 } }
    } }))

  // ------------------------------------------------------------------ 供应商侧
  out.push(surface.panel({ plugin_id: me, id: 'award.inbox', title: '发给我的授标意向（只出自己那份）',
    view: 'supplier', order: 50, kind: 'table', actions: ['award.confirm'],
    data: () => {
      const realm = realmOf('supplier')
      const all = host.readJson(intentFile())
      if (!Array.isArray(all) || !all.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-award-intent',
          next_action: '等承包商在 APP 里提出授标意向（意向本身不产生义务）',
          columns: [{ key: 'intent_id', label: '意向' }], rows: [] }
      }
      const mine = all.filter((item) => !realm || !(item.delivered_to ?? []).length
        || (item.delivered_to ?? []).map(String).includes(realm))
      const confirmedIds = new Set(typeRows(host.rows('supplier'), 'award/confirmed')
        .map((row) => asText(bodyOf(row).intent_id)))
      return { ok: true, kind: 'table',
        columns: [{ key: 'intent_id', label: '意向', type: 'code' }, { key: 'package_id', label: '包', type: 'code' },
          { key: 'quote_id', label: '我的报价', type: 'code' }, { key: 'lines', label: '条目' },
          { key: 'reason', label: '对方理由' }, { key: 'confirmed', label: '我确认了吗' }],
        rows: mine.map((item) => ({ id: String(item.intent_id), intent_id: item.intent_id,
          package_id: item.package_id, quote_id: item.quote_id,
          lines: (item.lines ?? []).map((line) => `${line.item_id}×${line.qty}@${line.unit_price_cents ?? line.unit_price}`).join(' '),
          reason: item.reason ?? '', confirmed: confirmedIds.has(asText(item.intent_id)) ? '已确认' : '待确认' })),
        row_actions: ['award.confirm'], counts: { intents: mine.length },
        note: '确认是**你自己**的动作（只确认自己那份报价对应的意向）；确认不等于承诺' }
    } }))

  out.push(surface.panel({ plugin_id: me, id: 'award.confirmed', title: '我确认过的授标（本侧账本）',
    view: 'supplier', order: 60, kind: 'table',
    data: () => {
      const rows = typeRows(host.rows('supplier'), 'award/confirmed').map((row) => bodyOf(row))
      if (!rows.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-confirmation',
          next_action: '收到授标意向后在「发给我的授标意向」里确认',
          columns: [{ key: 'intent_id', label: '意向' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        columns: [{ key: 'intent_id', label: '意向', type: 'code' }, { key: 'quote_id', label: '报价', type: 'code' },
          { key: 'confirmed_by', label: '确认人', type: 'code' }, { key: 'confirmed_at', label: '确认时刻' }],
        rows: rows.map((row) => ({ id: row.intent_id, ...row })), counts: { confirmations: rows.length } }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'award.confirm', title: '确认授标（人签）', views: ['supplier'],
    group: '授标', order: 40, permission: 'human-signature',
    confirm: { required: true, message: '确认这份意向（不是承诺，但对方要凭它才能承诺）：确认？' },
    hint: '写自己账本 award/confirmed + 承包商账本一条同名登记（双向登记）',
    input: { fields: [
      { name: 'intent_id', label: '意向 id', type: 'text', required: true, help: '从「发给我的授标意向」里复制' },
      { name: 'signature', label: '署名（人签）', type: 'signature', required: true, help: 'human:<你的名字>' },
      { name: 'note', label: '备注', type: 'text' },
    ] },
    server: async (ctx, input) => {
      const staged = host.stage('commitment-apply', { kind: 'commitment-apply', action: 'confirm', view: 'supplier',
        intent_id: asText(input.intent_id), note: String(input.note ?? ''), actor: asText(input.signature) })
      if (!staged.ok) return staged
      const run = host.runPython('src/domain/commitments/tools/commitment-apply.py',
        ['--step', 'confirm', '--request', staged.path, '--ui-shared', host.sharedDir,
          '--ledger-contractor', ledgerC(), '--ledger-supplier', ledgerS(), '--now', host.now()])
      const json = run.json ?? {}
      return { ok: run.ok && json.ok === true, code: json.refusal?.code ?? (json.ok ? 'confirmed' : 'writer-failed'),
        reason: json.refusal?.reason ?? run.reason ?? '',
        next_action: json.refusal?.next_action ?? json.next_action ?? '看 stdout 定位唯一写者的拒绝原因',
        result: { intent_id: json.intent_id ?? null, applied: json.applied ?? [],
          ledger_added: json.ledger_added ?? 0, duplicates: json.duplicates ?? [] } }
    } }))

  // ---- 工作台（首屏「我今天要做什么」）：待人工门队列 + 待确认意向 --------------------------------
  out.push(surface.panel({ plugin_id: me, id: 'home.gates', title: '待人工门与待确认（必须人签的动作）',
    view: 'home', order: 30, kind: 'list',
    data: () => {
      const cRows = host.rows('contractor')
      const last = new Map()
      for (const row of cRows) {
        if (!String(row?.type ?? '').startsWith('approval/')) continue
        const body = bodyOf(row)
        const id = asText(body.approval_id)
        if (id) last.set(id, { type: String(row.type), scope: body.scope, ref: body.ref })
      }
      const items = []
      for (const [id, gate] of last) {
        if (gate.type === 'approval/granted' || gate.type === 'approval/aborted') continue
        items.push({ level: 'warn', title: `人工门 ${id} 还在等（${gate.scope}）`,
          body: `对象 ${gate.ref}`, next_action: '在承包商道「授标与订单」里人签；界面不代签' })
      }
      const intents = typeRows(cRows, 'award/intent-proposed').length
      const awards = typeRows(cRows, 'award/committed').length
      const pos = typeRows(cRows, 'po/issued').length
      items.push({ level: awards ? 'ok' : 'info', title: `授标链：意向 ${intents} · 承诺 ${awards} · PO ${pos}`,
        body: '承诺要三样门：意向 + 供应商确认 + 人工批准', next_action: awards ? '发 PO（人签）' : '先提意向' })
      const supplierIntents = typeRows(host.rows('supplier'), 'award/confirmed').length
      if (supplierIntents === 0) {
        items.push({ level: 'info', title: '供应商侧：还没有确认过授标',
          body: '发给供应商的意向在供应商道「发给我的授标意向」里', next_action: '让对方确认（人签）' })
      }
      return { ok: true, kind: 'list', items }
    } }))

  out.push(surface.shortcut({ plugin_id: me, id: 'shortcut.award-propose', keys: 'a', action: 'award.propose',
    title: '提出授标意向', order: 40 }))

  // ------------------------------------------------------------------ 通知与状态（**待人工门队列**）
  out.push(surface.notificationSource({ plugin_id: me, id: 'notify.gates', title: '待人工门（授标链）',
    order: 30, poll: () => {
      const rows = host.rows('contractor')
      const last = new Map()
      for (const row of rows) {
        if (!String(row?.type ?? '').startsWith('approval/')) continue
        const body = bodyOf(row)
        const id = asText(body.approval_id)
        if (id) last.set(id, { type: row.type, scope: body.scope, ref: body.ref })
      }
      const items = []
      for (const [id, item] of last) {
        if (item.type === 'approval/granted' || item.type === 'approval/aborted') continue
        items.push({ id: `gate:${id}`, level: 'warn', at: '', ref: item.ref,
          title: `人工门 ${id} 还在等（${item.scope}）`,
          body: `对象 ${item.ref} —— 承诺类动作没有人工批准就落不了账`,
          next_action: '在「授标与订单」里用对应的动作（人签）批准；或先看「审批与变更」页等多久' })
      }
      for (const row of host.rows('supplier')) {
        if (String(row?.type ?? '') !== 'award/intent-proposed') continue
        items.push({ id: `intent:${bodyOf(row).intent_id}`, level: 'info', at: `${row.ts ?? ''}`,
          title: `承包商提出了授标意向 ${bodyOf(row).intent_id ?? ''}`, body: '等你确认',
          next_action: '在「发给我的授标意向」里确认（人签）' })
      }
      return items
    } }))

  out.push(surface.statusItem({ plugin_id: me, id: 'status.award', title: '授标', order: 40, read: () => {
    const rows = host.rows('contractor')
    const awards = typeRows(rows, 'award/committed').length
    const pos = typeRows(rows, 'po/issued').length
    const intents = typeRows(rows, 'award/intent-proposed').length
    return { text: `意向 ${intents} · 承诺 ${awards} · PO ${pos}`, level: awards ? 'ok' : 'warn',
      next_action: awards ? '' : '授标承诺要人签，且要有供应商确认与人工批准' }
  } }))

  return out
}
