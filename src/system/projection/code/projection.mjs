/**
 * 进树模块：`projection` —— **视角投影服务**（WebUI 与 canary 分流的共同入口）。
 *
 * 为什么要独立成插件（而不是留在 `webui.mjs` 里）：用户 2026-09-21 指令要求"每个功能都由插件提供"，
 * 且"每个功能模块可分别独立演进"。投影是**一条独立的业务功能**（谁看到什么字段），把它抽出来之后：
 *   · `webui` 只负责 HTTP 与路由，`inject: ['ledgerView', 'projection']`；
 *   · canary 分流可以作用在**这条真实请求路径**上（base=当前投影，候选=提案产出的投影），
 *     每次 UI 请求都会回灌样本给判定器（见 `host/lib/canary-dispatch.mjs`）。
 *
 * 私域纪律（`INV-008` / `AC-TRUST-001`）：投影是"私域不出 realm"的**视图**那一层；抑制行的原因
 * **对外必须通用**（键名只留服务端审计，实测过一次泄漏）。
 */
import { array, object, string } from '../lib/std-schema.mjs'

export const name = 'projection'

export const inject = []

export const builtin = []

export const usedServices = []

export const provides = ['projection']

export const Config = object({
  // 只有这些键能出现在对外视图里（字段白名单是**结构**，不是"记得别泄露"）
  fields: array(string()).default(['seq', 'type', 'correlation_id', 'actor', 'ts', 'summary']),
})

/** 视角规则：事件类型白名单 + 私域键拒收名单。 */
export const VIEW_RULES = {
  contractor: {
    title: '承包商视角',
    // 承包商与供应商**各自只看自己那本账本**（结构性隔离：对方的账本不在本视角的读取路径上）。
    // 这张类型白名单是纵深防御的第一道；**它必须是本侧待办的全集** —— 少一个前缀，用 `publicRows`
    // 的消费者（页面子视图、插件面板）就会**静默丢行**（实测：`clarification/` 缺 ⇒ 承包商侧看不到
    // 自己的澄清工单行；`mail/` 缺 ⇒ 看不到邮件通道事实；`gate/nudged` 缺 ⇒ 看不到「谁催过这个门」）。
    // 本批补齐的三个前缀都是**已登记**的事件类型（`docs/design/05-events.md`），不新增事件、不放宽私域键。
    types: ['rfq/', 'quote/', 'compare/', 'award/', 'po/', 'change/', 'approval/', 'capacity/', 'terms/',
      'clarification/', 'mail/', 'gate/nudged'],
    privateKeys: [],
    fields: ['seq', 'type', 'correlation_id', 'actor', 'ts', 'summary'],
  },
  supplier: {
    title: '供应商视角',
    // 同上：`approval/`（我自己那本账本里的人工门：报价提交签名、价格让步）与 `mail/`（发给我的通知
    // 登记 + 通道不可用的如实拒绝）在补进来之前会**静默丢行**。
    types: ['rfq/', 'quote/', 'award/', 'po/', 'change/', 'clarification/', 'approval/', 'mail/'],
    privateKeys: ['calendar:private', 'cost_floor', 'markup_pct', 'profiles', 'bidders_private',
      'authorized_band', 'internal_notes'],
    fields: ['seq', 'type', 'correlation_id', 'ts', 'summary'],
  },
}

const PRIVATE_MARK = 'private'

const summarize = (body) => {
  if (!body || typeof body !== 'object') return ''
  const keys = Object.keys(body).filter((key) => !key.toLowerCase().includes(PRIVATE_MARK))
  return keys.slice(0, 6).map((key) => {
    const value = body[key]
    // `typeof null === 'object'`：必须判空，否则 Object.keys(null) 抛错（实测：单个 null 字段曾让整个 UI 进程退出）
    const text = (value !== null && typeof value === 'object')
      ? `{${Object.keys(value).slice(0, 3).join(',')}}` : String(value)
    return `${key}=${text.slice(0, 40)}`
  }).join(' ')
}

