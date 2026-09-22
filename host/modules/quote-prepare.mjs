/**
 * 进树模块：`quote-prepare` —— **「把报价准备好（草稿）：行项目 / 单价 / 交期 / 备注」**（domain 插件）。
 *
 * 正面回答 human problem：**「员工填了单价、点了提交，浏览器回一页 200，什么都没发生」**。
 * 本仓铁律是「浏览器不得直接签署人工动作（`quote.submit` 仍只能由人/CLI 签）」，所以一条真正
 * 能在 APP 里**推进状态**的写闭环必须拆成三段，每段各自可验证：
 *
 *   ① **准备**（本插件）：把「员工想报的这份报价」变成一条**结构化草稿载荷**——行项目、单价
 *      （**整数分**）、交期（天）、备注（只留 sha256）、发言人（`human:*`）、RFQ 引用。校验是
 *      **字段级**的：每个不合法的字段各自给 `{field, code, message, next_action}`，不给一句
 *      笼统的「参数错误」；
 *   ② **落待办件**（宿主 `host/modules/webui.mjs`）：**只**写一条 0600 待办件（目录 0700、
 *      原子写），**账本零新增**（H1：宿主没有写账本的能力），回 202 + `next_action`；
 *   ③ **落账本**（Python 侧 `tools/quote-draft.py`，**唯一落账本者**）：校验行项目真的存在、
 *      数值在范围内、待办件逐字节没被改过 ⇒ 落 `quote/drafted`（**不是签名动作**：它只表示
 *      「报价已准备好」，body 不含备注正文、只含哈希与结构化字段），待办件移入 `applied/`。
 *
 * 最后一步（把草稿**签成**真正的报价 `quote/submitted`）**本 APP 不代签**：页面上的
 * 「下一步（签署）」区域给的是**可复制的 CLI 命令**（真实 RFQ / 行项目 / 金额参数），由人在终端
 * 跑 `tools/quote-sign.py --actor human:<人名> …`。本插件 `meta.can_sign=false`、
 * `meta.signature_required=true`，服务面里**没有** `sign`/`approve`/`decide`/`submit`/`send` 这类方法。
 *
 * 分工（与 `gate-timeline` / `rfq-deadline` / `advice-panel` 同一套纪律）：
 *   · `host/modules/webui.mjs` 只把**本视角自己的行**过滤成下面这份**白名单载荷**
 *     （键白名单读取：多出来的键读都不读；带私域键的行整行跳过）；
 *   · 本插件**不读账本、不写任何东西、不联网、不调模型、不取墙钟** —— 只对调用方给的结构化
 *     事实做一次确定性的规则派生（不 import `fs`：静态扫描断言看着）。
 *
 * 规则（各条可解释、可复算；常量都在本文件里，改口径就改这里 + 门 `host/t286-quote-draft-gate.mjs`）：
 *   ① `catalogue` 行项目目录：从本视角事实行里**逐条按键读取**已知行项目 id
 *      （`items[]` / `items:<n>` 之外不猜 / `lines[].item_id` / `item_id` / `item_ids[]`），
 *      连同参考单价（`lines[].unit_price` 元 → **整数分**，`Math.round(x*100)`）一起给；
 *      一条都读不出来 ⇒ `degraded=true` + 有名 reason（**不编行项目**）；
 *   ② `drafts` 既有草稿：投影里 `quote/drafted` 行 → `{quote_draft_id, rfq_id, item_id,
 *      unit_price_cents, lead_time_days, currency, prepared_by, supplier, note_sha256, ref,
 *      status:"awaiting-signature", status_text:"待签署"}`；**不签名就不叫已提交**（没有 `quote/submitted`
 *      的草稿在页面上恒为「待签署」）；
 *   ③ `validate` 字段级校验：`view` / `rfq_id` / `item_id` / `unit_price_cents` / `lead_time_days` /
 *      `prepared_by` / `currency` / `note` 八个字段各自独立判，错误按字段返回；
 *   ④ `handoff` 签署入口：给**可复制的** CLI 命令（含真实 RFQ / 行项目 / 整数分金额）与
 *      「本 APP 不代签」的说明（页面照抄，标记 `data-signature-required="1"`）。
 *
 * 【纪律：本插件**不能签名、不能提交、不能发信**】
 *   服务面只有 **8 个键**（`fields`/`limits`/`meta`/`privacy`/`prepare`/`validate`/`handoff`/`config`），
 *   没有 `approve` / `decide` / `submit` / `send` / `commit` 这类方法（门逐条断言）。
 */
