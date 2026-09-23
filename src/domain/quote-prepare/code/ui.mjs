/**
 * `domain/quote-prepare` 的 **GUI 贡献** —— 供应商侧「看包 → 备报价 → 人签提交 → 页面回读」这一条闭环。
 *
 * 注册的东西：
 *   · 视图 `quote.my`（挂 `supplier` 道）；
 *   · 面板 `quote.package`（**发给自己的** RFQ 包：只读投递信封里 `delivered_to` 含自己 realm 的那份；
 *     行项目表**可编辑**（单价整数分 / 交期天数）—— 这是"备报价"的交互面，批量提交就是「备这份草稿」）；
 *   · 面板 `quote.drafts`（本侧账本里 `quote/drafted` 的草稿：状态"待签署"，行内动作「人签提交」）；
 *   · 面板 `quote.submitted`（本侧账本里 `quote/submitted` 的事实行 —— **提交结果回读**）；
 *   · 动作 `quote.draft`（服务端一半：`validate()` 字段级校验 → 落 0600 待办件 →
 *     跑唯一写者 `src/domain/quote-prepare/tools/quote-draft.py` 落 `quote/drafted`（非签名动作））；
 *     支持**批量**（`input.rows`：来自可编辑表格的批量提交，一行一份草稿）；
 *   · 动作 `quote.submit`（**human-signature**：服务端一半跑唯一写者 `tools/quote-sign.py`，
 *     `--actor human:<署名>` → 落 `approval/requested` → `approval/granted` → `quote/submitted`，
 *     并在承包商账本登记一条「供应商已提交报价」）；
 *   · 快捷键 `d`、通知源（待签署草稿）、状态栏项。
 *   · **已读回执（本批新增）**：供应商**打开包**（列表面板 `quote.package` / 对象页 `package.mine`）时，
 *     按会话身份记一条**已读回执**给发包方（`<ui_shared>/receipts/deliveries.json`，0600，**不进账本**；
 *     理由见 `src/system/attachments/code/delivery-receipts.mjs` 文件头）。发包方那一侧在
 *     `domain/rfq` 的「投递与已读回执」面板里看到「谁 / 何时 / 看过几次」。回执里**没有**本侧的
 *     报价、成本或任何私域字段 —— 只有对象 id + 人 + 时刻 + 计数。
 *
 * 纪律：本文件不写账本（只 spawn Python 侧唯一写者）；单价一律**整数分**；备注正文只进 0600 待办件。
 * 已读回执也只写它自己那个 0600 文件（`ledger_added` 恒 0），不是第二条事实写路径。
 */
import { createHash } from 'node:crypto'
import { buildCatalogue, validate, LIMITS, FIELDS, MONEY_UNIT } from './quote-prepare.mjs'
import { createReceiptStore } from '../../../system/attachments/code/delivery-receipts.mjs'

/** 与唯一写者 `tools/quote-draft.py` 的 `canonical_lines()` **逐字节一致**的行项目规范化 JSON。
 *
 * 两种形态（与写者同一口径）：**单行**（无 `lines`）5 键；**多行**（`lines` 非空）`{currency, lines[], rfq_id}`。
 * 键序必须是**排序后**的顺序（写者用 `json.dumps(sort_keys=True)`；`JSON.stringify` 只保留插入顺序）。
 */
const canonicalLines = (record) => {
  const rows = Array.isArray(record.lines) && record.lines.length ? record.lines : null
  if (rows) {
    // **键序 = 字典序**（`currency` < `lines` < `rfq_id`；行内 `item_id` < `lead_time_days` <
    // `unit_price_cents`）：写者用 `json.dumps(sort_keys=True)`，而 `JSON.stringify` **只保留插入顺序** ——
    // 顺序写错就会算出另一个哈希（实测：写成 currency/rfq_id/lines 会被唯一写者按 `pending-tampered` 拒）。
    return JSON.stringify({ currency: String(record.currency ?? ''),
      lines: rows.map((line) => ({ item_id: String(line.item_id ?? ''), lead_time_days: line.lead_time_days,
        unit_price_cents: line.unit_price_cents })),
      rfq_id: String(record.rfq_id ?? '') })
  }
  return JSON.stringify({ currency: String(record.currency ?? ''), item_id: String(record.item_id ?? ''),
    lead_time_days: record.lead_time_days, rfq_id: String(record.rfq_id ?? ''),
    unit_price_cents: record.unit_price_cents })
}
const sha256 = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex')

export const plugin_id = 'domain/quote-prepare'

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
    ? `（未登录：登录${label}之后这一条才算"需要你处理"）`
    : `（不是你要办的：这一步由${label}的人做 —— 卡头「有 N 件需要你处理」只算本侧）`
  const body = asText(item.body)
  return { ...item, level: (item.level === 'warn' || item.level === 'bad') ? 'info' : item.level,
    body: `${body}${body ? ' ' : ''}${why}` }
}
const bodyOf = (row) => (row && typeof row.body === 'object' && row.body !== null ? row.body : {})
const typeRows = (rows, prefix) => rows.filter((row) => String(row?.type ?? '').startsWith(prefix))

/** 值的**形状名**（只用于如实报出"读不出来的是什么形状"，不做任何补值/猜测）。 */
const shapeOf = (value) => (value === undefined ? 'missing' : value === null ? 'null'
  : Array.isArray(value) ? 'array' : typeof value)
/** 「行」的最小形状：非 null 的**对象**（数组不是行 —— 它是形状异常）。 */
const isRow = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
/** 值 → 单元格文本（读不出来的给空串；**不补 0、不写 undefined、不把对象 stringify 出来**）。 */
const cellText = (value) => (isRow(value) || value === undefined || value === null ? '' : String(value))

/**
 * **逐行读数（唯一入口）**：`lines[]` / `items[]` 这类「行数组」一律走这里。
 *
 * 为什么必须有它（P27 实测的根因）：面板直接 `lines.map((line) => line.item_id)` 时，数组里
 * **只要有一条不是对象**（null / 字符串 / 数字 / 数组），读 `.item_id` 就抛 `TypeError`；而外壳对
 * `panel.data()` 抛错的处理是**整块面板判 `data-failed`**（页面其余部分照常，这一块整块没了）——
 * 一条坏行把整块面板打崩。
 *
 * 本函数把坏行**逐条计数**、把能当行用的对象照常交出去；调用方再把 `dropped` 如实报出来
 * （本仓纪律：读不到 ≠ 没有，也**不许静默丢**；但也不许因为一条坏行把这一块整块打崩）。
 *
 * 返回 `{all, list, rows, dropped, shape}`：`all` = 源**声明**有几条（不是数组 ⇒ 0）、
 * `rows` = 能当行用的对象、`dropped` = 读不成对象的条数、`shape` = 源本身的形状名。
 */
const readRows = (value) => {
  if (!Array.isArray(value)) return { all: 0, list: false, rows: [], dropped: 0, shape: shapeOf(value) }
  const rows = []
  let dropped = 0
  for (const row of value) {
    if (isRow(row)) rows.push(row)
    else dropped += 1
  }
  return { all: value.length, list: true, rows, dropped, shape: 'array' }
}

/** 逐行明细的一行在界面上的说法（唯一口径；坏行不参与 —— 它们的条数由调用方另行报出）。 */
const lineLabelOf = (line) => `${asText(line.item_id) || '（无 id）'}@${cellText(line.unit_price_cents) || '—'}分`

/**
 * **标量名单**的安全读数（收件人 `to: ['supplier:g1']` 这类：数组里是字符串，不是对象行）。
 * 只认**非空字符串**（数字/对象/null 一律不算名单里的人 —— 不编、也不猜）；
 * 不是数组 ⇒ `list=false` + 形状名（调用方如实报"读不出来"，不编一个空名单）。
 */
const scalarListOf = (value) => {
  if (!Array.isArray(value)) return { list: false, shape: shapeOf(value), items: [], dropped: 0 }
  const items = value.filter((item) => typeof item === 'string' && item.trim() !== '')
    .map((item) => item.trim())
  return { list: true, shape: 'array', items, dropped: value.length - items.length }
}

/**
 * **草稿在包表里的逐行回显**（P28 空账本走查登记的缺陷）：`quote/drafted` 的多行形态只写 `lines[]`，
 * 标量键（`item_id` / `unit_price_cents` / `lead_time_days`）**只有首行那一条**；照旧按标量键建索引时，
 * 表里别的行读不到草稿 ⇒ 单价/交期两列显示空、行合计算成 `0`（看着像"零价"，而草稿里明明有价）。
 *
 * 逐行取值口径：① `lines[]` 里按 `item_id` 取这一行（多行形态的真值）；② 没有 `lines[]` 的老形状
 * （单行草稿）才用标量键兜底。**读不出来就留空**，不补 0、不借用别行的价。
 */
const draftCellsOf = (draftBodies) => {
  const byItem = new Map()
  for (const body of draftBodies) {
    const draftId = asText(body.quote_draft_id) || asText(body.item_id)
    const lines = readRows(body.lines)
    for (const line of lines.rows.filter((row) => isRow(row))) {
      const itemId = asText(line.item_id)
      if (itemId === '' || byItem.has(itemId)) continue
      byItem.set(itemId, { draft_id: draftId, unit_price_cents: line.unit_price_cents,
        lead_time_days: line.lead_time_days })
    }
    const itemId = asText(body.item_id)
    if (lines.all === 0 && itemId !== '' && !byItem.has(itemId)) {
      byItem.set(itemId, { draft_id: draftId, unit_price_cents: body.unit_price_cents,
        lead_time_days: body.lead_time_days })
    }
  }
  return byItem
}

/**
 * **「首行」几列的取值口径**（P28 空账本走查登记的缺陷）：`quote/submitted` / `quote/drafted` 的多行形态
 * 只写 `lines[]`，标量键（`item_id` / `unit_price_cents` / `lead_time_days`）是**首行那一条**、甚至是空的
 * （账本里就是 `item_id: ""` / `unit_price_cents: null`）⇒ 照旧直读标量键时那几列空着、行合计显示成 `0`，
 * 看着像"这份报价没有价"。
 *
 * 口径：标量键**读得出来就用它**（单行形状的真值）；读不出来回落到 `lines[0]`（多行形状的真值）；
 * 都读不出来**留空**（不补 0、不借用别行的价）。`read` 是 `readRows(...)` 的结果（行数组的唯一读数入口）。
 */
const firstLineReader = (body, read) => {
  const first = (read && read.rows[0]) ?? null
  return (key) => (cellText(body[key]) !== '' ? body[key] : (first ? (first[key] ?? '') : ''))
}

/**
 * 投递信封里的**行项目**（`spec.items`）—— 本插件唯一读它的地方。
 *
 * 三种源形状必须**分得开**（P27：修前它们长得一模一样，都是「空表 + 自称健康」）：
 *   · **数组**：逐条只认对象行**且带可读 `item_id`**（没 id 的行备不了报价 —— 列出来点了必被
 *     `item-not-found` 拒，所以不列，但**计入 dropped**）；
 *   · **不是数组**（缺失 / 文本 / 键值表 / 数字）：**不是「零行项目」** ⇒ `list=false`，调用方如实降级；
 *   · 数组里**混着坏行**：好行照常列，`dropped` 逐条计数 ⇒ 调用方如实报出来（不假装健康）。
 */
const packageItemsOf = (spec) => {
  const holder = isRow(spec) ? spec : {}
  const read = readRows(holder.items)
  const rows = []
  let withoutId = 0
  // **行数组的唯一读数入口**：坏行已由 `readRows` 逐条计数、好行照列；这里再 `filter((row) => isRow(row))`
  // 是同一入口上的就地设防（读属性的那一行不再裸奔 —— 外壳对 `data()` 抛错的处理是整块面板判 `data-failed`）。
  for (const row of read.rows.filter((row) => isRow(row))) {
    const id = asText(row.item_id)
    if (id === '') { withoutId += 1; continue }
    rows.push({ ...row, item_id: id })
  }
  return { list: read.list, all: read.all, rows, dropped: read.dropped + withoutId,
    without_id: withoutId, shape: read.shape, spec_shape: isRow(spec) ? 'object' : shapeOf(spec) }
}

/** 信封行项目读不出来时的说法（`degraded`/`reason`/`next_action` 共用，免得各处各写一句）。 */
const itemsAnomaly = (packageId, items) => {
  if (!items.list) {
    return { degraded: true,
      reason: `package-items-not-a-list：信封的 \`spec.items\` 是 ${items.shape}（不是行项目数组）`
        + ` —— 空表不等于这份包没有行项目，本面板不编行项目`,
      next_action: `让发包方按行项目数组重发 ${packageId || '这一版'}；`
        + '本面板照常留了已读回执、也不假装这份包是空的（读不到 ≠ 没有）' }
  }
  if (items.dropped) {
    const noId = items.without_id ? `，其中 ${items.without_id} 条没有可读的 \`item_id\`` : ''
    return { degraded: true,
      reason: `package-items-partly-unreadable：信封里有 ${items.dropped} 条行项目读不出来`
        + `（形状异常：不是对象${noId}）—— 好行照常列出，坏行逐条计数、不静默丢`,
      next_action: '让发包方把这一版按行项目数组重发（坏行已跳过并计数）；'
        + '要按现在这些行备报价，先核对被跳过的条数是否与对方那份一致' }
  }
  return {}
}

