/**
 * `system/approval` 的 **GUI 贡献** —— 审批队列（DEF-023：**可等 / 可催 / 可升级 / 可终止 / 可委托**，
 * 且催办**真落账**）。
 *
 * 注册的东西（全部经注册面 `src/system/webui/code/ui-surface.mjs`）：
 *   · 面板 `gate.queue`（承包商道）与 `gate.queue.supplier`（供应商道）：门卡片表 —— 待批对象 / 卡在谁 /
 *     等待时长（按**事实时刻**算，不取墙钟）/ 超时策略与倒计时 / 已催 N 次 @ts / 升级与委托记录；
 *   · 面板 `gate.todo`（工作台）：一行一条"要人决定的事" + 可复制的 next_action；
 *   · 动作（都是**界内真动作**，服务端一半落 0600 待办件 → 唯一写者落账）：
 *       `gate.nudge`    催办 → `src/domain/gate-timeline/tools/gate-nudge.py`（既有唯一写者）落 `gate/nudged`
 *       `gate.escalate` 升级 → `src/system/approval/tools/gate-actions.py --step escalate` 落 `approval/escalated`
 *       `gate.delegate` 委托 → 同上 `--step delegate`
 *       `gate.abort`    终止 → `--step abort` 落 `approval/aborted`（**必须留理由**）
 *       `gate.request`  开一个待批门 → `--step request` 落 `approval/requested`
 *   · 通知源 `notify.gates`（等太久的门）、状态栏项 `status.gates`。
 *
 * 纪律：本文件**不写账本**（只 spawn 唯一写者）；签名动作的署名必须以 `human:` 开头（壳与写者各校验一次）；
 * 已决定的门不允许再催/再升级/再终止（`gate-already-decided`，写者自己判）。
 */
import { createHash } from 'node:crypto'

export const plugin_id = 'system/approval'

const asText = (value) => (typeof value === 'string' ? value.trim() : '')
const bodyOf = (row) => (row && typeof row.body === 'object' && row.body !== null ? row.body : {})
const hex64 = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex')
const RESOLVED = ['approval/granted', 'approval/denied', 'approval/aborted']
const POLICY_LABEL = { remind: '提醒（不改状态）', escalate: '升级', abort: '终止' }

/** 账本行 → 门登记（同一 approval_id 取**最后一次**写入；状态语义与 `ApprovalService.replay` 同形）。 */
const gatesOf = (rows) => {
  const order = []
  const map = new Map()
  for (const row of rows) {
    if (!String(row?.type ?? '').startsWith('approval/')) continue
    const body = bodyOf(row)
    const id = asText(body.approval_id)
    if (!id) continue
    if (!map.has(id)) order.push(id)
    const previous = map.get(id) ?? {}
    const type = String(row.type)
    map.set(id, {
      approval_id: id, scope: asText(body.scope), ref: asText(body.ref),
      status: RESOLVED.includes(type) ? asText(body.status) || (type === 'approval/granted' ? 'granted' : 'denied')
        : 'pending',
      decided_by: body.decided_by ?? null, comment: body.comment ?? '',
      requested_at: previous.requested_at ?? String(row.ts ?? ''),
      last_event: type, last_at: String(row.ts ?? ''),
      timeout_policy: asText(body.timeout_policy) || previous.timeout_policy || 'remind',
      timeout_s: Number(body.timeout_s ?? previous.timeout_s ?? 3600),
      approvers: Array.isArray(body.approvers) ? body.approvers : (previous.approvers ?? []),
      escalate_to: body.escalate_to ?? previous.escalate_to ?? null,
      escalated_to: body.escalated_to ?? previous.escalated_to ?? null,
      escalated_by: body.escalated_by ?? previous.escalated_by ?? null,
      aborted_by: body.aborted_by ?? null,
      remind_count: Number(body.remind_count ?? previous.remind_count ?? 0),
      reason: body.reason ?? previous.reason ?? '',
    })
  }
  return order.map((id) => map.get(id))
}

