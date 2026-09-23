/**
 * `system/approval` 的 **GUI 贡献** —— 审批队列（DEF-023：**可等 / 可催 / 可升级 / 可终止 / 可委托**，
 * 且催办**真落账**；DEF-008：**可批准 / 可驳回**）。
 *
 * 注册的东西（全部经注册面 `src/system/webui/code/ui-surface.mjs`）：
 *   · 面板 `gate.queue`（承包商道）与 `gate.queue.supplier`（供应商道）：门卡片表 —— 待批对象 / 卡在谁 /
 *     等待时长（按**事实时刻**算，不取墙钟）/ 超时策略与倒计时 / 已催 N 次 @ts / 升级与委托记录；
 *   · 面板 `gate.decided`：**已决定的门**（批准/驳回留痕：谁在何时、意见是什么）—— 批完能回读；
 *   · 面板 `gate.todo`（工作台）：一行一条"要人决定的事" + 可复制的 next_action；
 *   · 动作（都是**界内真动作**，服务端一半落 0600 待办件 → 唯一写者落账）：
 *       `gate.grant`    **批准** → `src/system/approval/tools/gate-actions.py --step grant` 落 `approval/granted`
 *       `gate.deny`     **驳回** → 同上 `--step deny` 落 `approval/denied`（**必须留理由**）
 *       `gate.nudge`    催办 → `src/domain/gate-timeline/tools/gate-nudge.py`（既有唯一写者）落 `gate/nudged`
 *       `gate.escalate` 升级 → 同上 `--step escalate` 落 `approval/escalated`
 *       `gate.delegate` 委托 → 同上 `--step delegate`
 *       `gate.abort`    终止 → `--step abort` 落 `approval/aborted`（**必须留理由**）
 *       `gate.request`  开一个待批门 → `--step request` 落 `approval/requested`
 *   · 通知源 `notify.gates`（等太久的门）、状态栏项 `status.gates`。
 *
 * 纪律：本文件**不写账本**（只 spawn 唯一写者）；签名动作的署名必须以 `human:` 开头（壳与写者各校验一次）；
 * 已决定的门不允许再批/再催/再升级/再终止（`gate-already-decided`，写者自己判）。
 *
 * **行内动作的字段名必须与行键同名**（外壳按**字段名**在行对象里取值 ⇒ 名字对不上就等于让人手抄门 id）：
 * 行的键就是 `gate_id`（`id` 与 `approval_id` 是同一个值），动作的入参字段也叫 `gate_id`。
 */
import { createHash } from 'node:crypto'

export const plugin_id = 'system/approval'

const asText = (value) => (typeof value === 'string' ? value.trim() : '')

/**
 * 工作台的卡头那句「有 N 件需要你处理」**只该算本侧**（P13 可用性修）：卡片把两侧插件贡献的待办并在一起，
 * 而"需要你处理"必须是**你能真去办**的 —— 对面侧的条目照旧列出来（带侧标），但降级成"信息"，
 * 并说清"这一步由哪一侧的人办"。未登录 ⇒ 没有"本侧"，一律按"信息"算（协作面会在卡上留一条"先登录"）。
 */