/**
 * 投影 + **服务端审计**。抑制原因对外通用（`private-field-suppressed`）——把私域键名写进
 * 对方视角的响应里本身就是一次泄漏（实测踩到过：`reason: private:cost_floor`）。
 *
 * 本批新增（`deliveries`/`realms`）：把**投递事实**（面向被邀供应商的 RFQ 包事实）接进同一次投影。
 * 不传 `deliveries` 的调用方行为**逐字节不变**（账本行一条不多、一条不少）。
 */
export function projectWithAudit(view, rows, { fields, deliveries, realms, maxPackages, maxItems } = {}) {
  const rule = VIEW_RULES[view]
  if (!rule) throw new Error(`[unknown-view] ${view}`)
  const base = fields ?? rule.fields
  // 投递信封只有**声明消费它的视角**才被读（其余视角：调用方连参数都不传 ⇒ 读都不读）
  const report = deliveries === undefined ? null
    : projectDeliveries(view, realms ?? [], deliveries, { maxPackages, maxItems })
  const audit = []
  const publicRows = [...rows, ...(report ? report.rows : [])]
    .filter((row) => rule.types.some((prefix) => String(row.type).startsWith(prefix)))
    .map((row) => {
      // 派生行（投递事实）额外放行 `rfq`：账本行没有这个键 ⇒ 既有输出逐字节不变
      const allow = row.derived === true ? [...base, ...DERIVED_FIELDS] : base
      const out = {}
      for (const field of allow) {
        if (row[field] !== undefined) out[field] = row[field]
      }
      out.summary = summarize(row.body)
      const serialized = JSON.stringify(out).toLowerCase()
      for (const secret of rule.privateKeys) {
        if (serialized.includes(secret.toLowerCase())) {
          audit.push({ seq: row.seq, type: row.type, suppressed_key: secret, view })
          return { seq: row.seq, type: row.type, suppressed: true, reason: 'private-field-suppressed' }
        }
      }
      return out
    })
  return { publicRows, audit, deliveries: report }
}

export function project(view, rows, options) {
  return projectWithAudit(view, rows, options).publicRows
}

