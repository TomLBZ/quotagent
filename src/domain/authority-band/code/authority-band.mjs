/**
 * 进树模块：`authority-band` —— **「授权区间」**（domain 插件，正面回答三句话）：
 *   ① **谁能批到多少**：`authority.bands.<角色>`（整数分）⇒ 输出区间**全表**与「覆盖本金额的角色」列表
 *      （每个角色给 `limit_cents` 与 `remaining_cents`）；
 *   ② **越界怎么办**：越界 ⇒ 走**人工门** —— 输出**可直接复制**的升级命令（真 CLI / 真门名），
 *      并且明说「**本插件不能批准、不能放行**」（`can_approve=false` + `approval_note`）；
 *   ③ **下一个能批的人是谁**：`next_role`（比当前角色限额更高的**最小**限额角色）、
 *      `required_role`（覆盖本金额的**最低权限**角色 —— least privilege：能满足就够）。
 *
 * 原始出处（原话在 `docs/work/plans/ux-双方痛点与交互需求.md.txt`）：
 *   · P-12「**[人类痛点]** 谈判让步的**授权区间不可见**」——人不敢批（不知道底线）或批过头；
 *   · §4.2「查看价格区间提示」：**无授权区间 → 显示"未设置授权区间；越界提交会被拒"（诚实，不猜）**。
 *
 * 纪律（每条都有门看着：`host/t284-authority-gate.mjs` + `tools/check-authority-route.py`）：
 *   · **未配置不得编限额**：`authority.bands.<角色>` 缺省（null）或没有登记 ⇒ `unconfigured=true` + 有名 `reason`，
 *     且 `required_role` / `next_role` **都为空** —— 绝不落回任何默认值（默认值 = 假事实，本项目既有教训）；
 *     `null`（未配置）与 `0`（人明确登记「这个角色一分也不能批」）是**两件事**，不许混同；
 *   · **越界必须走人工门**：越界时给可复制的升级命令；本插件**没有也不会**有 `approve` / `decide` / `grant` /
 *     `submit` / `ack` 这类方法（服务面恰 4 个键：`check` / `meta` / `config` 三个只读方法 + `requests` 声明清单）；
 *   · **只读**：只读调用方给的白名单载荷（`view` / `role` / `amount` / `config` 里的 `authority.*` 键）与自己的 Config；
 *     不读账本、不读文件、不联网、不调模型、**不取墙钟**（`payload.now` / `config.now` 读都不读）；
 *   · 金额一律**整数分**（`unit="cents"`）：负数 / 非整数 / 超上限一律**拒**并给具体 `code` + `next_action`
 *     （不折算、不四舍五入 —— 把「元」当「分」会被判越界，这正是要人自己声明单位的原因）；
 *   · 确定性（同输入两次逐字节一致；与入参键序无关）、有界（角色表 ≤ 8、金额 ≤ 上限、文本字段有界）、
 *     **私域零泄漏**（`config` 里非 `authority.` 前缀的键**读都不读**：带哨兵与不带哨兵输出逐字节一致）。
 */
import { constant, number, object, string } from '../lib/std-schema.mjs'

export const name = 'authority-band'

export const inject = []                 // 纯函数插件：载荷由调用方给（宿主只读配置快照）
export const builtin = []                // 本模块不使用事件：声明即事实（D-015 / A1 双向断言）
export const usedServices = []
export const provides = ['authorityBand']

/** 引擎自述：`rules` = **确定性规则**（不是模型、不是推测）。 */
export const ENGINE = 'rules'

/** 页面上必须原样出现的一句话（诚实分层 + "不能代签"一起说清）。 */
export const ENGINE_NOTE = '本页由确定性规则从**配置快照**派生（只读 `authority.*` 键）：不含模型推测、'
  + '不取墙钟、不读账本、不联网；**越界的唯一出路是人工门** —— 本插件不能批准、不能放行'

/** 金额口径的**机读名字**（JSON、页面文案与门都引用这一处真源）。 */
export const MONEY_UNIT = 'cents'

