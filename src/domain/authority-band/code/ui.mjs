/**
 * `domain/authority-band` 的 **GUI 贡献** —— 「授权区间（谁能批到多少）」搬进 APP 外壳（DEF-036 / DEF-023）。
 *
 * 修的是哪一条：`gate.escalate` 的字段帮助让你「去看授权区间那一页」，而那一页是旧 SSR 页
 * （`/<view>/authority/`，它还教用户回终端）；APP 外壳里**一个面板都没有** ⇒ 越界了不知道该找谁。
 * 现在：本视图上就有一块面板，读的是**同一份口径**（`authority-band` 插件自己的 `checkOf`，
 * 确定性规则，不读账本、不取墙钟、不能批准），并且**越界时一键真的开一条人工门**（`authority.escalate`
 * → 既有唯一写者 `system/approval/tools/gate-actions.py --step request` 落 `approval/requested`）。
 *
 * 纪律（与插件本体逐条对齐）：
 *   · **只读配置快照**：`authority.*` 那些行从**受管 YAML** 读（与 `config-view` 的只读总览同一来源、
 *     同一个解析器）；非 `authority.` 前缀的键**读都不读**（私域零泄漏，由插件的 `readConfig` 保证）；
 *   · **未配置不得编限额**：`authority.bands.<角色>` 为 null/缺省 ⇒ `unconfigured` + `required_role`/
 *     `next_role` 留空，面板照实说「不知道就是不知道」，并且明写「**未配置 ≠ 额度无限**」；
 *   · **本插件不能批准、不能放行**：面板只算「这笔钱落在谁的区间里 / 越界多少 / 下一个能批的人是谁」；
 *     真正改判定的只有审批队列里的「批准 / 驳回」（人签）；
 *   · 金额一律**整数分**（`unit=cents`）：负数 / 非整数 / 超上限一律具名拒（不折算、不四舍五入）。
 *
 * 复跑：`python3 tmp/p16-verify.py authority`（截图与读数在 `tmp/p16-shots/`）。
 */
import { statSync } from 'node:fs'

import { readConfigFile, projectView, flattenDoc } from '../../../system/config/code/config-ui.mjs'
import {
  AMOUNT_MAX, BAND_PREFIX, CONFIG_PREFIX, MONEY_NOTE, MONEY_UNIT, REGISTERED_ROLES,
  UNCONFIGURED_NOTE, checkOf,
} from './authority-band.mjs'

export const plugin_id = 'domain/authority-band'

const asText = (value) => (typeof value === 'string' ? value.trim() : '')
const CONFIG_ENV = 'QUOTAGENT_UI_CONFIG'
const CONFIG_DEFAULT = '/workspace/config.yaml'

/** 受管配置文件的路径：**与宿主同一处**（`QUOTAGENT_UI_CONFIG` → 缺省 `/workspace/config.yaml`）。 */
const configPath = () => asText(process.env[CONFIG_ENV]) || CONFIG_DEFAULT

/**
 * 只读配置快照（**按 mtime 备忘**：面板每次渲染都会调 `data()`，9KB 的 YAML 解析一次够了）。
 * 读不到 ⇒ `{}`（插件据此报 `config-missing`，**不假装**区间存在）。
 */
let snapshotCache = { at: -1, size: -1, snapshot: null, reason: '' }
const configSnapshot = () => {
  const path = configPath()
  let stat = null
  try {
    stat = statSync(path)          // 只为了拿 mtime/size 做缓存判据；读取与解析都在 `config-ui.mjs`（同一份实现）
  } catch (err) {
    snapshotCache = { at: -1, size: -1, snapshot: null, reason: 'config-file-missing' }
    return { snapshot: null, reason: 'config-file-missing', path }
  }
  if (snapshotCache.snapshot && snapshotCache.at === stat.mtimeMs && snapshotCache.size === stat.size) {
    return { snapshot: snapshotCache.snapshot, reason: snapshotCache.reason, path }
  }
  const file = readConfigFile(path)
  if (!file.ok) {
    snapshotCache = { at: stat.mtimeMs, size: stat.size, snapshot: null, reason: file.reason || 'config-unreadable' }
    return { snapshot: null, reason: file.reason || 'config-unreadable', path }
  }
  // 受管 YAML 的 `project:` 段在本仓库里是**嵌套**写的（`./run config init` 与 `tools/config-apply.py`
  // 的渲染约定：缩进 2 空格），而 `projectView` 的**文件层**是按**点分扁平键**取值的
  // （`hasOwnProperty(fileLayer, 'authority.bands.buyer')`）⇒ 这里先用 `flattenDoc`（**同一个模块导出的**
  // 同一个展平函数，不是自己写一个解析器）把嵌套展平，两种写法（嵌套 / 已经是点分键）都能读到。
  // 读的是**同一份** `PROJECT_KEYS` 登记表：`authority.*` 之外的键一个都不取。
  const rows = projectView({ doc: { project: flattenDoc(file.value?.project ?? {}) } }).rows
  const snapshot = {}
  for (const row of rows) {
    const key = String(row?.key ?? '')
    if (!key.startsWith(CONFIG_PREFIX)) continue
    snapshot[key] = row.value === undefined ? null : row.value
  }
  snapshotCache = { at: stat.mtimeMs, size: stat.size, snapshot, reason: '' }
  return { snapshot, reason: '', path }
}

