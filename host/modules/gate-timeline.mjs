/**
 * 进树模块：`gate-timeline` —— **「审批等多久 / 变更单到底是谁卡着」**（domain 插件）。
 *
 * 正面回答两条 human problem（原始出处：`docs/work/plans/ux-双方痛点与交互需求.md.txt`）：
 *   （a）**审批人等不到**（P-02/P-03：批准动作结构性不在 GUI、队列积压、"等审批"成为最大延迟）：
 *       每个**还在等**的人工门给出 —— 挂了多久（`age_seconds`）、**口径**（`age_basis`）、
 *       卡在谁手里（`owner`）、再等下去会发生什么（`consequence`）、`next_action`（可复制的终端命令 +
 *       催办请求路由）；
 *   （b）**变更单扯皮**（P-14：页面上只有一行 `delta_amount`、对账靠回忆）：每张变更单现在什么状态
 *       （`state`）、**谁欠谁一个动作**（`owed_by`）、从哪个**账本事件**起就在等（`waiting_since`）、
 *       以 `basis`（账本事件/计数引用）为凭；**再加规则 ⑤**：`change_detail` **逐行明细**
 *       （原量×原价 → 新量×新价 → 差额；金额一律**整数分**、缺依据的行**列入 `basis_missing` 并排除出小计**）。
 *
 * 分工（不重复造轮子，与 `advice-panel` 同一套纪律）：
 *   · Python 侧服务（`services/approval.py` 的人工门与超时策略、`services/change.py` 的变更状态机）
 *     是**判定**与**事实**的唯一真源；
 *   · `host/modules/webui.mjs` 只把**本视角自己的行**过滤成下面这份**白名单载荷**（带私域键的行整行
 *     跳过并报数）—— 投影规则的真源在 `host/modules/projection.mjs`；
 *   · 本插件**不改判定、不读账本、不写任何东西、不联网、不调模型、不取墙钟** —— 只对调用方给的
 *     结构化载荷做一次确定性的规则派生（不 import `fs`：静态扫描断言看着）。
 *
 * 【纪律一：**本插件永远不能批准任何东西**】
 *   人工门的专有动作（批准 / 提交报价 / 定标 / 发 PO / 变更批准 / 签收）只走交互式 Python CLI 且只能由
 *   `human:*` 产生（ADR-0013 §3、INV-005、P8）。本插件的服务面里**没有** `approve` / `decide` /
 *   `grant` / `submit` / `ack` 这类方法，也不许有（门 `t282` 逐条断言）。它只能做两件事：
 *   **告知**（等待时长 / 卡点 / 后果 / 下一步）与**转交催办**（`nudge()` 只产一条"催办请求"的载荷形状，
 *   由宿主落成 0600 待办件、再由 Python 侧唯一落账本者落 `gate/nudged`；催办**不改门的判定状态**）。
 *
 * 【纪律二：`age` 的口径 —— **绝不取墙钟**】
 *   `age_seconds = as_of − 该门 approval/requested 事件的 ts`，其中 `as_of` = 本视角投影里
 *   **最大的事件 `ts`**（系统已知的最新**事实**时刻，由调用方从账本事实派生）。
 *   因此**同一份快照在任何"当前时间"下输出逐字节一致**：载荷里给 `now`、配置里给 `now` 都
 *   **读都不读**（输出里的 `ignored_now_inputs` / `age_clock:"facts-only"` 把这件事变成可机检的事实，
 *   页面照抄 `age_basis_note`）。为什么必须这样：墙钟会让"等了多久"随刷新漂移 —— 两个人看同一份事实
 *   会得到两个数字（不确定性），而"审批人等不到"这个痛点的答案必须是可复算的。
 *
 * 规则（四条，各自可解释、可复算；常量都在本文件里，改口径就改这里 + 门 `host/t282-gate-timeline-gate.mjs`）：
 *   ① `waiting` 还在等的人工门：按 `approval_id` 取最后一条 `approval/*`；**已决**（granted/denied/aborted）
 *      的不算待办门；每条给 age / 口径 / owner / consequence / next_action；
 *   ② `policy`  后果与超时策略绑定：`remind`（只会再提醒）/`escalate`（转人类上级继续等）/`abort`
 *      （作废本次意图，需重新发起）—— 三种策略都**不存在**"超时自动批准"；
 *   ③ `change`  变更单时间线：按 `change_id` 归并 `change/*` 事件 → 状态 + 从哪个事件起在等 + 谁欠动作；
 *   ④ `link`    变更单与人工门的**关联**：`change/priced` 之后欠的动作就是人工门 `change.approve`
 *      （ref = change_id）—— 有对应门就用队列里的真审批人，没有就如实说 `unassigned`（不编人名）；
 *   ⑤ `detail`  变更单的**逐行明细**（`change_detail`）：每行给 `line_id/desc/qty_before/unit_price_before/
 *      amount_before/qty_after/unit_price_after/amount_after/delta_amount/delta_pct/basis`，
 *      并给出行小计与总计差额 —— **金额一律整数分、不出现浮点**；缺原量/原价/新量/新价的行走
 *      `basis_missing` 且**不计入小计**；整张单一行可用都没有 ⇒ `degraded` + `no-usable-lines` + 明细为空 +
 *      小计记 `null`（不编 0 冒充「没变」）；私域列只有 `PRIVATE_COLUMN_VIEWS` 里的视角看得见（其余读都不读）。
 */
import { createHash } from 'node:crypto'
import { constant, number, object, string } from '../lib/std-schema.mjs'

export const name = 'gate-timeline'

export const inject = []                 // 纯函数插件：载荷由调用方给（宿主只读投影/快照）
export const builtin = []                // 本模块不使用事件：声明即事实（D-015 / A1 双向断言）
export const usedServices = []
export const provides = ['gateTimeline']

/** 引擎自述：`rules` = **确定性规则**（不是模型、不是推测）。 */
export const ENGINE = 'rules'

/** 页面上必须原样出现的一句话（诚实分层 + "不能代签"一起说清）。 */
export const ENGINE_NOTE = '本页由确定性规则从投影/快照派生（只看事实时间戳之差），'
  + '不含模型推测、不取墙钟、不能代替你签字'

/** 时间口径的**机读名字**（页面文案与门都引用这一处真源）。 */
export const AGE_CLOCK = 'facts-only'

/** 时间口径的**人话**（页面照抄；写清"不随你刷新的时间变"）。 */
export const AGE_BASIS_NOTE = 'age_seconds = as_of − 该门 approval/requested 事件的事实 ts'
  + '（as_of = 本视角投影里最大的事件 ts，即系统已知的最新事实时刻）'
  + ' —— 本页不取墙钟：同一份快照在任何时刻打开，等待时长都一样'

/** 载荷里被读的段（白名单；门断言"输出只可能来自这几段"）。 */
export const SECTIONS = ['approvals', 'changes']

/** 墙钟入口（**存在但被忽略**：写进输出只为让"我没读它"成为可机检的事实）。 */
export const IGNORED_NOW_INPUTS = ['payload.now', 'config.now']

/** 已决的人工门事件（这三个之后就不再是"还在等"）。 */
export const RESOLVED_APPROVAL_EVENTS = ['approval/granted', 'approval/denied', 'approval/aborted']

/** 超时策略三选一（`services/approval.py` 的 TIMEOUT_POLICIES）—— **没有"自动批准"这一项**（05 §6）。 */
export const TIMEOUT_POLICIES = ['remind', 'escalate', 'abort']

