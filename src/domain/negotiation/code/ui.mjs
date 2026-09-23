/**
 * `domain/negotiation` 的 **GUI 贡献** —— 谈判面搬进 APP（DEF-020）。
 *
 * 修的是哪一条：谈判在 APP 内**一个入口都没有**（旧口径只给 `threads/rounds/rejected` 三个计数），
 * 于是"还能让多少 / 还剩几轮 / 上一轮到底被哪条策略拒了"在界面上完全看不到。现在：
 *
 *   · 面板 `negotiate.threads`（两侧）：**线程卡片** —— 挂的包/条目、对手方、状态（开着/已关）、
 *     **已用轮次 / 还剩几轮**、**让步边界**（底线 floor / 上沿 ceiling / 单次上限 %）、最近一轮的让步幅度；
 *   · 面板 `negotiate.rounds`（两侧）：**轮次时间轴** —— 逐轮 `from → to`、Δ%、是否在区间内、
 *     过没过人工门、以及**被拒轮次的原话**（`negotiate/round-rejected` 的 code/reason/next_action）；
 *   · 动作（都走**既有唯一写者** `src/domain/negotiation/tools/negotiate-actions.py`）：
 *       `negotiate.request-concession` 为一轮**请求人工批准**（落 `approval/requested`，scope 恰
 *         `negotiate.price-concession`）→ 去「审批队列」由点名的审批人**批准/驳回**；
 *       `negotiate.round` 提交一轮（带上那一次的 `approval_id`；判定链在服务里，越界即被拒并留痕）；
 *       `negotiate.close` 关闭线程（`accepted|rejected|withdrawn|limit-reached`，**不产生义务**）。
 *
 * 纪律：本文件**不写账本**（只 spawn 唯一写者）、**不自己重算判定**（边界与拒绝理由一律从账本行回读）；
 * 越界必须说清"越界多少、边界来自哪条策略"——拒绝原话就在 `negotiate/round-rejected` 行里。
 */
export const plugin_id = 'domain/negotiation'

const asText = (value) => (typeof value === 'string' ? value.trim() : '')
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const bodyOf = (row) => (row && typeof row.body === 'object' && row.body !== null ? row.body : {})
const OUTCOMES = ['accepted', 'rejected', 'withdrawn', 'limit-reached']

/** 账本行 → 线程/轮次视图（**事实回读**：每一栏都来自某一行，不重算、不猜）。 */
export const threadsOf = (rows) => {
  const order = []
  const threads = new Map()
  const rounds = []
  for (const row of rows) {
    const type = String(row?.type ?? '')
    if (!type.startsWith('negotiate/')) continue
    const body = bodyOf(row)
    const id = asText(body.thread_id)
    if (!id) continue
    const thread = threads.get(id) ?? { thread_id: id, rounds: [], bounds: null, status: '', outcome: null,
      package_id: '', item_id: '', role: '', counterparty: '', quote_id: '', proposal_id: '',
      rfq_rev: null, opened_at: '', closed_at: '', comment: '' }
    if (!threads.has(id)) order.push(id)
    if (type === 'negotiate/bounds-declared') {
      thread.bounds = { max_rounds: num(body.max_rounds), max_concession_pct: num(body.max_concession_pct),
        min_margin_pct: num(body.min_margin_pct), band: body.band ?? {}, cost_baseline: num(body.cost_baseline),
        policy_hash: asText(body.policy_hash), source: asText(body.source), at: String(row.ts ?? '') }
    } else if (type === 'negotiate/opened') {
      thread.package_id = asText(body.package_id); thread.item_id = asText(body.item_id)
      thread.role = asText(body.role); thread.counterparty = asText(body.counterparty)
      thread.quote_id = asText(body.quote_id); thread.proposal_id = asText(body.proposal_id)
      thread.rfq_rev = num(body.rfq_rev); thread.status = 'open'
      thread.opened_at = String(row.ts ?? '')
    } else if (type === 'negotiate/round' || type === 'negotiate/round-rejected') {
      const entry = { attempt_no: num(body.attempt_no), round_id: asText(body.round_id),
        rejected: type === 'negotiate/round-rejected',
        from: num(body.move?.from), to: num(body.move?.to), delta_pct: num(body.delta_pct),
        in_band: body.in_band === true, status: asText(body.status),
        approval_id: body.approval_id ?? null, code: asText(body.code), reason: asText(body.reason),
        next_action: asText(body.next_action), at: String(row.ts ?? '') }
      const list = type === 'negotiate/round' ? thread.rounds : (thread.rejections ?? [])
      if (type === 'negotiate/round') thread.rounds = [...thread.rounds, entry]
      else thread.rejections = [...list, entry]
      rounds.push({ thread_id: id, ...entry })
    } else if (type === 'negotiate/closed') {
      thread.status = 'closed'; thread.outcome = asText(body.outcome)
      thread.closed_at = String(row.ts ?? ''); thread.comment = asText(body.comment)
      thread.closed_by = asText(body.decided_by)
    }
    threads.set(id, thread)
  }
  return order.map((id) => threads.get(id))
}