/** 金额口径的**人话**（页面照抄；把"分/元"这件事写清，越界判定才有意义）。 */
export const MONEY_NOTE = '金额一律用**整数分**参与比较（money_unit=cents）：500000 分 = 5000.00 元。'
  + '本插件**不做折算、不做四舍五入**：把元写成分，数字会大 100 倍并被判越界 —— 这正是'
  + ' `authority.unit` / `authority.currency` 只作**声明**、不替你换算的原因'

/** 配置快照里**被读**的段（白名单；门断言"输出只可能来自这一段"）。 */
export const SECTIONS = ['config']

/** 墙钟入口（**存在但被忽略**：写进输出只为让"我没读它"成为可机检的事实）。 */
export const IGNORED_NOW_INPUTS = ['payload.now', 'config.now']

// ---------------------------------------------------------------------------
// 配置键（与 `host/lib/config-keys.mjs` 的登记**逐字同名**；门会两侧比对，防漂移）
// ---------------------------------------------------------------------------
export const CONFIG_PREFIX = 'authority.'
export const BAND_PREFIX = 'authority.bands.'
export const UNIT_KEY = 'authority.unit'
export const CURRENCY_KEY = 'authority.currency'
export const FALLBACK_ROLE_KEY = 'authority.fallback_role'
export const ESCALATION_NOTE_KEY = 'authority.escalation_note'

/** 登记的角色（= `host/lib/config-keys.mjs` 里 `authority.bands.*` 的三条；门逐字比对）。 */
export const REGISTERED_ROLES = ['buyer', 'director', 'lead']

/** 单位声明只认这一个值：别的值一律**拒解释**（不把元当分、不静默换算）。 */
export const SUPPORTED_UNITS = ['cents']

// ---------------------------------------------------------------------------
// 有界常量（改口径就改这里 + 门 t284）
// ---------------------------------------------------------------------------
/** 金额硬上限（整数分）：10^12 分 = 100 亿元 —— 有界，不猜天文数字。 */
export const AMOUNT_MAX = 1000000000000
/** 单次最多读入的角色数（有界：配置里给一堆角色也不把响应撑大；超出如实报 `roles_omitted`）。 */
export const ROLE_MAX = 8
/** 角色名 / 文本字段的字符上限（回显回来的任意字节必须有界）。 */
const ROLE_LIMIT = 32
const TEXT_MAX = 240
const ID_LIMIT = 64

/** 结论状态（**闭合集合**；页面/JSON/门都按这四个字面量判）。 */
export const STATUSES = ['inside-band', 'over-band', 'unconfigured', 'input-rejected']

/** 有名 `reason` 的**闭合集合**（门据此断言"降级是有名的，不是含糊的"）。 */
export const REASONS = ['payload-not-an-object', 'config-missing', 'unit-unsupported', 'role-missing',
  'band-unconfigured', 'amount-missing', 'amount-not-an-integer', 'amount-negative',
  'amount-out-of-range', 'over-band']

/** 输入/配置类拒绝码（`code` 取值域；`over-band` 不是拒绝，故**不在**这里）。 */
export const REFUSAL_CODES = ['payload-not-an-object', 'config-missing', 'unit-unsupported', 'role-missing',
  'band-unconfigured', 'amount-missing', 'amount-not-an-integer', 'amount-negative', 'amount-out-of-range']

/** 阻塞者的**闭合集合**（`''` = 没被挡住）。 */
export const BLOCKED_BY_VALUES = ['', 'human-gate-required', 'authority-unconfigured', 'input-rejected']

/**
 * 升级 / 决定路径（**两条各管一件事**，都是**在 APP 里点得到**的真动作）：
 *   · `ESCALATE_COMMAND`：越界后的第一步 —— 在「授权区间」面板点「提交给下一角色审批」
 *     （动作 `authority.escalate`，人签）把这件事**提成一条人工门**；
 *   · `ESCALATE_HUMAN_COMMAND`：门开出来以后**谁在哪批** —— 去「审批队列」由点名的审批人
 *     点「批准」/「驳回」（动作 `gate.grant` / `gate.deny`）。
 *
 * 旧口径（`tools/verify.sh gates` 的升级自述 + `PYTHONPATH=src python3 -m quotagent.g1side …` 的
 * 「人工签署命令」）已按 `docs/design/29-webui-gui-app.md` §2 + `AGENTS.md` 规则 12 **删除** ——
 * 产品面不许教用户回终端。门 t284 的判据同步改成「**这两条指到的动作 id 真的注册在注册面里**」：
 * 不弱于原来（命令名打错与动作 id 打错一样判红）。
 */