// ==========================================================================================
// **RFQ 投递事实的视角可见性**（本批新增：修「供应商看不到自己的 RFQ 包」这个根因）
//
// 根因（实测）：`rfq/*` 事实**只落在发送方（承包商）realm 的账本里**（`rfq/published` 1 条、
// `rfq/distributed` 2 条），而供应商视角只读**自己那本账本**（结构性隔离：对方的账本不在本视角的读取
// 路径上）—— 供应商那本账本里 `rfq/*` **一条都没有**（实测 count=0/20 行，类型只有 quote/*、
// clarification/*、approval/*、negotiate/*、faq/*、mail/*）。后果：供应商看不到要报的包、看不到 @rev、
// 看不到报价截止、看不到改版 ⇒ 整条链的起点断了。
//
// 修法（**最小改动，且不放宽任何隔离**）：不跨读对方账本，而是读**投递信封**（发送方放到共享交换目录里
// 的那份交付件：`{delivered_to, rev, sent_at, spec}`，即真供应商进程在 g1 走查里读的同一份文件），
// 然后按 **发放对象（`delivered_to`）** 做**收件人作用域**过滤，再按下面的**字段级白名单**投影。
//
// 【字段级白名单（唯一真源；文档 `docs/design/21-rfq-delivery-visibility.md` 与门逐字引用同一份）】
//   面向**被邀供应商**（✓ 可见；每个都有实测出处）：
//     · `spec.package_id`   包 id（实测：`pkg-g1`）
//     · `rev`              版本 rev（实测：`1` / 改版后 `2`）—— 供应商看不到它就不知道在报哪一版
//     · `spec.deadlines.quote_by`   报价截止（实测：`2026-09-25T00:00:00Z`）
//     · `spec.deadlines.clarify_by` 澄清截止（实测：`2026-09-23T00:00:00Z`）
//     · `spec.items[].{item_id,code,qty,unit}` 行项目与数量（实测：`L-001/m/120`、`L-002/kg/480`，
//       改版后 `L-001` 的 qty 变 `150`）
//     · `spec.currency`     币种（EXCHANGE 类：`services/realm.py` 的 `DEFAULT_FIELD_CLASSES`）
//     · `sent_at`           发放时刻（**事实时间戳**，不是墙钟）
//     · 发放对象 **只出"我"这一个**（`recipient` = 本视角自己的身份；`delivered_to` 的**其他成员一个字都不出**，
//       连"另有几家"这种计数也不出 —— `bidders_private` 是业主私域）
//   承包商私域 / 他家供应商数据（✗ 读都不读；`DELIVERY_NEVER_READ` 是机检的"没读"清单）：
//     · `snapshot_hash`/`hash`/`payload_bytes`（版本锚与体积属发送方案卷细节）
//     · `envelopes`/`recipients`/`delivered_to` 的**其他成员**（他家供应商代号 = 竞标人名册）
//     · `cost_floor` / `reserve_price` / `cost_model` / `markup_pct` / `internal_score` /
//       `other_quotes`（比价基准、其他供应商的报价）/ `tco_weights` / `bidders_private` /
//       `internal_notes` / `authorized_band` / `profiles` / `calendar:private`
//     · `06-evaluation.json` / `11-audit-pack*.json` / `private/**`（承包商比价表与审计包）
//   纪律：白名单是**结构**（只把这些键搬进输出），不是"记得别泄露"；另有两道**结构性负控**（下面
//   `projectDeliveries` 里逐条实现）：① 输出串里出现**任何非我的发放对象** ⇒ 整条抑制 + 服务端审计；
//   ② 输出串里出现私域键名 ⇒ 整条抑制 + 服务端审计。两条都不把键名/代号写进对外视图。
//
// 为什么放在 `projection` 而不是新开一个插件：这正是"谁看到什么字段"这条功能的第 N 条规则，且
// 收件人作用域与字段白名单都必须在**同一次投影**里完成（分两处做就会有人忘掉其中一道）。
// ==========================================================================================
/** 消费**投递事实**的视角（其余视角对投递信封**读都不读**：`deliveries` 参数直接不传）。 */
export const DELIVERY_VIEWS = ['supplier']
/** 投递事实投影出来的行类型（复用已登记事件类型：这只是"我这一侧看到的包事实"，不是新事件）。 */
export const DELIVERY_ROW_TYPE = 'rfq/published'
/** 信封层**被读**的键（其余键读都不读）。`delivered_to` 只用于**成员判定**，绝不进输出。 */
export const ENVELOPE_KEYS_READ = ['rev', 'sent_at', 'delivered_to', 'spec']
/** `spec` 层**被读**的键。 */
export const SPEC_KEYS_READ = ['package_id', 'deadlines', 'items', 'currency']
/** 行项目层**被读**的键。 */
export const ITEM_KEYS_READ = ['item_id', 'code', 'qty', 'unit']
/** 输出里 `rfq` 对象的**键集**（恰 9 键；门逐字断言）。 */
export const RFQ_KEYS = ['package_id', 'rev', 'quote_by', 'clarify_by', 'currency', 'items', 'recipient',
  'delivered_at', 'basis']
/** 输出里每个行项目的**键集**（恰 4 键）。 */
export const RFQ_ITEM_KEYS = ITEM_KEYS_READ
/** 投递事实的来源自述（输出里如实标注，别让读者以为这是账本行）。 */
export const DELIVERY_BASIS = 'delivery-envelope'
/** 派生行额外放行的字段（只有派生行有 `rfq` 键；账本行不受影响 ⇒ 既有视图逐字节不变）。 */
export const DERIVED_FIELDS = ['rfq']
/** **读都不读**的键（含承包商私域与他人供应商数据）——取作闭合清单，门据此断言 0 命中。 */
export const DELIVERY_NEVER_READ = ['snapshot_hash', 'hash', 'payload_bytes', 'envelopes', 'recipients',
  'cost_floor', 'reserve_price', 'cost_model', 'markup_pct', 'internal_score', 'other_quotes',
  'tco_weights', 'bidders_private', 'internal_notes', 'authorized_band', 'profiles', 'calendar:private']
/** 降级原因的**闭合集合**（门据此断言"降级是有名的，不是含糊的"）。 */
export const DELIVERY_REASONS = ['view-not-a-delivery-consumer', 'no-identity', 'ambiguous-identity',
  'identity-malformed', 'payload-not-an-object', 'no-deliveries', 'no-deliveries-visible']
