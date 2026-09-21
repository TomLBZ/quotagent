/**
 * 进树模块：`advice-panel` —— **AI agent 决策建议层**（domain 插件）。
 *
 * 要解决的痛点（用户 2026-09-21 原始要求里的「AI agent 的决策建议」一条；痛点在
 * `docs/work/plans/ux-双方痛点与交互需求.md.txt` §2「功能对人不可达」）：承包商与供应商
 * 在报价过程中**看得到事实但不知道下一步该干什么**。本插件把「下一步」变成一条条**可复制的
 * 命令/路由**，每一条都能追回投影里的真数据。
 *
 * 分工（不重复造轮子）：
 *   · Py 侧服务（`services/rfq.py` 的截止、`services/approval.py` 的人工门、`services/compare.py`
 *     的口径、`services/mail_transport.py` 的传输状态）：**判定**与**事实**的唯一真源；
 *   · `host/modules/webui.mjs`：把**本视角自己的**行/快照投影成下面那份**白名单载荷**
 *     （私域键的行整行跳过，跳过条数照实报）；
 *   · 本插件：**不改判定、不读账本、不写任何东西、不联网、不调模型** —— 只对调用方给的
 *     结构化载荷做一次确定性的规则派生。
 *
 * 【诚实分层（本插件最重要的一条纪律）】
 * 这是**确定性规则**建议层，**不是模型**：
 *   · 输出里恒有 `engine: "rules"` 与 `engine_note`（"本页建议由确定性规则从投影/快照派生，
 *     不含模型推测"）—— 页面照抄这两项，任何地方都不许把规则包装成"AI 推测"；
 *   · 每条建议 `basis` **非空**且指向载荷里的真键（形如 `deadlines[pkg-1].due_at` 或 `as_of`）；
 *   · **没有可分的数据就不给建议**：空载荷 / 无可判项 → `degraded:true` + 有名 `reason` +
 *     `items:[]`；数据齐但确实没有可建议项 → 同样 `degraded:true`（`no-signal`）。
 *     两种情形都**不编**一条"看起来有用"的建议。
 *
 * 规则（五条，各自可解释、可复算；常量都在本文件里，改口径就改这里 + 门）：
 *   ① `expiry`  截止临近/已过期 —— 需要 `as_of`（系统已知的最新事实时刻，由调用方从**账本事实**
 *      的 ts 派生，**不是墙钟**）；`due_at - as_of <= expiry_soon_hours` → medium，`<= 0` → high；
 *   ② `spread`  比价区间异常 —— 吃 `ranking.rows`（**`bid-heuristics` 的输出**，同口径的无量纲
 *      得分）；**按行项目分组**（不同行项目的单价不可比，混在一起算极差会把"哪家报价好"变成
 *      "哪个行项目贵"）；组内得分极差 ≥ `spread_points` → medium，≥ 2× 阈值 → high；
 *   ③ `gate`    等待人工门的项 —— 每条给**真实可复制的 CLI**（`src/quotagent/g1side.py`
 *      的分阶段命令或 `tools/g1-walkthrough.py`）；明确写着**浏览器不能代签**；
 *   ④ `channel` 凭据缺口导致的阻塞 —— 通道 `available:false` → high，`next_action` **照抄**
 *      声明里的真值（**不得假装能发**），`blocked_by` 填真原因；
 *   ⑤ `rank-up` 供应商侧"如何提升排名" —— 复用 `bid-heuristics` 的**贡献分解**（`focus`/
 *      `potential`/`hint`），只给无量纲的贡献点 + 一条**真路由**（`?w_<分量>=1`）。
 *
 * 边界（纪律，逐条都有 `host/t281-advice-gate.mjs` 的断言看着）：
 *   · **不读账本**：只吃调用方给的结构化载荷（连 `fs` 都不 import —— 静态扫描断言）；
 *   · **零写面**：不写文件、不写账本、不订阅事件、不注册定时器、不起子进程、不联网、不调模型；
 *   · **确定性**：不取墙钟（ISO 解析是纯字符串/整数运算，`Date` 一次都不用）、不用随机数；
 *     同输入两次输出**逐字节一致**，且与入参的**对象键序、条目顺序**无关（先按稳定键排序）；
 *   · **有界**：一次最多 `max_items` 条建议（夹取区间 [1, 200]），被丢条数在 `omitted`
 *     如实报出（`truncated=true`）；
 *   · **不编造**：认不出的 / 缺关键字段的条目**不进建议**（照实记进 `notes`/`counts`），
 *     既不补默认值也不拿"0"凑数；
 *   · **降级可分辨**：`degraded:true` + 有名 `reason`（闭合集合），正常时 `degraded:false`
 *     + `reason:null`；两种"空"（载荷不能用 vs 数据齐但没有可建议项）是**两个不同的 reason**；
 *   · **私域零泄漏**：只读白名单键（`ref`/`due_at`/`kind`/`approval_id`/`scope`/`code`/`score`/
 *     `focus`/`potential`/`hint`/`name`/`available`/`reason`/`next_action`），条目上多出来的键
 *     （`reserve_price`/`cost_model`/`private:*` …）**读都不读** → 加了私域键的输出与不加
 *     **逐字节一致**；文本字段过控制字符清洗 + 截断（不回显任意字节）。
 */