export const ESCALATE_COMMAND = '在「授权区间」面板点「提交给下一角色审批」（动作 `authority.escalate`，人签）'
  + '把这件事提成一条人工门；门开出来后去「审批队列」批准 / 驳回'
export const ESCALATE_HUMAN_COMMAND = '批准 / 驳回在 GUI 的「审批队列」里由点名的审批人**人签**'
  + '（动作 `gate.grant` / `gate.deny`；署名必须 == 会话身份）'

/** 「不能批准」的**人话**（越界与未配置两种结论都会带上它，别让人误会页面能放行）。 */
export const APPROVAL_NOTE = '本插件**不能**批准、不能放行、不能改任何判定：它只算"这笔金额落在谁的区间里、'
  + '越界多少、下一个能批的人是谁"；**真正改判定的是审批队列里的「批准 / 驳回」**（人签，动作 `gate.grant` / `gate.deny`）'

/** 配置在哪（页面与 next_action 引用这一处真源）。 */
export const CONFIG_WHERE = '`/quotagent/admin/config/`（提权后）—— `authority.bands.<角色>` 是**人工专属键**'
  + '（humanOnly：提交要带 `ap-NNNN` 人工引用），也可以直接写受管 YAML 的 `project:` 段；'
  + '两种路径都只落待办件/落盘由 Python 侧 `tools/config-apply.py` 做'

/** 未配置时的**诚实默认**（人话；页面照抄）。 */
export const UNCONFIGURED_NOTE = '未配置授权区间：**本插件不会替你编一个限额** —— 报 `unconfigured` 并留空'
  + ' `required_role`/`next_role`（不知道就是不知道）。登记后请重新派生（本页每次都是现算的，没有缓存）'

export const Config = object({
  max_roles: number().default(8),          // 角色表条数上限（夹取区间 [1, 8]）
  route_prefix: string().default('/quotagent'),
  now: string().default(''),               // 墙钟观测量：**读都不读**（见文件头的只读纪律）
  deterministic: constant(true),           // const 键：不得翻转（A3 负控）
})

// ---------------------------------------------------------------------------
// 小工具（与 `gate-timeline` 同一套纪律：不取墙钟、不解析非整数）
// ---------------------------------------------------------------------------
const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** 只有**整数**才算一个限额/金额；浮点、字符串数字、NaN、±Infinity 一律按"取不到"处理（不猜）。 */
const intOrNull = (value) => (typeof value === 'number' && Number.isInteger(value) ? value : null)

/** 人话串：清控制字符、去空白、截断（**有界**）；空串按取不到处理。 */
const textOrNull = (value, maxChars = TEXT_MAX) => {
  if (typeof value !== 'string') return null
  const stripped = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  if (stripped === '') return null
  return stripped.length > maxChars ? stripped.slice(0, maxChars) : stripped
}

const clampRoles = (value) => {
  const amount = intOrNull(value)
  if (amount === null) return ROLE_MAX
  return Math.min(ROLE_MAX, Math.max(1, amount))
}

const resolvedOptions = (config) => {
  const cfg = isPlain(config) ? config : {}
  return Object.freeze({
    max_roles: clampRoles(cfg.max_roles),
    route_prefix: (textOrNull(cfg.route_prefix, 128) ?? '/quotagent').replace(/\/$/, ''),
    // **读进来只为"证明它没被用于计算"**：任何把它掺进结论的做法都会被门抓红（t284 变异 1）
    now: textOrNull(cfg.now, 40),
  })
}

/** 角色名的形状（只有这种形状的键才会被当成"区间登记"——别的键**读都不读**）。 */
const ROLE_RE = /^[a-z][a-z0-9_-]{0,31}$/

/** 显式字典序比较器（排序不依赖默认比较的隐含规则，也不受 locale 影响）。 */
const byLex = (left, right) => (left < right ? -1 : (left > right ? 1 : 0))