/** 超时策略 → 再等下去会发生什么（逐条来自 05-events.md §3 与 `services/approval.py` 的实现）。 */
export const POLICY_EFFECTS = {
  remind: '只会**再提醒**一次待签人（approval/reminded）：状态不变、仍等待人类决定 —— 永不自动批准',
  escalate: '会**转给人类上级**继续等待（approval/escalated）：仍然不批准，只是换个人等',
  abort: '本次意图会被**作废**（approval/aborted，需重新发起）：作废既不是批准也不是拒绝',
}
export const POLICY_UNKNOWN = '未知超时策略：按"绝不自动批准"处理（不猜它会做什么）'

/** commit 面（永不给浏览器的动作）：这些 scope 的门在页面上标成"只能人签"。 */
export const COMMIT_SCOPES = ['quote.submit', 'award.commit', 'po.issue', 'change.approve']

/**
 * 人工门 → **真实可复制的终端命令**（逐条来自 `docs/work/deployment-manual.md` §2 与
 * `src/quotagent/g1side.py` 顶部的阶段表；门 `t282` 断言这些路径在仓库里真的存在）。
 * 阶段表：contractor 4 = 承诺（人工签署）+ 变更批准生效 + 审计包；supplier 2 = 报价；supplier 3 = 确认 + 提出变更。
 */
export const GATE_COMMANDS = {
  'quote.submit': 'PYTHONPATH=src python3 -m quotagent.g1side supplier tmp/manual 2   # 报价提交（过人工门，人工签署）',
  'award.commit': 'PYTHONPATH=src python3 -m quotagent.g1side contractor tmp/manual 4   # 授标承诺（人工签署）',
  'po.issue': 'PYTHONPATH=src python3 -m quotagent.g1side contractor tmp/manual 4   # 发 PO（人工签署）',
  'change.approve': 'PYTHONPATH=src python3 -m quotagent.g1side contractor tmp/manual 4   # 变更批准生效（人工签署）',
}
export const GATE_COMMAND_FALLBACK = 'python3 tools/g1-walkthrough.py   # 双人流程走查（人工门只在终端；'
  + '单侧分阶段：PYTHONPATH=src python3 -m quotagent.g1side <side> <dir> <阶段>）'

/** 变更单各状态的下一步（同样是真命令 / 真 AC，不是空话）。 */
export const CHANGE_COMMANDS = {
  proposed: 'PYTHONPATH=src python3 -m quotagent.g1side supplier tmp/manual 3   # 提出变更请求（同阶段落 change/proposed + change/priced）',
  priced: 'PYTHONPATH=src python3 -m quotagent.g1side contractor tmp/manual 4   # 变更批准生效（人工签署；未批准前不影响任何金额）',
  rejected: 'PYTHONPATH=src python3 -m quotagent.g1side supplier tmp/manual 3   # 补齐 basis_unit_price_ref 后重新发起（引用必须指向原报价条目的 unit_price）',
  approved: 'tools/verify.sh ac AC-CHANGE-002   # 已生效（计入金额）：对账走这条 AC（逐行按原报价单价复算）',
  unknown: GATE_COMMAND_FALLBACK,
}

/** 变更单状态的**排序权重**（欠动作的先看：等签 > 等定价 > 待补引用 > 已结 > 认不出）。 */
export const CHANGE_STATE_RANK = { priced: 0, proposed: 1, rejected: 2, approved: 3, unknown: 4 }
export const CHANGE_STATES = ['proposed', 'priced', 'approved', 'rejected', 'unknown']

/** 降级原因的**闭合集合**（门据此断言"降级是有名的，不是含糊的"）。 */
export const DEGRADED_REASONS = ['payload-not-an-object', 'no-usable-inputs', 'no-signal']

/** 催办请求被拒的**有名 code 闭合集合**（宿主据此定状态码，页面据此给 next_action）。 */
export const NUDGE_CODES = ['accepted', 'view-unknown', 'gate-not-found', 'empty-reason',
  'reason-too-long', 'payload-unusable']

/** 催办请求里唯一被允许的动作名（本插件**不存在**其它动作）。 */
export const NUDGE_ACTION = 'nudge'

/** 待办件（宿主落盘的那一条）的 kind / schema（Python 侧 `tools/gate-nudge.py` 认这两个值）。 */
export const NUDGE_KIND = 'gate-nudge'
export const NUDGE_SCHEMA = 1

// ---------------------------------------------------------------------------
// 变更单**逐行明细**的口径常量（规则 ⑤；改口径就改这里 + 门 `host/t283-change-detail-gate.mjs`）
// ---------------------------------------------------------------------------
/** 金额口径的**机读名字**（JSON、页面文案与门都引用这一处真源）。 */
export const MONEY_UNIT = 'cents'

/** 舍入口径的**机读名字**（`half-up-to-cent` = 到分位、负值**远离零**）。 */
export const ROUNDING = 'half-up-to-cent'

/** 金额口径的**人话**（页面照抄；把"钱怎么算的"写清，对账才有意义）。 */
export const MONEY_NOTE = '金额一律用**整数分**参与运算（money_unit=cents）：`amount = qty(整数件) × unit_price(整数分)`、'
  + '`delta_amount = amount_after − amount_before` —— 全程整数，不出现浮点；唯一的除法在 `delta_pct`：'
  + '`round_half_up(delta_amount × 10000 ÷ amount_before)` 取到分位（0.01%，负值按**远离零**舍入，'
  + 'rounding=half-up-to-cent 指的就是这一处），分母为 0 时记 `null`（不猜、不编无穷大）；'
  + '**入参必须是整数分与整数件**：把账本里的小数金额折算到分位由调用方的载荷装配做'
  + '（口径同样是 half-up，见 `host/modules/webui.mjs` 的 centsOf），本插件对非整数分/非整数件'
  + '一律按**缺依据**处理，**不做四舍五入**'

/** 逐行明细的键集（**恰 11 键**；门逐字段断言，顺序即键集本身）。 */
export const DETAIL_KEYS = ['line_id', 'desc', 'qty_before', 'unit_price_before', 'amount_before',
  'qty_after', 'unit_price_after', 'amount_after', 'delta_amount', 'delta_pct', 'basis']

/** 逐行明细的降级原因**闭合集合**（与 `DEGRADED_REASONS` 分开：那是"谁在等"，这是"明细"）。 */
export const DETAIL_REASONS = ['payload-not-an-object', 'change-not-found', 'no-usable-lines']

/** **看得见自己私域列**的视角（变更单的业主侧）；其余视角对私域列**读都不读**。 */
export const PRIVATE_COLUMN_VIEWS = ['contractor']

/** 私域列名的形状（含 `private` 字样的键也算）—— 与 `host/modules/projection.mjs` 同一套直觉。 */
export const PRIVATE_KEY_MARKS = ['cost_floor', 'markup_pct', 'reserve_price', 'cost_model']

/** 私域列的**人话**（页面照抄；**不写键名**：键名只在业主侧自己的列里出现，别的视角的输出里一个字都不许有）。 */
export const PRIVATE_COLUMNS_NOTE = '私域列白名单：只有业主侧（' + PRIVATE_COLUMN_VIEWS.join('/')
  + '）看得见**自己的**私域列（成本/加价/底价/内部备注这类键）；其余视角**读都不读** —— '
  + '带私域列与不带私域列的载荷输出**逐字节一致**（不是「藏起来」，是根本没读）'

export const Config = object({
  max_items: number().default(20),          // 每个列表各自的条数上限（夹取区间 [1, 200]）
  route_prefix: string().default('/quotagent'),
  now: string().default(''),                // 墙钟观测量：**读都不读**（见文件头的 age 口径）
  deterministic: constant(true),            // const 键：不得翻转（A3 负控）
})