import { constant, number, object } from '../lib/std-schema.mjs'

export const name = 'advice-panel'
export const inject = []                 // 纯函数插件：载荷由调用方给（宿主只读投影/快照）
export const builtin = []
export const usedServices = []
export const provides = ['advicePanel']

/**
 * 引擎自述：`rules` = **确定性规则**（不是模型、不是推测）。
 * 页面与 JSON 都照抄这一项：任何地方都不许把规则派生包装成"AI 判的"。
 */
export const ENGINE = 'rules'

/** 页面上必须原样出现的一句话（诚实分层的最小可见形态）。 */
export const ENGINE_NOTE = '本页建议由确定性规则从投影/快照派生，不含模型推测'

export const Config = object({
  max_items: number().default(20),          // 一次返回的建议条数上限（夹取区间 [1, 200]）
  expiry_soon_hours: number().default(96),  // 截止「临近」阈值（小时；0 ⇒ 只报已过期）
  spread_points: number().default(25),      // 比价得分极差阈值（无量纲贡献点，0..100）
  deterministic: constant(true),            // const 键：不得翻转（A3 负控）
})

/** 五条规则（**顺序即契约**：同严重度下按这个顺序排）。 */
export const RULES = [
  { rule: 'expiry', label: '截止临近或已过期' },
  { rule: 'spread', label: '比价区间异常（得分极差过大）' },
  { rule: 'gate', label: '等待人工门' },
  { rule: 'channel', label: '凭据缺口导致的阻塞' },
  { rule: 'rank-up', label: '如何提升排名（供应商侧）' },
]

export const SEVERITIES = ['high', 'medium', 'low']
const SEVERITY_RANK = { high: 0, medium: 1, low: 2 }

/** 降级原因的**闭合集合**（门据此断言"降级是有名的，不是含糊的"）。 */
export const DEGRADED_REASONS = ['payload-not-an-object', 'no-usable-inputs', 'no-signal']

/** 载荷里被读的段（白名单；门断言"输出只可能来自这几段"）。 */
export const SECTIONS = ['deadlines', 'gates', 'ranking', 'channels']

/** commit 面（永不给浏览器的动作）：这些 scope 的人工门一律 high。 */
export const COMMIT_SCOPES = ['quote.submit', 'award.commit', 'po.issue', 'change.approve']

/**
 * 人工门 → **真实 CLI**（逐条来自 `docs/work/deployment-manual.md` §2 与 `src/quotagent/g1side.py`
 * 的阶段表；门里会断言这些路径在仓库里真的存在）。
 */
export const GATE_COMMANDS = {
  'quote.submit': 'PYTHONPATH=src python3 -m quotagent.g1side supplier tmp/manual 2   # 报价提交（过人工门，人工签署）',
  'award.commit': 'PYTHONPATH=src python3 -m quotagent.g1side contractor tmp/manual 4   # 授标承诺（人工签署）',
  'po.issue': 'PYTHONPATH=src python3 -m quotagent.g1side contractor tmp/manual 4   # 发 PO（人工签署）',
  'change.approve': 'PYTHONPATH=src python3 -m quotagent.g1side contractor tmp/manual 4   # 变更批准生效',
}
export const GATE_COMMAND_FALLBACK = 'python3 tools/g1-walkthrough.py   # 双人流程走查（人工门只在终端；'
  + '单侧分阶段：PYTHONPATH=src python3 -m quotagent.g1side <side> <dir> <阶段>）'