import { array, number, object, string } from '../lib/std-schema.mjs'

export const name = 'quote-prepare'

export const inject = []                 // 纯函数插件：载荷由调用方给（宿主只读投影）
export const builtin = []                // 本模块不使用事件：声明即事实（D-015 / A1 双向断言）
export const usedServices = []
export const provides = ['quotePrepare']

/** 引擎自述：`rules` = **确定性规则**（不是模型、不是推测）。 */
export const ENGINE = 'rules'

/** 事件：**非签名动作**（「报价已准备好」不是「报价已提交」）。 */
export const EVENT = 'quote/drafted'

/** 待办件契约（宿主落盘、`tools/quote-draft.py` 消费）。 */
export const KIND = 'quote-draft'
export const ACTION = 'draft'
export const SCHEMA = 1
export const PENDING_PREFIX = 'qd-'

/** 页面上必须原样出现的一句话（诚实分层 + 「不代签」一起说清）。 */
export const ENGINE_NOTE = '本页由确定性规则从本视角投影派生（只看事实行的行项目、单价参考与交期），'
  + '不含模型推测、不取墙钟；本页**不能替你签名、不能替你提交报价**'

/** 「下一步（签署）」的说明（页面照抄；这是铁律的人话版本）。 */
export const SIGNATURE_NOTE = '浏览器**不代签**：把这份草稿签成真正的报价（`quote.submitted`）是'
  + '**人工动作**，只能在终端由 `--actor human:<人名>` 执行（ADR-0013 §3）。'
  + '下面给的是**可直接复制**的命令（参数取自上表：RFQ / 行项目 / 金额整数分）。'

/** 金额单位（全仓一致：整数分）。 */
export const MONEY_UNIT = 'cents'

/** 默认币种。 */
export const DEFAULT_CURRENCY = 'CNY'

/** 校验失败的**闭合**拒绝码集合（门断言它是闭合集合，不多不少）。 */
export const ERROR_CODES = [
  'view-not-allowed',        // 这个视角没有「准备报价」这一步
  'rfq-id-malformed',        // RFQ 引用形状不对
  'rfq-not-found',           // RFQ 引用不在本视角的事实里
  'item-id-malformed',       // 行项目 id 形状不对
  'item-not-found',          // 行项目不在本视角的行项目目录里
  'unit-price-not-integer',  // 单价不是整数分
  'unit-price-out-of-range', // 单价越界
  'lead-time-not-integer',   // 交期不是整数天
  'lead-time-out-of-range',  // 交期越界
  'prepared-by-required',    // 发言人必须是 human:<人名>
  'currency-malformed',      // 币种不是三个大写字母
  'note-too-long',           // 备注超过字节上限
]

/** 降级的有名 reason（闭合集合）。 */
export const DEGRADED_REASONS = ['payload-not-an-object', 'no-item-catalogue', 'no-drafts']

/** 行项目 id / RFQ 引用的形状（与 `tools/quote-draft.py` 逐字一致：改一处必须改两处 + 门）。 */
export const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

/** 被读取的载荷段（白名单；门断言「输出只可能来自这几段」）。 */
export const SECTIONS = ['facts']