/** 建议条数上限的夹取区间与回落值（非有限数 → 默认；越界 → 夹取）。 */
const ITEM_FLOOR = 1
const ITEM_CEILING = 200
const ITEM_FALLBACK = 20
/** 文本字段的字符上限（回显回来的任意字节必须有界）。 */
const TEXT_MAX = 240
/** 标识符的长度上限（`approval_id` / `change_id`）。 */
const ID_LIMIT = 64
/** 每段最多读入的条目数（有界：调用方给一堆也不把响应撑大）。 */
const SECTION_MAX = 64
/** 催办理由的**字节**上界（与宿主落盘形状同口径：超出即拒，不截断成另一份理由）。 */
const REASON_MAX_BYTES = 2048
/** 单张变更单最多读入的行数（有界：调用方给 1000 行也不把响应撑大；超出照实报 `lines_not_read`）。 */
const DETAIL_LINE_MAX = 64
/** 每行最多回显的私域列数（有界：业主侧也不许把响应撑大）与单个值的字符上限。 */
const PRIVATE_COL_MAX = 4
const PRIVATE_VALUE_MAX = 80

const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** 只有有限数字才算一个值；NaN / ±Infinity / 字符串数字一律按"取不到"处理（不解析、不猜）。 */
const numOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/** 人话串：清掉控制字符、去空白、截断（**有界**）；空串按取不到处理。 */
const textOrNull = (value, maxChars = TEXT_MAX) => {
  if (typeof value !== 'string') return null
  const stripped = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  if (stripped === '') return null
  return stripped.length > maxChars ? stripped.slice(0, maxChars) : stripped
}

/**
 * 时刻的**纯解析**（字符串 + 整数运算；**不取墙钟、不用 `Date`**）：
 * 只认 `YYYY-MM-DD`、`YYYY-MM-DDTHH:MM[:SS[.ms]]Z`（大小写不敏感、允许空格分隔）。认不出 → null。
 */
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?Z$/
export const isoMs = (value) => {
  const text = textOrNull(value, 40)
  if (text === null) return null
  const parts = ISO_RE.exec(text.toUpperCase())
  if (!parts) return null
  const year = Number(parts[1])
  const month = Number(parts[2])
  const day = Number(parts[3])
  const hour = Number(parts[4] ?? '0')
  const minute = Number(parts[5] ?? '0')
  const second = Number(parts[6] ?? '0')
  const milli = Number((parts[7] ?? '0').padEnd(3, '0'))
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  if (hour > 23 || minute > 59 || second > 59) return null
  // days_from_civil（Howard Hinnant）：纯整数运算，无时区数据库、无墙钟
  const shifted = month <= 2 ? year - 1 : year
  const era = Math.floor(shifted / 400)
  const yoe = shifted - era * 400
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  const days = era * 146097 + doe - 719468
  return ((days * 24 + hour) * 60 + minute) * 60000 + second * 1000 + milli
}

/** 毫秒 → 固定 3 位小数（`-0` 归一成 0，避免混进 JSON）；不做时区/格式化。 */
const round3 = (value) => {
  const rounded = Math.round(value * 1000) / 1000
  return rounded === 0 ? 0 : rounded
}

/** 显式字典序比较器（排序不依赖默认比较的隐含规则，也不受 locale 影响）。 */
const byLex = (left, right) => (left < right ? -1 : (left > right ? 1 : 0))

/**
 * `candidate` 是否比 `current` 更"后"（**口径确定性**：先比事实 `ts`，同刻或认不出 ts 时按事件类型字典序）——
 * 与调用方给的条目顺序无关，所以"打乱顺序/逆序输入"必然给同一个答案（t282 第 16 条看着）。
 */
const laterRow = (candidate, current) => {
  if (current === null) return true
  const left = isoMs(candidate.ts)
  const right = isoMs(current.ts)
  if (left !== null && right !== null) return left === right ? byLex(candidate.type, current.type) > 0 : left > right
  if (left !== null) return true
  if (right !== null) return false
  return byLex(candidate.type, current.type) > 0
}

/** `candidate` 是否比 `current` 更"早"（同上：先 ts，再类型字典序）。 */
const earlierRow = (candidate, current) => {
  if (current === null) return true
  const left = isoMs(candidate.ts)
  const right = isoMs(current.ts)
  if (left !== null && right !== null) return left === right ? byLex(candidate.type, current.type) < 0 : left < right
  if (left !== null) return true
  if (right !== null) return false
  return byLex(candidate.type, current.type) < 0
}

const clampLimit = (value) => {
  const amount = numOrNull(value)
  if (amount === null) return ITEM_FALLBACK
  return Math.min(ITEM_CEILING, Math.max(ITEM_FLOOR, Math.floor(amount)))
}

const resolvedOptions = (config) => {
  const cfg = isPlain(config) ? config : {}
  return Object.freeze({
    max_items: clampLimit(cfg.max_items),
    route_prefix: (textOrNull(cfg.route_prefix, 128) ?? '/quotagent').replace(/\/$/, ''),
    // **读进来只为"证明它没被用于计算"**：任何把它掺进 age 的做法都会被门抓红（t282 变异 1）
    now: textOrNull(cfg.now, 40),
  })
}

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

// ---------------------------------------------------------------------------
// 载荷读取（白名单键；条目上多出来的键**读都不读**）
// ---------------------------------------------------------------------------
const readApprovals = (raw) => {
  const rows = []
  const skipped = { shape: 0, incomplete: 0, over: 0 }
  if (raw === undefined || raw === null) return { rows, skipped, present: false }
  if (!Array.isArray(raw)) return { rows, skipped: { ...skipped, shape: 1 }, present: true }
  if (raw.length > SECTION_MAX) skipped.over = raw.length - SECTION_MAX
  for (const entry of raw.slice(0, SECTION_MAX)) {
    if (!isPlain(entry)) { skipped.shape += 1; continue }
    const id = textOrNull(entry.approval_id, ID_LIMIT)
    const type = textOrNull(entry.type, 64)
    if (id === null || type === null) { skipped.incomplete += 1; continue }
    const approvers = Array.isArray(entry.approvers)
      ? entry.approvers.slice(0, 8).map((item) => textOrNull(item, 64)).filter((item) => item !== null) : []
    rows.push({
      approval_id: id, type, ts: textOrNull(entry.ts, 40),
      scope: textOrNull(entry.scope, 64) ?? '', ref: textOrNull(entry.ref, 80) ?? '',
      summary: textOrNull(entry.summary, TEXT_MAX) ?? '',
      approvers, escalate_to: textOrNull(entry.escalate_to, 64),
      timeout_policy: textOrNull(entry.timeout_policy, 16),
      timeout_s: numOrNull(entry.timeout_s),
    })
  }
  return { rows, skipped, present: true }
}

