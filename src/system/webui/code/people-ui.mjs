/**
 * people-ui —— 把 `people.mjs` 的**人员名册与角色**搬上界面（名册面板 + 维护动作 + 状态读数）。
 *
 * 它为什么在**外壳这一层**（与 `collab-ui.mjs` 同一形态，不是"把业务写进外壳"）：
 *   · 本文件**不出现任何业务名词、插件 id、对象类字面量**：它只说"人、角色、直属关系、额度、策略"——
 *     这些是**组织配置**，对任何业务对象都成立（谁能批、谁能转交，是权限而不是领域语义）；
 *   · 名册是**权威取值处**：`@提及 / 指派 / 转交` 的候选与校验都从它来（`collab.mjs` 调 `host.people`），
 *     于是"同事"不再等于"登录过的人"；
 *   · 侧与身份只来自**会话**（`ctx.identity`，由外壳按 cookie 解析）；未登录时面板如实说"要登录"，
 *     而不是给一个假的候选名单。
 *
 * 纪律：这些贡献走的是**同一个注册面**（`surface.*`）⇒ 与插件贡献一样**可撤销**（`dispose()`）；
 * 名册数据只落 `<ui_shared>/people/roster.json`（0600），**不进账本、不进投影、不进模型输入**
 * （理由逐条写在 `people.mjs` 文件头）。**角色不改变签署权**：本文件注册的动作没有一个是人签动作，
 * 它们只改"配置"；人签仍由 `/api/action/<id>` 校验「署名 == 会话身份」。
 */
// 显示口径（`@名字`）与协作面**同一份实现**（`collab.mjs` 导出）：`human:limin` 不上界面。
import { nameOf } from './collab.mjs'

export const PEOPLE_PLUGIN_ID = 'system/people'
/** 面板顺序：名册排在协作面之前（先看"有谁、谁是主管"，再谈把活交给谁）。 */
const ROSTER_PANEL_ORDER = 880

const asText = (value) => (typeof value === 'string' ? value.trim() : '')

/**
 * 名册文件"读得不完整"的**如实降级行**（P13：一个坏形状的名册/策略文件以前会把面板打成异常，
 * 或者更坏 —— 被说成"名册是空的"）。这里给的是：哪个字段、为什么读不出来、该长什么样、怎么修。
 */
const shapeItems = (shape) => {
  if (!shape) return []
  // 同 `collab-ui.mjs`：说明走整行的 `note` + `next_action`，不塞进窄值列（那会挤成一列一个字）。
  if (shape.broken) {
    return [{ key: '⚠ 名册文件读不出来（不是"名册是空的"）', code: true, value: '原因与修法见下方提示' }]
  }
  return [{ key: `⚠ 名册有 ${shape.dropped_total} 处坏形状（已跳过，不是"没有"）`, code: true,
    value: '逐条说明见下方提示' }]
}
/** 一句话摘要（进面板的 `note`，整行、可换行）。 */
const shapeNote = (shape) => (shape
  ? (shape.broken
    ? `⚠ 名册文件读不出来（${shape.broken.code}）：${shape.broken.reason}｜文件 ${shape.broken.file}`
    : `⚠ 名册有 ${shape.dropped_total} 处坏形状（已跳过，不是"没有"）：`
      + [...new Set((shape.problems ?? []).map((problem) => problem.field))].slice(0, 6).join('、'))
  : '')
/** 面板 `next_action` 里那段**完整**的降级说明（逐条 why + 该长什么样 + 怎么修 + 策略降级的后果）。 */
const shapeExplain = (shape) => (shape
  ? `${(shape.problems ?? []).map((problem) => `${problem.field}：${problem.why}（跳过 ${problem.dropped} 处）`).join('；')}`
    + `${(shape.problems ?? []).length ? '｜' : ''}${shape.how_to_fix}`
    + `${shape.policy_degraded ? '｜**注意**：策略（偏好）被降级 ⇒ 读不出来的额度规则现在**不生效**（不是"放开了"）' : ''}`
  : '')

