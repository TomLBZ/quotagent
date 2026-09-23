/**
 * 进树模块：`rfq-deadline` —— **「来不及回 RFQ：谁还没回、还差多久、催了没有」**（domain 插件）。
 *
 * 正面回答 human problem（原始出处：`docs/work/plans/ux-双方痛点与交互需求.md.txt` 的
 * P-10「截止时间与催报**没有入口**」（临期/逾期包漏看；催了没痕迹）与 P-04 的
 * 「供应商被迫\"等回到电脑前再算\"，错过截止」—— 合起来就是「**来不及回 RFQ**」这条痛点）：
 *   每个还在收报价的 RFQ 给出 —— 回文时限（`due_ts`）、**这个时限是从哪条事实来的**（`due_basis`）、
 *   谁已经回了（`responded`）、谁还没回（`silent`）、是不是已经过了（`overdue`）、
 *   还剩多少秒（`remaining_seconds`，**由事实算、不取墙钟**）、严重度（`severity`）、
 *   下一步能粘贴的命令/路由（`next_action`）、以及**为什么发不出去**（`blocked_by`）。
 *
 * 分工（与 `gate-timeline` / `advice-panel` 同一套纪律）：
 *   · Python 侧服务（`services/rfq.py` 的 `deadline_status` / `remind`、`services/mail_transport.py`
 *     的通道状态）是**判定**与**事实**的唯一真源；
 *   · `host/modules/webui.mjs` 只把**本视角自己的行**过滤成下面这份**白名单载荷**（键白名单读取，
 *     多出来的键读都不读）；名单的私域口径由本插件声明（`meta.private_list_views`），宿主照抄；
 *   · 本插件**不读账本、不写任何东西、不联网、不调模型、不取墙钟、不发信** —— 只对调用方给的
 *     结构化载荷做一次确定性的规则派生（不 import `fs`：静态扫描断言看着）。
 *
 * 【纪律一：`due_ts` 的口径 —— **绝不取墙钟**】
 *   `remaining_seconds = due_ts − as_of`，其中 `due_ts` 来自**事实行**（`rfq/published.quote_by`
 *   或 `rfq/promised.due_at`；同一包取事实 `ts` 最晚的那条），`as_of` = 本视角投影里**最大的事件 `ts`**
 *   （系统已知的最新**事实**时刻，由调用方从账本事实派生）。因此**同一份快照在任何\"当前时间\"下输出
 *   逐字节一致**：载荷里给 `now`、配置里给 `now` 都**读都不读**（`ignored_now_inputs` /
 *   `due_clock:"facts-only"` 把这件事变成可机检的事实，页面照抄 `due_basis_note`）。
 *   为什么必须这样：墙钟会让\"还剩多久 / 是不是来不及了\"随刷新漂移 —— 两个人看同一份事实会得到两个
 *   数字（不确定性），而\"来不及回 RFQ\"这个痛点的答案必须是可复算的。
 *
 * 【纪律二：**没凭据不得假装能发**】
 *   若邮件通道 `channel.available !== true`，则每条 RFQ 的 `blocked_by` 必须写清\"**无法代发**\"与
 *   通道自己给的原因（`reason` / `next_action`），且**整个输出的任何字段里都不出现「已通知 / 已提醒 /
 *   已发送」这类事实**（本插件一个字节都发不出去：`meta.can_send=false`、`privacy.sends=0`）。
 *   邮件通道**可用**时也不许自称已发：仍然只给名单、时限与可复制的登记入口。
 *
 * 规则（四条，各自可解释、可复算；常量都在本文件里，改口径就改这里 + 门 `host/t285-rfq-deadline-gate.mjs`）：
 *   ① `rfq`  还在收报价的 RFQ：`due_ts` / `due_basis` / `overdue` / `remaining_seconds` / `severity`
 *      （`overdue|critical|soon|scheduled|unknown-deadline`；阈值 `CRITICAL_SECONDS`/`SOON_SECONDS`）；
 *   ② `roster` 名单（**业主侧才读**）：`invited` = `rfq/published.invited|suppliers`（与
 *      `host/modules/sourcing.mjs` 的 `coverage()` 同一规则）**∪** `rfq/distributed.recipients`
 *      （分发事实：谁在何时收到哪个版本）；`responded` = `quote/submitted` 的 `body.supplier` 或
 *      行的 `actor`（同一规则），按包归属以 `package_id`/`correlation_id` 为准；`silent` = 差集；
 *   ③ `honest` 没凭据就说没凭据：`blocked_by` 逐条给通道事实；`next_action` 给**可复制的**登记入口
 *      （`POST <prefix>/<view>/deadlines/promise`）与唯一落账本者（`tools/rfq-promise.py`）；
 *   ④ `bounded` 有界：每段最多读 `SECTION_MAX` 条、每条名单最多 `LIST_MAX` 个名字、文本字段有字符上限、
 *      展示上限 `max_items` 夹取并**如实报** `omitted`/`truncated`；无数据 ⇒ `degraded` + 有名 reason + 列表为空。
 *
 * 【纪律三：本插件**不能发信、不能批准**】
 *   服务面只有两件事：**告知**（`status`）与**登记承诺**（`promise` —— 只产一条待办件载荷，
 *   由宿主落 0600 文件、再由 Python 侧唯一落账本者落 `rfq/promised`）。没有 `send` / `mail` /
 *   `approve` / `decide` / `submit` 这类方法（门 `t285` 逐条断言）。
 */
import { createHash } from 'node:crypto'
import { constant, number, object, string } from '../lib/std-schema.mjs'