const mySideOf = (ctx) => asText(ctx?.identity?.side)
const sideScoped = (ctx, itemSide, item) => {
  const mine = mySideOf(ctx)
  if (mine === itemSide) return item
  const label = itemSide === 'contractor' ? '承包商侧' : '供应商侧'
  const why = mine === ''
    ? `（**未登录**：登录${label}之后这一条才算"需要你处理"）`
    : `（**不是你要办的**：这一步由${label}的人做 —— 卡头「有 N 件需要你处理」只算本侧）`
  const body = asText(item.body)
  return { ...item, level: (item.level === 'warn' || item.level === 'bad') ? 'info' : item.level,
    body: `${body}${body ? ' ' : ''}${why}` }
}
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
    // 超时倒计时**只由账本事实算**：`timeout_s` 与开单时刻都在 `approval/requested` 的 body 里（ADR-0022），
    // 上次动作时刻取该门最后一次写入的行（升级/委托/催办都会刷新它）。不取墙钟。
    const left = since === null ? null : Math.round(gate.timeout_s - since)
    return { ...gate, waited_seconds: waited, waited: human(waited), since_last: human(since),
      timeout_left_seconds: left,
      timeout_left: left === null ? '—' : (left > 0 ? `剩 ${human(left)}` : `已超时 ${human(-left)}`),
      overdue: since !== null && since >= gate.timeout_s,
      policy_label: POLICY_LABEL[gate.timeout_policy] ?? gate.timeout_policy,
      nudge_count: nudge.count, last_nudged_at: nudge.last_at, last_nudged_by: nudge.by,
      waiting_on: (gate.approvers ?? []).join(' ') || (gate.escalate_to ?? ''),
      // 审批人**从账本回读**（开单时已写进 `approval/requested` 的 body）；只有开单时真的没点名审批人
      // （旧行/无审批人）才如实说「未指定审批人」——不再把它说成「账本行未带」这种口径缺陷。
      who: (gate.approvers ?? []).join(' ') || (gate.escalate_to ?? '（未指定审批人）'),
      // **行键之一**：行内动作按**字段名**在行对象里取值（外壳 `row_actions` 的预填判据）—— 所以行里必须有
      // 与 `gate.grant` / `gate.deny` / `gate.nudge` / `gate.escalate` 入参**同名**的键。
      // `id` / `approval_id` 也留着（别的面板与协作面按它们认对象），三者恒等。
      gate_id: gate.approval_id,
      next_action: `批准 / 驳回 / 催办 / 升级 / 终止都在卡片上（人签 ${gate.approval_id}）；`
        + '越界金额该找谁批，看本视图的「授权区间（谁能批到多少）」面板（不用再回旧页）' }
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
    title: view === 'supplier' ? '我这边待批的门（供应商道）' : '审批队列（可批 / 可驳 / 可等 / 可催 / 可升级 / 可终止 / 可委托）',
    view, order, kind: 'table',
    actions: ['gate.grant', 'gate.deny', 'gate.nudge', 'gate.escalate', 'gate.delegate', 'gate.abort'],
    data: () => {
      const rows = host.rows(view)
      const gates = pendingRows(rows)
      const decided = gatesOf(rows).filter((gate) => gate.status !== 'pending')
      const moment = asOf(rows)
      if (!gates.length) {
        return { ok: true, kind: 'table', degraded: true,
          // **降级原因第一行是人话**（机器码放括号里，仍然可 grep）：面板的 `reason` 由外壳原样渲染，
          // 写一个裸机器码就是把"读不懂"摆在第一行 —— 这是 P15 登记的那条 P2 缺陷。
          reason: `这一侧现在没有待批的门（机器码 no-pending-gate；已决定 ${decided.length} 条在下面「已决定的门」里）`,
          next_action: '用「提交人工门（开一个待批门）」把要人决定的事提出来；'
            + '已经决定过的门不会被"再批一次"翻案（写者判 gate-already-decided）',
          columns: [{ key: 'approval_id', label: '门' }], rows: [],
          counts: { pending: 0, decided: decided.length }, note: `事实时刻 ${moment || '—'}` }
      }
      return { ok: true, kind: 'table',
        columns: [
          { key: 'approval_id', label: '门', type: 'code' },
          { key: 'scope', label: '待批对象（scope）', type: 'code', filter: 'enum' },
          { key: 'ref', label: '引用（ref）', type: 'code' },
          { key: 'who', label: '卡在谁（点名的审批人）', type: 'code' },
          { key: 'waited', label: '已等（按事实时刻）' },
          { key: 'policy_label', label: '超时策略', filter: 'enum' },
          { key: 'timeout_left', label: '超时剩余（按事实时刻）' },
          { key: 'overdue', label: '已超时？' },
          { key: 'nudge_count', label: '已催次数', filter: 'number' },
          { key: 'last_nudged_at', label: '最后一次催办 @ts', filter: 'date' },
          { key: 'escalated_to', label: '升级/委托给' },
        ],
        rows: gates.map((gate) => ({ id: gate.approval_id, ...gate,
          overdue: gate.overdue ? '是（策略会执行；永远不自动批准）' : '否',
          escalated_to: gate.escalated_to ?? '' })),
        row_actions: ['gate.grant', 'gate.deny', 'gate.nudge', 'gate.escalate', 'gate.delegate', 'gate.abort'],
        // **批量人签决定**（一次署名 → 逐条落账）：表头出现勾选框与「批量人签决定」按钮；
        // 选几条就逐条各跑一次唯一写者（见 `gate.decide-batch` 的服务端一半）。
        bulk: 'gate.decide-batch',
        counts: { pending: gates.length, decided: decided.length,
          nudges: gates.reduce((sum, gate) => sum + gate.nudge_count, 0) },
        note: `事实时刻 ${moment || '—'}（等待时长与超时剩余都相对账本里最大的 ts 算，不取墙钟）；`
          + '**「批准 / 驳回」在行内**：署名必须等于会话身份（服务端判 403 signer-mismatch），'
          + '落的是既有事件 `approval/granted` / `approval/denied`（**不新造事件类型**），写者仍是'
          + ' `tools/gate-actions.py`（GUI 不写账本）；驳回必须留理由（逐字进账本 `comment`）；'
          + '只有开单时**点名**的审批人能批（`approver-not-named`），已决定的门不能再批'
          + '（`gate-already-decided`）；'
          + '「卡在谁 / 超时策略 / 超时剩余 / 该催谁」**开单后即可回读**（追加键 approvers/timeout_policy/'
          + 'timeout_s/escalate_to/requested_at，ADR-0022；旧行按缺省读）；'
          + '超时策略只有 remind/escalate/abort，**不存在超时自动批准**' }
    } })

  /** 已决定的门：批准/驳回**留痕可回读**（谁在何时、意见是什么）——批完不必去翻账本 JSONL。 */
  const decidedPanel = (view, order) => surface.panel({
    plugin_id: me, id: view === 'supplier' ? 'gate.decided.supplier' : 'gate.decided',
    title: '已决定的门（批准 / 驳回留痕）', view, order, kind: 'table', actions: [],
    data: () => {
      const rows = host.rows(view)
      const moment = asOf(rows)
      const decided = gatesOf(rows).filter((gate) => gate.status !== 'pending')
        .map((gate) => ({ id: gate.approval_id, ...gate,
          gate_id: gate.approval_id,
          status_label: gate.status === 'granted' ? '已批准' : (gate.status === 'denied' ? '已驳回' : gate.status),
          decision: `${gate.last_event}（${gate.status}）`,
          comment: asText(gate.comment) || '（没有意见正文）' }))
      if (!decided.length) {
        return { ok: true, kind: 'table', degraded: true,
          reason: '这一侧还没有被决定过的门（机器码 no-decided-gate）——不是坏了，是还没批过',
          next_action: '在「审批队列」的行内点「批准」或「驳回」；一次决定落一条账本事实，之后在这里能读回来',
          columns: [{ key: 'approval_id', label: '门' }], rows: [], counts: { decided: 0 } }
      }
      return { ok: true, kind: 'table',
        columns: [
          { key: 'approval_id', label: '门', type: 'code' },
          { key: 'status_label', label: '结论', filter: 'enum' },
          { key: 'scope', label: '待批对象（scope）', type: 'code', filter: 'enum' },
          { key: 'ref', label: '引用（ref）', type: 'code' },
          { key: 'decided_by', label: '谁决定的', type: 'code' },
          { key: 'last_at', label: '决定时刻（账本 ts）', filter: 'date' },
          { key: 'comment', label: '意见（账本 comment）' },
          { key: 'decision', label: '落账事件', type: 'code' },
        ],
        rows: decided,
        counts: { decided: decided.length,
          granted: decided.filter((gate) => gate.status === 'granted').length,
          denied: decided.filter((gate) => gate.status === 'denied').length },
        note: `事实时刻 ${moment || '—'}；每一行的结论都来自账本里这条门**最后一次**写入的行`
          + '（`approval/granted` / `approval/denied` / `approval/aborted`），不是界面记的状态；'
          + '意见正文逐字来自账本 `comment`' }
    } })

  out.push(surface.view({ plugin_id: me, id: 'gate.workspace', title: '审批队列', order: 5, view: 'contractor',
    hint: '批准 / 驳回 / 催办 / 升级 / 终止 / 委托都在门卡片的行内；前两个改判定，后四个不改判定' }))
  out.push(queuePanel('contractor', 6))
  out.push(decidedPanel('contractor', 7))
  out.push(queuePanel('supplier', 70))
  out.push(decidedPanel('supplier', 71))

  out.push(surface.panel({ plugin_id: me, id: 'gate.todo', title: '要人决定的事（待人工门）', view: 'home',
    order: 15, kind: 'list',
    data: (ctx) => {
      const items = []
      for (const view of ['contractor', 'supplier']) {
        const label = view === 'supplier' ? '供应商侧' : '承包商侧'
        for (const gate of pendingRows(host.rows(view))) {
          // 侧标写在标题里（`workbench-two-sides.md` 的纪律），**级别按本侧**（卡头计数只算本侧）。
          items.push(sideScoped(ctx, view, { level: gate.overdue ? 'warn' : 'info',
            title: `${label}：人工门 ${gate.approval_id} 等 ${gate.waited}：${gate.scope}（${gate.ref}）`,
            // 人名与时刻不裸展示内部标识（`human:liangzi` / 毫秒 ISO）——与名册、协作面同一口径
            body: `卡在 @${asText(gate.who).replace(/^human:/, '')} · 已催 ${gate.nudge_count} 次`
              + `${gate.last_nudged_at ? ` @${gate.last_nudged_at}` : ''}`
              + ` · 超时策略 ${gate.policy_label}（${gate.timeout_left}）`,
            next_action: `深链 ${host.prefix}/app/${view}/ → 「审批队列」卡片上点催办/升级/终止（人签）`,
            // **跨面板去重的判据**（机制只比较字符串，不解读）：同一个门 id ⇒ 与别块面板列的那条是同一件事，
            // 外壳会合并成一条（见 `app-shell.mjs#foldPanelDuplicates`）。同一份 `ref` 让合并后的条目
            // **仍然能点进 `/app/<view>/gate/<id>/` 对象页**（指派/关注/评论都在那一页上）；
            // `view` 必须写出来：不写的话深链按"当前页的视角"拼 ⇒ 从工作台点过去会落在
            // `home` 视角（那里没注册 `gate` 对象类，只能如实说"本视图里没有这个对象"）。
            ref: { kind: 'gate', id: gate.approval_id, view, title: `审批门 ${gate.approval_id}` },
            dedupe_key: `gate:${gate.approval_id}` }))
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

  // ------------------------------------------------------------------ 批准 / 驳回（DEF-008：队列存在的理由）
  /**
   * 一个**共用**的服务端一半：`gate.grant` 与 `gate.deny` 只差一个 `--step`。
   *
   * 界面只做三件事：① 把这条门与**我这个署名**落成 0600 待办件（不写账本）；② spawn 唯一写者
   * `gate-actions.py`；③ 把写者回执（退出码 + stdout JSON）**原样**派生成本次回执。
   * 判定全部在写者里：门在不在本账本（`gate-not-found`）/ 是否已决定（`gate-already-decided`）/
   * 署名是不是开单时**点名**的审批人（`approver-not-named`）—— 任一不通过 ⇒ 账本零新增。
   *
   * 「侧只认会话」：动作总线是**一条**路由（`${prefix}/api/action/<id>`），`view` 是请求体给的 ——
   * 所以这里**不拿 `ctx.view` 当权威**：会话侧与会话给的 view 不一致就**具名拒绝**（`cross-side-action`），
   * 绝不把供应商会话的署名写进承包商账本（§10.3「侧与署名只认会话」）。
   */
  const decideAction = (id, step, title, hint) => surface.action({
    plugin_id: me, id, title, views: ['contractor', 'supplier'], group: '审批', inline: true,
    order: step === 'grant' ? 1 : 2, permission: 'human-signature',
    confirm: { required: true, message: `${title}：确认以你的署名${step === 'grant' ? '批准' : '驳回'}这条门？`
      + '（这一步**改判定**，落一条账本事实，不可撤销）' },
    hint, input: { fields: [
      { name: 'gate_id', label: '门 id', type: 'text', required: true, help: '从队列卡片复制（ap-…）；行内点「批准」会自动带上' },
      { name: 'signature', label: `署名（人签，${step === 'grant' ? '批准人' : '驳回人'}）`, type: 'signature',
        required: true, help: 'human:<你的名字> —— 服务端要求它等于会话身份，且必须是开单时点名的审批人' },
      { name: 'comment', label: step === 'grant' ? '意见（进账本 comment）' : '驳回理由（必填，进账本 comment）',
        type: 'textarea', required: step === 'deny',
        help: step === 'grant' ? '可选：一句人话，逐字落进 `approval/granted.comment`'
          : '必填：被拒的人要能从账本里读到「为什么不行」' },
    ] },
    server: async (ctx, input) => {
      const gateId = asText(input.gate_id)
      if (gateId === '') {
        return { ok: false, code: 'gate-id-missing', reason: '没给门 id：批哪一条必须显式',
          next_action: '在「审批队列」的门卡片行内点「批准 / 驳回」（门 id 会自动带上），或从卡片复制 ap-…' }
      }
      const comment = String(input.comment ?? '')
      if (step === 'deny' && comment.trim() === '') {
        return { ok: false, code: 'empty-reason', reason: '驳回必须留理由（要把"为什么不行"落进账本）',
          next_action: '在「驳回理由」里写清楚再提交（理由会逐字进 `approval/denied.comment`）' }
      }
      const asked = String(ctx.view ?? 'contractor')
      const mine = asText(ctx?.identity?.side)
      if (mine !== '' && mine !== asked) {
        // 会话侧 ≠ 请求声明的 view：**不落待办件、不写账本**，具名拒绝（免得用别人的侧签别人的门）
        return { ok: false, code: 'cross-side-action',
          reason: `你的会话是 ${mine} 侧，却在 ${asked} 侧发起${title}：侧只认会话（请求体改不动"我是谁"）`,
          next_action: `在 ${mine} 侧自己的「审批队列」里决定属于你这一侧的门`
            + '（跨侧的门属于对方的账本，你这边看不到、也不该批）' }
      }
      const view = mine === '' ? asked : mine
      const payload = { kind: 'gate-actions', action: step, view, gate_id: gateId,
        actor: asText(input.signature), note: comment }
      const staged = host.stage('gate-actions', payload)
      if (!staged.ok) return staged
      const run = host.runPython(gateTool, ['--step', step, '--request', staged.path,
        '--ui-shared', host.sharedDir, '--ledger-contractor', ledgerFromView(view),
        '--view', view, '--now', host.now()])
      const json = run.json ?? {}
      const refusal = json.refusal ?? null
      const ok = Boolean(run.ok && json.ok === true)
      const added = Number(json.ledger_added ?? 0)
      // 幂等重跑（同一份载荷已消费过）：**账本零新增**，别把它说成"又批了一次"
      const duplicated = Array.isArray(json.duplicates) && json.duplicates.length > 0
      const event = json.event ?? (step === 'grant' ? 'approval/granted' : 'approval/denied')
      const code = refusal?.code ?? json.code
        ?? (duplicated ? 'already-applied' : (ok ? (step === 'grant' ? 'granted' : 'denied') : 'writer-failed'))
      return { ok, code, reason: refusal?.reason ?? (ok ? '' : (run.reason ?? '')),
        next_action: refusal?.next_action ?? json.next_action_runtime
          ?? (ok ? (duplicated
            ? '同一份载荷已经消费过（幂等，账本零新增）：这条门的状态以「已决定的门」里读到的为准'
            : `已落 ${event}（本动作账本 +${added} 行）：这条门从待批里消失、`
              + '出现在「已决定的门」里（谁在何时、什么意见都能读回来）')
            : '看 result.stdout 定位后重提（本动作账本零新增）'),
        result: { pending: staged.file, pending_file: staged.name, view, step,
          approval_id: json.approval_id ?? gateId, scope: json.scope ?? '', ref: json.ref ?? '',
          status: json.status ?? '', decided_by: json.decided_by ?? asText(input.signature),
          decided_at: json.decided_at ?? '', event, ledger_added: added,
          applied: json.applied ?? [], stdout: run.stdout ? run.stdout.slice(-400) : '' } }
    } })

  out.push(decideAction('gate.grant', 'grant', '批准（人签，改判定）',
    '落 `approval/granted`（既有事件）：署名必须 == 会话身份，且必须是开单时点名的审批人；'
    + '已决定的门会被拒（gate-already-decided，账本零新增）。界面不代签、不写账本。'))
  out.push(decideAction('gate.deny', 'deny', '驳回（人签，改判定，必留理由）',
    '落 `approval/denied`（既有事件），理由逐字进账本 `comment`；'
    + '判定与「批准」同一条（门在不在 / 决定过没有 / 是不是点名的审批人）。'))

  /**
   * **批量人签决定**（一次署名 → **逐条落账**）—— 队列里常有十几条门，逐条点在现实里很磨人。
   *
   * 语义与 `gate.grant` / `gate.deny` **完全同一条**，只是把「一次署名」用在多条门上：
   *   · 人签门一字未动（机制层校验「已登录 + 署名 == 会话身份」，插件侧再核一遍 + 跨侧具名拒绝）；
   *   · 落账仍是**一条门一次**：每条门**单独**跑唯一写者 `gate-actions.py --step grant|deny`
   *     （同一条写路径、同一批事件 `approval/granted` / `approval/denied`），没有「一个动作落多条」的旁路；
   *   · 判定全在写者里（门不在本账本 `gate-not-found` / 已决定 `gate-already-decided` /
   *     不是开单时点名的审批人 `approver-not-named`）⇒ 某一条被拒**不影响**其余条；
   *   · **幂等**：同一条门的同一份载荷再签一次，写者认归档摘要 ⇒ `already-applied`（**账本零新增**）。
   */
  const BATCH_DECIDE_MAX = 50
  out.push(surface.action({ plugin_id: me, id: 'gate.decide-batch',
    title: '批量人签决定（批准 / 驳回，多选一次签）', views: ['contractor', 'supplier'], group: '审批',
    order: 3, permission: 'human-signature',
    confirm: { required: true, message: '批量决定 = 一次署名、**逐条**改判定（每条门各落一条 '
      + '`approval/granted` / `approval/denied`，不可撤销）：确认以你的署名执行？' },
    hint: '一次署名 → 逐条落账：每条门**单独**跑唯一写者 `gate-actions.py`（`--step grant|deny`）；'
      + '写者逐条判定（门不在本账本 / 已经决定过 / 你不是开单时点名的审批人）⇒ 某一条被拒**不影响**其余条；'
      + '回执逐条给「已批准 / 已驳回 / 已经决定过（幂等，零新增）/ 被拒 + 原因」；同一批重签不重复落账',
    input: { bulk: 'ids', fields: [
      { name: 'gate_id', label: '门 id（批量时由勾选的行自带）', type: 'text',
        help: 'ap-…；在「审批队列」里勾选后不必手抄' },
      { name: 'decision', label: '结论（对所选每一条门）', type: 'select', options: ['grant', 'deny'],
        default: 'grant', help: 'grant=批准、deny=驳回（与单条动作同一条判定；驳回必须给理由）' },
      { name: 'signature', label: '署名（人签）', type: 'signature', required: true, help: 'human:<你的名字>' },
      { name: 'comment', label: '意见 / 驳回理由（驳回必填，逐字进账本 comment）', type: 'textarea' },
    ] },
    server: async (ctx, input) => {
      const step = asText(input.decision) === 'deny' ? 'deny' : 'grant'
      const comment = String(input.comment ?? '')
      if (step === 'deny' && comment.trim() === '') {
        return { ok: false, code: 'empty-reason', reason: '批量驳回也要留理由（每条门都要能把"为什么不行"落进账本）',
          next_action: '在「驳回理由」里写清楚再提交（理由会逐字进每条门的 `approval/denied.comment`）' }
      }
      // 「侧只认会话」：与单条决定同一条（绝不把供应商会话的署名写进承包商账本）
      const asked = String(ctx.view ?? 'contractor')
      const mine = asText(ctx?.identity?.side)
      if (mine !== '' && mine !== asked) {
        return { ok: false, code: 'cross-side-action',
          reason: `你的会话是 ${mine} 侧，却在 ${asked} 侧发起批量决定：侧只认会话（请求体改不动"我是谁"）`,
          next_action: `在 ${mine} 侧自己的「审批队列」里决定属于你这一侧的门`
            + '（跨侧的门属于对方的账本，你这边看不到、也不该批）' }
      }
      const view = mine === '' ? asked : mine
      const raw = Array.isArray(input.ids) && input.ids.length ? input.ids : [input.gate_id]
      const ids = [...new Set(raw.map((item) => asText(typeof item === 'object' && item !== null
        ? (item.gate_id ?? item.approval_id ?? item.id) : item)).filter(Boolean))]
      if (!ids.length) {
        return { ok: false, code: 'gate-id-missing', reason: '没有选中任何门',
          next_action: '在「审批队列」里用表格左侧的勾选框选几条门（表头可全选本页），再点「批量人签决定」' }
      }
      if (ids.length > BATCH_DECIDE_MAX) {
        return { ok: false, code: 'batch-too-large',
          reason: `一次最多决定 ${BATCH_DECIDE_MAX} 条门，收到 ${ids.length} 条`,
          next_action: `先用「搜这块 / 按列筛选」把命中行缩到 ≤ ${BATCH_DECIDE_MAX} 行（计数行会跟着变），`
            + `再点表头那颗「选中全部命中行（N）」重来 —— 不要靠手工勾行：勾选**不跨页**`
            + `（第 1 页勾的在翻页后不跟着走）。本动作账本零新增` }
      }
      const actor = asText(input.signature)
      const results = []
      for (const gateId of ids) {                     // 顺序逐条：一条门一次写者运行，回执逐条可指认
        if (!/^ap-[0-9]{4,}$/.test(gateId)) {
          results.push({ gate_id: gateId, where: 'refused', ok: false, code: 'gate-id-malformed',
            reason: `门 id 形状非法：${gateId}`, next_action: '从队列卡片上取真门 id（形如 ap-0007）',
            ledger_added: 0 })
          continue
        }
        // 待办件名由宿主按**载荷摘要**生成 ⇒ 同一批的同一份意图永远是同一个名字：
        // 再签一次不会新落一个待办件，写者据归档摘要判 `already-applied`（幂等，账本零新增）。
        const staged = host.stage('gate-actions', { kind: 'gate-actions', action: step, view, gate_id: gateId,
          actor, note: comment })
        if (!staged.ok) {
          results.push({ gate_id: gateId, where: 'refused', ok: false, code: staged.code,
            reason: staged.reason, next_action: staged.next_action, ledger_added: 0 })
          continue
        }
        const run = host.runPython(gateTool, ['--step', step, '--request', staged.path,
          '--ui-shared', host.sharedDir, '--ledger-contractor', ledgerFromView(view),
          '--view', view, '--now', host.now()])
        // 本次运行**只处理这一条门**（`--request` 指到这一份待办件）⇒ 这条回执就是这一条门的回执。
        // 归属仍显式指认（先按待办件名，再要求清单里恰好只有一条），绝不拿 `applied[0]` 当结论。
        const receipt = host.writerReceipt(run)
        // 归属显式指认：这一条门的这次运行只处理这一份待办件 ⇒ applied 里的条目**必须**写的就是这个门
        // （`applied[].approval_id`）；对不上宁可如实报拒，也不认领别人的条目、也不把真落账说成失败。
        const named = (entry) => asText(entry?.approval_id) === gateId
        const written = receipt.applied.length > 0 && receipt.applied.every(named) ? receipt.applied[0] : null
        const already = receipt.duplicates.length === 1 ? receipt.duplicates[0] : null
        const refusedRow = receipt.refusal ?? (receipt.refused.length === 1 ? receipt.refused[0] : null)
        const appliedHere = Boolean(written)
        const idMismatch = receipt.applied.length > 0 && !written
        const ok = Boolean(receipt.ok && (appliedHere || already))
        const added = appliedHere ? Number(receipt.ledger_added ?? 0) : 0
        const event = appliedHere ? asText(written.event) : ''
        results.push({ gate_id: gateId, where: appliedHere ? 'applied' : (already ? 'duplicates' : 'refused'),
          ok, code: ok ? (appliedHere ? (step === 'grant' ? 'granted' : 'denied') : 'already-applied')
            : (refusedRow?.code ?? receipt.code ?? 'writer-failed'),
          reason: ok ? '' : (refusedRow?.reason ?? receipt.reason ?? ''),
          next_action: refusedRow?.next_action ?? receipt.next_action ?? '',
          event, scope: appliedHere ? asText(written.scope) : asText(receipt.json?.scope),
          ref: appliedHere ? asText(written.ref) : asText(receipt.json?.ref),
          decided_at: appliedHere ? asText(written.decided_at) : '', decided_by: actor,
          ledger_added: added, writer_rc: receipt.rc, writer_ok: receipt.said,
          writer_consistency: idMismatch ? 'id-mismatch' : 'consistent',
          pending_file: staged.name, pending_duplicate: staged.duplicate === true,
          applied: appliedHere ? [written] : [], duplicates: already ? [already] : [],
          refused: refusedRow ? [refusedRow] : [] })
      }
      const decided = results.filter((row) => row.where === 'applied')
      const idempotent = results.filter((row) => row.where === 'duplicates')
      const failed = results.filter((row) => row.where === 'refused')
      const ledgerAdded = results.reduce((sum, row) => sum + Number(row.ledger_added ?? 0), 0)
      const verb = step === 'grant' ? '已批准' : '已驳回'
      const one = (row) => `${row.gate_id}：${row.where === 'applied' ? `${verb}（${row.event}，本动作 +1 行）`
        : (row.where === 'duplicates' ? '**已经决定过**（幂等：这一条零新增）'
          : `**被拒**（${row.code}${row.reason ? `：${row.reason}` : ''}）`)}`
      const next = `${results.length} 条门：${verb} ${decided.length} 条 · 已决定过（幂等）${idempotent.length} 条 · `
        + `被拒 ${failed.length} 条（本次账本 +${ledgerAdded} 行）—— ${results.map(one).join('；')}`
        + (failed.length
          ? `。被拒的这几条要**单独**处理：${failed.map((row) => `${row.gate_id} ⇒ `
            + `${row.next_action || row.code}`).join('；')}（被拒的那几条账本零新增，其余条不受影响）`
          : `。${verb}的门在「已决定的门」里可回读（谁在何时、什么意见）`)
      return { ok: (decided.length + idempotent.length) > 0,
        code: failed.length === 0 ? (decided.length ? `batch-${step}ed` : 'batch-already-decided')
          : ((decided.length + idempotent.length) ? 'batch-partial' : 'batch-refused'),
        reason: failed.map((row) => `${row.gate_id}: ${row.reason || row.code}`).join('；'),
        next_action: next,
        result: { batch: { total: results.length, step, view, decided: decided.length,
            already: idempotent.length, refused: failed.length, ledger_added: ledgerAdded,
            max_per_batch: BATCH_DECIDE_MAX, ids }, results, ledger_added: ledgerAdded } }
    } }))

  /** 批量驳回必须留理由（与单条 `gate.deny` 同一条判据；字段级校验表达不了「按结论条件必填」）。 */
  out.push(surface.validator({ plugin_id: me, id: 'validator.gate-decide-batch', title: '批量决定的理由规则',
    actions: ['gate.decide-batch'], order: 3,
    validate: (input) => (asText(input.decision) === 'deny' && String(input.comment ?? '').trim() === '')
      ? [{ field: 'comment', code: 'empty-reason',
        message: '驳回必须留理由（逐字进每条门的 approval/denied.comment）',
        next_action: '在「驳回理由」里写清楚"为什么不行"再提交' }]
      : [] }))

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
      // ---- **判据只有一条**：写者回执（退出码 + stdout JSON），且只认**本动作落的那一条待办件** --------
      // `gate-nudge.py` 是**邮箱式**写者：它一次消费 `gate-nudges/` 里同视角的**所有**待办件，而被拒的件
      // **不归档**（会一直留在邮箱里）。修前按 `refused[0]` / 全局 `json.ok` / 全局 `ledger_added` 判 ⇒
      // 同一封邮箱里只要还有**别人的**（或**上一次被拒的**）件，写者就把那条的结论当成整次运行的：
      // **本动作的行真落了、响应却报失败**（机制层标成 `writer_consistency=fake-failure`；用户会据此
      // 重复提交，比真失败更坏）。现在：ok/code/ledger_added/next_action **全部**从 `receipt` 派生，
      // 归属用 `staged.name` 显式指认（回执的每条 applied/duplicates/refused 都带 `file`），不猜第一条。
      const receipt = host.writerReceipt(run)
      const mine = receipt.item({ file: staged.name }) ?? receipt.item({ gate_id: asText(input.gate_id) })
      const written = mine && mine.where === 'applied' ? mine.entry : null
      const duplicated = mine && mine.where === 'duplicates' ? mine.entry : null
      const refusedRow = mine && mine.where === 'refused' ? mine.entry : null
      const ok = Boolean(written || duplicated)
      // 本动作**自己**真落了几行：一件 `gate/nudged` 就是 1 行（写者的逐条回执不带 ledger_added）
      const ledgerAdded = written ? Number(written.ledger_added ?? 1) : 0
      // 同一次运行里写者还处理了**别人**的（或上次留下的）待办件：如实列出来 —— 它们不是本动作的结论
      const mineName = staged.name
      const otherApplied = (receipt.applied ?? []).filter((row) => host.receiptFileName(row) !== mineName)
      const otherRefused = (receipt.refused ?? []).filter((row) => host.receiptFileName(row) !== mineName)
      const othersNote = otherApplied.length || otherRefused.length
        ? `（同一次运行里写者还处理了 ${otherApplied.length + otherRefused.length} 条**别的**待办件：`
          + `${otherApplied.length} 条已落行、${otherRefused.length} 条被拒 —— 那些不属于本动作）`
        : ''
      const code = ok ? (written ? 'nudged' : 'already-nudged')
        : (refusedRow?.code ?? receipt.code ?? (mine ? 'writer-refused' : 'writer-receipt-missing'))
      return { ok, code,
        reason: refusedRow?.reason ?? (ok ? '' : (receipt.reason || '')),
        next_action: ok
          ? (written
            ? `催办已落 \`gate/nudged\`（本动作账本 +${ledgerAdded} 行）：队列里会出现「已催 N 次 @ts」`
              + '（不改门的判定）'
            : '同一句理由催过了（幂等，账本零新增）：换个说法或先看队列里"已催 N 次"')
          : ((refusedRow?.next_action ?? receipt.next_action
            ?? `这条待办件（${mineName}）没在写者回执里出现（applied/duplicates/refused 都没有）`
              + '⇒ 本动作账本零新增：看 result.writer.stdout_tail 定位后重提') + othersNote),
        result: { pending: staged.file, pending_file: staged.name, ledger_added: ledgerAdded,
          applied: written ? [written] : [], duplicates: duplicated ? [duplicated] : [],
          refused: refusedRow ? [refusedRow] : [],
          others: { applied: otherApplied.map((row) => ({ file: row?.file ?? '', gate_id: row?.gate_id ?? '' })),
            refused: otherRefused.map((row) => ({ file: row?.file ?? '', code: row?.code ?? '' })) },
          writer: { rc: receipt.rc, stdout_ok: receipt.said, code: receipt.code,
            ledger_added: receipt.ledger_added, refused_codes: receipt.refused.map((row) => row?.code ?? ''),
            stdout_tail: receipt.stdout_tail } } }
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
      help: '下一角色从本视图的「授权区间（谁能批到多少）」面板直接读（越界时它给出 next_role）' },
  ], '落 `approval/escalated`（与 ApprovalService.sweep 的 escalate 分支同形）；**升级不是批准**'))

  out.push(stepAction('gate.delegate', 'delegate', '委托给另一个人等', [
    { name: 'escalate_to', label: '委托给（human:<名字>）', type: 'text', required: true },
  ], '落 `approval/escalated`（action=delegate）；门仍是 pending，只是换了人'))

  out.push(stepAction('gate.abort', 'abort', '终止这个门', [],
    '落 `approval/aborted`：本次意图作废（需重新发起），**必须留理由**；已决定的门会被拒'))

  out.push(surface.shortcut({ plugin_id: me, id: 'shortcut.gate-queue', keys: 'g', action: 'gate.nudge',
    title: '催办一个门', order: 5 }))

  /**
   * 通知源：**每个视角只逐条报最急的 N 个门，其余聚合成一条**（本批 P10）。
   *
   * 为什么：规模下这是**唯一会把通知中心吃光**的来源（实测 400 个待批门 = 400 条通知）。
   * 通知中心的用途是"哪件事在等我"，不是"把队列整个复述一遍"——队列本体在「审批队列」面板里，
   * 那里有分页、筛选与逐行动作。所以这里按**急 → 不急**排序取前 N 条，再补一条"另有 N 个门在等"
   * （带计数与去处的下一步）：一条也没丢（总数与去处都在），也不再让别的插件一条都进不来。
   */
  const NOTIFY_GATES_TOP = 20
  out.push(surface.notificationSource({ plugin_id: me, id: 'notify.gates', title: '审批队列（等太久的门）',
    order: 5, poll: () => {
      const items = []
      for (const view of ['contractor', 'supplier']) {
        const gates = pendingRows(host.rows(view))
        // 急的排前：先超时、再按等得久（`waited_seconds` 是既有的按事实时刻算出的读数；缺失按 0，不猜）
        const ordered = [...gates].sort((left, right) => (right.overdue ? 1 : 0) - (left.overdue ? 1 : 0)
          || Number(right.waited_seconds ?? 0) - Number(left.waited_seconds ?? 0)
          || String(left.approval_id).localeCompare(String(right.approval_id)))
        for (const gate of ordered.slice(0, NOTIFY_GATES_TOP)) {
          items.push({ id: `gate:${view}:${gate.approval_id}`, level: gate.overdue ? 'warn' : 'info',
            at: gate.requested_at, ref: gate.ref,
            title: `${gate.approval_id} 等 ${gate.waited}（${view}）：${gate.scope}`,
            body: `卡在 ${gate.who} · 已催 ${gate.nudge_count} 次 · ${gate.overdue ? '已超时（策略会执行，但永不自动批准）' : '未超时'}`,
            next_action: '去「审批队列」催办 / 升级 / 终止（人签）' })
        }
        const rest = ordered.length - Math.min(ordered.length, NOTIFY_GATES_TOP)
        const overdue = ordered.filter((gate) => gate.overdue).length
        if (rest > 0) {
          items.push({ id: `gate:${view}:rest:${ordered.length}`, level: overdue ? 'warn' : 'info',
            at: '',
            title: `（${view}）另有 ${rest} 个门在等批（这一条把它们合成一条）`,
            body: `共 ${ordered.length} 个待批，其中超时 ${overdue} 个；这里只逐条报了最急的 `
              + `${Math.min(ordered.length, NOTIFY_GATES_TOP)} 个 —— 一条都没删，只是不逐条占通知位`,
            next_action: `去「审批队列」看全部（${ordered.length} 行，可筛选/翻页/逐行催办）` })
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