/** 服务端审计的抑制原因（**只在审计里**，不进对外视图）。 */
export const DELIVERY_SUPPRESSED = ['delivery-other-recipient-suppressed', 'delivery-private-key-suppressed']
/**
 * **行项目层**降级的**闭合原因集合**（与信封层的 `DELIVERY_REASONS` 分开：这一层的判据只有一个 ——
 * `spec.items[]` 里某一条**读不成一行**）。
 *
 * 为什么它必须存在（P33 修的缺陷）：修前这里是一句 `filter(isPlainDelivery)` —— 坏行**静默消失**，
 * 下游（外壳/页面/面板）拿到的是一个**已经干净**的数组 ⇒ `data-rfq-items-dropped` 恒为 `0`，
 * 屏幕上"这份包有 3 条行项目"与"信封里其实有 5 条、2 条读不出来"长得**一模一样**。
 * 现在：坏行照样**不进视图**（白名单一个字不放宽），但**丢了几条、为什么、怎么修**逐条报出。
 */
export const ITEM_DROP_REASONS = ['item-not-an-object']
/** 每个原因的**人话 + 修法**（读数要能直接照做；文案是常量，**不回显坏行的任何取值** —— 回显等于泄漏）。 */
export const ITEM_DROP_NOTES = {
  'item-not-an-object': {
    what: '不是对象（`null` / 字符串 / 数字 / 嵌套数组都算）—— 行项目必须是像 '
      + '`{item_id, code, qty, unit}` 这样的对象',
    fix: '在投递信封的 `spec.items[]` 里逐条给对象行；坏的那几条按 id 补成对象或直接删掉 '
      + '（不要把整段文本 / 一个大数组塞进 `items`）',
  },
}

const isPlainDelivery = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const IDENTITY_SHAPE = /^[a-z][a-z0-9-]*:\S+$/
const byRfq = (left, right) => (left.package_id < right.package_id ? -1
  : (left.package_id > right.package_id ? 1 : (left.rev === right.rev ? 0 : (left.rev < right.rev ? -1 : 1))))

/**
 * 投递信封 → **本视角可见的 RFQ 包事实**（收件人作用域 + 字段白名单 + 有界 + 确定性）。
 *
 * `realms` = 本视角**自己那本账本**里出现过的 realm（身份来源；0 个 ⇒ `no-identity`，多于 1 个 ⇒
 * `ambiguous-identity`：都**不给**任何包，fail-closed）；`envelopes` = 投递信封（数组）。
 * 纯函数：不读文件、不读墙钟、不随机（信封由调用方读进来；身份由调用方从自己的账本里取）。
 *
 * **坏行不静默丢**（P33）：`spec.items[]` 里读不成行的条目（非对象）**照样不进视图**（白名单与私域
 * 哨兵扫描一个字不放宽 —— 坏行不参与 `serialized`，不回显它的任何取值），但**丢了几条 / 为什么 /
 * 怎么修**逐条报出：`counts.items_dropped`、`packages[].items_dropped{,_reason,_reasons,_note}`、
 * 顶层 `item_degraded` / `item_dropped_note`。理由：修前一句 `filter(isPlainDelivery)` 让下游看到
 * 一个**已经干净**的数组 ⇒ 屏幕上的"3 条行项目"既可能是"信封里就 3 条"也可能是"5 条里坏了 2 条"。
 */