/** 截止 → 真实 CLI（改包 = 承包商升版再分发；按新版本报价 = 供应商侧）。 */
const DEADLINE_COMMANDS = {
  contractor: 'PYTHONPATH=src python3 -m quotagent.g1side contractor tmp/manual 2   # 升版 + 再分发（deadlines 随新版本写入）',
  supplier: 'PYTHONPATH=src python3 -m quotagent.g1side supplier tmp/manual 2   # 按最新版本报价（过人工门）',
}
const DEADLINE_COMMAND_DEFAULT = GATE_COMMAND_FALLBACK

/** 建议条数上限的夹取区间与回落值（非有限数 → 默认；越界 → 夹取）。 */
const ITEM_FLOOR = 1
const ITEM_CEILING = 200
const ITEM_FALLBACK = 20
/** 文本字段的字符上限（回显回来的任意字节必须有界）。 */
const TEXT_MAX = 240
/** 每段最多读入的条目数（有界：调用方给一堆也不把响应撑大）。 */
const SECTION_MAX = 32

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
 * 只认 `YYYY-MM-DD`、`YYYY-MM-DDTHH:MM[:SS[.ms]]Z`（大小写不敏感、允许空格分隔）。
 * 认不出 → null（"取不到"，不猜）。
 */
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?Z?$/
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

/** 固定 1 位小数（小时数展示用；`-0` 归一成 0，避免混进 JSON）。 */
const round1 = (value) => {
  const rounded = Math.round(value * 10) / 10
  return rounded === 0 ? 0 : rounded
}

/** 显式字典序比较器（排序不依赖默认比较的隐含规则，也不受 locale 影响）。 */
const byLex = (left, right) => (left < right ? -1 : (left > right ? 1 : 0))

const clampLimit = (value) => {
  const amount = numOrNull(value)
  if (amount === null) return ITEM_FALLBACK
  return Math.min(ITEM_CEILING, Math.max(ITEM_FLOOR, Math.floor(amount)))
}
/** 阈值：非有限数回落默认；负数夹到 0（0 = 该规则不报"临近"，仍报"已过期"）。 */
const clampThreshold = (value, fallback, ceiling) => {
  const amount = numOrNull(value)
  if (amount === null) return fallback
  return Math.min(ceiling, Math.max(0, amount))
}

const resolvedOptions = (config) => {
  const cfg = isPlain(config) ? config : {}
  return Object.freeze({
    max_items: clampLimit(cfg.max_items),
    expiry_soon_hours: clampThreshold(cfg.expiry_soon_hours, 96, 1000000),
    spread_points: clampThreshold(cfg.spread_points, 25, 1000),
  })
}

/** 条目 → 建议（键序即契约；见文件头的"边界"）。 */
const buildItem = (id, rule, severity, title, why, basis, next_action, blocked_by = '') =>
  ({ id, rule, severity, title, why, basis, next_action, blocked_by })

/** 一条"不派生"的诚实说明（有界、无原始值）。 */
const note = (text) => text

// ---------------------------------------------------------------------------
// 载荷读取（白名单键；条目上多出来的键**读都不读**）
// ---------------------------------------------------------------------------
const readDeadlines = (raw) => {
  const out = []
  const skipped = { shape: 0, incomplete: 0 }
  if (raw === undefined || raw === null) return { rows: out, skipped, present: false }
  if (!Array.isArray(raw)) return { rows: out, skipped: { ...skipped, shape: 1 }, present: true }
  for (const entry of raw.slice(0, SECTION_MAX)) {
    if (!isPlain(entry)) { skipped.shape += 1; continue }
    const ref = textOrNull(entry.ref, 80)
    const dueAt = textOrNull(entry.due_at, 40)
    if (ref === null || dueAt === null) { skipped.incomplete += 1; continue }
    out.push({ ref, due_at: dueAt, kind: textOrNull(entry.kind, 32) ?? 'deadline' })
  }
  return { rows: out, skipped, present: true }
}