const nudgesOf = (rows) => {
  const out = new Map()
  for (const row of rows) {
    if (String(row?.type ?? '') !== 'gate/nudged') continue
    const body = bodyOf(row)
    const id = asText(body.gate_id)
    if (!id) continue
    const entry = out.get(id) ?? { count: 0, last_at: '', by: '' }
    out.set(id, { count: entry.count + 1, last_at: String(row.ts ?? ''), by: asText(body.actor) })
  }
  return out
}

/** 事实时刻：账本里最大的 ts（**不取墙钟**）。等待时长一律相对它算。 */
const asOf = (rows) => rows.map((row) => String(row?.ts ?? '')).filter(Boolean).sort().pop() ?? ''
const secondsBetween = (from, to) => {
  const start = Date.parse(String(from ?? '').replace('Z', '+00:00'))
  const end = Date.parse(String(to ?? '').replace('Z', '+00:00'))
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  return Math.round((end - start) / 1000)
}
const human = (seconds) => {
  if (seconds === null) return '—'
  if (seconds < 60) return `${seconds} 秒`
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分`
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} 小时`
  return `${(seconds / 86400).toFixed(1)} 天`
}
const pendingRows = (rows) => {
  const nudges = nudgesOf(rows)
  const moment = asOf(rows)
  return gatesOf(rows).filter((gate) => gate.status === 'pending').map((gate) => {
    const nudge = nudges.get(gate.approval_id) ?? { count: 0, last_at: '', by: '' }
    const waited = secondsBetween(gate.requested_at, moment)
    const since = secondsBetween(gate.last_at, moment)
    return { ...gate, waited_seconds: waited, waited: human(waited), since_last: human(since),
      overdue: since !== null && since >= gate.timeout_s,
      policy_label: POLICY_LABEL[gate.timeout_policy] ?? gate.timeout_policy,
      nudge_count: nudge.count, last_nudged_at: nudge.last_at, last_nudged_by: nudge.by,
      waiting_on: (gate.approvers ?? []).join(' ') || (gate.escalate_to ?? ''),
      who: (gate.approvers ?? []).join(' ') || (gate.escalate_to ?? '（账本行未带审批人）'),
      next_action: `催办/升级/终止都在卡片上（人签 ${gate.approval_id}）；升级到授权区间的下一角色` }
  })
}

