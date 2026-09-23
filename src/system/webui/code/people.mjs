/**
 * people —— **人员名册与角色**（同侧成员、角色、直属关系、按角色限动作），外壳机制层。
 *
 * 它为什么存在：界面上原来那个「同事」是从**登录过的人**推出来的（活跃会话 + 协作记录里出现过的人），
 * 于是"@提及 / 指派 / 转交"能做的范围取决于**谁碰巧登录过**，而不是**单位里真实有谁**；也没有任何地方
 * 能表达"这个人是采购员还是主管""他的直属上级是谁""这一步只有主管能批"。本文件提供这层的机制：
 * 把名册与角色落成一份**可读可改的 0600 配置**，让 ①@提及/指派/转交**只从名册取值**（未知名字如实拒），
 * ②**动作**按角色限权（不是限视图：谁能批超额、谁有资格转交别人的活）。
 *
 * ============================ 为什么这些数据**不能进账本**（硬约束，别搬） ============================
 * 账本是**合同事实**的 append-only 记录（`AGENTS.md` 规则 2/3）：每一行都要能被审计包/哈希链/模型输入重建，
 * 且必须表示对外承诺或业务状态变化。而本文件存的是**组织与权限的配置**：谁是同事、谁是什么角色、
 * 谁的额度多少。它们不是合同事实：
 *   · 写进账本 ⇒ 事件类型目录/证据包哈希/审计取证的语义被改变（一次"给某人换角色"会污染合同事实的时间线）；
 *   · 写进账本 ⇒ 按规则 2 它就变成**模型可见输入**，"名册与额度"会被当成业务事实喂给模型，错；
 *   · 名册/额度是**可改的运营配置**（换人、调额度要能立刻生效），账本是不可改的 append-only。
 * 因此：只落 **`<ui_shared>/people/roster.json`（目录 0700 / 文件 0600、原子写、有界）**，不进投影、不进 QEP、
 * 不进模型输入，也不出现第二条事实写路径：本文件不 import 任何账本 API、不写账本、不 spawn 写者。
 *
 * **角色不改变签署权**（与身份面同一口径，别越界）：本文件的 guard 只回答"**这次请求能不能被执行**"，
 * 它**不**代替人签 —— 人签动作仍由 `/api/action/<id>` 的服务端一半要求「署名 == 会话身份」
 * （身份面 `signGate`），角色再高也不能替别人签、也不能跳过人工门。guard 只能**收紧**动作，永远不能放开。
 *
 * 隔离与边界：
 *   · **按侧隔离**：名册里的每个人带 `side`；`side` 只由调用方（外壳按**会话身份**）给，本文件不接受
 *     请求体里的 side ⇒ 供应商进程/身份读不到承包商的内部名册与额度；
 *   · **同侧人类之间**：`actor`/成员名一律 `human:<名字>` 口径（ASCII 小写集）；跨侧的名字进不了本侧名册；
 *   · 时间戳是**界面级**的（名册不是事实）⇒ 用调用方给的 `at`（外壳的 `host.now()`），本文件不取墙钟；
 *   · 有界：成员 200 / 角色 24 / 单值长度有界；超出**如实拒**（不静默截断成另一份名册）。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

export const PEOPLE_SCHEMA = 'quotagent/people-roster/v1'
export const PEOPLE_DIR = 'people'
export const PEOPLE_FILE = 'roster.json'
/** 名册数据的**存储口径自述**（进 `/api/ui/surface`，用来对账"它没进账本"）。 */
export const PEOPLE_WHY_NOT_LEDGER = '名册与角色是**组织与权限的配置**（谁是同事、什么角色、额度多少），'
  + '不是合同事实：进账本会改变事件类型目录、证据包哈希与审计取证语义，并会把"名册与额度"变成模型可见输入。'
  + '所以只落 `<ui_shared>/people/roster.json`（0600、按侧隔离），不进账本、不进投影、不进模型输入。'
/** 自动登记（登录即进名册）时的角色 id：**待指派** —— 有名字、没有权限，等主管补角色。 */
export const PENDING_ROLE = 'pending'
export const MAX_MEMBERS = 200
export const MAX_ROLES = 24
export const MAX_NAME_BYTES = 64
export const MAX_TEXT = 200
export const MAX_NOTE = 500
export const MAX_LIMIT_CENTS = 10 ** 15
/** 拒绝码（闭合集合：拒绝一律有名 + 下一步，不静默）。 */
export const REFUSAL_CODES = ['identity-required', 'unknown-side', 'name-malformed', 'not-a-member',
  'member-exists', 'member-not-found', 'role-malformed', 'role-unknown', 'role-in-use', 'role-limit',
  'too-many-members', 'too-many-roles', 'self-report', 'policy-malformed', 'manager-unknown',
  'manager-cycle', 'cross-side-member', 'transfer-not-yours', 'role-limit-exceeded', 'amount-unknown',
  'people-write-failed']

const NAME_RE = /^[a-z][a-z0-9._-]{0,31}$/
const ROLE_ID_RE = /^[a-z][a-z0-9-]{0,31}$/
const plain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const text = (value) => (typeof value === 'string' ? value.trim() : '')
const flat = (value, limit = 200) => String(value ?? '').replace(/\s+/g, ' ').slice(0, limit)
const humanOf = (value) => {
  const raw = text(value)
  if (raw === '') return ''
  const name = raw.startsWith('human:') ? raw.slice(6) : raw
  return NAME_RE.test(name) ? `human:${name}` : ''
}
const nameOf = (human) => String(human ?? '').replace(/^human:/, '')
const refusal = (code, reason, next_action, extra = {}) => ({ ok: false, code, reason, next_action, ...extra })

/**
 * **出厂角色表**（可配：界面上的「设定角色」动作能改标签/等级/额度，也能加新角色）。
 * 额度口径：`approval_limit_cents` = 这个角色**单独**能批到的金额上限（整数分；`null` = 不限）。
 * `rank` 只用于"谁比谁大"（转交越权、额度不足时推荐找谁）。**这里没有任何业务名词**：动作 id 与金额口径
 * 都在名册文件的 `policy` 里配置（见下）。
 */