const readChanges = (raw) => {
  const rows = []
  const skipped = { shape: 0, incomplete: 0, over: 0 }
  if (raw === undefined || raw === null) return { rows, skipped, present: false }
  if (!Array.isArray(raw)) return { rows, skipped: { ...skipped, shape: 1 }, present: true }
  if (raw.length > SECTION_MAX) skipped.over = raw.length - SECTION_MAX
  for (const entry of raw.slice(0, SECTION_MAX)) {
    if (!isPlain(entry)) { skipped.shape += 1; continue }
    const id = textOrNull(entry.change_id, ID_LIMIT)
    const type = textOrNull(entry.type, 64)
    if (id === null || type === null) { skipped.incomplete += 1; continue }
    const single = textOrNull(entry.basis_unit_price_ref, 96)
    const refs = Array.isArray(entry.basis_unit_price_refs)
      ? entry.basis_unit_price_refs.slice(0, 8).map((item) => textOrNull(item, 96)).filter((item) => item !== null)
      : (single === null ? [] : [single])
    rows.push({
      change_id: id, type, ts: textOrNull(entry.ts, 40),
      quote_id: textOrNull(entry.quote_id, 64) ?? '',
      delta_amount: numOrNull(entry.delta_amount),
      basis_refs: refs,
      approved_by: textOrNull(entry.approved_by, 64),
      approval_id: textOrNull(entry.approval_id, 64),
      code: textOrNull(entry.code, 64),
    })
  }
  return { rows, skipped, present: true }
}

// ---------------------------------------------------------------------------
// 派生：人工门（① + ② + ④）
// ---------------------------------------------------------------------------
/** 一条待办门的**后果**：把超时策略 + 阈值翻译成"再等下去会发生什么"。 */
const consequenceOf = (row, ageSeconds) => {
  const policy = row.timeout_policy
  const effect = policy === null ? '（未声明 timeout_policy：无法说明超时行为）'
    : (POLICY_EFFECTS[policy] ?? `${POLICY_UNKNOWN}"${policy}"`)
  const known = policy !== null && POLICY_EFFECTS[policy] !== undefined
  if (!known || row.timeout_s === null) {
    const threshold = row.timeout_s === null ? '超时阈值未声明（不猜）' : `超时阈值 ${row.timeout_s} 秒`
    return `${threshold}，已等 ${ageSeconds} 秒；再等下去：${effect}`
  }
  const remaining = round3(row.timeout_s - ageSeconds)
  if (remaining <= 0) {
    return `已超过超时阈值（等了 ${ageSeconds} 秒 ≥ 阈值 ${row.timeout_s} 秒）：再等下去${effect}`
  }
  return `再等约 ${remaining} 秒（阈值 ${row.timeout_s} 秒）就触发策略「${policy}」：${effect}`
}

/** 卡在谁手里（`owner`）：队列里的真审批人；没有就如实说 `unassigned`（不编一个人名）。 */
const ownerOf = (row) => {
  if (row.approvers.length > 0) return row.approvers.join('+')
  if (row.escalate_to !== null) return `${row.escalate_to}（escalate_to）`
  return 'unassigned'
}

/** 队列里的名字 → `human:` 形状（已经是就不再加前缀，免得出现 `human:human:x`）。 */
const humanOf = (row) => {
  const who = ownerOf(row)
  if (who === 'unassigned') return 'human:unassigned'
  return who.startsWith('human:') ? who : `human:${who}`
}

/** 返回 `{ items, byPolicy }`：`byPolicy` 是**生成口径**的策略分布（items 上不许多带键）。 */
const gateRows = (approvals, asOfMs, asOf, options, view, notes) => {
  const order = []
  const state = new Map()
  for (const row of approvals) {
    if (!state.has(row.approval_id)) {
      state.set(row.approval_id, { requested: null, decidedMs: null, decidedEvent: '', count: 0 })
      order.push(row.approval_id)
    }
    const entry = state.get(row.approval_id)
    entry.count += 1
    // "等待起点" = **最后一条** approval/requested（重开的门重新计时）；决定时刻取已决事件里最晚的那个。
    // 两处都只比事实 ts（并列时同级比较相等 ⇒ 先出现的胜出，与入参顺序无关 ⇒ 确定性）。
    if (row.type === 'approval/requested' && laterRow(row, entry.requested)) entry.requested = row
    if (RESOLVED_APPROVAL_EVENTS.includes(row.type)) {
      const when = isoMs(row.ts)
      if (when !== null && (entry.decidedMs === null || when >= entry.decidedMs)) {
        entry.decidedMs = when
        entry.decidedEvent = row.type
      }
    }
  }
  const items = []
  const byPolicy = {}
  for (const policy of [...TIMEOUT_POLICIES, 'unknown']) byPolicy[policy] = 0
  for (const id of order) {
    const entry = state.get(id)
    if (entry.requested === null) {
      // 没有任何 requested 行：要么只有已决事件（不是"还在等"），要么数据不全 —— 两种都**不猜**
      if (entry.decidedMs === null) {
        notes.push(`approvals[${id}] 没有可解析的 approval/requested 事实行 → 不进等待列表（不猜它从什么时候开始等）`)
      }
      continue
    }
    const requestedMs = isoMs(entry.requested.ts)
    if (requestedMs === null) {
      notes.push(`approvals[${id}].requested_ts 不是可解析的时刻 → 不给等待时长（不猜时钟）`)
      continue
    }
    /**
     * **已决的判据（与账本语义对齐）**：最后一次请求之后（**含同一时刻**）出现过 granted/denied/aborted
     * ⇒ 这个门已经不在等。为什么含"同一时刻"：真实账本里请求与决定可能落在**同一秒**
     * （实测：演示账本的 ap-0001 请求与 granted 同为 21:06:37Z），此时"决定"是终态、也是账本里后追加的那条；
     * 若拿事件类型字典序当并列裁决，`approval/requested` 会被误判成"还在等" ⇒ 页面说"待批"、Python 侧说
     * "已决"，同一件事两个口径（本仓 D-055/D-056 明令禁止）。"终态优先"既与账本追加序一致，
     * 又与入参顺序无关（确定性）。
     */
    if (entry.decidedMs !== null && entry.decidedMs >= requestedMs) continue
    if (asOfMs === null) {
      notes.push(`approvals[${id}] 待办，但投影里没有可用的 as_of（事实时刻）→ 不给等待时长（不猜时钟）`)
      continue
    }
    const ageSeconds = round3((asOfMs - requestedMs) / 1000)
    const last = entry.requested
    const scope = last.scope === '' ? '(未声明 scope)' : last.scope
    const commit = COMMIT_SCOPES.includes(last.scope)
    const ref = last.ref === '' ? '(无 ref)' : last.ref
    byPolicy[last.timeout_policy === null || POLICY_EFFECTS[last.timeout_policy] === undefined ? 'unknown'
      : last.timeout_policy] += 1
    items.push({
      id,
      kind: scope,
      subject: `${ref} — ${last.summary === '' ? '(队列里没有摘要)' : last.summary}`,
      owner: ownerOf(last),
      age_seconds: ageSeconds,
      age_basis: `${AGE_BASIS_NOTE}（本次 as_of=${asOf}，该门最后一次 requested=${entry.requested.ts}，`
        + `approvals[${id}] 共 ${entry.count} 条 approval/* 事件）`,
      consequence: consequenceOf(last, ageSeconds),
      next_action: `${GATE_COMMANDS[last.scope] ?? GATE_COMMAND_FALLBACK}\n`
        + `催办（宿主只落 0600 待办件、账本零新增）：POST ${options.route_prefix}/${view}/gates/nudge`
        + ` -d id=${id} -d reason=<你的理由>`,
      blocked_by: `${commit ? 'commit 面不暴露给浏览器（ADR-0013 §3 / INV-005）：批准只能由 human:* 在**终端**完成。'
        : '等待人类决定。'}` + '本页只告知与转交催办请求，**永远不能代签/批准/提交**',
    })
  }
  return { items, byPolicy }
}

// ---------------------------------------------------------------------------
// 派生：变更单（③ + ④）
// ---------------------------------------------------------------------------
const STATE_OF_EVENT = {
  'change/approved': 'approved',
  'change/rejected': 'rejected',
  'change/priced': 'priced',
  'change/proposed': 'proposed',
}