export function projectDeliveries(view, realms, envelopes, { maxPackages = 8, maxItems = 32 } = {}) {
  const rule = VIEW_RULES[view]
  const out = {
    view, identity: '', packages: [], rows: [],
    counts: { envelopes: 0, read: 0, visible: 0, skipped: 0, items_omitted: 0, items_dropped: 0 },
    bounds: { max_packages: maxPackages, max_items: maxItems },
    omitted: 0, bounded: false, truncated: false, degraded: false, reason: '',
    // **行项目层的降级读数**（P33）：`item_degraded` = 有坏行被跳过；`item_dropped_note` = 人话读数
    // （丢了几条 / 为什么 / 怎么修）。它**不是** `degraded` —— 整份视图没坏（好行照出），
    // 所以不拿它去冒充"整个视角降级"（那会让下游把好条也当没读到）。
    item_degraded: false, item_dropped_reason: '', item_dropped_note: '',
    whitelist: { envelope: ENVELOPE_KEYS_READ.slice(), spec: SPEC_KEYS_READ.slice(),
      item: ITEM_KEYS_READ.slice(), output: RFQ_KEYS.slice(), never_read: DELIVERY_NEVER_READ.slice() },
    privacy: { other_bidders_included: false, contractor_private_included: false,
      recipient_list_emitted: false, reads_wall_clock: false },
    audit: [],
  }
  const degrade = (reason, extra = {}) => ({ ...out, ...extra, degraded: true, reason })
  if (!rule || !DELIVERY_VIEWS.includes(view)) return degrade('view-not-a-delivery-consumer')
  const found = Array.isArray(realms) ? realms.filter((item) => typeof item === 'string' && item.trim() !== '')
    .map((item) => item.trim()) : []
  const distinct = [...new Set(found)].sort()
  if (distinct.length === 0) return degrade('no-identity')
  if (distinct.length > 1) return degrade('ambiguous-identity', { counts: { ...out.counts } })
  const me = distinct[0]
  if (!IDENTITY_SHAPE.test(me)) return degrade('identity-malformed')
  out.identity = me
  if (!Array.isArray(envelopes)) return degrade('payload-not-an-object', { identity: me })
  if (envelopes.length === 0) return degrade('no-deliveries', { identity: me })

  const counts = { ...out.counts, envelopes: envelopes.length }
  /** package_id → 该包被本视角看到的最新一版（rev 大者优先，同 rev 取 delivered_at 字典序大者）。 */
  const picked = new Map()
  for (const raw of envelopes) {
    if (!isPlainDelivery(raw) || !isPlainDelivery(raw.spec)) { counts.skipped += 1; continue }
    const spec = raw.spec
    const packageId = typeof spec.package_id === 'string' && spec.package_id.trim() !== ''
      ? spec.package_id.trim()
      : (typeof raw.package_id === 'string' ? raw.package_id.trim() : '')
    const to = (Array.isArray(raw.delivered_to) ? raw.delivered_to : [])
      .filter((who) => typeof who === 'string' && who.trim() !== '').map((who) => who.trim())
    if (packageId === '' || to.length === 0) { counts.skipped += 1; continue }
    counts.read += 1
    if (!to.includes(me)) continue                      // **只留发给我的那一份**（作用域：其余读都不读地丢掉）
    counts.visible += 1
    const rev = Number.isInteger(raw.rev) ? raw.rev : null
    const deadlines = isPlainDelivery(spec.deadlines) ? spec.deadlines : {}
    // ---- **行项目逐条读数**（P33，修前这里是一句静默的 `.filter(isPlainDelivery)`）------------------------
    // 坏行照样**不进视图**（下面 `rfq.items` 只由 `items` 构造 ⇒ 白名单/私域纪律一个字没松），
    // 但"丢了几条、为什么、怎么修"必须**当场读出来**：丢的是**条数**与**具名原因**，不是内容
    // （不回显坏行的取值 —— 那是把白名单外的东西搬到屏幕上）。
    const rawItems = Array.isArray(spec.items) ? spec.items : []
    const items = []
    const dropReasons = new Map()
    for (const item of rawItems) {
      if (isPlainDelivery(item)) { items.push(item); continue }
      const why = ITEM_DROP_REASONS[0]
      dropReasons.set(why, (dropReasons.get(why) ?? 0) + 1)
    }
    const itemsDropped = rawItems.length - items.length
    // 逐原因读数（闭合集合；今天的集合只有一个原因，形状按"可能不止一个"给）
    const dropBreakdown = [...dropReasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((left, right) => (left.reason < right.reason ? -1 : 1))
    const dropReason = dropBreakdown.length ? dropBreakdown[0].reason : ''
    const dropNote = itemsDropped
      ? `这份包的信封里 ${rawItems.length} 条行项目中有 ${itemsDropped} 条读不出来`
        + `（原因：${dropReason} —— ${ITEM_DROP_NOTES[dropReason].what}）⇒ 整条跳过并计数（不静默丢、不猜内容）；`
        + `视图里只出读得出来的 ${Math.min(items.length, maxItems)} 条。修法：${ITEM_DROP_NOTES[dropReason].fix}`
      : ''
    if (itemsDropped) counts.items_dropped += itemsDropped
    const text = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)
    const rfq = {
      package_id: packageId,
      rev,
      quote_by: text(deadlines.quote_by),
      clarify_by: text(deadlines.clarify_by),
      currency: text(spec.currency),
      items: items.slice(0, maxItems).map((item) => ({
        item_id: text(item.item_id) ?? '', code: text(item.code) ?? '',
        qty: typeof item.qty === 'number' && Number.isFinite(item.qty) ? item.qty : null,
        unit: text(item.unit) ?? '',
      })),
      recipient: me,                                    // 发放对象：**只出"我"**
      delivered_at: text(raw.sent_at),
      basis: DELIVERY_BASIS,
    }
    const serialized = JSON.stringify(rfq)
    // 结构性负控 ①：**任何非我的发放对象**出现在输出串里 ⇒ 整条抑制（其他人几个字都不出）
    if (to.some((who) => who !== me && serialized.includes(who))) {
      out.audit.push({ package_id: packageId, reason: DELIVERY_SUPPRESSED[0] })
      counts.skipped += 1
      continue
    }
    // 结构性负控 ②：私域键名出现在输出串里 ⇒ 整条抑制（白名单之外的东西一个字都不进视图）
    const needles = [...(rule.privateKeys ?? []), ...DELIVERY_NEVER_READ]
    if (needles.some((key) => serialized.toLowerCase().includes(String(key).toLowerCase()))) {
      out.audit.push({ package_id: packageId, reason: DELIVERY_SUPPRESSED[1] })
      counts.skipped += 1
      continue
    }
    const itemsOmitted = Math.max(0, items.length - rfq.items.length)
    counts.items_omitted += itemsOmitted
    const entry = { rfq, items_omitted: itemsOmitted, items_dropped: itemsDropped,
      items_dropped_reasons: dropBreakdown.flatMap((row) => Array.from({ length: row.count }, () => row.reason)),
      items_dropped_reason: dropReason, items_dropped_note: dropNote,
      // 怎么修：**常量文案**（原因的闭合集合里那条），所以坏行的取值一个字都不进输出
      items_dropped_fix: dropReason ? ITEM_DROP_NOTES[dropReason].fix : '',
      items_declared: rawItems.length }
    const previous = picked.get(packageId)
    const better = previous === undefined
      || (rev ?? -1) > (previous.rfq.rev ?? -1)
      || ((rev ?? -1) === (previous.rfq.rev ?? -1)
        && String(rfq.delivered_at ?? '') > String(previous.rfq.delivered_at ?? ''))
    if (better) picked.set(packageId, entry)
  }
  const all = [...picked.values()].map((entry) => entry.rfq).sort(byRfq)
  const shown = all.slice(0, maxPackages)
  const omitted = all.length - shown.length
  const packages = shown.map((rfq, index) => {
    const source = picked.get(rfq.package_id)
    const dropped = source?.items_dropped ?? 0
    return {
      rfq, index,
      items_omitted: source?.items_omitted ?? 0,
      // **丢条读数**（P33）：丢了几条 / 为什么 / 怎么修 —— 与 `items_omitted`（"夹取掉的好行"）
      // 是两件事，分开给（把"信封坏了"说成"行项目太多"是另一种不诚实）。
      items_declared: source?.items_declared ?? rfq.items.length,
      items_dropped: dropped,
      items_dropped_reasons: source?.items_dropped_reasons ?? [],
      items_dropped_reason: source?.items_dropped_reason ?? '',
      items_dropped_note: source?.items_dropped_note ?? '',
      items_dropped_fix: source?.items_dropped_fix ?? '',
      summary: `RFQ 包 ${rfq.package_id}@rev${rfq.rev === null ? '—' : rfq.rev}（发给本视角）：`
        + `报价截止 ${rfq.quote_by ?? '—'}、澄清截止 ${rfq.clarify_by ?? '—'}、行项目 ${rfq.items.length} 条`
        + (dropped ? `（另有 ${dropped} 条读不出来，原因：${source?.items_dropped_reason}` : '')
        + (dropped ? ' ⇒ 已跳过并计数，不静默丢）' : ''),
    }
  })
  // 派生行：`rfq` 恰 9 键（白名单），`body` 与 `rfq` 同物（`summary` 由同一条 `summarize` 派生）
  const rows = packages.map((pkg) => ({
    seq: null, type: DELIVERY_ROW_TYPE, correlation_id: pkg.rfq.package_id, ts: pkg.rfq.delivered_at,
    derived: true, body: pkg.rfq, rfq: pkg.rfq,
  }))
  const itemNote = counts.items_dropped
    ? `投递信封里有 ${counts.items_dropped} 条行项目读不出来（原因：${ITEM_DROP_REASONS[0]} —— `
      + `${ITEM_DROP_NOTES[ITEM_DROP_REASONS[0]].what}）⇒ 逐条跳过并计数（不静默丢、不猜内容）；`
      + `读到的好行照常出。修法：${ITEM_DROP_NOTES[ITEM_DROP_REASONS[0]].fix}`
    : ''
  if (packages.length === 0) {
    return degrade('no-deliveries-visible', { counts, identity: me, audit: out.audit,
      item_degraded: counts.items_dropped > 0, item_dropped_reason: counts.items_dropped ? ITEM_DROP_REASONS[0] : '',
      item_dropped_note: itemNote })
  }
  return { ...out, identity: me, packages, rows, counts,
    omitted, bounded: omitted > 0 || counts.items_omitted > 0, truncated: omitted > 0, audit: out.audit,
    item_degraded: counts.items_dropped > 0,
    item_dropped_reason: counts.items_dropped ? ITEM_DROP_REASONS[0] : '',
    item_dropped_note: itemNote }
}