export const DEFAULT_ROLES = [
  { id: PENDING_ROLE, label: '待指派', rank: 0, approval_limit_cents: 0,
    note: '登录即登记：有名字、没有权限；等主管在名册里补角色' },
  { id: 'buyer', label: '采购员', rank: 10, approval_limit_cents: 0,
    note: '办日常的活（备料/询价/跟单）；**不批超额**：超过权限的动作要交主管' },
  { id: 'supervisor', label: '主管', rank: 20, approval_limit_cents: 5_000_000,
    note: '管本侧的人：可以转交别人的活（留理由）、批准额度内的超额（50000.00 元以内）' },
  { id: 'admin', label: '管理员', rank: 30, approval_limit_cents: null,
    note: '额度不限、可以改名册与角色本身（`can: ["people.admin"]`）' },
]
/** 转交/额度的**出厂策略**（动作 id 与金额键都在配置里；`system` 机制层不认识任何业务名词）。 */
export const DEFAULT_POLICY = {
  transfer: { enabled: true, actions: ['collab.assign'], override_roles: ['supervisor', 'admin'],
    note: '只有**归我**（当前指派给我）或**我指派的**（当前指派是我下的）才能转交；override_roles 里的角色'
      + '可以转交别人的活，但必须写明理由（拒绝码 `transfer-not-yours`）' },
  amount_limit: { enabled: true, rules: {}, unknown_amount: 'refuse',
    note: '按角色限动作（不是限视图）：`rules` 给"哪个动作 + 金额从哪条事实取 + 单位"，动作金额超过我的角色'
      + '额度 ⇒ 拒绝（拒绝码 `role-limit-exceeded`，并告诉你该找哪个角色）。`rules` 空 ⇒ 这条策略不起作用'
      + '（额度检查是**配置**，不是写死的业务判断）；金额取不到 ⇒ 按 `unknown_amount`（`refuse` = 拒，'
      + '宁可拦下一次也不放过越权）。' },
}

/**
 * 建名册存储。
 * @param {object} options
 * @param {string} options.root 仓库根（只用来算相对路径，便于回执里给人看的路径）
 * @param {string} options.sharedDir 共享目录（`<ui_shared>`；名册落它下面的 `people/`）
 * @param {string} [options.sessionsFile] 身份会话文件（**只读**：用来看"这个人今天登录没有"）
 * @param {string[]} [options.sides] 允许的侧（由外壳从身份面传入，本文件不硬编码）
 * @param {(msg: string) => void} [options.log]
 */