/**
 * **P32：外部行数组的唯一读数入口**（口径见 `src/system/webui/docs/row-action-prefill.md` §4）。
 * 只认**非 null 的对象**行：数组里混进 `null`/字符串/数字/嵌套数组时，裸读 `row.rfq_id` 抛
 * `TypeError` ⇒ 这一页/这块面板整块崩掉（外壳判 `data-failed`、SSR 路由 500）。
 * 坏行**逐条计数**（`bad`，调用方必须如实报出）、**好行照列**；源不是数组 ⇒ `list:false`（「读不出来」≠「零行」）。
 */
const isRow = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const readRows = (value) => {
  if (!Array.isArray(value)) return { list: false, rows: [], all: 0, bad: 0 }
  const rows = []
  let bad = 0
  for (const row of value) { if (isRow(row)) rows.push(row); else bad += 1 }
  return { list: true, rows, all: value.length, bad }
}

export const name = 'rfq-deadline'

export const inject = []                 // 纯函数插件：载荷由调用方给（宿主只读投影/快照）
export const builtin = []                // 本模块不使用事件：声明即事实（D-015 / A1 双向断言）
export const usedServices = []
export const provides = ['rfqDeadline']

/** 引擎自述：`rules` = **确定性规则**（不是模型、不是推测）。 */
export const ENGINE = 'rules'

/** 页面上必须原样出现的一句话（诚实分层 + \"不能代发\"一起说清）。 */
export const ENGINE_NOTE = '本页由确定性规则从投影/快照派生（只看**事实时间戳**与事实行里声明的回文时限），'
  + '不含模型推测、不取墙钟；本页**不能替你发信**、也不代替人工门'

/** 回文时限口径的**机读名字**（页面文案与门都引用这一处真源）。 */
export const DUE_CLOCK = 'facts-only'

/** 回文时限口径的**人话**（页面照抄；写清\"不随你刷新的时间变\"）。 */
export const DUE_BASIS_NOTE = 'due_ts 取自**事实行**：`rfq/published.quote_by` 或 `rfq/promised.due_at`'
  + '（同一包取事实 ts 最晚的那条，同刻按事件类型字典序；两边都没有 ⇒ 不猜时限）'
  + ' —— `remaining_seconds = due_ts − as_of`（as_of = 本视角投影里最大的事件 ts，即系统已知的最新事实时刻）'
  + '；本页不取墙钟：同一份快照在任何时刻打开，剩余时长都一样'

/** 载荷里被读的段（白名单；门断言\"输出只可能来自这几段\"）。 */
export const SECTIONS = ['rfqs', 'quotes', 'promises']

/** 墙钟入口（**存在但被忽略**：写进输出只为让\"我没读它\"成为可机检的事实）。 */
export const IGNORED_NOW_INPUTS = ['payload.now', 'config.now']

/** 降级原因的**闭合集合**（门据此断言\"降级是有名的，不是含糊的\"）。 */
export const DEGRADED_REASONS = ['payload-not-an-object', 'no-usable-inputs', 'no-signal']

/** 严重度的**闭合集合**（`unknown-deadline` = 事实里没有可解析的回文时限：不猜）。 */
export const SEVERITIES = ['overdue', 'critical', 'soon', 'scheduled', 'unknown-deadline']

/** 严重度的**排序权重**（来不及的先看：已过 > 不到 1 小时 > 不到 24 小时 > 还早 > 认不出）。 */
export const SEVERITY_RANK = { overdue: 0, critical: 1, soon: 2, scheduled: 3, 'unknown-deadline': 4 }

/** 每条 RFQ 的键集（**恰 11 键**；门逐字段断言，顺序即键集本身）。 */
export const RFQ_KEYS = ['rfq_id', 'subject', 'due_ts', 'due_basis', 'responded', 'silent',
  'overdue', 'remaining_seconds', 'severity', 'next_action', 'blocked_by']

/** **看得见竞标人名册**的视角（名册是业主私域）；其余视角对名单**读都不读**。 */
export const PRIVATE_LIST_VIEWS = ['contractor']

/** 名单白名单的**人话**（页面照抄；**不写供应商代号**）。 */
export const PRIVATE_LISTS_NOTE = '名单白名单：只有业主侧（' + PRIVATE_LIST_VIEWS.join('/') + '）看得见'
  + '「已邀请 / 已回应 / 未回应」这三列（**竞标人名册本身是业主私域**）；其余视角**读都不读** —— '
  + '带名单与不带名单的载荷输出**逐字节一致**（不是「藏起来」，是根本没读）'

/** 名单来源的**人话**（页面照抄：口径写在页面上，别人才复核得了）。 */
export const ROSTER_NOTE = 'invited 的口径 = `rfq/published` 的 `invited`/`suppliers`（与 '
  + '`host/modules/sourcing.mjs` 的 `coverage()` 同一规则）**∪** `rfq/distributed.recipients`'
  + '（分发事实：谁在何时收到哪个版本）；responded 的口径 = `quote/submitted` 的 `body.supplier` '
  + '（缺失时用行的 `actor`）且能按 `package_id`/`correlation_id` 归到该包；silent = 差集。'
  + '两份名单都只统计**本视角投影**里的事实（对方的账本不在本视角的读取路径上）'

/** \"不能发信\"的**人话**（页面照抄；输出里不出现任何\"发过了\"类事实表述）。 */
export const NO_SEND_NOTE = '本插件**发不出任何东西**：没有邮件凭据时不得假装能代发 —— '
  + '输出的任何字段里都不会出现任何\"发过了\"的事实表述；'
  + '要发信只能走已登记的邮件路由，且由 Python 侧的唯一发信者做'