/**
 * 本侧 realm 的**取值顺序**（与 `domain/commitments` 的 `realmOf('supplier')` **同一判据**）：
 * ① 投影行上的行级 `realm`（夹具/单账本模式下才有；机制给的投影默认只出
 * `seq/type/correlation_id/actor/ts/body`，所以真实面上这一条通常取不到）；
 * ② **投递登记**里的收件人（`rfq/distributed` / `po/distributed` 的 `recipients[]` 或 `supplier`）。
 *
 * **为什么必须对齐**（P20 走查实测的核心流程阻断）：报价上记的 `supplier` 会被 `award.propose`
 * 逐字抄进授标意向的 `delivered_to`，而供应商侧「发给我的授标意向」按**它自己**算出来的 realm 过滤。
 * 两边取值规则不一致时（这里是硬编码兜底 `supplier:gui` vs 投递登记的 `supplier:g1`），
 * 意向**永远投不到供应商那一侧** ⇒ 「确认中标」在 GUI 里点不到 ⇒ 承包商「授标承诺」被
 * `supplier-confirmation-required` 拒 ⇒ PO / 回签整条链卡住（AGENTS.md 规则 11：双方仅通过 GUI
 * 走完全部业务流程）。对齐之后两侧同源，投递与过滤按构造一致。
 */
const registrationRealmOf = (host) => {
  for (const type of ['po/distributed', 'rfq/distributed']) {
    for (const row of typeRows(host.rows('supplier') ?? [], type)) {
      const body = bodyOf(row)
      // `recipients` **不是一个数组**时（字符串/数字/对象）修前 `...body.recipients` 会抛
      // `TypeError: … is not iterable` ⇒ 读 realm 的这条路径把上游一起带崩；现在按座位名读数
      // （不是数组 ⇒ 只认 `body.supplier`，不猜）。
      const recipients = scalarListOf(body.recipients)
      const mine = [asText(body.supplier), ...recipients.items].find((item) => item !== '')
      if (mine) return mine
    }
  }
  return ''
}

/** 本视角投影事实行 → 插件要的白名单载荷（只有 `rfq/*`、`quote/*` 的类型，逐键白名单）。 */
const FACT_KEYS = ['item_id', 'item_ids', 'items', 'lines', 'currency', 'package_id', 'rfq_id', 'quote_id',
  'quote_by', 'quote_draft_id', 'unit_price_cents', 'lead_time_days', 'supplier', 'ok', 'status',
  'submitted_at', 'line_count']
const payloadOf = (host, view) => {
  const facts = []
  for (const row of typeRows(host.rows(view), 'rfq/').concat(typeRows(host.rows(view), 'quote/'))) {
    const body = bodyOf(row)
    const fact = { type: String(row?.type ?? ''), ts: row?.ts }
    for (const key of FACT_KEYS) if (body[key] !== undefined && body[key] !== null) fact[key] = body[key]
    // **逐行真值**也要进来：行项目目录是**并集**（`items[]` / `item_ids[]` / `item_id` / `lines[].item_id`）——
    // 漏掉 `lines[].item_id` 会把"明明在账本里读到的行项目"当成不存在，于是一份多行报价的合法行被
    // 误判成 `item-not-found`（`quote-prepare.mjs` 的老实现就是这么读的，本处是把它补回来）。
    if (Array.isArray(body.lines)) {
      fact.lines = body.lines.slice(0, 64).map((line) => ({
        item_id: asText(line?.item_id), unit_price: line?.unit_price, lead_time_days: line?.lead_time_days }))
    }
    if (String(row?.type ?? '').startsWith('quote/drafted') && fact.quote_draft_id === undefined
      && typeof row?.correlation_id === 'string') fact.quote_draft_id = row.correlation_id
    facts.push(fact)
    if (facts.length >= 256) break
  }
  return { view, as_of: facts.map((fact) => fact.ts).filter(Boolean).sort().pop() ?? null, facts }
}

/** 一次「备草稿」提交里的行（批量 `input.rows`，或用标量字段的单条）。 */
const draftRowsOf = (input) => (Array.isArray(input?.rows) && input.rows.length ? input.rows : [input])

/**
 * 本视角**真的能当 RFQ 引用用**的包 id —— 与 `validate()` **同源**：同一个
 * `buildCatalogue(payloadOf(host, 'supplier'))`。
 *
 * 为什么必须问这一句（P22 实测）：`buildCatalogue` 的包 id 目录**有硬上限**（`LIMITS.max_items = 64`，
 * 行项目目录同限）—— 包多到超过上限时，**最新那些包会读不到**；而本插件的面板「发给我的 RFQ 包」
 * 按定义读的就是**最新那个**（投递信封）⇒ 一旦 >64 个包，界面会**自动预填一个它自己会拒的包**
 * （服务端按同一份目录判 `rfq-not-found`，P20 §5.1 的坑 + 390px 截图 `p20-390-04`）。
 *
 * 取不到就不预填（并如实说明「为什么这一份包现在备不了报价」）—— 「未验证不断言」在界面上的形态。
 * `capped=true` 表示这一份目录**已经在上限上**（多的包读都读不到，不是"没有更多包"）。
 */
const referenceablePackages = (host) => {
  const catalogue = buildCatalogue(payloadOf(host, 'supplier'))
  const ids = (Array.isArray(catalogue.rfq_ids) ? catalogue.rfq_ids : []).map(asText).filter(Boolean)
  return { ids, capped: ids.length >= LIMITS.max_items }
}

/**
 * **我方对这份包的报价草稿**（乐观并发的对象）= **这份包一个对象**（对象 id 就是包 id）。
 *
 * 为什么这么定：草稿是"我方对这份包的报价"这一件事 —— 界面上的"整张表一次提交"、行内改价、批量提交
 * 写进去的都是它；两个人各改一部分行项目（一个改 L-001、一个改 L-002）时**仍然是同一个对象**，
 * 后写覆盖前写（对方的价不见了）正是要防的。行项目集合若参与对象 id，两个人各改一行就互不冲突了
 * （那正是漏网的口子）。逐行差异由状态（`draftStateOf`）里的价目表给出，不靠对象 id。
 */
const draftSlotOf = (input) => asText(input?.rfq_id)
/** 这份草稿"写进去之后"的权威状态（乐观并发比对的字段；机制只取指纹与逐字段差异，不解读含义）。 */
const draftStateOf = (input) => {
  // 只认**对象行**（`row?.` 已挡住 null 的部分取值，但数组里的非对象行会静默变成空 id ⇒ 先把它们
  // 剔掉：指纹只该由真行构成，坏行不参与比对，也不打崩这次保存）
  const lines = draftRowsOf(input).filter(isRow).map((row) => ({
    item_id: asText(row?.item_id ?? row?.id),
    unit_price_cents: String(row?.unit_price_cents ?? input?.unit_price_cents ?? ''),
    lead_time_days: String(row?.lead_time_days ?? input?.lead_time_days ?? '') }))
    .sort((left, right) => (left.item_id < right.item_id ? -1 : 1))
  return { rfq_id: asText(input?.rfq_id),
    item_ids: lines.map((line) => line.item_id).join('+'),
    prices: lines.map((line) => `${line.item_id}@${line.unit_price_cents}/${line.lead_time_days}d`).join(' '),
    currency: asText(input?.currency) || 'CNY',
    prepared_by: asText(input?.prepared_by),
    note_sha256: sha256(String(input?.note ?? '')) }
}

/** 投递信封里**发给自己的**那一份（`delivered_to` 含本侧 realm；只出自己的包）。 */
const myPackage = (host, realm) => {
  const file = asText(host.config?.rfq_delivery)
  if (file === '') return { ok: false, code: 'delivery-unconfigured',
    reason: '宿主未配置投递信封位置（rfq_delivery）',
    next_action: '发布方（承包商）发布 RFQ 时会写这份信封；配置见 ./run 的 QUOTAGENT_UI_RFQ_DELIVERY' }
  const envelope = host.readJson(file)
  if (!envelope) return { ok: false, code: 'delivery-missing',
    reason: '本侧还没有收到任何 RFQ 包（投递信封里还没有发给你的那一份）',
    next_action: '等对方发布：承包商道「发布 RFQ」把包投给本侧 realm 之后，这一页会自动出现那一包' }
  const delivered = Array.isArray(envelope.delivered_to) ? envelope.delivered_to.map(String) : []
  if (realm && delivered.length && !delivered.includes(realm)) {
    return { ok: false, code: 'not-addressed-to-me', reason: `这份包发给了 ${delivered.join(' / ')}，不是 ${realm}`,
      next_action: '只出自己的那份：确认本侧 realm 与邀请名单' }
  }
  return { ok: true, envelope }
}