// ---------------------------------------------------------------------------
// 配置快照读取（**白名单**：非 `authority.` 前缀的键一个都不读值）
// ---------------------------------------------------------------------------
/**
 * 读调用方给的**配置快照**（`payload.config`）。返回值里只有被读到的键：
 *   `unit` / `currency` / `fallback_role` / `escalation_note` / `bands`（角色 → 整数分）。
 * 未出现（或值不是合法形状）⇒ 对应字段为 `null` = **未配置**（不许落回默认值）。
 */
const readConfig = (raw, roleLimit = ROLE_MAX) => {
  const out = { present: false, unit: null, currency: null, fallback_role: null, escalation_note: null,
    bands: [], role_entries: 0, roles_omitted: 0, foreign_keys: 0 }
  if (!isPlain(raw)) return out
  out.present = true
  // 只按**键名**挑出 authority.* 的候选；其余键的**值**我们不读（私域零泄漏）
  const keys = Object.keys(raw).filter((key) => typeof key === 'string' && key.startsWith(CONFIG_PREFIX)).sort(byLex)
  out.foreign_keys = Object.keys(raw).length - keys.length
  for (const key of keys) {
    if (key === UNIT_KEY) { out.unit = textOrNull(raw[key], 16); continue }
    if (key === CURRENCY_KEY) { out.currency = textOrNull(raw[key], 16); continue }
    if (key === FALLBACK_ROLE_KEY) { out.fallback_role = textOrNull(raw[key], ID_LIMIT); continue }
    if (key === ESCALATION_NOTE_KEY) { out.escalation_note = textOrNull(raw[key]); continue }
    if (!key.startsWith(BAND_PREFIX)) continue                 // 形如 authority.foo：不认识的键 → 不读
    const role = key.slice(BAND_PREFIX.length)
    if (!ROLE_RE.test(role)) continue                          // 坏角色名（含哨兵/大写/超长）→ 不进区间表、不回显
    const limit = intOrNull(raw[key])
    if (limit === null || limit < 0 || limit > AMOUNT_MAX) continue   // null = **未配置**；坏值一律不猜
    out.role_entries += 1
    if (out.bands.length < roleLimit) out.bands.push({ role, limit_cents: limit })
    else out.roles_omitted += 1
  }
  out.bands.sort((left, right) => (left.limit_cents - right.limit_cents) || byLex(left.role, right.role))
  return out
}

// ---------------------------------------------------------------------------
// 金额解析（整数分；不折算、不四舍五入）
// ---------------------------------------------------------------------------
const INT_RE = /^-?\d+$/
const parseAmount = (raw) => {
  if (raw === undefined || raw === null) return { ok: false, code: 'amount-missing' }
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw)) return { ok: false, code: 'amount-not-an-integer' }
    return { ok: true, value: raw }
  }
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (text === '') return { ok: false, code: 'amount-missing' }
    if (!INT_RE.test(text)) return { ok: false, code: 'amount-not-an-integer' }
    const value = Number(text)
    if (!Number.isSafeInteger(value)) return { ok: false, code: 'amount-out-of-range' }
    return { ok: true, value }
  }
  return { ok: false, code: 'amount-not-an-integer' }
}

const NEXT_ACTIONS = {
  'payload-not-an-object': '让调用方给**对象载荷**（形如 {view, role, amount, config}）：本插件不猜形状',
  'config-missing': '把配置快照交给本插件（宿主读 `/quotagent/admin/api/config` 的 project 段里 `authority.*` 那些行）'
    + '；读不到就报 `config-missing`，**不假装**区间存在',
  'unit-unsupported': '把 `authority.unit` 改回 `cents`（本插件只按**整数分**判区间：把元当分会被判越界，'
    + '而静默换算等于替你改口径）',
  'role-missing': '给出角色名（登记表见 `/quotagent/admin/api/config` 的 `authority.bands.*` 行）；'
    + '本插件不猜"你是谁"，因为限额是按角色的',
  'band-unconfigured': `登记 \`authority.bands.<角色>\`（**整数分**）后重新派生：${CONFIG_WHERE}。`
    + '在未配置时本插件**绝不**替你编一个限额（null ≠ 0：0 是"人明确登记过一分也不能批"）',
  'amount-missing': '把金额填上（**整数分**：500000 = 5000.00 元）；不填就不给结论（不把空当成 0）',
  'amount-not-an-integer': '把金额写成**整数分**（例：500000）。小数/带单位/科学计数法一律拒：'
    + '本插件不做折算、不四舍五入',
  'amount-negative': '金额必须 ≥ 0（负数没有任何授权区间含义：它不是一笔金额，也不该落进任何比较）',
  'amount-out-of-range': `金额超过本插件的**有界上限** ${AMOUNT_MAX} 分（= 100 亿元）：请拆单，`
    + '或先确认是不是把「元」写成了「分」（有界：不猜天文数字）',
  'over-band': '越界 ⇒ 走人工门（面板上的「提交给下一角色审批」，动作 `authority.escalate`）：**本插件不能批准**；'
    + '门开出来后由点名的审批人在「审批队列」里批准 / 驳回，'
    + `或者由人调 \`authority.bands.<角色>\`（${CONFIG_WHERE}）`,
}