export async function register(surface, host) {
  const me = plugin_id
  const out = []
  const ledgerC = () => asText(host.config?.ledger_contractor)
  const ledgerS = () => asText(host.config?.ledger_supplier)
  const gateTool = 'src/system/approval/tools/gate-actions.py'
  const nudgeTool = 'src/domain/gate-timeline/tools/gate-nudge.py'
  const ledgerFor = (view) => (view === 'supplier' ? ledgerS() : ledgerC())

  const queuePanel = (view, order) => surface.panel({
    plugin_id: me, id: view === 'supplier' ? 'gate.queue.supplier' : 'gate.queue',
    title: view === 'supplier' ? '我这边待批的门（供应商道）' : '审批队列（可等 / 可催 / 可升级 / 可终止 / 可委托）',
    view, order, kind: 'table', actions: ['gate.nudge', 'gate.escalate', 'gate.delegate', 'gate.abort'],
    data: () => {
      const rows = host.rows(view)
      const gates = pendingRows(rows)
      const decided = gatesOf(rows).filter((gate) => gate.status !== 'pending')
      const moment = asOf(rows)
      if (!gates.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-pending-gate',
          next_action: '用「提交人工门」（开一个待批门）把要人决定的事提出来；已决定的门在下面一栏',
          columns: [{ key: 'approval_id', label: '门' }], rows: [],
          counts: { pending: 0, decided: decided.length }, note: `事实时刻 ${moment || '—'}` }
      }
      return { ok: true, kind: 'table',
        columns: [
          { key: 'approval_id', label: '门', type: 'code' },
          { key: 'scope', label: '待批对象（scope）', type: 'code' },
          { key: 'ref', label: '引用（ref）', type: 'code' },
          { key: 'who', label: '卡在谁', type: 'code' },
          { key: 'waited', label: '已等（按事实时刻）' },
          { key: 'policy_label', label: '超时策略' },
          { key: 'overdue', label: '已超时？' },
          { key: 'nudge_count', label: '已催次数' },
          { key: 'last_nudged_at', label: '最后一次催办 @ts' },
          { key: 'escalated_to', label: '升级/委托给' },
        ],
        rows: gates.map((gate) => ({ id: gate.approval_id, ...gate,
          overdue: gate.overdue ? '是（策略会执行；永远不自动批准）' : '否',
          escalated_to: gate.escalated_to ?? '' })),
        row_actions: ['gate.nudge', 'gate.escalate', 'gate.delegate', 'gate.abort'],
        counts: { pending: gates.length, decided: decided.length,
          nudges: gates.reduce((sum, gate) => sum + gate.nudge_count, 0) },
        note: `事实时刻 ${moment || '—'}（等待时长相对账本里最大的 ts 算，不取墙钟）；`
          + '催办落 `gate/nudged`（不改判定），升级/委托落 `approval/escalated`，终止落 `approval/aborted`；'
          + '**不存在超时自动批准**；'
          + '「卡在谁 / 超时策略」在**升级或委托之后**可回读（`approval/escalated` 的 body 带 `approvers`/`escalated_to`），'
          + '而开单时写的审批人与策略**没有进账本**（`approval/requested` 的 body 只有 7 键：'
          + 'approval_id/scope/ref/payload_hash/status/decided_by/comment）——这里如实标「账本行未带」，不假装知道；'
          + '要让它可回读需要改 `src/system/approval/code/approval.py:_append`（文档 05-events.md 声明 body 应带策略），本轮未改，已记进报告' }
    } })

  out.push(surface.view({ plugin_id: me, id: 'gate.workspace', title: '审批队列', order: 5, view: 'contractor',
    hint: '可等、可催、可升级、可终止、可委托；每一步都真落账，且都不是"批准"' }))
  out.push(queuePanel('contractor', 6))
  out.push(queuePanel('supplier', 70))

  out.push(surface.panel({ plugin_id: me, id: 'gate.todo', title: '要人决定的事（待人工门）', view: 'home',
    order: 15, kind: 'list',
    data: () => {
      const items = []
      for (const view of ['contractor', 'supplier']) {
        for (const gate of pendingRows(host.rows(view))) {
          items.push({ level: gate.overdue ? 'warn' : 'info',
            title: `[${view}] ${gate.approval_id} 等 ${gate.waited}：${gate.scope}（${gate.ref}）`,
            body: `卡在 ${gate.who} · 已催 ${gate.nudge_count} 次${gate.last_nudged_at ? ` @${gate.last_nudged_at}` : ''}`
              + ` · 超时策略 ${gate.policy_label}`,
            next_action: `深链 ${host.prefix}/app/${view}/ → 「审批队列」卡片上点催办/升级/终止（人签）` })
        }
      }
      if (!items.length) {
        items.push({ level: 'info', title: '没有待批的门', body: '（已决定的门不在这一栏；撤销/作废都不是"自动批准"）',
          next_action: '要提一件事给人批，用「提交人工门」' })
      }
      return { ok: true, kind: 'list', items }
    } }))

  // ------------------------------------------------------------------ 动作（界内真动作）
  const signed = (title, id, fields, hint, run) => surface.action({ plugin_id: me, id, title,
    views: ['contractor', 'supplier'], group: '审批', permission: 'human-signature',
    confirm: { required: true, message: `${title}：确认以你的署名执行？（这一步不改判定状态，除非它是终止）` },
    hint, input: { fields }, server: run })

  out.push(surface.action({ plugin_id: me, id: 'gate.nudge', title: '催办（真落账）', views: ['contractor', 'supplier'],
    group: '审批', order: 10, permission: 'human-signature', inline: true,
    confirm: { required: true, message: '催办只留一条「谁催了哪个门」的事实（不改判定）：确认？' },
    hint: '落 `gate/nudged`（body 恰 5 键，不含理由正文）；已决定的门会被拒（gate-already-decided）',
    input: { fields: [
      { name: 'gate_id', label: '门 id', type: 'text', required: true, help: '从队列卡片复制（ap-…）' },
      { name: 'signature', label: '催办人（人签）', type: 'signature', required: true, help: 'human:<你的名字>' },
      { name: 'reason', label: '催办理由（进 0600 待办件，不进账本）', type: 'textarea', required: true },
    ] },
    server: async (ctx, input) => {
      const reason = String(input.reason ?? '')
      if (reason.trim() === '') {
        return { ok: false, code: 'empty-reason', reason: '理由为空：催办要有一句人话',
          next_action: '写一句"为什么现在要催"再提交' }
      }
      const view = String(ctx.view ?? 'contractor')
      const digest = hex64(reason)
      const staged = host.stage('gate-nudges', { schema: 1, kind: 'gate-nudge', requested_action: 'nudge',
        view, gate_id: asText(input.gate_id), reason, note: reason, reason_sha256: digest,
        actor: asText(input.signature) }, { name: `gn-${view}-${digest.slice(0, 12)}.json` })
      if (!staged.ok) return staged
      const run = host.runPython(nudgeTool, ['--inbox', `${host.sharedDir}/gate-nudges`,
        '--ui-shared', host.sharedDir, '--views', 'contractor,supplier', '--view', view,
        '--ledger-contractor', ledgerC(), '--ledger-supplier', ledgerS(),
        '--actor', asText(input.signature), '--now', host.now()])
      const json = run.json ?? {}
      const refused = (json.refused ?? [])[0] ?? null
      const duplicate = (json.duplicates ?? [])[0] ?? null
      return { ok: run.ok && json.ok === true && refused === null,
        code: refused?.code ?? (duplicate ? 'already-nudged' : (json.ok ? 'nudged' : 'writer-failed')),
        reason: refused?.reason ?? run.reason ?? '',
        next_action: refused?.next_action ?? (duplicate
          ? '同一句理由催过了（幂等，账本零新增）：换个说法或先看队列里"已催 N 次"'
          : '催办已落 `gate/nudged`：队列里会出现「已催 N 次 @ts」（不改门的判定）'),
        result: { pending: staged.file, ledger_added: json.ledger_added ?? 0, refused, duplicates: json.duplicates ?? [] } }
    } }))

  const stepAction = (id, step, title, extraFields, hint) => surface.action({
    plugin_id: me, id, title, views: ['contractor', 'supplier'], group: '审批',
    order: step === 'request' ? 5 : 20, permission: 'human-signature', inline: true,
    confirm: { required: true, message: `${title}：确认以你的署名执行？` },
    hint, input: { fields: [
      { name: 'gate_id', label: '门 id', type: 'text', required: step !== 'request', help: '从队列卡片复制（ap-…）' },
      ...extraFields,
      { name: 'signature', label: '署名（人签）', type: 'signature', required: true, help: 'human:<你的名字>' },
      { name: 'note', label: '理由', type: 'textarea', required: step === 'abort',
        help: step === 'abort' ? '终止必须留理由（事后要能回答"为什么作废"）' : '进 0600 待办件，不进账本正文' },
    ] },
    server: async (ctx, input) => {
      const payload = { kind: 'gate-actions', action: step, view: String(ctx.view ?? 'contractor'),
        gate_id: asText(input.gate_id), scope: asText(input.scope), ref: asText(input.ref),
        summary: asText(input.summary), timeout_policy: asText(input.timeout_policy) || 'remind',
        timeout_s: Number(input.timeout_s ?? 3600), escalate_to: asText(input.escalate_to),
        approvers: String(input.approvers ?? '').split(/[,\s]+/).map(asText).filter(Boolean),
        actor: asText(input.signature), note: String(input.note ?? '') }
      const staged = host.stage('gate-actions', payload)
      if (!staged.ok) return staged
      const run = host.runPython(gateTool, ['--step', step, '--request', staged.path,
        '--ui-shared', host.sharedDir, '--ledger-contractor', ledgerFromView(ctx.view),
        '--view', String(ctx.view ?? 'contractor'), '--now', host.now()])
      const json = run.json ?? {}
      return { ok: run.ok && json.ok === true, code: json.refusal?.code ?? (json.ok ? step : 'writer-failed'),
        reason: json.refusal?.reason ?? run.reason ?? '',
        next_action: json.refusal?.next_action ?? json.next_action_runtime ?? '看 result 里的账本增量与下一步',
        result: { pending: staged.file, approval_id: json.approval_id ?? null, escalated_to: json.escalated_to ?? null,
          applied: json.applied ?? [], ledger_added: json.ledger_added ?? 0, stdout: run.stdout ? run.stdout.slice(-400) : '' } }
    } })

  const ledgerFromView = (view) => (String(view) === 'supplier' ? ledgerS() : ledgerC())

  out.push(stepAction('gate.request', 'request', '提交人工门（开一个待批门）', [
    { name: 'scope', label: 'scope（待批对象）', type: 'text', required: true, help: '如 quote.submit / change.approve' },
    { name: 'ref', label: 'ref（被批对象的 id）', type: 'text', required: true, help: '如 q-… / aw-… / chg-…' },
    { name: 'summary', label: '一句话摘要（给人看）', type: 'text' },
    { name: 'timeout_policy', label: '超时策略', type: 'select', options: ['remind', 'escalate', 'abort'],
      default: 'remind', help: '**没有"超时自动批准"**；escalate 必须给上级' },
    { name: 'timeout_s', label: '超时秒数', type: 'number', min: 1, max: 7776000, default: 3600 },
    { name: 'escalate_to', label: '升级/上级（policy=escalate 时必填）', type: 'text', help: 'human:<上级名字>' },
    { name: 'approvers', label: '审批人（逗号分隔，默认自己）', type: 'text', help: 'human:<名字>' },
  ], '开一个待批门 = 落 `approval/requested`；可等、可催、可升级、可终止（都不是自动批准）'))

  out.push(stepAction('gate.escalate', 'escalate', '升级到下一角色', [
    { name: 'escalate_to', label: '升级给（human:<名字>）', type: 'text', required: true,
      help: '推荐用「授权区间」页给出的下一角色' },
  ], '落 `approval/escalated`（与 ApprovalService.sweep 的 escalate 分支同形）；**升级不是批准**'))

  out.push(stepAction('gate.delegate', 'delegate', '委托给另一个人等', [
    { name: 'escalate_to', label: '委托给（human:<名字>）', type: 'text', required: true },
  ], '落 `approval/escalated`（action=delegate）；门仍是 pending，只是换了人'))

  out.push(stepAction('gate.abort', 'abort', '终止这个门', [],
    '落 `approval/aborted`：本次意图作废（需重新发起），**必须留理由**；已决定的门会被拒'))

  out.push(surface.shortcut({ plugin_id: me, id: 'shortcut.gate-queue', keys: 'g', action: 'gate.nudge',
    title: '催办一个门', order: 5 }))

  out.push(surface.notificationSource({ plugin_id: me, id: 'notify.gates', title: '审批队列（等太久的门）',
    order: 5, poll: () => {
      const items = []
      for (const view of ['contractor', 'supplier']) {
        for (const gate of pendingRows(host.rows(view))) {
          items.push({ id: `gate:${view}:${gate.approval_id}`, level: gate.overdue ? 'warn' : 'info',
            at: gate.requested_at, ref: gate.ref,
            title: `${gate.approval_id} 等 ${gate.waited}（${view}）：${gate.scope}`,
            body: `卡在 ${gate.who} · 已催 ${gate.nudge_count} 次 · ${gate.overdue ? '已超时（策略会执行，但永不自动批准）' : '未超时'}`,
            next_action: '去「审批队列」催办 / 升级 / 终止（人签）' })
        }
      }
      return items
    } }))

  out.push(surface.statusItem({ plugin_id: me, id: 'status.gates', title: '人工门', order: 5, read: () => {
    const c = pendingRows(host.rows('contractor'))
    const s = pendingRows(host.rows('supplier'))
    const overdue = c.concat(s).filter((gate) => gate.overdue).length
    return { text: `待批 ${c.length + s.length}（超时 ${overdue}）`,
      level: overdue ? 'warn' : (c.length + s.length ? 'ok' : 'ok'),
      next_action: c.length + s.length ? '等不代表卡死：可催、可升级、可终止' : '' }
  } }))

  return out
}
