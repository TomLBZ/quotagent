/**
 * `domain/capacity` 的 **GUI 贡献** —— 供应商侧「**承诺交期 + 产能日历 + 冲突提醒**」（DEF-021）。
 *
 * 注册的东西（全部经注册面 `src/system/webui/code/ui-surface.mjs`）：
 *   · 面板 `capacity.calendar`：产能日历（按天：可用 / 已承诺窗口 / 冲突标记）——数据只来自**本视角账本**
 *     的 `capacity/calendar` 与 `capacity/committed` 事实（私域，不外发）；
 *   · 面板 `capacity.commitments`：我的承诺交期（`firm` / `indicative`、交期日、revision、留痕），
 *     行内动作「改期（留痕）」；
 *   · 面板 `capacity.conflicts`：冲突提醒（`capacity/conflict`）——可点进冲突的那个承诺；
 *   · 动作 `capacity.calendar`（设置产能日历）/ `capacity.commit`（承诺交期，**实时可行性试算**）/
 *     `capacity.amend`（改期留痕；`firm` 交期只能由 `human:*` 改，agent 一律拒）；
 *   · 承包商侧面板 `capacity.supplier-dates`：对方承诺的**share-safe**交期（只看得到交期与绑定性质，
 *     看不到产能日历与缺口数值 —— 规则 4）；
 *   · 通知源与状态栏项、快捷键。
 *
 * 三个动作的**服务端一半**只落 0600 待办件并 spawn 唯一写者 `tools/capacity-commit.py`（内部走
 * **既有服务** `CapacityService`）；本文件不写账本、不自行改交期（不可行时不夹取、不自动顺延）。
 */
export const plugin_id = 'domain/capacity'

