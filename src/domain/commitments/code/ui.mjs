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
          po_id: po?.po_id ?? '', chain: po?.chain ?? '',
          ref: { kind: 'award', id: award?.award_id ?? intentId,
            title: award ? `授标 ${award.award_id}` : `意向 ${intentId}` } })
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
      // 唯一写者的 `next_action` 里偶尔提到走查脚本（`本脚本 --step confirm`）——产品界面不该教用户回终端，
      // 这里换成**界面内**的下一步（写者原文仍留在 `result.writer_next_action` 里可查）。
      const writerNext = asText(json.next_action)
      const inAppNext = (writerNext && /本脚本|--step|PYTHONPATH/.test(writerNext))
        ? '等供应商在 APP 里确认中标（供应商道「确认授标」/ 通知中心「去处理」）；'
          + '确认 + 人工批准齐备后，在「授标链」行内点「授标承诺（人签）」'
        : writerNext
      return { ok: run.ok && json.ok === true, code: json.refusal?.code ?? (json.ok ? 'proposed' : 'writer-failed'),
        reason: json.refusal?.reason ?? run.reason ?? '',
        next_action: json.refusal?.next_action ?? inAppNext ?? '看 stdout 定位唯一写者的拒绝原因',
        result: { intent_id: json.intent_id ?? null, applied: json.applied ?? [], envelope: json.envelope ?? null,
          ledger_added: json.ledger_added ?? 0, duplicates: json.duplicates ?? [],
          writer_next_action: writerNext || null } }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'award.commit', title: '授标承诺（人签）', views: ['contractor'],
    group: '授标', order: 20, permission: 'human-signature', object_kind: 'award',
    confirm: { required: true, message: '授标承诺＝对外义务：确认以你的署名承诺？' },
    hint: '三样门齐备才落账：意向 + 供应商确认 + 人工批准（approval/requested → granted → award/committed）',
    input: { fields: [
      { name: 'intent_id', label: '意向 id', type: 'text', required: true, from_route: true,
        help: '从「授标链」表里复制（awin-…）；在授标对象页上会自动填当前这一条' },
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
        next_action: json.refusal?.next_action
          ?? (json.ok === true ? '已成立：' + (json.award_id ?? 'aw-…') + ' 已落账（授权人 = 你的会话身份）。下一步：在「授标链」行内点「发 PO（人签）」逐行派生采购单'
            : (json.next_action ?? '看 result / stdout 定位唯一写者的输出（这条路才是失败）')),
        result: { award_id: json.award_id ?? null, approval_id: json.approval_id ?? null,
          applied: json.applied ?? [], ledger_added: json.ledger_added ?? 0, duplicates: json.duplicates ?? [] } }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'po.issue', title: '发 PO（人签）', views: ['contractor'],
    group: '授标', order: 30, permission: 'human-signature', object_kind: 'award',
    confirm: { required: true, message: '发 PO 是承诺类动作：确认以你的署名发出？' },
    hint: 'PO 只能由承诺派生；行与价都从中标条目派生（不得在界面上自由改价）',
    input: { fields: [
      { name: 'award_id', label: '承诺 id', type: 'text', required: true, from_route: true,
        help: '从「授标链」表里复制（aw-…）；在授标对象页上会自动填当前这一条' },
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
        next_action: json.refusal?.next_action
          ?? (json.ok === true ? '已签发：' + (json.po_id ?? 'po-…') + '（追溯模式 ' + (json.trace_mode ?? '—') + '）。下一步：点行内「追溯这条 PO」看四段链路，或把 PO 对象页深链发给供应商'
            : (json.next_action ?? '看 result / stdout 定位唯一写者的输出（这条路才是失败）')),
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
      { name: 'intent_id', label: '意向 id', type: 'text', required: true,
        help: '从「发给我的授标意向」里复制（或点通知中心那条「去处理」自动带上）' },
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
        next_action: json.refusal?.next_action
          ?? (json.ok === true ? '已确认：对方侧（承包商）的「授标承诺」现在可以提交了（确认不等于承诺）。下一步回承包商侧的授标链看状态'
            : (json.next_action ?? '看 result / stdout 定位唯一写者的输出（这条路才是失败）')),
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
          body: `对象 ${gate.ref}`, next_action: '在承包商道「授标与订单」里人签；界面不代签',
          ref: gate.scope === 'change.approve' ? { kind: 'change', id: String(gate.ref) } : null,
          action: gate.scope === 'change.approve' ? 'change.approve'
            : (gate.scope === 'award.commit' ? 'award.commit' : '') ,
          label: gate.scope === 'change.approve' ? '去批准这条变更' : '去人签' })
      }
      const intents = typeRows(cRows, 'award/intent-proposed').length
      const awards = typeRows(cRows, 'award/committed').length
      const pos = typeRows(cRows, 'po/issued').length
      items.push({ level: awards ? 'ok' : 'info', title: `授标链：意向 ${intents} · 承诺 ${awards} · PO ${pos}`,
        body: '承诺要三样门：意向 + 供应商确认 + 人工批准',
        action: awards ? 'po.issue' : 'award.propose',
        label: awards ? '发 PO（人签）' : '先提授标意向' })
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
      // 供应商侧「待确认中标」：读**授标意向信封**（与 award.inbox 面板同一来源；意向不在供应商账本里，
      // 只通过信封投递 —— P3 走查实测：原来这里读的是供应商账本，导致供应商的通知中心里看不到"待你确认"）。
      const realm = realmOf('supplier')
      const envelope = host.readJson(intentFile())
      const myQuotes = new Set(host.rows('supplier').filter((row) => String(row?.type ?? '') === 'quote/submitted')
        .map((row) => asText(bodyOf(row).quote_id)))
      const confirmedIds = new Set(host.rows('supplier').filter((row) => String(row?.type ?? '') === 'award/confirmed')
        .map((row) => asText(bodyOf(row).intent_id)))
      for (const item of (Array.isArray(envelope) ? envelope : [])) {
        const intentId = asText(item.intent_id)
        if (intentId === '' || confirmedIds.has(intentId)) continue
        const delivered = (item.delivered_to ?? []).map(String)
        // 可见性：**引用的报价是我提交过的那份**，或信封投递名单含我的 realm（与 clarify 侧同一口径；
        // 只用 realm 匹配会在"信封 realm 与账本 realm 不一致"时漏掉应看到的意向）
        const mineByQuote = asText(item.quote_id) !== '' && myQuotes.has(asText(item.quote_id))
        const mineByRealm = delivered.length > 0 && realm !== '' && delivered.includes(realm)
        if (!mineByQuote && !mineByRealm) continue
        items.push({ id: `intent:${intentId}`, level: 'warn', at: '',
          title: `承包商提出了授标意向 ${intentId}`,
          body: `包 ${asText(item.package_id)} · ${(item.lines ?? []).length} 条目 · 等你确认（人签）`,
          next_action: '点下面的按钮确认（署名 = 你的会话身份）',
          action: 'award.confirm', preset: { intent_id: intentId },
          ref: asText(item.quote_id) === '' ? null : { view: 'supplier', kind: 'quote',
            id: asText(item.quote_id), title: `报价 ${asText(item.quote_id)}` } })
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

  // ------------------------------------------------------------------ PO 页与追溯链（DEF-027）
  const changeTool = 'src/domain/commitments/tools/change-apply.py'
  const TRACE_KEY = 'po-trace'
  const rowByType = (rows, type) => rows.filter((row) => String(row?.type ?? '') === type).map((row) => bodyOf(row))
  const posOf = (rows) => rowByType(rows, 'po/issued')
  const awardsOf = (rows) => rowByType(rows, 'award/committed')
  const intentsOf = (rows) => rowByType(rows, 'award/intent-proposed')

  /**
   * PO 的追溯链（**唯一一处**计算：行内动作与对象页 `/app/<view>/po/<id>/` 共用同一份，避免两处漂移）。
   * 返回 `null` = 本侧账本里没有这条 PO（调用方据此渲染未命中态，不编内容）。
   */
  const traceOf = (poId, view = 'contractor') => {
    const rows = host.rows(view)
    const po = posOf(rows).find((item) => asText(item.po_id) === asText(poId))
    if (!po) return null
    const award = awardsOf(rows).find((item) => asText(item.award_id) === asText(po.award_id)) ?? {}
    const intent = intentsOf(rows).find((item) => asText(item.intent_id) === asText(po.intent_id)) ?? {}
    const base = `${host.prefix}/app/${view}/`
    return {
      po_id: po.po_id, chain: po.chain, trace_mode: po.trace_mode, total_amount: po.total_amount,
      approved_by: po.approved_by, issued_at: po.issued_at, approval_id: po.approval_id,
      award_id: po.award_id, intent_id: po.intent_id, quote_id: po.quote_id,
      segments: [
        { kind: 'po', id: po.po_id, label: `PO ${po.po_id}`, where: '承包商道 › 授标与订单 › 采购单',
          fact: `${(po.lines ?? []).length} 行 · 金额 ${po.total_amount} · ${po.issued_at}`,
          href: `${base}po/${encodeURIComponent(asText(po.po_id))}/` },
        { kind: 'award', id: po.award_id, label: `承诺 ${po.award_id}`, where: '承包商道 › 授标与订单 › 授标链',
          fact: `批准人 ${po.approved_by} · 人工门 ${po.approval_id}`,
          href: `${base}award/${encodeURIComponent(asText(po.award_id))}/` },
        { kind: 'intent', id: po.intent_id, label: `意向 ${po.intent_id}`, where: '承包商道 › 授标与订单 › 授标链',
          fact: `中标行 ${((award.lines ?? intent.lines ?? []).length)} 条`,
          href: `${base}award/${encodeURIComponent(asText(po.intent_id))}/` },
        { kind: 'quote', id: po.quote_id, label: `报价 ${po.quote_id}`, where: '承包商道 › 报价收件箱 / 比价',
          fact: `${(intent.lines ?? []).length} 行快照`,
          href: `${base}quote/${encodeURIComponent(asText(po.quote_id))}/` },
      ],
      lines: (po.lines ?? []).map((line) => ({ ref_line: line.ref_line, qty: line.qty,
        unit_price: line.unit_price, basis: line.basis, trace: line.trace,
        quote_id: po.quote_id, href: `${base}quote/${encodeURIComponent(asText(po.quote_id))}/` })),
      note: '链路四段都能点（每段给出所在页面与事实摘要）；行内 `basis` 指向中标报价条目，'
        + '点报价段进「报价收件箱/比价」页核对',
    }
  }

  out.push(surface.panel({ plugin_id: me, id: 'po.list', title: '采购单（PO）：逐行可追溯',
    view: 'contractor', order: 50, kind: 'table', actions: ['po.trace'],
    data: () => {
      const rows = host.rows('contractor')
      const pos = posOf(rows)
      if (!pos.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-po',
          next_action: 'PO 只能由承诺派生：先在「授标链」里提意向 → 对方确认 → 人签承诺 → 人签发 PO',
          columns: [{ key: 'po_id', label: 'PO' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        columns: [
          { key: 'po_id', label: 'PO', type: 'code' }, { key: 'award_id', label: '承诺', type: 'code' },
          { key: 'intent_id', label: '意向', type: 'code' }, { key: 'quote_id', label: '报价', type: 'code' },
          { key: 'line_count', label: '行数' }, { key: 'trace_mode', label: '追溯模式' },
          { key: 'total_amount', label: '金额（元）' }, { key: 'approved_by', label: '签发人', type: 'code' },
          { key: 'chain', label: '链路' }, { key: 'issued_at', label: '签发时刻' },
        ],
        rows: pos.map((po) => ({ id: String(po.po_id), po_id: po.po_id, award_id: po.award_id,
          intent_id: po.intent_id, quote_id: po.quote_id, line_count: (po.lines ?? []).length,
          trace_mode: po.trace_mode, total_amount: po.total_amount, approved_by: po.approved_by,
          chain: po.chain, issued_at: po.issued_at,
          ref: { kind: 'po', id: String(po.po_id), title: `PO ${po.po_id}` } })),
        row_actions: ['po.trace'], counts: { po: pos.length },
        note: '行内「打开 →」是这条 PO 的**对象深链**（可复制分享、刷新不丢）；'
          + '「追溯这条 PO」把链路摊到下方，两者同一份计算'
      }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'po.trace', title: '追溯这条 PO（四段可点）',
    views: ['contractor'], group: '授标', order: 40, inline: true, object_kind: 'po',
    hint: '只读：把 po → 承诺 → 意向 → 报价 的链路与逐行 basis 摊开（账本零新增）',
    input: { fields: [
      { name: 'po_id', label: 'PO id', type: 'text', required: true, help: '从 PO 列表行里取（po-…）' },
    ] },
    server: async (ctx, input) => {
      const poId = asText(input.po_id) || asText(ctx.route?.id)
      const trace = traceOf(poId, 'contractor')
      if (!trace) {
        return { ok: false, code: 'po-not-found', reason: `本侧账本里没有 PO ${poId}`,
          next_action: `从 PO 列表列出的真 po_id 里选一条，或直接打开对象深链 ${host.prefix}/app/contractor/po/<id>/` }
      }
      host.note.set(me, TRACE_KEY, trace)
      return { ok: true, code: 'traced',
        next_action: '链路已摊到下方「追溯链」面板：四段与逐行 basis 都能点'
          + `（也可以直接把 ${host.prefix}/app/contractor/po/${asText(poId)}/ 发给同事）`,
        result: trace }
    } }))

  // ---- **对象页**：`/app/contractor/po/<po-id>/`（刷新不丢、可复制分享；不再依赖上面那条内存便签） ----
  out.push(surface.panel({ plugin_id: me, id: 'po.object', title: 'PO 追溯（对象页）', view: 'contractor',
    order: 50, kind: 'kv', object_kind: 'po',
    data: (ctx) => {
      const poId = asText(ctx.route?.id)
      const trace = traceOf(poId, 'contractor')
      if (!trace) {
        return { ok: true, kind: 'kv', object: { found: false, title: `PO ${poId}`,
          reason: 'po-not-in-my-view',
          next_action: '这条 PO 不在承包商侧账本的投影里：回「采购单（PO）」列表，'
            + '点行内「打开 →」用真实存在的深链' }, items: [] }
      }
      return { ok: true, kind: 'kv',
        object: { title: `PO ${trace.po_id}`, subtitle: `${trace.chain} · 追溯模式 ${trace.trace_mode}`
          + ` · 签发 ${trace.issued_at}`, found: true,
          facts: [
            { key: '金额', value: String(trace.total_amount) },
            { key: '行数', value: String((trace.lines ?? []).length) },
            { key: '签发人（人签）', value: trace.approved_by, code: true },
            { key: '人工门', value: trace.approval_id, code: true },
            { key: '报价', value: trace.quote_id, code: true },
          ],
          links: (trace.segments ?? []).filter((seg) => seg.kind !== 'po') },
        items: [
          { key: '链路', value: trace.chain, code: true },
          { key: '追溯模式', value: `${trace.trace_mode}（full=逐行可回溯；ref-only=只给引用）` },
          { key: '逐行', value: `${(trace.lines ?? []).length} 行（见下方明细表）` },
          { key: '事实时刻', value: trace.issued_at },
        ],
        note: '这一页**只看**账本事实：PO 由承诺派生、逐行引用中标条目，界面上不提供任何改价入口' }
    } }))

  out.push(surface.panel({ plugin_id: me, id: 'po.object-lines', title: 'PO 逐行明细（单价基准可点）',
    view: 'contractor', order: 51, kind: 'table', object_kind: 'po',
    data: (ctx) => {
      const trace = traceOf(asText(ctx.route?.id), 'contractor')
      if (!trace) {
        return { ok: true, kind: 'table', degraded: true, reason: 'po-not-in-my-view',
          columns: [{ key: 'ref_line', label: 'PO 行' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        columns: [{ key: 'ref_line', label: 'PO 行', type: 'code' }, { key: 'qty', label: '量' },
          { key: 'unit_price', label: '单价' }, { key: 'basis', label: '单价基准（中标报价条目）', type: 'code' },
          { key: 'trace', label: '追溯模式' }],
        rows: (trace.lines ?? []).map((line) => ({ id: String(line.ref_line), ...line })),
        counts: { lines: (trace.lines ?? []).length },
        note: '每一行的 `basis` 指向中标报价里的条目；缺基准的行不会出现在 PO 里（`po-line-not-derived` 会拒绝签发）' }
    } }))

  out.push(surface.panel({ plugin_id: me, id: 'po.detail', title: '追溯链（PO → 承诺 → 意向 → 报价，全链可点）',
    view: 'contractor', order: 52, kind: 'html',
    data: () => {
      const trace = host.note.get(me, TRACE_KEY, null)
      const rows = host.rows('contractor')
      const pos = posOf(rows)
      if (!trace) {
        return { ok: true, kind: 'html', html: `<p class="q-hint">还没有选中的 PO。`
          + (pos.length ? '在上面的 PO 列表里点某一行「追溯这条 PO」或「打开 →」（对象页会显示同一条链路）。'
            : '本侧账本里还没有 PO：PO 只能由承诺派生（提意向 → 对方确认 → 人签承诺 → 人签发 PO）。')
          + `</p><p class="q-hint">深链：<code>${host.prefix}/app/contractor/po/&lt;po-id&gt;/</code>`
          + '（从列表行「打开 →」拿真 id）</p>' }
      }
      const seg = (item) => `<li><a href="${item.href}" title="去 ${item.where}">${item.label}</a>`
        + ` —— <code>${item.id}</code><br><small>${item.where} · ${item.fact}</small></li>`
      const lines = (trace.lines ?? []).map((line) => `<tr><td><code>${line.ref_line}</code></td>`
        + `<td>${line.qty}</td><td>${line.unit_price}</td>`
        + `<td><a href="${line.href}" title="去报价收件箱/比价核对这条基准"><code>${line.basis}</code></a></td>`
        + `<td>${line.trace}</td></tr>`).join('')
      return { ok: true, kind: 'html', html: `<p class="q-hint"><b>${trace.chain}</b> · 追溯模式 `
        + `<code>${trace.trace_mode}</code> · 金额 ${trace.total_amount} · 签发 ${trace.issued_at}`
        + ` · 人工门 <code>${trace.approval_id}</code>（${trace.approved_by}）</p>`
        + `<ol class="q-list">${(trace.segments ?? []).map(seg).join('')}</ol>`
        + `<div class="q-scroll"><table class="q-table"><thead><tr><th>PO 行</th><th>量</th><th>单价</th>`
        + `<th>单价基准（可点）</th><th>追溯模式</th></tr></thead><tbody>${lines}</tbody></table></div>`
        + `<p class="q-hint">${trace.note}</p>` }
    } }))

  // ---- **对象页**：`/app/contractor/award/<awin-… 或 aw-…>/`（意向 → 确认 → 承诺 → PO 四段） ----
  out.push(surface.panel({ plugin_id: me, id: 'award.object', title: '授标（对象页：四段状态）',
    view: 'contractor', order: 41, kind: 'kv', object_kind: 'award',
    data: (ctx) => {
      const id = asText(ctx.route?.id)
      const rows = host.rows('contractor')
      const intents = intentsOf(rows)
      const awards = awardsOf(rows)
      const intent = intents.find((item) => asText(item.intent_id) === id
        || asText(item.award_id) === id) ?? intents.find((item) => {
        const award = awards.find((row) => asText(row.intent_id) === asText(item.intent_id))
        return award && asText(award.award_id) === id
      })
      if (!intent) {
        return { ok: true, kind: 'kv', object: { found: false, title: `授标 ${id}`, reason: 'award-not-in-my-view',
          next_action: '这条授标不在承包商侧投影里：回「授标链」表，点行内「打开 →」用真实存在的深链' },
          items: [] }
      }
      const intentId = asText(intent.intent_id)
      const award = awards.find((item) => asText(item.intent_id) === intentId)
      const po = award ? posOf(rows).find((item) => asText(item.award_id) === asText(award.award_id)) : null
      const confirmed = typeRows(rows, 'award/confirmed').map((row) => bodyOf(row))
        .find((row) => asText(row.intent_id) === intentId)
      const base = `${host.prefix}/app/contractor/`
      const step = (label, done, fact) => ({ key: label, value: done ? `✅ ${fact}` : `⏳ ${fact}` })
      return { ok: true, kind: 'kv',
        object: { title: `授标 ${intentId}`, subtitle: `报价 ${intent.quote_id ?? '—'} ·`
          + ` 包 ${intent.package_id ?? '—'}`, found: true,
          facts: [
            { key: '状态', value: award ? (po ? '已承诺 + 已发 PO' : '已承诺（待发 PO）') : '仅有意向（未承诺）' },
            { key: '中标行', value: String((intent.lines ?? []).length) },
            { key: '报价', value: asText(intent.quote_id), code: true },
          ],
          links: [
            { kind: 'quote', id: asText(intent.quote_id), title: `报价 ${intent.quote_id}` },
            { kind: 'package', id: asText(intent.package_id), title: `包 ${intent.package_id}` },
          ].filter((link) => link.id !== '') },
        items: [
          step('① 意向', true, `已提出（${intent.proposed_at ?? '—'}）`),
          step('② 供应商确认', Boolean(confirmed), confirmed
            ? `${confirmed.confirmed_by} @ ${confirmed.confirmed_at}` : '还没确认（对方要在它自己的界面确认）'),
          step('③ 人签承诺', Boolean(award), award ? `${award.award_id} · ${award.approved_by}` : '还没承诺'),
          step('④ 发 PO', Boolean(po), po ? `${po.po_id}` : '还没签发'),
        ],
        note: `承诺与 PO 都必须**人签**且要过人工门（INV-005）；这一页只读。`
          + `${po ? ` PO 深链：${base}po/${encodeURIComponent(asText(po.po_id))}/` : ''}` }
    } }))

  // ---- **对象页**：`/app/contractor/change/<chg-…>/`（逐行差异 + 批准判定） ----
  out.push(surface.panel({ plugin_id: me, id: 'change.object', title: '变更单（对象页：逐行差异）',
    view: 'contractor', order: 61, kind: 'table', object_kind: 'change',
    data: (ctx) => {
      const id = asText(ctx.route?.id)
      const rows = host.rows('contractor')
      const change = changeRows(rows).find((item) => asText(item.change_id) === id)
      if (!change) {
        return { ok: true, kind: 'table', object: { found: false, title: `变更单 ${id}`,
          reason: 'change-not-in-my-view',
          next_action: '这条变更单不在承包商侧投影里：回「变更与价格让步」列表，点行内「打开 →」用真实存在的深链' },
          columns: [{ key: 'change_id', label: '变更' }], rows: [] }
      }
      const decision = changeDecisions(rows).get(asText(change.change_id))
      const status = change.status === 'approved' ? '已批准（生效）'
        : (decision?.decision === 'denied' ? `已驳回（${decision.by}）` : '待批（未生效，不计金额）')
      return { ok: true, kind: 'table',
        object: { title: `变更单 ${change.change_id}`, subtitle: `报价 ${change.quote_id} · ${status}`, found: true,
          facts: [
            { key: '差额', value: String(change.delta_amount ?? 0) },
            { key: '状态', value: status },
            { key: '批准人', value: change.approved_by ?? '—' },
            { key: '理由', value: String(change.reason ?? '') },
          ],
          links: [{ kind: 'quote', id: asText(change.quote_id), title: `报价 ${change.quote_id}` }]
            .filter((link) => link.id !== '') },
        columns: [{ key: 'ref_line', label: '行', type: 'code' }, { key: 'old_qty', label: '原量' },
          { key: 'new_qty', label: '新量' }, { key: 'old_unit_price', label: '原单价（只读）' }],
        rows: (change.lines ?? []).map((line, index) => ({ id: `${line.ref_line ?? line.item_id ?? index}`,
          ref_line: line.ref_line ?? line.item_id, old_qty: line.old_qty, new_qty: line.new_qty,
          old_unit_price: line.old_unit_price ?? '' })),
        counts: { lines: (change.lines ?? []).length },
        note: '未批准的变更**一分钱都不计**；批准/驳回都是人工门（在列表行内点，或本页工具栏的动作）' }
    } }))

  // ------------------------------------------------------------------ 变更与价格让步（DEF-018）
  const changeRows = (rows) => {
    const map = new Map()
    const order = []
    for (const row of rows) {
      const type = String(row?.type ?? '')
      if (!type.startsWith('change/')) continue
      const body = bodyOf(row)
      const id = asText(body.change_id)
      if (!id) continue
      if (!map.has(id)) order.push(id)
      const previous = map.get(id) ?? { change_id: id, quote_id: asText(body.quote_id), status: 'proposed',
        reason: '', lines: [], delta_amount: 0, refs: [], approved_by: null, approval_id: null,
        proposed_at: String(row.ts ?? ''), approved_at: '', rejected_reason: '', mirror: false }
      const next = { ...previous }
      if (type === 'change/proposed') {
        next.quote_id = asText(body.quote_id) || next.quote_id
        next.reason = body.reason ?? next.reason
        next.refs = (body.ref_quote_lines ?? next.refs)
        next.delta = body.delta ?? next.delta
        if (Array.isArray(body.lines) && body.lines.length) next.lines = body.lines
        const mirrored = asText(body.status)
        if (mirrored === 'approved') next.status = 'approved'
        else if (mirrored === 'rejected') next.status = 'rejected'
      } else if (type === 'change/priced') {
        next.lines = body.lines ?? next.lines
        next.delta_amount = body.delta_amount ?? next.delta_amount
      } else if (type === 'change/approved') {
        next.status = 'approved'; next.approved_by = body.approved_by; next.approval_id = body.approval_id
        next.approved_at = String(row.ts ?? '')
      }
      next.mirror = body.mirror === true
      map.set(id, next)
    }
    return order.map((id) => map.get(id))
  }
  const changeDecisions = (rows) => {
    const map = new Map()
    for (const row of rows) {
      if (!String(row?.type ?? '').startsWith('approval/')) continue
      const body = bodyOf(row)
      if (asText(body.scope) !== 'change.approve') continue
      const id = asText(body.ref)
      if (!id) continue
      if (asText(body.status) === 'denied') {
        map.set(id, { decision: 'denied', by: body.decided_by, comment: body.comment ?? '', at: String(row.ts ?? '') })
      } else if (asText(body.status) === 'granted' && !map.has(id)) {
        map.set(id, { decision: 'granted', by: body.decided_by, comment: body.comment ?? '', at: String(row.ts ?? '') })
      }
    }
    return map
  }

  out.push(surface.panel({ plugin_id: me, id: 'change.list', title: '变更与价格让步（提出 / 批准 / 驳回）',
    view: 'contractor', order: 60, kind: 'table', actions: ['change.approve', 'change.reject'],
    data: () => {
      const rows = host.rows('contractor')
      const changes = changeRows(rows)
      const decisions = changeDecisions(rows)
      if (!changes.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-change',
          next_action: '用「提出变更」把现场追加/减少变成一条可追溯的变更单（原单价只读、只改量）',
          columns: [{ key: 'change_id', label: '变更' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        columns: [
          { key: 'change_id', label: '变更', type: 'code' }, { key: 'quote_id', label: '报价', type: 'code' },
          { key: 'lines', label: '逐行（原量→新量 @ 原单价）' },
          { key: 'delta_amount', label: '差额（元，整数分口径见工具输出）' },
          { key: 'status_label', label: '状态' }, { key: 'approved_by', label: '批准人', type: 'code' },
          { key: 'reason', label: '理由' }, { key: 'proposed_at', label: '提出 @ts' },
        ],
        rows: changes.map((change) => {
          const decision = decisions.get(change.change_id)
          const status = change.status === 'approved' ? '已批准（生效）'
            : (decision?.decision === 'denied' ? `已驳回（${decision.by}）` : '待批（未生效，不计金额）')
          return { id: change.change_id, change_id: change.change_id, quote_id: change.quote_id,
            lines: (change.lines ?? []).map((line) => `${line.ref_line ?? line.item_id}: `
              + `${line.old_qty}→${line.new_qty}`
              + `${line.old_unit_price === undefined ? '' : ` @ ${line.old_unit_price}`}`).join(' · '),
            delta_amount: change.delta_amount, status_label: status,
            approved_by: change.approved_by ?? '', reason: change.reason, proposed_at: change.proposed_at,
            reject_comment: decision?.decision === 'denied' ? decision.comment : '',
            ref: { kind: 'change', id: String(change.change_id), title: `变更单 ${change.change_id}` } }
        }),
        row_actions: ['change.approve', 'change.reject'], counts: { changes: changes.length,
          approved: changes.filter((change) => change.status === 'approved').length },
        note: '未批准的变更**一分钱都不计**（`effective_total` 只算已批准项）；批准走人工门 '
          + '`change.approve`（人签），驳回走人工门 denied（理由逐字落 comment）；'
          + '缺单价基准的行会被服务拒（`change/rejected`，拒绝也留痕）' }
    } }))

  out.push(surface.panel({ plugin_id: me, id: 'change.inbox', title: '承包商提出的变更（对方通知）',
    view: 'supplier', order: 80, kind: 'table',
    data: () => {
      const rows = host.rows('supplier')
      const changes = changeRows(rows)
      if (!changes.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-change',
          next_action: '承包商提出变更后这里会出现（带逐行 原量→新量 与差额）',
          columns: [{ key: 'change_id', label: '变更' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        columns: [{ key: 'change_id', label: '变更', type: 'code' }, { key: 'quote_id', label: '我的报价', type: 'code' },
          { key: 'lines', label: '逐行 原量→新量' }, { key: 'delta_amount', label: '差额' },
          { key: 'status_label', label: '状态' }, { key: 'reason', label: '对方理由' }],
        rows: changes.map((change) => ({ id: change.change_id, change_id: change.change_id,
          quote_id: change.quote_id,
          lines: (change.lines ?? []).map((line) => `${line.ref_line ?? line.item_id}: `
            + `${line.old_qty}→${line.new_qty}`).join(' · '),
          delta_amount: change.delta_amount,
          status_label: change.status === 'approved' ? '已批准（生效）'
            : (asText(change.status) === 'rejected' ? '已驳回' : '待回应 / 待批'),
          reason: change.reason })),
        counts: { changes: changes.length },
        note: '只出本侧该看到的字段（逐行差异与差额，不含承包商内部备注）；'
          + '供应商侧的「接受/异议」由供应商道自己的变更页负责' }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'change.propose', title: '提出变更（原单价只读，只改量）',
    views: ['contractor'], group: '变更', order: 10, permission: 'human-signature',
    confirm: { required: true, message: '提出变更不产生对外义务（未批准不计金额）：确认以你的署名提出？' },
    hint: '逐行写 `item_id,新数量`；基准引用自动按 `<报价>#<条目>:unit_price` 填；全部行都没改量会被拒（no-op-change）',
    input: { fields: [
      { name: 'quote_id', label: '报价 id', type: 'text', required: true, help: '从报价收件箱/比价里取' },
      { name: 'lines', label: '逐行变更（每行 `item_id,新数量`）', type: 'textarea', required: true,
        help: '例：L-002,500' },
      { name: 'reason', label: '变更理由', type: 'textarea', required: true },
      { name: 'signature', label: '提出人（人签）', type: 'signature', required: true },
    ] },
    server: async (ctx, input) => {
      const lines = String(input.lines ?? '').split('\n').map((line) => line.trim()).filter(Boolean)
        .map((line) => {
          const [itemId, qty] = line.split(',').map((piece) => piece.trim())
          return { item_id: itemId, new_qty: Number(qty) }
        })
      if (!lines.length) {
        return { ok: false, code: 'lines-required', reason: '没有给任何行变更',
          next_action: '每行写 `item_id,新数量`（如 L-002,500）' }
      }
      const bad = lines.filter((line) => !line.item_id || !Number.isFinite(line.new_qty))
      if (bad.length) {
        return { ok: false, code: 'line-malformed', reason: `这些行写法不对：${JSON.stringify(bad)}`,
          next_action: '每行恰好两段：`item_id,新数量`' }
      }
      const staged = host.stage('change-apply', { kind: 'change-apply', action: 'propose', view: 'contractor',
        quote_id: asText(input.quote_id), lines, actor: asText(input.signature), note: String(input.reason ?? '') })
      if (!staged.ok) return staged
      const run = host.runPython(changeTool, ['--step', 'propose', '--request', staged.path,
        '--ui-shared', host.sharedDir, '--ledger-contractor', asText(host.config?.ledger_contractor),
        '--ledger-supplier', asText(host.config?.ledger_supplier), '--now', host.now()])
      const json = run.json ?? {}
      return { ok: run.ok && json.ok === true, code: json.refusal?.code ?? (json.ok ? 'proposed' : 'writer-failed'),
        reason: json.refusal?.reason ?? run.reason ?? '',
        next_action: json.refusal?.next_action ?? json.next_action_runtime ?? '看 result 里的逐行差额与下一步',
        result: { pending: staged.file, change_id: json.change_id ?? null, delta_amount: json.delta_amount ?? null,
          preview: json.preview ?? [], ledger_added: json.ledger_added ?? 0 } }
    } }))

  const decideAction = (id, step, title, hint) => surface.action({ plugin_id: me, id, title,
    views: ['contractor'], group: '变更', order: step === 'approve' ? 20 : 25, permission: 'human-signature',
    inline: true, object_kind: 'change',
    confirm: { required: true, message: `${title}：确认以你的署名执行？（人工门 change.approve）` },
    hint, input: { fields: [
      { name: 'change_id', label: '变更 id', type: 'text', required: true, from_route: true,
        help: '从变更列表行里取（chg-…）；在变更对象页上会自动填当前这一条' },
      { name: 'signature', label: '署名（人签）', type: 'signature', required: true, help: 'human:<你的名字>' },
      { name: 'comment', label: '意见（驳回必填；逐字落 approval 记录）', type: 'textarea',
        required: step === 'reject' },
    ] },
    server: async (ctx, input) => {
      const staged = host.stage('change-apply', { kind: 'change-apply', action: step, view: 'contractor',
        change_id: asText(input.change_id), actor: asText(input.signature), note: String(input.comment ?? '') })
      if (!staged.ok) return staged
      const run = host.runPython(changeTool, ['--step', step, '--request', staged.path,
        '--ui-shared', host.sharedDir, '--ledger-contractor', asText(host.config?.ledger_contractor),
        '--ledger-supplier', asText(host.config?.ledger_supplier), '--now', host.now()])
      const json = run.json ?? {}
      return { ok: run.ok && json.ok === true, code: json.refusal?.code ?? (json.ok ? step : 'writer-failed'),
        reason: json.refusal?.reason ?? run.reason ?? '',
        next_action: json.refusal?.next_action ?? json.next_action_runtime ?? '看 result 里的账本增量',
        result: { pending: staged.file, change_id: json.change_id ?? null, status: json.status ?? null,
          delta_amount: json.delta_amount ?? null, effective_total: json.effective_total ?? null,
          ledger_added: json.ledger_added ?? 0 } }
    } })

  out.push(decideAction('change.approve', 'approve', '批准变更（人签 · 价格让步）',
    '人工门 change.approve：先落 approval/requested → granted，再落 change/approved（此后计入金额）'))
  out.push(decideAction('change.reject', 'reject', '驳回变更（人签）',
    '人工门 change.approve 的 denied：变更保持 proposed、不进金额；理由逐字落 comment'))

  out.push(surface.notificationSource({ plugin_id: me, id: 'notify.changes', title: '变更待批与对方变更',
    order: 20, poll: () => {
      const items = []
      const rowsOut = host.rows('contractor')
      const decisions = changeDecisions(rowsOut)
      for (const change of changeRows(rowsOut)) {
        if (change.status === 'approved' || decisions.get(change.change_id)?.decision === 'denied') continue
        items.push({ id: `change:${change.change_id}`, level: 'warn', at: change.proposed_at, ref: change.change_id,
          title: `待批变更 ${change.change_id}（差额 ${change.delta_amount}）`,
          body: `报价 ${change.quote_id} · ${(change.lines ?? []).length} 行 · 未批准前不计金额`,
          next_action: '去「变更与价格让步」点「批准变更」或「驳回变更」（人签）' })
      }
      for (const row of host.rows('supplier')) {
        if (String(row?.type ?? '') !== 'change/proposed') continue
        const body = bodyOf(row)
        if (body.mirror !== true) continue
        items.push({ id: `change:s:${body.change_id}:${row.ts ?? ''}`, level: 'info', at: String(row.ts ?? ''),
          title: `承包商提出变更 ${asText(body.change_id)}（差额 ${body.delta_amount}）`,
          body: `${(body.lines ?? []).length} 行 · 状态 ${asText(body.status) || 'proposed'}`,
          next_action: '看供应商道「承包商提出的变更」面板' })
      }
      return items
    } }))

  return out
}