/** 一笔金额的**结论行**（人话）：在区间内 / 越界多少 / 未配置 / 输入被拒。 */
const verdictOf = (run) => {
  if (run.status === 'inside-band') return `在区间内（还差 ${run.bands.find((b) => b.role === run.role)?.remaining_cents ?? '—'} 分到限额）`
  if (run.status === 'over-band') return `**越界 ${run.over_by} 分**`
  if (run.status === 'unconfigured') return `未配置（${run.code}）——不知道就是不知道`
  return `输入被拒（${run.code}）`
}

export async function register(surface, host) {
  const me = plugin_id
  const out = []
  const gateTool = 'src/system/approval/tools/gate-actions.py'
  const ledgerC = () => asText(host.config?.ledger_contractor)
  const ledgerS = () => asText(host.config?.ledger_supplier)
  const ledgerFor = (view) => (view === 'supplier' ? ledgerS() : ledgerC())

  /** 面板的共用数据：区间全表 + 口径 + 出处 + 「这里不能批」的人话。 */
  const panel = (view, order) => surface.panel({
    plugin_id: me, id: view === 'supplier' ? 'authority.bands.supplier' : 'authority.bands',
    title: '授权区间（谁能批到多少 / 越界找谁）', view, order, kind: 'table',
    actions: ['authority.check', 'authority.escalate'],
    data: () => {
      const { snapshot, reason, path } = configSnapshot()
      const meta = { unit: MONEY_UNIT, registered_roles: [...REGISTERED_ROLES] }
      const probe = checkOf({ view, role: REGISTERED_ROLES[0] ?? 'buyer', amount: 1, config: snapshot }, {})
      const configured = Array.isArray(probe.bands) ? probe.bands : []
      const rows = (meta.registered_roles ?? []).map((role) => {
        const found = configured.find((item) => item.role === role) ?? null
        return {
          id: role, role, band_key: `${BAND_PREFIX}${role}`,
          limit_cents: found ? found.limit_cents : null,
          // **逐行都写清"未配置 ≠ 0 ≠ 无限"**：这是 DEF-036 点名的那条误导
          limit_label: found ? `${found.limit_cents} 分（= ${(found.limit_cents / 100).toFixed(2)} 元）`
            : '未配置 ⇒ 这个角色**不是"不限"**，而是"一律走人工门"',
          status: probe.status, can_approve: '否（本面板不能批准、不能放行）',
        }
      })
      const unset = probe.status === 'unconfigured'
      return { ok: true, kind: 'table', degraded: unset,
        // **降级原因第一行是人话**（机器码放括号里）：读配置读出了"还没登记"这件事，不是坏了
        reason: unset
          ? `授权区间还没登记（机器码 ${probe.code || 'band-unconfigured'}）—— 未配置 ≠ 额度无限：一律走人工门`
          : '',
        next_action: unset
          ? `登记 \`authority.bands.<角色>\`（**整数分**）后本页立刻生效：${probe.config_where}；`
            + '或者现在就用下面的「按金额查该谁批」表单算一笔，再点「提交给下一角色审批」开人工门'
          : '按金额查该谁批（表单），越界就一键开人工门；改判定永远在审批队列里由人签批准/驳回',
        columns: [
          { key: 'role', label: '角色', type: 'code' },
          { key: 'limit_cents', label: '限额（整数分）', filter: 'number' },
          { key: 'limit_label', label: '这一行到底什么意思' },
          { key: 'band_key', label: '配置键（人工专属）', type: 'code' },
        ],
        rows,
        row_actions: ['authority.check', 'authority.escalate'],
        counts: { registered_roles: rows.length, configured: configured.length },
        note: `口径：${MONEY_NOTE}。`
          + `单位声明 ${MONEY_UNIT}；配置来源 = 受管 YAML ${path}（**只读** \`${CONFIG_PREFIX}\` 那些行，`
          + '别的键读都不读）'
          + `${reason ? `；本次读取降级：${reason}` : ''}。`
          + (unset ? `${UNCONFIGURED_NOTE}。` : '')
          + '本面板由确定性规则派生（source=authority-band）：不读账本、不取墙钟、不调模型、'
          + '**不能批准**——越界的唯一出路是人工门（提交后去「审批队列」由人签批准/驳回）。' }
    } })

  out.push(surface.view({ plugin_id: me, id: 'authority.workspace', title: '授权区间', order: 8,
    view: 'contractor', hint: '谁能批到多少 / 越界多少 / 下一个能批的人是谁；一键把越界的事提成人工门' }))
  out.push(surface.view({ plugin_id: me, id: 'authority.workspace.supplier', title: '授权区间', order: 8,
    view: 'supplier', hint: '谁能批到多少 / 越界多少 / 下一个能批的人是谁；一键把越界的事提成人工门' }))
  out.push(panel('contractor', 8))
  out.push(panel('supplier', 8))

  // ------------------------------------------------------------------ 动作
  out.push(surface.action({ plugin_id: me, id: 'authority.check', title: '按金额查该谁批（只读，账本零新增）',
    views: ['contractor', 'supplier'], group: '审批', order: 5, permission: 'none', inline: true,
    confirm: { required: false },
    hint: '跑的是插件自己的确定性规则（不读账本、不取墙钟）；**本动作不改任何判定、账本零新增**',
    input: { fields: [
      { name: 'role', label: '我的角色', type: 'select', options: [...REGISTERED_ROLES], required: true,
        help: '限额是按角色登记的（authority.bands.<角色>）' },
      { name: 'amount', label: '金额（**整数分**：500000 = 5000.00 元）', type: 'number', required: true,
        min: 0, max: AMOUNT_MAX, help: '不折算、不四舍五入：把元写成分会被判越界' },
    ] },
    server: async (ctx, input) => {
      const { snapshot, reason } = configSnapshot()
      const run = checkOf({ view: String(ctx.view ?? 'contractor'), role: asText(input.role),
        amount: input.amount, config: snapshot }, {})
      const bad = ['input-rejected'].includes(run.status)
      return { ok: !bad, code: bad ? (run.code || 'input-rejected') : `authority-${run.status}`,
        reason: bad ? run.reason : '',
        next_action: bad ? run.next_action
          : (run.status === 'over-band'
            ? `越界 ${run.over_by} 分：用「提交给下一角色审批」把这件事提成人工门`
              + `${run.next_role ? `（下一个能批的是 ${run.next_role}）` : '（没有角色的限额覆盖这笔金额：只能改配置或走人工门）'}`
            : (run.status === 'inside-band'
              ? `${run.role} 的限额覆盖这笔金额：继续既有流程；**批准仍在审批队列里由人签**（本面板不能批准）`
              : `${run.next_action}${reason ? `（配置读取降级：${reason}）` : ''}`)),
        result: { status: run.status, verdict: verdictOf(run), role: run.role, amount: run.amount,
          required_role: run.required_role, next_role: run.next_role, over_by: run.over_by,
          bands: run.bands, within: run.within, unit: run.unit, can_approve: run.can_approve,
          unconfigured: run.unconfigured, blocked_by: run.blocked_by, config_where: run.config_where,
          approval_note: run.approval_note, notes: run.notes, ledger_added: 0 } }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'authority.escalate',
    title: '提交给下一角色审批（越界 → 开一条人工门）',
    views: ['contractor', 'supplier'], group: '审批', order: 6, permission: 'human-signature',
    confirm: { required: true, message: '越界的金额要提成人工门：确认以你的署名开这条门？'
      + '（门本身不改判定；谁批它由点名的审批人决定）' },
    hint: '落 `approval/requested`（既有事件，scope=authority.escalate）—— 写者仍是 '
      + '`tools/gate-actions.py`；门开出来后去「审批队列」由点名的审批人批准/驳回',
    input: { fields: [
      { name: 'role', label: '我的角色', type: 'select', options: [...REGISTERED_ROLES], required: true },
      { name: 'amount', label: '金额（**整数分**）', type: 'number', required: true },
      { name: 'ref', label: '这笔钱挂在哪条事实上（被批对象的 id）', type: 'text', required: true,
        help: '如 q-… / aw-… / chg-…（门要挂在一个真对象上，不许凭空的金额）' },
      { name: 'approvers', label: '点名给谁批（human:<名字>）', type: 'text', required: true,
        help: '越界时面板给出的 next_role 决定"该找哪个角色"，这里写**那个角色的具体人**' },
      { name: 'signature', label: '署名（人签）', type: 'signature', required: true,
        help: 'human:<你的名字> —— 服务端要求它等于会话身份' },
      { name: 'note', label: '一句话说明（进待办件，不上账本正文）', type: 'textarea', required: false },
    ] },
    server: async (ctx, input) => {
      const role = asText(input.role)
      const ref = asText(input.ref)
      const asked = String(ctx.view ?? 'contractor')
      const mine = asText(ctx?.identity?.side)
      if (mine !== '' && mine !== asked) {
        return { ok: false, code: 'cross-side-action',
          reason: `你的会话是 ${mine} 侧，却在 ${asked} 侧发起升级：侧只认会话`,
          next_action: `在 ${mine} 侧自己的「授权区间」面板里发起` }
      }
      const view = mine === '' ? asked : mine
      const { snapshot } = configSnapshot()
      const run = checkOf({ view, role, amount: input.amount, config: snapshot }, {})
      if (run.status === 'inside-band') {
        return { ok: false, code: 'not-over-band',
          reason: `${run.role} 的限额 ${run.bands.find((b) => b.role === run.role)?.limit_cents} 分`
            + `覆盖这笔 ${run.amount} 分：没有越界，不需要升级`,
          next_action: '直接走既有流程；整笔的批准仍在「审批队列」里由人签（本面板不能批准）' }
      }
      if (run.status !== 'over-band') {
        return { ok: false, code: run.code || 'authority-unconfigured',
          reason: `拿不到区间结论（${run.status}）：不编一个限额，也不假装这笔越界了`,
          next_action: run.next_action }
      }
      const approvers = String(input.approvers ?? '').split(/[,\s]+/).map(asText).filter(Boolean)
      const bad = approvers.filter((who) => !who.startsWith('human:'))
      if (!approvers.length || bad.length) {
        return { ok: false, code: 'approver-not-human',
          reason: `点名审批人必须是 human:<名字>（收到 ${JSON.stringify(input.approvers)}）`,
          next_action: `写 human:<名字>；越界时该找哪个角色看面板给出的 next_role`
            + `${run.next_role ? `（本题的 next_role=${run.next_role}）` : '（本题没有角色能批这笔金额）'}` }
      }
      const staged = host.stage('gate-actions', { kind: 'gate-actions', action: 'request', view,
        scope: 'authority.escalate', ref, summary: `越界 ${run.over_by} 分（角色 ${run.role}）待批`,
        timeout_policy: 'escalate', timeout_s: 86400, escalate_to: approvers[0], approvers,
        actor: asText(input.signature), note: String(input.note ?? '') })
      if (!staged.ok) return staged
      const runTool = host.runPython(gateTool, ['--step', 'request', '--request', staged.path,
        '--ui-shared', host.sharedDir, '--ledger-contractor', ledgerFor(view), '--view', view, '--now', host.now()])
      const json = runTool.json ?? {}
      const refusal = json.refusal ?? null
      const ok = Boolean(runTool.ok && json.ok === true)
      return { ok, code: refusal?.code ?? (ok ? 'gate-opened' : 'writer-failed'),
        reason: refusal?.reason ?? (ok ? '' : (runTool.reason ?? '')),
        next_action: refusal?.next_action ?? json.next_action_runtime
          ?? (ok ? `门 ${json.approval_id} 已开（approval/requested，本动作账本 +${Number(json.ledger_added ?? 0)} 行）：`
              + `去「审批队列」让 ${approvers.join('、')} 批准/驳回`
            : '看 result.stdout 定位后重提（本动作账本零新增）'),
        result: { pending: staged.file, pending_file: staged.name, view,
          approval_id: json.approval_id ?? '', scope: 'authority.escalate', ref,
          over_by: run.over_by, role: run.role, next_role: run.next_role, approvers,
          ledger_added: Number(json.ledger_added ?? 0), applied: json.applied ?? [],
          stdout: runTool.stdout ? runTool.stdout.slice(-400) : '' } }
    } }))

  out.push(surface.statusItem({ plugin_id: me, id: 'status.authority', title: '授权区间', order: 8, read: () => {
    const { snapshot, reason } = configSnapshot()
    const probe = checkOf({ view: 'contractor', role: REGISTERED_ROLES[0] ?? 'buyer', amount: 1, config: snapshot }, {})
    const configured = Array.isArray(probe.bands) ? probe.bands.length : 0
    return { text: probe.status === 'unconfigured'
      ? `未配置（${configured}/${REGISTERED_ROLES.length} 角色登记了限额；未配置 ≠ 不限额）`
      : `已登记 ${configured} 个角色`,
      level: probe.status === 'unconfigured' ? 'warn' : 'ok',
      next_action: probe.status === 'unconfigured'
        ? '在「授权区间」面板登记 authority.bands.<角色>（整数分），或先按金额算一笔再开人工门'
        : (reason || '') } } }))

  return out
}
