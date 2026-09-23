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
 *   · 面板 `po.inbox` / `po.object-received` / `po.object-lines-received` / `po.prereqs`：
 *     **发给我的采购单**（逐行 + 追溯链 + 执行前提），行来自**本侧账本**的 `po/distributed`
 *     （投递登记：由签发方的唯一写者写），投递信封 `<ui-shared>/exchange/po-deliveries.json` 只补
 *     `delivered_at`/收件人这类投递面读数；`delivered_to` 不含我这条的**根本不出现在输出里**；
 *   · 动作 `po.acknowledge`（**human-signature**）：--step acknowledge（回签：自己账本 `po/acknowledged` +
 *     承包商账本一条同名登记）；
 *   · 导出 `po.export-received` + 声明 `report.po-received`：把**收到的那张 PO** 导出/打印
 *     （行与价只用本侧事实，行内带 `basis` 与追溯链）。
 *
 * 纪律：本文件不写账本（只 spawn 唯一写者）；**承诺与 PO 都必须人签**，且必须带人工批准记录（INV-005）；
 * 回签同样是**人签**（署名 = 会话身份，服务端在动作总线上校验）。
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
  const deliveryFile = () => `${host.sharedDir}/exchange/po-deliveries.json`
  /**
   * 本侧 realm（= 身份）。
   *
   * ⚠ 机制给插件的 `host.rows(view)` 是**只读投影**（`kernel/code/ledger-view.mjs` 的 `rows()` 按设计只出
   * `seq/type/correlation_id/actor/ts/body`），**行级的 `realm` 不在里面**；而 `realms()`（身份的真源）
   * 只在宿主内部用（RFQ 投递可见性那套）。所以这里从**本侧账本的登记**里推：先看行级 `realm`
   * （夹具/单账本模式下有），再退到「谁在何时收到」这类登记里的收件人字段
   * （`po/distributed.recipients` / `rfq/distributed.recipients` / `award/confirmed.supplier`）——
   * **只读本侧账本**，不读信封、不猜、不跨侧。读不出来 ⇒ `''`（调用方按 `no-identity` 如实降级）。
   */
  const realmOf = (view) => {
    const rows = host.rows(view)
    const direct = rows.find((row) => asText(row?.realm) !== '')
    if (direct) return asText(direct.realm)
    if (view !== 'supplier') return ''      // 承包商侧没有"我的收件人身份"这回事（那是对方的 realm）
    for (const type of ['po/distributed', 'rfq/distributed']) {
      for (const row of typeRows(rows, type)) {
        const body = bodyOf(row)
        const mine = [body.supplier, ...(body.recipients ?? [])].map(asText).find((item) => item !== '')
        if (mine) return mine
      }
    }
    return typeRows(rows, 'award/confirmed').map(bodyOf).map((body) => asText(body.supplier))
      .find((item) => item !== '') ?? ''
  }
  const poDeliveries = (view) => typeRows(host.rows(view), 'po/distributed').map((row) => bodyOf(row))
  /** 投递信封里**投给本侧**的那几条（`delivered_to` 不含我 ⇒ 根本不进输出，不是"藏起来"）。 */
  const myDeliveryEnvelopes = (realm) => {
    const all = host.readJson(deliveryFile())
    if (!Array.isArray(all)) return []
    if (realm === '') return []
    return all.filter((item) => (item.delivered_to ?? []).map(String).includes(realm))
  }
  /** 本侧回签状态（`po/acknowledged`）：po_id → 最后一条。 */
  const acksOf = (view) => {
    const out = new Map()
    for (const row of typeRows(host.rows(view), 'po/acknowledged')) {
      const body = bodyOf(row)
      const id = asText(body.po_id)
      if (id) out.set(id, body)
    }
    return out
  }
  /**
   * **侧只能来自会话**（机制给出的唯一判据）：本侧的人签动作拒绝另一侧的名字来签。
   * 为什么必须在插件里再判一次：动作总线的身份门只校验「署名 == 会话身份」（防冒名），不校验
   * 「这个动作是不是你这侧的」；而回签/确认这类动作**写的是本侧账本**——另一侧替签等于把
   * 「谁收到了货」写成对方的人（跨侧替签）。判据跑在写任何东西之前：拒绝时账本与待办件零新增。
   *
   * **沙盘例外（机制给的，不是我放宽的）**：沙盘里两侧由**机制生成的演示身份**驱动（29 §11.5：
   * `actors[side]`），会话身份在那里按设计为空（沙盘账本不是真实面）。所以沙盘里按机制给的
   * `host.sandbox.actors[side]` 判「有没有这一侧的演示身份」；**真实面上这条替换不存在**，
   * 仍然要求会话身份（`identity-required`）。
   */
  const sideGuard = (ctx, side, title) => {
    const who = ctx?.identity
    if (who && asText(who.side) !== '') {
      if (asText(who.side) !== side) {
        return { ok: false, code: 'cross-side-action',
          reason: `「${title}」是**${side} 侧**的动作；当前会话是 ${asText(who.side)} 侧（${asText(who.human)}）`,
          next_action: `切到 ${side} 侧的身份再签：人签只能由本侧的人做（跨侧替签一律拒，账本零新增）` }
      }
      return null
    }
    const sandbox = host.sandbox
    if (sandbox?.on) {
      return asText(sandbox.actors?.[side]) !== '' ? null
        : { ok: false, code: 'identity-required',
          reason: `沙盘里没有 ${side} 侧的演示身份：${title}没人能签`,
          next_action: '重开沙盘（`sandbox.clear` → `sandbox.seed`）让机制重新生成两侧的演示身份' }
    }
    return { ok: false, code: 'identity-required', reason: `${title}需要会话身份（侧与署名都取会话）`,
      next_action: `先在 ${host.prefix}/identity/ 登录（账本零新增）` }
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
          { key: 'lines', label: '条目', filter: 'number' }, { key: 'confirmed', label: '供应商确认' },
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
    confirm: { required: true, message: '发 PO 是承诺类动作：确认以你的署名发出并投递给中标供应商？' },
    hint: 'PO 只能由承诺派生；行与价都从中标条目派生（不得在界面上自由改价）；发出即**同步投递**给中标供应商（两侧账本各一条投递登记）',
    input: { fields: [
      { name: 'award_id', label: '承诺 id', type: 'text', required: true, from_route: true,
        help: '从「授标链」表里复制（aw-…）；在授标对象页上会自动填当前这一条' },
      { name: 'signature', label: '署名（人签）', type: 'signature', required: true, help: 'human:<你的名字>' },
      { name: 'delivery_window', label: '交期窗口（随投递登记给供应商）', type: 'text', max: 120,
        help: '如「2026-10-08 前到货」；空着也行，供应商侧会如实显示"对方没给"' },
      { name: 'ship_to', label: '送货地址（随投递登记给供应商）', type: 'text', max: 120,
        help: '如「苏州工业园区 A 区 3 号库」；空着也行' },
      { name: 'reason', label: '批准理由', type: 'text' },
      { name: 'comment', label: '批注（进批准记录）', type: 'text' },
    ] },
    server: async (ctx, input) => {
      const staged = host.stage('commitment-apply', { kind: 'commitment-apply', action: 'po', view: 'contractor',
        award_id: asText(input.award_id), reason: String(input.reason ?? ''), comment: String(input.comment ?? ''),
        delivery_window: asText(input.delivery_window).slice(0, 120),
        ship_to: asText(input.ship_to).slice(0, 120),
        note: '', actor: asText(input.signature) })
      if (!staged.ok) return staged
      const run = host.runPython('src/domain/commitments/tools/commitment-apply.py',
        ['--step', 'po', '--request', staged.path, '--ui-shared', host.sharedDir,
          '--ledger-contractor', ledgerC(), '--ledger-supplier', ledgerS(),
          '--delivery-out', deliveryFile(), '--now', host.now()])
      const json = run.json ?? {}
      return { ok: run.ok && json.ok === true, code: json.refusal?.code ?? (json.ok ? 'issued' : 'writer-failed'),
        reason: json.refusal?.reason ?? run.reason ?? '',
        next_action: json.refusal?.next_action
          ?? (json.ok === true ? '已签发并投递：' + (json.po_id ?? 'po-…') + '（追溯模式 ' + (json.trace_mode ?? '—')
            + '，投给 ' + (json.delivered_to ?? []).join('/') + '）。下一步：对方在供应商道「发给我的采购单」里回签'
            + '(人签)；你也可以点行内「追溯这条 PO」看四段链路'
            : (json.next_action ?? '看 result / stdout 定位唯一写者的输出（这条路才是失败）')),
        result: { po_id: json.po_id ?? null, award_id: json.award_id ?? null, chain: json.chain ?? null,
          trace_mode: json.trace_mode ?? null, total_amount: json.total_amount ?? null,
          delivered_to: json.delivered_to ?? [], delivery: json.delivery ?? null,
          premises: json.premises ?? {},
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
          { key: 'quote_id', label: '我的报价', type: 'code' }, { key: 'lines', label: '条目', filter: 'number' },
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
          { key: 'confirmed_by', label: '确认人', type: 'code' }, { key: 'confirmed_at', label: '确认时刻', filter: 'date' }],
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
      const cross = sideGuard(ctx, 'supplier', '确认授标（人签）')
      if (cross) return cross
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

  // ---------------------------------------------------------------- 供应商侧：**发给我的采购单**
  /**
   * 「发给我的采购单」（P8）：承包商发 PO 时**同步投递**，本侧账本因此多一条 `po/distributed`
   * （收件人侧那条投递登记，由签发方的唯一写者写）。这一组面板/动作全部读**本侧事实**：
   *   · 行逐行来自投递登记的 `lines`（ref_line / qty / unit_price / basis / trace）；
   *   · 追溯链来自 `chain`（po → 承诺 → 意向 → 报价），报价那一段是**本侧自己提交的报价**
   *     （承包商侧的承诺/意向页面对本侧不可见，所以只给文本 + 自己那份报价的深链）；
   *   · 执行前提：交期窗口/送货地址来自投递登记（发 PO 的人给的；没给就如实说"对方没给"），
   *     币种/报价截止来自本侧 `rfq/distributed`（同一个 `package_id` 对得上才用）。
   */
  const poReceivedOf = (poId) => poDeliveries('supplier').find((item) => asText(item.po_id) === asText(poId)) ?? null

  out.push(surface.panel({ plugin_id: me, id: 'po.inbox', title: '发给我的采购单（只出自己那份）',
    view: 'supplier', order: 55, kind: 'table', actions: ['po.acknowledge', 'po.export-received'],
    hint: '逐行 + 追溯链 + 回签状态；打开行内「打开 →」进这张 PO 的对象页（附件、导出、回签都在那里）',
    data: () => {
      const realm = realmOf('supplier')
      const delivered = poDeliveries('supplier')
      const acks = acksOf('supplier')
      const envelopes = new Map(myDeliveryEnvelopes(realm).map((item) => [asText(item.po_id), item]))
      if (realm === '') {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-identity',
          columns: [{ key: 'po_id', label: 'PO' }], rows: [],
          next_action: '本侧账本里还没有 realm（身份）：先在本侧产生一条事实，再回来看投递给你的采购单' }
      }
      if (!delivered.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-po-delivery',
          columns: [{ key: 'po_id', label: 'PO' }], rows: [],
          next_action: '等承包商在 APP 里「发 PO（人签）」——发出即投递，本侧账本会多一条 po/distributed 登记' }
      }
      return { ok: true, kind: 'table',
        columns: [{ key: 'po_id', label: 'PO', type: 'code' }, { key: 'lines', label: '行数', filter: 'number' },
          { key: 'total_amount', label: '金额', filter: 'number' }, { key: 'approved_by', label: '签发人', type: 'code' },
          { key: 'issued_at', label: '签发时刻', filter: 'date' }, { key: 'delivered_at', label: '投递时刻', filter: 'date' },
          { key: 'chain', label: '追溯链' }, { key: 'ack', label: '回签' }],
        rows: delivered.map((item) => {
          const poId = asText(item.po_id)
          const ack = acks.get(poId)
          return { id: poId, po_id: poId, lines: (item.lines ?? []).length,
            total_amount: item.total_amount ?? '', approved_by: item.approved_by ?? '',
            issued_at: item.issued_at ?? '',
            delivered_at: envelopes.get(poId)?.delivered_at ?? asText(item.sent_at),
            recipients: (item.recipients ?? []).join(' / '),
            chain: item.chain ?? '', quote_id: item.quote_id ?? '',
            ack: ack ? `${asText(ack.acknowledged_by)} @ ${asText(ack.acknowledged_at)}` : '待回签',
            ref: { kind: 'po', id: poId, title: `采购单 ${poId}` } }
        }),
        row_actions: ['po.acknowledge', 'po.export-received'], counts: { po: delivered.length },
        note: '行来自**本侧账本**的投递登记（`po/distributed`，签发方写的那条）；投递信封里 `delivered_to` '
          + '不含我这侧的条目**根本不出现在这里**（不是藏起来）' }
    } }))

  out.push(surface.panel({ plugin_id: me, id: 'po.object-received', title: '采购单（对象页：我先看到的那份）',
    view: 'supplier', order: 50, kind: 'kv', object_kind: 'po',
    hint: '事实全部来自本侧账本的投递登记；回签状态来自本侧 po/acknowledged',
    data: (ctx) => {
      const poId = asText(ctx.route?.id)
      const item = poReceivedOf(poId)
      if (!item) {
        return { ok: true, kind: 'kv', object: { found: false, title: `采购单 ${poId}`,
          reason: 'po-not-delivered-to-you',
          next_action: '这条 PO 没有投递到本侧（本侧账本里没有它的投递登记）：回「发给我的采购单」列表，'
            + '点行内「打开 →」用真实存在的深链' }, items: [] }
      }
      const ack = acksOf('supplier').get(poId)
      const myQuote = typeRows(host.rows('supplier'), 'quote/submitted')
        .some((row) => asText(bodyOf(row).quote_id) === asText(item.quote_id))
      const links = myQuote
        ? [{ kind: 'quote', id: asText(item.quote_id), label: `我提交的报价 ${asText(item.quote_id)}`,
          where: '供应商道 › 我的报价', fact: `${(item.lines ?? []).length} 行`,
          href: `${host.prefix}/app/supplier/quote/${encodeURIComponent(asText(item.quote_id))}/` }]
        : []
      return { ok: true, kind: 'kv',
        object: { title: `采购单 ${poId}`, found: true,
          subtitle: `${asText(item.chain)} · 追溯模式 ${asText(item.trace_mode)} · 签发 ${asText(item.issued_at)}`,
          facts: [
            { key: '金额', value: String(item.total_amount ?? '') },
            { key: '行数', value: String((item.lines ?? []).length) },
            { key: '签发人（承包商侧人签）', value: asText(item.approved_by), code: true },
            { key: '投递对象', value: (item.recipients ?? []).join(' / '), code: true },
            { key: '包 / 报价', value: `${asText(item.package_id)} / ${asText(item.quote_id)}`, code: true },
          ],
          links,
          // **分享**（插件声明"对方能不能看"；机制据此写分享弹层与邮件正文）
          share: { visibility: 'both', other_side_view: 'contractor',
            requirements: ['对方要用**承包商侧**的身份登录（签发方）；这张 PO 是按 realm 投递的 —— '
              + '只有投递到本侧的 PO 才会出现在本侧视图里'],
            note: '这是投递给本侧的那一份（本侧账本里有投递登记）；回签件挂在这张 PO 的附件面板上。' } },
        items: [
          { key: '追溯链', value: asText(item.chain), code: true },
          { key: '我回签了吗', value: ack ? `已回签：${asText(ack.acknowledged_by)} @ ${asText(ack.acknowledged_at)}`
            + (asText(ack.note) ? ` · 备注 ${asText(ack.note)}` : '') : '还没有（人签动作「确认收到采购单」）' },
          { key: '投递时刻', value: asText(item.sent_at) },
        ],
        note: '这一页**只看**本侧账本的事实：PO 的行与价由承包商从承诺派生，本侧不提供任何改价入口；'
          + '回签（po/acknowledged）也不改 PO 的任何行与价' }
    } }))

  out.push(surface.panel({ plugin_id: me, id: 'po.object-lines-received', title: '采购单逐行明细（单价基准可核）',
    view: 'supplier', order: 51, kind: 'table', object_kind: 'po',
    data: (ctx) => {
      const item = poReceivedOf(asText(ctx.route?.id))
      if (!item) {
        return { ok: true, kind: 'table', degraded: true, reason: 'po-not-delivered-to-you',
          columns: [{ key: 'ref_line', label: '行项目' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        columns: [{ key: 'ref_line', label: '行项目', type: 'code' }, { key: 'qty', label: '量', filter: 'number' },
          { key: 'unit_price', label: '单价', filter: 'number' }, { key: 'amount', label: '行金额', filter: 'number' },
          { key: 'basis', label: '单价基准（中标报价条目）', type: 'code' },
          { key: 'trace', label: '追溯模式' }],
        rows: (item.lines ?? []).map((line) => ({ id: String(line.ref_line), ref_line: line.ref_line,
          qty: line.qty, unit_price: line.unit_price,
          amount: Number(line.qty ?? 0) * Number(line.unit_price ?? 0),
          basis: line.basis, trace: line.trace })),
        counts: { lines: (item.lines ?? []).length },
        note: '每一行的 `basis` 指向中标报价里的条目（本侧提交的那份报价）；量×单价 = 行金额，可逐行核' }
    } }))

  out.push(surface.panel({ plugin_id: me, id: 'po.prereqs', title: '执行前提（送货地址 / 交期窗口 / 截止）',
    view: 'supplier', order: 52, kind: 'kv', object_kind: 'po',
    hint: '有事实就照实给；没有的**如实说"对方没给"**（不编送货地址、不编交期）',
    data: (ctx) => {
      const poId = asText(ctx.route?.id)
      const item = poReceivedOf(poId)
      if (!item) {
        return { ok: true, kind: 'kv', degraded: true, reason: 'po-not-delivered-to-you', items: [] }
      }
      const packageId = asText(item.package_id)
      const delivery = poDeliveries('supplier').find((row) => asText(row.po_id) === poId) ?? {}
      const rfq = typeRows(host.rows('supplier'), 'rfq/distributed').map((row) => bodyOf(row))
        .find((row) => asText(row.package_id) === packageId) ?? {}
      const window = asText(delivery.delivery_window)
      const shipTo = asText(delivery.ship_to)
      const items = [
        { key: '送货地址', value: shipTo || '承包商在这张 PO 上**没有给**（不是我没有权限看）' },
        { key: '交期窗口', value: window || '承包商在这张 PO 上**没有给**' },
        { key: '行项目与数量', value: (item.lines ?? []).map((line) => `${line.ref_line}×${line.qty}`).join(' · ') },
        { key: '币种', value: asText(rfq.currency) || '（本侧账本里没有这个包的投递登记）' },
        { key: '报价截止（本侧包事实）', value: asText(rfq.quote_by) || '（同上）' },
        { key: '包 / 版本', value: packageId ? `${packageId}${rfq.rev ? ` @rev${rfq.rev}` : ''}` : '—' },
      ]
      return { ok: true, kind: 'kv', items,
        real_facts: ['送货地址/交期窗口来自投递登记（发 PO 的人填的）', '币种/报价截止来自本侧 rfq/distributed'],
        note: '本侧只如实显示有事实的前提：地址与交期没有就写"没有"，要补就把它作为**附件**挂在这张 PO 上'
          + '（回签件/送货单），或用变更单（change/proposed）走人工门',
        next_action: (shipTo && window) ? '' : (asText(delivery.delivered_at)
          ? '要承包商补地址/交期：在本页「附件」面板里留言条，或用「变更单」提一条（双方都会看到）'
          : '') }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'po.acknowledge', title: '确认收到采购单（人签）', views: ['supplier'],
    group: '采购单', order: 41, permission: 'human-signature', object_kind: 'po',
    confirm: { required: true, message: '回签＝确认收到了这张采购单（不改变 PO 的行与价）：以你的署名确认？' },
    hint: '写自己账本 po/acknowledged + 承包商账本一条同名登记（双向留痕）；只有**投递给本侧**的 PO 才能回签',
    input: { fields: [
      { name: 'po_id', label: 'PO id', type: 'text', required: true, from_route: true,
        help: '从「发给我的采购单」表里取（po-…）；在 PO 对象页上会自动填当前这一条' },
      { name: 'signature', label: '署名（人签）', type: 'signature', required: true, help: 'human:<你的名字>' },
      { name: 'note', label: '备注（进回签登记，如交货安排）', type: 'text', max: 120 },
    ] },
    server: async (ctx, input) => {
      const cross = sideGuard(ctx, 'supplier', '确认收到采购单（人签）')
      if (cross) return cross
      const staged = host.stage('commitment-apply', { kind: 'commitment-apply', action: 'acknowledge',
        view: 'supplier', po_id: asText(input.po_id), note: asText(input.note).slice(0, 120),
        actor: asText(input.signature) })
      if (!staged.ok) return staged
      const run = host.runPython('src/domain/commitments/tools/commitment-apply.py',
        ['--step', 'acknowledge', '--request', staged.path, '--ui-shared', host.sharedDir,
          '--ledger-contractor', ledgerC(), '--ledger-supplier', ledgerS(), '--now', host.now()])
      const json = run.json ?? {}
      return { ok: run.ok && json.ok === true, code: json.refusal?.code ?? (json.ok ? 'acknowledged' : 'writer-failed'),
        reason: json.refusal?.reason ?? run.reason ?? '',
        next_action: json.refusal?.next_action
          ?? (json.ok === true ? '已回签：' + (json.po_id ?? 'po-…') + '（双方账本各一条 po/acknowledged，'
            + '回签人 = 你的会话身份）。回签件可以挂在这张 PO 的「附件」面板里给承包商'
            : (json.next_action ?? '看 result / stdout 定位唯一写者的输出（这条路才是失败）')),
        result: { po_id: json.po_id ?? null, acknowledged_by: json.acknowledged_by ?? null,
          applied: json.applied ?? [], ledger_added: json.ledger_added ?? 0,
          duplicates: json.duplicates ?? [] } }
    } }))

  /** **收到的那张 PO** 的导出/打印：行与价只用本侧事实（投递登记的 `lines` + `chain`），一列都不由界面拼。 */
  out.push(surface.action({ plugin_id: me, id: 'po.export-received', title: '导出 / 打印这张采购单（我收到的那份）',
    views: ['supplier'], group: '采购单', order: 42, icon: 'print', object_kind: 'po',
    hint: '内容 = 本侧账本 `po/distributed` 的行与追溯链；外壳只做序列化',
    input: { fields: [
      { name: 'po_id', label: 'PO id', type: 'text', required: true, from_route: true,
        help: '在 PO 对象页上会自动填当前这一条' },
      { name: 'format', label: '格式（csv = 表格；html = 可直接打印）', type: 'select', required: true,
        options: ['csv', 'html'], default: 'csv' },
    ] },
    server: (ctx, input) => {
      const cross = sideGuard(ctx, 'supplier', '导出这张采购单（我收到的那份）')
      if (cross) return cross
      const poId = asText(input.po_id)
      const item = poReceivedOf(poId)
      if (!item) {
        return { ok: false, code: 'po-not-delivered-to-you',
          reason: `本侧账本里没有这条 PO 的投递登记：${poId || '(空)'}`,
          next_action: '回「发给我的采购单」面板，点行内「打开 →」用真实存在的深链再导出' }
      }
      const ack = acksOf('supplier').get(poId)
      const poRow = typeRows(host.rows('supplier'), 'po/distributed')
        .find((row) => asText(bodyOf(row).po_id) === poId) ?? {}
      const lines = (item.lines ?? []).map((line, index) => ({ no: index + 1, ref_line: asText(line.ref_line),
        qty: line.qty, unit_price: line.unit_price,
        amount: Number(line.qty ?? 0) * Number(line.unit_price ?? 0), basis: asText(line.basis),
        trace: asText(line.trace), quote_id: asText(item.quote_id) }))
      return host.report({ format: asText(input.format) || 'csv', filename: `po-received-${poId}`,
        title: `采购单（PO）${poId} —— 我收到的那份`,
        subtitle: `供应商侧导出 · ${lines.length} 行 · 追溯模式 ${asText(item.trace_mode) || '—'}`,
        facts: [
          { key: 'PO', value: poId },
          { key: '承诺（award）', value: asText(item.award_id) },
          { key: '意向（intent）', value: asText(item.intent_id) },
          { key: '我的报价（quote）', value: asText(item.quote_id) },
          { key: '签发人（承包商侧人签）', value: asText(item.approved_by) },
          { key: '签发时刻', value: asText(item.issued_at) },
          { key: '投递时刻（本侧收到的时刻）', value: asText(item.sent_at) },
          { key: '追溯链', value: asText(item.chain) },
          { key: '金额合计', value: String(item.total_amount ?? '') },
          { key: '送货地址', value: asText(item.ship_to) || '（承包商未给）' },
          { key: '交期窗口', value: asText(item.delivery_window) || '（承包商未给）' },
          { key: '回签', value: ack ? `${asText(ack.acknowledged_by)} @ ${asText(ack.acknowledged_at)}` : '未回签' },
          { key: '账本行', value: poRow.seq === undefined ? '—'
            : `seq ${poRow.seq} · ${asText(poRow.entry_hash)}` },
        ],
        columns: [{ key: 'no', label: '#' }, { key: 'ref_line', label: '行项目' }, { key: 'qty', label: '数量', filter: 'number' },
          { key: 'unit_price', label: '单价', filter: 'number' }, { key: 'amount', label: '行金额', filter: 'number' },
          { key: 'basis', label: '单价基准（可追溯）' }, { key: 'trace', label: '追溯模式' },
          { key: 'quote_id', label: '来源报价' }],
        rows: lines,
        notes: ['行与价来自承包商签发的那张 PO（本侧账本 `po/distributed` 逐行可核，本侧不改行与价）。',
          `导出时刻：${host.now()}；本文件逐行可与本侧账本 po/distributed（seq ${poRow.seq ?? '—'}）核对，`
            + '合计 = 各行 数量×单价 之和。'],
        source: '供应商侧账本 po/distributed（po.export-received，domain/commitments）',
        ledger_refs: poRow.seq === undefined ? [] : [{ type: 'po/distributed', seq: poRow.seq,
          entry_hash: asText(poRow.entry_hash), chain: asText(item.chain) }] })
    } }))

  out.push(surface.report({ plugin_id: me, id: 'report.po-received', title: '我收到的采购单（CSV / 可打印 HTML）',
    views: ['supplier'], object_kind: 'po', formats: ['csv', 'html'], action: 'po.export-received', order: 42,
    // `columns` = 这份导出有哪些列（**元数据**：界面拿它做「列选择」个人偏好；内容仍由 action 生成）。
    // 与 `po.export-received` 的 spec.columns 逐字一致 —— 改了这里就要改那里（同一份台账）。
    columns: [{ key: 'no', label: '#' }, { key: 'ref_line', label: '行项目' }, { key: 'qty', label: '数量', filter: 'number' },
      { key: 'unit_price', label: '单价', filter: 'number' }, { key: 'amount', label: '行金额', filter: 'number' },
      { key: 'basis', label: '单价基准（可追溯）' }, { key: 'trace', label: '追溯模式' },
      { key: 'quote_id', label: '来源报价' }],
    hint: '逐行带单价基准与来源报价；表头给追溯链、投递时刻、送货地址/交期与回签状态' }))

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
        items.push({ level: 'warn', title: `承包商侧：人工门 ${id} 还在等（${gate.scope}）`,
          body: `对象 ${gate.ref}`, next_action: '打开这条门看卡在哪/等多久；门本身的人签动作在「授标与订单」里，界面不代签',
          // 门自己也是一个**可协作的对象**（`/app/<view>/gate/<id>/`）：指派/关注/评论由外壳的协作面提供，
          // 这里只声明"门后面那个对象是哪一类"（scope→kind 是本插件的领域知识）。
          ref: { kind: 'gate', id, title: `审批门 ${id}` },
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
      // 采购单的**投递与回签**（本批 P8）：两侧各自读自己的账本，缺什么就说什么。
      const myPos = poDeliveries('contractor').map((item) => asText(item.po_id))
      const myAcks = acksOf('contractor')
      const unacked = myPos.filter((id) => !myAcks.has(id))
      if (myPos.length && unacked.length) {
        items.push({ level: 'warn', title: `还有 ${unacked.length} 张采购单没等到对方回签`,
          body: `已投递：${myPos.join(' / ')} · 待回签：${unacked.join(' / ')}`,
          next_action: '对方在供应商道「发给我的采购单」里人签「确认收到采购单」；'
            + '回签件（签章 PDF）由对方挂在这张 PO 的附件面板里' })
      }
      const supplierPos = poDeliveries('supplier')
      const supplierAcks = acksOf('supplier')
      const supplierUnacked = supplierPos.filter((item) => !supplierAcks.has(asText(item.po_id)))
      if (supplierUnacked.length) {
        items.push({ level: 'warn', title: `供应商侧：${supplierUnacked.length} 张采购单还没回签`,
          body: `收到：${supplierUnacked.map((item) => asText(item.po_id)).join(' / ')}`,
          next_action: '在供应商道「发给我的采购单」里打开这张 PO，人签「确认收到采购单」'
            + '（署名 = 你的会话身份），回签件挂在同一页的「附件」面板',
          action: 'po.acknowledge', preset: { po_id: asText(supplierUnacked[0].po_id) },
          label: '去回签这张 PO' })
      }
      return { ok: true, kind: 'list', items }
    } }))

  out.push(surface.shortcut({ plugin_id: me, id: 'shortcut.award-propose', keys: 'a', action: 'award.propose',
    title: '提出授标意向', order: 40 }))

  // ------------------------------------------------------------------ 审批门（对象类 `gate`）
  // 「门」也是可以被协作的对象：做成**对象页**（`/app/<view>/gate/<approval_id>/`）后，它自动获得外壳的
  // 协作面（指派/转交、关注、评论与 @同事、我的/我指派的）——**门本身的事实仍由本插件给**（不重述、不发明）。
  // `scope → 对象类` 是本插件的领域知识，所以由本插件声明（外壳与协作面都不认识任何对象类）。
  const GATE_SCOPE_KIND = { 'change.approve': 'change', 'award.commit': 'award', 'po.issue': 'po',
    'quote.submit': 'quote' }
  for (const view of ['contractor', 'supplier']) {
    out.push(surface.panel({ plugin_id: me, id: `gate.object-${view}`, title: '审批门（对象页：谁在等、卡在哪）',
      view, order: 39, kind: 'kv', object_kind: 'gate',
      hint: '门后面那个对象可点；指派/关注/评论在「协作」面板里（同侧可见，不进账本）',
      data: (ctx) => {
        const id = asText(ctx?.route?.id)
        const rows = host.rows(view).filter((row) => String(row?.type ?? '').startsWith('approval/')
          && asText(bodyOf(row).approval_id) === id)
        if (!rows.length) {
          return { ok: true, kind: 'kv', items: [], object: { found: false, reason: 'gate-not-found',
            next_action: `这一侧（${view}）的账本里没有审批门 ${id}：门 id 从「审批与变更」页或工作台的`
              + '待人工门那一行点「打开 →」拿（不要手抄）' } }
        }
        const last = rows[rows.length - 1]
        const body = bodyOf(last)
        const status = String(last.type).replace('approval/', '')
        const scope = asText(body.scope)
        const target = asText(body.ref)
        const kind = GATE_SCOPE_KIND[scope] ?? ''
        const decided = status === 'granted' || status === 'aborted'
        const granted = rows.find((row) => String(row?.type ?? '') === 'approval/granted')
        const grantedBy = granted ? asText(bodyOf(granted).decided_by) || asText(bodyOf(granted).by) : ''
        const facts = [
          { key: '门 id', value: id, code: true },
          { key: '范围（scope）', value: scope || '（未登记范围）', code: true },
          { key: '状态', value: status === 'requested' ? '还在等（requested）'
            : (status === 'granted' ? '已批准（granted）' : `${status}`) },
          { key: '门后面那个对象', value: kind ? `${kind} ${target}` : `（未登记类别）${target}` },
          { key: '请求人', value: asText(body.requested_by) || '（未记）' },
          { key: '事实时刻', value: String(last.ts ?? '') },
          { key: '批准人', value: grantedBy || '（还没批）' },
        ]
        return { ok: true, kind: 'kv', items: facts,
          object: { title: `审批门 ${id}`, subtitle: `${scope || '（范围未登记）'} · ${decided
            ? '已决定' : '还在等'}（门的事实来自本侧账本；本页只多给一条协作面）`, found: true, facts,
            links: kind && target ? [{ kind, id: target, title: `门后面那个对象（${kind} ${target}）` }] : [],
            next_action: decided ? '这条门已经决定了：要看它挡住了哪一步，点上面的对象链接'
              : '这条门还在等：在本侧「授标与订单」用对应动作人签（界面不代签）；'
                + '办不完就在协作面板里「指派 / 转交」给同侧同事' } }
      } }))
  }

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
        items.push({ id: `gate:${id}`, level: 'warn', at: '', ref: { kind: 'gate', id, title: `审批门 ${id}` },
          title: `人工门 ${id} 还在等（${item.scope}）`,
          body: `对象 ${item.ref} —— 承诺类动作没有人工批准就落不了账`,
          next_action: '点「打开 审批门 …」进这条门的对象页（可以指派/评论）；'
            + '人签在「授标与订单」里用对应动作做' })
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
      // 投递与回签都读**本侧账本的事实行**（`po/distributed` 是我自己写的分发登记；`po/acknowledged`
      // 是对方回签后由唯一写者写到本侧的登记）——没有就是没有，不假装已送/已回签。
      const deliveredIds = new Set(poDeliveries('contractor').map((item) => asText(item.po_id)))
      const acks = acksOf('contractor')
      if (!pos.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-po',
          next_action: 'PO 只能由承诺派生：先在「授标链」里提意向 → 对方确认 → 人签承诺 → 人签发 PO',
          columns: [{ key: 'po_id', label: 'PO' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        columns: [
          { key: 'po_id', label: 'PO', type: 'code' }, { key: 'award_id', label: '承诺', type: 'code' },
          { key: 'intent_id', label: '意向', type: 'code' }, { key: 'quote_id', label: '报价', type: 'code' },
          { key: 'line_count', label: '行数', filter: 'number' }, { key: 'trace_mode', label: '追溯模式', filter: 'enum' },
          { key: 'total_amount', label: '金额（元）', filter: 'number' }, { key: 'approved_by', label: '签发人', type: 'code' },
          { key: 'chain', label: '链路' }, { key: 'issued_at', label: '签发时刻', filter: 'date' },
          { key: 'delivered', label: '投递' }, { key: 'ack', label: '对方回签' },
        ],
        rows: pos.map((po) => ({ id: String(po.po_id), po_id: po.po_id, award_id: po.award_id,
          intent_id: po.intent_id, quote_id: po.quote_id, line_count: (po.lines ?? []).length,
          trace_mode: po.trace_mode, total_amount: po.total_amount, approved_by: po.approved_by,
          chain: po.chain, issued_at: po.issued_at,
          delivered: deliveredIds.has(asText(po.po_id)) ? '已投递' : '未投递',
          ack: acks.has(asText(po.po_id))
            ? `${asText(acks.get(asText(po.po_id)).acknowledged_by)} @ `
              + `${asText(acks.get(asText(po.po_id)).acknowledged_at)}` : '待回签',
          ref: { kind: 'po', id: String(po.po_id), title: `PO ${po.po_id}` } })),
        row_actions: ['po.trace'], counts: { po: pos.length, delivered: deliveredIds.size, acked: acks.size },
        note: '行内「打开 →」是这条 PO 的**对象深链**（可复制分享、刷新不丢）；'
          + '「追溯这条 PO」把链路摊到下方，两者同一份计算；'
          + '「投递/对方回签」两列读的是 `po/distributed` 与 `po/acknowledged` 事实（没投递就是"未投递"——不假装已送）'
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
          links: (trace.segments ?? []).filter((seg) => seg.kind !== 'po'),
          // **分享**（插件声明"对方能不能看"；机制据此写分享弹层与邮件正文）
          share: { visibility: 'both', other_side_view: 'supplier',
            requirements: ['对方要用**供应商侧**的身份登录（收件方）；这张 PO 只有**投递到它那一侧**'
              + '才会出现在它的视图里（发 PO 即投递）'],
            note: '这是承包商侧签发的原件；对方那一侧看到的是同一次投递的收件登记（逐行同源）。' } },
        items: [
          { key: '链路', value: trace.chain, code: true },
          { key: '追溯模式', value: `${trace.trace_mode}（full=逐行可回溯；ref-only=只给引用）` },
          { key: '逐行', value: `${(trace.lines ?? []).length} 行（见下方明细表）` },
          { key: '投递', value: (() => {
            const did = poDeliveries('contractor').find((row) => asText(row.po_id) === asText(trace.po_id))
            if (!did) return '未投递（这张 PO 还没有投递给对方的账本登记）'
            return `已投递给 ${(did.recipients ?? []).join(' / ')} @ ${asText(did.sent_at)}`
              + (did.delivery_window ? ` · 交期窗口 ${asText(did.delivery_window)}` : '')
              + (did.ship_to ? ` · 送货地址 ${asText(did.ship_to)}` : '')
          })() },
          { key: '对方回签', value: (() => {
            const ack = acksOf('contractor').get(asText(trace.po_id))
            return ack ? `已回签：${asText(ack.acknowledged_by)} @ ${asText(ack.acknowledged_at)}`
              + (asText(ack.note) ? ` · 备注 ${asText(ack.note)}` : '') : '还没有（对方在供应商道「确认收到采购单」人签）'
          })() },
          { key: '事实时刻', value: trace.issued_at },
        ],
        note: '这一页**只看**账本事实：PO 由承诺派生、逐行引用中标条目，界面上不提供任何改价入口；'
          + '投递与回签也各自是账本事实（po/distributed / po/acknowledged）' }
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
        columns: [{ key: 'ref_line', label: 'PO 行', type: 'code' }, { key: 'qty', label: '量', filter: 'number' },
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
        columns: [{ key: 'ref_line', label: '行', type: 'code' }, { key: 'old_qty', label: '原量', filter: 'number' },
          { key: 'new_qty', label: '新量', filter: 'number' }, { key: 'old_unit_price', label: '原单价（只读）', filter: 'number' }],
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
          { key: 'delta_amount', label: '差额（元，整数分口径见工具输出）', filter: 'number' },
          { key: 'status_label', label: '状态' }, { key: 'approved_by', label: '批准人', type: 'code' },
          { key: 'reason', label: '理由' }, { key: 'proposed_at', label: '提出 @ts', filter: 'date' },
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
          { key: 'lines', label: '逐行 原量→新量' }, { key: 'delta_amount', label: '差额', filter: 'number' },
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

  // ------------------------------------------------------------------ 导出 / 打印（`report` 声明 + 动作）
  /**
   * **PO 导出**（对象页 `/app/contractor/po/<id>/` 上的「导出 / 打印」）：行与价**全部来自账本事实**
   * （`po/issued` 的 `lines` 与追溯链），一列都不由界面拼；每行带 `basis`（单价基准）与 `trace`，
   * 表头带四段链与账本行号 ⇒ 打印出来能逐行对回账本。
   */
  out.push(surface.action({ plugin_id: me, id: 'po.export', title: '导出 / 打印采购单（人读格式）',
    views: ['contractor'], group: '授标', order: 32, icon: 'print', object_kind: 'po',
    hint: '内容 = 本侧账本 `po/issued` 的行 + 追溯链（逐行带单价基准）；外壳只做序列化',
    input: { fields: [
      { name: 'po_id', label: 'PO id', type: 'text', required: true, from_route: true,
        help: '在 PO 对象页上会自动填当前这一条' },
      { name: 'format', label: '格式（csv = 表格；html = 可直接打印）', type: 'select', required: true,
        options: ['csv', 'html'], default: 'csv' },
    ] },
    server: (ctx, input) => {
      const view = 'contractor'
      const rows = host.rows(view)
      const poId = asText(input.po_id)
      const po = posOf(rows).find((item) => asText(item.po_id) === poId) ?? null
      if (!po) {
        return { ok: false, code: 'po-not-in-my-view', reason: `本侧账本里没有这条 PO：${poId || '(空)'}`,
          next_action: '回「采购单（PO）」面板，点行内「打开 →」用真实存在的深链再导出' }
      }
      const award = awardsOf(rows).find((item) => asText(item.award_id) === asText(po.award_id)) ?? {}
      const intent = intentsOf(rows).find((item) => asText(item.intent_id) === asText(po.intent_id)) ?? {}
      const poRow = rows.filter((row) => String(row?.type ?? '') === 'po/issued')
        .find((row) => asText(bodyOf(row).po_id) === poId) ?? {}
      const lines = (po.lines ?? []).map((line, index) => ({ no: index + 1, ref_line: asText(line.ref_line),
        qty: line.qty, unit_price: line.unit_price,
        amount: Number(line.qty ?? 0) * Number(line.unit_price ?? 0), basis: asText(line.basis),
        trace: asText(line.trace), quote_id: asText(po.quote_id) }))
      return host.report({ format: asText(input.format) || 'csv', filename: `po-${poId}`,
        title: `采购单（PO）${poId}`,
        subtitle: `承包商侧导出 · ${lines.length} 行 · 追溯模式 ${asText(po.trace_mode) || '—'}`,
        facts: [
          { key: 'PO', value: poId },
          { key: '承诺（award）', value: asText(po.award_id) },
          { key: '意向（intent）', value: asText(po.intent_id) },
          { key: '报价（quote）', value: asText(po.quote_id) },
          { key: '人工门（approval）', value: asText(po.approval_id) },
          { key: '批准人（署名）', value: asText(po.approved_by) },
          { key: '签发时刻', value: asText(po.issued_at) },
          { key: '追溯链', value: asText(po.chain) },
          { key: '金额合计', value: String(po.total_amount ?? '') },
          { key: '中标条目（承诺里）', value: String((award.lines ?? intent.lines ?? []).length) },
          { key: '账本行', value: poRow.seq === undefined ? '—'
            : `seq ${poRow.seq} · ${asText(poRow.entry_hash)}` },
        ],
        columns: [{ key: 'no', label: '#' }, { key: 'ref_line', label: '行项目' }, { key: 'qty', label: '数量', filter: 'number' },
          { key: 'unit_price', label: '单价', filter: 'number' }, { key: 'amount', label: '行金额', filter: 'number' },
          { key: 'basis', label: '单价基准（可追溯）' }, { key: 'trace', label: '追溯模式' },
          { key: 'quote_id', label: '来源报价' }],
        rows: lines,
        notes: ['行与价都由中标承诺派生（不得在界面上改价）；`basis` 指向中标报价的那一条单价。',
          `导出时刻：${host.now()}；本文件逐行可与账本 po/issued（seq ${poRow.seq ?? '—'}）核对，`
            + '合计 = 各行 数量×单价 之和。'],
        source: '承包商侧账本 po/issued（po.export，domain/commitments）',
        ledger_refs: poRow.seq === undefined ? [] : [{ type: 'po/issued', seq: poRow.seq,
          entry_hash: asText(poRow.entry_hash), chain: asText(po.chain) }] })
    } }))

  out.push(surface.report({ plugin_id: me, id: 'report.po', title: '采购单 PO（CSV / 可打印 HTML）',
    views: ['contractor'], object_kind: 'po', formats: ['csv', 'html'], action: 'po.export', order: 32,
    // `columns` = 这份导出有哪些列（**元数据**：界面拿它做「列选择」个人偏好；内容仍由 action 生成）。
    // 与 `po.export` 的 spec.columns 逐字一致 —— 改了这里就要改那里（同一份台账）。
    columns: [{ key: 'no', label: '#' }, { key: 'ref_line', label: '行项目' }, { key: 'qty', label: '数量', filter: 'number' },
      { key: 'unit_price', label: '单价', filter: 'number' }, { key: 'amount', label: '行金额', filter: 'number' },
      { key: 'basis', label: '单价基准（可追溯）' }, { key: 'trace', label: '追溯模式' },
      { key: 'quote_id', label: '来源报价' }],
    hint: '逐行带单价基准与来源报价；表头给四段追溯链与账本行号' }))

  // ---- **沙盘场景**：演示流程的第 ④ 段 = **授标（人签）→ 发 PO（人签）→ 供应商回签** --------------
  // 5 步：承包商提意向 → 供应商人签确认 → 承包商人签承诺 → 承包商人签发 PO（发出即投递）→ 供应商人签回签。
  // 门与写者一个字都没改：沙盘的差别只在**账本路径与署名来自机制生成的演示身份**（见 app-shell 沙盘段）。
  out.push(surface.scenario({ plugin_id: me, id: 'scenario.award-po', scenario: 'demo.procurement',
    scenario_title: '演示：包 → 报价 → 比价 → 授标 → PO → 回签', title: '④ 授标（人签）→ 发 PO（人签）→ 回签',
    view: 'contractor', order: 40,
    hint: '意向 → 供应商确认 → 授标承诺 → 逐行派生 PO（同步投递给供应商）→ 供应商人签回签；'
      + '每一道人签都由对应那一侧的演示身份签',
    steps: [
      { action: 'award.propose', capture: 'intent', input: { package_id: 'DEMO-PKG-001',
        quote_id: '$cap.q1.quote_id', item_id: 'L-001', qty: 120, unit_price_cents: 8600,
        reason: '沙盘演示：按比价第一名提意向' } },
      { action: 'award.confirm', as: { side: 'supplier' },
        input: { intent_id: '$cap.intent.intent_id', signature: '$actor', note: '沙盘演示：供应商确认',
          confirm_ack: '1' } },
      { action: 'award.commit', capture: 'award', input: { intent_id: '$cap.intent.intent_id',
        signature: '$actor', reason: '沙盘演示：人工批准（三样门齐备）', comment: '沙盘演示',
        confirm_ack: '1' } },
      { action: 'po.issue', capture: 'po', input: { award_id: '$cap.award.award_id', signature: '$actor',
        reason: '沙盘演示：发 PO（同步投递）', comment: '沙盘演示',
        delivery_window: '沙盘演示：2026-10-08 前到货', ship_to: '沙盘演示：苏州工业园区 A 区 3 号库',
        confirm_ack: '1' } },
      { action: 'po.acknowledge', as: { side: 'supplier' }, optional: true,
        input: { po_id: '$cap.po.po_id', signature: '$actor', note: '沙盘演示：供应商回签收到',
          confirm_ack: '1' } }] }))

  return out
}