/** 表单字段的**单一真源**：页面渲染、宿主校验与门都读这里（不许各写一份）。 */
export const FIELDS = [
  { name: 'rfq_id', label: 'RFQ 引用', kind: 'text', required: true, placeholder: 'pkg-g1',
    rule: '必填；形状 `[A-Za-z0-9][A-Za-z0-9._:-]{0,63}`；必须出现在本视角的事实里（否则拒绝码 `rfq-not-found`）' },
  { name: 'item_id', label: '行项目', kind: 'text', required: true, placeholder: 'L-001',
    rule: '必填；形状同 RFQ；必须出现在本视角的行项目目录里（否则 `item-not-found`）。目录见上表' },
  { name: 'unit_price_cents', label: '单价（整数分）', kind: 'text', required: true, placeholder: '8600',
    rule: '必填；纯数字（无小数点、无负号）；范围见下表。**金额单位恒为整数分**（8600 = 86.00 元）' },
  { name: 'lead_time_days', label: '交期（天）', kind: 'text', required: true, placeholder: '7',
    rule: '必填；纯数字；范围见下表' },
  { name: 'prepared_by', label: '发言人', kind: 'text', required: true, placeholder: 'human:zhang',
    rule: '必填；必须以 `human:` 开头（草稿也要有人认领；`agent:` 一律拒）' },
  { name: 'currency', label: '币种', kind: 'text', required: false, placeholder: 'CNY',
    rule: '可空；给了就必须是三个大写字母（默认 CNY）' },
  { name: 'note', label: '备注（可选）', kind: 'textarea', required: false, placeholder: '交期可谈；含运费',
    rule: '可空；**只留 sha256 进待办件与账本**（正文留在 0600 待办件里）；字节数见下表' },
]

/** 数值与文本的上下界（页面上写清；越界一律拒，不夹取）。 */
export const LIMITS = {
  unit_price_cents_min: 1,
  unit_price_cents_max: 100000000,
  lead_time_days_min: 1,
  lead_time_days_max: 3650,
  note_bytes_max: 2000,
  max_facts: 256,
  max_items: 64,
  max_drafts: 32,
}

export const Config = object({
  // 「准备报价」这一步属于哪个视角（默认只有供应商侧；承包商是在**对方**的位置上）
  views: array(string()).default(['supplier']),
  unit_price_cents_min: number().default(LIMITS.unit_price_cents_min),
  unit_price_cents_max: number().default(LIMITS.unit_price_cents_max),
  lead_time_days_min: number().default(LIMITS.lead_time_days_min),
  lead_time_days_max: number().default(LIMITS.lead_time_days_max),
  note_bytes_max: number().default(LIMITS.note_bytes_max),
  max_items: number().default(LIMITS.max_items),
  max_drafts: number().default(LIMITS.max_drafts),
})

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value) => (typeof value === 'string' ? value : '')
const toCents = (value) => {
  const n = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN)
  return Number.isFinite(n) ? Math.round(n * 100) : null
}
const pickId = (...values) => {
  for (const value of values) {
    const candidate = text(value).trim()
    if (candidate !== '') return candidate
  }
  return ''
}

/** 逐条按键读取行项目 id（**不是**原样透传：只认这几个键的形状）。 */
function itemIdsOf(fact) {
  const out = []
  const push = (value) => {
    const candidate = text(value).trim()
    if (candidate !== '' && !out.includes(candidate)) out.push(candidate)
  }
  if (Array.isArray(fact.items)) {
    for (const entry of fact.items) {
      if (typeof entry === 'string') push(entry)
      else if (isObject(entry)) push(entry.item_id)
    }
  }
  if (Array.isArray(fact.item_ids)) for (const entry of fact.item_ids) push(entry)
  push(fact.item_id)
  return out
}

/** 逐条按键读取参考单价（元 → 整数分）。 */
function priceRefsOf(fact) {
  const out = {}
  const lines = Array.isArray(fact.lines) ? fact.lines : []
  for (const line of lines) {
    if (!isObject(line)) continue
    const item = text(line.item_id).trim()
    const cents = toCents(line.unit_price)
    if (item !== '' && cents !== null && out[item] === undefined) out[item] = cents
  }
  return out
}