export function apply(ctx, config) {
  ctx.provide('projection', {
    rules: VIEW_RULES,
    fields: config.fields,
    project: (view, rows) => project(view, rows, { fields: config.fields }),
    projectWithAudit: (view, rows, options = {}) => projectWithAudit(view, rows,
      { fields: config.fields, ...options }),
    deliveries: (view, realms, envelopes, options) => projectDeliveries(view, realms, envelopes, options),
    deliveryViews: DELIVERY_VIEWS,
    summarize,
  })
}

/** A5 采样点：同一输入两次必须字节一致（纯函数投影）。 */
const DELIVERY_SAMPLE = {
  package_id: 'pkg-1', rev: 2, sent_at: '2026-09-23T09:00:00Z',
  delivered_to: ['supplier:g1', 'supplier:g2'],
  spec: { package_id: 'pkg-1', currency: 'CNY',
    deadlines: { clarify_by: '2026-09-23T00:00:00Z', quote_by: '2026-09-25T00:00:00Z' },
    items: [{ item_id: 'L-001', code: 'P-100', qty: 120, unit: 'm' }],
    cost_floor: 700 },
}

export const fixture = {
  sample: (handle) => ({
    contractor: handle.project('contractor', [
      { seq: 1, type: 'rfq/published', body: { package_id: 'pkg-1', cost_floor: 700 } },
      { seq: 2, type: 'quote/submitted', body: { quote_id: 'q-1' } },
    ]),
    supplier: handle.project('supplier', [
      { seq: 1, type: 'rfq/published', body: { package_id: 'pkg-1', cost_floor: 700 } },
      { seq: 2, type: 'quote/submitted', body: { quote_id: 'q-1' } },
    ]),
    // 投递事实（本批新增）：被邀供应商看到的包事实 + 未被邀时的降级（都要确定性、且私域 0 命中）
    invited: handle.projectWithAudit('supplier', [], { deliveries: [DELIVERY_SAMPLE],
      realms: ['supplier:g1'] }),
    uninvited: handle.projectWithAudit('supplier', [], { deliveries: [DELIVERY_SAMPLE],
      realms: ['supplier:g2-other'] }),
  }),
}