const readGates = (raw) => {
  const out = []
  const skipped = { shape: 0, incomplete: 0 }
  if (raw === undefined || raw === null) return { rows: out, skipped, present: false }
  if (!Array.isArray(raw)) return { rows: out, skipped: { ...skipped, shape: 1 }, present: true }
  for (const entry of raw.slice(0, SECTION_MAX)) {
    if (!isPlain(entry)) { skipped.shape += 1; continue }
    const id = textOrNull(entry.approval_id, 64)
    if (id === null) { skipped.incomplete += 1; continue }
    out.push({ approval_id: id, scope: textOrNull(entry.scope, 64) ?? '', ref: textOrNull(entry.ref, 80) ?? '' })
  }
  return { rows: out, skipped, present: true }
}

const readRanking = (raw) => {
  const out = []
  const skipped = { shape: 0, incomplete: 0 }
  const list = Array.isArray(raw) ? raw : (isPlain(raw) && Array.isArray(raw.rows) ? raw.rows : null)
  if (list === null) return { rows: out, skipped, present: raw !== undefined && raw !== null }
  for (const entry of list.slice(0, SECTION_MAX)) {
    if (!isPlain(entry)) { skipped.shape += 1; continue }
    const code = textOrNull(entry.code, 64)
    const score = numOrNull(entry.score)
    if (code === null || score === null) { skipped.incomplete += 1; continue }
    out.push({ code, item: textOrNull(entry.item, 64) ?? '(未给行项目)', score,
      focus: textOrNull(entry.focus, 32), potential: numOrNull(entry.potential) ?? 0,
      hint: textOrNull(entry.hint, TEXT_MAX) ?? '' })
  }
  return { rows: out, skipped, present: true }
}

const readChannels = (raw) => {
  const out = []
  const skipped = { shape: 0, incomplete: 0 }
  if (raw === undefined || raw === null) return { rows: out, skipped, present: false }
  if (!Array.isArray(raw)) return { rows: out, skipped: { ...skipped, shape: 1 }, present: true }
  for (const entry of raw.slice(0, SECTION_MAX)) {
    if (!isPlain(entry)) { skipped.shape += 1; continue }
    const label = textOrNull(entry.name, 48)
    if (label === null || typeof entry.available !== 'boolean') { skipped.incomplete += 1; continue }
    out.push({ name: label, available: entry.available, reason: textOrNull(entry.reason, 80) ?? '',
      next_action: textOrNull(entry.next_action, TEXT_MAX) ?? '' })
  }
  return { rows: out, skipped, present: true }
}

// ---------------------------------------------------------------------------
// 规则派生
// ---------------------------------------------------------------------------
/** ① 截止临近/已过期（要 `as_of`；没有 `as_of` 就**不猜**，只记一条说明）。 */
const expiryItems = (deadlines, asOfMs, asOf, options, view, notes) => {
  const items = []
  const upcoming = []
  for (const entry of deadlines) {
    const dueMs = isoMs(entry.due_at)
    if (dueMs === null) { notes.push(note(`deadlines[${entry.ref}].due_at 不是可解析的时刻 → 该条不派生建议（不猜）`)); continue }
    if (asOfMs === null) { upcoming.push(entry.ref); continue }
    const hoursLeft = round1((dueMs - asOfMs) / 3600000)
    const expired = hoursLeft <= 0
    if (!expired && !(options.expiry_soon_hours > 0 && hoursLeft <= options.expiry_soon_hours)) continue
    items.push(buildItem(
      `expiry:${entry.ref}`, 'expiry', expired ? 'high' : 'medium',
      expired ? `「${entry.kind}」已过期（${entry.ref}）` : `「${entry.kind}」临近截止（${entry.ref}）`,
      expired
        ? `截止时刻 ${entry.due_at} 已早于系统已知的最新事实时刻 ${asOf}（逾期约 ${Math.abs(hoursLeft)} 小时；`
          + `口径：due_at − as_of，as_of 取自本视角账本事实的 ts，不是本页的墙钟）`
        : `截止时刻 ${entry.due_at} 距系统已知的最新事实时刻 ${asOf} 只剩约 ${hoursLeft} 小时`
          + `（≤ 阈值 ${options.expiry_soon_hours} 小时）`,
      ['as_of', `deadlines[${entry.ref}].due_at`, `deadlines[${entry.ref}].kind`],
      DEADLINE_COMMANDS[view] ?? DEADLINE_COMMAND_DEFAULT,
      view === 'supplier'
        ? '供应商侧不能改包截止时间：只能等承包商升版后按新版本报价（本页只读这个事实）'
        : (expired ? '过期包的报价不得再被比较（services/quotes.py：superseded 报价不进排序）' : ''),
    ))
  }
  if (asOfMs === null && upcoming.length > 0) {
    notes.push(note(`有 ${upcoming.length} 条截止，但没有 as_of（系统已知的最新事实时刻）→ 不派生有效期建议（不猜时刻）`))
  }
  return items
}