/** 只读 `facts` 段：逐条按键投影（多出来的键读都不读）。 */
function readFacts(payload) {
  const facts = Array.isArray(payload.facts) ? payload.facts : []
  return facts.slice(0, LIMITS.max_facts).map((fact) => (isObject(fact) ? {
    type: text(fact.type), ts: text(fact.ts),
    package_id: text(fact.package_id), quote_id: text(fact.quote_id), supplier: text(fact.supplier),
    item_id: text(fact.item_id), item_ids: Array.isArray(fact.item_ids) ? fact.item_ids.slice(0, 32) : [],
    items: Array.isArray(fact.items) ? fact.items.slice(0, 64) : [],
    lines: (Array.isArray(fact.lines) ? fact.lines : []).slice(0, 64)
      .map((line) => (isObject(line) ? { item_id: text(line.item_id), unit_price: line.unit_price } : {})),
    quote_draft_id: text(fact.quote_draft_id), rfq_id: text(fact.rfq_id),
    correlation_id: text(fact.correlation_id), ok: fact.ok,
    unit_price_cents: fact.unit_price_cents, lead_time_days: fact.lead_time_days,
    currency: text(fact.currency), prepared_by: text(fact.prepared_by), note_sha256: text(fact.note_sha256),
  } : {}))
}

/** 行项目目录：本视角事实里**真的出现过**的行项目（读不出来就说读不出来，不编）。 */
export function buildCatalogue(payload) {
  const facts = readFacts(payload)
  const rfqIds = []
  const items = {}
  for (const fact of facts) {
    const packageId = pickId(fact.package_id, fact.rfq_id)
    if (packageId !== '' && !rfqIds.includes(packageId)) rfqIds.push(packageId)
    const prices = priceRefsOf(fact)
    // 行项目 id 的来源是**并集**：`items[]` / `item_ids[]` / `item_id` / `lines[].item_id`
    // （单价参考只出现在 `lines[]` 里时，这一行本身就是「这个行项目存在」的证据 —— 漏掉它就会
    //  把明明读到的行项目当成读不到，本门抓到的第一个真 bug 就是这个）
    const ids = itemIdsOf(fact)
    for (const key of Object.keys(prices)) if (!ids.includes(key)) ids.push(key)
    for (const item of ids) {
      if (!items[item]) items[item] = { item_id: item, unit_price_cents: null, source: '' }
      if (prices[item] !== undefined && items[item].unit_price_cents === null) {
        items[item].unit_price_cents = prices[item]
        items[item].source = `${fact.type || 'fact'}.lines[].unit_price`
      } else if (items[item].source === '') {
        items[item].source = `${fact.type || 'fact'}.item_id`
      }
    }
  }
  const catalogue = Object.values(items).sort((a, b) => (a.item_id < b.item_id ? -1 : 1))
    .slice(0, LIMITS.max_items)
  return { items: catalogue, rfq_ids: rfqIds.slice(0, LIMITS.max_items),
    omitted: Math.max(0, Object.keys(items).length - LIMITS.max_items) }
}

/** 既有草稿（投影里的 `quote/drafted` 行）。**没有签名就不叫已提交**。 */
export function buildDrafts(payload) {
  const facts = readFacts(payload)
  const out = []
  const seen = new Set()
  for (const fact of facts) {
    if (fact.type !== EVENT || fact.ok === false) continue
    const draftId = pickId(fact.quote_draft_id, fact.correlation_id)
    if (draftId !== '' && seen.has(draftId)) continue
    if (draftId !== '') seen.add(draftId)
    const cents = Number.isFinite(Number(fact.unit_price_cents)) ? Number(fact.unit_price_cents) : null
    out.push({
      quote_draft_id: draftId,
      rfq_id: text(fact.rfq_id) || text(fact.package_id),
      item_id: fact.item_id,
      unit_price_cents: cents,
      lead_time_days: Number.isFinite(Number(fact.lead_time_days)) ? Number(fact.lead_time_days) : null,
      currency: fact.currency || DEFAULT_CURRENCY,
      prepared_by: fact.prepared_by,
      supplier: fact.supplier,
      note_sha256: fact.note_sha256,
      ref: draftId,
      status: 'awaiting-signature',
      status_text: '待签署',
      ts: fact.ts,
    })
  }
  return out.slice(0, LIMITS.max_drafts)
}