// ---------------------------------------------------------------------------
// 派生主体（**纯函数**：只读入参，不写任何入参对象）
// ---------------------------------------------------------------------------
const emptyBands = () => []

/**
 * 把「视图 + 金额（整数分）+ 角色 + 配置快照」派生成区间结论。
 * 只读入参：不读账本/文件/墙钟/随机数、不联网、不调模型、不改入参。
 */
export const checkOf = (payload, config) => {
  const options = resolvedOptions(config)
  const reflect = (view, role, amount) => ({ view, role, amount })

  const shape = (fields, extra) => ({
    source: 'authority-band',
    engine: ENGINE,
    engine_note: ENGINE_NOTE,
    ...fields,
    unit: MONEY_UNIT,
    money_note: MONEY_NOTE,
    status: extra.status,
    within: extra.within,
    bands: extra.bands,
    required_role: extra.required_role,
    next_role: extra.next_role,
    over_by: extra.over_by,
    escalate_cmd: extra.escalate_cmd,
    escalate_human_cmd: extra.escalate_cmd === '' ? '' : ESCALATE_HUMAN_COMMAND,
    inside_band: extra.inside_band,
    blocked_by: extra.blocked_by,
    unconfigured: extra.unconfigured,
    basis: [...extra.basis].sort(byLex),
    degraded: extra.reason !== '',
    reason: extra.reason,
    code: extra.code,
    next_action: extra.next_action,
    escalation_note: extra.escalation_note,
    escalation_note_source: extra.escalation_note_source,
    config_where: CONFIG_WHERE,
    unconfigured_note: extra.unconfigured ? UNCONFIGURED_NOTE : '',
    approval_note: APPROVAL_NOTE,
    can_approve: false,
    registered_roles: [...REGISTERED_ROLES],
    counts: extra.counts,
    bounds: { max_roles: options.max_roles, amount_max: AMOUNT_MAX, unit_limit: 16, note_limit: TEXT_MAX },
    truncated: extra.counts.roles_omitted > 0,
    ignored_now_inputs: [...IGNORED_NOW_INPUTS],
    notes: [...extra.notes].sort(byLex),
    privacy: { private_keys_read: false, model_calls: 0, network_calls: 0, clock_reads: 0 },
  })

  // 计数（**恒定的键集**：任何路径都给同一组计数键，免得调用方到处判 undefined）
  const counts = (cfg, extra = {}) => ({
    roles_configured: cfg.bands.length,
    roles_omitted: cfg.roles_omitted,
    foreign_config_keys: cfg.foreign_keys,
    within: extra.within ?? 0,
    ...extra.more,
  })

  // ---- 0. 载荷形状 ----
  if (!isPlain(payload)) {
    return shape(reflect('', '', null), { status: 'input-rejected', within: emptyBands(), bands: emptyBands(),
      required_role: '', next_role: '', over_by: null, escalate_cmd: '', inside_band: null,
      blocked_by: 'input-rejected', unconfigured: true, basis: ['payload'], reason: 'payload-not-an-object',
      code: 'payload-not-an-object', next_action: NEXT_ACTIONS['payload-not-an-object'],
      escalation_note: '', escalation_note_source: 'default',
      counts: counts(readConfig(null, options.max_roles)), notes: ['载荷不是对象 ⇒ 不给任何结论（不猜）'] })
  }
  const view = textOrNull(payload.view, ROLE_LIMIT) ?? ''
  const role = textOrNull(payload.role, ROLE_LIMIT) ?? ''
  const cfg = readConfig(payload.config, options.max_roles)
  const notes = []
  if (!cfg.present) notes.push('配置快照缺失/不是对象 ⇒ 读不到任何区间登记')
  if (cfg.foreign_keys > 0) notes.push(`配置快照里有 ${cfg.foreign_keys} 个非 authority.* 的键 → **读都不读**（私域零泄漏）`)
  if (cfg.roles_omitted > 0) notes.push(`区间登记超出单次读取上限 ${options.max_roles} → 未读 ${cfg.roles_omitted} 条（有界，照实报）`)
  const baseBasis = ['payload.config', 'payload.amount', 'payload.role', 'payload.view']

  // ---- 1. 配置快照 ----
  if (!cfg.present) {
    return shape(reflect(view, role, null), { status: 'unconfigured', within: emptyBands(), bands: emptyBands(),
      required_role: '', next_role: '', over_by: null, escalate_cmd: '', inside_band: null,
      blocked_by: 'authority-unconfigured', unconfigured: true, basis: baseBasis,
      reason: 'config-missing', code: 'config-missing', next_action: NEXT_ACTIONS['config-missing'],
      escalation_note: '', escalation_note_source: 'default',
      counts: counts(cfg), notes: [...notes, '未配置 ⇒ required_role/next_role 留空、inside_band=null（不编结论）'] })
  }

  // ---- 2. 单位声明（只认 cents；别的值一律拒解释）----
  const unitKeyPresent = Object.prototype.hasOwnProperty.call(payload.config, UNIT_KEY)
  if (cfg.unit !== null && !SUPPORTED_UNITS.includes(cfg.unit)) {
    return shape(reflect(view, role, null), { status: 'unconfigured', within: emptyBands(), bands: cfg.bands,
      required_role: '', next_role: '', over_by: null, escalate_cmd: '', inside_band: null,
      blocked_by: 'authority-unconfigured', unconfigured: true, basis: [...baseBasis, `config[${UNIT_KEY}]`],
      reason: 'unit-unsupported', code: 'unit-unsupported', next_action: NEXT_ACTIONS['unit-unsupported'],
      escalation_note: cfg.escalation_note ?? '', escalation_note_source: cfg.escalation_note === null ? 'default' : 'file',
      counts: counts(cfg), notes: [...notes, `单位声明是 ${cfg.unit}（只支持 ${SUPPORTED_UNITS.join('/')}）：`
        + '本插件**不换算** —— 静默把元当分会静默改口径'] })
  }
  if (!unitKeyPresent) notes.push(`配置里没有 ${UNIT_KEY} 声明：按本插件的口径（整数分）解释金额，`
    + '请显式登记单位，免得把元当分')

  // ---- 3. 角色 ----
  if (role === '') {
    return shape(reflect(view, role, null), { status: 'unconfigured', within: emptyBands(), bands: cfg.bands,
      required_role: '', next_role: '', over_by: null, escalate_cmd: '', inside_band: null,
      blocked_by: 'input-rejected', unconfigured: true, basis: [...baseBasis, 'config'],
      reason: 'role-missing', code: 'role-missing', next_action: NEXT_ACTIONS['role-missing'],
      escalation_note: cfg.escalation_note ?? '', escalation_note_source: cfg.escalation_note === null ? 'default' : 'file',
      counts: counts(cfg), notes: [...notes, '没给角色 ⇒ 不给区间结论（限额是按角色的，不猜你是谁）'] })
  }

  const own = cfg.bands.find((item) => item.role === role) ?? null
  const bandBasis = `config[${BAND_PREFIX}${role}]`
  if (own === null) {
    return shape(reflect(view, role, null), { status: 'unconfigured', within: emptyBands(), bands: cfg.bands,
      required_role: '', next_role: '', over_by: null, escalate_cmd: '', inside_band: null,
      blocked_by: 'authority-unconfigured', unconfigured: true, basis: [...baseBasis, bandBasis, `config[${UNIT_KEY}]`],
      reason: 'band-unconfigured', code: 'band-unconfigured', next_action: NEXT_ACTIONS['band-unconfigured'],
      escalation_note: cfg.escalation_note ?? '', escalation_note_source: cfg.escalation_note === null ? 'default' : 'file',
      counts: counts(cfg), notes: [...notes, `角色 ${role} **没有**登记限额（${bandBasis} 为 null 或缺省）⇒ `
        + 'unconfigured=true，`required_role`/`next_role` 留空 —— **不编一个限额**'] })
  }

  // ---- 4. 金额（负数 / 非整数 / 超上限三类拒 + 缺参）----
  const parsed = parseAmount(payload.amount)
  if (!parsed.ok || parsed.value < 0 || parsed.value > AMOUNT_MAX) {
    const code = parsed.ok ? (parsed.value < 0 ? 'amount-negative' : 'amount-out-of-range') : parsed.code
    return shape(reflect(view, role, parsed.ok ? parsed.value : null),
      { status: 'input-rejected', within: emptyBands(), bands: cfg.bands, required_role: '', next_role: '',
        over_by: null, escalate_cmd: '', inside_band: null, blocked_by: 'input-rejected', unconfigured: false,
        basis: [...baseBasis, bandBasis], reason: code, code, next_action: NEXT_ACTIONS[code],
        escalation_note: cfg.escalation_note ?? '', escalation_note_source: cfg.escalation_note === null ? 'default' : 'file',
        counts: counts(cfg), notes: [...notes, `金额不可用（${code}）⇒ 不给区间结论：`
          + '越界判定必须建立在**整数分**上（不折算、不四舍五入）'] })
  }
  const amount = parsed.value

  // ---- 5. 区间判定（手算口径写在 notes 里，可与门/页面逐项对账）----
  const within = cfg.bands.filter((item) => item.limit_cents >= amount)
    .map((item) => ({ role: item.role, limit_cents: item.limit_cents, remaining_cents: item.limit_cents - amount }))
  const requiredRole = within.length > 0 ? within[0].role : ''
  // 「下一个能批的人」= 比当前角色限额更高、**且真的批得到这笔金额**的最小限额角色；
  // 没有这样的角色就留空（"没人能批这笔"本身就是结论：只能走人工门/改配置，别编一个人名）
  const higher = cfg.bands.filter((item) => item.limit_cents > own.limit_cents && item.limit_cents >= amount)
  const nextRole = higher.length > 0 ? higher[0].role : ''
  const inside = amount <= own.limit_cents
  const overBy = inside ? 0 : amount - own.limit_cents
  const basis = [...baseBasis, bandBasis, `config[${UNIT_KEY}]`]
  if (cfg.currency !== null) basis.push(`config[${CURRENCY_KEY}]`)
  if (cfg.fallback_role !== null) basis.push(`config[${FALLBACK_ROLE_KEY}]`)
  if (cfg.escalation_note !== null) basis.push(`config[${ESCALATION_NOTE_KEY}]`)
  const ownNote = `角色 ${role} 的限额 ${own.limit_cents} 分、金额 ${amount} 分 ⇒ `
    + (inside ? `在区间内（还差 ${own.limit_cents - amount} 分到限额）` : `**越界 ${overBy} 分**`)
  const noteList = [...notes, ownNote,
    `覆盖本金额的角色 ${within.length} 个（最低权限者 = ${requiredRole === '' ? '（没有：谁都不能批）' : requiredRole}）`,
    nextRole === ''
      ? `比 ${role} 更高限额的角色：没有${cfg.fallback_role === null ? '' : `（配置声明的兜底角色 ${cfg.fallback_role} 未登记限额，**不**用来补一个限额）`}`
      : `比 ${role} 更高限额的角色：${nextRole}（${cfg.bands.find((item) => item.role === nextRole).limit_cents} 分）`]
  if (cfg.currency !== null) noteList.push(`币种声明：${cfg.currency}（只声明、不换算）`)

  const escalationNoteSource = cfg.escalation_note === null ? 'default' : 'file'
  if (inside) {
    return shape(reflect(view, role, amount), { status: 'inside-band', within, bands: cfg.bands,
      required_role: requiredRole, next_role: nextRole, over_by: 0, escalate_cmd: '', inside_band: true,
      blocked_by: '', unconfigured: false, basis,
      reason: '', code: '', next_action: `在区间内：可以继续既有流程；**真正的批准在审批队列里由人签**`
        + `（动作 \`gate.grant\` / \`gate.deny\`；本插件不能代签）${nextRole === '' ? '' : `；要批更大的金额就得找 ${nextRole}`}`,
      escalation_note: cfg.escalation_note ?? '', escalation_note_source: escalationNoteSource,
      counts: counts(cfg, { within: within.length }), notes: noteList })
  }
  return shape(reflect(view, role, amount), { status: 'over-band', within, bands: cfg.bands,
    required_role: requiredRole, next_role: nextRole, over_by: overBy, escalate_cmd: ESCALATE_COMMAND,
    inside_band: false, blocked_by: 'human-gate-required', unconfigured: false, basis,
    reason: 'over-band', code: '', next_action: NEXT_ACTIONS['over-band'],
    escalation_note: cfg.escalation_note ?? '', escalation_note_source: escalationNoteSource,
    counts: counts(cfg, { within: within.length }),
    notes: [...noteList, `越界 ⇒ **人工门**：${ESCALATE_COMMAND}；${ESCALATE_HUMAN_COMMAND}；`
      + '本插件**不能批准**（can_approve=false）'] })
}