export function createPeopleStore({ root = '.', sharedDir, sessionsFile = '', sides = [], log } = {}) {
  const base = resolve(String(root ?? '.'), String(sharedDir ?? 'tmp/ui-shared'))
  const dir = join(base, PEOPLE_DIR)
  const file = join(dir, PEOPLE_FILE)
  let allowedSides = sides.map(text).filter(Boolean)
  let sessionsPath = text(sessionsFile) === '' ? '' : resolve(String(root ?? '.'), sessionsFile)
  const say = (msg) => { if (typeof log === 'function') log(`[people] ${msg}`) }

  /** 装配期后补配置（外壳先建、身份面后建）。**已落的名册不动**（只影响侧校验与"登录过没有"）。 */
  const configure = ({ sessionsFile: nextFile, sides: nextSides } = {}) => {
    if (typeof nextFile === 'string' && nextFile.trim() !== '') sessionsPath = resolve(String(root ?? '.'), nextFile.trim())
    if (Array.isArray(nextSides) && nextSides.length) allowedSides = nextSides.map(text).filter(Boolean)
    return { ok: true, sessions_file: sessionsPath, sides: allowedSides, file }
  }

  const emptyDoc = () => ({ schema: PEOPLE_SCHEMA, roles: DEFAULT_ROLES.map((role) => ({ ...role })),
    members: {}, policy: JSON.parse(JSON.stringify(DEFAULT_POLICY)), updated_at: '',
    note: PEOPLE_WHY_NOT_LEDGER, sanitized: { counts: {}, problems: [], dropped_total: 0, fields: {},
      read_only: true }, broken: null, policy_degraded: false })
  /** 名册文件**整体**读不出来（JSON 坏了 / 顶层不是对象 / `members` 不是对象）时的**如实降级**读数。 */
  const brokenDoc = (code, reason) => {
    const doc = emptyDoc()
    doc.broken = { code, reason, file: relative(resolve(String(root ?? '.')), file),
      how_to_fix: '名册是**配置**（不是账本）：把它改回这份形状即可 —— '
        + '`{"schema":"quotagent/people-roster/v1","roles":[…],"members":{"<名字>":{…}},"policy":{…}}`；'
        + '名册面每次渲染都真读盘、**不缓存** ⇒ 改好下一次刷新就自动恢复（也可以直接删掉这个文件：会回到出厂角色表、0 成员）。',
      next_action: `${relative(resolve(String(root ?? '.')), file)} 读不出来：修好它或删掉它（面板会自动恢复）` }
    return doc
  }

  /**
   * 读名册文件（**每次真读盘、不缓存** ⇒ 改对之后下一次渲染自动恢复）。
   * 坏形状的字段：能读的照读、读不懂的**跳过并如实计数**（`doc.sanitized`）—— 绝不因为一个坏字段
   * 把「人员名册与角色」面板打成异常，也绝不把"文件坏了"说成"名册是空的"（那是撒谎）。
   */
  const load = () => {
    let parsed = null
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch (err) {
      if (err && err.code === 'ENOENT') return emptyDoc()      // 还没写过：真的"还没有"
      return brokenDoc('roster-file-unreadable', flat(err))
    }
    if (!plain(parsed)) {
      return brokenDoc('roster-file-not-an-object',
        `顶层不是对象（收到 ${Array.isArray(parsed) ? 'array' : typeof parsed}）`)
    }
    if (parsed.members !== undefined && !plain(parsed.members)) {
      return brokenDoc('roster-members-not-an-object',
        '`members` 不是对象（它要是「名字 → 一行成员」的键值表）')
    }
    const doc = emptyDoc()
    const dropped = {}
    const problems = []
    let policyDegraded = false
    const note = (field, why, count, container = false) => {
      if (!count) return
      dropped[field] = (dropped[field] ?? 0) + count
      if (problems.length < 20) problems.push({ field, why, dropped: count, container })
    }
    // ---- 角色表：数组（顺序即展示顺序）或对象（手改过/别的版本写过）两种都收；坏行跳过并计数 ----------
    if (parsed.roles !== undefined && !Array.isArray(parsed.roles) && !plain(parsed.roles)) {
      note('roles', '不是数组也不是对象（已忽略，用出厂角色表）', 1, true)
    }
    const rawRoles = Array.isArray(parsed.roles) ? parsed.roles
      : (plain(parsed.roles) ? Object.values(parsed.roles) : [])
    const roles = []
    for (const role of rawRoles) {
      if (!plain(role) || !ROLE_ID_RE.test(text(role.id))) { note('roles', '角色行没有合法的 `id`（已跳过）', 1); continue }
      const limit = role.approval_limit_cents
      const asLimit = limit === null || limit === undefined || limit === '' ? null : Number(limit)
      const okLimit = asLimit === null || (Number.isFinite(asLimit) && asLimit >= 0)
      if (!okLimit) note('roles.approval_limit_cents', '额度不是整数分（**按 0 处理**：不批超额，而不是"不限"）', 1)
      roles.push({ id: text(role.id), label: flat(role.label, MAX_TEXT) || text(role.id),
        rank: Number.isFinite(Number(role.rank)) ? Number(role.rank) : 0,
        approval_limit_cents: okLimit ? asLimit : 0, note: flat(role.note, MAX_NOTE) })
    }
    if (roles.length) doc.roles = roles
    // ---- 成员表：一行一个人；形状不对的行**跳过并计数**（不把一行当成两个人、也不假装名册是空的） --------
    for (const [key, member] of Object.entries(parsed.members ?? {})) {
      if (!plain(member)) { note('members', `\`${key}\` 那一行不是对象（已跳过）`, 1); continue }
      const name = text(member.name) || nameOf(key)
      if (!NAME_RE.test(name)) { note('members', `\`${key}\` 的名字形状不合法（已跳过）`, 1); continue }
      const rawReports = text(member.reports_to).replace(/^human:/, '')
      if (rawReports !== '' && !NAME_RE.test(rawReports)) {
        note('members.reports_to', `\`${key}\` 的直属上级不是名字（已置空）`, 1)
      }
      doc.members[name] = { name, side: text(member.side), role: text(member.role),
        title: flat(member.title, MAX_TEXT), reports_to: NAME_RE.test(rawReports) ? rawReports : '',
        active: member.active !== false, source: text(member.source) || 'roster',
        first_at: text(member.first_at), last_at: text(member.last_at) }
    }
    // ---- 策略（偏好）：**逐块校验**；形状不对就回到出厂策略并如实计数（不把坏形状塞进判据里） ----------
    const rawPolicy = plain(parsed.policy) ? parsed.policy : {}
    if (parsed.policy !== undefined && !plain(parsed.policy)) {
      note('policy', '不是对象（已用出厂策略）', 1, true)
    }
    if (rawPolicy.transfer !== undefined) {
      if (!plain(rawPolicy.transfer)) {
        note('policy.transfer', '不是对象（`{enabled, actions, override_roles}`）—— 已用出厂策略', 1, true)
        policyDegraded = true
      } else {
        const raw = rawPolicy.transfer.override_roles
        if (raw !== undefined && !Array.isArray(raw)) {
          note('policy.transfer.override_roles', '不是数组（已忽略：**默认只有归我/我指派的能转交**）', 1, true)
          policyDegraded = true
        }
        doc.policy.transfer = { ...doc.policy.transfer, enabled: rawPolicy.transfer.enabled !== false,
          actions: Array.isArray(rawPolicy.transfer.actions) ? rawPolicy.transfer.actions.map(text).filter(Boolean)
            : doc.policy.transfer.actions,
          override_roles: Array.isArray(raw) ? raw.map(text).filter(Boolean) : [] }
      }
    }
    if (rawPolicy.amount_limit !== undefined) {
      if (!plain(rawPolicy.amount_limit)) {
        note('policy.amount_limit', '不是对象（`{enabled, rules}`）—— 已用出厂策略', 1, true)
        policyDegraded = true
      } else {
        const rawRules = rawPolicy.amount_limit.rules
        if (rawRules !== undefined && !plain(rawRules)) {
          note('policy.amount_limit.rules', '不是对象（已忽略：这些动作的额度检查现在**不生效**）', 1, true)
          policyDegraded = true
        }
        const rules = {}
        for (const [actionId, rule] of Object.entries(plain(rawRules) ? rawRules : {})) {
          const fact = plain(rule) && plain(rule.fact) ? rule.fact : null
          const unit = fact ? (text(fact.unit) || 'minor') : ''
          const ok = plain(rule) && fact && text(rule.object_field) !== '' && text(fact.type) !== ''
            && text(fact.id_field) !== '' && text(fact.amount_key) !== '' && ['major', 'minor'].includes(unit)
          if (!ok) {
            note('policy.amount_limit.rules', `规则 \`${actionId}\` 形状不对（已忽略：这个动作的额度检查不生效）`, 1)
            policyDegraded = true
            continue
          }
          rules[text(actionId)] = { object_field: text(rule.object_field), note: flat(rule.note, MAX_NOTE),
            fact: { type: text(fact.type), id_field: text(fact.id_field), amount_key: text(fact.amount_key), unit } }
        }
        doc.policy.amount_limit = { ...doc.policy.amount_limit, enabled: rawPolicy.amount_limit.enabled !== false,
          rules,
          unknown_amount: ['refuse', 'allow'].includes(text(rawPolicy.amount_limit.unknown_amount))
            ? text(rawPolicy.amount_limit.unknown_amount) : doc.policy.amount_limit.unknown_amount }
      }
    }
    doc.updated_at = text(parsed.updated_at)
    doc.sanitized = { counts: dropped, problems,
      dropped_total: Object.values(dropped).reduce((sum, n) => sum + Number(n || 0), 0),
      fields: { roles: '数组（每行 `{id, label, rank, approval_limit_cents, note}`）',
        members: '对象：名字 → `{name, side, role, title, reports_to, active, source}`',
        'policy.transfer': '对象 `{enabled, actions[], override_roles[]}`',
        'policy.amount_limit': '对象 `{enabled, rules:{"<动作 id>":{object_field, fact:{type,id_field,amount_key,unit}}}}`' },
      read_only: true }
    doc.policy_degraded = policyDegraded
    return doc
  }
  /** 原子写：临时文件 → `chmod 0600` → rename（不受 umask 影响；与身份会话同一口径）。 */
  const save = (doc) => {
    doc.schema = PEOPLE_SCHEMA
    doc.note = PEOPLE_WHY_NOT_LEDGER
    // **派生读数不进文件**（`sanitized`/`broken`/`policy_degraded` 是这一次读的结论，不是配置）。
    const clean = { schema: PEOPLE_SCHEMA, roles: doc.roles, members: doc.members, policy: doc.policy,
      updated_at: text(doc.updated_at), note: PEOPLE_WHY_NOT_LEDGER }
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      try { chmodSync(dir, 0o700) } catch (err) { /* FS 不支持时尽力而为 */ }
      const tmp = join(dir, `.${PEOPLE_FILE}.${process.pid}.tmp`)
      writeFileSync(tmp, JSON.stringify(clean, null, 1) + '\n', { encoding: 'utf8', mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, file)
      return { ok: true, file: relative(resolve(String(root ?? '.')), file), mode: '0600' }
    } catch (err) {
      return refusal('people-write-failed', flat(err),
        `先修 ${relative(resolve(String(root ?? '.')), dir)} 目录权限（名册文件必须 0600；写不进去时界面如实报，不假装成功）`)
    }
  }

  // ------------------------------------------------------------------ 会话（只读）：谁今天登录过
  const loggedIn = () => {
    const out = new Map()
    if (sessionsPath === '') return out
    try {
      const parsed = JSON.parse(readFileSync(sessionsPath, 'utf8'))
      const rows = plain(parsed?.sessions) ? Object.values(parsed.sessions) : []
      for (const row of rows) {
        const name = text(row?.name)
        if (!NAME_RE.test(name)) continue
        const seen = out.get(name)
        const at = Number(row?.expires_at ?? 0) || 0
        if (!seen || at > seen) out.set(name, at)
      }
    } catch (err) { /* 读不到会话文件 ⇒ 所有人一律"未登录"（如实降级，不猜） */ }
    return out
  }

  // ------------------------------------------------------------------ 读侧
  const rolesOf = (doc) => Object.fromEntries((doc.roles ?? []).map((role) => [role.id, role]))
  /** 某个成员的角色（角色被删了 ⇒ 回落到待指派，**不**回落到"有权限"）。 */
  const roleFor = (doc, member) => {
    const roles = rolesOf(doc)
    const id = text(member?.role)
    return roles[id] ?? roles[PENDING_ROLE] ?? { id: PENDING_ROLE, label: '待指派', rank: 0,
      approval_limit_cents: 0, note: '' }
  }
  const publicMember = (doc, member, sessions) => {
    const role = roleFor(doc, member)
    const name = text(member?.name)
    // 额度 `null` = **不限**（不能写成 0：0 是"一分超额都不许批"，两者语义相反 —— 实测踩过一次）
    const limit = role.approval_limit_cents
    return { name, human: `human:${name}`, side: text(member?.side), role: role.id,
      role_label: text(role.label), rank: Number(role.rank ?? 0),
      approval_limit_cents: limit === null || limit === undefined ? null : Number(limit), title: text(member?.title),
      reports_to: text(member?.reports_to), manager: text(member?.reports_to) === '' ? '' : `human:${text(member.reports_to)}`,
      active: member?.active !== false, source: text(member?.source) || 'roster',
      first_at: text(member?.first_at), last_at: text(member?.last_at),
      logged_in: sessions.has(name) }
  }
  /** 本侧成员（名册口径；默认只出在职的；`side` 空 ⇒ 全体）。 */
  const members = (side = '', { includeInactive = false } = {}) => {
    const doc = load()
    const sessions = loggedIn()
    return Object.values(doc.members).filter((member) => plain(member)
      && (side === '' || text(member.side) === side)
      && (includeInactive || member.active !== false))
      .map((member) => publicMember(doc, member, sessions))
      .sort((left, right) => (right.rank - left.rank)
        || (left.name < right.name ? -1 : 1))
  }
  const memberOf = (name) => {
    const doc = load()
    const wanted = nameOf(humanOf(name) || `human:${text(name)}`)
    const member = doc.members[wanted]
    return plain(member) ? publicMember(doc, member, loggedIn()) : null
  }
  const isMember = (side, human) => {
    const member = memberOf(human)
    return Boolean(member && member.active && (side === '' || member.side === side))
  }
  const describe = () => {
    const doc = load()
    const rows = {}
    for (const side of allowedSides) {
      const list = members(side, { includeInactive: true })
      rows[side] = { members: list.length, active: list.filter((item) => item.active).length,
        logged_in: list.filter((item) => item.logged_in).length,
        by_role: list.reduce((acc, item) => ({ ...acc, [item.role]: (acc[item.role] ?? 0) + 1 }), {}) }
    }
    return { schema: PEOPLE_SCHEMA, file: relative(resolve(String(root ?? '.')), file), mode: '0600',
      exists: existsSync(file), sides: allowedSides, per_side: rows,
      // **读侧韧性**的如实读数（坏形状 / 整份读不出来 / 策略被降级）：面板据此如实说明，不假装"名册是空的"
      shape: (doc.broken || doc.sanitized?.dropped_total) ? {
        broken: doc.broken ?? null, counts: doc.sanitized?.counts ?? {}, problems: doc.sanitized?.problems ?? [],
        dropped_total: doc.sanitized?.dropped_total ?? 0, fields: doc.sanitized?.fields ?? {},
        policy_degraded: Boolean(doc.policy_degraded),
        file: relative(resolve(String(root ?? '.')), file),
        how_to_fix: doc.broken?.how_to_fix ?? '把上面列出的字段改回声明的形状（名册每次渲染都真读盘、不缓存 ⇒ 改好下一次刷新就自动恢复）',
        next_action: doc.broken?.next_action ?? '修名册文件里列出的坏形状（面板上逐条给了"哪个字段、为什么读不出来、该长什么样"）',
      } : null,
      roles: doc.roles.map((role) => ({ id: role.id, label: role.label, rank: role.rank,
        approval_limit_cents: role.approval_limit_cents ?? 0, note: text(role.note) })),
      policy: doc.policy, updated_at: text(doc.updated_at), why_not_ledger: PEOPLE_WHY_NOT_LEDGER,
      bounded: { members: MAX_MEMBERS, roles: MAX_ROLES, text: MAX_TEXT, note: MAX_NOTE },
      note: '名册按侧隔离、0600：一侧的进程/身份读不到另一侧的人与额度（不是"过滤掉"，是结构性隔离）；'
        + '它是**配置**（可改、可撤），不是合同事实（账本只记承诺与状态变化）' }
  }
  /** 建议列表（自动补全的**服务端一半**；未登录 ⇒ 空列表 + 说明，不编人）。 */
  const suggest = (side = '', actor = '') => {
    const me = text(actor)
    if (!allowedSides.includes(text(side))) return { ok: false, code: 'unknown-side', items: [],
      reason: `不是本服务的合法侧：${JSON.stringify(side)}` }
    const list = members(side)
    return { ok: true, side: text(side), me, items: list.map((item) => ({ value: item.name,
      label: `@${item.name}（${item.role_label}${item.title ? ` · ${item.title}` : ''}${item.logged_in ? ' · 在线' : ''}）`,
      role: item.role, human: item.human })),
      note: list.length ? '取值一律来自**名册**（不是"登录过的人"）：未知名字会被如实拒（unknown-colleague）'
        : `本侧名册还是空的：先在「人员名册与角色」面板里加人（或让对方登录一次自动登记为待指派）` }
  }

  /** `@提及` 的解析（名册口径，**与协作面同一处判据**）：本侧解析、跨侧拒、未知如实报。 */
  const mentions = (side, body) => {
    const found = [...String(body ?? '').matchAll(/(^|[\s(（[【,，。;；:：])@([a-z][a-z0-9._-]{0,31})/g)]
      .map((item) => item[2])
    const mine = new Set(members(side).map((item) => item.name))
    const others = new Set(allowedSides.filter((item) => item !== side)
      .flatMap((other) => members(other).map((item) => item.name)))
    const resolved = []
    const crossSide = []
    const unresolved = []
    for (const name of [...new Set(found)]) {
      const human = `human:${name}`
      if (mine.has(name)) resolved.push(human)
      else if (others.has(name)) crossSide.push(human)
      else unresolved.push(human)
    }
    return { resolved, crossSide, unresolved, roster: [...mine].sort() }
  }

  // ------------------------------------------------------------------ 写侧（名册维护：界面上的动作调它）
  const guardActor = (actor, { side = '' } = {}) => {
    const who = text(actor)
    if (!who.startsWith('human:') || !NAME_RE.test(who.slice(6))) {
      return refusal('identity-required', `名册是**同侧人类**维护的，actor 必须是 human:<名字>（收到 ${JSON.stringify(actor)}）`,
        '先在身份页登录（human:<名字> + 属于哪一侧），再改名册')
    }
    if (side !== '' && !allowedSides.includes(text(side))) {
      return refusal('unknown-side', `不是本服务的合法侧：${JSON.stringify(side)}`,
        `用 ${allowedSides.join(' / ') || '（未配置任何侧）'} 之一（侧由**会话身份**决定，不由请求体决定）`)
    }
    return null
  }
  const writeDoc = (mutate, { at = '' } = {}) => {
    const doc = load()
    const bad = mutate(doc)
    if (bad) return bad
    doc.updated_at = text(at)
    const saved = save(doc)
    if (!saved.ok) return saved
    return { ok: true, file: saved.file, mode: saved.mode, doc }
  }

  /**
   * **登录即登记**：会话里第一次出现的人进名册（角色 = 待指派，`source: auto-enroll`）。
   * 为什么保留这条路：名册是权威，但"单位里真有人第一次进来"时不该被挡在门外 —— 他进得来、看得到、
   * **没有权限**，等主管在界面上补角色。名字不在名册、也没登录过的人**仍然会被拒**（`unknown-colleague`）。
   */
  const enroll = ({ side, name, at = '' }) => {
    const who = humanOf(name)
    if (who === '') return refusal('name-malformed', `名字形状非法：${JSON.stringify(name)}`,
      '名字用小写字母开头、≤32 位、只含 [a-z0-9._-]')
    if (!allowedSides.includes(text(side))) return { ok: false, code: 'unknown-side', enrolled: false,
      reason: `不是本服务的合法侧：${JSON.stringify(side)}` }
    const doc = load()
    const key = nameOf(who)
    const known = plain(doc.members[key]) ? doc.members[key] : null
    if (known) {
      if (text(known.side) !== text(side)) {
        return refusal('cross-side-member', `${who} 已经在 **${text(known.side)}** 侧的名册里，不能再算 ${text(side)} 侧的人`,
          `一个人只属于一侧：要换侧先在名册面板里把他移出（${text(known.side)}），再在 ${text(side)} 侧加回来`)
      }
      if (known.active === false || text(known.role) === '') {
        known.active = true
        known.last_at = at
        const saved = save(doc)
        if (!saved.ok) return saved
        return { ok: true, enrolled: 'reactivated', name: key, side: text(side), role: text(known.role),
          file: saved.file, mode: saved.mode, next_action: `已把他重新放进 ${text(side)} 侧名册（角色不变）` }
      }
      return { ok: true, enrolled: false, name: key, side: text(side), role: text(known.role),
        file: relative(resolve(String(root ?? '.')), file), mode: '0600',
        next_action: '他已经在名册里（重复的自动登记不会改角色/额度）' }
    }
    if (Object.keys(doc.members).length >= MAX_MEMBERS) {
      return refusal('too-many-members', `名册已经 ${Object.keys(doc.members).length} 人（上限 ${MAX_MEMBERS}）`,
        '先清掉离岗的人（名册面板里可以停用），再加新的')
    }
    doc.members[key] = { name: key, side: text(side), role: PENDING_ROLE, title: '', reports_to: '',
      active: true, source: 'auto-enroll', first_at: at, last_at: at }
    const saved = save(doc)
    if (!saved.ok) return saved
    say(`登录即登记：${who}（${side}，角色 ${PENDING_ROLE} 待指派）`)
    return { ok: true, enrolled: true, name: key, side: text(side), role: PENDING_ROLE,
      file: saved.file, mode: saved.mode,
      next_action: `他到名册里了（角色「待指派」= 没有权限）：在「人员名册与角色」面板里给他补角色/直属上级` }
  }

  /** 加/改一个成员（界面上的「加人」「改角色/直属/在职」都走它）。 */
  const upsertMember = ({ actor, side, name, role = '', title = '', reports_to = '', active = true, at = '' } = {}) => {
    const bad = guardActor(actor, { side })
    if (bad) return bad
    const who = humanOf(name)
    if (who === '') return refusal('name-malformed', `成员名字形状非法：${JSON.stringify(name)}`,
      '名字用小写字母开头、≤32 位、只含 [a-z0-9._-]（它会进 human:<名字> 与 URL）')
    const key = nameOf(who)
    const manager = text(reports_to) === '' ? '' : nameOf(humanOf(reports_to))
    if (text(reports_to) !== '' && manager === '') {
      return refusal('manager-unknown', `直属上级名字形状非法：${JSON.stringify(reports_to)}`,
        '写 human:<名字> 或直接写名字；也可以留空（没有直属上级）')
    }
    if (manager === key) {
      return refusal('manager-cycle', `不能把 ${key} 的直属上级设成他自己`,
        '直属关系要指向另一个人（或留空）')
    }
    const saved = writeDoc((doc) => {
      if (text(role) !== '' && !plain(rolesOf(doc)[text(role)])) {
        return refusal('role-unknown', `名册里没有角色 ${JSON.stringify(role)}`,
          `已有角色：${Object.keys(rolesOf(doc)).join(' / ')}；要新角色先用「设定角色」加一个`)
      }
      if (manager !== '' && !plain(doc.members[manager])) {
        return refusal('manager-unknown', `${manager} 不在名册里`,
          '先把他加进名册（跨侧的人不能当本侧成员的直属上级）')
      }
      if (manager !== '' && text(doc.members[manager]?.side) !== text(side)) {
        return refusal('manager-unknown', `${manager} 属于 **${text(doc.members[manager]?.side)}** 侧，不能当 ${text(side)} 侧成员的直属上级`,
          '直属关系只在同一侧内成立（跨侧不是"上下级"，是甲乙方）')
      }
      const known = plain(doc.members[key]) ? doc.members[key] : null
      if (!known && Object.keys(doc.members).length >= MAX_MEMBERS) {
        return refusal('too-many-members', `名册已经 ${Object.keys(doc.members).length} 人（上限 ${MAX_MEMBERS}）`,
          '先停用离岗的人，再加新的')
      }
      if (known && text(known.side) !== text(side)) {
        return refusal('cross-side-member', `${key} 已经在 **${text(known.side)}** 侧的名册里`,
          `一个人只属于一侧：先把他从 ${text(known.side)} 侧移出，再加进 ${text(side)}`)
      }
      // 环检测：沿着 reports_to 往上走，走回自己就是环（名册里不允许出现"我的上级也是我"）
      let cursor = manager
      let hops = 0
      while (cursor !== '' && hops <= MAX_MEMBERS) {
        if (cursor === key) {
          return refusal('manager-cycle', `${key} 的直属链绕回了自己（${manager} → … → ${key}）`,
            '上级关系要是一条能走到头的链（顶上那位留空）')
        }
        cursor = text(doc.members[cursor]?.reports_to)
        hops += 1
      }
      doc.members[key] = { name: key, side: text(side), role: text(role) || text(known?.role) || PENDING_ROLE,
        title: flat(title, MAX_TEXT), reports_to: manager, active: active !== false,
        source: text(known?.source) || 'roster', first_at: text(known?.first_at) || at, last_at: at }
      return null
    }, { at })
    if (!saved.ok) return saved
    const member = memberOf(key)
    return { ok: true, code: text(role) === '' ? 'member-saved' : 'member-role-set', member,
      file: saved.file, mode: saved.mode,
      next_action: `名册已更新：${key} = ${member?.role_label}（换角色/额度立刻影响他能执行的动作；`
        + '**不影响签署权**：人签仍要求署名 == 会话身份）' }
  }

  /** 停用（离岗）：**不删行**，只置 `active:false`（历史留痕；他不再出现在候选名单里）。 */
  const deactivate = ({ actor, name, at = '' } = {}) => {
    const bad = guardActor(actor)
    if (bad) return bad
    const key = nameOf(humanOf(name) || `human:${text(name)}`)
    const doc = load()
    if (!plain(doc.members[key])) {
      return refusal('member-not-found', `名册里没有 ${key}`,
        '名册面板里的人数与角色就是真源；名字要写 human:<名字>')
    }
    if (text(doc.members[key].role) === 'admin' && members('', { includeInactive: false })
      .filter((item) => item.role === 'admin').length <= 1) {
      return refusal('role-in-use', `${key} 是名册里**唯一**的管理员：不能把他停用（否则没人能改名册）`,
        '先把另一个人的角色设成管理员，再停用他')
    }
    doc.members[key].active = false
    doc.members[key].last_at = at
    return save(doc).ok
      ? { ok: true, code: 'member-deactivated', name: key, file: relative(resolve(String(root ?? '.')), file),
        next_action: `${key} 不再出现在@提及/指派/转交的候选名单里（历史协作记录不动）；`
          + '要恢复就在名册面板里把他加回来（角色会回到待指派）' }
      : refusal('people-write-failed', '写名册失败', '看服务日志里 [people] 的报错')
  }

  /** 设定角色（加/改：标签、等级、额度、能力）；额度 `null` = 不限。 */
  const setRole = ({ actor, id, label = '', rank = null, approval_limit_cents = 0, note = '', at = '' } = {}) => {
    const bad = guardActor(actor)
    if (bad) return bad
    const roleId = text(id)
    if (!ROLE_ID_RE.test(roleId)) {
      return refusal('role-malformed', `角色 id 形状非法：${JSON.stringify(id)}`,
        '角色 id 写小写字母/数字/连字符（≤32 位，例如 supervisor）')
    }
    const limit = approval_limit_cents === null || approval_limit_cents === undefined || approval_limit_cents === ''
      ? null : Number(approval_limit_cents)
    if (limit !== null && (!Number.isInteger(limit) || limit < 0 || limit > MAX_LIMIT_CENTS)) {
      return refusal('role-limit', `额度必须是 0..${MAX_LIMIT_CENTS} 的整数分，或留空 = 不限（收到 ${JSON.stringify(approval_limit_cents)}）`,
        '金额一律**整数分**：5000000 = 50000.00 元；要"不限"就留空')
    }
    const rk = rank === null || rank === undefined || rank === '' ? null : Number(rank)
    if (rk !== null && !Number.isInteger(rk)) {
      return refusal('role-malformed', `等级必须是整数（收到 ${JSON.stringify(rank)}）`,
        '等级用来比"谁比谁大"（0–100；管理员最大）')
    }
    const saved = writeDoc((doc) => {
      const roles = rolesOf(doc)
      const known = roles[roleId]
      if (!known && doc.roles.length >= MAX_ROLES) {
        return refusal('too-many-roles', `角色已经 ${doc.roles.length} 个（上限 ${MAX_ROLES}）`,
          '先删掉不用的角色（有人的角色删不掉：role-in-use）')
      }
      const next = { id: roleId, label: flat(label, MAX_TEXT) || text(known?.label) || roleId,
        rank: rk === null ? Number(known?.rank ?? 10) : rk,
        approval_limit_cents: approval_limit_cents === '' || approval_limit_cents === undefined
          ? (known?.approval_limit_cents ?? 0) : limit,
        note: flat(note, MAX_NOTE) || text(known?.note) || '' }
      doc.roles = [...doc.roles.filter((role) => role.id !== roleId), next]
      return null
    }, { at })
    if (!saved.ok) return saved
    const role = (saved.doc.roles ?? []).find((item) => item.id === roleId)
    return { ok: true, code: 'role-set', role, file: saved.file, mode: saved.mode,
      next_action: `角色 ${roleId}（${role?.label}）已更新：额度 ${role?.approval_limit_cents === null ? '不限' : `${role?.approval_limit_cents} 分`}`
        + '；改它会立刻影响用它的人能执行的动作（**不影响签署权**）' }
  }

  /** 删除角色（有人在用 ⇒ 拒，`role-in-use`；不许悄悄把人降级）。 */
  const removeRole = ({ actor, id, at = '' } = {}) => {
    const bad = guardActor(actor)
    if (bad) return bad
    const roleId = text(id)
    const saved = writeDoc((doc) => {
      if (!plain(rolesOf(doc)[roleId])) {
        return refusal('role-unknown', `没有角色 ${JSON.stringify(roleId)}`,
          `已有角色：${doc.roles.map((role) => role.id).join(' / ')}`)
      }
      const used = Object.values(doc.members).filter((member) => text(member.role) === roleId).map((member) => member.name)
      if (used.length) {
        return refusal('role-in-use', `${roleId} 还有 ${used.length} 个成员在用：${used.join(' ')}`,
          '先把这些人改成别的角色（在名册面板里逐条改），再删这个角色')
      }
      if (roleId === PENDING_ROLE) {
        return refusal('role-in-use', `${PENDING_ROLE} 是"登录即登记"的落点：不能删`,
          '它只代表"有名字、没有权限"；不需要可以不用，但删掉会让新来的人无处安放')
      }
      doc.roles = doc.roles.filter((role) => role.id !== roleId)
      return null
    }, { at })
    if (!saved.ok) return saved
    return { ok: true, code: 'role-removed', id: roleId, file: saved.file,
      next_action: `角色 ${roleId} 已删除（用它的人一个都没有：没有人被悄悄降级）` }
  }

  /** 设定策略（转交越权角色 / 按角色限动作的规则表）。**只接受形状合法的配置**，非法逐条拒。 */
  const setPolicy = ({ actor, transfer = null, amount_limit = null, at = '' } = {}) => {
    const bad = guardActor(actor)
    if (bad) return bad
    const saved = writeDoc((doc) => {
      if (transfer !== null && transfer !== undefined) {
        if (!plain(transfer)) return refusal('policy-malformed', 'transfer 策略必须是对象', '给 {enabled, actions, override_roles}')
        const roles = rolesOf(doc)
        const override = (Array.isArray(transfer.override_roles) ? transfer.override_roles : [])
          .map(text).filter(Boolean)
        for (const id of override) {
          if (!plain(roles[id])) {
            return refusal('policy-malformed', `转交越权角色里有不存在的角色：${id}`,
              `已有角色：${Object.keys(roles).join(' / ')}`)
          }
        }
        const actions = (Array.isArray(transfer.actions) ? transfer.actions : []).map(text).filter(Boolean)
        doc.policy = { ...doc.policy, transfer: { enabled: transfer.enabled !== false, actions,
          override_roles: override, note: text(doc.policy?.transfer?.note) || DEFAULT_POLICY.transfer.note } }
      }
      if (amount_limit !== null && amount_limit !== undefined) {
        if (!plain(amount_limit) || !plain(amount_limit.rules)) {
          return refusal('policy-malformed', 'amount_limit 策略需要 {enabled, rules:{<动作 id>:{…}}}',
            '给 rules：{"<动作 id>":{"object_field":"…","fact":{"type":"…","id_field":"…","amount_key":"…","unit":"major|minor"}}}')
        }
        const rules = {}
        for (const [actionId, rule] of Object.entries(amount_limit.rules)) {
          if (text(actionId) === '' || !plain(rule)) {
            return refusal('policy-malformed', `规则形状非法：${JSON.stringify(actionId)}`,
              '每条规则 = {object_field, fact:{type, id_field, amount_key, unit}}')
          }
          const fact = plain(rule.fact) ? rule.fact : {}
          const unit = text(fact.unit) || 'minor'
          if (!['major', 'minor'].includes(unit)) {
            return refusal('policy-malformed', `金额单位只能是 major（元）或 minor（分）：${JSON.stringify(fact.unit)}`,
              '账本里是小数的金额写 major（内部 ×100 取整），已经是整数分的写 minor')
          }
          if (text(rule.object_field) === '' || text(fact.type) === '' || text(fact.id_field) === ''
            || text(fact.amount_key) === '') {
            return refusal('policy-malformed', `规则 ${actionId} 缺字段（object_field / fact.type / fact.id_field / fact.amount_key）`,
              '四条都要写：从哪条事实、按哪个键、取哪个金额键、什么单位')
          }
          rules[text(actionId)] = { object_field: text(rule.object_field), note: flat(rule.note, MAX_NOTE),
            fact: { type: text(fact.type), id_field: text(fact.id_field), amount_key: text(fact.amount_key), unit } }
        }
        doc.policy = { ...doc.policy, amount_limit: { enabled: amount_limit.enabled !== false, rules,
          unknown_amount: ['refuse', 'allow'].includes(text(amount_limit.unknown_amount))
            ? text(amount_limit.unknown_amount) : (doc.policy?.amount_limit?.unknown_amount ?? 'refuse'),
          note: text(doc.policy?.amount_limit?.note) || DEFAULT_POLICY.amount_limit.note } }
      }
      return null
    }, { at })
    if (!saved.ok) return saved
    return { ok: true, code: 'policy-set', policy: saved.doc.policy, file: saved.file, mode: saved.mode,
      next_action: '策略已生效（下一次请求就按它判）：转交越权角色与"按角色限动作"的规则都在这里' }
  }

  // ------------------------------------------------------------------ 判据（**按角色限动作**：只收紧，不放开）
  /** 我（这个会话身份）的角色；名册里没有我 ⇒ 回落 `pending`（= 没有权限，不是"不限"）。 */
  const roleOf = (side, human) => {
    const doc = load()
    const member = doc.members[nameOf(human)]
    if (!plain(member) || text(member.side) !== text(side)) return roleFor(doc, { role: PENDING_ROLE })
    return roleFor(doc, member)
  }
  /** 能否**转交别人的活**（当前指派不归我、也不是我下的）：策略里 override_roles 的角色才行。 */
  const transferOverride = (side, human) => {
    const doc = load()
    const policy = doc.policy?.transfer ?? DEFAULT_POLICY.transfer
    if (policy.enabled === false) return { ok: true, role: 'policy-disabled', policy }
    const role = roleOf(side, human)
    const allowed = (policy.override_roles ?? []).includes(role.id)
    return { ok: allowed, role: role.id, role_label: role.label, policy }
  }
  /**
   * **按角色限动作**（不是限视图）：这次请求能不能被执行。
   * 返回 `null` = 放行；返回拒绝对象 = 明确拒（带 `code`/`reason`/`next_action`，账本与待办件零新增）。
   * `rows(view)` = 本视角的账本行（只读；金额从**事实**里取，不从表单里取）。
   */
  const guardAction = ({ action_id, input = {}, identity = null, view = '', rows = () => [] } = {}) => {
    const doc = load()
    const policy = doc.policy?.amount_limit ?? DEFAULT_POLICY.amount_limit
    if (policy.enabled === false) return null
    const rule = plain(policy.rules) ? policy.rules[text(action_id)] : null
    if (!plain(rule)) return null
    const who = identity && identity.human ? identity.human : ''
    const side = identity && identity.side ? identity.side : ''
    if (who === '') {
      return refusal('identity-required', `「${action_id}」按角色限权：没有会话身份就不能判"你是谁、额度多少"`,
        `先在 ${'/identity/'} 登录（human:<名字> + 属于哪一侧），再用这个动作；这一次什么都没写`)
    }
    if (!isMember(side, who)) {
      return refusal('not-a-member', `${who} 不在 ${side} 侧名册里：无法判定他能不能执行「${action_id}」`,
        '先让他在名册里出现（登录一次自动登记为「待指派」，或由同侧同事在「人员名册与角色」面板里加人）；'
          + '名册里没有的人**不能执行受额度限制的动作**（拒绝而不是放过）')
    }
    const objectId = text(input[rule.object_field])
    if (objectId === '') {
      return refusal('amount-unknown', `「${action_id}」要看金额才能判额度，但入参里没有 ${rule.object_field}`,
        `这个动作的对象字段是 ${rule.object_field}：从列表/对象页打开它（会按地址预填），不要手敲空值`)
    }
    let amount = null
    const fact = rule.fact ?? {}
    for (const row of rows(view)) {
      if (!plain(row) || String(row.type ?? '') !== String(fact.type ?? '')) continue
      const body = plain(row.body) ? row.body : {}
      if (text(body[fact.id_field]) !== objectId) continue
      const raw = Number(body[fact.amount_key])
      if (!Number.isFinite(raw)) continue
      amount = fact.unit === 'major' ? Math.round(raw * 100) : Math.round(raw)
      break
    }
    if (amount === null) {
      if (text(policy.unknown_amount) === 'allow') return null
      return refusal('amount-unknown', `找不到「${action_id}」的金额事实（${fact.type} 里 ${fact.id_field}=${objectId} 的 ${fact.amount_key}）`,
        '额度检查宁可拦下一次也不放过越权：要么让这条事实先落账，要么由管理员在名册里改这条规则'
          + '（`amount_limit.rules` / `unknown_amount`）')
    }
    const role = roleOf(side, who)
    const limit = role.approval_limit_cents
    const cents = Math.abs(amount)
    if (limit === null) {
      return null                       // 不限：角色自己就够
    }
    if (cents <= Number(limit)) return null
    const need = doc.roles.filter((item) => item.approval_limit_cents === null
      || Number(item.approval_limit_cents) >= cents)
      .sort((left, right) => (Number(left.rank) - Number(right.rank)) || (left.id < right.id ? -1 : 1))[0] ?? null
    const roles = doc.roles.map((item) => `${item.label}(${item.id})=${item.approval_limit_cents === null
      ? '不限' : `${item.approval_limit_cents} 分`}`).join(' · ')
    return refusal('role-limit-exceeded',
      `「${action_id}」的金额 ${(cents / 100).toFixed(2)} 元（${cents} 分）超过你角色「${role.label}」的额度 `
        + `${limit === null ? '不限' : `${(Number(limit) / 100).toFixed(2)} 元`}`,
      need
        ? `交给有额度的角色（${need.label} / ${need.id}，额度 ${need.approval_limit_cents === null
          ? '不限' : `${(Number(need.approval_limit_cents) / 100).toFixed(2)} 元`}）来批：换人登录或请他在界面上做这一步；`
          + `**角色不改变签署权** —— 这一步仍然是人工门，要本人人签（署名 == 会话身份）`
        : `名册里还没有能批这么大的角色：让管理员在名册面板里调额度（当前：${roles}）`,
      { action_id: text(action_id), role: role.id, role_label: role.label,
        approval_limit_cents: limit, amount_cents: cents, object_field: rule.object_field, object_id: objectId,
        required_role: need ? need.id : null, ledger: 'zero-management' })
  }

  /** 名册自述（HTTP 只读面 + 证据）。 */
  return { dir, fileOf: () => file, configure, load, save, describe, members, memberOf, isMember, suggest,
    mentions, roles: () => load().roles, policy: () => load().policy, roleOf, enroll, upsertMember, deactivate,
    setRole, removeRole, setPolicy, transferOverride, guardAction, refused: REFUSAL_CODES }
}