/** 派生（纯函数）：目录 + 既有草稿 + 计数。同入参两次**逐字节一致**。 */
export function prepare(payload, config) {
  const view = text(payload && payload.view)
  const views = config.views
  const out = {
    view, engine: ENGINE, engine_note: ENGINE_NOTE, as_of: text(payload && payload.as_of),
    as_of_basis: '本视角投影里最大的 ts（事实时刻，不是墙钟）',
    views, can_sign: false, signature_required: true, signature_note: SIGNATURE_NOTE,
    money_unit: MONEY_UNIT, limits: limitsOf(config),
    catalogue: { items: [], rfq_ids: [], omitted: 0 },
    drafts: [], counts: { items: 0, rfq_ids: 0, drafts: 0 },
    degraded: true, reason: 'payload-not-an-object',
  }
  if (!isObject(payload)) return out
  const catalogue = buildCatalogue(payload)
  const drafts = buildDrafts(payload)
  out.catalogue = catalogue
  out.drafts = drafts
  out.counts = { items: catalogue.items.length, rfq_ids: catalogue.rfq_ids.length, drafts: drafts.length }
  // **读不出来就说读不出来，不编**：一个行项目都读不到 ⇒ 降级 + 有名 reason（页面照抄这句话）
  const hasCatalogue = catalogue.items.length > 0
  if (hasCatalogue) {
    out.degraded = false
    out.reason = ''
  } else {
    out.degraded = true
    out.reason = 'no-item-catalogue'
  }
  return out
}

function limitsOf(config) {
  return {
    unit_price_cents_min: config.unit_price_cents_min, unit_price_cents_max: config.unit_price_cents_max,
    lead_time_days_min: config.lead_time_days_min, lead_time_days_max: config.lead_time_days_max,
    note_bytes_max: config.note_bytes_max,
    money_unit: MONEY_UNIT,
  }
}

const bytesOf = (value) => Buffer.byteLength(text(value), 'utf8')