/** ② 比价区间异常（**按行项目分组**：不同行项目的单价不可比）。 */
const spreadItems = (ranking, options, view) => {
  const items = []
  const groups = new Map()
  for (const row of ranking) {
    if (!groups.has(row.item)) groups.set(row.item, [])
    groups.get(row.item).push(row)
  }
  for (const item of [...groups.keys()].sort(byLex)) {
    const rows = [...groups.get(item)].sort((left, right) => byLex(left.code, right.code))
    if (rows.length < 2) continue
    // 极值取"分数最高/最低"；同分时取代号字典序最小的一条（确定性，不靠到达顺序）
    const top = rows.reduce((acc, row) => (row.score > acc.score ? row : acc), rows[0])
    const bottom = rows.reduce((acc, row) => (row.score < acc.score ? row : acc), rows[0])
    const spread = Math.round((top.score - bottom.score) * 1000) / 1000
    if (spread < options.spread_points) continue
    items.push(buildItem(
      `spread:${item}`, 'spread', spread >= options.spread_points * 2 ? 'high' : 'medium',
      `比价区间异常：${item} 组内得分极差 ${spread} 分`,
      `行项目「${item}」内 ${rows.length} 个候选中最高 ${top.code}=${top.score}、最低 ${bottom.code}=${bottom.score}，`
        + `极差 ${spread} ≥ 阈值 ${options.spread_points} —— 区间可能不可比或存在异常项`
        + `（得分是 bid-heuristics 同口径的**无量纲**贡献点，越高越前）`,
      [`ranking[${top.code}].score`, `ranking[${bottom.code}].score`],
      `/quotagent/${view}/heuristics/   # 用「比价口径」页调权重看每项贡献分解（无量纲）`,
      '',
    ))
  }
  return items
}

/** ③ 等待人工门（每条的下一步都是**真 CLI**；浏览器不能代签这件事写在 blocked_by 里）。 */
const gateItems = (gates) => gates.map((entry) => {
  const scope = entry.scope === '' ? '(未声明 scope)' : entry.scope
  const commit = COMMIT_SCOPES.includes(entry.scope)
  return buildItem(
    `gate:${entry.approval_id}`, 'gate', commit ? 'high' : 'medium',
    `等待人工门：${scope}（${entry.approval_id}）`,
    `投影里 ${entry.approval_id} 的最后一条 approval/* 不是 granted/aborted，`
      + `即该 ${scope} 仍待批（ref=${entry.ref === '' ? '—' : entry.ref}）`,
    [`gates[${entry.approval_id}].scope`, `gates[${entry.approval_id}].ref`],
    GATE_COMMANDS[entry.scope] ?? GATE_COMMAND_FALLBACK,
    'commit 面不暴露给浏览器：宿主不能代签（ADR-0013 §3），批准只能由 human:* 在终端完成',
  )
})