const asText = (value) => (typeof value === 'string' ? value.trim() : '')
const bodyOf = (row) => (row && typeof row.body === 'object' && row.body !== null ? row.body : {})
const typeRows = (rows, ...types) => rows.filter((row) => types.includes(String(row?.type ?? '')))
const daysBetween = (from, to) => {
  const start = Date.parse(`${from}T00:00:00Z`)
  const end = Date.parse(`${to}T00:00:00Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return []
  const out = []
  for (let ts = start; ts <= end; ts += 86400000) out.push(new Date(ts).toISOString().slice(0, 10))
  return out
}
const DAY_LIMIT = 60

/** 本视角的产能状态（账本重放）：日历 + 承诺 + 冲突。 */
const stateOf = (host, view) => {
  const rows = host.rows(view)
  const calendar = new Map()
  for (const row of typeRows(rows, 'capacity/calendar')) {
    for (const [day, available] of Object.entries(bodyOf(row).days ?? {})) {
      calendar.set(String(day), Number(available))
    }
  }
  const commitments = []
  for (const row of typeRows(rows, 'capacity/committed')) {
    const body = bodyOf(row)
    if (asText(body.view) === 'contractor' && asText(body.supplier) !== '') {
      // 承包商侧看到的 share-safe 行（供应商侧自己的行不带 view 字段）
      if (view === 'contractor') commitments.push({ ...body, share_safe: true })
      continue
    }
    const key = asText(body.commitment_id)
    if (key === '') continue
    const existing = commitments.find((item) => item.commitment_id === key)
    if (existing) Object.assign(existing, body)
    else commitments.push({ ...body })
  }
  const conflicts = typeRows(rows, 'capacity/conflict').map((row) => bodyOf(row))
  return { calendar, commitments, conflicts }
}

export async function register(surface, host) {
  const me = plugin_id
  const out = []
  const ledgerS = () => asText(host.config?.ledger_supplier)
  const ledgerC = () => asText(host.config?.ledger_contractor)

  const runWriter = async ({ record, okNext }) => {
    const staged = host.stage('capacity-commit', record)
    if (!staged.ok) return staged
    const run = host.runPython('src/domain/capacity/tools/capacity-commit.py',
      ['--request', staged.path, '--ui-shared', host.sharedDir, '--view', 'supplier',
        '--ledger-supplier', ledgerS(), '--ledger-contractor', ledgerC(), '--now', host.now()])
    const json = run.json ?? {}
    const refusal = json.refusal ?? (Array.isArray(json.refused) ? json.refused[0] : null)
    const ok = run.ok && refusal == null && json.ok !== false
    return { ok, code: refusal?.code ?? (ok ? 'accepted' : 'writer-failed'),
      reason: refusal?.reason ?? run.reason ?? '',
      next_action: refusal?.next_action ?? (ok ? okNext : '看 stdout/stderr 定位唯一写者的拒绝原因（拒绝时账本零新增）'),
      result: { pending: staged.file, ledger_added: json.ledger_added ?? 0, applied: json.applied ?? [],
        duplicates: json.duplicates ?? [], refused: json.refused ?? [], writer: 'capacity-commit.py',
        stdout: run.stdout ? run.stdout.slice(-800) : '', stderr: run.stderr ? run.stderr.slice(-300) : '' } }
  }

  out.push(surface.view({ plugin_id: me, id: 'exchange.capacity-workspace', title: '产能与交期', order: 30,
    view: 'supplier', hint: '产能日历 → 承诺交期（实时可行性）→ 冲突提醒 → 改期留痕' }))

  // ================================================================== 产能日历（热力图形态：按天一行）
  out.push(surface.panel({ plugin_id: me, id: 'exchange.calendar', title: '产能日历（按天：可用 / 已承诺 / 冲突）',
    view: 'supplier', order: 30, kind: 'table', actions: ['exchange.calendar', 'exchange.capacity-promise'],
    hint: '日历是**本方私域**（只进本视角账本）；「已承诺」列给出落在该天窗口内的承诺，冲突标记来自 capacity/conflict',
    data: () => {
      const state = stateOf(host, 'supplier')
      const days = [...state.calendar.keys()].sort()
      if (!days.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'calendar-not-set',
          next_action: '先用「设置产能日历」填几天的可用产量（例：2026-10-01=12、2026-10-02=10），'
            + '再承诺交期——没有日历就没有可行性试算',
          columns: [{ key: 'day', label: '日期' }], rows: [] }
      }
      const first = days[0]
      const last = days[days.length - 1]
      const window = daysBetween(first, last).slice(0, DAY_LIMIT)
      const rows = window.map((day) => {
        const available = state.calendar.has(day) ? state.calendar.get(day) : 0
        const covering = state.commitments.filter((item) => {
          const start = asText(item.start_date) || asText(item.delivery_date)
          const end = asText(item.delivery_date)
          return start && end && day >= start && day <= end
        })
        const conflict = state.conflicts.filter((item) => covering.some((c) =>
          c.commitment_id === asText(item.commitment_id)))
        return { id: day, day, available,
          committed: covering.length
            ? covering.map((item) => `${item.commitment_id}（${item.binding}，需 ${item.quantity}）`).join(' ')
            : '—',
          conflict: conflict.length ? `不可行：需 ${conflict[0].required}，日历可用 ${conflict[0].available}` : '' }
      })
      return { ok: true, kind: 'table',
        columns: [{ key: 'day', label: '日期', type: 'code' }, { key: 'available', label: '产能可用' },
          { key: 'committed', label: '已承诺（落在该天窗口的承诺）', type: 'code' },
          { key: 'conflict', label: '冲突' }],
        rows, counts: { days: days.length, shown: rows.length, commitments: state.commitments.length,
          conflicts: state.conflicts.length },
        note: `天数上限 ${DAY_LIMIT} 行（有界；超出如实截断并给 counts）`
          + ' · 冲突只提请人工：服务**不**自动改交期、**不**否决报价（护栏不否决）' }
    } }))

  out.push(surface.panel({ plugin_id: me, id: 'exchange.commitments', title: '我的承诺交期（firm 不可原地改）',
    view: 'supplier', order: 31, kind: 'table', actions: ['exchange.capacity-reschedule'],
    hint: 'firm = 有效期内不可变更（只能由 human:* 改期并留痕）；indicative = 可再谈',
    data: () => {
      const state = stateOf(host, 'supplier')
      const mine = state.commitments.filter((item) => asText(item.view) !== 'contractor')
      if (!mine.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-commitment',
          next_action: '用「承诺交期」挂在一份报价上（先有日历与报价）',
          columns: [{ key: 'commitment_id', label: '承诺' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        columns: [{ key: 'commitment_id', label: '承诺', type: 'code' }, { key: 'quote_id', label: '报价', type: 'code' },
          { key: 'package_id', label: '包', type: 'code' }, { key: 'binding', label: '绑定' },
          { key: 'lead_time_days', label: '交期（天）', filter: 'number' }, { key: 'delivery_date', label: '交期日', filter: 'date' },
          { key: 'valid_until', label: '有效期至' }, { key: 'revision', label: 'revision' },
          { key: 'by', label: '由谁', type: 'code' }],
        rows: mine.map((item) => ({ id: asText(item.commitment_id), ...item })),
        row_actions: ['exchange.capacity-reschedule'],
        counts: { commitments: mine.length,
          firm: mine.filter((item) => asText(item.binding) === 'firm').length },
        note: '改 `firm` 交期只能由 human:* 走「改期」（会留痕、产生新 revision）；'
          + 'agent 发起 ⇒ 前置拒绝且账本零新增（FR-CAP-002）' }
    } }))

  out.push(surface.panel({ plugin_id: me, id: 'exchange.conflicts', title: '冲突提醒（可点进冲突的那个承诺）',
    view: 'supplier', order: 32, kind: 'table',
    data: () => {
      const state = stateOf(host, 'supplier')
      if (!state.conflicts.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-conflict',
          next_action: '目前没有产能/交期冲突（承诺时会实时试算；不可行只提请人工）',
          columns: [{ key: 'commitment_id', label: '承诺' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        columns: [{ key: 'commitment_id', label: '承诺（点它看详情）', type: 'code' },
          { key: 'quote_id', label: '报价', type: 'code' }, { key: 'window', label: '窗口' },
          { key: 'required', label: '需要' }, { key: 'available', label: '日历可用' },
          { key: 'shortfall', label: '缺口' }, { key: 'requires_human', label: '需人工' }],
        rows: state.conflicts.map((item) => ({ id: asText(item.commitment_id), commitment_id: asText(item.commitment_id),
          quote_id: asText(item.quote_id),
          window: Array.isArray(item.window) ? item.window.join(' → ') : '—',
          required: item.required, available: item.available, shortfall: item.shortfall,
          requires_human: item.requires_human === true ? '是（只提请人工）' : '否' })),
        counts: { conflicts: state.conflicts.length },
        note: '缺口数值是**本方私域**；对外的 share-safe 形态只有定性结论（承包商侧看不到这些数字）' }
    } }))

  // ================================================================== 承包商侧：对方承诺的 share-safe 交期
  out.push(surface.panel({ plugin_id: me, id: 'exchange.supplier-dates', title: '供应商承诺的交期（share-safe）',
    view: 'contractor', order: 39, kind: 'table',
    data: () => {
      const state = stateOf(host, 'contractor')
      const rows = state.commitments.filter((item) => asText(item.supplier) !== '')
      if (!rows.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-supplier-commitment',
          next_action: '等供应商在 APP 里「承诺交期」（对方侧的产能日历与缺口不外发，只给交期与绑定性质）',
          columns: [{ key: 'commitment_id', label: '承诺' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        columns: [{ key: 'commitment_id', label: '承诺', type: 'code' }, { key: 'supplier', label: '供应商', type: 'code' },
          { key: 'quote_id', label: '报价', type: 'code' }, { key: 'binding', label: '绑定' },
          { key: 'lead_time_days', label: '交期（天）', filter: 'number' }, { key: 'delivery_date', label: '交期日', filter: 'date' },
          { key: 'revision', label: 'revision' }, { key: 'by', label: '由谁', type: 'code' }],
        rows: rows.map((item) => ({ id: asText(item.commitment_id), ...item })),
        counts: { commitments: rows.length },
        note: 'share-safe：只有交期与绑定性质（**不含**对方的产能日历、缺口值与里程碑细节 —— 规则 4）' }
    } }))

  // ================================================================== 动作
  out.push(surface.action({ plugin_id: me, id: 'exchange.calendar', title: '设置产能日历（按天可用产量）',
    views: ['supplier'], group: '产能', order: 10,
    hint: 'days 用 `YYYY-MM-DD=可用量` 每行一条；日历是**本方私域**，只进本视角账本',
    input: { fields: [
      { name: 'days_text', label: '日历（每行：YYYY-MM-DD=可用量）', type: 'textarea', required: true,
        help: '例：2026-10-01=12\\n2026-10-02=10\\n2026-10-03=8' },
      { name: 'actor', label: '发言人', type: 'text', required: true, identity: true, help: 'human:<你的名字>' },
      { name: 'note', label: '备注（可选）', type: 'textarea' },
    ] },
    server: async (ctx, input) => {
      const days = {}
      const problems = []
      for (const [index, line] of String(input.days_text ?? '').split('\n').entries()) {
        const raw = line.trim()
        if (raw === '') continue
        const [day, available] = raw.split('=').map((piece) => piece.trim())
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day ?? ''))) {
          problems.push({ field: 'days_text', code: 'day-malformed',
            message: `第 ${index + 1} 行的日期不是 YYYY-MM-DD：${raw}`, next_action: '按 `YYYY-MM-DD=可用量` 写' })
          continue
        }
        if (!Number.isFinite(Number(available))) {
          problems.push({ field: 'days_text', code: 'available-invalid',
            message: `第 ${index + 1} 行的可用量不是数：${raw}`, next_action: '可用量给一个数' })
          continue
        }
        days[day] = Number(available)
      }
      if (problems.length) {
        return { ok: false, code: 'validation-failed', errors: problems,
          next_action: '按每行的正确写法（`YYYY-MM-DD=可用量`）改后重提' }
      }
      if (!Object.keys(days).length) {
        return { ok: false, code: 'days-required', reason: '日历为空', next_action: '至少填一天' }
      }
      const note = String(input.note ?? '')
      return runWriter({ record: { kind: 'capacity-commit', action: 'calendar', view: 'supplier', days,
        actor: asText(input.actor), note, note_sha256: '' },
        okNext: '日历已落账（本视角私域事实 capacity/calendar）：现在可以承诺交期并做可行性试算' })
    } }))

  out.push(surface.action({ plugin_id: me, id: 'exchange.capacity-promise', title: '承诺交期（实时可行性试算）',
    views: ['supplier'], group: '产能', order: 20,
    hint: 'firm = 有效期内不可变更；不可行**不夹取**：服务只提请人工（requires_human + capacity_risk）',
    input: { fields: [
      { name: 'quote_id', label: '报价 id', type: 'text', required: true, help: '从「已提交的报价」里复制' },
      { name: 'package_id', label: '包 id', type: 'text', required: true },
      { name: 'lead_time_days', label: '交期（天）', type: 'number', required: true, min: 1 },
      { name: 'quantity', label: '数量（本轮要交的量）', type: 'number', required: true, min: 0.0001 },
      { name: 'start_date', label: '开工日（YYYY-MM-DD）', type: 'text', required: true,
        pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      { name: 'binding', label: '绑定性质', type: 'select', options: ['indicative', 'firm'], default: 'indicative' },
      { name: 'actor', label: '承诺人', type: 'text', required: true, identity: true, help: 'human:<你的名字>' },
      { name: 'note', label: '备注（可选）', type: 'textarea' },
    ] },
    server: async (ctx, input) => {
      const note = String(input.note ?? '')
      return runWriter({ record: { kind: 'capacity-commit', action: 'commit', view: 'supplier',
        quote_id: asText(input.quote_id), package_id: asText(input.package_id),
        lead_time_days: Number(input.lead_time_days), quantity: Number(input.quantity),
        start_date: asText(input.start_date), binding: asText(input.binding) || 'indicative',
        actor: asText(input.actor), note, note_sha256: '' },
        okNext: '交期已承诺（capacity/committed，两侧各一条：对方只看到交期与绑定性质）；'
          + '看「冲突提醒」判断产能是否够，不够只提请人工、不自动改期' })
    } }))

  out.push(surface.action({ plugin_id: me, id: 'exchange.capacity-reschedule', title: '改期（留痕，产生新 revision）',
    views: ['supplier'], group: '产能', order: 30,
    hint: 'firm 交期只能由 human:* 改（agent 前置拒绝、账本零新增）；改期会留痕并通知对方（share-safe）',
    input: { fields: [
      { name: 'commitment_id', label: '承诺 id', type: 'text', required: true, help: '从「我的承诺交期」里复制' },
      { name: 'delivery_date', label: '新交期日（YYYY-MM-DD）', type: 'text', required: true,
        pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      { name: 'actor', label: '改期人', type: 'text', required: true, identity: true, help: 'human:<你的名字>' },
      { name: 'note', label: '改期原因（可选）', type: 'textarea' },
    ] },
    server: async (ctx, input) => {
      const by = asText(input.actor)
      const note = String(input.note ?? '')
      return runWriter({ record: { kind: 'capacity-commit', action: 'amend', view: 'supplier',
        commitment_id: asText(input.commitment_id),
        changes: { delivery_date: asText(input.delivery_date) }, actor: by, note, note_sha256: '' },
        okNext: '改期已留痕（新 revision 已落账并通知对方 share-safe）；已定交期不能原地改，只能这样改' })
    } }))

  // ================================================================== 工作台 / 通知 / 状态 / 快捷键
  out.push(surface.panel({ plugin_id: me, id: 'exchange.capacity-home', title: '产能与交期：我今天要做什么',
    view: 'home', order: 18, kind: 'list',
    data: () => {
      const state = stateOf(host, 'supplier')
      const items = []
      if (!state.calendar.size) {
        items.push({ level: 'warn', title: '供应商侧：还没有产能日历',
          body: '没有日历就没有可行性试算（承诺交期时给不出"够不够"的结论）',
          next_action: '用「设置产能日历」填几天的可用产量（私域，不外发）' })
      } else {
        items.push({ level: 'ok', title: `供应商侧：产能日历已设置 ${state.calendar.size} 天`,
          body: '承诺交期时会按窗口实时试算（需要量 vs 日历可用）', next_action: '去承诺交期' })
      }
      for (const conflict of state.conflicts) {
        items.push({ level: 'warn', title: `供应商侧：承诺 ${asText(conflict.commitment_id)} 不可行（产能冲突）`,
          body: `需要 ${conflict.required}，日历可用 ${conflict.available}（缺口 ${conflict.shortfall}）`,
          next_action: '去「冲突提醒」点进那个承诺：或缩量、或改期（firm 只能由人改期留痕）' })
      }
      const firm = state.commitments.filter((item) => asText(item.binding) === 'firm')
      if (firm.length) {
        items.push({ level: 'info', title: `${firm.length} 条 firm（已定）交期`,
          body: firm.map((item) => `${asText(item.commitment_id)} → ${asText(item.delivery_date)}`).join('；'),
          next_action: '已定交期不可原地改；要改走「改期」（human:*，留痕）' })
      }
      return { ok: true, kind: 'list', items }
    } }))

  out.push(surface.notificationSource({ plugin_id: me, id: 'exchange.capacity-notify', title: '产能与交期待办',
    order: 18, poll: () => {
      const state = stateOf(host, 'supplier')
      const items = state.conflicts.map((conflict) => ({ id: `cap:${asText(conflict.commitment_id)}`,
        level: 'warn', at: asText(conflict.at),
        title: `产能冲突：${asText(conflict.commitment_id)} 不可行`,
        body: `需要 ${conflict.required}、可用 ${conflict.available}（缺口 ${conflict.shortfall}）`,
        next_action: '缩量或改期（firm 交期只能由人改期，留痕）' }))
      if (!state.calendar.size) {
        items.push({ id: 'cap:no-calendar', level: 'info', at: '',
          title: '还没设置产能日历', body: '没有日历就无法试算可行性',
          next_action: '设置产能日历（按天可用产量）' })
      }
      return items
    } }))

  out.push(surface.statusItem({ plugin_id: me, id: 'exchange.capacity-status', title: '产能', order: 18, read: () => {
    const state = stateOf(host, 'supplier')
    const firm = state.commitments.filter((item) => asText(item.binding) === 'firm').length
    return { text: `日历 ${state.calendar.size} 天 · 承诺 ${state.commitments.length}（firm ${firm}）`
      + ` · 冲突 ${state.conflicts.length}`,
      level: state.conflicts.length ? 'warn' : 'ok',
      next_action: state.conflicts.length ? '有产能冲突待处理（只提请人工）' : '' }
  } }))

  out.push(surface.shortcut({ plugin_id: me, id: 'exchange.shortcut-reschedule', keys: 'l', action: 'exchange.capacity-promise',
    title: '承诺交期', order: 32 }))

  return out
}