/** 字段级校验：每个不合法的字段各自一条 `{field, code, message, next_action}`。 */
export function validate(input, config) {
  const { view, form, payload } = input
  const errors = []
  const limits = limitsOf(config)
  const catalogue = buildCatalogue(isObject(payload) ? payload : {})
  const field = (name, code, message, nextAction) => errors.push({
    field: name, code, message, next_action: nextAction })

  const requestedView = text(form.get ? form.get('view') : '') || text(view)
  if (!config.views.includes(requestedView)) {
    field('view', 'view-not-allowed', `视角 ${requestedView || '(空)'} 没有「准备报价」这一步（允许：${config.views.join(' / ')}）`,
      `用 ${config.views[0]} 视角打开 ${'/quotagent/' + config.views[0] + '/quotes/prepare/'} 再提交`)
  }

  const rfqId = text(form.get ? form.get('rfq_id') : form.rfq_id).trim()
  const itemId = text(form.get ? form.get('item_id') : form.item_id).trim()
  const priceRaw = text(form.get ? form.get('unit_price_cents') : form.unit_price_cents).trim()
  const leadRaw = text(form.get ? form.get('lead_time_days') : form.lead_time_days).trim()
  const preparedBy = text(form.get ? form.get('prepared_by') : form.prepared_by).trim()
  const currencyRaw = text(form.get ? form.get('currency') : form.currency).trim()
  const note = text(form.get ? form.get('note') : form.note)
  const currency = currencyRaw === '' ? DEFAULT_CURRENCY : currencyRaw

  if (rfqId === '' || !REF_RE.test(rfqId)) {
    field('rfq_id', 'rfq-id-malformed', 'RFQ 引用必填，且只能由字母数字与 `. _ : -` 组成（≤64 字符）',
      '从本页「RFQ 引用」一列里复制一个真 id；形状写在本页的校验规则里')
  } else if (catalogue.rfq_ids.length > 0 && !catalogue.rfq_ids.includes(rfqId)) {
    field('rfq_id', 'rfq-not-found',
      `RFQ ${rfqId} 不在本视角的事实里（本视角已知 ${catalogue.rfq_ids.length} 个：${catalogue.rfq_ids.slice(0, 5).join(' / ') || '无'}）`,
      '用页面上「RFQ 引用」一列里的真 id 重提（本页不猜、不默认）')
  }
  if (itemId === '' || !REF_RE.test(itemId)) {
    field('item_id', 'item-id-malformed', '行项目必填，且只能由字母数字与 `. _ : -` 组成（≤64 字符）',
      '从本页「行项目目录」一列里复制一个真 item_id')
  } else if (catalogue.items.length > 0 && !catalogue.items.some((row) => row.item_id === itemId)) {
    field('item_id', 'item-not-found',
      `行项目 ${itemId} 不在本视角的行项目目录里（已知 ${catalogue.items.map((row) => row.item_id).slice(0, 6).join(' / ') || '无'}）`,
      '用页面上「行项目目录」里的真 item_id 重提；目录为空 ⇒ 先让 RFQ 事实进账本')
  }

  let unitPrice = null
  if (!/^[0-9]{1,12}$/.test(priceRaw)) {
    field('unit_price_cents', 'unit-price-not-integer',
      `单价必须是**整数分**（纯数字，无小数点/负号；8600 = 86.00 元），收到「${priceRaw.slice(0, 20)}」`,
      '把单价换算成整数分再提交（本页不做四舍五入、不替你改数）')
  } else {
    unitPrice = Number(priceRaw)
    if (!(unitPrice >= limits.unit_price_cents_min && unitPrice <= limits.unit_price_cents_max)) {
      field('unit_price_cents', 'unit-price-out-of-range',
        `单价 ${unitPrice} 分越界（允许 ${limits.unit_price_cents_min}..${limits.unit_price_cents_max} 分）`,
        '改到范围内再提交；越界不夹取（夹取会合成一个你没报过的价格）')
    }
  }

  let leadTime = null
  if (!/^[0-9]{1,5}$/.test(leadRaw)) {
    field('lead_time_days', 'lead-time-not-integer',
      `交期必须是整数天（纯数字），收到「${leadRaw.slice(0, 20)}」`,
      '把交期写成整数天再提交（本页不做单位换算）')
  } else {
    leadTime = Number(leadRaw)
    if (!(leadTime >= limits.lead_time_days_min && leadTime <= limits.lead_time_days_max)) {
      field('lead_time_days', 'lead-time-out-of-range',
        `交期 ${leadTime} 天越界（允许 ${limits.lead_time_days_min}..${limits.lead_time_days_max} 天）`,
        '改到范围内再提交；越界不夹取')
    }
  }

  if (!/^human:/.test(preparedBy)) {
    field('prepared_by', 'prepared-by-required',
      '发言人必填且必须以 `human:` 开头（草稿也有人认领；`agent:` 一律拒）',
      '写成 human:<你的名字> 再提交')
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    field('currency', 'currency-malformed', `币种必须是三个大写字母（收到「${currency.slice(0, 8)}」）`,
      '写成 CNY / USD 这样的三字母代码，或留空用默认 CNY')
  }
  if (bytesOf(note) > limits.note_bytes_max) {
    field('note', 'note-too-long',
      `备注 ${bytesOf(note)} 字节超过上限 ${limits.note_bytes_max} 字节`,
      '把备注拆小或改短；本页**不截断**（截断会合成另一份正文）')
  }

  if (errors.length > 0) return { ok: false, code: 'validation-failed', errors, record: null }
  const record = {
    schema: SCHEMA, kind: KIND, view: requestedView, requested_action: ACTION,
    rfq_id: rfqId, item_id: itemId, unit_price_cents: unitPrice, lead_time_days: leadTime,
    currency, prepared_by: preparedBy, note, note_sha256: '', submitted_at: '',
  }
  return { ok: true, code: 'accepted', errors: [], record }
}