/** ④ 凭据缺口导致的阻塞（`next_action` 照抄声明里的真值；**不得假装能发**）。 */
const channelItems = (channels) => channels
  .filter((entry) => entry.available === false)
  .map((entry) => buildItem(
    `channel:${entry.name}`, 'channel', 'high',
    `通道「${entry.name}」未连接`,
    `通道「${entry.name}」的声明是 available=false${entry.reason === '' ? '' : `（reason=${entry.reason}）`}`
      + ' —— 本页**不假装能发**：这个事实来自 Python 侧服务的真实状态，不是本页推断的',
    [`channels[${entry.name}].available`, `channels[${entry.name}].reason`],
    entry.next_action === ''
      ? '配置凭据：/quotagent/admin/config/   # 宿主只落待处理项，由 Python 侧消费后才生效'
      : entry.next_action,
    entry.reason === '' ? 'channel-unavailable' : entry.reason,
  ))

/** ⑤ 如何提升排名（**供应商侧**：复用 bid-heuristics 的贡献分解口径）。 */
const rankUpItems = (ranking, view) => {
  if (view !== 'supplier') return []
  const items = []
  for (const row of ranking) {
    if (row.focus === null) continue
    const potential = Math.round(row.potential * 1000) / 1000
    items.push(buildItem(
      `rank-up:${row.code}`, 'rank-up', potential >= 10 ? 'medium' : 'low',
      `如何提升排名：${row.code} 优先改善「${row.focus}」`,
      `贡献分解（与 bid-heuristics 同一个口径）：${row.hint === '' ? `该家现得分 ${row.score}` : row.hint}`
        + `（现得分 ${row.score}，做到本次候选集最好可再提约 ${potential} 分；得分越高排名越前）`,
      [`ranking[${row.code}].focus`, `ranking[${row.code}].potential`],
      `/quotagent/${view}/heuristics/?w_${row.focus}=1   # 只看该分量权重下的名次与贡献`,
      '',
    ))
  }
  return items
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------
const countsOf = (items, shown) => {
  const by = {}
  for (const severity of SEVERITIES) by[severity] = items.filter((item) => item.severity === severity).length
  return { generated: items.length, shown, omitted: items.length - shown, by_severity: by }
}

const shape = (view, asOf, items, options, extra) => ({
  source: 'advice-panel',
  engine: ENGINE,
  engine_note: ENGINE_NOTE,
  view,
  as_of: asOf,
  items,
  counts: extra.counts,
  absent: extra.absent,
  notes: extra.notes,
  rules: RULES.map((entry) => ({ rule: entry.rule, label: entry.label })),
  bounds: { max_items: options.max_items, expiry_soon_hours: options.expiry_soon_hours,
    spread_points: options.spread_points },
  truncated: extra.counts.omitted > 0,
  omitted: extra.counts.omitted,
  bounded: extra.counts.omitted > 0,
  degraded: extra.reason !== null,
  reason: extra.reason,
  privacy: { private_keys_read: false, model_calls: 0, network_calls: 0 },
})

/**
 * 纯函数：把一份**结构化投影/快照载荷**派生成一组确定性建议。
 * 只读入参（不写任何入参对象），不读账本/文件/墙钟/随机数、不联网、不调模型。
 */
export const adviseOf = (payload, config) => {
  const options = resolvedOptions(config)
  if (!isPlain(payload)) {
    return shape('', null, [], options,
      { counts: countsOf([], 0), absent: [...SECTIONS], notes: [], reason: 'payload-not-an-object' })
  }
  const view = textOrNull(payload.view, 32) ?? ''
  const asOf = textOrNull(payload.as_of, 40)
  const asOfMs = isoMs(asOf)

  const deadlines = readDeadlines(payload.deadlines)
  const gates = readGates(payload.gates)
  const ranking = readRanking(payload.ranking)
  const channels = readChannels(payload.channels)
  const notes = []
  for (const [label, section] of [['deadlines', deadlines], ['gates', gates], ['ranking', ranking], ['channels', channels]]) {
    if (section.skipped.shape > 0) notes.push(note(`${label} 有 ${section.skipped.shape} 段/条形状不对 → 整段跳过（不猜）`))
    if (section.skipped.incomplete > 0) notes.push(note(`${label} 有 ${section.skipped.incomplete} 条缺关键字段 → 不进建议（不补默认值）`))
  }
  const absent = []
  if (deadlines.rows.length === 0) absent.push('deadlines')
  if (gates.rows.length === 0) absent.push('gates')
  if (ranking.rows.length === 0) absent.push('ranking')
  if (channels.rows.length === 0) absent.push('channels')
  const inputs = { deadlines: deadlines.rows.length, gates: gates.rows.length,
    ranking_rows: ranking.rows.length, channels: channels.rows.length }
  const usableInputs = inputs.deadlines + inputs.gates + inputs.ranking_rows + inputs.channels
  // **没有可分的数据就不给建议**（空投影 → degraded + 有名 reason + 0 条）
  if (usableInputs === 0) {
    return shape(view, asOf, [], options, { counts: countsOf([], 0), absent, notes, reason: 'no-usable-inputs' })
  }

  const generated = [
    ...expiryItems(deadlines.rows, asOfMs, asOf, options, view, notes),
    ...spreadItems(ranking.rows, options, view),
    ...gateItems(gates.rows),
    ...channelItems(channels.rows),
    ...rankUpItems(ranking.rows, view),
  ]
  // 数据齐但确实没有可建议项 → 也是 degraded（`no-signal`），**不编**一条兜底建议
  if (generated.length === 0) {
    return shape(view, asOf, [], options,
      { counts: countsOf([], 0), absent, notes: [...notes, note('数据齐但没有触发任何规则 → 不给建议（no-signal）')],
        reason: 'no-signal' })
  }
  const ruleOrder = new Map(RULES.map((entry, index) => [entry.rule, index]))
  generated.sort((left, right) => (SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity])
    || (ruleOrder.get(left.rule) - ruleOrder.get(right.rule)) || byLex(left.id, right.id))
  const shown = generated.slice(0, options.max_items)
  if (generated.length > shown.length) {
    notes.push(note(`建议共 ${generated.length} 条，上限 ${options.max_items} → 展示前 ${shown.length} 条，`
      + `被丢 ${generated.length - shown.length} 条（omitted 照实报）`))
  }
  return shape(view, asOf, shown, options,
    { counts: countsOf(generated, shown.length), absent, notes, reason: null })
}