/** 登记承诺（承诺回文时限）被拒的**有名 code 闭合集合**（宿主据此定状态码，页面据此给 next_action）。 */
export const PROMISE_CODES = ['accepted', 'payload-unusable', 'view-unknown', 'rfq-not-found',
  'actor-malformed', 'due-at-malformed', 'empty-note', 'note-too-long']

/** 登记请求里唯一被允许的动作名（本插件**不存在**别的动作：尤其没有\"发信\"）。 */
export const PROMISE_ACTION = 'promise'

/** 待办件（宿主落盘的那一条）的 kind / schema（Python 侧 `tools/rfq-promise.py` 认这两个值）。 */
export const PROMISE_KIND = 'rfq-promise'
export const PROMISE_SCHEMA = 1

/** 唯一落账本者（Python 侧）落的事件名：本插件只产载荷，**不落任何账本行**。 */
export const PROMISE_EVENT = 'rfq/promised'

/** 下一步里的\"登记承诺\"入口（相对前缀；宿主补上自己的 route_prefix）。 */
export const PROMISE_ROUTE = '/deadlines/promise'
export const PROMISE_CONSUMER = 'python3 tools/rfq-promise.py --now <ISO8601>'

/** 立即要处理 / 快来不及 / 还早 / 认不出时限 —— 每种都给**可复制**的下一步。 */
export const CALL_TO_ACTION = {
  overdue: '已经过了回文时限：①**登记新的承诺回文时限**（把它变成一条事实）；②或决定延期/放弃（在 GUI 里改包升版再分发）。'
    + '名单上还没回的人**只能你亲自联系**（本面板不能代发；催报走「回文时限与催报」面板的点「催报」）',
  critical: '距回文时限不到 1 小时：要回的人现在就得知道 —— 本页不能代发，**请亲自联系**；'
    + '同时把\"什么时候能回\"登记成事实（承诺回文时限）',
  soon: '距回文时限不到 24 小时：按名单逐个确认（本页不能代发）；'
    + '对方给了口头承诺就把它登记成**承诺回文时限**，别让它只留在微信里',
  scheduled: '还有时间：按名单逐个确认（本页不能代发）；需要书面承诺就走\"登记承诺\"入口留下痕迹',
  'unknown-deadline': '这个包**没有可用的回文时限事实**（不猜）：先补上 `rfq/published.quote_by`，'
    + '或登记一条 `rfq/promised` 之后再重开本页',
}

export const Config = object({
  max_items: number().default(20),          // 展示条数上限（夹取区间 [1, 200]）
  route_prefix: string().default('/quotagent'),
  now: string().default(''),                // 墙钟观测量：**读都不读**（见文件头的 due 口径）
  deterministic: constant(true),            // const 键：不得翻转（A3 负控）
})

/** 展示条数上限的夹取区间与回落值（非有限数 → 默认；越界 → 夹取）。 */
const ITEM_FLOOR = 1
const ITEM_CEILING = 200
const ITEM_FALLBACK = 20
/** 文本字段的字符上限（回显回来的任意字节必须有界）。 */
const TEXT_MAX = 240
/** 标识符的长度上限（`rfq_id`）。 */
const ID_LIMIT = 64
/** 每段最多读入的条目数（有界：调用方给一堆也不把响应撑大）。 */
const SECTION_MAX = 64
/** 每条 RFQ 的名册最多回显的名字数（有界：业主侧也不许把响应撑大）。 */
const LIST_MAX = 32
/** 承诺说明（用户原话）的**字节**上界（与宿主落盘形状同口径：超出即拒，不截断成另一份理由）。 */
const NOTE_MAX_BYTES = 2048
/** 承诺人（发言人）的形状：必须显式写 human:/agent:，**不许匿名**（谁承诺的必须可追）。 */
const ACTOR_RE = /^(human|agent):[A-Za-z0-9._-]{1,48}$/
/** 严重度阈值（秒）：不到 1 小时 = critical；不到 24 小时 = soon。 */
const CRITICAL_SECONDS = 3600
const SOON_SECONDS = 86400

const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** 只有有限数字才算一个值；NaN / ±Infinity / 字符串数字一律按\"取不到\"处理（不解析、不猜）。 */
const numOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/** 人话串：清掉控制字符、去空白、截断（**有界**）；空串按取不到处理。 */
const textOrNull = (value, maxChars = TEXT_MAX) => {
  if (typeof value !== 'string') return null
  const stripped = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  if (stripped === '') return null
  return stripped.length > maxChars ? stripped.slice(0, maxChars) : stripped
}

/** 显式字典序比较器（排序不依赖默认比较的隐含规则，也不受 locale 影响）。 */
const byLex = (left, right) => (left < right ? -1 : (left > right ? 1 : 0))

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
    // **读进来只为\"证明它没被用于计算\"**：任何把它掺进 remaining_seconds 的做法都会被门抓红（t285 变异 1）
    now: textOrNull(cfg.now, 40),
  })
}

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

// ---------------------------------------------------------------------------
// 载荷读取（白名单键；条目上多出来的键**读都不读** —— 私域哨兵因此进不了输出）
// ---------------------------------------------------------------------------
/** 一层通用读取：返回 `{rows, skipped:{shape,incomplete,over}, present}`。 */
const readSection = (raw, pick) => {
  const rows = []
  const skipped = { shape: 0, incomplete: 0, over: 0 }
  if (raw === undefined || raw === null) return { rows, skipped, present: false }
  if (!Array.isArray(raw)) return { rows, skipped: { ...skipped, shape: 1 }, present: true }
  if (raw.length > SECTION_MAX) skipped.over = raw.length - SECTION_MAX
  for (const entry of raw.slice(0, SECTION_MAX)) {
    if (!isPlain(entry)) { skipped.shape += 1; continue }
    const row = pick(entry)
    if (row === null) { skipped.incomplete += 1; continue }
    rows.push(row)
  }
  return { rows, skipped, present: true }
}