export async function register(surface, host) {
  const me = plugin_id
  const out = []
  /** 批量人签一次最多几份（面板文案与拒绝判据**同一个常量**：写在 register 顶部，免得面板 note 引用到 TDZ）。 */
  const BATCH_SIGN_MAX = 50
  const supplierLedger = () => asText(host.config?.ledger_supplier)
  const contractorLedger = () => asText(host.config?.ledger_contractor)
  /** 已读回执存储（0600；**不进账本**，理由见模块文件头）。沙盘里 `host.sharedDir` 会指向沙盘目录 ⇒ 演示不脏真实面。 */
  const receipts = createReceiptStore({ root: host.root, sharedDir: host.sharedDir,
    log: (msg) => host.note.set(me, 'receipt-log', msg) })
  /**
   * **打开包的一方留一条已读回执**（发包方据此回答「对方收到了吗 / 看了吗」）。
   *
   * 三条纪律（逐条都是硬约束）：
   *   · **侧与人都只认会话**（`ctx.identity`）：没有身份、或身份不是供应商侧 ⇒ **不记**、也不报错；
   *   · 只记「对象 id + 人 + 时刻 + 从哪看的」，**不记**报价/成本/评分（回执不是数据出口）；
   *   · 失败不影响这一页渲染（回执是痕迹，读不到回执不该把「看包」这件事弄坏）：如实塞进面板的 note。
   */
  const receiptNote = (out) => {
    if (!out) return ''
    if (out.ok === true) {
      // 注意：这句话会被渲染成**纯文本**（对象页事实 / kv 条目 / 面板 note 都过 HTML 转义）
      // ⇒ 不要写 markdown 记号，否则用户看到的是星号本身。
      return out.unchanged
        ? '已读回执：这一次查看（60 s 内重复查看不重复记）'
        : `已读回执：已记下你打开了这个包（${out.first_at} 起）—— 对方（发包方）能看到「谁 / 何时 / 看过几次」，`
          + '看不到你的报价、成本或任何本侧私有数据'
    }
    return `已读回执没记上（${out.code}）：${out.reason}`
  }
  const recordPackageReceipt = (ctx, packageId, source) => {
    const who = ctx?.identity
    const human = asText(who?.human)
    const side = asText(who?.side)
    if (packageId === '' || human === '' || side !== 'supplier') return null
    const out = receipts.record({ kind: 'package', id: packageId, human, side, at: host.now(), source })
    return out
  }

  const realmOf = (view) => {
    const rows = host.rows(view)
    const found = rows.find((row) => asText(row?.realm) !== '')
    return found ? asText(found.realm) : ''
  }

  out.push(surface.view({ plugin_id: me, id: 'quote.my', title: '我的 RFQ 与报价', order: 10, view: 'supplier',
    hint: '看发给自己的包 → 备报价（草稿可续）→ 人签提交 → 回读提交结果' }))

  out.push(surface.panel({ plugin_id: me, id: 'quote.package', title: '发给我的 RFQ 包（只出自己那份）',
    view: 'supplier', order: 10, kind: 'table',
    // 面板 `hint` 是**渲染出来**的那句（`data.note` 只在空态/降级里当 next_action 用）——
    // 预填口径写在这里，用户才真的看得到（P22 实测：写在 `data.note` 里等于没写）。
    // 注意：`hint` 会被外壳 HTML 转义 ⇒ 这里写**纯文本**（不要 markdown 记号，否则用户看到的是 `**`）。
    hint: '预填只给本侧事实里真的认得的包：包 id 目录有上限（最多 64 个包），超过上限后最新那个包读不到'
      + ' ⇒ 这块不预填它、也不给备报价入口（免得你按下去必然被拒 rfq-not-found），只在顶上如实说明。'
      + '能备报价时：表里填几行就交几行 —— 一次「提交编辑」= 一条草稿（多行），随后在「我的草稿」里一次人签提交整份。'
      + '打开这一页会给发包方留一条已读回执（谁 / 何时 / 看过几次，0600 文件、不进账本）——'
      + '对方看不到你的报价、成本或任何本侧私有数据。',
    data: (ctx) => {
      const realm = realmOf('supplier')
      const mine = myPackage(host, realm)
      if (!mine.ok) {
        return { ok: true, kind: 'table', degraded: true, reason: mine.code, next_action: mine.next_action,
          columns: [{ key: 'item_id', label: '行项目' }], rows: [] }
      }
      const envelope = mine.envelope
      const spec = envelope.spec && typeof envelope.spec === 'object' ? envelope.spec : {}
      // **行项目读数（唯一入口）**：数组里混坏行 ⇒ 好行照列 + 逐条计数；不是数组 ⇒ 不是"零行项目"（见 `packageItemsOf`）
      const items = packageItemsOf(spec)
      const draftCells = draftCellsOf(typeRows(host.rows('supplier'), 'quote/drafted')
        .map((row) => bodyOf(row)))
      const packageId = String(spec.package_id ?? '')
      // **已读回执**：你打开这一页 = 发包方那边多一条「谁在何时看过这个包」（0600 痕迹，不进账本）
      const receipt = recordPackageReceipt(ctx, packageId, 'quote.package')
      const known = referenceablePackages(host)
      // **预填的判据**：本侧事实真的认得这个包才预填（目录为空时无从判断，按旧行为预填）
      const referenceable = packageId === '' || known.ids.length === 0 || known.ids.includes(packageId)
      const declared = referenceable ? '（整数分，可直接改）' : '（整数分）'
      // **信封行项目读不出来** ⇒ 如实降级（不冒充健康，也不把这一块打崩）：好行照常列出
      const anomaly = itemsAnomaly(packageId, items)
      return { ok: true, kind: 'table', ...anomaly,
        columns: [
          { key: 'item_id', label: '行项目', type: 'code', pin: 'left' },
          { key: 'description', label: '描述' },
          { key: 'qty', label: '数量' },
          { key: 'unit', label: '单位' },
          { key: 'unit_price_cents', label: `单价${declared}`, ...(referenceable ? { editable: true } : {}),
            type: 'number', line_total_of: 'qty', help: '8600 = 86.00 元' },
          { key: 'lead_time_days', label: `交期（天${referenceable ? '，可直接改' : ''}）`,
            ...(referenceable ? { editable: true } : {}), type: 'number' },
          { key: 'draft', label: '已备草稿' },
        ],
        rows: items.rows.filter((row) => isRow(row)).map((item) => {
          const draft = draftCells.get(asText(item.item_id))
          return { id: asText(item.item_id), item_id: asText(item.item_id), description: item.description ?? '',
            qty: item.qty, unit: item.unit,
            unit_price_cents: draft?.unit_price_cents ?? '', lead_time_days: draft?.lead_time_days ?? '',
            draft: draft ? `${draft.draft_id}（待签署）` : '' }
        }),
        // 实时小计（外壳在编辑时立刻重算：Σ 单价×数量）；Tab/Enter 走格、Esc 还原、Ctrl+Enter 提交
        totals: [{ label: '报价小计（整数分）', key: 'unit_price_cents', factor: 'qty', unit: '分' },
          { label: '已填条数', key: 'unit_price_cents', count: true, skip_empty: true }],
        ...(referenceable
          // **一份草稿 = 一整张表**：这条 `editable_action` 就是"备报价"的唯一入口（提交编辑 ⇒
          // `editable_defaults` 把 RFQ 引用/币种带上）。**没有 `bulk`**：批量那颗按钮的 presets 只有
          // `{ids, rows}`，`rfq_id`（必填）谁也填不上 ⇒ 点下去必然被「必填」挡在提交前（P22 实测）。
          ? { editable_action: 'quote.draft',
              editable_defaults: { rfq_id: packageId, currency: String(spec.currency ?? 'CNY'), prepared_by: '' },
              // **乐观并发**：把"你打开这一页时看到的这一版草稿"交给界面（保存时带回 `expected_version`）。
              // 对象 = 这份包 + 这一组行项目（与 `quote.draft` 的 concurrency 同一口径，逐字对齐）。
              version: host.versions.current('supplier', 'quote-draft',
                draftSlotOf({ rfq_id: packageId, rows: items.rows.filter((row) => isRow(row)).map((item) => ({ item_id: item.item_id })) })),
              version_for: 'quote.draft' }
          : { degraded: true, reason: 'package-not-in-visible-facts',
              next_action: `本侧事实认得的包 id 目录已到上限（${LIMITS.max_items} 个${known.capped ? '，已满' : ''}）：`
                + `这一份包（${packageId}）不在其中 ⇒ 现在提交必被拒（rfq-not-found）。因此本面板不预填这个包、`
                + `也不给备报价入口（免得你按下去必然被拒）。能作 RFQ 引用的包：`
                + `${known.ids.slice(0, 3).join(' / ') || '（一个都没有）'}`
                + `${known.ids.length > 3 ? ` …（共 ${known.ids.length} 个）` : ''}`
                + ' —— 在「我收到的包」或首页按能引用得上的那个包备报价；'
                + '要让最新那个包也备得了，得先让它的事实进本侧账本（写者/口径问题，不是界面能补的）。' }),
        ref: spec.package_id ? { kind: 'package', id: String(spec.package_id),
          title: `包 ${spec.package_id} rev${envelope.rev ?? '—'}` } : null,
        // **条数口径**：`items` = 能列出（且真能备报价）的行数；`envelope_items` = 信封里声明的条数
        // （不是数组 ⇒ null，"读不出来"与"一条都没有"必须长得不一样）；`dropped` = 读不出来的条数。
        counts: { items: items.rows.length, envelope_items: items.list ? items.all : null,
          dropped: items.dropped, rev: envelope.rev },
        note: `包 ${spec.package_id ?? '—'} rev${envelope.rev ?? '—'} · 报价截止 ${(spec.deadlines ?? {}).quote_by ?? '—'}`
          + ` · 报价一律整数分（8600 = 86.00）；改单价时右边实时算"×量 = 行合计"，底部编辑栏给小计`
          + ` · 键盘：Tab 走格 / Enter 走同列下一行 / Esc 还原 / Ctrl+Enter 提交 —— 备多行报价不用鼠标`
          + ` · 表里填几行就交几行：一次「备这份草稿」= 一条草稿（多行），随后一次人签提交整份`
          + ` · 标题旁的「打开对象 →」是这个包的深链（可复制分享、刷新不丢）`
          + `${receiptNote(receipt) ? ` · ${receiptNote(receipt)}` : ''}`
          + (items.list ? '' : ` · 信封的 \`spec.items\` 是 ${items.shape}（不是行项目数组）⇒ 本表只列得出可读的行项目，`
            + `不拿空表顶替"这份包没有行项目"`)
          + (items.dropped ? ` · 有 ${items.dropped} 条行项目读不出来（形状异常）⇒ 已跳过并逐条计数，不静默丢`
            : '')
          + (referenceable ? '' : ` · 这一份包（${packageId}）现在备不了报价：它不在本侧事实的包目录里`
            + `（目录上限 ${LIMITS.max_items} 个）⇒ 提交必被拒，界面故意不预填它。`) }
    } }))

  // ---- **对象页**：`/app/supplier/package/<pkg-id>/`（我收到的那个包：条目 + 我的草稿进度） ----
  out.push(surface.panel({ plugin_id: me, id: 'package.mine', title: '我收到的包（对象页）', view: 'supplier',
    order: 11, kind: 'table', object_kind: 'package',
    hint: '这一页是那个包的深链（刷新不丢、可复制）：改单价/交期 → 「提交编辑」备草稿 → 再去「我的草稿」人签提交。'
      + '包不在本侧事实的包目录里（目录上限 64 个）时，这一页只读并说明原因（提交必被拒，界面不预填）。'
      + '打开这一页会给发包方留一条已读回执（谁 / 何时 / 看过几次，0600 文件、不进账本）——'
      + '对方看不到你的报价、成本或任何本侧私有数据。',
    data: (ctx) => {
      const wanted = asText(ctx.route?.id)
      const realm = realmOf('supplier')
      const mine = myPackage(host, realm)
      const spec = mine.ok ? (mine.envelope.spec ?? {}) : {}
      const packageId = String(spec.package_id ?? '')
      // 投递名单也是**行读数**：`delivered_to` 不是数组时（字符串/数字/对象）修前 `.join` / `.map` 直接
      // TypeError ⇒ 这一页打不开；现在按形状如实说，不编一个空名单。
      const delivered = mine.ok ? scalarListOf(mine.envelope.delivered_to) : null
      const deliveredText = delivered === null ? ''
        : (delivered.list ? delivered.items.join(' ')
          || (delivered.dropped ? `（名单里有 ${delivered.dropped} 条读不出来）` : '')
          : `（投递名单字段是 ${delivered.shape}，不是名单：读不出来就不编）`)
      if (!mine.ok || (wanted && packageId !== wanted)) {
        return { ok: true, kind: 'table', object: { found: false, title: `包 ${wanted}`,
          reason: mine.ok ? 'package-not-addressed-to-me' : mine.code,
          next_action: mine.ok
            ? `这份包不是发给 ${realm || '本侧'} 的（投递名单：${deliveredText || '—'}）：`
              + '只出自己的那份，回供应商道首页看「发给我的 RFQ 包」'
            : (mine.next_action ?? '') },
          columns: [{ key: 'item_id', label: '行项目' }], rows: [] }
      }
      const items = packageItemsOf(spec)
      // **已读回执**（对象页 = 真正「打开了这个包」）：给发包方留一条「谁在何时看过这个包」
      const receipt = recordPackageReceipt(ctx, packageId, 'package.mine')
      const draftCells = draftCellsOf(typeRows(host.rows('supplier'), 'quote/drafted')
        .map((row) => bodyOf(row)))
      // **乐观并发**：这一页上保存动作要带的"你看到的那一版"（与 `quote.draft` 的 concurrency 同一口径）
      const myDraftVersion = host.versions.current('supplier', 'quote-draft',
        draftSlotOf({ rfq_id: packageId, rows: items.rows.filter((row) => isRow(row)).map((item) => ({ item_id: item.item_id })) }))
      // 这一页也是"备报价"的入口之一 ⇒ **同一条预填判据**（见 `referenceablePackages` 的注释）：
      // 包不在本侧事实的目录里 ⇒ 不预填、不给备报价入口（提交必被拒）。
      const known = referenceablePackages(host)
      const referenceable = known.ids.length === 0 || known.ids.includes(packageId)
      const declared = referenceable ? '（整数分，可直接改）' : '（整数分）'
      // **信封行项目读不出来** ⇒ 如实降级（对象页也不假装健康）；好行照常列出
      const anomaly = itemsAnomaly(packageId, items)
      return { ok: true, kind: 'table', ...anomaly,
        object: { title: `包 ${packageId} rev${mine.envelope.rev ?? '—'}`, found: true,
          subtitle: `发给 ${deliveredText || realm || '本侧'}`
            + ` · 报价截止 ${(spec.deadlines ?? {}).quote_by ?? '—'}`,
          facts: [
            // **条目数分得开**：`条目数` = 能列出的行数；信封里声明的条数与读不出来的条数各自另立一行
            // （"读不出来"不许冒充"一条都没有"，也不许静默吞掉）
            { key: '条目数', value: `${items.rows.length}${items.dropped ? `（另有 ${items.dropped} 条读不出来）` : ''}` },
            ...(items.list ? [] : [{ key: '信封行项目形状', code: true, value: `${items.shape}（不是行项目数组）`
              + ' —— 本页只列得出可读的行项目，不拿空表顶替"这份包没有行项目"' }]),
            ...(items.list ? [{ key: '信封声明的条数', value: String(items.all) }] : []),
            { key: '版本 rev', value: String(mine.envelope.rev ?? '—') },
            { key: '澄清截止', value: String((spec.deadlines ?? {}).clarify_by ?? '—') },
            // **已备草稿**按**逐行数量**算（多行草稿一行一条）：只数得清"这一行有没有草稿"，
            // 不拿"草稿份数"冒充"备了几行"（P28 走查：多行草稿曾显示 1 / 2，像有一行没备）
            { key: '已备草稿', value: `${items.rows.filter((row) => isRow(row))
              .filter((item) => draftCells.has(asText(item.item_id))).length} / ${items.rows.length}` },
            // 「能不能当 RFQ 引用」是备报价的前置判据 ⇒ 明写在对象页上（不在目录里就说不在）
            { key: '可作 RFQ 引用', value: referenceable
              ? '是（在本侧事实的包目录里）'
              : `否 —— 不在本侧事实的包目录里（目录上限 ${LIMITS.max_items} 个包）`
                + ' ⇒ 现在备报价会被 rfq-not-found 拒，本页因此只读' },
            { key: '我方草稿的版本', code: true, value: myDraftVersion
              ? `rev ${myDraftVersion.rev} · ${myDraftVersion.at} · ${myDraftVersion.by || '（未记名）'}`
              : '还没有人保存过这份包的这一版报价草稿（第一次保存按"首次"记下来）' },
            // **当次留痕如实可见**（表格式面板的 `note` 只在空态渲染 ⇒ 回执这件事写进对象页事实里，
            // 用户真的看得到"我这一眼已经被记下了"）
            { key: '已读回执（发包方能看到）', value: receiptNote(receipt)
              || '这次没记（没有会话身份 → 不记回执；回执是读取痕迹，不进账本）' },
          ],
          links: [],
          // 分享：这个包的可见性由插件声明（机制据此写"对方需要什么身份/侧"）
          share: { visibility: 'both', other_side_view: 'supplier',
            requirements: ['对方需要用承包商侧的身份登录（它是发包方）；这份包是按 realm 投递的，'
              + '只出现在被邀请方的视图里'],
            note: '包是交付件：你看到的是发给本侧的版本事实与行项目；对方那一侧只认它自己的投递信封。' },
          // **乐观并发**：这个对象页上的保存动作要带的那一版（草稿槽 = 这份包）
          version: myDraftVersion },
        columns: [
          { key: 'item_id', label: '行项目', type: 'code', pin: 'left' }, { key: 'description', label: '描述' },
          { key: 'qty', label: '数量' }, { key: 'unit', label: '单位' },
          { key: 'unit_price_cents', label: `单价${declared}`, ...(referenceable ? { editable: true } : {}),
            type: 'number', line_total_of: 'qty', help: '8600 = 86.00 元' },
          { key: 'lead_time_days', label: `交期（天${referenceable ? '，可直接改' : ''}）`,
            ...(referenceable ? { editable: true } : {}), type: 'number' },
          { key: 'draft', label: '已备草稿' },
        ],
        rows: items.rows.filter((row) => isRow(row)).map((item) => {
          const draft = draftCells.get(asText(item.item_id))
          return { id: asText(item.item_id), item_id: asText(item.item_id), description: item.description ?? '',
            qty: item.qty, unit: item.unit,
            unit_price_cents: draft?.unit_price_cents ?? '', lead_time_days: draft?.lead_time_days ?? '',
            draft: draft ? `${draft.draft_id}（待签署）` : '' }
        }),
        totals: [{ label: '报价小计（整数分）', key: 'unit_price_cents', factor: 'qty', unit: '分' },
          { label: '已填条数', key: 'unit_price_cents', count: true, skip_empty: true }],
        ...(referenceable
          ? { editable_action: 'quote.draft',
              editable_defaults: { rfq_id: packageId, currency: String(spec.currency ?? 'CNY'), prepared_by: '' } }
          : { degraded: true, reason: 'package-not-in-visible-facts',
              next_action: `这一份包（${packageId}）不在本侧事实的包目录里（上限 ${LIMITS.max_items} 个包）`
                + ' ⇒ 现在备报价必被拒（rfq-not-found）：本页不预填这个包、也不给备报价入口。'
                + `能作 RFQ 引用的包：${known.ids.slice(0, 3).join(' / ') || '（一个都没有）'}`
                + `${known.ids.length > 3 ? ` …（共 ${known.ids.length} 个）` : ''}。`
                + '要让最新那个包也备得了，得先让它的事实进本侧账本。' }),
        counts: { items: items.rows.length, envelope_items: items.list ? items.all : null,
          dropped: items.dropped, rev: mine.envelope.rev },
        note: '这一页是那个包的对象地址（刷新不丢、可复制）：改单价/交期 → 「备这份草稿」→ 再去「我的草稿」人签提交'
          + `${receiptNote(receipt) ? ` · ${receiptNote(receipt)}` : ''}`
          + (items.dropped ? ` · 有 ${items.dropped} 条行项目读不出来（形状异常）⇒ 已跳过并逐条计数，不静默丢`
            : '') }
    } }))

  out.push(surface.panel({ plugin_id: me, id: 'quote.object', title: '报价逐行明细（承包商收到的）',
    view: 'contractor', order: 36, kind: 'table', object_kind: 'quote',
    data: (ctx) => {
      const wanted = asText(ctx.route?.id)
      const { json } = inboxOf()
      const bagOf = (json.packages ?? []).find((bag) => (bag.quotes ?? [])
        .some((quote) => asText(quote.quote_id) === wanted))
      const quote = bagOf ? (bagOf.quotes ?? []).find((row) => asText(row.quote_id) === wanted) : null
      if (!quote) {
        return { ok: true, kind: 'table', object: { found: false, title: `报价 ${wanted}`,
          reason: json.ok ? 'quote-not-in-my-view' : (json.reason ?? json.refusal?.code ?? 'inbox-failed'),
          next_action: json.ok
            ? '这份报价不在承包商侧收件箱里：回「报价收件箱」（承包商道）点行内「打开 →」用真实存在的深链'
            : (json.next_action ?? json.refusal?.next_action ?? '看只读工具的输出') },
          columns: [{ key: 'item_id', label: '行项目' }], rows: [] }
      }
      // **逐行读数（唯一入口）**：收件箱 JSON 由只读工具给；数组里混坏行 ⇒ 好行照列 + 逐条计数，
      // 一条坏行不再把整块面板打崩（修前实测：`line.item_id` 直接 TypeError ⇒ data-failed）。
      const lines = readRows(quote.items)
      return { ok: true, kind: 'table',
        object: { title: `报价 ${asText(quote.quote_id)}`, found: true,
          subtitle: `供应商 ${asText(quote.supplier)} · 包 ${asText(bagOf.package_id)} rev${bagOf.rev ?? '—'}`
            + ` · ${asText(quote.vs_current_rev)}`,
          facts: [
            { key: '行合计（整数分）', value: String(quote.total_cents ?? '') },
            { key: '提交时刻', value: String(quote.submitted_at ?? '') },
            { key: '受理状态', value: String(quote.review_status ?? '') },
            { key: '签署人（人签）', value: String(quote.approved_by ?? '—') },
            { key: '人工门', value: String(quote.approval_id ?? '—'), code: true },
          ],
          links: [
            { kind: 'package', id: asText(bagOf.package_id), title: `包 ${asText(bagOf.package_id)}` },
          ].filter((link) => link.id !== '') },
        columns: [{ key: 'item_id', label: '行项目', type: 'code' }, { key: 'qty', label: '量', filter: 'number' },
          { key: 'unit_price_cents', label: '单价（整数分）', filter: 'number' }, { key: 'lead_time_days', label: '交期（天）', filter: 'number' }],
        // **逐行读数**（收件箱 JSON 由只读工具给；数组里混坏行 ⇒ 好行照列 + 逐条计数，不打崩面板）
        rows: lines.rows.filter((row) => isRow(row)).map((line) => {
          const id = asText(line.item_id)
          return { ...(id ? { id } : {}), item_id: id || '（无 id）', qty: line.qty,
            unit_price_cents: line.unit_price_cents, lead_time_days: line.lead_time_days }
        }),
        counts: { lines: lines.rows.length, quoted_items: lines.all, dropped: lines.dropped },
        note: '受理 / 退回 / 要求补件是人工门：本页工具栏上的那个动作直接对这份报价发起（id 已按地址预填，'
          + '不必手抄）；逐行单价与量的对账口径见「报价收件箱」面板的备注'
          + (lines.dropped
            ? ` · 收件箱里这份报价有 ${lines.dropped} 条行读不出来（形状异常）⇒ 已跳过并逐条计数，不静默丢`
            : '') }
    } }))

  out.push(surface.panel({ plugin_id: me, id: 'quote.drafts', title: '我的草稿（待签署）', view: 'supplier',
    order: 20, kind: 'table', actions: ['quote.submit'],
    // **勾选语义写在这句里**（`hint` 是**真的渲染出来**的那一句；P20 把这段话写在 `data.note` 里 ——
    // 而 table 面板的 `data.note` 只在"没有行"时当 next_action 用，用户**看不到**）。
    // 措辞与界面上的实际字符串逐字对齐：提交按钮写「已选 X 行」/「已选 0（含不在本页共 M） 行」、
    // 计数行写「已勾选 M 行」「取消勾选」「选中全部命中行（N）」。
    // **P25 按事实改口**：P21 之后手工勾选**跨页保留**（真跑：勾 2 行 → 翻到第 2 页 → 再翻回来，
    // 那 2 行还是勾着的、按钮写「已选 2 行」），原先那句"勾只算这一页 / 翻页后不跟着走"与事实不符。
    hint: '勾选语义（说清，免得少签）：表格左侧的勾按这一块记、跨页保留 —— 翻到下一页时，'
      + '上一页勾着的行不会丢（翻回来还是勾着的，勾过的行有底色）。'
      + '提交按钮上那个数字就是这一次真会送出的行数（手工勾过的 + 「选中全部命中行」选上的）：'
      + '本页没勾、只有别页勾着时它写成「已选 0（含不在本页共 M） 行」，计数行同时写「已勾选 M 行」。'
      + '要按命中行签，先把命中行筛到 50 行以内，再点计数行上那颗「选中全部命中行（N）」：'
      + '它把命中全集选上（换筛选条件会自动作废这次跨页选择）。'
      + '本块含「已签署提交」的历史行（按「状态」列筛「待签署」只看待办的）；一次最多签 50 份。',
    data: () => {
      const drafts = new Map()
      for (const row of typeRows(host.rows('supplier'), 'quote/drafted')) {
        const body = bodyOf(row)
        const id = asText(body.quote_draft_id) || asText(row?.correlation_id)
        if (!id) continue
        // **逐行读数（唯一入口）**：`lines` 里混着 null/字符串/数字时，修前 `line.item_id` 直接 TypeError
        // ⇒ 整块「我的草稿」面板 data-failed（一条坏行把面板打崩）；现在好行照列、坏行逐条计数。
        const lines = readRows(body.lines)
        // 「首行」三列的口径见 `firstLineReader`：标量键优先，读不出来回落到 `lines[0]`
        const first = firstLineReader(body, lines)
        drafts.set(id, { id, quote_draft_id: id, draft_id: id, rfq_id: body.rfq_id ?? body.package_id ?? '',
          // **首行三列同样回落到 `lines[0]`**（与「已提交的报价」同一口径：多行形态的标量键只有首行）
          item_id: first('item_id'), unit_price_cents: first('unit_price_cents'),
          lead_time_days: first('lead_time_days'), prepared_by: body.prepared_by ?? '',
          line_count: lines.all || 1,
          lines_text: lines.rows.length > 1 ? lines.rows.map(lineLabelOf).join(' ')
            + (lines.dropped ? `（+${lines.dropped} 条读不出来）` : '')
            : (lines.dropped ? `（有 ${lines.dropped} 条行读不出来）` : ''),
          ts: row.ts ?? '' })
      }
      const submitted = new Set(typeRows(host.rows('supplier'), 'quote/submitted')
        .map((row) => asText(bodyOf(row).quote_draft_id)))
      const rows = [...drafts.values()].map((draft) => ({ ...draft,
        status: submitted.has(draft.quote_draft_id) ? '已签署提交' : '待签署' }))
      if (!rows.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-drafts',
          next_action: '在上面的「发给我的 RFQ 包」里填单价与交期，然后「备这份草稿」（整张表一次提交）',
          columns: [{ key: 'quote_draft_id', label: '草稿' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        columns: [{ key: 'quote_draft_id', label: '草稿', type: 'code' }, { key: 'rfq_id', label: '包', type: 'code' },
          { key: 'line_count', label: '行数', filter: 'number' }, { key: 'item_id', label: '首行项目', type: 'code' },
          { key: 'lines_text', label: '逐行（条目@单价分）' },
          { key: 'unit_price_cents', label: '首行单价（整数分）', filter: 'number' },
          { key: 'lead_time_days', label: '首行交期（天）', filter: 'number' }, { key: 'status', label: '状态', filter: 'enum' }],
        rows, row_actions: ['quote.submit'], counts: { drafts: rows.length },
        // **批量人签**（一次署名 → 逐份落账）：表头出现勾选框与「批量人签提交」按钮；勾几份签几份，
        // 每一份仍各自跑唯一写者 quote-sign.py（见 quote.submit-batch 的服务端一半）。
        bulk: 'quote.submit-batch',
        note: '草稿不是报价：只有人签提交（quote/submit）之后才算对外报价（AGENTS.md 规则 3）；'
          + '一份草稿 = 一整张表（行数 > 1 的草稿签一次就提交全部行）；'
          + '一天几十份时用表格左侧勾选框多选后点「批量人签提交」（一次署名、逐份落账、逐份可拒）。'
          + '这一块含「已签署提交」的历史行（按「状态」列筛「待签署」只看待办的）；'
          + `一次最多签 ${BATCH_SIGN_MAX} 份，超过会被具名拒（batch-too-large）；`
          + '勾选跨页保留（翻到下一页时上一页的勾不丢，翻回来还是勾着的）—— 要按「命中行」签，'
          + `先筛到 ≤ ${BATCH_SIGN_MAX} 行、再点计数行上那颗「选中全部命中行（N）」` }
    } }))

  out.push(surface.panel({ plugin_id: me, id: 'quote.submitted', title: '已提交的报价（提交结果回读）',
    view: 'supplier', order: 30, kind: 'table',
    data: () => {
      const rows = typeRows(host.rows('supplier'), 'quote/submitted').map((row) => bodyOf(row))
      if (!rows.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-submitted-quotes',
          next_action: '把草稿签了：行内「人签提交」→ 填 human:<你的名字>',
          columns: [{ key: 'quote_id', label: '报价' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        columns: [{ key: 'quote_id', label: '报价', type: 'code' }, { key: 'package_id', label: '包', type: 'code' },
          { key: 'line_count', label: '行数', filter: 'number' }, { key: 'item_id', label: '首行项目', type: 'code' },
          { key: 'lines_text', label: '逐行（条目@单价分）' },
          { key: 'unit_price_cents', label: '首行单价（整数分）', filter: 'number' },
          { key: 'lead_time_days', label: '首行交期（天）', filter: 'number' }, { key: 'approved_by', label: '签署人', type: 'code' },
          { key: 'approval_id', label: '人工门', type: 'code' }, { key: 'submitted_at', label: '提交时刻', filter: 'date' }],
        rows: rows.map((row) => {
          const lines = readRows(row.lines)
          // **标量三列回落到首行**：多行形态的 `item_id` / `unit_price_cents` / `lead_time_days` 在账本里
          // 就是 `""` / `null`（真值在 `lines[]` 里）—— P28 走查实测：那两列空着，像"这份报价没有单价"
          const first = firstLineReader(row, lines)
          return { id: row.quote_id, ...row, line_count: lines.all || 1,
            item_id: asText(row.item_id) || asText(lines.rows[0]?.item_id),
            unit_price_cents: first('unit_price_cents'), lead_time_days: first('lead_time_days'),
            lines_text: lines.rows.length > 1 ? lines.rows.map(lineLabelOf).join(' ')
              + (lines.dropped ? `（+${lines.dropped} 条读不出来）` : '')
              : (lines.dropped ? `（有 ${lines.dropped} 条行读不出来）` : ''),
            ref: { kind: 'quote', id: asText(row.quote_id), title: `报价 ${asText(row.quote_id)}` } }
        }),
        counts: { quotes: rows.length },
        note: '每一行都对应一次人签的人工门（approval/requested → granted → quote/submitted，顺序不可颠倒）；'
          + '一份报价 = 一次人签：行数 > 1 的报价是一次签完整份的（逐行在 `lines` 里）；'
          + '「首行项目 / 首行单价 / 首行交期」三列**在标量键为空时回落到 `lines[0]`**（多行形态的标量键本来就只有首行）' }
    } }))

  // ---- **对象页**：`/app/supplier/quote/<q-…>/`（我提交的那份报价的全链事实） ----
  out.push(surface.panel({ plugin_id: me, id: 'quote.mine', title: '我的报价（对象页：提交与批准记录）',
    view: 'supplier', order: 31, kind: 'kv', object_kind: 'quote',
    data: (ctx) => {
      const wanted = asText(ctx.route?.id)
      const rows = readRows(typeRows(host.rows('supplier'), 'quote/submitted')).rows.map(bodyOf)
      const quote = rows.find((row) => asText(row.quote_id) === wanted)
      if (!quote) {
        return { ok: true, kind: 'kv', object: { found: false, title: `报价 ${wanted}`,
          reason: 'quote-not-in-my-view',
          next_action: '这份报价不在供应商侧账本里：回「已提交的报价」面板，点行内「打开 →」用真实存在的深链' },
          items: [] }
      }
      const gates = readRows(typeRows(host.rows('supplier'), 'approval/')).rows.map(bodyOf)
        .filter((row) => asText(row.ref) === wanted)
      // **逐行读数（唯一入口）**：`lines` 里混着 null/字符串/数字时，修前 `${line.item_id}` 直接 TypeError
      // ⇒ 整个「我的报价」对象页打不开（data-failed）；现在好行照列、坏行逐条计数。
      const lines = readRows(quote.lines)
      return { ok: true, kind: 'kv',
        object: { title: `报价 ${asText(quote.quote_id)}`, found: true,
          subtitle: `包 ${asText(quote.package_id)} · rev${asText(quote.rfq_rev) || '—'}`
            + ` · ${asText(quote.currency)}`,
          facts: [
            { key: '行数', value: `${lines.all}${lines.dropped ? `（其中 ${lines.dropped} 条读不出来）` : ''}` },
            { key: '签署人（人签）', value: asText(quote.approved_by), code: true },
            { key: '人工门', value: asText(quote.approval_id), code: true },
            { key: '提交时刻', value: asText(quote.submitted_at) },
          ],
          links: [{ kind: 'package', id: asText(quote.package_id),
            title: `包 ${asText(quote.package_id)}` }].filter((link) => link.id !== '') },
        items: [
          { key: '逐行', value: lines.rows.map((line) => `${asText(line.item_id) || '（无 id）'}: `
            + `${cellText(line.unit_price_cents) || '—'} 分 / ${cellText(line.lead_time_days) || '—'} 天`).join('；')
            + (lines.dropped ? `${lines.rows.length ? '；' : ''}（另有 ${lines.dropped} 条行读不出来：形状异常，已跳过并计数）` : '')
            || '（没有行明细）' },
          { key: '人工门记录', value: gates.map((gate) => `${gate.status ?? ''} ${gate.decided_by ?? ''}`
            + ` ${gate.comment ?? ''}`.trim()).join(' | ') || '（没有批准记录）' },
          { key: '对账口径', value: '金额一律整数分；这一页只读，改报要按新版重填（人签提交）' },
        ],
        note: '这一页是那份报价的对象地址：刷新不丢、可复制；对外承诺类动作只有人签提交那一步'
          + `（提交入口在「我的草稿」面板）。` }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'quote.draft', title: '备报价草稿（整张表一次提交）', views: ['supplier'],
    group: '报价', order: 10,
    // **乐观并发**（机制）：这个动作保存的是"我方对这份包的报价草稿"（同一组行项目 = 同一个对象）。
    // 两个同事各自打开这份包、先后保存 ⇒ 后保存的人被**明确拒绝**并看到"谁在何时把哪条改成了什么"。
    concurrency: { object_class: 'quote-draft', label: '我方对这份包的报价草稿',
      object_id: (ctx, input) => draftSlotOf(input), state: (ctx, input) => draftStateOf(input) },
    input: {
      bulk: 'rows',
      fields: [
        { name: 'rfq_id', label: 'RFQ 引用', type: 'text', required: true, help: '必须出现在本侧事实里' },
        { name: 'item_id', label: '行项目', type: 'text', help: '批量提交时每行自带 item_id（可留空）' },
        { name: 'unit_price_cents', label: '单价（整数分）', type: 'number',
          min: LIMITS.unit_price_cents_min, max: LIMITS.unit_price_cents_max,
          help: '8600 = 86.00 元；批量时每行自带（单条提交时必填）' },
        { name: 'lead_time_days', label: '交期（天）', type: 'number',
          min: LIMITS.lead_time_days_min, max: LIMITS.lead_time_days_max,
          help: '批量时每行自带（单条提交时必填）' },
        { name: 'currency', label: '币种', type: 'text', default: 'CNY' },
        { name: 'prepared_by', label: '发言人', type: 'text', required: true, identity: true,
          help: 'human:<你的名字>（登录后会按会话身份自动填）' },
        { name: 'note', label: '备注（可选）', type: 'textarea' },
      ] },
    hint: '一份草稿 = 一整张表：表里填几行就交几行，落一条草稿（`lines`）；'
      + '草稿是非签名动作（不产生对外义务），随后「人签提交」一次签完整份',
    server: async (ctx, input) => {
      const rows = Array.isArray(input.rows) && input.rows.length ? input.rows : [input]
      const payload = payloadOf(host, 'supplier')
      const rows0 = (host.rows('supplier') ?? []).find((row) => asText(row?.realm) !== '') ?? null
      const preparedBy = asText(input.prepared_by)
      if (!preparedBy.startsWith('human:')) {
        return { ok: false, code: 'human-required', reason: '草稿也要有人认领：prepared_by 必须以 human: 开头',
          next_action: '写 human:<你的名字>' }
      }
      // ① 逐行字段校验（沿用插件自己的字段级规则与拒绝码；行号进 `field` 让人知道是哪一行错）
      const lines = []
      const failures = []
      for (const row of rows.slice(0, LIMITS.max_items)) {
        // **行形状异常不静默、也不抛错**：`rows` 里混进 null/字符串/数字时，修前 `row.item_id` 直接
        // TypeError ⇒ 整个「备这份草稿」提交崩掉（用户看到的是报错而不是"哪一行不对"）。
        // 现在落一条具名失败（整批按既有语义拒绝：`failures.length` ⇒ 什么都没落盘）。
        if (!isRow(row)) {
          failures.push({ item_id: null, code: 'row-malformed',
            reason: `第 ${lines.length + failures.length + 1} 行的形状是 ${shapeOf(row)}（不是对象）：`
              + '批量提交的每一行都必须是行对象（含 item_id / unit_price_cents / lead_time_days）',
            next_action: '把这一行的形状改对（或从「发给我的 RFQ 包」表里重新提交编辑）' })
          continue
        }
        const itemId = asText(row.item_id ?? row.id)
        const form = { get: (key) => ({ rfq_id: asText(input.rfq_id), item_id: itemId,
          unit_price_cents: String(row.unit_price_cents ?? input.unit_price_cents ?? ''),
          lead_time_days: String(row.lead_time_days ?? input.lead_time_days ?? ''),
          prepared_by: preparedBy, currency: asText(input.currency) || 'CNY',
          note: String(input.note ?? '') }[key]) }
        const verdict = validate({ view: 'supplier', form, payload }, { views: ['supplier'], ...LIMITS })
        if (!verdict.ok) {
          failures.push({ item_id: itemId, code: verdict.errors?.[0]?.code ?? 'validation-failed',
            reason: (verdict.errors ?? []).map((item) => `第 ${lines.length + failures.length + 1} 行 ${item.field}:`
              + `${item.message}`).join('；'),
            next_action: verdict.errors?.[0]?.next_action ?? '按字段错误改后重提' })
          continue
        }
        lines.push({ item_id: asText(verdict.record.item_id), unit_price_cents: verdict.record.unit_price_cents,
          lead_time_days: verdict.record.lead_time_days })
      }
      // ② 结构门：重复行项目会让「这份报价总共多少」没有唯一答案 ⇒ 明确拒（不悄悄去重）
      const seen = new Set()
      for (const line of lines) {
        if (seen.has(line.item_id)) {
          failures.push({ item_id: line.item_id, code: 'line-duplicate',
            reason: `行项目 ${line.item_id} 在表里出现了两次`,
            next_action: '同一个行项目只留一行（重复会让总价没有唯一答案）' })
        }
        seen.add(line.item_id)
      }
      if (failures.length || !lines.length) {
        return { ok: false, code: failures.length ? 'validation-failed' : 'no-lines',
          reason: failures.map((item) => `${item.item_id}: ${item.reason}`).join('；')
            || '表里没有可提交的行（一行都没有 ⇒ 不落任何草稿）',
          next_action: '按每条的 next_action 改后重提（本次什么都没落盘）',
          result: { applied: [], failures, drafts: 0, lines: 0 } }
      }
      // ③ **一整张表 → 一条草稿**：多行带 `lines`（标量三键写第一行，供既有读者兜底），单行沿用旧形状
      const supplierRealm = asText(rows0?.realm) || registrationRealmOf(host) || 'supplier:gui'
      const first = lines[0]
      const prepared = { schema: 1, kind: 'quote-draft', view: 'supplier', requested_action: 'draft',
        rfq_id: asText(input.rfq_id), item_id: first.item_id, unit_price_cents: first.unit_price_cents,
        lead_time_days: first.lead_time_days, currency: asText(input.currency) || 'CNY',
        prepared_by: preparedBy, note: String(input.note ?? ''), supplier: supplierRealm, submitted_at: '' }
      if (lines.length > 1) prepared.lines = lines
      // 草稿 id / 行哈希 / 备注哈希：与宿主既有那条路由（`webui.mjs` 的 `submitDraft`）**同一算法**，
      // 唯一写者 `tools/quote-draft.py` 会对它们逐字节重算复核（对不上就拒、账本零新增）。
      prepared.note_sha256 = sha256(prepared.note ?? '')
      prepared.lines_sha256 = sha256(canonicalLines(prepared))
      prepared.bytes = Buffer.byteLength(String(prepared.note ?? ''), 'utf8')
      const draftId = `qd-supplier-` + sha256([prepared.view, supplierRealm, canonicalLines(prepared),
        String(prepared.note ?? ''), String(prepared.prepared_by ?? '')].join('\n')).slice(0, 12)
      prepared.quote_draft_id = draftId
      const staged = host.stage('quote-drafts', prepared, { name: `${draftId}.json` })
      if (!staged.ok) {
        return { ok: false, code: staged.code ?? 'pending-write-failed', reason: staged.reason ?? '',
          next_action: staged.next_action ?? '先修待办件目录权限（宿主只落 0600 待办件）',
          result: { applied: [], failures: [], drafts: 0, lines: 0 } }
      }
      const run = host.runPython('src/domain/quote-prepare/tools/quote-draft.py',
        ['--inbox', `${host.sharedDir}/quote-drafts`, '--ui-shared', host.sharedDir, '--view', 'supplier',
          '--ledger-supplier', supplierLedger(), '--ledger-contractor', contractorLedger(),
          '--now', host.now()])
      // ---- **判据只有一条**：写者回执（退出码 + stdout JSON），且只认**本动作落的那一条待办件** --------
      // 修前的**假失败**（两个子 agent 实测、原样复现）：`ok` 里叠了一条自造断言
      // `Number(applied[0].line_count) === lines.length` ——
      //   · `applied[0]` 是"写者这一次消费的**第一条**"，写者一次消费多条待办件时那不是我的；
      //   · 单行草稿在写者侧 `line_count` 是"`lines` 数组有几条"（恒 0）⇒ 断言恒不成立。
      // 结果：账本真落了行、响应报 `writer-refused`；用户看到失败→**重复提交**（比真失败更坏）。
      // 现在：ok/code/ledger_added/next_action **全部**从 `receipt` 派生，归属用 `staged.name` 显式指认。
      const receipt = host.writerReceipt(run)
      const mine = receipt.item({ file: staged.name, draft_id: draftId })
      const written = mine && mine.where === 'applied' ? mine.entry : null
      const duplicated = mine && mine.where === 'duplicates' ? mine.entry : null
      const refusedRow = mine && mine.where === 'refused' ? mine.entry : null
      const ok = Boolean(written || duplicated)
      // 本动作**自己**真落了几行（写者逐条给 `ledger_added`；不是本次运行的全局数）
      const ledgerAdded = written ? Number(written.ledger_added ?? 0) : 0
      // 同一次运行里写者还处理了**别人**的待办件（不属于本动作）：如实列出来 ——
      // 否则用户会看到"本动作零新增"而账本行数却变了，又是一处对不上。
      const mineName = staged.name
      const othersApplied = (receipt.applied ?? []).filter((row) => host.receiptFileName(row) !== mineName)
      const otherRefused = (receipt.refused ?? []).filter((row) => host.receiptFileName(row) !== mineName)
      const othersNote = (written || duplicated) ? '' : (othersApplied.length || otherRefused.length
        ? `（同一次运行里写者还处理了 ${othersApplied.length + otherRefused.length} 条别的待办件：`
          + `${othersApplied.length} 条已落行、${otherRefused.length} 条被拒 —— 那些不属于本动作）`
        : '')
      const code = ok ? 'drafted'
        : (refusedRow?.code ?? receipt.code ?? (mine ? 'writer-refused' : 'writer-receipt-missing'))
      const reason = refusedRow?.reason ?? (ok ? '' : (receipt.reason || ''))
      return { ok, code, reason,
        next_action: ok
          ? `草稿已落账（quote/drafted，${written ? (written.line_count ?? lines.length) : lines.length} 行`
            + `，供应商 + 承包商各一条 ⇒ 本动作账本 +${ledgerAdded} 行）：在「我的草稿」里点「人签提交」`
            + '一次签完整份（不必一行签一次）'
            + (duplicated ? '；这一份本来就在账本里（幂等：本次零新增）' : '')
            + (otherRefused.length ? `；同一次运行里另有 ${otherRefused.length} 条待办件被拒`
              + `（${otherRefused.map((row) => row?.file ?? '?').join(' / ')}）—— 它们不属于本动作` : '')
          : (refusedRow?.next_action ?? receipt.next_action
            ?? `这条待办件（${mineName}）没在写者回执里出现（applied/duplicates/refused 都没有）`
              + '⇒ 本动作账本零新增：看 result.writer_stdout 定位，再重提交')
            + othersNote,
        result: { applied: [{ item_id: first.item_id, quote_draft_id: draftId,
          line_count: written ? (written.line_count ?? lines.length) : lines.length,
          lines, pending: staged.file, pending_file: staged.name,
          // 这一条真落的行数（写者回执逐条给）+ 它落在哪两本账上
          ledger_added: ledgerAdded, ledger_rows: written?.ledger_rows ?? [],
          event: written ? (written.event ?? 'quote/drafted') : null, ok,
          refusal: refusedRow, duplicate: duplicated,
          writer_stdout: receipt.stdout_tail }],
        failures, drafts: ok ? 1 : 0, lines: lines.length,
        writer: { rc: receipt.rc, stdout_ok: receipt.said, code: receipt.code,
          ledger_added: receipt.ledger_added, refused: receipt.refused, skipped: receipt.skipped,
          others: { applied: othersApplied.map((row) => ({ file: row?.file ?? '', code: null })),
            refused: otherRefused.map((row) => ({ file: row?.file ?? '', code: row?.code ?? '' })) } } } }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'quote.submit', title: '人签提交报价', views: ['supplier'],
    group: '报价', order: 20, permission: 'human-signature',
    confirm: { required: true, message: '提交报价是对外承诺：确认以你的署名提交？' },
    hint: '人工门：一份草稿签一次就提交整份（草稿里有几行就提交几行，不必一行签一次）；'
      + '服务端会校验署名 == 会话身份，不一致一律拒（`signer-mismatch`，账本零新增）；'
      + '落账本的是唯一写者 tools/quote-sign.py（界面不代签、不写账本）',
    input: { fields: [
      { name: 'draft_id', label: '草稿 id', type: 'text', required: true, from_row: true,
        pattern: '^qd-[A-Za-z0-9-]+-[0-9a-f]{12}$',
        help: '从「我的草稿」一列复制（qd-supplier-…）；在那一行点「人签提交报价」会自动带上，'
          + '工具栏/命令面板里点它也会先让你从草稿里**挑一条**（缺上下文不摆空表单）' },
      { name: 'signature', label: '署名（人签）', type: 'signature', required: true, help: 'human:<你的名字>' },
      { name: 'comment', label: '批注（进批准记录，不进报价正文）', type: 'text' },
      { name: 'timeout_policy', label: '超时策略', type: 'select', options: ['remind', 'escalate', 'abort'],
        default: 'remind' },
    ] },
    server: async (ctx, input) => {
      // 服务端一半**再核一遍**署名 == 会话身份（机制层已在动作总线上拦一次；这里在插件侧留痕，
      // 免得有人绕过外壳直接调这个服务端一半时少一道门）。
      const session = ctx.session && typeof ctx.session === 'object' ? ctx.session : null
      const typed = asText(input.signature)
      if (session && session.human && typed !== session.human) {
        return { ok: false, code: 'signer-mismatch',
          reason: `署名 ${typed} 与会话身份 ${session.human} 不一致`,
          next_action: `人签只能本人签：用 ${session.human} 署名，或切换到该身份的会话（账本零新增）` }
      }
      const run = host.runPython('src/domain/quote-prepare/tools/quote-sign.py',
        ['--ui-shared', host.sharedDir, '--draft-id', asText(input.draft_id),
          '--actor', typed, '--now', host.now(),
          '--comment', String(input.comment ?? ''), '--timeout-policy', asText(input.timeout_policy) || 'remind',
          '--ledger-supplier', supplierLedger(), '--ledger-contractor', contractorLedger()])
      // ---- **判据只有一条**：写者回执（退出码 + stdout JSON）------------------------------------------------
      // 归属**按草稿 id 指认**（写者回执的每条 applied/duplicates 都带 `draft_id`），不猜 `applied[0]`；
      // 幂等（同一份草稿再签）⇒ 账本零新增，响应必须**如实说"零新增"**（不能照抄"多了三条"那句话）。
      const receipt = host.writerReceipt(run)
      const draftId = asText(input.draft_id)
      const mine = receipt.item({ draft_id: draftId })
      const written = mine && mine.where === 'applied' ? mine.entry : null
      const already = mine && mine.where === 'duplicates' ? mine.entry : null
      const refusedRow = mine && mine.where === 'refused' ? mine.entry : null
      // 兜底：写者没有逐条给 id（旧版回执）但整次运行成功且确有 applied ⇒ 按成功算（同源，不猜内容）
      const fallbackWritten = !mine && receipt.ok === true && receipt.applied.length > 0
      const ok = Boolean(written || already || fallbackWritten)
      const ledgerAdded = already ? 0 : Number(receipt.ledger_added ?? 0)
      const lines = Number((written ?? receipt.applied.find((row) => row?.view === 'supplier')
        ?? receipt.applied[0] ?? {}).line_count ?? 0)
      const code = ok ? (already && !written ? 'already-signed' : 'submitted')
        : (refusedRow?.code ?? receipt.code ?? 'writer-failed')
      return { ok, code, reason: refusedRow?.reason ?? (ok ? '' : receipt.reason),
        next_action: ok
          ? (already && !written
            ? `这一份（${draftId}）已经签过了：账本零新增（签名是幂等动作，不会产生第二条报价事实）——`
              + '去「已提交的报价」面板回读那一条'
            : `已提交：本侧账本多了 approval/requested、approval/granted、quote/submitted 三条`
              + `${lines > 1 ? `（这一份报价 ${lines} 行，一次签完）` : ''}；`
              + `承包商账本多了「供应商已提交报价」一条 ⇒ 本次账本共 +${ledgerAdded} 行`
              + '（下面两个面板都能回读）')
          : (refusedRow?.next_action ?? receipt.next_action
            ?? '看 stdout/stderr 定位唯一写者的拒绝原因（拒绝时账本零新增）'),
        result: { quote_id: receipt.json?.quote_id ?? null, approval_id: receipt.json?.approval_id ?? null,
          applied: receipt.applied, duplicates: receipt.duplicates, ledger_added: ledgerAdded,
          line_count: lines, supplier: receipt.json?.supplier ?? null,
          contractor: receipt.json?.contractor ?? null,
          // 原始判据（rc + stdout JSON）与本次运行的全局读数都留在回执里，供界面/审计核对
          writer: { rc: receipt.rc, stdout_ok: receipt.said, code: receipt.code,
            ledger_added: receipt.ledger_added, json: receipt.json } } }
    } }))

  /**
   * **批量人签提交报价**（一次署名 → **逐份落账**）—— 现实里一份包几十行、一天几十份，逐份点一次是磨人的。
   *
   * 语义**一条都不松**：
   *   · 署名仍只有**一次**，人签门一字未动（机制层先校验「已登录 + 署名 == 会话身份」，插件侧再核一遍）；
   *   · 落账仍是**一份一份**的：每一份草稿**单独**跑唯一写者 `tools/quote-sign.py`（同一条写路径、
   *     同一张人工门形状 approval/requested → approval/granted → quote/submitted），
   *     不存在「一个动作落多条」这种绕过人签门的旁路；
   *   · 每份**各自判定**（写者自己判：草稿在不在本账本 / 行被改过 / 已经签过）⇒ 某一份被拒**不影响**其余份，
   *     回执逐条列「已签 / 幂等（零新增）/ 被拒（原因）」，不是全成或全败的二选一；
   *   · **幂等**：同一批再签一次，写者按草稿 id 认出 already-signed ⇒ **账本零新增**（回执如实说零新增）。
   */
  const DRAFT_ID_RE = /^qd-[A-Za-z0-9-]+-[0-9a-f]{12}$/
  out.push(surface.action({ plugin_id: me, id: 'quote.submit-batch',
    title: '批量人签提交（多选一次签，逐份落账）', views: ['supplier'], group: '报价', order: 21,
    permission: 'human-signature',
    confirm: { required: true, message: '批量提交 = 一次署名、逐份对外承诺（每一份各落一条 quote/submitted）'
      + '：确认以你的署名提交所选草稿？' },
    hint: '一次署名 → 逐份落账：每份草稿单独跑唯一写者 quote-sign.py（各落 approval/requested → granted → '
      + 'quote/submitted）；写者逐份判定 ⇒ 某一份被拒（已被改过 / 形状不对 / 已经签过）不影响其余份；'
      + '回执逐条给「已签 / 已经签过（幂等，零新增）/ 被拒 + 原因」；同一批重签不重复落账',
    input: { bulk: 'ids', fields: [
      { name: 'draft_id', label: '草稿 id（单条时可填；批量时由勾选的行自带）', type: 'text',
        help: 'qd-supplier-…；在「我的草稿」里勾选后不必手抄' },
      { name: 'signature', label: '署名（人签，所选每一份都用它）', type: 'signature', required: true,
        help: 'human:<你的名字> —— 服务端要求它等于会话身份（不一致 403 signer-mismatch，账本零新增）' },
      { name: 'comment', label: '批注（逐份进批准记录 / approval/granted.comment）', type: 'text' },
      { name: 'timeout_policy', label: '超时策略（每份各自声明）', type: 'select',
        options: ['remind', 'escalate', 'abort'], default: 'remind' },
    ] },
    server: async (ctx, input) => {
      // 与 quote.submit 同一道插件侧留痕：服务端一半**再核一遍**「署名 == 会话身份」
      const session = ctx.session && typeof ctx.session === 'object' ? ctx.session : null
      const typed = asText(input.signature)
      if (session && session.human && typed !== session.human) {
        return { ok: false, code: 'signer-mismatch',
          reason: `署名 ${typed} 与会话身份 ${session.human} 不一致`,
          next_action: `人签只能本人签：用 ${session.human} 署名，或切换到该身份的会话（账本零新增）` }
      }
      const raw = Array.isArray(input.ids) && input.ids.length ? input.ids : [input.draft_id]
      // 勾选的行键就是草稿 id（行键 = `row.id` = `quote_draft_id`）；单条路径也接受完整行对象
      const ids = [...new Set(raw.map((item) => asText(typeof item === 'object' && item !== null
        ? (item.quote_draft_id ?? item.draft_id ?? item.id) : item)).filter(Boolean))]
      if (!ids.length) {
        return { ok: false, code: 'drafts-required', reason: '没有选中任何草稿',
          next_action: '在「我的草稿（待签署）」里用表格左侧的勾选框选几份（表头可全选本页），'
            + '再点表头的「批量人签提交」' }
      }
      if (ids.length > BATCH_SIGN_MAX) {
        return { ok: false, code: 'batch-too-large',
          reason: `一次最多签 ${BATCH_SIGN_MAX} 份，收到 ${ids.length} 份`,
          next_action: `先用「搜这块 / 按列筛选 / 状态=待签署」把命中行缩到 ≤ ${BATCH_SIGN_MAX} 行`
            + `（计数行会跟着变），再点计数行上那颗「选中全部命中行（N）」重来。手工勾的也能用：`
            + `勾选跨页保留（第 1 页勾的在翻页后不跟着丢），提交按钮上的数字就是真会送出的行数。`
            + `本动作账本零新增` }
      }
      const comment = String(input.comment ?? '')
      const policy = asText(input.timeout_policy) || 'remind'
      const results = []
      for (const draftId of ids) {                       // 顺序逐份：一份一份地写，回执逐份可指认
        if (!DRAFT_ID_RE.test(draftId)) {
          results.push({ draft_id: draftId, where: 'refused', ok: false, code: 'draft-id-malformed',
            reason: `草稿 id 形状不对：${draftId}`, next_action: '从「我的草稿」勾选那一行（id 会自带）',
            ledger_added: 0 })
          continue
        }
        const run = host.runPython('src/domain/quote-prepare/tools/quote-sign.py',
          ['--ui-shared', host.sharedDir, '--draft-id', draftId, '--actor', typed, '--now', host.now(),
            '--comment', comment, '--timeout-policy', policy,
            '--ledger-supplier', supplierLedger(), '--ledger-contractor', contractorLedger()])
        // 本次运行**只处理这一份草稿**（`--draft-id` 一次一个）⇒ 这条回执（rc + stdout JSON）就是这一份的回执。
        // 归属仍按 `draft_id` **显式指认**（`receipt.item()`）；只有「这一份」的清单里恰好只有一条时才取它，
        // 绝不把 `applied[0]` 当成结论（写者一次处理多条时那条不是你的 —— 那是"假失败"的老根因）。
        const receipt = host.writerReceipt(run)
        const mine = receipt.item({ draft_id: draftId })
        // 兜底只在**这一份的回执**内部成立时使用：一次运行只处理这一份草稿 ⇒ 回执里的 applied/duplicates
        // 条目**要么没写 draft_id、要么就是这一份**（`quote-sign.py` 一次运行给 2 条 applied：两侧各一条）。
        // 这样既不把「写者真落了行」误报成失败（假失败比真失败更坏），也不会认领别人的条目。
        const belongsHere = (list) => list.length > 0
          && list.every((entry) => asText(entry?.draft_id) === '' || asText(entry?.draft_id) === draftId)
        const written = (mine && mine.where === 'applied' ? mine.entry : null)
          ?? (belongsHere(receipt.applied) ? receipt.applied[0] : null)
        const already = (mine && mine.where === 'duplicates' ? mine.entry : null)
          ?? (belongsHere(receipt.duplicates) ? receipt.duplicates[0] : null)
        const refusedRow = mine && mine.where === 'refused' ? mine.entry : null
        const idMismatch = [written, already].filter(Boolean)
          .some((entry) => asText(entry.draft_id) !== '' && asText(entry.draft_id) !== draftId)
        const ok = Boolean(receipt.ok && (written || already))
        const added = written ? Number(receipt.ledger_added ?? 0) : 0
        results.push({ draft_id: draftId, where: written ? 'applied' : (already ? 'duplicates' : 'refused'),
          ok, code: ok ? (written ? 'submitted' : 'already-signed')
            : ((refusedRow ?? receipt.refusal)?.code ?? receipt.code ?? 'writer-failed'),
          reason: ok ? '' : ((refusedRow ?? receipt.refusal)?.reason ?? receipt.reason ?? ''),
          next_action: (refusedRow ?? receipt.refusal)?.next_action ?? receipt.next_action ?? '',
          quote_id: written?.quote_id ?? already?.quote_id ?? (asText(receipt.json?.quote_id) || null),
          approval_id: written?.approval_id ?? already?.approval_id ?? (asText(receipt.json?.approval_id) || null),
          line_count: Number(written?.line_count ?? 0) || null,
          ledger_added: added, writer_rc: receipt.rc, writer_ok: receipt.said,
          writer_consistency: idMismatch ? 'id-mismatch' : 'consistent',
          applied: written ? [written] : [], duplicates: already ? [already] : [],
          refused: refusedRow ? [refusedRow] : [] })
      }
      const signed = results.filter((row) => row.where === 'applied')
      const idempotent = results.filter((row) => row.where === 'duplicates')
      const failed = results.filter((row) => row.where === 'refused')
      const ledgerAdded = results.reduce((sum, row) => sum + Number(row.ledger_added ?? 0), 0)
      // `ledger_added` 来自写者这一次运行的**全局**计数（本侧 3 行 + 承包商侧登记 1 行），不是供应商单侧行数：
      // 措辞里写明口径，免得用户按"这一侧只落了 4 行"去对账。
      const one = (row) => `${row.draft_id}：${row.where === 'applied' ? `已签（写者本次 +${row.ledger_added} 行：本侧 3 + 承包商侧登记 1）`
        : (row.where === 'duplicates' ? '已经签过（幂等：这一份零新增）'
          : `被拒（${row.code}${row.reason ? `：${row.reason}` : ''}）`)}`
      // 逐条如实报告（**不许**"要么全成要么全败"）：份数、行数、以及每一份的落点都写出来
      const next = `${results.length} 份：已签 ${signed.length} 份 · 已经签过（幂等）${idempotent.length} 份 · `
        + `被拒 ${failed.length} 份（本次账本 +${ledgerAdded} 行）—— ${results.map(one).join('；')}`
        + (failed.length
          ? `。被拒的这几份要单独处理：${failed.map((row) => `${row.draft_id} ⇒ `
            + `${row.next_action || row.code}`).join('；')}（被拒的那几份账本零新增，其余份不受影响）`
          : '。已签的几份在「已提交的报价」里可回读')
      return { ok: (signed.length + idempotent.length) > 0,
        code: failed.length === 0 ? (signed.length ? 'batch-submitted' : 'batch-already-signed')
          : ((signed.length + idempotent.length) ? 'batch-partial' : 'batch-refused'),
        reason: failed.map((row) => `${row.draft_id}: ${row.reason || row.code}`).join('；'),
        next_action: next,
        result: { batch: { total: results.length, signed: signed.length, already: idempotent.length,
            refused: failed.length, ledger_added: ledgerAdded, max_per_batch: BATCH_SIGN_MAX, ids, policy },
          results, ledger_added: ledgerAdded } }
    } }))

  out.push(surface.shortcut({ plugin_id: me, id: 'shortcut.quote-draft', keys: 'd', action: 'quote.draft',
    title: '备报价草稿', order: 20 }))

  out.push(surface.statusItem({ plugin_id: me, id: 'status.quote', title: '报价', order: 20, read: () => {
    const rows = host.rows('supplier')
    const drafts = new Set(typeRows(rows, 'quote/drafted').map((row) => asText(bodyOf(row).quote_draft_id)))
    const submitted = typeRows(rows, 'quote/submitted').length
    return { text: `${drafts.size} 份草稿 · ${submitted} 条已提交`, level: submitted ? 'ok' : 'warn',
      next_action: submitted ? '' : '草稿要人签提交才算对外报价' }
  } }))

  out.push(surface.notificationSource({ plugin_id: me, id: 'notify.quote', title: '报价待办', order: 20,
    poll: () => {
      const rows = host.rows('supplier')
      const drafts = new Map()
      for (const row of typeRows(rows, 'quote/drafted')) {
        const body = bodyOf(row)
        const id = asText(body.quote_draft_id) || asText(row?.correlation_id)
        if (id) drafts.set(id, body)
      }
      const signed = new Set(typeRows(rows, 'quote/submitted').map((row) => asText(bodyOf(row).quote_draft_id)))
      const items = []
      for (const [id, body] of drafts) {
        if (signed.has(id)) continue
        // **逐行读数（唯一入口）**：`lines` 里混着 null/字符串/数字时，修前 `${line.item_id}` 直接
        // TypeError ⇒ 整条通知源 poll() 抛错（外壳的通知面会因此报错）；现在好行照报、坏行计数。
        const lines = readRows(body.lines)
        items.push({ id: `q:pending:${id}`, level: 'warn', at: String(body.submitted_at ?? ''),
          title: `草稿待签署：${id}${lines.all > 1 ? `（${lines.all} 行）` : ''}`,
          body: lines.all > 1
            ? `${lines.all} 行：` + lines.rows.slice(0, 3).map(lineLabelOf)
              .join(' / ') + (lines.rows.length > 3 ? ' …' : '')
              + (lines.dropped ? `（另有 ${lines.dropped} 条行读不出来：形状异常）` : '')
            : `行项目 ${body.item_id ?? '—'} · 单价 ${body.unit_price_cents ?? '—'} 分`
              + (lines.dropped ? `（另有 ${lines.dropped} 条行读不出来：形状异常）` : ''),
          next_action: lines.all > 1
            ? `人签提交报价（一次签完整份 ${lines.all} 行；署名 = 你的会话身份）`
            : '人签提交报价（署名 = 你的会话身份）',
          action: 'quote.submit', preset: { draft_id: id },
          ref: asText(body.rfq_id) === '' ? null : { view: 'supplier', kind: 'package',
            id: asText(body.rfq_id), title: `包 ${asText(body.rfq_id)}` } })
      }
      return items
    } }))

  // ---- 工作台（首屏「我今天要做什么」）：只有"我现在该做什么"与一键入口，不是报告列表 -----------------
  out.push(surface.panel({ plugin_id: me, id: 'home.quote-todo', title: '供应商侧：我今天要做什么',
    view: 'home', order: 10, kind: 'list', not_data: true,
    data: (ctx) => {
      const rows = host.rows('supplier')
      const drafts = new Map()
      for (const row of typeRows(rows, 'quote/drafted')) {
        const body = bodyOf(row)
        const id = asText(body.quote_draft_id) || asText(row?.correlation_id)
        if (id) drafts.set(id, body)
      }
      const signed = new Set(typeRows(rows, 'quote/submitted').map((row) => asText(bodyOf(row).quote_draft_id)))
      const pending = [...drafts.entries()].filter(([id]) => !signed.has(id))
      const mine = myPackage(host, realmOf('supplier'))
      const known = referenceablePackages(host)
      const packageId = mine.ok ? String(mine.envelope.spec?.package_id ?? '') : ''
      // **信封行项目读数（唯一入口）**：首屏这一条也在报"几条行项目" —— 修前 `spec.items.length` 在
      // `items` 是**文本**时会把字符串长度当成行数（README 级的谎）；现在只有数组才按条数报。
      const packageItems = mine.ok ? packageItemsOf(mine.envelope.spec) : null
      // 首屏的「备这份草稿」按钮也走同一条预填口径：包不在本侧事实的目录里、或行项目读不出来，就别给入口
      const draftable = mine.ok && packageItems.list
        && (known.ids.length === 0 || known.ids.includes(packageId))
      const items = []
      items.push(sideScoped(ctx, 'supplier', { level: pending.length ? 'warn' : 'info',
        title: pending.length ? `供应商侧：${pending.length} 份草稿待供应商人签提交` : '供应商侧：没有待签署的草稿',
        body: '提交报价是对外承诺：要人签（human:<你的名字>）；一份草稿签一次就提交整份。'
          + '（这一条属于供应商侧：工作台把两侧的待办并在一张卡上，只有登录供应商侧的那个人能签。）',
        action: pending.length ? 'quote.submit' : 'quote.draft',
        label: pending.length ? '人签提交报价' : '备一份草稿',
        next_action: pending.length ? '点按钮直接开签名弹层（一次签完整份）；也可以在「我的草稿」里逐条签'
          : '先把表里的单价与交期填完，再「备这份草稿」（整张表一次提交）' }))
      items.push(sideScoped(ctx, 'supplier', { level: mine.ok ? 'info' : 'warn',
        title: mine.ok ? `供应商侧：发给供应商的包（${packageItems.list
          ? `${packageItems.rows.length} 条行项目${packageItems.dropped ? `，另有 ${packageItems.dropped} 条读不出来` : ''}`
          : `行项目读不出来：信封里 \`spec.items\` 是 ${packageItems.shape}`}，rev${mine.envelope.rev}）`
          : '供应商侧：还没有发给供应商的 RFQ 包',
        body: mine.ok ? `报价截止 ${(mine.envelope.spec?.deadlines ?? {}).quote_by ?? '—'}`
          + (packageItems.list ? '' : ` · 信封里的行项目读不出来（是 ${packageItems.shape}，不是数组）⇒ 这份包现在备不了报价：`
            + '界面不编行项目、也不给入口（空表不等于"没有行项目"）')
          + (draftable ? '' : ` · 这一份包现在备不了报价：它（${packageId}）不在本侧事实的包目录里`
            + `（上限 ${LIMITS.max_items} 个包）⇒ 提交必被拒，界面故意不给入口`) : mine.reason,
        action: mine.ok && draftable ? 'quote.draft' : '', label: '备这份草稿',
        next_action: mine.ok
          ? (draftable ? '去填单价与交期 → 备草稿'
            : (packageItems.list
              ? `先让这个包的事实进本侧账本（或按本侧事实里认得的包备报价：`
                + `${known.ids.slice(0, 3).join(' / ') || '（一个都没有）'}）；这一份包现在点了也会被 rfq-not-found 拒`
              : `让发包方按行项目数组重发这一版（现在点「备报价」也没有可填的行）`))
          : (mine.next_action ?? ''),
        ref: mine.ok ? { kind: 'package', id: String(mine.envelope.spec?.package_id ?? '') } : null }))
      return { ok: true, kind: 'list', items }
    } }))

  // 字段与校验规则的只读自述（让人在界面上能看到规则，而不是靠猜）
  out.push(surface.panel({ plugin_id: me, id: 'quote.rules', title: '草稿字段与校验规则（自述）',
    view: 'supplier', order: 40, kind: 'kv', placement: 'side', not_data: true,
    data: () => {
      // 金额单位：`prepare()` 在没有事实可读时会抛错 —— 自述面板不该因此整块变红（如实降级成 'cents'）
      let moneyUnit = 'cents'
      try {
        moneyUnit = prepare({}, { views: ['supplier'] }).limits?.money_unit ?? 'cents'
      } catch (err) {
        moneyUnit = `cents（兜底：prepare() 抛 ${String(err).slice(0, 40)}）`
      }
      return { ok: true, kind: 'kv', items: FIELDS.map((field) => ({ key: `${field.label}${field.required ? ' *' : ''}`,
        value: field.rule })).concat([{ key: '金额单位', value: `整数分（unit=${moneyUnit}）`, code: true },
        { key: '数值范围', value: `单价 ${LIMITS.unit_price_cents_min}..${LIMITS.unit_price_cents_max} 分；`
          + `交期 ${LIMITS.lead_time_days_min}..${LIMITS.lead_time_days_max} 天；备注 ≤ ${LIMITS.note_bytes_max} 字节` }]) }
    } }))

  // ------------------------------------------------------------------ 承包商侧：报价收件箱 + 受理（DEF-011）
  const inboxTool = 'src/domain/quote-prepare/tools/quote-inbox.py'
  const reviewTool = 'src/domain/quote-prepare/tools/quote-review.py'
  const reviewsFile = () => `${host.sharedDir}/exchange/quote-reviews.json`
  const inboxOf = () => {
    // `{read:true}`：quote-inbox.py 是只读收件箱（写者在别处）⇒ 同一批参数在一次渲染里只 spawn 一次
    // （收件箱面板、待受理通知源、状态栏三处读的是同一份结果）。
    const run = host.runPython(inboxTool, ['--ui-shared', host.sharedDir,
      '--ledger-contractor', contractorLedger()], { read: true })
    return { run, json: run.json ?? {} }
  }
  const reviewNotices = () => {
    const data = host.readJson(reviewsFile())
    const items = data && Array.isArray(data.reviews) ? data.reviews : []
    return items
  }

  out.push(surface.panel({ plugin_id: me, id: 'quotes.inbox', title: '报价收件箱（按包分组 · 可受理 · 可退回 · 可要补件）',
    view: 'contractor', order: 35, kind: 'table', actions: ['quote.review'],
    data: () => {
      const { json, run } = inboxOf()
      if (!json.ok || json.degraded) {
        return { ok: true, kind: 'table', degraded: true, reason: json.reason ?? json.refusal?.code ?? 'inbox-failed',
          next_action: json.next_action ?? json.refusal?.next_action ?? (run.reason || '看只读工具的输出'),
          columns: [{ key: 'quote_id', label: '报价' }], rows: [] }
      }
      const rows = []
      let droppedLines = 0
      for (const bag of json.packages ?? []) {
        for (const quote of bag.quotes ?? []) {
          // **逐行读数（唯一入口）**：收件箱 JSON 里的 `quote.items` 混进 null/字符串/数字时，
          // 修前 `${line.item_id}` 直接 TypeError ⇒ 整块收件箱面板 data-failed（承包商连受理都点不到）。
          const lines = readRows(quote.items)
          droppedLines += lines.dropped
          rows.push({ id: quote.quote_id, quote_id: quote.quote_id, package_id: bag.package_id, rev: bag.rev,
            supplier: quote.supplier, currency: quote.currency,
            items: lines.rows.map((line) => `${asText(line.item_id) || '（无 id）'}×${cellText(line.qty) || '?'}`
              + `@${cellText(line.unit_price_cents) || '—'}分`).join(' ')
              + (lines.dropped ? `（+${lines.dropped} 条读不出来）` : ''),
            total_cents: quote.total_cents, vs_current_rev: quote.vs_current_rev,
            submitted_at: quote.submitted_at, review_status: quote.review_status,
            reviewed_by: quote.reviewed_by ?? '', review_comment: quote.review_comment ?? '',
            approved_by: quote.approved_by ?? '',
            lead_time: lines.rows.map((line) => cellText(line.lead_time_days) || '—').join('/'),
            ref: { kind: 'quote', id: asText(quote.quote_id), title: `报价 ${asText(quote.quote_id)}` } })
        }
      }
      return { ok: true, kind: 'table',
        columns: [
          { key: 'quote_id', label: '报价', type: 'code', pin: 'left' },
          { key: 'package_id', label: '包', type: 'code' },
          { key: 'rev', label: 'rev' },
          { key: 'supplier', label: '供应商', type: 'code' },
          { key: 'items', label: '行级明细（条目×量@单价分）' },
          { key: 'total_cents', label: '行合计（整数分）' },
          { key: 'lead_time', label: '交期（天）' },
          { key: 'submitted_at', label: '提交时刻' },
          { key: 'vs_current_rev', label: '版本状态' },
          { key: 'review_status', label: '受理状态' },
          { key: 'reviewed_by', label: '受理人', type: 'code' },
        ],
        rows, row_actions: ['quote.review'], bulk: 'quote.review',
        counts: { ...(json.counts ?? {}), dropped_lines: droppedLines },
        note: `事实时刻 ${json.as_of || '—'} · 逐条「受理/退回/要求补件」（人签，按行内或勾选批量）；`
          + '受理状态读账本 `approval/*` 的 `scope=quote-review:<decision>`；作废的报价不允许受理（`quote-superseded`）'
          + (droppedLines ? ` · 收件箱里有 ${droppedLines} 条报价行读不出来（形状异常）⇒ 已跳过并逐条计数，`
            + '行级明细里如实标了「+N 条读不出来」，不静默丢' : '') }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'quote.review', title: '受理 / 退回 / 要求补件（人签）',
    views: ['contractor'], group: '报价', order: 5, permission: 'human-signature', inline: true,
    object_kind: 'quote',
    confirm: { required: true, message: '这是人签判定：受理后对方会看到「已受理」；确认以你的署名执行？' },
    hint: '受理=approval/granted、退回/要补件=approval/denied（scope 带判定）；退回/补件必须给理由；'
      + '通知对方只含判定与披露理由，不含内部备注',
    input: { bulk: 'ids', fields: [
      { name: 'quote_id', label: '报价 id', type: 'text', required: true, from_route: true,
        help: '从收件箱行里取（批量时每行自带）；在报价对象页上会自动填当前这一份' },
      { name: 'decision', label: '判定', type: 'select', options: ['accepted', 'returned', 'need-info'],
        default: 'accepted', help: '受理 / 退回 / 要求补件' },
      { name: 'signature', label: '受理人（人签）', type: 'signature', required: true, help: 'human:<你的名字>' },
      { name: 'comment', label: '理由（退回/补件必填；受理可空）', type: 'textarea',
        help: '退回 / 要求补件时必须写清楚要对方改什么（会披露给对方）；受理时留空即可' },
    ] },
    server: async (ctx, input) => {
      const decision = asText(input.decision) || 'accepted'
      const comment = String(input.comment ?? '')
      if (decision !== 'accepted' && comment.trim() === '') {
        return { ok: false, code: 'reason-required', reason: '退回/要求补件必须给理由（对方要知道改什么）',
          next_action: '在「理由」里写清楚：哪一条不对、要补什么' }
      }
      const quoteIds = Array.isArray(input.ids) && input.ids.length
        ? input.ids.map(asText) : [asText(input.quote_id)]
      const results = []
      for (const quoteId of quoteIds) {
        const staged = host.stage('quote-review', { kind: 'quote-review', action: 'review', view: 'contractor',
          quote_id: quoteId, decision, actor: asText(input.signature), note: comment })
        if (!staged.ok) { results.push({ quote_id: quoteId, ok: false, code: staged.code, reason: staged.reason }); continue }
        const run = host.runPython(reviewTool, ['--request', staged.path, '--ui-shared', host.sharedDir,
          '--ledger-contractor', contractorLedger(), '--ledger-supplier', supplierLedger(), '--now', host.now()])
        const json = run.json ?? {}
        results.push({ quote_id: quoteId, ok: run.ok && json.ok === true,
          code: json.refusal?.code ?? (json.ok ? decision : 'writer-failed'),
          reason: json.refusal?.reason ?? run.reason ?? '',
          next_action: json.refusal?.next_action ?? json.next_action_runtime ?? '',
          approval_id: json.approval_id ?? null, ledger_added: json.ledger_added ?? 0,
          pending: staged.file, notices: json.notices ?? null })
      }
      const okAll = results.every((row) => row.ok)
      const failed = results.filter((row) => !row.ok)
      return { ok: okAll && results.length > 0,
        code: okAll ? decision : (results.length > 1 ? 'partial-failure' : (failed[0]?.code ?? 'refused')),
        reason: failed.map((row) => `${row.quote_id}: ${row.reason}`).join('；'),
        next_action: okAll
          ? `判定已落账（approval/requested + granted|denied，scope=quote-review:${decision}）：`
            + '对方侧看到「已受理/已退回/要求补件」（不含内部备注）；邮件通道不可用时通知未发出，可复制通知正文'
          : failed.map((row) => `${row.quote_id}：${row.next_action}`).join('；'),
        result: { results, accepted: results.filter((row) => row.ok).length, failed: failed.length,
          notices: reviewsFile() } }
    } }))

  out.push(surface.validator({ plugin_id: me, id: 'validator.quote-review', title: '受理/退回/补件的理由规则',
    actions: ['quote.review'], order: 5,
    validate: (input) => (String(input.decision ?? 'accepted') !== 'accepted'
      && String(input.comment ?? '').trim() === '')
      ? [{ field: 'comment', code: 'reason-required',
        message: '退回 / 要求补件必须给理由（对方要知道改什么）',
        next_action: '在「理由」里写清楚：哪一条不对、要补什么' }]
      : [] }))

  out.push(surface.panel({ plugin_id: me, id: 'quotes.review-notices', title: '承包商对我报价的判定（对方通知）',
    view: 'supplier', order: 45, kind: 'table',
    data: () => {
      const rows = []
      const letters = reviewNotices()
      const letterOf = (subject) => {
        const match = /\s(q-[\w.-]+)\s*$/.exec(String(subject))
        const quoteId = match ? match[1] : ''
        return (letters.filter((item) => item.quote_id === quoteId).slice(-1)[0] ?? {}).letter ?? ''
      }
      for (const row of typeRows(host.rows('supplier'), 'mail/') ) {
        const body = bodyOf(row)
        const subject = asText(body.subject)
        if (!subject.startsWith('报价评审：')) continue
        // **收件人行读数**：`to` 不是一个数组时（字符串/数字/对象/缺失）修前 `(body.to ?? []).join` 直接
        // TypeError ⇒ 整块「对方通知」面板打崩；现在按形状如实报出来（读不出来就说读不出来）。
        const recipients = scalarListOf(body.to)
        rows.push({ id: `${body.message_id ?? ''}-${row.ts ?? ''}`, at: row.ts ?? '', subject,
          to: recipients.list ? recipients.items.join(' ') + (recipients.dropped
            ? `${recipients.items.length ? ' ' : ''}（另有 ${recipients.dropped} 条收件人读不出来）` : '')
            : `（收件人字段是 ${recipients.shape}，不是名单：读不出来就不编）`,
          body_sha256: asText(body.body_sha256),
          disclosed: letterOf(subject) })
      }
      if (!rows.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-quote-review-notice',
          next_action: '等承包商在收件箱里受理/退回你的报价（判定会通过通知信封送到本侧）',
          columns: [{ key: 'subject', label: '通知' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        columns: [{ key: 'at', label: '收到时刻' }, { key: 'subject', label: '判定' },
          { key: 'disclosed', label: '承包商披露的理由' }, { key: 'body_sha256', label: '正文哈希', type: 'code' }],
        rows, counts: { notices: rows.length },
        note: '只含判定与承包商愿意披露的理由（不含内部备注）；通知是"入队"事实，不代表邮件真的发出' }
    } }))

  out.push(surface.notificationSource({ plugin_id: me, id: 'notify.quote-review', title: '待受理的报价',
    order: 8, poll: () => {
      const { json } = inboxOf()
      const items = []
      for (const bag of json.packages ?? []) {
        for (const quote of bag.quotes ?? []) {
          if (quote.review_status !== '待审') continue
          const quoteLines = readRows(quote.items)
          items.push({ id: `quote:review:${quote.quote_id}`, level: 'warn', at: quote.submitted_at,
            ref: { view: 'contractor', kind: 'quote', id: asText(quote.quote_id),
              title: `报价 ${asText(quote.quote_id)}` },
            title: `待受理：${quote.quote_id}（${bag.package_id} · ${quote.supplier}）`,
            body: `行合计 ${quote.total_cents} 分 · ${quoteLines.rows.length} 行`
              + `${quoteLines.dropped ? `（另有 ${quoteLines.dropped} 条行读不出来）` : ''}`
              + ` · ${quote.vs_current_rev}`,
            next_action: '点下面的按钮受理/退回/要补件（人签）', action: 'quote.review',
            preset: { quote_id: asText(quote.quote_id) } })
        }
      }
      return items
    } }))

  out.push(surface.statusItem({ plugin_id: me, id: 'status.quote-review', title: '报价收件箱', order: 6, read: () => {
    const { json } = inboxOf()
    if (!json.ok) return { text: '收件箱读不到', level: 'warn', next_action: json.refusal?.next_action ?? '' }
    const pending = json.counts?.pending ?? 0
    return { text: `${json.counts?.quotes ?? 0} 条报价 · 待受理 ${pending}`,
      level: pending ? 'warn' : 'ok', next_action: pending ? '去收件箱受理/退回（人签）' : '' }
  } }))

  // ---- **沙盘场景**：演示流程的第 ② 段 = **备报价 + 人签提交**（供应商侧两家人，比价才有得看）------
  // 4 步：备一份 → 人签提交 → 再备一份（另一家的价）→ 人签提交。
  // `$actor` = 机制给的演示身份（沙盘按侧决定）；`capture` 把回执留下来给后来的步骤取用。
  out.push(surface.scenario({ plugin_id: me, id: 'scenario.quote-draft-submit', scenario: 'demo.procurement',
    scenario_title: '演示：包 → 报价 → 比价 → 授标 → PO', title: '② 备报价 + 人签提交（供应商发起）',
    view: 'supplier', order: 20,
    hint: '整张表一次备草稿 → 人签提交（沙盘里的人签用机制生成的演示身份）；两家候选，比价才看得出差别',
    steps: [
      { action: 'quote.draft', as: { side: 'supplier' },
        input: { rfq_id: 'DEMO-PKG-001', prepared_by: '$actor',
          currency: 'CNY', rows: [{ item_id: 'L-001', unit_price_cents: 8600, lead_time_days: 10 },
            { item_id: 'L-002', unit_price_cents: 1150, lead_time_days: 10 }] } },
      { action: 'quote.submit', as: { side: 'supplier' }, capture: 'q1',
        input: { draft_id: '$last.applied.0.quote_draft_id', signature: '$actor',
          comment: '沙盘演示：第一家候选提交', timeout_policy: 'remind', confirm_ack: '1' } },
      { action: 'quote.draft', as: { side: 'supplier' },
        input: { rfq_id: 'DEMO-PKG-001', prepared_by: '$actor', currency: 'CNY',
          rows: [{ item_id: 'L-001', unit_price_cents: 9400, lead_time_days: 6 }] } },
      { action: 'quote.submit', as: { side: 'supplier' },
        input: { draft_id: '$last.applied.0.quote_draft_id', signature: '$actor',
          comment: '沙盘演示：第二家候选提交（交期更短、价更高）', timeout_policy: 'remind',
          confirm_ack: '1' } }] }))

  // ---- **起步指引**（机制：`surface.guide`）：空态那一屏说什么、从哪一步开始 ---------------------------
  // 供应商这一侧的"第一步"依赖对方先发包 —— 所以这里**只写人话**（这条路怎么走），按钮由机制那一条
  // （演示数据）与到手后的行内动作提供：外壳不会为了凑按钮去摆一颗跑不了的。
  out.push(surface.guide({ plugin_id: me, id: 'guide.supplier-start', view: 'supplier', order: 10,
    title: '供应商：这条活怎么走',
    summary: '这条道是供应商的活：收到 RFQ 包 → 填单价与交期 → 备一份报价草稿 → 人签提交（人工门）→'
      + '等对方的授标意向 → 确认授标 → 收到采购单并回签。现在还没有发给你的包 —— 等对方发包，'
      + '或者先点演示数据看一遍完整流转。',
    hint: '一份报价签一次就提交整份；署名 = 你的会话身份（界面不代签、账本零新增）' }))

  return out
}