/**
 * @param {object} options
 * @param {object} options.surface 注册面（`ui-surface.mjs`）
 * @param {object} options.host 机制上下文（用 `host.people` 名册句柄、`host.now()`）
 * @param {string[]} options.views 名册面覆盖的视图（装配方给：身份侧的视图；`home` 由本模块自己加上）
 * @param {(msg: string) => void} [options.log]
 */
export function createPeopleSurface({ surface, host, views = [], log } = {}) {
  const me = PEOPLE_PLUGIN_ID
  const say = (msg) => { if (typeof log === 'function') log(`[people-ui] ${msg}`) }
  const store = () => (host && host.people ? host.people : null)
  const who = (ctx) => (ctx && ctx.identity ? ctx.identity : null)
  const push = (bucket, out) => {
    if (out && out.ok === true) bucket.push(out.dispose)
    else say(`贡献被拒：${out?.code ?? 'unknown'}（${asText(out?.reason)}）`)
    return out
  }

  let viewList = views.map(asText).filter((view) => view !== '')
  const businessViews = () => viewList.filter((view) => view !== 'home')
  let onceDisposers = []
  let onceViews = null
  const panels = new Map()          // view → [disposer…]

  // ------------------------------------------------------------------ ① 名册面板（本侧有谁、什么角色、谁归谁）
  const rosterPanelData = () => (ctx) => {
    const people = store()
    const session = who(ctx)
    if (!people) return { ok: true, kind: 'kv', degraded: true, reason: 'people-mechanism-missing',
      next_action: '这是外壳装配问题（看服务日志里 [people] 的报错）',
      items: [{ key: '名册', value: '外壳没有装上名册机制' }] }
    if (!session) {
      return { ok: true, kind: 'kv', degraded: true, reason: 'identity-required',
        next_action: '顶栏「身份」→ 去登录（human:<名字> + 属于哪一侧）后再看本侧名册（名册按侧隔离）',
        items: [{ key: '人员名册与角色', value: '只给**本侧登录的人**看：未登录时读不到任何一侧的名册' }] }
    }
    const side = session.side
    const list = people.members(side)
    const role = people.roleOf(side, session.human)
    const mine = list.find((item) => item.human === session.human) ?? null
    const reports = list.filter((item) => item.reports_to === session.name)
    const shape = people.describe().shape ?? null
    const items = [
      // 显示口径：与协作面同一套（`@limin`，不是 `human:limin`）；原始值仍在 `/api/people/*` 的回执里
      { key: '我是谁 / 我的角色', value: `@${nameOf(session.human)}（你） · ${role.label}（${role.id}）`
        + `｜额度 ${role.approval_limit_cents === null ? '不限'
          : `${(Number(role.approval_limit_cents) / 100).toFixed(2)} 元`}`
        + (mine ? '' : '｜**名册里还没有我**（登录即登记的登记失败？看服务日志）'), code: true },
      { key: '我的直属上级', value: mine && mine.reports_to ? `@${mine.reports_to}` : '（没写：名册面板可以设）' },
      { key: '直接向我汇报', value: reports.length ? reports.map((item) => `@${item.name}`).join(' ') : '（没有）' },
      { key: `本侧在册成员（${list.length} 人）`, value: list.length
        ? list.map((item) => `@${item.name}（${item.role_label}${item.logged_in ? ' · 在线' : ''}）`).join(' ')
        : '名册是空的：用工具栏「名册：加人」加一个（对方登录一次也会自动登记为「待指派」）' },
      { key: '角色表（角色 · 等级 · 审批额度）', value: people.roles().map((item) => `${item.label}(${item.id}) · r${item.rank} · `
        + `${item.approval_limit_cents === null ? '不限' : `${(Number(item.approval_limit_cents) / 100).toFixed(2)} 元`}`).join(' ｜ '),
      code: true },
      { key: '名册文件', value: `${people.describe().file}（${people.describe().mode}；按侧隔离，不进账本；`
        + '它是**配置**：换角色、调额度立刻生效）', code: true },
    ]
    items.push(...shapeItems(shape))          // ⚠ 如实降级：哪个字段读不出来 + 该长什么样（修法在 next_action）
    return { ok: true, kind: 'kv', items, counts: { members: list.length,
      online: list.filter((item) => item.logged_in).length },
      degraded: Boolean(shape),
      note: shapeNote(shape),
      reason: shape ? (shape.broken ? shape.broken.code : 'roster-shape-bad-fields')
        : (list.length ? null : 'roster-empty'),
      next_action: shape ? `${shape.broken ? shape.how_to_fix : shapeExplain(shape)}｜${shape.next_action}`
        : (list.length
        ? '「@提及 / 指派 / 转交」的候选**只来自这份名册**：名字不在这里的人会被如实拒（unknown-colleague）；'
          + '要限动作（谁能批超额、谁能转交别人的活）用工具栏的「名册：策略」'
          : '先用工具栏「名册：加人」把本侧的人加进来（角色决定他能执行哪些受额度限制的动作）') }
  }

  /** 名册表格（可逐行打开维护动作）：一眼看全 + 每行一个入口。 */
  const rosterTableData = () => (ctx) => {
    const people = store()
    const session = who(ctx)
    if (!people || !session) {
      return { ok: true, kind: 'table', columns: [], rows: [], degraded: true,
        reason: people ? 'identity-required' : 'people-mechanism-missing',
        next_action: people ? '登录后这里列出本侧名册（按侧隔离：一侧的进程读不到另一侧的人）' : '外壳装配问题' }
    }
    const shape = people.describe().shape ?? null
    const list = people.members(session.side)
    const rows = list.map((item) => ({ id: item.name, name: item.name, role_label: item.role_label,
      title: item.title, reports_to: item.reports_to ? `@${item.reports_to}` : '',
      state: item.active ? (item.logged_in ? '在职 · 在线' : '在职') : '已停用',
      limit: item.approval_limit_cents === null ? '不限（可以批任何金额）'
        : `${(Number(item.approval_limit_cents) / 100).toFixed(2)} 元`,
      source: item.source,
      is_me: item.human === session.human ? '我' : '' }))
    return { ok: true, kind: 'table',
      columns: [{ key: 'name', label: '名字' }, { key: 'is_me', label: '' },
        { key: 'role_label', label: '角色' }, { key: 'limit', label: '审批额度' },
        { key: 'title', label: '职务' }, { key: 'reports_to', label: '直属上级' },
        { key: 'state', label: '状态' }, { key: 'source', label: '进名册的方式' }],
      rows, row_actions: ['people.member-save', 'people.member-remove'],
      counts: { members: rows.length },
      degraded: Boolean(shape),
      reason: shape ? (shape.broken ? shape.broken.code : 'roster-shape-bad-fields') : null,
      note: `本侧（${session.side}）名册：${people.describe().file}（0600）。`
        + `${shape ? `**读得不完整**：${shape.dropped_total} 处坏形状被跳过（${(shape.problems ?? []).map((problem) => problem.field).join(' / ')}）`
          + ` —— ${shape.how_to_fix}。` : ''}`
        + '额度 = 这个角色**单独**能批到的金额上限（整数分；空 = 不限）；**角色不改变签署权** ——'
        + '人签仍要本人签（署名 == 会话身份）。',
      next_action: '行内「改角色 / 直属 / 在职」改这个人；「加人」加新成员；「策略」改越权转交与额度规则' }
  }

  // ------------------------------------------------------------------ 注册（可撤销 / 可对账）
  const registerPanels = (view) => {
    const made = []
    push(made, surface.panel({ plugin_id: me, id: `people.roster-${view}`, title: '人员名册与角色（本侧）',
      view, order: view === 'home' ? 18 : ROSTER_PANEL_ORDER, kind: 'kv',
      // **运营配置**（名册/角色/额度）：它不算"这一屏有没有业务数据"—— 刚登录时这里总有你自己那一条，
      // 若把它算成数据，空态（说人话 + 2–3 个下一步）就永远不出现。面板照旧渲染、照旧有内容。
      not_data: true,
      actions: ['people.member-add', 'people.role-set', 'people.policy-set'],
      hint: '名册是权威取值处：「@提及 / 指派 / 转交」的候选与校验都从它来；它是**配置**（可改、不进账本）',
      data: rosterPanelData() }))
    push(made, surface.panel({ plugin_id: me, id: `people.table-${view}`, title: '名册表（逐行可改）',
      view, order: (view === 'home' ? 18 : ROSTER_PANEL_ORDER) + 1, kind: 'table', not_data: true,
      actions: ['people.member-add', 'people.member-save'],
      hint: '每行一个人：角色、额度、职务、直属上级、在职状态；行内动作按名字预填',
      data: rosterTableData() }))
    return made
  }

  const registerOnce = () => {
    onceDisposers = []
    // 视图集合：业务侧视图 + 工作台（`home`）——**不含**运维/系统管理道（它们是外壳之外的道，见
    // `config.views`；名册是业务侧的事，`ops` 侧的人也可以在名册里出现，但入口不挂在运维页上）。
    const sides = [...new Set([...businessViews(), 'home'])].sort()
    const memberFields = [
      { name: 'name', label: '名字（human:<名字> 或直接写名字）', type: 'text', required: true,
        suggest_url: '/api/people/suggest?scope=all',
        help: '小写字母开头、≤32 位、只含 [a-z0-9._-]；它要能被对方登录时对上' },
      { name: 'role', label: '角色 id', type: 'text',
        help: '取自「角色表」（面板里列出）；填了不存在的角色会被如实拒（role-unknown）' },
      { name: 'title', label: '职务（人话，可空）', type: 'text', help: '例：采购二组' },
      { name: 'reports_to', label: '直属上级（human:<名字>，可空）', type: 'text',
        suggest_url: '/api/people/suggest',
        help: '必须是同侧在册的人（环会被拒：manager-cycle）' },
    ]
    push(onceDisposers, surface.action({ plugin_id: me, id: 'people.member-add', title: '名册：加人',
      views: sides, group: '名册', order: 1, placement: ['toolbar', 'inline', 'command'],
      confirm: { required: false },
      hint: '把本侧的人加进名册（角色决定他能执行哪些受额度限制的动作）；**这不是账本事实**，是配置',
      input: { fields: [
        { name: 'side', label: '哪一侧', type: 'text',
          help: `留空 = 本侧（跟随会话身份）；要显式写就用 ${businessViews().join(' / ') || '（未配置业务侧）'}` },
        ...memberFields] },
      server: async (ctx, input) => runPeople(ctx, 'member-add', input) }))
    push(onceDisposers, surface.action({ plugin_id: me, id: 'people.member-save', title: '名册：改角色 / 直属 / 在职',
      views: sides, group: '名册', order: 2, placement: ['toolbar', 'inline', 'command', 'context'],
      confirm: { required: false },
      hint: '只改你填了的项：角色（含额度）、职务、直属上级、是否在职；名字不在名册里 ⇒ member-not-found',
      input: { fields: [...memberFields,
        { name: 'active', label: '在职（取消勾选 = 停用：不再出现在@提及/指派候选名单里）',
          type: 'checkbox', default: true }] },
      server: async (ctx, input) => runPeople(ctx, 'member-save', input) }))
    push(onceDisposers, surface.action({ plugin_id: me, id: 'people.member-remove', title: '名册：停用（离岗）',
      views: sides, group: '名册', order: 3, placement: ['toolbar', 'inline', 'command', 'context'],
      confirm: { required: true, message: '停用后他不再出现在@提及/指派/转交的候选名单里（历史记录不动）——确认？' },
      hint: '离岗**不删行**（历史留痕）：置「已停用」；名册里唯一的管理员不能被停用（role-in-use）',
      input: { fields: [{ name: 'name', label: '停用谁（human:<名字>）', type: 'text', required: true }] },
      server: async (ctx, input) => runPeople(ctx, 'member-remove', input) }))
    push(onceDisposers, surface.action({ plugin_id: me, id: 'people.role-set', title: '名册：设定角色（标签 / 等级 / 额度）',
      views: sides, group: '名册', order: 4, placement: ['toolbar', 'inline', 'command'],
      confirm: { required: false },
      hint: '额度 = 这个角色**单独**能批到的金额上限（整数分；空 = 不限）；改它立刻影响用它的人能执行的动作',
      input: { fields: [
        { name: 'id', label: '角色 id', type: 'text', required: true, help: '例如 buyer / supervisor / admin' },
        { name: 'label', label: '显示名（人话）', type: 'text', help: '例：采购员 / 主管 / 管理员' },
        { name: 'rank', label: '等级（整数，越大越大）', type: 'number', min: 0, max: 100 },
        { name: 'approval_limit_cents', label: '审批额度（整数分；留空 = 不限）', type: 'text',
          help: '5000000 = 50000.00 元；0 = 一分的超额也不能批' },
        { name: 'note', label: '这个角色干什么（人话，可空）', type: 'textarea' }] },
      server: async (ctx, input) => runPeople(ctx, 'role-set', input) }))
    push(onceDisposers, surface.action({ plugin_id: me, id: 'people.role-remove', title: '名册：删除角色（有人在用则拒）',
      views: sides, group: '名册', order: 5, placement: ['command'],
      confirm: { required: true, message: '删除一个没有人在用的角色（有人在用会被拒）——确认？' },
      hint: '不许悄悄把人降级：还有成员在用的角色删不掉（role-in-use，会列出是谁）',
      input: { fields: [{ name: 'id', label: '角色 id', type: 'text', required: true }] },
      server: async (ctx, input) => runPeople(ctx, 'role-remove', input) }))
    push(onceDisposers, surface.action({ plugin_id: me, id: 'people.policy-set',
      title: '名册：策略（越权转交 / 按角色限动作）', views: sides, group: '名册', order: 6,
      placement: ['toolbar', 'command'], confirm: { required: false },
      hint: '**按角色限动作**（不是限视图）：谁能转交别人的活、哪个动作超过谁的额度就不许做；'
        + '策略是配置（改完下一次请求就按它判）',
      input: { fields: [
        { name: 'transfer_override_roles', label: '可以转交别人活的角色（逗号分隔）', type: 'text',
          help: '留空 = 只有归我/我指派的才能转交；写了 supervisor 就允许主管转交别人的活（要写理由）' },
        { name: 'amount_limit_rules', label: '额度规则（JSON：动作 id → 金额从哪条事实取）', type: 'textarea',
          help: '例：{"change.approve":{"object_field":"change_id","fact":{"type":"change/proposed",'
            + '"id_field":"change_id","amount_key":"delta_amount","unit":"major"}}}；空 = 不启用额度检查' },
        { name: 'amount_limit_enabled', label: '启用额度检查', type: 'checkbox', default: true }] },
      server: async (ctx, input) => runPeople(ctx, 'policy-set', input) }))
    push(onceDisposers, surface.statusItem({ plugin_id: me, id: 'people.status', title: '名册', order: 44,
      read: (ctx) => {
        const people = store()
        const session = who(ctx)
        if (!people) return { text: '名册机制未装配', level: 'warn' }
        if (!session) return { text: '未登录（名册按侧隔离）', level: 'warn', next_action: '顶栏「身份」→ 去登录' }
        const list = people.members(session.side)
        const role = people.roleOf(session.side, session.human)
        const pending = list.filter((item) => item.role === 'pending').length
        return { text: `名册 ${list.length} 人（在线 ${list.filter((item) => item.logged_in).length}）`
          + ` · 我的角色 ${role.label}${pending ? ` · ${pending} 人待指派` : ''}`,
        level: pending ? 'warn' : 'ok',
        next_action: pending ? '在「人员名册与角色」面板里给待指派的人补角色（角色决定他能执行哪些动作）' : '' }
      } }))
    onceViews = viewList.join(',')
  }

  /** 动作的**服务端一半**：actor/侧一律取**会话**，名册句柄取机制（不由表单给）。 */
  const runPeople = async (ctx, verb, input) => {
    const people = store()
    const session = who(ctx)
    if (!people) return { ok: false, code: 'people-mechanism-missing', reason: '外壳没有装上名册机制',
      next_action: '看服务日志里 [people] 的报错' }
    if (!session) return { ok: false, code: 'identity-required',
      reason: '名册是**同一侧登录的人**维护的：当前请求没有会话身份',
      next_action: '顶栏「身份」→ 去登录（human:<名字> + 属于哪一侧），再用同一个动作；这一次什么都没写' }
    const actor = session.human
    const side = asText(input.side) || session.side
    const at = host.now()
    // **名册按侧隔离**：只能维护**自己那侧**的人（想改对面那侧的名册，先切成那侧的身份）——
    // 这与"一侧的进程读不到另一侧的名册"是同一件事的两个面（读隔离 + 写隔离）。
    if (side !== session.side) {
      return { ok: false, code: 'cross-side-member',
        reason: `你是 ${session.side} 侧的人，不能改 ${side} 侧的名册`
          + '（一个人只属于一侧，名册按侧分文件）',
        next_action: `要维护 ${side} 侧的名册，用那侧的身份登录（顶栏「身份」→ 切换）` }
    }
    if (verb === 'member-add' || verb === 'member-save') return memberWrite(verb, { people, session, actor, side, input, at })
    if (verb === 'member-remove') return wrap(people.deactivate({ actor, name: input.name, at }), { verb })
    // 角色表 / 策略的改动与"改人"同一档：本侧已有管理员 ⇒ 只有管理员能做（本侧没有管理员 ⇒ bootstrap）。
    const gate = roleGate(people, session)
    if (gate) return gate
    if (verb === 'role-set') return wrap(people.setRole({ actor, id: input.id, label: input.label, rank: input.rank,
      approval_limit_cents: input.approval_limit_cents, note: input.note, at }), { verb })
    if (verb === 'role-remove') return wrap(people.removeRole({ actor, id: input.id, at }), { verb })
    if (verb === 'policy-set') return policyWrite({ people, session, actor, input, at })
    return { ok: false, code: 'unknown-verb', reason: `不认识的名册动词 ${verb}`, next_action: '这是外壳装配问题' }
  }

  /**
   * 名册动作的统一回执形状（与其它插件同一套：`{ok, code, reason, next_action, result}`）：
   *  `result` 里放**可核对的东西**（被改的那个人 / 角色 / 策略 + 落盘文件 + 0600 + `ledger: zero-management`）。
   * 为什么要有这一层：名册是**配置**，回执要让界面能显示"改了什么、落在哪个 0600 文件、账本没动"。
   */
  const wrap = (out, extra = {}) => {
    if (!out || out.ok === false) return out
    return { ok: true, code: out.code ?? 'ok', reason: null, next_action: out.next_action ?? null,
      result: { ...extra, ...(out.member ? { member: out.member } : {}), ...(out.role ? { role: out.role } : {}),
        ...(out.policy ? { policy: out.policy } : {}), ...(out.name ? { name: out.name } : {}),
        file: out.file ?? null, mode: out.mode ?? null, ledger: 'zero-management' } }
  }

  /**
   * 加人 / 改人。**只改填了的项**（空 = 不改），并把"改角色"与"改别人的角色"这件事按角色判权：
   *   · 名册里**还没有管理员** ⇒ 首次初始化：本侧登录的人可以先把角色配上（如实说明这是 bootstrap）；
   *   · 已经有管理员 ⇒ 只有 `admin` 角色能加人/改角色/停用（`admin-required`），防止采购员自己升自己的额度。
   */
  const memberWrite = (verb, { people, session, actor, side, input, at }) => {
    const verdict = roleGate(people, session)
    if (verdict) return verdict
    if (verb === 'member-save' && input.active !== undefined
      && !(input.active === true || input.active === 'true')) {
      // 停用走同一个动作（少一个入口），但判据与专用动作一致（唯一的管理员不能被停用）
      return people.deactivate({ actor, name: input.name, at })
    }
    const known = people.memberOf(input.name)
    const out = people.upsertMember({ actor, side, name: input.name,
      role: asText(input.role) === '' ? asText(known?.role) : input.role,
      title: asText(input.title) === '' ? asText(known?.title) : input.title,
      reports_to: asText(input.reports_to) === '' ? asText(known?.reports_to) : input.reports_to,
      active: input.active === undefined ? true : input.active === true || input.active === 'true', at })
    if (!out.ok) return out
    return { ok: true, code: out.code, reason: null,
      next_action: out.next_action,
      result: { member: out.member, side, verb, file: out.file, mode: out.mode, ledger: 'zero-management' } }
  }

  const policyWrite = ({ people, session, actor, input, at }) => {
    const verdict = roleGate(people, session)
    if (verdict) return verdict
    let rules = null
    const raw = String(input.amount_limit_rules ?? '').trim()
    if (raw !== '') {
      try { rules = JSON.parse(raw) } catch (err) {
        return { ok: false, code: 'policy-malformed',
          reason: `额度规则不是合法 JSON：${String(err).slice(0, 120)}`,
          next_action: '写 {"<动作 id>":{"object_field":"…","fact":{"type":"…","id_field":"…","amount_key":"…","unit":"major|minor"}}}；'
            + '空字符串 = 不启用额度检查（规则表清空）' }
      }
      if (rules && typeof rules === 'object' && !Array.isArray(rules)) {
        // 文本域里常见的两种形状都收：{rules:{…}} 或直接 {动作 id: 规则}
        rules = rules.rules && typeof rules.rules === 'object' ? rules.rules : rules
      }
    }
    const transferRoles = String(input.transfer_override_roles ?? '')
      .split(/[,\s]+/).map(asText).filter(Boolean)
    const out = people.setPolicy({ actor, at,
      transfer: { enabled: true, actions: ['collab.assign'], override_roles: transferRoles },
      amount_limit: { enabled: input.amount_limit_enabled !== false, rules: rules ?? {} } })
    if (!out.ok) return out
    return { ok: true, code: out.code, next_action: out.next_action,
      result: { policy: out.policy, file: out.file, mode: out.mode, ledger: 'zero-management' } }
  }

  /** 名册维护的角色门（见 `memberWrite` 头注释的 bootstrap 口径）：**按侧**判 —— 名册按侧分文件，
   *  一侧的管理员不管另一侧的事（那侧自己 bootstrap / 由那侧的管理员维护）。 */
  const roleGate = (people, session) => {
    const list = people.members(session.side, { includeInactive: false })
    const admins = list.filter((item) => item.role === 'admin')
    if (admins.length === 0) return null            // 本侧首次初始化：谁先来谁配（面板上如实说明）
    const mine = people.roleOf(session.side, session.human)
    if (mine.id === 'admin') return null
    return { ok: false, code: 'admin-required',
      reason: `本侧名册里已经有管理员（${admins.map((item) => item.human).join(' ')}）：改人/改角色/改策略这件事只有管理员能做`
        + `（你当前是 ${mine.label}）`,
      next_action: '请管理员在「人员名册与角色」面板里改（或让他把你的角色设成 admin）；'
        + '**角色不改变签署权**：这一步不是人签，它只改配置' }
  }

  const sync = () => {
    if (onceViews === null || onceViews !== viewList.join(',')) registerOnce()
    const wanted = new Set(['home', ...businessViews()])
    for (const view of wanted) if (!panels.has(view)) panels.set(view, registerPanels(view))
    for (const [view, list] of [...panels.entries()]) {
      if (wanted.has(view)) continue
      for (const dispose of list) dispose()
      panels.delete(view)
    }
    return { ok: true, plugin_id: me, views: [...wanted], panels: panels.size }
  }

  /** 装配期后补：名册面覆盖哪些视图（= 身份侧的视图）由装配方在身份面建好之后才知道。 */
  const configure = ({ views: nextViews } = {}) => {
    if (Array.isArray(nextViews) && nextViews.length) {
      viewList = nextViews.map(asText).filter((view) => view !== '')
    }
    return sync()
  }

  const dispose = () => {
    for (const disposeOne of onceDisposers) disposeOne()
    onceDisposers = []
    onceViews = null
    for (const list of panels.values()) for (const disposeOne of list) disposeOne()
    panels.clear()
  }

  return { sync, configure, dispose, runPeople, plugin_id: me, viewsOf: () => [...viewList],
    get contributions() { return onceDisposers.length }, get panelCount() { return panels.size } }
}