/** `rfq/published` 行：包 id / rev / 事实 ts / 声明的回文时限 / 清单条数 /（业主侧才读的）邀请名单。 */
const readRfq = (owner) => (entry) => {
  const id = textOrNull(entry.rfq_id, ID_LIMIT) ?? textOrNull(entry.package_id, ID_LIMIT)
  if (id === null) return null
  let invited = []
  if (owner) {
    const raw = entry.invited === undefined || entry.invited === null ? entry.suppliers : entry.invited
    const list = Array.isArray(raw) ? raw : (typeof raw === 'string' && raw !== '' ? [raw] : [])
    invited = [...new Set(list.slice(0, LIST_MAX).map((item) => textOrNull(item, 64))
      .filter((item) => item !== null))].sort(byLex)
  }
  return { rfq_id: id, rev: numOrNull(entry.rev), ts: textOrNull(entry.ts, 40),
    due_ts: textOrNull(entry.due_ts, 40), items: numOrNull(entry.items),
    subject: textOrNull(entry.subject, TEXT_MAX), invited }
}

/** `quote/submitted` 行：按哪个包 / 谁回的 / 事实 ts（**只读这三个键**，私域列读都不读）。 */
const readQuote = (entry) => {
  const rfqId = textOrNull(entry.rfq_id, ID_LIMIT) ?? textOrNull(entry.package_id, ID_LIMIT)
    ?? textOrNull(entry.correlation_id, ID_LIMIT)
  if (rfqId === null) return null
  const supplier = textOrNull(entry.supplier, 64) ?? textOrNull(entry.actor, 64)
  return { rfq_id: rfqId, supplier, ts: textOrNull(entry.ts, 40) }
}

/** `rfq/promised` 行：对哪个包、承诺的回文时限（事实行里声明的）、事实 ts、谁承诺的。 */
const readPromise = (entry) => {
  const rfqId = textOrNull(entry.rfq_id, ID_LIMIT) ?? textOrNull(entry.package_id, ID_LIMIT)
  if (rfqId === null) return null
  return { rfq_id: rfqId, due_at: textOrNull(entry.due_at, 40), ts: textOrNull(entry.ts, 40),
    actor: textOrNull(entry.actor, 64) }
}

/** 通道事实（邮件）：只读这几个键，**不出任何凭据值**。 */
const readChannel = (raw) => {
  const blank = { kind: '', available: false, configured: false, connected: false,
    reason: 'channel-undeclared', next_action: '', source: '' }
  if (!isPlain(raw)) return blank
  return {
    kind: textOrNull(raw.kind, 32) ?? 'smtp',
    available: raw.available === true,
    configured: raw.configured === true,
    connected: raw.connected === true,
    reason: textOrNull(raw.reason, TEXT_MAX) ?? (raw.available === true ? '' : 'mail-transport-unavailable'),
    next_action: textOrNull(raw.next_action, TEXT_MAX) ?? '',
    source: textOrNull(raw.source, TEXT_MAX) ?? '',
  }
}

// ---------------------------------------------------------------------------
// 派生：回文时限（① —— 只用事实：due_ts 与 as_of 都是事实时间戳）
// ---------------------------------------------------------------------------
/** 事实候选：事实行的 kind / 该行上的时限 / 事实 ts。 */
const factOf = (kind, ts, due) => ({ kind, ts, due })

/** 事实候选的排序（**确定性**：先比事实 ts，同刻按事件类型字典序；认不出 ts 的排在最后）。 */
const laterFact = (candidate, current) => {
  if (current === null) return true
  const left = isoMs(candidate.ts)
  const right = isoMs(current.ts)
  if (left !== null && right !== null) return left === right ? byLex(candidate.kind, current.kind) > 0 : left > right
  if (left !== null) return true
  if (right !== null) return false
  return byLex(candidate.kind, current.kind) > 0
}

/** 严重度：全部由**事实之差**决定（不取墙钟、不看名字、不调模型）。 */
const severityOf = (remaining) => {
  if (remaining === null) return 'unknown-deadline'
  if (remaining < 0) return 'overdue'
  if (remaining <= CRITICAL_SECONDS) return 'critical'
  if (remaining <= SOON_SECONDS) return 'soon'
  return 'scheduled'
}

/** 名单（业主侧才读）：`invited` ∪ 分发事实；`responded` 按包归属取；`silent` = 差集。 */
const rosterOf = (row, quotes, owner) => {
  if (!owner) return { invited: [], responded: [], silent: [] }
  const invited = [...row.invited]
  const responded = [...new Set(quotes.filter((item) => item.rfq_id === row.rfq_id && item.supplier !== null)
    .map((item) => item.supplier))].sort(byLex)
  const respondedSet = new Set(responded)
  return { invited, responded, silent: invited.filter((item) => !respondedSet.has(item)) }
}

/** 单条 RFQ 的下一步：可复制的登记入口 + 唯一落账本者（**不出现\"已通知\"**）。 */
const nextOf = (options, view, item) => {
  const head = CALL_TO_ACTION[item.severity] ?? CALL_TO_ACTION['unknown-deadline']
  if (item.severity === 'unknown-deadline') return `${head}（本页只读：不改任何状态）`
  const route = `${options.route_prefix}/${view}${PROMISE_ROUTE}`
  return `${head}\n登记承诺（宿主只落 0600 待办件、**账本零新增**）：`
    + `curl -s -X POST ${route} -d id=${item.rfq_id} -d by=human:<你> -d due_at=<ISO8601> -d note=<一句话>`
    + `；落账本：${PROMISE_CONSUMER}（唯一落账本者）`
}