export function apply(ctx, config) {
  const options = { max_items: config?.max_items, expiry_soon_hours: config?.expiry_soon_hours,
    spread_points: config?.spread_points }
  const resolved = resolvedOptions(options)
  ctx.provide('advicePanel', {
    advise: (payload) => adviseOf(payload, options),
    /** 引擎自述 + 规则表（页面/接口自述用；不含任何载荷数据）。 */
    meta: () => ({ engine: ENGINE, engine_note: ENGINE_NOTE, rules: RULES.map((entry) => ({ ...entry })),
      severities: [...SEVERITIES], sections: [...SECTIONS], degraded_reasons: [...DEGRADED_REASONS],
      bounds: { max_items: resolved.max_items, expiry_soon_hours: resolved.expiry_soon_hours,
        spread_points: resolved.spread_points } }),
    config: () => ({ max_items: resolved.max_items, expiry_soon_hours: resolved.expiry_soon_hours,
      spread_points: resolved.spread_points }),
  })
}

export function disposer() {
  return () => {}
}

/** fixture：纯读取（A5 会连跑两次比对字节，故不得有任何副作用）。 */
export const fixture = {
  sample: (handle) => ({
    all: handle.advise({
      view: 'supplier',
      as_of: '2026-09-25T12:00:00Z',
      deadlines: [{ ref: 'pkg-1', due_at: '2026-09-26T00:00:00Z', kind: 'quote_by' }],
      gates: [{ approval_id: 'ap-0001', scope: 'quote.submit', ref: 'q-1' }],
      ranking: { rows: [
        { code: 'sup-A', item: 'L-001', score: 80, focus: 'price', potential: 20, hint: '优先改善「单价」' },
        { code: 'sup-B', item: 'L-001', score: 20, focus: null, potential: 0, hint: '没有可提升项' },
      ] },
      channels: [{ name: 'mail', available: false, reason: 'mail-smtp-unconfigured', next_action: '配置 SMTP' }],
    }),
    empty: handle.advise({ view: 'supplier' }),
    meta: handle.meta(),
  }),
}