export function apply(ctx, config) {
  const options = resolvedOptions(config)
  const handle = {
    requests: ['check'],                  // 只声明事实：服务面恰 3 个**只读**方法（没有、也不许有"批准"类方法）
    check: (payload) => checkOf(payload, config),
    meta: () => ({
      engine: ENGINE, engine_note: ENGINE_NOTE, unit: MONEY_UNIT, money_note: MONEY_NOTE,
      supported_units: [...SUPPORTED_UNITS], registered_roles: [...REGISTERED_ROLES],
      band_prefix: BAND_PREFIX, unit_key: UNIT_KEY, currency_key: CURRENCY_KEY,
      fallback_role_key: FALLBACK_ROLE_KEY, escalation_note_key: ESCALATION_NOTE_KEY,
      statuses: [...STATUSES], reasons: [...REASONS], refusal_codes: [...REFUSAL_CODES],
      blocked_by_values: [...BLOCKED_BY_VALUES], sections: [...SECTIONS],
      ignored_now_inputs: [...IGNORED_NOW_INPUTS], config_where: CONFIG_WHERE,
      escalate_cmd: ESCALATE_COMMAND, escalate_human_cmd: ESCALATE_HUMAN_COMMAND,
      bounds: { max_roles: options.max_roles, amount_max: AMOUNT_MAX },
      can_approve: false,                // 机器可读的"不能批准"：本插件的服务面里没有这类方法
      approval_note: APPROVAL_NOTE,
    }),
    config: () => ({ max_roles: options.max_roles, route_prefix: options.route_prefix, unit: MONEY_UNIT,
      amount_max: AMOUNT_MAX, registered_roles: [...REGISTERED_ROLES] }),
  }
  ctx.provide('authorityBand', handle)
}

export function disposer() {
  return () => {}
}

/** fixture：纯读取（A5 会连跑两次比对字节，故不得有任何副作用）。 */
export const fixture = {
  sample: (handle) => JSON.stringify({
    inside: handle.check({ view: 'contractor', role: 'buyer', amount: 500000,
      config: { 'authority.unit': 'cents', 'authority.currency': 'CNY',
        'authority.bands.buyer': 500000, 'authority.bands.lead': 2000000, 'authority.bands.director': 10000000 } }),
    over: handle.check({ view: 'contractor', role: 'buyer', amount: 500001,
      config: { 'authority.unit': 'cents', 'authority.bands.buyer': 500000, 'authority.bands.lead': 2000000 } }),
    unconfigured: handle.check({ view: 'contractor', role: 'agent', amount: 1,
      config: { 'authority.unit': 'cents', 'authority.bands.buyer': null } }),
    meta: handle.meta(),
  }),
}