export async function register(surface, host) {
  const me = plugin_id
  const out = []
  const tool = 'src/domain/negotiation/tools/negotiate-actions.py'
  const ledgerFor = (view) => asText(view === 'supplier' ? host.config?.ledger_supplier : host.config?.ledger_contractor)
  const money = (value) => (value === null ? '—' : `${value}`)

  const threadCard = (thread) => {
    const bounds = thread.bounds ?? {}
    const used = (thread.rounds ?? []).length
    const cap = bounds.max_rounds ?? null
    const left = cap === null ? null : Math.max(0, cap - used)
    const lastRound = (thread.rounds ?? [])[(thread.rounds ?? []).length - 1] ?? null
    const lastReject = (thread.rejections ?? [])[(thread.rejections ?? []).length - 1] ?? null
    // 底线/上沿：`negotiate/bounds-declared` 的 body **不带** floor/ceiling 这两个派生值
    // （契约 §5 的键集里没有它们），所以这里按服务**同一套公式**复算
    // （`_bounds_from_declaration`：floor = max(成本基线×(1+余量), 区间下限)；ceiling = 区间上沿）。
    // 复算值只用于**展示**：判定永远是服务的事（本文件不判）。
    const baseline = bounds.cost_baseline
    const margin = bounds.min_margin_pct
    const bandLow = num(bounds.band?.min_unit_price)
    const bandHigh = num(bounds.band?.max_unit_price)
    const derivedFloor = (baseline === null || margin === null) ? null
      : Math.max(baseline * (1 + margin / 100), bandLow ?? -Infinity)
    return {
      id: thread.thread_id, thread_id: thread.thread_id,
      package_id: thread.package_id, item_id: thread.item_id, role: thread.role,
      status_label: thread.status === 'open' ? '开着' : (thread.status === 'closed' ? `已关（${thread.outcome}）` : '—'),
      rounds_used: used, max_rounds: cap, rounds_left: left,
      floor: derivedFloor === null ? null : Number(derivedFloor.toFixed(2)),
      ceiling: bandHigh,
      band_label: `${money(bandLow)} … ${money(bandHigh)}`,
      max_concession_pct: bounds.max_concession_pct ?? null,
      cost_baseline: baseline,
      last_move: lastRound ? `${lastRound.from} → ${lastRound.to}（${Number(lastRound.delta_pct).toFixed(2)}%）`
        : (lastReject ? `（上一轮被拒）${lastReject.from} → ${lastReject.to}` : '还没有轮次'),
      last_rejection: lastReject ? `${lastReject.code}：${lastReject.reason}` : '',
      limits_source: bounds.source ? `边界来自 ${bounds.source}（policy_hash ${String(bounds.policy_hash).slice(7, 19)}…）`
        : '边界未声明',
      next_action: thread.status !== 'open'
        ? '这条线程已经关了（不会再有轮次）；要重谈就另开线程'
        : (left === 0
          ? '轮次用完了（上限来自 `negotiate.max_rounds`，humanOnly）：只能关闭线程，或由人放宽上限'
          : `还剩 ${left} 轮：先「为一轮请求人工批准」→ 去「审批队列」批准 → 回来「提交一轮」`),
    }
  }

  const threadsPanel = (view, order) => surface.panel({
    plugin_id: me, id: view === 'supplier' ? 'negotiate.threads.supplier' : 'negotiate.threads',
    title: '谈判线程（还能让多少 / 还剩几轮）', view, order, kind: 'table',
    actions: ['negotiate.request-concession', 'negotiate.round', 'negotiate.close'],
    data: () => {
      const rows = host.rows(view)
      const threads = threadsOf(rows)
      const open = threads.filter((thread) => thread.status === 'open')
      if (!threads.length) {
        return { ok: true, kind: 'table', degraded: true,
          reason: '这一侧还没有谈判线程（机器码 no-negotiation-thread）——不是坏了，是还没开线',
          next_action: '谈判线由插件在"包/报价/定价"链上开出来（线程绑在已人确认的定价建议上，绑条目与对手方）；'
            + '开线后这里会给出让步边界（底线 / 上沿 / 单次上限）与剩余轮次',
          columns: [{ key: 'thread_id', label: '线程' }], rows: [], counts: { threads: 0, rounds: 0 } }
      }
      return { ok: true, kind: 'table',
        columns: [
          { key: 'thread_id', label: '线程', type: 'code' },
          { key: 'status_label', label: '状态', filter: 'enum' },
          { key: 'package_id', label: '挂的包', type: 'code' },
          { key: 'item_id', label: '条目', type: 'code' },
          { key: 'role', label: '我方视角', filter: 'enum' },
          { key: 'rounds_used', label: '已用轮次', filter: 'number' },
          { key: 'rounds_left', label: '还剩几轮', filter: 'number' },
          { key: 'floor', label: '底线 floor（按边界复算）' },
          { key: 'ceiling', label: '上沿 ceiling' },
          { key: 'max_concession_pct', label: '单次让步上限 %' },
          { key: 'last_move', label: '最近一轮' },
          { key: 'last_rejection', label: '上一轮被拒的原话' },
          { key: 'limits_source', label: '边界来自哪条策略' },
        ],
        rows: threads.map(threadCard),
        row_actions: ['negotiate.request-concession', 'negotiate.round', 'negotiate.close'],
        counts: { threads: threads.length, open: open.length,
          rounds: threads.reduce((sum, thread) => sum + (thread.rounds ?? []).length, 0),
          rejected: threads.reduce((sum, thread) => sum + (thread.rejections ?? []).length, 0) },
        note: '每一栏都从账本行回读：边界 = `negotiate/bounds-declared`（底线/上沿/单次上限/策略哈希），'
          + '轮次 = `negotiate/round`，被拒轮次 = `negotiate/round-rejected`（被拒的尝试也占轮次号），'
          + '结局 = `negotiate/closed`。越界不是"不允许"三个字：拒绝原话（越界多少、该找哪条策略）'
          + '就在上面那一栏。本面板不能批准：让步要过人工门（先请求批准，再提交同一轮的 approval_id）。' }
    } })

  const roundsPanel = (view, order) => surface.panel({
    plugin_id: me, id: view === 'supplier' ? 'negotiate.rounds.supplier' : 'negotiate.rounds',
    title: '轮次时间轴（谁在何时让了什么）', view, order, kind: 'table', actions: [],
    data: () => {
      const rows = host.rows(view)
      const threads = threadsOf(rows)
      const entries = []
      for (const thread of threads) {
        for (const round of thread.rounds ?? []) entries.push({ thread, round, rejected: false })
        for (const rejected of thread.rejections ?? []) entries.push({ thread, round: rejected, rejected: true })
      }
      entries.sort((left, right) => String(left.round.at).localeCompare(String(right.round.at)))
      if (!entries.length) {
        return { ok: true, kind: 'table', degraded: true,
          reason: '还没有任何轮次（机器码 no-negotiation-round）——线程开着，但还没提交过一轮',
          next_action: '在「谈判线程」卡片上点「为一轮请求人工批准」→ 去「审批队列」批准 → 再「提交一轮」',
          columns: [{ key: 'round_id', label: '轮次' }], rows: [], counts: { rounds: 0 } }
      }
      return { ok: true, kind: 'table',
        columns: [
          { key: 'thread_id', label: '线程', type: 'code' },
          { key: 'attempt_no', label: '第几次尝试（被拒也占号）', filter: 'number' },
          { key: 'result', label: '结果', filter: 'enum' },
          { key: 'pair', label: '单价 从 → 到', type: 'code' },
          { key: 'delta_pct', label: '让步幅度 %', filter: 'number' },
          { key: 'in_band', label: '在授权区间内？' },
          { key: 'approval_id', label: '过的人工门' },
          { key: 'at', label: '账本 ts', filter: 'date' },
          { key: 'detail', label: '拒绝原话 / 下一步' },
        ],
        rows: entries.map(({ thread, round, rejected }) => ({
          id: `${round.round_id ?? `${thread.thread_id}#${round.attempt_no}`}${rejected ? '-rejected' : ''}`,
          thread_id: thread.thread_id, attempt_no: round.attempt_no,
          result: rejected ? `被拒（${round.code || 'rejected'}）` : `已落账（${round.status || 'conceded'}）`,
          pair: `${round.from} → ${round.to}`, delta_pct: round.delta_pct,
          in_band: rejected ? '否（判定链就此停住）' : (round.in_band ? '是' : '否'),
          approval_id: round.approval_id ?? '（这一轮没有门）', at: round.at,
          detail: rejected ? `${round.reason}；下一步：${round.next_action}` : '（拒绝原话与被拒轮次的留痕都在这里）',
        })),
        counts: { rounds: entries.filter((item) => !item.rejected).length,
          rejected: entries.filter((item) => item.rejected).length },
        note: '时间一律是账本行的 `ts`（不取墙钟）；被拒的尝试也占轮次号（契约 §1），'
          + '所以"还剩几轮"按尝试数算，不是按成功数算。' }
    } })

  for (const view of ['contractor', 'supplier']) {
    out.push(surface.view({ plugin_id: me, id: view === 'supplier' ? 'negotiate.workspace.supplier' : 'negotiate.workspace',
      title: '谈判', order: 7, view,
      hint: '线程卡片（还能让多少 / 还剩几轮）+ 轮次时间轴；让步过人工门，被拒有原话' }))
    out.push(threadsPanel(view, 7))
    out.push(roundsPanel(view, 8))
  }

  // ------------------------------------------------------------------ 动作（都只 spawn 唯一写者）
  const stepAction = (id, step, title, fields, hint) => surface.action({
    plugin_id: me, id, title, views: ['contractor', 'supplier'], group: '谈判',
    order: step === 'close' ? 30 : (step === 'round' ? 20 : 10), permission: 'human-signature', inline: true,
    confirm: { required: true, message: `${title}：确认以你的署名执行？（落一条账本事实）` },
    hint, input: { fields },
    server: async (ctx, input) => {
      const asked = String(ctx.view ?? 'contractor')
      const mine = asText(ctx?.identity?.side)
      if (mine !== '' && mine !== asked) {
        return { ok: false, code: 'cross-side-action',
          reason: `你的会话是 ${mine} 侧，却在 ${asked} 侧发起谈判动作：侧只认会话`,
          next_action: `在 ${mine} 侧自己的「谈判」面板里发起` }
      }
      const view = mine === '' ? asked : mine
      const payload = { kind: 'negotiate-actions', action: step, view,
        thread_id: asText(input.thread_id), item_id: asText(input.item_id),
        unit: asText(input.unit) || 'unit-price',
        from: input.from === undefined ? null : input.from,
        to: input.to === undefined ? null : input.to,
        approval_id: asText(input.approval_id), outcome: asText(input.outcome),
        timeout_policy: 'remind', timeout_s: 3600,
        actor: asText(input.signature), note: String(input.note ?? '') }
      const staged = host.stage('negotiate-actions', payload)
      if (!staged.ok) return staged
      const run = host.runPython(tool, ['--step', step, '--request', staged.path,
        '--inbox', `${host.sharedDir}/negotiate-actions`, '--ui-shared', host.sharedDir,
        '--ledger-contractor', ledgerFor(view), '--view', view, '--now', host.now()])
      const json = run.json ?? {}
      const refusal = json.refusal ?? null
      const ok = Boolean(run.ok && json.ok === true)
      const added = Number(json.ledger_added ?? 0)
      return { ok, code: refusal?.code ?? (ok ? (json.event ?? step) : 'writer-failed'),
        reason: refusal?.reason ?? (ok ? '' : (run.reason ?? '')),
        next_action: refusal?.next_action ?? json.next_action_runtime
          ?? (ok ? `已落 \`${json.event}\`（本动作账本 +${added} 行）：刷新「谈判」面板能看到它`
            : '看 result.stdout 定位后重提'),
        result: { pending: staged.file, pending_file: staged.name, view, step,
          thread_id: json.thread_id ?? asText(input.thread_id), event: json.event ?? '',
          approval_id: json.approval_id ?? '', ref: json.ref ?? '',
          round_id: json.round_id ?? '', attempt_no: json.attempt_no ?? null,
          delta_pct: json.delta_pct ?? null, in_band: json.in_band ?? null,
          outcome: json.outcome ?? '', ledger_added: added,
          applied: json.applied ?? [], stdout: run.stdout ? run.stdout.slice(-500) : '' } }
    } })

  const threadField = (label) => ({ name: 'thread_id', label, type: 'text', required: true,
    help: '从「谈判线程」卡片复制（nt-…）；行内点动作会自动带上' })
  const itemField = { name: 'item_id', label: '条目 id（留空 = 线程绑定的那个）', type: 'text',
    help: '线程是绑在某个条目上的；本条留空就用线程自己的 item_id' }
  const moveFields = [
    { name: 'from', label: '让步前单价（from，正数）', type: 'number', required: true, min: 0 },
    { name: 'to', label: '让步后单价（to；供应商侧必须更低，承包商侧必须更高）', type: 'number',
      required: true, min: 0,
      help: '方向搞反会被判 move-direction-invalid；幅度超过单次上限会被判 concession-over-limit' },
  ]

  out.push(stepAction('negotiate.request-concession', 'request-concession',
    '为一轮请求人工批准（价格让步的门）',
    [threadField('线程 id'), itemField, ...moveFields,
      { name: 'signature', label: '署名（人签）', type: 'signature', required: true, help: 'human:<你的名字>' },
      { name: 'note', label: '为什么让这一步（进待办件与门的理由）', type: 'textarea', required: true }],
    '落 `approval/requested`（scope 恰 `negotiate.price-concession`，ref 恰 `<线程>:a<第几次>`）：'
    + '之后去「审批队列」由点名的审批人批准，再提交同一轮'))

  out.push(stepAction('negotiate.round', 'round', '提交一轮（带上那一次的门）',
    [threadField('线程 id'), itemField, ...moveFields,
      { name: 'approval_id', label: '这一轮过的人工门（ap-…）', type: 'text', required: true,
        help: '先「为一轮请求人工批准」，去「审批队列」批准后把那个 ap-… 填这里（没有批准必被拒）' },
      { name: 'signature', label: '署名（人签）', type: 'signature', required: true, help: 'human:<你的名字>' },
      { name: 'note', label: '理由（进账本 citations/round）', type: 'textarea', required: false }],
    '判定链（维度 → 轮次上限 → 幅度 → 底线 → 区间 → 人工门）在服务里跑：越界不落 round，'
    + '落 `negotiate/round-rejected` 留痕并具名拒（被拒也占轮次号）'))

  out.push(stepAction('negotiate.close', 'close', '关闭线程（不产生义务）',
    [threadField('线程 id'),
      { name: 'outcome', label: '结局', type: 'select', options: OUTCOMES, required: true,
        help: 'accepted = 接受当前这条线；rejected/withdrawn/limit-reached 各有各的语义' },
      { name: 'signature', label: '署名（人签）', type: 'signature', required: true, help: 'human:<你的名字>' },
      { name: 'note', label: '说明（进账本 comment）', type: 'textarea', required: false }],
    '落 `negotiate/closed`：不产生义务（无承诺事件、无 PO、无对外报价）'))

  out.push(surface.statusItem({ plugin_id: me, id: 'status.negotiation', title: '谈判', order: 7, read: () => {
    const threads = threadsOf(host.rows('contractor')).concat(threadsOf(host.rows('supplier')))
    const open = threads.filter((thread) => thread.status === 'open').length
    const rejected = threads.reduce((sum, thread) => sum + (thread.rejections ?? []).length, 0)
    return { text: `线程 ${threads.length}（开着 ${open}）· 被拒轮次 ${rejected}`,
      level: rejected ? 'warn' : 'ok',
      next_action: open ? '在「谈判」面板线程卡片上行内操作（让步要过人工门）' : '' } } }))

  return out
}