/** 单条 RFQ 的\"为什么发不出去\"：没凭据就说没凭据（永远非空）。 */
const blockedOf = (channel) => {
  if (!channel.available) {
    return `邮件通道 **available=false**（${channel.reason}）：**无法代发**任何催报/通知`
      + `${channel.next_action ? `；通道自己给的下一步：${channel.next_action}` : ''}`
      + ' —— 本页只列名单与时限，**不声称任何\"发过了\"的事实**（本插件一个字节都发不出去）'
  }
  return '邮件通道 available=true（凭据就位），但本插件**不发送任何东西**（只读投影）：'
    + '要发信只能走已登记的邮件路由，且由 Python 侧的唯一发信者做'
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------
const emptySeverity = () => {
  const out = {}
  for (const name of SEVERITIES) out[name] = 0
  return out
}

const shape = (view, asOf, items, options, channel, extra) => ({
  source: 'rfq-deadline',
  engine: ENGINE,
  engine_note: ENGINE_NOTE,
  view,
  as_of: asOf,
  due_clock: DUE_CLOCK,
  due_basis_note: DUE_BASIS_NOTE,
  ignored_now_inputs: [...IGNORED_NOW_INPUTS],
  rfq_keys: [...RFQ_KEYS],
  rfqs: items,
  counts: extra.counts,
  bounds: { max_items: options.max_items, sections: [...SECTIONS], section_max: SECTION_MAX,
    list_max: LIST_MAX, note_max_bytes: NOTE_MAX_BYTES, critical_seconds: CRITICAL_SECONDS,
    soon_seconds: SOON_SECONDS },
  truncated: extra.counts.omitted > 0,
  omitted: extra.counts.omitted,
  degraded: extra.reason !== null,
  reason: extra.reason,
  channel: { ...channel },
  can_send: false,                       // 机器可读的\"发不出去\"：本插件的服务面里没有发信方法
  no_send_note: NO_SEND_NOTE,
  private_lists_visible: PRIVATE_LIST_VIEWS.includes(view),
  private_lists_note: PRIVATE_LISTS_NOTE,
  roster_note: ROSTER_NOTE,
  // 说明行的顺序也必须是**确定性**的（同一份快照在条目逆序输入下也要逐字节一致）：按字典序排
  notes: [...extra.notes].sort(byLex),
  privacy: { private_keys_read: false, bidder_lists_read: PRIVATE_LIST_VIEWS.includes(view),
    model_calls: 0, network_calls: 0, clock_reads: 0, sends: 0 },
})

/**
 * 纯函数：把一份**结构化投影/快照载荷**派生成\"哪个包还差谁回、还剩多久、为什么发不出去\"。
 * 只读入参（不写任何入参对象），不读账本/文件/墙钟/随机数、不联网、不调模型、不发信。
 * 输入形状（调用方按白名单装配；多余的键**读都不读**）：
 *   `{ view, as_of, channel: {kind, available, reason, next_action, source},
 *      rfqs: [{ rfq_id, rev, ts, due_ts, items, subject, invited?, suppliers? }],
 *      quotes: [{ rfq_id, package_id, correlation_id, supplier, actor, ts }],
 *      promises: [{ rfq_id, due_at, ts, actor }] }`
 */
export const statusOf = (payload, config) => {
  const options = resolvedOptions(config)
  const channel = readChannel(isPlain(payload) ? payload.channel : null)
  const blankCounts = () => ({ rfq: { found: 0, shown: 0, omitted: 0 },
    facts: { rfqs: 0, quotes: 0, promises: 0 }, invited: 0, responded: 0, silent: 0,
    unattributed_quotes: 0, by_severity: emptySeverity(), shown: 0, omitted: 0 })
  if (!isPlain(payload)) {
    return shape('', null, [], options, channel,
      { counts: blankCounts(), notes: [], reason: 'payload-not-an-object' })
  }
  const view = textOrNull(payload.view, 32) ?? ''
  const asOf = textOrNull(payload.as_of, 40)
  const asOfMs = isoMs(asOf)
  const owner = PRIVATE_LIST_VIEWS.includes(view)

  const rfqs = readSection(payload.rfqs, readRfq(owner))
  // 报价事实段与邀请名单同属**业主侧名册口径**：非业主视角**读都不读**（否则计数也会随它变，
  // 那样\"读都不读\"就不是可机检的事实了）
  const quotes = owner ? readSection(payload.quotes, readQuote)
    : { rows: [], skipped: { shape: 0, incomplete: 0, over: 0 }, present: true }
  const promises = readSection(payload.promises, readPromise)
  const notes = []
  for (const [label, section] of [['rfqs', rfqs], ['quotes', quotes], ['promises', promises]]) {
    if (section.skipped.shape > 0) notes.push(`${label} 有 ${section.skipped.shape} 段/条形状不对 → 整段跳过（不猜）`)
    if (section.skipped.incomplete > 0) notes.push(`${label} 有 ${section.skipped.incomplete} 条缺关键字段 → 不进派生（不补默认值）`)
    if (section.skipped.over > 0) notes.push(`${label} 有 ${section.skipped.over} 条超出单段读取上限 ${SECTION_MAX} → 未读（有界，照实报）`)
    if (section.present === false) notes.push(`${label} 段缺失（调用方没给这一段）→ 该段按空读，不等于\"没有这种事实\"`)
  }
  const usable = rfqs.rows.length + quotes.rows.length + promises.rows.length
  if (usable === 0) {
    return shape(view, asOf, [], options, channel,
      { counts: blankCounts(), notes, reason: 'no-usable-inputs' })
  }

  // 报价事实：能归到发布过的包才计入该包；归不到的不猜（照实报数）
  // P32：三段行数组（`rfqs`/`quotes`/`promises` 的 `rows`）走唯一读数入口，不再裸读元素属性 ——
  // 坏行**不参与派生**，也不静默丢（段级跳过的条数已由上面 `section.skipped.shape` 如实报进 notes）。
  const rfqRows = readRows(rfqs.rows).rows
  const quoteRows = readRows(quotes.rows).rows
  const published = new Set(rfqRows.map((row) => row.rfq_id))
  const attributed = quoteRows.filter((row) => published.has(row.rfq_id))
  const unattributed = quoteRows.filter((row) => !published.has(row.rfq_id))
  if (unattributed.length > 0) {
    notes.push(`quotes 有 ${unattributed.length} 条**归不到任何发布过的包**（package_id/correlation_id 都对不上）`
      + ' → 不计入任何 RFQ 的名单（不猜它属于哪一包），未回应名单因此可能**少算**了已回应者')
  }
  if (owner && rfqRows.some((row) => row.invited.length === 0)) {
    notes.push('有包**没有邀请名单事实**（`rfq/published.invited`/`suppliers` 与 `rfq/distributed.recipients` 都缺）'
      + ' → 该包的名册两列留空（不编一份名册）')
  }
  if (!owner) notes.push('本视角不是业主侧 → 竞标人名册与报价事实段（invited/quotes）**读都不读**'
    + '（responded/silent 恒为空，不是"没人回"）')
  if (rfqs.rows.some((row) => row.subject === null)) {
    notes.push('`rfq/published` 事实里没有标题字段 → subject 由包 id、rev 与清单条数拼出（**不编一个标题**）')
  }
  if (asOfMs === null) {
    notes.push('投影里没有可解析的 as_of（事实时刻）→ 不给剩余时长与严重度（不猜时钟）')
  }

  // 同一包的**多条发布事实**（真实账本里会有：amend 后重发、或同一包发布两次）⇒ 合成**一行**：
  //   · 定口径的事实候选 = 该包的全部发布事实 + 该包的全部 `rfq/promised`（都按事实 ts 比较）；
  //   · `subject` 取**事实 ts 最晚的那条发布事实**（并列时比 rev、再比 due_ts —— 与入参顺序无关）；
  //   · 名册取该包全部发布事实的**并集**（谁被邀请过都在里面，不因为发了两次就漏一家）。
  const groups = new Map()
  for (const row of rfqRows) {
    if (!groups.has(row.rfq_id)) groups.set(row.rfq_id, { rows: [], invited: new Set() })
    const bucket = groups.get(row.rfq_id)
    bucket.rows.push(row)
    for (const who of row.invited) bucket.invited.add(who)
  }
  const rankOf = (row) => [isoMs(row.ts) ?? -1, numOrNull(row.rev) ?? -1, row.due_ts ?? '']
  const laterPublished = (candidate, current) => {
    if (current === null) return true
    const left = rankOf(candidate)
    const right = rankOf(current)
    if (left[0] !== right[0]) return left[0] > right[0]
    if (left[1] !== right[1]) return left[1] > right[1]
    return byLex(left[2], right[2]) > 0
  }
  for (const [rfqId, bucket] of groups) {
    if (bucket.rows.length > 1) {
      notes.push(`rfqs[${rfqId}] 有 ${bucket.rows.length} 条发布事实 → **合成一行**`
        + '（due/subject 取事实 ts 最晚的那条，名册取并集）')
    }
  }

  const items = [...groups.entries()].map(([rfqId, bucket]) => {
    const latest = bucket.rows.reduce((acc, row) => (laterPublished(row, acc) ? row : acc), null)
    // 事实候选：**该包全部发布事实**上的 quote_by、以及该包上每一条 rfq/promised 的 due_at
    let winner = null
    for (const row of readRows(bucket.rows).rows) {
      if (isoMs(row.due_ts) === null) continue
      const candidate = factOf('rfq/published', row.ts, row.due_ts)
      if (laterFact(candidate, winner)) winner = candidate
    }
    for (const promise of promises.rows.filter((item) => item.rfq_id === rfqId)) {
      if (isoMs(promise.due_at) === null) continue
      const candidate = factOf('rfq/promised', promise.ts, promise.due_at)
      if (laterFact(candidate, winner)) winner = candidate
    }
    const dueMs = winner === null ? null : isoMs(winner.due)
    const remaining = (dueMs === null || asOfMs === null) ? null : round3((dueMs - asOfMs) / 1000)
    const severity = severityOf(remaining)
    const roster = rosterOf({ rfq_id: rfqId, invited: [...bucket.invited].sort(byLex) }, attributed, owner)
    const subject = latest.subject
      ?? `${rfqId} rev=${latest.rev ?? '?'}${latest.items === null ? '' : `（清单 ${latest.items} 条）`}`
    const dueBasis = winner === null
      ? `本视角投影里没有可解析的回文时限事实（\`rfq/published.quote_by\` / \`rfq/promised.due_at\` 都缺）`
        + ' → 不给 due_ts 与剩余时长（不猜时限）'
      : `due_ts=${winner.due} 取自事实 \`${winner.kind}\`（该事实 ts=${winner.ts ?? '（无 ts）'}）`
        + `；as_of=${asOf ?? '（无）'}（本视角投影里最大的事实 ts）—— 事实时间戳之差，**不取墙钟**`
    const item = { rfq_id: rfqId, subject, due_ts: winner === null ? null : winner.due,
      due_basis: dueBasis, responded: roster.responded, silent: roster.silent,
      overdue: remaining !== null && remaining < 0, remaining_seconds: remaining, severity,
      next_action: '', blocked_by: blockedOf(channel) }
    item.next_action = nextOf(options, view === '' ? '(缺 view)' : view, item)
    return item
  })

  // 排序口径（**确定性**，与入参顺序无关）：来不及的在最前（严重度权重），同权重按包 id 字典序
  const ordered = [...items].sort((left, right) =>
    ((SEVERITY_RANK[left.severity] ?? 9) - (SEVERITY_RANK[right.severity] ?? 9))
    || byLex(left.rfq_id, right.rfq_id))
  const shown = ordered.slice(0, options.max_items)
  const bySeverity = emptySeverity()
  for (const item of ordered) bySeverity[item.severity] = (bySeverity[item.severity] ?? 0) + 1
  if (ordered.length > shown.length) {
    notes.push(`RFQ 共 ${ordered.length} 条，上限 ${options.max_items} → 展示前 ${shown.length} 条，`
      + `被丢 ${ordered.length - shown.length} 条（omitted 照实报）`)
  }
  const counts = { rfq: { found: ordered.length, shown: shown.length, omitted: ordered.length - shown.length },
    facts: { rfqs: rfqs.rows.length, quotes: quotes.rows.length, promises: promises.rows.length },
    invited: ordered.reduce((sum, item) => sum + item.responded.length + item.silent.length, 0),
    responded: ordered.reduce((sum, item) => sum + item.responded.length, 0),
    silent: ordered.reduce((sum, item) => sum + item.silent.length, 0),
    unattributed_quotes: unattributed.length, by_severity: bySeverity,
    shown: shown.length, omitted: ordered.length - shown.length }
  if (ordered.length === 0) {
    notes.push('投影里有事实行，但没有**发布过的包**（`rfq/published`）→ 不给任何条目（no-signal）')
    return shape(view, asOf, [], options, channel, { counts, notes, reason: 'no-signal' })
  }
  return shape(view, asOf, shown, options, channel, { counts, notes, reason: null })
}

// ---------------------------------------------------------------------------
// 登记承诺（**只产载荷形状**：本插件不写任何东西，落盘由宿主、落账本由 Python 侧）
// ---------------------------------------------------------------------------
/** 与提交面同一个 id 口径：同一份（包 + 发言人 + 时限 + 原话）→ 同一个待办件 id（幂等可观察）。 */
const promiseId = (view, rfqId, by, dueAt, note) =>
  `rp-${view}-${sha256(`${rfqId}\u0000${by}\u0000${dueAt}\u0000${note}`).slice(0, 12)}`

/**
 * 登记一条\"承诺回文时限\"（**不改任何判定状态**，因此不构成\"发信\"也不构成\"批准\"）：返回一条
 * **待办件载荷** + 说明性 `next_action`。真正的落盘在宿主（0600 待办件）、真正的落账本在
 * `tools/rfq-promise.py`（唯一写账本者，落 `rfq/promised`）。
 */
export const promiseOf = (payload, request, config) => {
  const options = resolvedOptions(config)
  const req = isPlain(request) ? request : {}
  const view = textOrNull(req.view, 32) ?? (isPlain(payload) ? (textOrNull(payload.view, 32) ?? '') : '')
  const rfqId = textOrNull(req.rfq_id, ID_LIMIT) ?? ''
  const by = typeof req.promise_by === 'string' ? req.promise_by.trim() : ''
  const dueAt = typeof req.due_at === 'string' ? req.due_at.trim() : ''
  const note = typeof req.note === 'string' ? req.note : ''
  const bytes = Buffer.byteLength(note, 'utf8')
  const digest = `sha256:${sha256(note)}`
  const refuse = (code, next_action) => ({ ok: false, code, view, rfq_id: rfqId, promise_by: by,
    due_at: dueAt, note_sha256: digest, bytes, id: '', record: null, next_action })
  if (!isPlain(payload)) {
    return refuse('payload-unusable', '先让宿主把本视角投影交给插件（没有事实就登记不了承诺）')
  }
  if (view === '') return refuse('view-unknown', '给出视图名（这条承诺属于哪一侧）')
  if (!ACTOR_RE.test(by)) {
    return refuse('actor-malformed',
      '发言人必须显式写 human:<人名> 或 agent:<组件>（**不许匿名**：谁承诺的回文时限必须可追）')
  }
  if (rfqId === '') {
    return refuse('rfq-not-found', '给出目标包 id（形如 pkg-g1）；本插件不猜你想给哪个包承诺')
  }
  if (isoMs(dueAt) === null) {
    return refuse('due-at-malformed',
      '承诺回文时限必须是可解析的 ISO8601 事实格式（形如 2026-09-25T00:00:00Z）—— 不猜、不做时区换算')
  }
  const derived = statusOf(payload, config)
  if (!derived.rfqs.some((item) => item.rfq_id === rfqId)) {
    return refuse('rfq-not-found',
      `包 ${rfqId} 不在**本视角投影**的 RFQ 列表里（可能写错、或不属于本视角）→ 不改任何状态、`
      + `**账本零新增**；看 ${options.route_prefix}/${view}/deadlines/ 列出的真 id 再登记`)
  }
  if (note.trim() === '') {
    return refuse('empty-note', '把承诺内容用自己的话写进 note（空内容不落盘：没有内容就没有事实）')
  }
  if (bytes > NOTE_MAX_BYTES) {
    return refuse('note-too-long', `原话 ${bytes} 字节 > 上限 ${NOTE_MAX_BYTES}：请写短一点（宿主不截断、不静默丢）`)
  }
  const id = promiseId(view, rfqId, by, dueAt, note)
  const record = {
    schema: PROMISE_SCHEMA, kind: PROMISE_KIND, view, rfq_id: rfqId, promised_by: by,
    requested_action: PROMISE_ACTION,   // **只可能是承诺**：本插件不存在发信/批准这类动作
    due_at: dueAt, note, note_sha256: digest, bytes, submitted_at: '',
    note_text: '宿主只落本条 0600 待办件（含发言人 + 承诺回文时限 + RFQ id + sha256）；'
      + '不写账本、不发信、不改任何判定状态；时间由 Python 侧按 --now 落账',
  }
  return {
    ok: true, code: 'accepted', view, rfq_id: rfqId, promise_by: by, due_at: dueAt,
    note_sha256: digest, bytes, id, record,
    next_action: `跑 ${PROMISE_CONSUMER} 消费待办件（**唯一落账本者**，落一条 \`${PROMISE_EVENT}\`：`
      + '只记\"谁在什么时候为哪个包承诺了什么回文时限\"，body 不含正文与凭据）；待办件移入 applied/；'
      + '账本里**不会**因此多出一条报价，也不会有任何\"已通知\"的记录（本插件发不出东西）',
  }
}

export function apply(ctx, config) {
  const options = resolvedOptions(config)
  const handle = {
    requests: ['status', 'promise'],   // 只声明事实：别的都不是服务面（没有发信/批准类方法）
    status: (payload) => statusOf(payload, config),
    // 登记承诺回文时限：只吃白名单载荷，产出**唯一的**待办件形状（落盘由宿主、落账本由 Python 侧）
    promise: (payload, request) => promiseOf(payload, request, config),
    meta: () => ({
      engine: ENGINE, engine_note: ENGINE_NOTE, due_clock: DUE_CLOCK, due_basis_note: DUE_BASIS_NOTE,
      ignored_now_inputs: [...IGNORED_NOW_INPUTS], sections: [...SECTIONS],
      degraded_reasons: [...DEGRADED_REASONS], severities: [...SEVERITIES], rfq_keys: [...RFQ_KEYS],
      private_list_views: [...PRIVATE_LIST_VIEWS], promise_codes: [...PROMISE_CODES],
      promise_action: PROMISE_ACTION, kind: PROMISE_KIND, schema: PROMISE_SCHEMA, event: PROMISE_EVENT,
      no_send_note: NO_SEND_NOTE,
      bounds: { max_items: options.max_items, section_max: SECTION_MAX, list_max: LIST_MAX,
        note_max_bytes: NOTE_MAX_BYTES, critical_seconds: CRITICAL_SECONDS, soon_seconds: SOON_SECONDS },
      can_send: false,     // 机器可读的\"发不出去\"：本插件的服务面里没有发信/提醒方法
      can_approve: false,  // 也批不了任何东西
    }),
    config: () => ({ max_items: options.max_items, route_prefix: options.route_prefix,
      note_max_bytes: NOTE_MAX_BYTES, due_clock: DUE_CLOCK, critical_seconds: CRITICAL_SECONDS,
      soon_seconds: SOON_SECONDS }),
  }
  ctx.provide('rfqDeadline', handle)
}

export function disposer() {
  return () => {}
}

/** fixture：纯读取（A5 会连跑两次比对字节，故不得有任何副作用）。 */
export const fixture = {
  sample: (handle) => ({
    all: handle.status({
      view: 'contractor',
      as_of: '2026-09-21T12:00:00Z',
      channel: { kind: 'smtp', configured: false, connected: false, available: false,
        reason: 'mail-transport-unavailable', next_action: '配凭据', source: 'fixture' },
      rfqs: [
        { rfq_id: 'pkg-g1', rev: 2, ts: '2026-09-21T10:00:00Z', due_ts: '2026-09-25T00:00:00Z',
          items: 2, invited: ['supplier:g1', 'supplier:g2'] },
        { rfq_id: 'pkg-g2', rev: 1, ts: '2026-09-21T11:00:00Z', due_ts: '2026-09-21T11:30:00Z',
          suppliers: ['supplier:g1'] },
      ],
      quotes: [{ rfq_id: 'pkg-g1', supplier: 'supplier:g2', ts: '2026-09-21T11:00:00Z' }],
      promises: [{ rfq_id: 'pkg-g2', due_at: '2026-09-21T13:00:00Z', ts: '2026-09-21T11:30:00Z',
        actor: 'human:liangzi' }],
    }),
    empty: handle.status({ view: 'contractor' }),
    private: handle.status({ view: 'supplier', as_of: '2026-09-21T12:00:00Z',
      rfqs: [{ rfq_id: 'pkg-g1', rev: 2, ts: '2026-09-21T10:00:00Z', due_ts: '2026-09-25T00:00:00Z',
        invited: ['supplier:g1'] }] }),
    promise: handle.promise({ view: 'contractor', as_of: '2026-09-21T12:00:00Z',
      rfqs: [{ rfq_id: 'pkg-g1', rev: 2, ts: '2026-09-21T10:00:00Z', due_ts: '2026-09-25T00:00:00Z' }] },
    { view: 'contractor', rfq_id: 'pkg-g1', promise_by: 'human:liangzi',
      due_at: '2026-09-26T00:00:00Z', note: '周五前一定回' }),
    meta: handle.meta(),
  }),
}