const changeRows = (changes, approvals, options, view, notes) => {
  const order = []
  const grouped = new Map()
  for (const row of changes) {
    if (!grouped.has(row.change_id)) { grouped.set(row.change_id, []); order.push(row.change_id) }
    grouped.get(row.change_id).push(row)
  }
  /** `change.approve` 人工门里"欠谁签"：ref 与 change_id 对上就用队列里的真审批人（④）。 */
  const gateOf = (changeId) => {
    let found = null
    for (const entry of approvals) {
      if (entry.type === 'approval/requested' && entry.scope === 'change.approve' && entry.ref === changeId) found = entry
    }
    return found
  }
  const items = []
  for (const id of order) {
    const rows = grouped.get(id)
    // "当前状态"按最后一条（ts + 类型字典序）取：与入参顺序无关（确定性）
    const last = rows.reduce((acc, row) => (laterRow(row, acc) ? row : acc), null)
    let state = STATE_OF_EVENT[last.type] ?? 'unknown'
    if (state !== 'rejected' && rows.some((row) => row.type === 'change/rejected')) state = 'rejected'
    if (state === 'unknown') {
      notes.push(`changes[${id}] 最后一条事件类型 ${last.type} 不在变更状态机里 → 状态记 unknown（不猜）`)
    }
    const gate = state === 'priced' ? gateOf(id) : null
    if (state === 'priced' && gate === null) {
      notes.push(`changes[${id}] 已定价但没有对应的 change.approve 人工门 → 欠谁签如实记 unassigned（不编人名）`)
    }
    const basis = [`changes[${id}].type`, `changes[${id}].ts`, `events[${last.type}].count`]
    if (gate !== null) basis.push(`approvals[${gate.approval_id}].ts`)
    const owedBy = state === 'priced' ? (gate === null ? 'human:unassigned' : humanOf(gate))
      : state === 'proposed' ? 'contractor-agent'
        : state === 'rejected' ? 'proposer' : 'none'
    const delta = last.delta_amount === null ? '' : `；对账依据：差额 ${last.delta_amount}（按原报价单价基准复算）`
    const link = state === 'priced'
      ? `（对应人工门 ${gate === null ? '尚未登记（不猜）' : gate.approval_id}：批准只能在终端由 human:* 完成）`
      : ''
    items.push({
      id,
      state,
      owed_by: owedBy,
      waiting_since: last.ts ?? '(该条事件没有可解析的 ts)',
      basis,
      next_action: `${CHANGE_COMMANDS[state] ?? GATE_COMMAND_FALLBACK}${link}${delta}\n`
        + `催办/转交（只落待办件，账本零新增）：POST ${options.route_prefix}/${view}/gates/nudge`,
    })
  }
  return items
}

// ---------------------------------------------------------------------------
// 派生：**变更单逐行明细**（规则 ⑤ —— 正面回答「变更单到底改了什么、多花多少钱」P-14）
//   口径（全部写进输出，逐条可复算；常量都在本文件里）：
//     · 只从调用方给的**投影/快照载荷**派生（不读任何存储、不联网、不调模型、不取墙钟）；
//     · `money_unit = "cents"`：金额一律**整数分**（`amount = qty × unit_price`、`delta = after − before`）；
//     · `rounding = "half-up-to-cent"`：唯一的除法在 `delta_pct`（分位、负值远离零；分母 0 记 null）；
//     · **缺依据不得编数**：某行缺原量/原价/新量/新价（或值不是整数分/整数件）⇒ 列入 `basis_missing`
//       并**排除出小计**；整张单一行可用都没有 ⇒ `degraded` + `no-usable-lines` + 明细为空 + 小计记 null；
//     · 私域白名单：`PRIVATE_COLUMN_VIEWS` 里的视角照实回显自己的私域列，其余视角**读都不读**。
// ---------------------------------------------------------------------------
/** 一行的**四个事实**（缺任何一个都不是"编一个默认值"能补的）。 */
const DETAIL_FACTS = ['qty_before', 'unit_price_before', 'qty_after', 'unit_price_after']

/**
 * 整数解析（**只认整数**）：JSON 整数或十进制整数字面量（`-0` 归一成 0）。
 * 浮点 / 小数字符串 / 科学计数 / 空白 / 布尔 → `null` = "取不到" —— 按**缺依据**处理，
 * **不四舍五入**（对账最怕的就是"悄悄帮你圆了一下"）。
 */
const intOrNull = (value) => {
  if (typeof value === 'number') return Number.isInteger(value) ? (value === 0 ? 0 : value) : null
  if (typeof value === 'string') {
    const text = value.trim()
    if (!/^-?\d+$/.test(text)) return null
    const parsed = Number(text)
    return parsed === 0 ? 0 : parsed
  }
  return null
}

/** 分位 **half-up**（远离零）：`round_half_up(num / denominator)`，全程整数运算（denominator > 0）。 */
const halfUpDiv = (numerator, denominator) => {
  const sign = numerator < 0 ? -1 : 1
  const magnitude = numerator < 0 ? -numerator : numerator
  return sign * Math.floor((2 * magnitude + denominator) / (2 * denominator))
}

/** 一个键是不是私域列名（含 `private` 字样的一律算）。 */
const isPrivateKey = (key) => PRIVATE_KEY_MARKS.includes(String(key).toLowerCase())
  || String(key).toLowerCase().includes('private')

/** 私域列的值（业主侧自己的东西）：标量原样、其余转成**有界**文本；不出未定义。 */
const privateValue = (value) => {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') return textOrNull(value, PRIVATE_VALUE_MAX) ?? ''
  const text = JSON.stringify(value)
  return text === undefined ? '' : (textOrNull(text, PRIVATE_VALUE_MAX) ?? '')
}

/** 读入 `change.lines`（**有界**：最多 `DETAIL_LINE_MAX` 条；形状不对的整条跳过并报数）。 */
const readDetailLines = (raw) => {
  const rows = []
  const skipped = { shape: 0, over: 0 }
  if (raw === undefined || raw === null) return { rows, skipped, present: false }
  if (!Array.isArray(raw)) return { rows, skipped: { ...skipped, shape: 1 }, present: true }
  if (raw.length > DETAIL_LINE_MAX) skipped.over = raw.length - DETAIL_LINE_MAX
  for (const entry of raw.slice(0, DETAIL_LINE_MAX)) {
    if (!isPlain(entry)) { skipped.shape += 1; continue }
    rows.push(entry)
  }
  return { rows, skipped, present: true }
}

const EMPTY_DETAIL_COUNTS = () => ({ lines_found: 0, lines_read: 0, lines_shown: 0, lines_usable: 0,
  lines_excluded: 0, lines_not_read: 0, basis_missing: 0, duplicates: 0, omitted: 0, private_columns: 0 })

/** 逐行明细的输出形状（键集固定；`counts`/`subtotal` 同口径）。 */
const detailShape = (view, asOf, changeId, options, extra) => ({
  source: 'gate-timeline',
  engine: ENGINE,
  engine_note: ENGINE_NOTE,
  view,
  as_of: asOf,
  change_id: changeId,
  money_unit: MONEY_UNIT,
  rounding: ROUNDING,
  money_note: MONEY_NOTE,
  line_keys: [...DETAIL_KEYS],
  lines: extra.lines,
  basis_missing: extra.basis_missing,
  subtotal: extra.subtotal,
  private_columns: extra.private_columns,
  private_columns_note: PRIVATE_COLUMNS_NOTE,
  counts: extra.counts,
  bounds: { max_items: options.max_items, lines_max: DETAIL_LINE_MAX, private_columns_max: PRIVATE_COL_MAX },
  truncated: extra.counts.omitted > 0,
  omitted: extra.counts.omitted,
  degraded: extra.reason === null ? false : true,
  reason: extra.reason,
  next_action: extra.next_action,
  ignored_now_inputs: [...IGNORED_NOW_INPUTS],
  // 说明行的顺序也必须**确定性**（同一份事实在条目逆序输入下逐字节一致）：按字典序排
  notes: [...extra.notes].sort(byLex),
  privacy: { private_keys_read: extra.private_keys_read, model_calls: 0, network_calls: 0, clock_reads: 0 },
})