/** 签署入口：**可复制的** CLI 命令（真实参数）+ 「本 APP 不代签」的说明。 */
export function handoff(input) {
  const view = text(input && input.view)
  const draft = isObject(input && input.draft) ? input.draft : {}
  const rfqId = text(draft.rfq_id || (input && input.rfq_id))
  const itemId = text(draft.item_id || (input && input.item_id))
  const cents = Number.isFinite(Number(draft.unit_price_cents ?? (input && input.unit_price_cents)))
    ? Number(draft.unit_price_cents ?? input.unit_price_cents) : null
  const draftId = text(draft.quote_draft_id || (input && input.draft_id)) || `<draft-id>`
  const shared = '<ui-shared>'    // 宿主不在页面上编路径：真实路径由运维手册给出（见 deployment-manual）
  return {
    required: true, can_sign: false, view,
    why: SIGNATURE_NOTE,
    draft_id: draftId, rfq_id: rfqId, item_id: itemId, unit_price_cents: cents, money_unit: MONEY_UNIT,
    commands: [
      `python3 tools/quote-sign.py --ui-shared ${shared} --draft-id ${draftId} \\\n`
      + `    --actor human:<你的名字> --now <ISO8601> --comment "同意提交"`,
      `python3 tools/quote-sign.py --ui-shared ${shared} --draft-id ${draftId} --dry-run \\\n`
      + `    --actor human:<你的名字> --now <ISO8601>`,
      `# 参数取自上表：RFQ=${rfqId || '—'} 行项目=${itemId || '—'} `
      + `金额=${cents === null ? '—' : cents} 分（${MONEY_UNIT}）`,
    ],
    data_signature_required: '1',
    page_note: '本 APP 不代签：签的是**人**（`approval.decide` 的 actor 必须 `human:*`），'
      + '浏览器连一个「提交报价」的口子都没有',
  }
}

/** 宿主把本视角的行过滤成载荷前，用来判「这条行是不是私域」的键名单（由视角规则给）。 */
export function hasPrivateKey(body, privateKeys) {
  if (!isObject(body)) return false
  const serialized = JSON.stringify(body).toLowerCase()
  return (privateKeys || []).some((key) => serialized.includes(String(key).toLowerCase()))
}

export function apply(ctx, config) {
  ctx.provide('quotePrepare', {
    fields: () => FIELDS.map((field) => ({ ...field })),
    limits: () => limitsOf(config),
    views: () => [...config.views],
    meta: () => ({
      engine: ENGINE, event: EVENT, kind: KIND, action: ACTION, schema: SCHEMA, sections: SECTIONS,
      error_codes: [...ERROR_CODES], degraded_reasons: [...DEGRADED_REASONS],
      can_sign: false, signature_required: true, can_submit: false, sends: 0,
      money_unit: MONEY_UNIT, fields: FIELDS.map((field) => field.name),
      views: [...config.views], limits: limitsOf(config),
      ref_pattern: String(REF_RE), pending_prefix: PENDING_PREFIX, engine_note: ENGINE_NOTE,
    }),
    privacy: () => ({
      // 本插件读的段 / 不读的东西：门逐条断言（声明即事实）
      reads: [...SECTIONS], reads_ledger: false, writes: 0, sends: 0, reads_clock: false,
      calls_model: false, uses_network: false, approves: false, signs: false, note_body_written: false,
    }),
    prepare: (payload) => prepare(payload, config),
    // 字段级校验（`form` 只要求 get(name) 这一个方法 —— 页面与门都能给）
    validate: (input) => {
      const source = isObject(input) ? input : {}
      const form = source.form && typeof source.form.get === 'function'
        ? source.form : { get: (key) => (isObject(source.fields) ? source.fields[key] : undefined) }
      return validate({ view: source.view, form, payload: source.payload }, config)
    },
    handoff: (input) => handoff(input),
  })
}

/** A5 采样点：同一输入两次必须逐字节一致（纯函数派生）。 */
export const fixture = {
  sample: (handle) => {
    const payload = {
      view: 'supplier', as_of: '2026-09-21T12:00:00Z',
      facts: [
        { type: 'rfq/published', ts: '2026-09-21T10:00:00Z', package_id: 'pkg-1', items: 2 },
        { type: 'quote/submitted', ts: '2026-09-21T11:00:00Z', package_id: 'pkg-1',
          lines: [{ item_id: 'L-001', unit_price: 86 }] },
      ],
    }
    return { first: handle.prepare(payload), second: handle.prepare(payload) }
  },
}