/**
 * 纯函数：把**本视角的一张变更单**派生成逐行可核对的明细。
 * 输入形状（调用方按白名单装配；多余的键**读都不读**）：
 *   `{ view, as_of, change: { change_id, quote_id, ts, lines: [{ line_id, desc,
 *      qty_before, unit_price_before, qty_after, unit_price_after }] } }`；`change: null` = 本视角没有这张单。
 */
export const changeDetailOf = (payload, config) => {
  const options = resolvedOptions(config)
  const blank = {
    lines: [], basis_missing: [], private_columns: [],
    subtotal: { lines: 0, amount_before: null, amount_after: null, delta_amount: null, delta_pct: null },
    counts: EMPTY_DETAIL_COUNTS(), notes: [], private_keys_read: false,
  }
  if (!isPlain(payload)) {
    return detailShape('', null, '', options, { ...blank, reason: 'payload-not-an-object',
      next_action: '先让宿主把本视角的变更单载荷交给插件（没有事实就没有明细：既不猜、也不编行）' })
  }
  const view = textOrNull(payload.view, 32) ?? ''
  const asOf = textOrNull(payload.as_of, 40)
  const change = isPlain(payload.change) ? payload.change : null
  if (change === null) {
    return detailShape(view, asOf, textOrNull(payload.change_id, ID_LIMIT) ?? '', options, { ...blank,
      reason: 'change-not-found',
      next_action: `本视角投影里没有这张变更单：看 ${options.route_prefix}/${view}/gates/ 的变更单列表`
        + '（每行都有逐行明细链接）拿到**真 id** 再打开 —— 本页不猜 id、也不编行' })
  }
  const changeId = textOrNull(change.change_id, ID_LIMIT) ?? ''
  const quoteId = textOrNull(change.quote_id, 64)
  const owner = PRIVATE_COLUMN_VIEWS.includes(view)
  const notes = []
  const read = readDetailLines(change.lines)
  if (read.present === false) notes.push('change.lines 段缺失（调用方没给这一行清单）→ 按空读处理：'
    + '**不等于**「这张单没有行」')
  if (read.skipped.shape > 0) notes.push(`change.lines 有 ${read.skipped.shape} 条形状不对 → 整条跳过（不猜）`)
  if (read.skipped.over > 0) notes.push(`change.lines 有 ${read.skipped.over} 条超出单张单读取上限 `
    + `${DETAIL_LINE_MAX} → 未读（有界，照实报 lines_not_read）`)
  // 同一 line_id 出现多行 ⇒ 口径不确定：**两行都不计入小计**（与入参顺序无关 ⇒ 确定性）
  const seen = new Map()
  for (const entry of read.rows) {
    const id = textOrNull(entry.line_id, ID_LIMIT)
    if (id === null) continue
    seen.set(id, (seen.get(id) ?? 0) + 1)
  }
  const basisMissing = []
  const usable = []
  const privateColumns = []
  let duplicates = 0
  let zeroDenominator = 0
  for (const entry of read.rows) {
    const id = textOrNull(entry.line_id, ID_LIMIT)
    if (id !== null && (seen.get(id) ?? 0) > 1) {
      duplicates += 1
      basisMissing.push({ line_id: id, missing: [], reason: 'duplicate-line-id',
        note: '同一个 line_id 出现多行：哪一行是真的无法判定 → **两行都不计入小计**（不猜）' })
      continue
    }
    if (owner) {
      let taken = 0
      for (const key of Object.keys(entry).sort(byLex)) {
        if (taken >= PRIVATE_COL_MAX) break
        if (!isPrivateKey(key)) continue
        privateColumns.push({ line_id: id ?? '', key: String(key), value: privateValue(entry[key]) })
        taken += 1
      }
    }
    if (id === null) {
      basisMissing.push({ line_id: '(缺 line_id)', missing: ['line_id'], reason: 'missing-fact',
        note: '这一行没有 line_id：定位不到原报价条目 → **不计入小计**（不编一个 id）' })
      continue
    }
    const facts = {}
    const missing = []
    for (const field of DETAIL_FACTS) {
      const value = intOrNull(entry[field])
      facts[field] = value
      if (value === null) missing.push(field)
    }
    if (missing.length > 0) {
      basisMissing.push({ line_id: id, missing: [...missing], reason: 'missing-fact',
        note: `这一行缺 ${missing.join('/')}：**缺依据不得编数** → 计入 basis_missing 且**排除出小计**` })
      continue
    }
    const amountBefore = facts.qty_before * facts.unit_price_before
    const amountAfter = facts.qty_after * facts.unit_price_after
    const deltaAmount = amountAfter - amountBefore
    // 分母为 0 ⇒ 百分比**记 null**（不猜、不编无穷大）；差额本身可算，这一行仍计入小计
    const deltaPct = amountBefore === 0 ? null : halfUpDiv(deltaAmount * 10000, amountBefore) / 100
    if (deltaPct === null) zeroDenominator += 1
    const basis = [`change.change_id`, `change.lines[${id}].qty_before`,
      `change.lines[${id}].unit_price_before`, `change.lines[${id}].qty_after`,
      `change.lines[${id}].unit_price_after`]
    if (quoteId !== null) basis.push('change.quote_id')
    usable.push({ line_id: id, desc: textOrNull(entry.desc, TEXT_MAX) ?? '', qty_before: facts.qty_before,
      unit_price_before: facts.unit_price_before, amount_before: amountBefore, qty_after: facts.qty_after,
      unit_price_after: facts.unit_price_after, amount_after: amountAfter, delta_amount: deltaAmount,
      delta_pct: deltaPct, basis })
  }
  const ordered = [...usable].sort((left, right) => byLex(left.line_id, right.line_id))
  const shown = ordered.slice(0, options.max_items)
  const subtotal = { lines: ordered.length, amount_before: null, amount_after: null,
    delta_amount: null, delta_pct: null }
  if (ordered.length > 0) {
    let before = 0
    let after = 0
    for (const line of ordered) { before += line.amount_before; after += line.amount_after }
    subtotal.amount_before = before
    subtotal.amount_after = after
    subtotal.delta_amount = after - before
    subtotal.delta_pct = before === 0 ? null : halfUpDiv(subtotal.delta_amount * 10000, before) / 100
  }
  const counts = { lines_found: Array.isArray(change.lines) ? change.lines.length : 0,
    lines_read: read.rows.length, lines_shown: shown.length, lines_usable: ordered.length,
    lines_excluded: basisMissing.length - duplicates, lines_not_read: read.skipped.over,
    basis_missing: basisMissing.length, duplicates, omitted: ordered.length - shown.length,
    private_columns: privateColumns.length }
  if (counts.omitted > 0) notes.push(`可用行 ${ordered.length} 条 > 展示上限 ${options.max_items} → 展示前 `
    + `${shown.length} 条（被丢 ${counts.omitted} 条，omitted 照实报）；**总计差额仍按全部可用行算**`
    + '（截断只影响展示，不改口径）')
  if (zeroDenominator > 0) notes.push(`有 ${zeroDenominator} 行的原价为 0 ⇒ delta_pct 记 null`
    + '（分母 0 不猜百分比；该行差额可算，**仍计入小计**）')
  if (basisMissing.length > 0) notes.push(`有 ${basisMissing.length} 行**未纳入小计**`
    + '（缺依据 / 重复 line_id / 缺 line_id 都不得编数）：逐行见 `basis_missing`')
  const reason = ordered.length === 0 ? 'no-usable-lines' : null
  const next = reason === null
    ? 'tools/verify.sh ac AC-CHANGE-002   # 按原报价单价逐行复算（本页每行都给 basis 便于核对；'
      + '本页只展示，不改任何金额）'
    : '先补齐缺的依据（原量/原价/新量/新价：整数件与**整数分**）再重开本页；'
      + '缺依据的行**永不计入小计**（宁可少算，也不编一个数）'
  return detailShape(view, asOf, changeId, options, { lines: shown, basis_missing: basisMissing,
    private_columns: privateColumns, subtotal, counts, notes, private_keys_read: owner,
    reason, next_action: next })
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------
const countsOf = (gateFound, gateShown, changeFound, changeShown, byPolicy, byState) => {
  const omitted = (gateFound - gateShown) + (changeFound - changeShown)
  return {
    gates: { found: gateFound, shown: gateShown, omitted: gateFound - gateShown },
    changes: { found: changeFound, shown: changeShown, omitted: changeFound - changeShown },
    by_policy: byPolicy,
    by_state: byState,
    shown: gateShown + changeShown,
    omitted,
  }
}

const shape = (view, asOf, gates, changes, options, extra) => ({
  source: 'gate-timeline',
  engine: ENGINE,
  engine_note: ENGINE_NOTE,
  view,
  as_of: asOf,
  age_clock: AGE_CLOCK,
  age_basis_note: AGE_BASIS_NOTE,
  ignored_now_inputs: [...IGNORED_NOW_INPUTS],
  gates,
  changes,
  counts: extra.counts,
  bounds: { max_items: options.max_items, sections: [...SECTIONS], reason_max_bytes: REASON_MAX_BYTES },
  truncated: extra.counts.omitted > 0,
  omitted: extra.counts.omitted,
  degraded: extra.reason !== null,
  reason: extra.reason,
  // 说明行的顺序也必须是**确定性**的（同一份快照在条目逆序输入下也要逐字节一致）：按字典序排
  notes: [...extra.notes].sort(byLex),
  privacy: { private_keys_read: false, model_calls: 0, network_calls: 0, clock_reads: 0 },
})

const EMPTY_POLICY = () => {
  const out = {}
  for (const policy of [...TIMEOUT_POLICIES, 'unknown']) out[policy] = 0
  return out
}
const EMPTY_STATE = () => {
  const out = {}
  for (const state of CHANGE_STATES) out[state] = 0
  return out
}

/**
 * 纯函数：把一份**结构化投影/快照载荷**派生成"谁在等、等了多久、谁欠谁一个动作"。
 * 只读入参（不写任何入参对象），不读账本/文件/墙钟/随机数、不联网、不调模型。
 */
export const timelineOf = (payload, config) => {
  const options = resolvedOptions(config)
  if (!isPlain(payload)) {
    return shape('', null, [], [], options,
      { counts: countsOf(0, 0, 0, 0, EMPTY_POLICY(), EMPTY_STATE()), notes: [], reason: 'payload-not-an-object' })
  }
  const view = textOrNull(payload.view, 32) ?? ''
  const asOf = textOrNull(payload.as_of, 40)
  const asOfMs = isoMs(asOf)

  const approvals = readApprovals(payload.approvals)
  const changes = readChanges(payload.changes)
  const notes = []
  for (const [label, section] of [['approvals', approvals], ['changes', changes]]) {
    if (section.skipped.shape > 0) notes.push(`${label} 有 ${section.skipped.shape} 段/条形状不对 → 整段跳过（不猜）`)
    if (section.skipped.incomplete > 0) notes.push(`${label} 有 ${section.skipped.incomplete} 条缺关键字段 → 不进列表（不补默认值）`)
    if (section.skipped.over > 0) notes.push(`${label} 有 ${section.skipped.over} 条超出单段读取上限 ${SECTION_MAX} → 未读（有界，照实报）`)
    if (section.present === false) notes.push(`${label} 段缺失（调用方没给这一段）→ 该段按空读，不等于"没有待批/没有变更"`)
  }
  const usable = approvals.rows.length + changes.rows.length
  if (usable === 0) {
    return shape(view, asOf, [], [], options,
      { counts: countsOf(0, 0, 0, 0, EMPTY_POLICY(), EMPTY_STATE()), notes, reason: 'no-usable-inputs' })
  }

  const gateRun = gateRows(approvals.rows, asOfMs, asOf, options, view, notes)
  const rawChanges = changeRows(changes.rows, approvals.rows, options, view, notes)
  const rawGates = gateRun.items
  if (rawGates.length === 0 && rawChanges.length === 0) {
    // 数据齐但没有"还在等"的门、也没有变更单 → 这本身是结论，**不编**一条兜底项
    return shape(view, asOf, [], [], options,
      { counts: countsOf(0, 0, 0, 0, gateRun.byPolicy, EMPTY_STATE()),
        notes: [...notes, '投影里有事实行，但既没有待办人工门、也没有变更单 → 不给任何条目（no-signal）'],
        reason: 'no-signal' })
  }

  // 排序口径（**确定性**，与入参顺序无关）：门按"等得最久"在前（同长按 id 字典序）；
  // 变更单按"谁欠动作"在前（同状态按 id 字典序）。
  const gates = [...rawGates].sort((left, right) =>
    (right.age_seconds - left.age_seconds) || byLex(left.id, right.id))
  const sortedChanges = [...rawChanges].sort((left, right) =>
    ((CHANGE_STATE_RANK[left.state] ?? 9) - (CHANGE_STATE_RANK[right.state] ?? 9)) || byLex(left.id, right.id))
  const shownGates = gates.slice(0, options.max_items)
  const shownChanges = sortedChanges.slice(0, options.max_items)
  const byState = EMPTY_STATE()
  for (const item of sortedChanges) byState[item.state] = (byState[item.state] ?? 0) + 1
  const counts = countsOf(gates.length, shownGates.length, sortedChanges.length, shownChanges.length,
    gateRun.byPolicy, byState)
  for (const [label, derived, shown] of [['人工门', gates, shownGates], ['变更单', sortedChanges, shownChanges]]) {
    if (derived.length > shown.length) {
      notes.push(`${label}共 ${derived.length} 条，上限 ${options.max_items} → 展示前 ${shown.length} 条，`
        + `被丢 ${derived.length - shown.length} 条（omitted 照实报）`)
    }
  }
  return shape(view, asOf, shownGates, shownChanges, options, { counts, notes, reason: null })
}

// ---------------------------------------------------------------------------
// 催办请求（**只产载荷形状**：本插件不写任何东西，落盘由宿主、落账本由 Python 侧）
// ---------------------------------------------------------------------------
/** 与提交面同一个 id 口径：同一份（门 + 理由）→ 同一个待办件 id（幂等可观察）。 */
const nudgeId = (view, gateId, reason) => `gn-${view}-${sha256(`${gateId}\u0000${reason}`).slice(0, 12)}`

/**
 * 催办请求（**不改任何门的判定状态**，因此不构成"批准"）：返回一条**待办件载荷** +
 * 说明性 `next_action`。真正的落盘在宿主（0600 待办件）、真正的落账本在
 * `tools/gate-nudge.py`（唯一写账本者，落 `gate/nudged`）。
 */
export const nudgeOf = (payload, request, config) => {
  const options = resolvedOptions(config)
  const req = isPlain(request) ? request : {}
  const view = textOrNull(req.view, 32) ?? (isPlain(payload) ? (textOrNull(payload.view, 32) ?? '') : '')
  const gateId = textOrNull(req.gate_id, ID_LIMIT) ?? ''
  const reason = typeof req.reason === 'string' ? req.reason : ''
  const bytes = Buffer.byteLength(reason, 'utf8')
  const digest = `sha256:${sha256(reason)}`
  const refuse = (code, next_action) => ({ ok: false, code, view, gate_id: gateId, reason_sha256: digest,
    bytes, id: '', record: null, next_action })
  if (!isPlain(payload)) {
    return refuse('payload-unusable', '先让宿主把本视角投影交给插件（没有事实就催不了谁）')
  }
  if (view === '') return refuse('view-unknown', '给出视图名（本次催办属于哪一侧）')
  if (gateId === '') return refuse('gate-not-found', '给出目标人工门 id（形如 ap-0007）；本插件不猜你想催哪一条')
  const derived = timelineOf(payload, config)
  if (!derived.gates.some((item) => item.id === gateId)) {
    return refuse('gate-not-found',
      `门 ${gateId} 不在**本视角投影**的待办门列表里（可能已决、或不属于本视角）→ 不改任何状态、`
      + `**账本零新增**；看 ${options.route_prefix}/${view}/gates/ 列出的真 id 再催`)
  }
  if (reason.trim() === '') {
    return refuse('empty-reason', '把催办理由用自己的话写进 reason（空理由不落盘：没有内容就没有事实）')
  }
  if (bytes > REASON_MAX_BYTES) {
    return refuse('reason-too-long', `理由 ${bytes} 字节 > 上限 ${REASON_MAX_BYTES}：请写短一点（宿主不截断、不静默丢）`)
  }
  const id = nudgeId(view, gateId, reason)
  const record = {
    schema: NUDGE_SCHEMA, kind: NUDGE_KIND, view, gate_id: gateId,
    requested_action: NUDGE_ACTION,        // **只可能是催办**：本插件不存在批准/提交/签收这类动作
    reason, reason_sha256: digest, bytes, submitted_at: '',
    note: '宿主只落本条 0600 待办件（含用户原话 + 目标门 id + sha256）；不写账本、不改门的判定状态；'
      + '时间由 Python 侧按 --now 落账',
  }
  return {
    ok: true, code: 'accepted', view, gate_id: gateId, reason_sha256: digest, bytes, id, record,
    next_action: '跑 tools/gate-nudge.py --now <ISO8601> 消费待办件（唯一落账本者，落 gate/nudged：'
      + '只记"谁在什么时候催过哪一个门"，不改门的判定）；账本里**不会**因此多出一条批准',
  }
}

export function apply(ctx, config) {
  const options = resolvedOptions(config)
  const handle = {
    requests: ['timeline', 'change_detail'],   // 只声明事实：别的都不是服务面（本插件没有、也不许有"批准"类方法）
    timeline: (payload) => timelineOf(payload, config),
    // 变更单**逐行明细**（规则 ⑤）：只吃白名单载荷，金额整数分，缺依据的行排除出小计
    change_detail: (payload) => changeDetailOf(payload, config),
    nudge: (payload, request) => nudgeOf(payload, request, config),
    meta: () => ({
      engine: ENGINE, engine_note: ENGINE_NOTE, age_clock: AGE_CLOCK, age_basis_note: AGE_BASIS_NOTE,
      ignored_now_inputs: [...IGNORED_NOW_INPUTS],
      sections: [...SECTIONS], degraded_reasons: [...DEGRADED_REASONS], nudge_codes: [...NUDGE_CODES],
      nudge_action: NUDGE_ACTION, kind: NUDGE_KIND, schema: NUDGE_SCHEMA,
      timeout_policies: [...TIMEOUT_POLICIES], resolved_approval_events: [...RESOLVED_APPROVAL_EVENTS],
      commit_scopes: [...COMMIT_SCOPES], change_states: [...CHANGE_STATES],
      money_unit: MONEY_UNIT, rounding: ROUNDING, detail_reasons: [...DETAIL_REASONS],
      line_keys: [...DETAIL_KEYS], private_column_views: [...PRIVATE_COLUMN_VIEWS],
      bounds: { max_items: options.max_items, reason_max_bytes: REASON_MAX_BYTES,
        lines_max: DETAIL_LINE_MAX, private_columns_max: PRIVATE_COL_MAX },
      can_approve: false,      // 机器可读的"不能批准"：本插件的服务面里没有这类方法
    }),
    config: () => ({ max_items: options.max_items, route_prefix: options.route_prefix,
      reason_max_bytes: REASON_MAX_BYTES, age_clock: AGE_CLOCK, money_unit: MONEY_UNIT, rounding: ROUNDING }),
  }
  ctx.provide('gateTimeline', handle)
}

export function disposer() {
  return () => {}
}

/** fixture：纯读取（A5 会连跑两次比对字节，故不得有任何副作用）。 */
export const fixture = {
  sample: (handle) => ({
    all: handle.timeline({
      view: 'contractor',
      as_of: '2026-09-21T12:00:00Z',
      approvals: [
        { approval_id: 'ap-0007', type: 'approval/requested', ts: '2026-09-21T10:00:00Z',
          scope: 'award.commit', ref: 'awin-1', summary: '授标承诺', approvers: ['human:liangzi'],
          timeout_policy: 'escalate', timeout_s: 3600, escalate_to: 'human:boss' },
        { approval_id: 'ap-0007', type: 'approval/escalated', ts: '2026-09-21T11:30:00Z',
          scope: 'award.commit', ref: 'awin-1', escalate_to: 'human:boss' },
      ],
      changes: [
        { change_id: 'chg-0001', type: 'change/proposed', ts: '2026-09-21T10:30:00Z', quote_id: 'q-1' },
        { change_id: 'chg-0001', type: 'change/priced', ts: '2026-09-21T11:00:00Z', quote_id: 'q-1',
          delta_amount: 1720, basis_unit_price_refs: ['q-1#L-001:unit_price'] },
      ],
    }),
    empty: handle.timeline({ view: 'contractor' }),
    detail: handle.change_detail({ view: 'contractor', as_of: '2026-09-21T12:00:00Z',
      change: { change_id: 'CO-0001', quote_id: 'q-1', ts: '2026-09-21T11:00:00Z', lines: [
        { line_id: 'L-001', desc: '钢筋', qty_before: 10, unit_price_before: 6000, qty_after: 12,
          unit_price_after: 6000 },
        { line_id: 'L-002', desc: '水泥', qty_before: 3, unit_price_before: 1000, qty_after: 3,
          unit_price_after: 1500, cost_floor: 900 },
      ] } }),
    detail_missing: handle.change_detail({ view: 'contractor', as_of: '2026-09-21T12:00:00Z',
      change_id: 'CO-9999' }),
    nudge: handle.nudge({ view: 'contractor', as_of: '2026-09-21T12:00:00Z',
      approvals: [{ approval_id: 'ap-0007', type: 'approval/requested', ts: '2026-09-21T10:00:00Z',
        scope: 'award.commit', ref: 'awin-1' }] }, { gate_id: 'ap-0007', reason: '现场催一下' }),
    meta: handle.meta(),
  }),
}
