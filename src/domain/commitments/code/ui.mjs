/**
 * `domain/commitments` 的 **GUI 贡献** —— 授标链（意向 → 供应商确认 → **人签承诺** → **人签发 PO**）。
 *
 * 注册的东西（承包商侧）：
 *   · 面板 `award.chain`：意向 / 供应商确认 / 承诺 / PO 四种事实行一屏（状态、批准人、追溯链）；
 *   · 动作 `award.propose`（服务端一半跑 `src/domain/commitments/tools/commitment-apply.py --step propose`：
 *     落 `award/intent-proposed`，**不产生义务**；也可从「收到的报价」行内点击预填）；
 *   · 动作 `award.commit`（**human-signature**）：--step commit（要求①意向 ②供应商确认 ③人工批准三样齐备）；
 *   · 动作 `po.issue`（**human-signature**）：--step po（PO 只能由承诺派生、逐行引用中标条目、不得改价）。
 *
 * 注册的东西（供应商侧）：
 *   · 面板 `award.inbox`：**发给自己的**授标意向（只读投递信封 `<ui-shared>/exchange/award-intents.json` 里
 *     `delivered_to` 含自己 realm 的那几条）；
 *   · 动作 `award.confirm`（**human-signature**）：--step confirm（写自己账本 `award/confirmed` +
 *     承包商账本一条同名登记 —— 与 `quote-sign.py` 的双向登记同一模式）。
 *   · 面板 `po.inbox` / `po.object-received` / `po.object-lines-received` / `po.prereqs`：
 *     **发给我的采购单**（逐行 + 追溯链 + 执行前提），行来自**本侧账本**的 `po/distributed`
 *     （投递登记：由签发方的唯一写者写），投递信封 `<ui-shared>/exchange/po-deliveries.json` 只补
 *     `delivered_at`/收件人这类投递面读数；`delivered_to` 不含我这条的**根本不出现在输出里**；
 *   · 动作 `po.acknowledge`（**human-signature**）：--step acknowledge（回签：自己账本 `po/acknowledged` +
 *     承包商账本一条同名登记）；
 *   · 导出 `po.export-received` + 声明 `report.po-received`：把**收到的那张 PO** 导出/打印
 *     （行与价只用本侧事实，行内带 `basis` 与追溯链）。
 *   · **已读回执（本批新增）**：供应商**打开采购单**（`po.inbox` / 对象页 `po.object-received`）时
 *     按会话身份记一条已读回执给签发方；承包商侧在 `po.receipts` 面板看到「投递给谁 / 何时投的
 *     （账本事实）+ 谁何时看过（0600 痕迹，**不进账本**）」。回执里没有对方的报价/成本/评分。
 *
 * 纪律：本文件不写账本（只 spawn 唯一写者）；**承诺与 PO 都必须人签**，且必须带人工批准记录（INV-005）；
 * 回签同样是**人签**（署名 = 会话身份，服务端在动作总线上校验）。已读回执只写它自己那个 0600 文件。
 */
export const plugin_id = 'domain/commitments'
import { createReceiptStore } from '../../../system/attachments/code/delivery-receipts.mjs'
import { plainText } from '../../../system/approval/code/ui.mjs'

const asText = (value) => (typeof value === 'string' ? value.trim() : '')

/**
 * 写者回执里的 `json` → **给人看的那一份**（P43）。
 *
 * 唯一写者（Python 工具）的 `reason` / `next_action` 会带**命令行旗标**（`--step confirm`、
 * `--actor human:<人名>`、`PYTHONPATH=… python3 -m …`）——产品界面不该教人回终端
 * （`docs/design/29-webui-gui-app.md` §21.4）。`plainText` 是**唯一一份实现**
 * （在 `system/approval/code/ui.mjs` 里，与审批队列用同一个函数），这里只把它套在写者文案上。
 *
 * **不像素级改写判据**：只动 `refusal.reason` / `refusal.next_action` / `next_action` / `next_action_runtime`
 * 这四个**文案**键；`ok` / `ledger_added` / `applied` / `duplicates` / `refused` / 事件名一律不动。
 * 写者原文挂在 `writer_text` 上 ⇒ 回执的 `result.writer_text` 照样可查（一个字都没丢，可审计）。
 */
const cleanJson = (run) => {
  const json = run?.json ?? {}
  const clean = (value) => (typeof value === 'string' && value !== '' ? plainText(value) : value)
  const refusal = json.refusal && typeof json.refusal === 'object'
    ? { ...json.refusal, reason: clean(json.refusal.reason), next_action: clean(json.refusal.next_action) }
    : json.refusal
  return { ...json, refusal,
    next_action: clean(json.next_action), next_action_runtime: clean(json.next_action_runtime),
    writer_text: { reason: json.refusal?.reason ?? '', next_action: json.refusal?.next_action ?? '' } }
}

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
const typeRows = (rows, type) => rows.filter((row) => String(row?.type ?? '') === type)
/**
 * **门被决定过**的那三种事件（批准 / 驳回 / 终止）——一件事一旦落在其中一条上，它就不在"还在等"里了。
 * 修前 `home.gates` 只认 granted/aborted ⇒ **被驳回的门一直以"还在等"挂在工作台上**（会误判成还没办）。
 */
const DECIDED_GATE_EVENTS = ['approval/granted', 'approval/denied', 'approval/aborted']
/** 值的**形状名**（只用于如实报出"读不出来的是什么形状"，不做任何补值/猜测）。 */
const shapeOf = (value) => (value === undefined ? 'missing' : value === null ? 'null'
  : Array.isArray(value) ? 'array' : typeof value)
/** 「行」的最小形状：非 null 的**对象**（数组不是行）。 */
const isRow = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/**
 * **行数组的唯一读数入口**（`lines[]` / `items[]` / 外部 JSON 里的行数组一律走这里）。
 *
 * 为什么必须有它（P27 实测的根因）：面板直接在**行数组的元素**上读属性（`line.item_id` 这种写法）时，
 * 数组里**只要有一条不是对象**（`null` / 字符串 / 数字），读 `.item_id` 就抛 `TypeError`；而外壳对
 * `panel.data()` 抛错的处理是**整块面板判 `data-failed`** —— 一条坏行把一整块面板打崩。
 *
 * 返回 `{list, all, rows, dropped, shape}`：`rows` = 能当行用的对象，`dropped` = 读不成对象的条数
 * （**逐条计数、不静默丢**），`list` = 源本身是不是数组（不是 ⇒ 另外说"读不出来"，不当成"空"）。
 */
const readRows = (value) => {
  if (!Array.isArray(value)) return { list: false, all: 0, rows: [], dropped: 0, shape: shapeOf(value) }
  const rows = value.filter((row) => isRow(row))
  return { list: true, all: value.length, rows, dropped: value.length - rows.length, shape: 'array' }
}

/**
 * 逐行文本（`render` 由调用方给）+ **坏行逐条计数**。
 * 调用口径：把 `readRows(...)` 写在参数上（`linesTextOf(readRows(x.lines), render)`）——
 * 这样"这一行是外部数组里的元素"在读取处一眼可见，不必去追上游变量。
 */
const linesTextOf = (read, render, { sep = ' ', empty = '' } = {}) => {
  if (!read.list) return ''
  const text = read.rows.map(render).join(sep)
  if (!read.dropped) return text
  return `${text || empty}${text ? ` · ` : ''}（另有 ${read.dropped} 条读不出来：形状异常，已跳过并计数）`
}
/** `html` 面板里逐段转义（面板的 html 是原样注入的 ⇒ 值必须自己转义；只转义，不解读）。 */
const escHtml = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
/**
 * **整包授标**一次最多覆盖几行（与批量人签的 `batch-too-large` 同一口径：50）。
 * 超限**具名拒 + 给下一步**，不静默截断成"前 50 行"（截断会让用户以为整包提过了）。
 */
const MAX_PACKAGE_LINES = 50

export async function register(surface, host) {
  const me = plugin_id
  const out = []
  const ledgerC = () => asText(host.config?.ledger_contractor)
  const ledgerS = () => asText(host.config?.ledger_supplier)
  const intentFile = () => `${host.sharedDir}/exchange/award-intents.json`
  const deliveryFile = () => `${host.sharedDir}/exchange/po-deliveries.json`
  /**
   * **包的行项目量**（`byItem`: `<条目 id>` → 快照里的那一条）：给整包授标带出每一行的量。
   *
   * 口径与 `src/domain/rfq/code/ui.mjs#itemQtyIndex` **同源**（那里是真源，这里只取同一份快照文件）：
   * 唯一写者 `rfq-publish.py` 发布时把 `<ui-shared>/contractor/rfq-<包>-rev<n>.json` 落盘，包体
   * （含 `spec.items` 的 `qty`）**不进账本**，所以量只能从这份快照读。读不到 ⇒ 如实说读不到
   * （**不编数量**：没有量时唯一写者会按 `line-qty-invalid` 拒，界面先一步说清）。
   * 先按账本里 `rfq/published` 给过的 rev 找，再退回 rev 1..5（与 rfq 侧同一套兜底顺序）。
   */
  const packageItemsOf = (rows, packageId) => {
    const revs = typeRows(rows, 'rfq/published').map((row) => bodyOf(row))
      .filter((body) => asText(body.package_id) === packageId)
      .map((body) => Number(body.rev)).filter((rev) => Number.isFinite(rev) && rev > 0)
      .sort((left, right) => right - left)
    const wanted = [...new Set([...revs, 5, 4, 3, 2, 1])]
    let sawFile = false
    for (const rev of wanted) {
      const data = host.readJson(`${host.sharedDir}/contractor/rfq-${packageId}-rev${rev}.json`)
      if (!data || typeof data !== 'object') continue
      sawFile = true
      const spec = data.spec && typeof data.spec === 'object' && data.spec !== null ? data.spec : {}
      const rowsOfItems = readRows(spec.items).rows
      if (!rowsOfItems.length) continue
      const byItem = new Map()
      for (const item of rowsOfItems) {
        const itemId = asText(item.item_id)
        if (itemId === '') continue
        byItem.set(itemId, { qty: Number(item.qty), unit: asText(item.unit) })
      }
      if (byItem.size) return { ok: true, rev, byItem, why: '',
        dropped: readRows(spec.items).dropped }
    }
    return { ok: false, rev: 0, byItem: new Map(),
      why: sawFile
        ? `包 ${packageId} 的快照里没有可读的行项目（\`spec.items\` 不是行数组或为空）⇒ 不编数量`
        : `本机没有包 ${packageId} 的快照文件（\`<ui-shared>/contractor/rfq-<包>-rev<n>.json\`）；`
          + '发布这一包时唯一写者会落它 —— 读不到就如实降级（不编条目/数量）' }
  }
  /**
   * 本侧 realm（= 身份）。
   *
   * ⚠ 机制给插件的 `host.rows(view)` 是**只读投影**（`kernel/code/ledger-view.mjs` 的 `rows()` 按设计只出
   * `seq/type/correlation_id/actor/ts/body`），**行级的 `realm` 不在里面**；而 `realms()`（身份的真源）
   * 只在宿主内部用（RFQ 投递可见性那套）。所以这里从**本侧账本的登记**里推：先看行级 `realm`
   * （夹具/单账本模式下有），再退到「谁在何时收到」这类登记里的收件人字段
   * （`po/distributed.recipients` / `rfq/distributed.recipients` / `award/confirmed.supplier`）——
   * **只读本侧账本**，不读信封、不猜、不跨侧。读不出来 ⇒ `''`（调用方按 `no-identity` 如实降级）。
   */
  const realmOf = (view) => {
    const rows = host.rows(view)
    const direct = rows.find((row) => asText(row?.realm) !== '')
    if (direct) return asText(direct.realm)
    if (view !== 'supplier') return ''      // 承包商侧没有"我的收件人身份"这回事（那是对方的 realm）
    for (const type of ['po/distributed', 'rfq/distributed']) {
      for (const row of typeRows(rows, type)) {
        const body = bodyOf(row)
        const mine = [body.supplier, ...(body.recipients ?? [])].map(asText).find((item) => item !== '')
        if (mine) return mine
      }
    }
    return typeRows(rows, 'award/confirmed').map(bodyOf).map((body) => asText(body.supplier))
      .find((item) => item !== '') ?? ''
  }
  const poDeliveries = (view) => typeRows(host.rows(view), 'po/distributed').map((row) => bodyOf(row))
  /** 已读回执存储（0600；**不进账本**，理由见模块文件头）。沙盘里 `host.sharedDir` 指向沙盘目录。 */
  const receipts = createReceiptStore({ root: host.root, sharedDir: host.sharedDir,
    log: (msg) => host.note.set(me, 'receipt-log', msg) })
  /** 显示口径：只去掉 `human:` 前缀（与协作面同一套）；**逻辑判据仍用原始值**。 */
  const humanName = (value) => String(value ?? '').replace(/^human:/, '')
  /**
   * **打开采购单的一方留一条已读回执**（签发方据此回答「对方收到了吗 / 看了吗」）。
   * 侧与人**只认会话**：没有身份、或身份不是供应商侧 ⇒ 不记（也不报错）。
   * 回执里只有对象 id + 人 + 时刻 + 从哪看的；**没有**对方的报价/成本。
   */
  const receiptNote = (out) => {
    if (!out) return ''
    if (out.ok === true) {
      // 注意：这句话会被渲染成**纯文本**（对象页 kv 条目 / 面板 note 都过 HTML 转义）
      // ⇒ 不要写 markdown 记号，否则用户看到的是星号本身。
      return out.unchanged
        ? '已读回执：这一次查看（60 s 内重复查看不重复记）'
        : `已读回执：已记下你打开了这张采购单（首次 ${out.first_at}）—— 签发方能看到「谁 / 何时 / 看过几次」，`
          + '看不到你的报价、成本或任何本侧私有数据'
    }
    return `已读回执没记上（${out.code}）：${out.reason}`
  }
  const recordPoReceipt = (ctx, poId, source) => {
    const who = ctx?.identity
    const human = asText(who?.human)
    const side = asText(who?.side)
    if (poId === '' || human === '' || side !== 'supplier') return null
    return receipts.record({ kind: 'po', id: poId, human, side, at: host.now(), source })
  }

  /** 投递信封里**投给本侧**的那几条（`delivered_to` 不含我 ⇒ 根本不进输出，不是"藏起来"）。 */
  const myDeliveryEnvelopes = (realm) => {
    const all = host.readJson(deliveryFile())
    if (!Array.isArray(all)) return []
    if (realm === '') return []
    return all.filter((item) => (item.delivered_to ?? []).map(String).includes(realm))
  }
  /** 本侧回签状态（`po/acknowledged`）：po_id → 最后一条。 */
  const acksOf = (view) => {
    const out = new Map()
    for (const row of typeRows(host.rows(view), 'po/acknowledged')) {
      const body = bodyOf(row)
      const id = asText(body.po_id)
      if (id) out.set(id, body)
    }
    return out
  }
  /**
   * **侧只能来自会话**（机制给出的唯一判据）：本侧的人签动作拒绝另一侧的名字来签。
   * 为什么必须在插件里再判一次：动作总线的身份门只校验「署名 == 会话身份」（防冒名），不校验
   * 「这个动作是不是你这侧的」；而回签/确认这类动作**写的是本侧账本**——另一侧替签等于把
   * 「谁收到了货」写成对方的人（跨侧替签）。判据跑在写任何东西之前：拒绝时账本与待办件零新增。
   *
   * **沙盘例外（机制给的，不是我放宽的）**：沙盘里两侧由**机制生成的演示身份**驱动（29 §11.5：
   * `actors[side]`），会话身份在那里按设计为空（沙盘账本不是真实面）。所以沙盘里按机制给的
   * `host.sandbox.actors[side]` 判「有没有这一侧的演示身份」；**真实面上这条替换不存在**，
   * 仍然要求会话身份（`identity-required`）。
   */
  const sideGuard = (ctx, side, title) => {
    const who = ctx?.identity
    if (who && asText(who.side) !== '') {
      if (asText(who.side) !== side) {
        return { ok: false, code: 'cross-side-action',
          reason: `「${title}」是${side} 侧的动作；当前会话是 ${asText(who.side)} 侧（${asText(who.human)}）`,
          next_action: `切到 ${side} 侧的身份再签：人签只能由本侧的人做（跨侧替签一律拒，账本零新增）` }
      }
      return null
    }
    const sandbox = host.sandbox
    if (sandbox?.on) {
      return asText(sandbox.actors?.[side]) !== '' ? null
        : { ok: false, code: 'identity-required',
          reason: `沙盘里没有 ${side} 侧的演示身份：${title}没人能签`,
          next_action: '重开沙盘（`sandbox.clear` → `sandbox.seed`）让机制重新生成两侧的演示身份' }
    }
    return { ok: false, code: 'identity-required', reason: `${title}需要会话身份（侧与署名都取会话）`,
      next_action: `先在 ${host.prefix}/identity/ 登录（账本零新增）` }
  }

  // ------------------------------------------------------------------ 承包商侧
  out.push(surface.view({ plugin_id: me, id: 'award.workspace', title: '授标与订单', order: 30,
    view: 'contractor', hint: '意向 → 供应商确认 → 人签承诺 → 人签发 PO（逐行可追溯）' }))

  /**
   * **人门（P48）的只读判据**：这条业务引用（`scope` + `ref`）上，账本里有没有一扇**可以消费的门**。
   *
   * 与写者的判定**同一处口径**（`src/system/approval/code/approval.py#signoff_verdict`）：门要在账本里、
   * 状态 `granted`、批的人是人、**不是这次署名的人**、开单点名了审批人时还必须就是那位。这里只把它
   * **读出来**摆在面板上（「门未被真正用上时不要装作有」）——**判定与拒绝永远在写者里**，界面不改判据。
   * 未登录（会话身份为空）时判不出「批的人是不是你」：如实说判不出来，不猜。
   */
  const GATE_RESOLVED = ['approval/granted', 'approval/denied', 'approval/aborted']
  const gateName = (who) => asText(who.replace(/^human:/, ''))
  const gateStateOf = (rows, scope, ref, signer) => {
    const byId = new Map()
    for (const row of rows) {
      if (!String(row?.type ?? '').startsWith('approval/')) continue
      const body = bodyOf(row)
      if (asText(body.scope) !== scope || asText(body.ref) !== ref) continue
      const id = asText(body.approval_id)
      if (!id) continue
      const seen = byId.get(id) ?? { id, status: 'pending', decided_by: '', approvers: [], comment: '' }
      const type = String(row.type)
      byId.set(id, {
        ...seen,
        status: GATE_RESOLVED.includes(type)
          ? (asText(body.status) || (type === 'approval/granted' ? 'granted' : 'denied')) : seen.status,
        decided_by: asText(body.decided_by) || seen.decided_by,
        approvers: Array.isArray(body.approvers) ? body.approvers.map(asText).filter(Boolean) : seen.approvers,
        comment: asText(body.comment) || seen.comment })
    }
    const gates = [...byId.values()]
    if (!gates.length) {
      return { ok: false, code: 'approval-required', gate: null,
        label: `没有这扇门（${scope}）：提交会被**具名拒**（approval-required）—— 先在「提交人工门」开单`
          + `（scope=${scope}、ref=${ref}、审批人写另一个人），请那位在审批队列里批` }
    }
    const usable = gates.filter((gate) => gate.status === 'granted'
      && gate.decided_by.startsWith('human:') && gate.decided_by !== signer
      && (!gate.approvers.length || gate.approvers.includes(gate.decided_by)))
    if (usable.length) {
      const gate = usable[usable.length - 1]
      return { ok: true, code: 'approval-ok', gate,
        label: `可提交：门 ${gate.id} 由 ${gateName(gate.decided_by)} 批准`
          + `${gate.approvers.length ? '' : '（开单时未点名审批人：只按 scope/ref 对账）'}`
          + ` —— 谁批的（${gateName(gate.decided_by)}）≠ 谁签的${signer === '' ? '（未登录：判不出是不是你）'
            : `（你 ${gateName(signer)}）`}` }
    }
    const gate = gates[gates.length - 1]
    if (gate.status === 'granted' && signer !== '' && gate.decided_by === signer) {
      return { ok: false, code: 'approver-must-differ', gate,
        label: `门 ${gate.id} 是**你自己**批的（自签自批）⇒ 提交会被**具名拒**（approver-must-differ）：`
          + `让另一个人开单点名并批准这扇门（或运营侧显式打开自签自批开关，默认关闭）` }
    }
    if (gate.status === 'granted' && gate.approvers.length && !gate.approvers.includes(gate.decided_by)) {
      return { ok: false, code: 'approver-not-named', gate,
        label: `门 ${gate.id} 由 ${gateName(gate.decided_by)} 批准，但开单点名的是 `
          + `${gate.approvers.map(gateName).join('、')} ⇒ 会被**具名拒**（approver-not-named）` }
    }
    const statusLabel = { pending: '还在等', denied: '已被驳回', aborted: '已被终止' }[gate.status] ?? gate.status
    return { ok: false, code: gate.status === 'pending' ? 'approval-not-granted'
        : (gate.status === 'denied' ? 'approval-denied' : 'approval-aborted'), gate,
      label: `门 ${gate.id} ${statusLabel}`
        + `${gate.approvers.length ? `（卡在 ${gate.approvers.map(gateName).join('、')}）` : ''}`
        + ` ⇒ 还没批：提交会被**具名拒**（${gate.status === 'pending' ? 'approval-not-granted' : `approval-${gate.status}`}）`
        + `${gate.status === 'pending' ? ' —— 让点名的那位在「审批队列」里点「批准」' : ' —— 重新开一个门并请人批'}` }
  }
  /** 已落账的承诺 / PO 的「谁签的 vs 谁批的」（**从账本行算**：署名取行 `actor`，批准人取 body `approved_by`）。 */
  const signoffLabelOf = (row, body) => {
    const signer = asText(row?.actor) || '（未记录署名）'
    const approver = asText(body?.approved_by) || '（未记录批准人）'
    if (signer !== approver && approver !== '' && approver !== '（未记录批准人）') {
      return `署名 ${gateName(signer)} · 批准人 ${gateName(approver)} —— **不是同一个人**（谁批的 ≠ 谁签的）`
    }
    return `署名 ${gateName(signer)} · 批准人 ${gateName(approver)} —— **同一个人**`
      + `（自签自批：本批之前写入的旧行是这个形状）`
  }

  out.push(surface.panel({ plugin_id: me, id: 'award.chain', title: '授标链（四种事实行一屏）',
    view: 'contractor', order: 40, kind: 'table', actions: ['award.commit', 'po.issue'],
    data: (ctx) => {
      const rows = host.rows('contractor')
      const me_ = asText(ctx?.identity?.human)          // 人门判据里的「署名的人」= 会话身份
      const intents = typeRows(rows, 'award/intent-proposed').map((row) => bodyOf(row))
      const confirmed = new Map(typeRows(rows, 'award/confirmed').map((row) => [asText(bodyOf(row).intent_id), bodyOf(row)]))
      const awardRows = typeRows(rows, 'award/committed')
      const awards = awardRows.map((row) => bodyOf(row))
      const poRows = typeRows(rows, 'po/issued')
      const pos = poRows.map((row) => bodyOf(row))
      const table = []
      for (const intent of intents) {
        const intentId = asText(intent.intent_id)
        const award = awards.find((item) => asText(item.intent_id) === intentId)
        const awardRow = awardRows.find((row) => asText(bodyOf(row).intent_id) === intentId) ?? null
        const po = award ? pos.find((item) => asText(item.award_id) === asText(award.award_id)) : null
        const supplierConfirmed = confirmed.has(intentId)
        // **人门那两列（P48）**：账本里这条业务引用上有没有一扇**可以消费的门**（判据与写者同一处）——
        // 门没被真正用上时**不装作有**：写的是"没有这扇门 / 是你自己批的 / 还在等谁"。
        const commitGate = gateStateOf(rows, 'award.commit', intentId, me_)
        const poGate = award ? gateStateOf(rows, 'po.issue', asText(award.award_id), me_) : null
        // **行内动作按这一行的状态给**（P28 空账本走查登记的可点性缺陷）：修前这一行上永远长着
        // 「授标承诺（人签）」和「发 PO（人签）」两颗按钮 —— 供应商还没确认时点「发 PO」，
        // 必然被唯一写者拒 `supplier-confirmation-required`（用户白填一遍表单，还以为是界面坏了）。
        //
        // 判据与写者（`commitment-apply.py`）**一字不差**，界面只决定"摆不摆这颗按钮"，不放宽任何一条
        // 承诺判据：承诺要「意向 + 供应商确认」；发 PO 要「已承诺」（PO 只能由承诺派生）。
        // **人门不在这里拦**（`approval-required` 那类拒因由写者给、`next_action` 指到开单处）：
        // 门要别人去批，属于"下一步该谁办"，写在「人门」列里，而不是把按钮藏掉（§23：不把缺上下文做成隐藏）。
        const canCommit = supplierConfirmed && !award
        const canIssue = Boolean(award)
        table.push({ id: intentId, intent_id: intentId, quote_id: intent.quote_id ?? '',
          package_id: intent.package_id ?? '', lines: (intent.lines ?? []).length,
          confirmed: supplierConfirmed
            ? `${asText(confirmed.get(intentId).confirmed_by)} @ ${asText(confirmed.get(intentId).confirmed_at)}`
            : '未确认',
          award_id: award?.award_id ?? '',
          approved_by: award
            ? `${asText(award.approved_by)} · ${awardRow ? signoffLabelOf(awardRow, award) : ''}`
            : '',
          gate_commit: commitGate.label,
          gate_po: poGate ? poGate.label : (award ? '（本行还没发 PO）' : ''),
          po_id: po?.po_id ?? '', chain: po?.chain ?? '',
          next_step: po ? '整条链已成立（行内可「追溯这条 PO」）'
            : (award ? '这一行现在可以「发 PO（人签）」'
              : (supplierConfirmed
                ? '这一行现在可以「授标承诺（人签）」（还要过人工门）'
                : '等供应商在它自己的界面点「确认授标」—— 确认之前既不能承诺、也不能发 PO（承诺不可凭空产生）')),
          row_actions: [...(canCommit ? ['award.commit'] : []), ...(canIssue ? ['po.issue'] : [])],
          ref: { kind: 'award', id: award?.award_id ?? intentId,
            title: award ? `授标 ${award.award_id}` : `意向 ${intentId}` } })
      }
      if (!table.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-award-intent',
          next_action: '在「收到的报价」表里点某一行「提出授标意向」（意向不产生义务）',
          columns: [{ key: 'intent_id', label: '意向' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        columns: [{ key: 'intent_id', label: '意向', type: 'code' }, { key: 'quote_id', label: '报价', type: 'code' },
          { key: 'lines', label: '条目', filter: 'number' }, { key: 'confirmed', label: '供应商确认' },
          { key: 'gate_commit', label: '人门：承诺（谁批的 / 能不能提交）' },
          { key: 'award_id', label: '承诺', type: 'code' }, { key: 'approved_by', label: '承诺：谁签的 / 谁批的' },
          { key: 'gate_po', label: '人门：发 PO（谁批的 / 能不能提交）' },
          { key: 'po_id', label: 'PO', type: 'code' }, { key: 'chain', label: '追溯链' },
          { key: 'next_step', label: '下一步' }],
        rows: table, counts: { intents: intents.length, awards: awards.length, po: pos.length },
        note: '承诺与 PO 两列只有在人签并过人工门之后才会有值（没签就是空 —— 不假装已承诺）；'
          + '行内按钮只在这一行**现在真能落账**时才出现：供应商还没确认 ⇒ 既不摆「授标承诺」也不摆「发 PO」'
          + '（缺什么、下一步该谁办，写在「下一步」列里）—— 不摆按下去必被拒的按钮。'
          + '**人门两列**（P48）读的是账本：有没有一扇 `granted` 的、**由别人批过**的门（写者只消费这种门）——'
          + '没有就说没有、是你自己批的就说是你自己批的、还在等就写卡在谁；门是别人的活，界面不代签也不隐藏按钮' }
    } }))

  /**
   * **意向逐行明细**（整包授标的「账本逐行对账」那一半）：一条意向覆盖整包多行时，把账本里
   * `award/intent-proposed.lines[]` **逐行摊开** —— 每行给条目 / 量 / 整数分单价 + 它的单价基准
   * （`<报价>#<条目>:unit_price`，也就是后面 PO 行会带的 `basis`）+ **这一行的账本行号**。
   *
   * 为什么要有这一块：`award.propose-package` 的**逐条回执**（toast / 「最近」流水）是一次性的；
   * 之后要回答"这份整包意向到底覆盖了哪几行、每行多少钱、逐行对不对得上账本"就得有这么一处
   * 只读面。行序 = 账本里 `lines[]` 的顺序（不重排），坏行逐条计数、好行照列。
   */
  out.push(surface.panel({ plugin_id: me, id: 'award.intent-lines',
    title: '意向逐行明细（整包授标 · 逐行对账）', view: 'contractor', order: 42, kind: 'table',
    hint: '一条意向覆盖整包多行时，这里把账本 `award/intent-proposed.lines[]` 逐行摊开：条目 / 量 / '
      + '整数分单价 + 单价基准（报价#条目）+ 这一行的账本行号 —— 逐行可回账本核，不用只信一句"已受理"。',
    data: () => {
      const rows = host.rows('contractor')
      const confirmed = new Map(typeRows(rows, 'award/confirmed')
        .map((row) => [asText(bodyOf(row).intent_id), bodyOf(row)]))
      const awards = new Map(typeRows(rows, 'award/committed')
        .map((row) => [asText(bodyOf(row).intent_id), bodyOf(row)]))
      const pos = typeRows(rows, 'po/issued').map((row) => bodyOf(row))
      const table = []
      let dropped = 0
      for (const row of typeRows(rows, 'award/intent-proposed')) {
        const body = bodyOf(row)
        const intentId = asText(body.intent_id)
        const packageId = asText(body.package_id)
        const quoteId = asText(body.quote_id)
        const lines = readRows(body.lines)
        dropped += lines.dropped
        const award = awards.get(intentId) ?? null
        const po = award ? pos.find((item) => asText(item.award_id) === asText(award.award_id)) ?? null : null
        lines.rows.forEach((line, index) => {
          const itemId = asText(line.item_id)
          table.push({ id: `${intentId}#${itemId}#${index}`, intent_id: intentId, ledger_seq: row.seq,
            package_id: packageId, quote_id: quoteId, item_id: itemId, qty: line.qty ?? '',
            unit_price_cents: line.unit_price_cents ?? '', basis: `${quoteId}#${itemId}:unit_price`,
            lines_in_intent: lines.all,
            status: award ? '已成承诺' : (confirmed.has(intentId) ? '供应商已确认' : '待供应商确认'),
            award_id: award ? asText(award.award_id) : '', po_id: po ? asText(po.po_id) : '' })
        })
      }
      if (!table.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-award-intent',
          next_action: '在「收到的报价（逐行）」表里按行内「整包提出授标意向」提一条（覆盖整包的多行）',
          columns: [{ key: 'item_id', label: '条目' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        columns: [
          { key: 'intent_id', label: '意向', type: 'code' }, { key: 'ledger_seq', label: '账本行号', filter: 'number' },
          { key: 'package_id', label: '包', type: 'code' }, { key: 'quote_id', label: '报价', type: 'code' },
          { key: 'item_id', label: '条目', type: 'code' }, { key: 'qty', label: '量', filter: 'number' },
          { key: 'unit_price_cents', label: '单价（整数分）', filter: 'number' },
          { key: 'basis', label: '单价基准（报价#条目）', type: 'code' },
          { key: 'lines_in_intent', label: '这份意向共几行', filter: 'number' },
          { key: 'status', label: '状态' }, { key: 'award_id', label: '承诺', type: 'code' },
          { key: 'po_id', label: 'PO', type: 'code' }],
        rows: table,
        counts: { intents: new Set(table.map((item) => item.intent_id)).size, lines: table.length, dropped },
        note: '行序 = 账本里 `lines[]` 的顺序（不重排）；`basis` 就是后面 PO 行会带的单价基准 ——'
          + '一行一条链、逐行可回账本核（`ledger_seq` 是那条事实在 append-only 账本里的位次）。'
          + (dropped ? ` 另有 ${dropped} 条行读不出来（形状异常）：已跳过并逐条计数，不静默丢。` : '') }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'award.propose', title: '提出授标意向（不产生义务）',
    views: ['contractor'], group: '授标', order: 10,
    hint: '意向可撤回、可重提；承诺不可凭空产生（FR-AWARD-001/002）',
    input: { fields: [
      { name: 'package_id', label: '包', type: 'text', required: true, from_row: true,
        help: '从「比价排名 / 收到的报价」那一行带入（行内点「提出授标意向」会自动填）' },
      { name: 'quote_id', label: '报价', type: 'text', required: true, from_row: true,
        help: '本侧账本里已收到的报价 id（在那一行的「提出授标意向」里自动带上；'
          + '工具栏/命令面板里点它会先让你挑一条报价）' },
      { name: 'item_id', label: '行项目', type: 'text', from_row: true, help: '批量（选中多行）时每行自带' },
      { name: 'qty', label: '数量', type: 'number', min: 1, from_row: true, help: '批量时每行自带' },
      { name: 'unit_price_cents', label: '中标单价（整数分）', type: 'number', min: 1, from_row: true,
        help: '批量时每行自带' },
      { name: 'reason', label: '理由（进意向正文）', type: 'text' },
    ] },
    server: async (ctx, input) => {
      // **批量行也是外部来的数组**：坏形状不再静默变成 `undefined`（修前 `row.item_id` 直接 TypeError，
      // 整个"提意向"崩掉）—— 先把不是对象的行**逐条计数**，有一条就具名拒（整批不落盘）。
      const bulkRows = Array.isArray(input.rows) ? input.rows.filter((row) => isRow(row)) : []
      const malformed = (Array.isArray(input.rows) ? input.rows.length : 0) - bulkRows.length
      if (malformed) {
        return { ok: false, code: 'row-malformed',
          reason: `选中的行里有 ${malformed} 条形状读不出来（不是对象）：批量提意向的每一行都必须是行对象`,
          next_action: '在「收到的报价」表里按行内的「提出授标意向」重选（表格行永远是行对象）' }
      }
      const lines = bulkRows.length
        ? bulkRows.map((row) => ({ item_id: asText(row.item_id ?? row.id), qty: Number(row.qty),
          unit_price_cents: Number(row.unit_price_cents ?? input.unit_price_cents) }))
        : [{ item_id: asText(input.item_id), qty: Number(input.qty),
          unit_price_cents: Number(input.unit_price_cents) }]
      const staged = host.stage('commitment-apply', { kind: 'commitment-apply', action: 'propose',
        view: 'contractor', package_id: asText(input.package_id), quote_id: asText(input.quote_id), lines,
        reason: String(input.reason ?? ''), note: '', actor: 'agent:commitment-apply' })
      if (!staged.ok) return staged
      const run = host.runPython('src/domain/commitments/tools/commitment-apply.py',
        ['--step', 'propose', '--request', staged.path, '--ui-shared', host.sharedDir,
          '--ledger-contractor', ledgerC(), '--ledger-supplier', ledgerS(),
          '--intent-out', intentFile(), '--now', host.now()])
      const json = cleanJson(run)
      // 唯一写者的 `next_action` 里偶尔提到走查脚本（`本脚本 --step confirm`）——产品界面不该教用户回终端，
      // 这里换成**界面内**的下一步（写者原文仍留在 `result.writer_next_action` 里可查）。
      const writerNext = asText(json.next_action)
      // 「写者文案里提到命令行」这条判据看**写者原文**（`json.writer_text`，见 `cleanJson`）：
      // 给人看的那一份已经被洗过，洗过的文本里不会再出现旗标 —— 判据必须落在原文上。
      const writerMentionsCli = /本脚本|--step|PYTHONPATH/.test(asText(json.writer_text?.next_action))
      const inAppNext = (writerNext && writerMentionsCli)
        ? '等供应商在 APP 里确认中标（供应商道「确认授标」/ 通知中心「去处理」）；'
          + '确认 + 人工批准齐备后，在「授标链」行内点「授标承诺（人签）」'
        : writerNext
      return { ok: run.ok && json.ok === true, code: json.refusal?.code ?? (json.ok ? 'proposed' : 'writer-failed'),
        reason: json.refusal?.reason ?? run.reason ?? '',
        next_action: json.refusal?.next_action ?? inAppNext ?? '看 stdout 定位唯一写者的拒绝原因',
        result: { intent_id: json.intent_id ?? null, applied: json.applied ?? [], envelope: json.envelope ?? null,
          ledger_added: json.ledger_added ?? 0, duplicates: json.duplicates ?? [],
          writer_next_action: writerNext || null } }
    } }))

  /**
   * **整包授标**（P39 终局验收 §4.3 的缺口）：多行报价（29 §7.5：行在 `lines[]` 里）原先只能**逐行**
   * 提意向 ⇒ 一份 2 行报价要走「2 条意向 / 2 次供应商确认 / 2 份承诺 / 2 张 PO」。这条动作把**整份报价
   * 的行一次提完**：一条 `award/intent-proposed`（body 的 `lines[]` 带上每一行），随后供应商**一次**
   * 确认、承包商**一次**人签承诺、**一张** PO 覆盖整包 —— 链只有一条，但**逐行仍各带自己的引用链**：
   *
   *   · 行与价**逐行取自本侧账本的报价事实**（界面不许手抄、不许改价；量取自本侧发布的包快照文件）；
   *   · 意向/承诺/PO 三处都按行保留 `item_id` 与整数分单价，PO 行还带
   *     `basis = <报价 id>#<条目>:unit_price` ⇒ 账本里**逐行**都能对回原报价那一条。
   *
   * 回执**逐条**（沿用 P18 批量人签的语义与文案口径）：逐行列出入批的条目/量/单价 + 它的引用链，
   * 并且**不是**"全成/全败"的模糊话 —— 每条自带 `where`（`included` / `refused`）与具名原因；
   * 行数上限 50（`batch-too-large`，与 P18 同一口径）；同一份意向重提 ⇒ 写者如实报 `already-proposed`
   * 且**账本零新增**（幂等）。**一条意向是原子的**：有任何一行读不出来（没有量/没有价/行形状坏）⇒
   * **整包具名拒**、账本零新增 —— 不拿"部分行"冒充整包（逐行入口仍照旧可用：行内「提出授标意向」）。
   */
  out.push(surface.action({ plugin_id: me, id: 'award.propose-package',
    title: '整包提出授标意向（覆盖这份报价的每一行）', views: ['contractor'], group: '授标', order: 12,
    confirm: { required: true,
      message: '整包意向覆盖这份报价的每一行（逐行仍各带自己的引用链），不产生义务、可撤回：确认？' },
    hint: '一条意向覆盖整包：行与价逐行取自本侧账本的报价事实（界面不改价），量取自本侧发布的包快照；'
      + '随后供应商一次确认 → 承包商一次人签承诺 → 一张 PO（逐行 basis 指向中标报价条目）',
    input: { fields: [
      { name: 'package_id', label: '包', type: 'text', required: true, from_row: true,
        help: '从「收到的报价（逐行）」那一行带入（行内点「整包提出授标意向」会自动填）' },
      { name: 'quote_id', label: '报价', type: 'text', required: true, from_row: true,
        help: '这一份报价的整包意向覆盖它 `lines[]` 里的每一行（行形状见 29 §7.5）' },
      { name: 'reason', label: '理由（进意向正文）', type: 'text' },
    ] },
    server: async (ctx, input) => {
      const packageId = asText(input.package_id)
      const quoteId = asText(input.quote_id)
      if (packageId === '' || quoteId === '') {
        return { ok: false, code: 'package-or-quote-required',
          reason: '整包意向要知道是哪个包的哪一份报价（不猜）',
          next_action: '在「收到的报价（逐行）」表里按行的「整包提出授标意向」打开（包/报价会带进来）' }
      }
      const rows = host.rows('contractor')
      // ---- 逐行报价事实（29 §7.5 的两种形状；口径与 `rfq.responses` / `compare-rank.py` 同一个）---
      const quoted = []
      let lineShape = 'none'
      for (const row of typeRows(rows, 'quote/submitted')) {
        const body = bodyOf(row)
        if (asText(body.quote_id) !== quoteId) continue
        const multi = Array.isArray(body.lines) && body.lines.length > 0
        const list = multi ? body.lines
          : [{ item_id: body.item_id, unit_price_cents: body.unit_price_cents,
            lead_time_days: body.lead_time_days }]
        lineShape = multi ? 'lines[]（多行）' : 'body 顶层（单行）'
        for (const line of readRows(list).rows) {
          const itemId = asText(line.item_id)
          const raw = line.unit_price_cents ?? (Number.isFinite(Number(line.unit_price))
            ? Number(line.unit_price) * 100 : null)
          const cents = Number(raw)
          if (itemId === '' || !Number.isFinite(cents) || cents <= 0) continue
          quoted.push({ item_id: itemId, unit_price_cents: cents,
            lead_time_days: Number.isFinite(Number(line.lead_time_days)) ? Number(line.lead_time_days) : null })
        }
      }
      if (!quoted.length) {
        return { ok: false, code: 'quote-lines-unreadable',
          reason: `本侧账本里读不出报价 ${quoteId} 的任何一行（行形状：${lineShape}）`,
          next_action: '先让对方把报价送达本侧（APP 的「人签提交报价」会写这条登记），或按行内'
            + '「提出授标意向」逐行提（那一行会把量/单价带进表单）' }
      }
      if (quoted.length > MAX_PACKAGE_LINES) {
        return { ok: false, code: 'batch-too-large',
          reason: `这份报价 ${quoted.length} 行超过一次上限 ${MAX_PACKAGE_LINES} 行`,
          next_action: `分两次提（先按行内「提出授标意向」提一部分，再提剩下的）；`
            + `上限与批量人签同一口径（${MAX_PACKAGE_LINES}）` }
      }
      // ---- 量：只取**本侧发布的包快照**（唯一写者落盘的那份），读不到就说读不到 ----
      const items = packageItemsOf(rows, packageId)
      if (!items.ok) {
        return { ok: false, code: 'package-snapshot-missing',
          reason: `读不到包 ${packageId} 的行项目快照：${items.why || '没有可读的快照'}`,
          next_action: '先在「发包」里发布这一包（快照是量的唯一来源，不编数量）；'
            + '或在「收到的报价」表里按行内「提出授标意向」逐行提（那一行自带量）',
          result: { quote_id: quoteId, package_id: packageId, line_shape: lineShape,
            lines_total: quoted.length } }
      }
      const lines = []
      const receipts = []
      const missingQty = []
      for (const line of quoted) {
        const item = items.byItem.get(line.item_id)
        const qty = item ? Number(item.qty) : Number.NaN
        if (!Number.isFinite(qty) || qty <= 0) { missingQty.push(line.item_id); continue }
        lines.push({ item_id: line.item_id, qty, unit_price_cents: line.unit_price_cents })
      }
      if (missingQty.length) {
        for (const line of quoted) {
          receipts.push({ item_id: line.item_id, qty: items.byItem.get(line.item_id)?.qty ?? null,
            unit_price_cents: line.unit_price_cents,
            where: missingQty.includes(line.item_id) ? 'refused' : 'included',
            code: missingQty.includes(line.item_id) ? 'line-qty-invalid' : '',
            reason: missingQty.includes(line.item_id) ? '包快照里没有这一行的量（不编数量）' : '',
            basis: `${quoteId}#${line.item_id}:unit_price` })
        }
        return { ok: false, code: 'line-qty-invalid',
          reason: `有 ${missingQty.length} 行在包快照里读不到量（${missingQty.join(' ')}）⇒ 整包意向不落账`,
          next_action: '先在「包的行项目」里把这一包的条目补上（或让对方按最新一版重报），再提整包意向；'
            + '只提读得出量的那几行可以走行内「提出授标意向」',
          result: { quote_id: quoteId, package_id: packageId, line_shape: lineShape,
            snapshot_rev: items.rev, lines_total: quoted.length, receipts } }
      }
      // ---- 一条意向覆盖整包：**只经唯一写者** `commitment-apply.py --step propose`（界面不是第二条写路径）----
      const staged = host.stage('commitment-apply', { kind: 'commitment-apply', action: 'propose',
        view: 'contractor', package_id: packageId, quote_id: quoteId, lines,
        reason: String(input.reason ?? ''), note: '', actor: 'agent:commitment-apply' })
      if (!staged.ok) return staged
      const run = host.runPython('src/domain/commitments/tools/commitment-apply.py',
        ['--step', 'propose', '--request', staged.path, '--ui-shared', host.sharedDir,
          '--ledger-contractor', ledgerC(), '--ledger-supplier', ledgerS(),
          '--intent-out', intentFile(), '--now', host.now()])
      const json = cleanJson(run)
      const done = run.ok && json.ok === true
      // 幂等：同一份意向已经提过时写者回 `duplicates[{intent_id, reason:'already-proposed'}]`（账本零新增）——
      // 那一条也把 intent_id 报出来，界面照实说"已经提过这一条"，不假装刚提的。
      const intentId = asText(json.intent_id) || asText((json.duplicates ?? [])[0]?.intent_id)
      for (const line of lines) {
        receipts.push({ item_id: line.item_id, qty: line.qty, unit_price_cents: line.unit_price_cents,
          where: done ? 'included' : 'refused', code: done ? '' : (json.refusal?.code ?? 'writer-failed'),
          reason: done ? '' : (json.refusal?.reason ?? run.reason ?? ''),
          intent_id: intentId, basis: `${quoteId}#${line.item_id}:unit_price` })
      }
      const writerNext = asText(json.next_action)
      // 「写者文案里提到命令行」这条判据看**写者原文**（`json.writer_text`，见 `cleanJson`）：
      // 给人看的那一份已经被洗过，洗过的文本里不会再出现旗标 —— 判据必须落在原文上。
      const writerMentionsCli = /本脚本|--step|PYTHONPATH/.test(asText(json.writer_text?.next_action))
      const inAppNext = (writerNext && writerMentionsCli)
        ? '等供应商在 APP 里确认中标（供应商道「确认授标」）；确认 + 人工批准齐备后在「授标链」行内点'
          + '「授标承诺（人签）」—— 一次承诺覆盖整包，再发一张 PO（逐行 basis 指向报价条目）'
        : writerNext
      // **逐条回执**（沿用 P18 批量人签的文案口径）：逐行列明这次进了哪几行、量/单价各是多少 ——
      // 回执里看得见这句话（toast / 「最近」动作流水照抄 `next_action`），不只是一句"成功了"。
      const lineReceipt = lines
        .map((line) => `${line.item_id}×${line.qty}@${line.unit_price_cents}分`).join(' · ')
      const step = json.refusal?.next_action ?? inAppNext ?? '看 result 里的逐条回执定位'
      const idempotent = (json.duplicates ?? []).some((item) => item?.reason === 'already-proposed')
      const head = json.refusal
        ? `整包 ${lines.length} 行一次提交，未落账（${json.refusal.code}）：${lineReceipt}`
        : (idempotent
          ? `这一份意向已经提过（${intentId || '—'}）⇒ 账本零新增：覆盖 ${lines.length} 行（${lineReceipt}）`
          : `已受理：一条意向 ${intentId || '—'} 覆盖整包 ${lines.length} 行（${lineReceipt}）`)
      return { ok: done, code: json.refusal?.code ?? (done ? 'proposed' : 'writer-failed'),
        reason: json.refusal?.reason ?? run.reason ?? '',
        note: `${head}；逐行 basis = ${quoteId}#<条目>:unit_price —— 账本里可逐行对账`,
        next_action: `${head} —— ${step}`,
        result: { intent_id: intentId || null, quote_id: quoteId, package_id: packageId,
          line_shape: lineShape, snapshot_rev: items.rev, lines_total: quoted.length,
          lines_included: done ? lines.length : 0, receipts,
          applied: json.applied ?? [], ledger_added: json.ledger_added ?? 0,
          duplicates: json.duplicates ?? [], envelope: json.envelope ?? null,
          writer_next_action: writerNext || null } }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'award.commit', title: '授标承诺（人签）', views: ['contractor'],
    group: '授标', order: 20, permission: 'human-signature', object_kind: 'award',
    confirm: { required: true, message: '授标承诺＝对外义务：确认以你的署名承诺？' },
    hint: '三样门齐备才落账：意向 + 供应商确认 + **一扇已经批准的人门**（`scope=award.commit`、`ref=<意向>`）。'
      + '人门必须是**别人**批的（批准人不得是署名者本人）——没有这样的门 ⇒ 具名拒（approval-required / '
      + 'approver-must-differ）+ 下一步，账本零新增；自签自批只在运营侧显式打开开关时才行（默认关闭，'
      + '回执会如实写「本次批准来自你本人署名」）',
    input: { fields: [
      { name: 'intent_id', label: '意向 id', type: 'text', required: true, from_route: true,
        help: '从「授标链」表里复制（awin-…）；在授标对象页上会自动填当前这一条' },
      { name: 'signature', label: '署名（人签）', type: 'signature', required: true, help: 'human:<你的名字>' },
      { name: 'reason', label: '批准理由', type: 'text' },
      { name: 'comment', label: '批注（进批准记录）', type: 'text' },
    ] },
    server: async (ctx, input) => {
      const staged = host.stage('commitment-apply', { kind: 'commitment-apply', action: 'commit',
        view: 'contractor', intent_id: asText(input.intent_id), reason: String(input.reason ?? ''),
        comment: String(input.comment ?? ''), note: '', actor: asText(input.signature) })
      if (!staged.ok) return staged
      const run = host.runPython('src/domain/commitments/tools/commitment-apply.py',
        ['--step', 'commit', '--request', staged.path, '--ui-shared', host.sharedDir,
          '--ledger-contractor', ledgerC(), '--ledger-supplier', ledgerS(), '--now', host.now()])
      const json = cleanJson(run)
      // 「谁批的 ≠ 谁签的」（P48）：写者回执里的人门那段**原样**抬到回执最外层 —— 界面上要能直接读到，
      // 而不是只藏一份 `result` 里。自签自批那种（只在运营侧开了开关时可能）如实写「来自你本人署名」。
      const gateNote = asText(json.gate_note)
      return { ok: run.ok && json.ok === true, code: json.refusal?.code ?? (json.ok ? 'committed' : 'writer-failed'),
        reason: json.refusal?.reason ?? run.reason ?? '',
        next_action: json.refusal?.next_action
          ?? (json.ok === true
            ? `已成立：${json.award_id ?? 'aw-…'} 已落账。人门：${gateNote || '（账本里的门）'}。`
              + '下一步：在「授标链」行内点「发 PO（人签）」逐行派生采购单'
              + '（发 PO 也要另一个人批过 po.issue 的门）'
            : (json.next_action ?? '看 result / stdout 定位唯一写者的输出（这条路才是失败）')),
        result: { award_id: json.award_id ?? null, approval_id: json.approval_id ?? null,
          approver: json.approver ?? null, signer: json.signer ?? null, gate: json.gate ?? null,
          gate_note: gateNote || null, gate_consumed: json.gate_consumed ?? false,
          self_approved: json.self_approved ?? false,
          self_approval_switch: json.self_approval_switch ?? false,
          self_approval_policy: json.self_approval_policy ?? null,
          applied: json.applied ?? [], ledger_added: json.ledger_added ?? 0, duplicates: json.duplicates ?? [] } }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'po.issue', title: '发 PO（人签）', views: ['contractor'],
    group: '授标', order: 30, permission: 'human-signature', object_kind: 'award',
    confirm: { required: true, message: '发 PO 是承诺类动作：确认以你的署名发出并投递给中标供应商？' },
    hint: 'PO 只能由承诺派生；行与价都从中标条目派生（不得在界面上自由改价）；发出即同步投递给中标供应商'
      + '（两侧账本各一条投递登记）。人门与承诺同一条：要**一扇已经批准**的 `scope=po.issue`、`ref=<承诺>` 的门，'
      + '且**批准人不得是署名者本人**（没有 ⇒ 具名拒 + 下一步，账本零新增）',
    input: { fields: [
      { name: 'award_id', label: '承诺 id', type: 'text', required: true, from_route: true,
        help: '从「授标链」表里复制（aw-…）；在授标对象页上会自动填当前这一条' },
      { name: 'signature', label: '署名（人签）', type: 'signature', required: true, help: 'human:<你的名字>' },
      { name: 'delivery_window', label: '交期窗口（随投递登记给供应商）', type: 'text', max: 120,
        help: '如「2026-10-08 前到货」；空着也行，供应商侧会如实显示"对方没给"' },
      { name: 'ship_to', label: '送货地址（随投递登记给供应商）', type: 'text', max: 120,
        help: '如「苏州工业园区 A 区 3 号库」；空着也行' },
      { name: 'reason', label: '批准理由', type: 'text' },
      { name: 'comment', label: '批注（进批准记录）', type: 'text' },
    ] },
    server: async (ctx, input) => {
      const staged = host.stage('commitment-apply', { kind: 'commitment-apply', action: 'po', view: 'contractor',
        award_id: asText(input.award_id), reason: String(input.reason ?? ''), comment: String(input.comment ?? ''),
        delivery_window: asText(input.delivery_window).slice(0, 120),
        ship_to: asText(input.ship_to).slice(0, 120),
        note: '', actor: asText(input.signature) })
      if (!staged.ok) return staged
      const run = host.runPython('src/domain/commitments/tools/commitment-apply.py',
        ['--step', 'po', '--request', staged.path, '--ui-shared', host.sharedDir,
          '--ledger-contractor', ledgerC(), '--ledger-supplier', ledgerS(),
          '--delivery-out', deliveryFile(), '--now', host.now()])
      const json = cleanJson(run)
      const gateNote = asText(json.gate_note)
      return { ok: run.ok && json.ok === true, code: json.refusal?.code ?? (json.ok ? 'issued' : 'writer-failed'),
        reason: json.refusal?.reason ?? run.reason ?? '',
        next_action: json.refusal?.next_action
          ?? (json.ok === true ? '已签发并投递：' + (json.po_id ?? 'po-…') + '（追溯模式 ' + (json.trace_mode ?? '—')
            + '，投给 ' + (json.delivered_to ?? []).join('/') + '）。人门：' + (gateNote || '（账本里的门）')
            + '。下一步：对方在供应商道「发给我的采购单」里回签'
            + '(人签)；你也可以点行内「追溯这条 PO」看四段链路'
            : (json.next_action ?? '看 result / stdout 定位唯一写者的输出（这条路才是失败）')),
        result: { po_id: json.po_id ?? null, award_id: json.award_id ?? null, chain: json.chain ?? null,
          trace_mode: json.trace_mode ?? null, total_amount: json.total_amount ?? null,
          delivered_to: json.delivered_to ?? [], delivery: json.delivery ?? null,
          premises: json.premises ?? {},
          approver: json.approver ?? null, signer: json.signer ?? null, gate: json.gate ?? null,
          gate_note: gateNote || null, gate_consumed: json.gate_consumed ?? false,
          self_approved: json.self_approved ?? false,
          self_approval_switch: json.self_approval_switch ?? false,
          self_approval_policy: json.self_approval_policy ?? null,
          applied: json.applied ?? [], ledger_added: json.ledger_added ?? 0 } }
    } }))

  // ------------------------------------------------------------------ 供应商侧
  out.push(surface.panel({ plugin_id: me, id: 'award.inbox', title: '发给我的授标意向（只出自己那份）',
    view: 'supplier', order: 50, kind: 'table', actions: ['award.confirm'],
    data: () => {
      const realm = realmOf('supplier')
      const all = host.readJson(intentFile())
      if (!Array.isArray(all) || !all.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-award-intent',
          next_action: '等承包商在 APP 里提出授标意向（意向本身不产生义务）',
          columns: [{ key: 'intent_id', label: '意向' }], rows: [] }
      }
      const mine = readRows(all).rows.filter((item) => !realm || !(item.delivered_to ?? []).length
        || (item.delivered_to ?? []).map(String).includes(realm))
      const confirmedIds = new Set(typeRows(host.rows('supplier'), 'award/confirmed')
        .map((row) => asText(bodyOf(row).intent_id)))
      return { ok: true, kind: 'table',
        columns: [{ key: 'intent_id', label: '意向', type: 'code' }, { key: 'package_id', label: '包', type: 'code' },
          { key: 'quote_id', label: '我的报价', type: 'code' }, { key: 'lines', label: '条目', filter: 'number' },
          { key: 'reason', label: '对方理由' }, { key: 'confirmed', label: '我确认了吗' }],
        rows: mine.map((item) => ({ id: String(item.intent_id), intent_id: item.intent_id,
          package_id: item.package_id, quote_id: item.quote_id,
          // 逐行文本走唯一入口（`readRows` 写在参数上）：坏行逐条计数、好行照列
          lines: linesTextOf(readRows(item.lines), (line) => `${line.item_id}×${line.qty}@${line.unit_price_cents ?? line.unit_price}`),
          reason: item.reason ?? '', confirmed: confirmedIds.has(asText(item.intent_id)) ? '已确认' : '待确认' })),
        row_actions: ['award.confirm'], counts: { intents: mine.length },
        note: '确认是你自己的动作（只确认自己那份报价对应的意向）；确认不等于承诺' }
    } }))

  out.push(surface.panel({ plugin_id: me, id: 'award.confirmed', title: '我确认过的授标（本侧账本）',
    view: 'supplier', order: 60, kind: 'table',
    data: () => {
      const rows = typeRows(host.rows('supplier'), 'award/confirmed').map((row) => bodyOf(row))
      if (!rows.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-confirmation',
          next_action: '收到授标意向后在「发给我的授标意向」里确认',
          columns: [{ key: 'intent_id', label: '意向' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        columns: [{ key: 'intent_id', label: '意向', type: 'code' }, { key: 'quote_id', label: '报价', type: 'code' },
          { key: 'confirmed_by', label: '确认人', type: 'code' }, { key: 'confirmed_at', label: '确认时刻', filter: 'date' }],
        rows: rows.map((row) => ({ id: row.intent_id, ...row })), counts: { confirmations: rows.length } }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'award.confirm', title: '确认授标（人签）', views: ['supplier'],
    group: '授标', order: 40, permission: 'human-signature',
    confirm: { required: true, message: '确认这份意向（不是承诺，但对方要凭它才能承诺）：确认？' },
    hint: '写自己账本 award/confirmed + 承包商账本一条同名登记（双向登记）',
    input: { fields: [
      { name: 'intent_id', label: '意向 id', type: 'text', required: true, from_row: true,
        help: '从「发给我的授标意向」里复制（或点通知中心那条「去处理」自动带上）；'
          + '工具栏/命令面板里点它会先让你从收到的意向里**挑一条**' },
      { name: 'signature', label: '署名（人签）', type: 'signature', required: true, help: 'human:<你的名字>' },
      { name: 'note', label: '备注', type: 'text' },
    ] },
    server: async (ctx, input) => {
      const cross = sideGuard(ctx, 'supplier', '确认授标（人签）')
      if (cross) return cross
      const staged = host.stage('commitment-apply', { kind: 'commitment-apply', action: 'confirm', view: 'supplier',
        intent_id: asText(input.intent_id), note: String(input.note ?? ''), actor: asText(input.signature) })
      if (!staged.ok) return staged
      const run = host.runPython('src/domain/commitments/tools/commitment-apply.py',
        ['--step', 'confirm', '--request', staged.path, '--ui-shared', host.sharedDir,
          '--ledger-contractor', ledgerC(), '--ledger-supplier', ledgerS(), '--now', host.now()])
      const json = cleanJson(run)
      return { ok: run.ok && json.ok === true, code: json.refusal?.code ?? (json.ok ? 'confirmed' : 'writer-failed'),
        reason: json.refusal?.reason ?? run.reason ?? '',
        next_action: json.refusal?.next_action
          ?? (json.ok === true ? '已确认：对方侧（承包商）的「授标承诺」现在可以提交了（确认不等于承诺）。下一步回承包商侧的授标链看状态'
            : (json.next_action ?? '看 result / stdout 定位唯一写者的输出（这条路才是失败）')),
        result: { intent_id: json.intent_id ?? null, applied: json.applied ?? [],
          ledger_added: json.ledger_added ?? 0, duplicates: json.duplicates ?? [] } }
    } }))

  // ---------------------------------------------------------------- 供应商侧：**发给我的采购单**
  /**
   * 「发给我的采购单」（P8）：承包商发 PO 时**同步投递**，本侧账本因此多一条 `po/distributed`
   * （收件人侧那条投递登记，由签发方的唯一写者写）。这一组面板/动作全部读**本侧事实**：
   *   · 行逐行来自投递登记的 `lines`（ref_line / qty / unit_price / basis / trace）；
   *   · 追溯链来自 `chain`（po → 承诺 → 意向 → 报价），报价那一段是**本侧自己提交的报价**
   *     （承包商侧的承诺/意向页面对本侧不可见，所以只给文本 + 自己那份报价的深链）；
   *   · 执行前提：交期窗口/送货地址来自投递登记（发 PO 的人给的；没给就如实说"对方没给"），
   *     币种/报价截止来自本侧 `rfq/distributed`（同一个 `package_id` 对得上才用）。
   */
  const poReceivedOf = (poId) => poDeliveries('supplier').find((item) => asText(item.po_id) === asText(poId)) ?? null

  out.push(surface.panel({ plugin_id: me, id: 'po.inbox', title: '发给我的采购单（只出自己那份）',
    view: 'supplier', order: 55, kind: 'table', actions: ['po.acknowledge', 'po.export-received'],
    hint: '逐行 + 追溯链 + 回签状态；打开行内「打开 →」进这张 PO 的对象页（附件、导出、回签都在那里）。'
      + '打开这一页会给签发方留一条已读回执（谁 / 何时 / 看过几次，0600 文件、不进账本）——'
      + '回执里没有你的报价、成本或任何本侧私有数据；已读 ≠ 回签（回签是人签、有义务语义）。',
    data: (ctx) => {
      const realm = realmOf('supplier')
      const delivered = poDeliveries('supplier')
      const acks = acksOf('supplier')
      const envelopes = new Map(myDeliveryEnvelopes(realm).map((item) => [asText(item.po_id), item]))
      if (realm === '') {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-identity',
          columns: [{ key: 'po_id', label: 'PO' }], rows: [],
          next_action: '本侧账本里还没有 realm（身份）：先在本侧产生一条事实，再回来看投递给你的采购单' }
      }
      if (!delivered.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-po-delivery',
          columns: [{ key: 'po_id', label: 'PO' }], rows: [],
          next_action: '等承包商在 APP 里「发 PO（人签）」——发出即投递，本侧账本会多一条 po/distributed 登记' }
      }
      // **已读回执**：这一页列出的每一张（投递给本侧的）PO 都记一条「谁在何时看过」——
      // 这是**签发方**回答「对方收到了吗 / 看了吗」的那一半；不写账本（读取痕迹，见回执模块文件头）。
      const receiptOut = delivered.map((item) => recordPoReceipt(ctx, asText(item.po_id), 'po.inbox'))
        .filter((item) => item !== null)
      const receiptLine = receiptOut.map((item) => receiptNote(item)).filter((item) => item !== '')
        .slice(0, 1).join('')
      return { ok: true, kind: 'table',
        columns: [{ key: 'po_id', label: 'PO', type: 'code' }, { key: 'lines', label: '行数', filter: 'number' },
          { key: 'total_amount', label: '金额（元）', filter: 'number' },
          { key: 'approved_by', label: '门的批准人（人门；≠ 署名者）', type: 'code' },
          { key: 'issued_at', label: '签发时刻', filter: 'date' }, { key: 'delivered_at', label: '投递时刻', filter: 'date' },
          { key: 'chain', label: '追溯链' }, { key: 'ack', label: '回签' }],
        rows: delivered.map((item) => {
          const poId = asText(item.po_id)
          const ack = acks.get(poId)
          return { id: poId, po_id: poId, lines: (item.lines ?? []).length,
            total_amount: item.total_amount ?? '', approved_by: item.approved_by ?? '',
            issued_at: item.issued_at ?? '',
            delivered_at: envelopes.get(poId)?.delivered_at ?? asText(item.sent_at),
            recipients: (item.recipients ?? []).join(' / '),
            chain: item.chain ?? '', quote_id: item.quote_id ?? '',
            ack: ack ? `${asText(ack.acknowledged_by)} @ ${asText(ack.acknowledged_at)}` : '待回签',
            ref: { kind: 'po', id: poId, title: `采购单 ${poId}` } }
        }),
        row_actions: ['po.acknowledge', 'po.export-received'], counts: { po: delivered.length },
        note: '行来自本侧账本的投递登记（`po/distributed`，签发方写的那条）；投递信封里 `delivered_to` '
          + '不含我这侧的条目根本不出现在这里（不是藏起来）'
          + `${receiptLine ? ` · ${receiptLine}` : ''}` }
    } }))

  out.push(surface.panel({ plugin_id: me, id: 'po.object-received', title: '采购单（对象页：我先看到的那份）',
    view: 'supplier', order: 50, kind: 'kv', object_kind: 'po',
    hint: '事实全部来自本侧账本的投递登记；回签状态来自本侧 po/acknowledged。'
      + '打开这一页会给签发方留一条已读回执（谁 / 何时 / 看过几次，0600 文件、不进账本）——'
      + '回执里没有你的报价、成本或任何本侧私有数据；已读 ≠ 回签（回签是人签、有义务语义）。',
    data: (ctx) => {
      const poId = asText(ctx.route?.id)
      const item = poReceivedOf(poId)
      if (!item) {
        return { ok: true, kind: 'kv', object: { found: false, title: `采购单 ${poId}`,
          reason: 'po-not-delivered-to-you',
          next_action: '这条 PO 没有投递到本侧（本侧账本里没有它的投递登记）：回「发给我的采购单」列表，'
            + '点行内「打开 →」用真实存在的深链' }, items: [] }
      }
      const ack = acksOf('supplier').get(poId)
      // **已读回执**（对象页 = 真正「打开了这张采购单」）：签发方在承包商道 `po.receipts` 里看到「谁 / 何时 / 几次」
      const receipt = recordPoReceipt(ctx, poId, 'po.object-received')
      const myQuote = typeRows(host.rows('supplier'), 'quote/submitted')
        .some((row) => asText(bodyOf(row).quote_id) === asText(item.quote_id))
      const links = myQuote
        ? [{ kind: 'quote', id: asText(item.quote_id), label: `我提交的报价 ${asText(item.quote_id)}`,
          where: '供应商道 › 我的报价', fact: `${(item.lines ?? []).length} 行`,
          href: `${host.prefix}/app/supplier/quote/${encodeURIComponent(asText(item.quote_id))}/` }]
        : []
      return { ok: true, kind: 'kv',
        object: { title: `采购单 ${poId}`, found: true,
          subtitle: `${asText(item.chain)} · 追溯模式 ${asText(item.trace_mode)} · 签发 ${asText(item.issued_at)}`,
          facts: [
            { key: '金额（元）', value: String(item.total_amount ?? '') },
            { key: '行数', value: String((item.lines ?? []).length) },
            // P48：「签发」是承包商侧署名的（账本行 actor），这个字段是**门的批准人**（谁批的）——两者不同才对
            { key: '门的批准人（承包商侧，谁批的）', value: asText(item.approved_by), code: true },
            { key: '投递对象', value: (item.recipients ?? []).join(' / '), code: true },
            { key: '包 / 报价', value: `${asText(item.package_id)} / ${asText(item.quote_id)}`, code: true },
          ],
          links,
          // **分享**（插件声明"对方能不能看"；机制据此写分享弹层与邮件正文）
          share: { visibility: 'both', other_side_view: 'contractor',
            requirements: ['对方要用承包商侧的身份登录（签发方）；这张 PO 是按 realm 投递的 —— '
              + '只有投递到本侧的 PO 才会出现在本侧视图里'],
            note: '这是投递给本侧的那一份（本侧账本里有投递登记）；回签件挂在这张 PO 的附件面板上。' } },
        items: [
          { key: '追溯链', value: asText(item.chain), code: true },
          { key: '我回签了吗', value: ack ? `已回签：${asText(ack.acknowledged_by)} @ ${asText(ack.acknowledged_at)}`
            + (asText(ack.note) ? ` · 备注 ${asText(ack.note)}` : '') : '还没有（人签动作「确认收到采购单」）' },
          { key: '投递时刻', value: asText(item.sent_at) },
          // **当次留痕如实可见**（kv 面板的 `note` 也不在正常态渲染 ⇒ 回执写进条目里）
          { key: '已读回执（签发方能看到）', value: receiptNote(receipt)
            || '这次没记（没有会话身份 → 不记回执；回执是读取痕迹，不进账本）' },
        ],
        note: '这一页只看本侧账本的事实：PO 的行与价由承包商从承诺派生，本侧不提供任何改价入口；'
          + '回签（po/acknowledged）也不改 PO 的任何行与价'
          + `${receiptNote(receipt) ? ` · ${receiptNote(receipt)}` : ''}` }
    } }))

  out.push(surface.panel({ plugin_id: me, id: 'po.object-lines-received', title: '采购单逐行明细（单价基准可核）',
    view: 'supplier', order: 51, kind: 'table', object_kind: 'po',
    data: (ctx) => {
      const item = poReceivedOf(asText(ctx.route?.id))
      if (!item) {
        return { ok: true, kind: 'table', degraded: true, reason: 'po-not-delivered-to-you',
          columns: [{ key: 'ref_line', label: '行项目' }], rows: [] }
      }
      // 投递登记里的行数组走唯一入口：坏行逐条计数（`counts.dropped`），好行照列
      const lines = readRows(item.lines)
      return { ok: true, kind: 'table',
        columns: [{ key: 'ref_line', label: '行项目', type: 'code' }, { key: 'qty', label: '量', filter: 'number' },
          { key: 'unit_price', label: '单价（元）', filter: 'number' }, { key: 'amount', label: '行金额（元）', filter: 'number' },
          { key: 'basis', label: '单价基准（中标报价条目）', type: 'code' },
          { key: 'trace', label: '追溯模式' }],
        rows: lines.rows.map((line) => ({ id: String(line?.ref_line), ref_line: line?.ref_line,
          qty: line?.qty, unit_price: line?.unit_price,
          amount: Number(line?.qty ?? 0) * Number(line?.unit_price ?? 0),
          basis: line?.basis, trace: line?.trace })),
        counts: { lines: lines.all, dropped: lines.dropped },
        note: '每一行的 `basis` 指向中标报价里的条目（本侧提交的那份报价）；量×单价 = 行金额，可逐行核'
          + '（读不出来的行已跳过并计数，不静默丢）' }
    } }))

  out.push(surface.panel({ plugin_id: me, id: 'po.prereqs', title: '执行前提（送货地址 / 交期窗口 / 截止）',
    view: 'supplier', order: 52, kind: 'kv', object_kind: 'po',
    hint: '有事实就照实给；没有的如实说"对方没给"（不编送货地址、不编交期）',
    data: (ctx) => {
      const poId = asText(ctx.route?.id)
      const item = poReceivedOf(poId)
      if (!item) {
        return { ok: true, kind: 'kv', degraded: true, reason: 'po-not-delivered-to-you', items: [] }
      }
      const packageId = asText(item.package_id)
      const delivery = poDeliveries('supplier').find((row) => asText(row.po_id) === poId) ?? {}
      const rfq = readRows(typeRows(host.rows('supplier'), 'rfq/distributed')).rows.map(bodyOf)
        .find((row) => asText(row.package_id) === packageId) ?? {}
      const window = asText(delivery.delivery_window)
      const shipTo = asText(delivery.ship_to)
      const items = [
        { key: '送货地址', value: shipTo || '承包商在这张 PO 上没有给（不是我没有权限看）' },
        { key: '交期窗口', value: window || '承包商在这张 PO 上没有给' },
        { key: '行项目与数量', value: linesTextOf(readRows(item.lines),
          (line) => `${line.ref_line}×${line.qty}`, { sep: ' · ' }) },
        { key: '币种', value: asText(rfq.currency) || '（本侧账本里没有这个包的投递登记）' },
        { key: '报价截止（本侧包事实）', value: asText(rfq.quote_by) || '（同上）' },
        { key: '包 / 版本', value: packageId ? `${packageId}${rfq.rev ? ` @rev${rfq.rev}` : ''}` : '—' },
      ]
      return { ok: true, kind: 'kv', items,
        real_facts: ['送货地址/交期窗口来自投递登记（发 PO 的人填的）', '币种/报价截止来自本侧 rfq/distributed'],
        note: '本侧只如实显示有事实的前提：地址与交期没有就写"没有"，要补就把它作为附件挂在这张 PO 上'
          + '（回签件/送货单），或用变更单（change/proposed）走人工门',
        next_action: (shipTo && window) ? '' : (asText(delivery.delivered_at)
          ? '要承包商补地址/交期：在本页「附件」面板里留言条，或用「变更单」提一条（双方都会看到）'
          : '') }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'po.acknowledge', title: '确认收到采购单（人签）', views: ['supplier'],
    group: '采购单', order: 41, permission: 'human-signature', object_kind: 'po',
    confirm: { required: true, message: '回签＝确认收到了这张采购单（不改变 PO 的行与价）：以你的署名确认？' },
    hint: '写自己账本 po/acknowledged + 承包商账本一条同名登记（双向留痕）；只有投递给本侧的 PO 才能回签',
    input: { fields: [
      { name: 'po_id', label: 'PO id', type: 'text', required: true, from_route: true,
        help: '从「发给我的采购单」表里取（po-…）；在 PO 对象页上会自动填当前这一条' },
      { name: 'signature', label: '署名（人签）', type: 'signature', required: true, help: 'human:<你的名字>' },
      { name: 'note', label: '备注（进回签登记，如交货安排）', type: 'text', max: 120 },
    ] },
    server: async (ctx, input) => {
      const cross = sideGuard(ctx, 'supplier', '确认收到采购单（人签）')
      if (cross) return cross
      const staged = host.stage('commitment-apply', { kind: 'commitment-apply', action: 'acknowledge',
        view: 'supplier', po_id: asText(input.po_id), note: asText(input.note).slice(0, 120),
        actor: asText(input.signature) })
      if (!staged.ok) return staged
      const run = host.runPython('src/domain/commitments/tools/commitment-apply.py',
        ['--step', 'acknowledge', '--request', staged.path, '--ui-shared', host.sharedDir,
          '--ledger-contractor', ledgerC(), '--ledger-supplier', ledgerS(), '--now', host.now()])
      const json = cleanJson(run)
      return { ok: run.ok && json.ok === true, code: json.refusal?.code ?? (json.ok ? 'acknowledged' : 'writer-failed'),
        reason: json.refusal?.reason ?? run.reason ?? '',
        next_action: json.refusal?.next_action
          ?? (json.ok === true ? '已回签：' + (json.po_id ?? 'po-…') + '（双方账本各一条 po/acknowledged，'
            + '回签人 = 你的会话身份）。回签件可以挂在这张 PO 的「附件」面板里给承包商'
            : (json.next_action ?? '看 result / stdout 定位唯一写者的输出（这条路才是失败）')),
        result: { po_id: json.po_id ?? null, acknowledged_by: json.acknowledged_by ?? null,
          applied: json.applied ?? [], ledger_added: json.ledger_added ?? 0,
          duplicates: json.duplicates ?? [] } }
    } }))

  /** **收到的那张 PO** 的导出/打印：行与价只用本侧事实（投递登记的 `lines` + `chain`），一列都不由界面拼。 */
  out.push(surface.action({ plugin_id: me, id: 'po.export-received', title: '导出 / 打印这张采购单（我收到的那份）',
    views: ['supplier'], group: '采购单', order: 42, icon: 'print', object_kind: 'po',
    hint: '内容 = 本侧账本 `po/distributed` 的行与追溯链；外壳只做序列化',
    input: { fields: [
      { name: 'po_id', label: 'PO id', type: 'text', required: true, from_route: true,
        help: '在 PO 对象页上会自动填当前这一条' },
      { name: 'format', label: '格式（csv = 表格；html = 可直接打印）', type: 'select', required: true,
        options: ['csv', 'html'], default: 'csv' },
    ] },
    server: (ctx, input) => {
      const cross = sideGuard(ctx, 'supplier', '导出这张采购单（我收到的那份）')
      if (cross) return cross
      const poId = asText(input.po_id)
      const item = poReceivedOf(poId)
      if (!item) {
        return { ok: false, code: 'po-not-delivered-to-you',
          reason: `本侧账本里没有这条 PO 的投递登记：${poId || '(空)'}`,
          next_action: '回「发给我的采购单」面板，点行内「打开 →」用真实存在的深链再导出' }
      }
      const ack = acksOf('supplier').get(poId)
      const poRow = typeRows(host.rows('supplier'), 'po/distributed')
        .find((row) => asText(bodyOf(row).po_id) === poId) ?? {}
      const lines = (item.lines ?? []).map((line, index) => ({ no: index + 1, ref_line: asText(line.ref_line),
        qty: line.qty, unit_price: line.unit_price,
        amount: Number(line.qty ?? 0) * Number(line.unit_price ?? 0), basis: asText(line.basis),
        trace: asText(line.trace), quote_id: asText(item.quote_id) }))
      return host.report({ format: asText(input.format) || 'csv', filename: `po-received-${poId}`,
        title: `采购单（PO）${poId} —— 我收到的那份`,
        subtitle: `供应商侧导出 · ${lines.length} 行 · 追溯模式 ${asText(item.trace_mode) || '—'}`,
        facts: [
          { key: 'PO', value: poId },
          { key: '承诺（award）', value: asText(item.award_id) },
          { key: '意向（intent）', value: asText(item.intent_id) },
          { key: '我的报价（quote）', value: asText(item.quote_id) },
          { key: '门的批准人（承包商侧，谁批的）', value: asText(item.approved_by) },
          { key: '签发时刻', value: asText(item.issued_at) },
          { key: '投递时刻（本侧收到的时刻）', value: asText(item.sent_at) },
          { key: '追溯链', value: asText(item.chain) },
          { key: '金额合计（元）', value: String(item.total_amount ?? '') },
          { key: '送货地址', value: asText(item.ship_to) || '（承包商未给）' },
          { key: '交期窗口', value: asText(item.delivery_window) || '（承包商未给）' },
          { key: '回签', value: ack ? `${asText(ack.acknowledged_by)} @ ${asText(ack.acknowledged_at)}` : '未回签' },
          { key: '账本行', value: poRow.seq === undefined ? '—'
            : `seq ${poRow.seq} · ${asText(poRow.entry_hash)}` },
        ],
        columns: [{ key: 'no', label: '#' }, { key: 'ref_line', label: '行项目' }, { key: 'qty', label: '数量', filter: 'number' },
          { key: 'unit_price', label: '单价（元）', filter: 'number' }, { key: 'amount', label: '行金额（元）', filter: 'number' },
          { key: 'basis', label: '单价基准（可追溯）' }, { key: 'trace', label: '追溯模式' },
          { key: 'quote_id', label: '来源报价' }],
        rows: lines,
        notes: ['行与价来自承包商签发的那张 PO（本侧账本 `po/distributed` 逐行可核，本侧不改行与价）。',
          `导出时刻：${host.now()}；本文件逐行可与本侧账本 po/distributed（seq ${poRow.seq ?? '—'}）核对，`
            + '合计 = 各行 数量×单价 之和。'],
        source: '供应商侧账本 po/distributed（po.export-received，domain/commitments）',
        ledger_refs: poRow.seq === undefined ? [] : [{ type: 'po/distributed', seq: poRow.seq,
          entry_hash: asText(poRow.entry_hash), chain: asText(item.chain) }] })
    } }))

  out.push(surface.report({ plugin_id: me, id: 'report.po-received', title: '我收到的采购单（CSV / 可打印 HTML）',
    views: ['supplier'], object_kind: 'po', formats: ['csv', 'html'], action: 'po.export-received', order: 42,
    // `columns` = 这份导出有哪些列（**元数据**：界面拿它做「列选择」个人偏好；内容仍由 action 生成）。
    // 与 `po.export-received` 的 spec.columns 逐字一致 —— 改了这里就要改那里（同一份台账）。
    columns: [{ key: 'no', label: '#' }, { key: 'ref_line', label: '行项目' }, { key: 'qty', label: '数量', filter: 'number' },
      { key: 'unit_price', label: '单价（元）', filter: 'number' }, { key: 'amount', label: '行金额（元）', filter: 'number' },
      { key: 'basis', label: '单价基准（可追溯）' }, { key: 'trace', label: '追溯模式' },
      { key: 'quote_id', label: '来源报价' }],
    hint: '逐行带单价基准与来源报价；表头给追溯链、投递时刻、送货地址/交期与回签状态' }))

  // ---- 工作台（首屏「我今天要做什么」）：待人工门队列 + 待确认意向 --------------------------------
  out.push(surface.panel({ plugin_id: me, id: 'home.gates', title: '待人工门与待确认（必须人签的动作）',
    view: 'home', order: 30, kind: 'list', not_data: true,
    data: (ctx) => {
      const cRows = host.rows('contractor')
      const last = new Map()
      for (const row of cRows) {
        if (!String(row?.type ?? '').startsWith('approval/')) continue
        const body = bodyOf(row)
        const id = asText(body.approval_id)
        // `approvers` 一起读回来：**这条门点的是谁的名**决定它算不算"要你处理"（P43）。
        if (id) last.set(id, { type: String(row.type), scope: body.scope, ref: body.ref,
          approvers: Array.isArray(body.approvers) ? body.approvers.map(asText).filter(Boolean) : [] })
      }
      const me = asText(ctx?.identity?.human)
      const items = []
      const others = []
      for (const [id, gate] of last) {
        // **已被决定的门不在这一栏**：granted / denied / aborted 三种都算决定过 —— 修前只跳
        // granted/aborted ⇒ 一条**被驳回**的门会一直以"还在等"挂在工作台上（与 §4.2 的"为什么作废答不出"
        // 同一类误判，一批治掉）。
        if (DECIDED_GATE_EVENTS.includes(gate.type)) continue
        // **点名我的才算"要你处理"**（P43，与 `system/approval#gate.todo` 同一判据）：
        // 写者判 `approver-not-named`；开单时没点名审批人的旧门按缺省放行（谁都能决定）。
        const named = !gate.approvers.length ? 'unassigned'
          : (me === '' ? 'unknown' : (gate.approvers.includes(me) ? 'mine' : 'others'))
        const mine = named === 'mine' || named === 'unassigned'
        const who = gate.approvers.map((name) => `@${name.replace(/^human:/, '')}`).join('、') || '（开单时没点名）'
        const tail = named === 'others'
          ? `点名的是 ${who} —— 你批这条会被写者拒（approver-not-named）⇒ 不算「需要你处理」`
          : (named === 'unknown'
            ? '未登录：判定不出这条点的是不是你的名（登录后它才可能算「需要你处理」）'
            : (named === 'unassigned' ? '开单时没点名审批人：这条谁都能决定' : `点名的是 ${who}`))
        const openable = gate.scope === 'change.approve' ? 'change.approve'
          : (gate.scope === 'award.commit' ? 'award.commit' : '')
        if (named === 'others') others.push(`${id}（${gate.scope}）`)
        items.push(sideScoped(ctx, 'contractor', { level: mine ? 'warn' : 'info',
          title: `承包商侧：人工门 ${id} 还在等（${gate.scope}）`,
          body: `对象 ${gate.ref} · ${tail}`,
          next_action: mine
            ? '打开这条门看卡在哪/等多久；门本身的人签动作在「授标与订单」里，界面不代签'
            : `去承包商道「审批队列」：那张表按「卡在谁（点名的审批人）」列筛出 ${who} 这一行`
              + '（表里有金额与越界标识）；要让给别人就点行内「升级 / 委托」（人签）',
          // 门自己也是一个**可协作的对象**（`/app/<view>/gate/<id>/`）：指派/关注/评论由外壳的协作面提供，
          // 这里只声明"门后面那个对象是哪一类"（scope→kind 是本插件的领域知识）。
          ref: { kind: 'gate', id, view: 'contractor', title: `审批门 ${id}` },
          // **跨面板去重的判据**：同一批门在 `system/approval#gate.todo` 里已经列过一次 ⇒ 键相同，
          // 外壳合并成一条（不重复占位）；`ref` 保留 ⇒ 合并后仍能从这条点进门的对象页。
          dedupe_key: `gate:${id}`,
          // **只有点了我名的门才给「去批准」按钮**：点的是别人的名 ⇒ 不给按钮（点了必被
          // `approver-not-named` 拒 —— 摆一个按下去必被拒的按钮就是让人误判"这活归我"）。
          action: mine ? openable : '',
          label: mine ? (gate.scope === 'change.approve' ? '去批准这条变更' : '去人签') : '' }))
      }
      // 「别人的」照实报数 + 给查看入口（不藏、也不冒充"要你处理"）。
      if (others.length) {
        items.push(sideScoped(ctx, 'contractor', { level: 'info',
          title: `承包商侧：另有 ${others.length} 条待批门点名的是别人（不归你处理）`,
          body: `${others.join('；')} —— 这些不算卡头「有 N 件需要你处理」`,
          next_action: '去承包商道「审批队列」看全部待批（含点名别人的）：按「卡在谁」列筛，'
            + '金额与越界标识都在那张表上' }))
      }
      const intents = typeRows(cRows, 'award/intent-proposed').length
      const awards = typeRows(cRows, 'award/committed').length
      const pos = typeRows(cRows, 'po/issued').length
      items.push(sideScoped(ctx, 'contractor', { level: awards ? 'ok' : 'info',
        title: `承包商侧：授标链：意向 ${intents} · 承诺 ${awards} · PO ${pos}`,
        body: '承诺要三样门：意向 + 供应商确认 + 人工批准',
        action: awards ? 'po.issue' : 'award.propose',
        label: awards ? '发 PO（人签）' : '先提授标意向' }))
      const supplierIntents = typeRows(host.rows('supplier'), 'award/confirmed').length
      if (supplierIntents === 0) {
        items.push(sideScoped(ctx, 'supplier', { level: 'info', title: '供应商侧：还没有确认过授标',
          body: '发给供应商的意向在供应商道「发给我的授标意向」里', next_action: '让对方确认（人签）' }))
      }
      // 采购单的**投递与回签**（本批 P8）：两侧各自读自己的账本，缺什么就说什么。
      const myPos = poDeliveries('contractor').map((item) => asText(item.po_id))
      const myAcks = acksOf('contractor')
      const unacked = myPos.filter((id) => !myAcks.has(id))
      if (myPos.length && unacked.length) {
        items.push(sideScoped(ctx, 'supplier', { level: 'warn',
          title: `供应商侧：还有 ${unacked.length} 张采购单没等到回签（承包商已投递）`,
          body: `已投递：${myPos.join(' / ')} · 待回签：${unacked.join(' / ')}`,
          next_action: '对方在供应商道「发给我的采购单」里人签「确认收到采购单」；'
            + '回签件（签章 PDF）由对方挂在这张 PO 的附件面板里' }))
      }
      const supplierPos = poDeliveries('supplier')
      const supplierAcks = acksOf('supplier')
      const supplierUnacked = supplierPos.filter((item) => !supplierAcks.has(asText(item.po_id)))
      if (supplierUnacked.length) {
        items.push(sideScoped(ctx, 'supplier', { level: 'warn',
          title: `供应商侧：${supplierUnacked.length} 张采购单还没回签`,
          body: `收到：${supplierUnacked.map((item) => asText(item.po_id)).join(' / ')}`,
          next_action: '在供应商道「发给我的采购单」里打开这张 PO，人签「确认收到采购单」'
            + '（署名 = 你的会话身份），回签件挂在同一页的「附件」面板',
          action: 'po.acknowledge', preset: { po_id: asText(supplierUnacked[0].po_id) },
          label: '去回签这张 PO' }))
      }
      return { ok: true, kind: 'list', items }
    } }))

  out.push(surface.shortcut({ plugin_id: me, id: 'shortcut.award-propose', keys: 'a', action: 'award.propose',
    title: '提出授标意向', order: 40 }))

  // ------------------------------------------------------------------ 审批门（对象类 `gate`）
  // 「门」也是可以被协作的对象：做成**对象页**（`/app/<view>/gate/<approval_id>/`）后，它自动获得外壳的
  // 协作面（指派/转交、关注、评论与 @同事、我的/我指派的）——**门本身的事实仍由本插件给**（不重述、不发明）。
  // `scope → 对象类` 是本插件的领域知识，所以由本插件声明（外壳与协作面都不认识任何对象类）。
  const GATE_SCOPE_KIND = { 'change.approve': 'change', 'award.commit': 'award', 'po.issue': 'po',
    'quote.submit': 'quote' }
  for (const view of ['contractor', 'supplier']) {
    out.push(surface.panel({ plugin_id: me, id: `gate.object-${view}`, title: '审批门（对象页：谁在等、卡在哪）',
      view, order: 39, kind: 'kv', object_kind: 'gate',
      hint: '门后面那个对象可点；指派/关注/评论在「协作」面板里（同侧可见，不进账本）',
      data: (ctx) => {
        const id = asText(ctx?.route?.id)
        const rows = host.rows(view).filter((row) => String(row?.type ?? '').startsWith('approval/')
          && asText(bodyOf(row).approval_id) === id)
        if (!rows.length) {
          return { ok: true, kind: 'kv', items: [], object: { found: false, reason: 'gate-not-found',
            next_action: `这一侧（${view}）的账本里没有审批门 ${id}：门 id 从「审批与变更」页或工作台的`
              + '待人工门那一行点「打开 →」拿（不要手抄）' } }
        }
        const last = rows[rows.length - 1]
        const body = bodyOf(last)
        const status = String(last.type).replace('approval/', '')
        const scope = asText(body.scope)
        const target = asText(body.ref)
        const kind = GATE_SCOPE_KIND[scope] ?? ''
        // **这扇门的一屏三问**（主管/审批人）：「谁提的 / 谁批的·什么时候 / 为什么」。
        // 修前：请求人读的是**最后一行**的 `requested_by`（账本里根本没有这个键）⇒ 永远显示「（未记）」，
        // 而真正的请求人就在**第一行**的 `actor` 里；「批准人」只认 `approval/granted`（驳回/终止的门
        // 那一格空着），决定时刻与**意见正文**压根没摆出来。
        const first = rows[0]
        const firstBody = bodyOf(first)
        const requestedBy = asText(firstBody.requested_by) || asText(first.actor)
        const decided = status === 'granted' || status === 'denied' || status === 'aborted'
        const decision = decided ? last : null
        const decider = decision ? (asText(body.decided_by) || asText(body.aborted_by) || asText(decision.actor)) : ''
        const comment = asText(body.comment)
        const requester = requestedBy || '（账本这一行的 actor 也没记）'
        const facts = [
          { key: '门 id', value: id, code: true },
          { key: '范围（scope）', value: scope || '（未登记范围）', code: true },
          { key: '状态', value: status === 'requested' ? '还在等（requested）'
            : (status === 'granted' ? '已批准（granted）'
              : (status === 'denied' ? '已驳回（denied）' : `${status}`)) },
          { key: '门后面那个对象', value: kind ? `${kind} ${target}` : `（未登记类别）${target}` },
          { key: '请求人', value: requester, code: true },
          { key: '请求时刻', value: asText(firstBody.requested_at) || String(first.ts ?? '') },
          { key: '点名的审批人', value: (Array.isArray(body.approvers) ? body.approvers.join(' ') : '')
            || asText(body.escalate_to) || '（开单时没点名）' },
          { key: '谁批的 / 什么时候', value: decision
            ? `${decider || '（账本没记决定人）'} @ ${String(decision.ts ?? '')}（${status}）`
            : '（还没决定——门还在队列里等）' },
          { key: '为什么（意见正文）', value: decision
            ? (comment || (status === 'aborted'
              ? '（终止：账本只留理由哈希，正文在 0600 待办件里）' : '（没留意见正文）'))
            : '—' },
        ]
        return { ok: true, kind: 'kv', items: facts,
          object: { title: `审批门 ${id}`, subtitle: `${scope || '（范围未登记）'} · ${decided
            ? '已决定' : '还在等'}（门的事实来自本侧账本；本页只多给一条协作面）`, found: true, facts,
            links: kind && target ? [{ kind, id: target, title: `门后面那个对象（${kind} ${target}）` }] : [],
            next_action: decided ? '这条门已经决定了：要看它挡住了哪一步，点上面的对象链接'
              : '这条门还在等：在本侧「授标与订单」用对应动作人签（界面不代签）；'
                + '办不完就在协作面板里「指派 / 转交」给同侧同事' } }
      } }))
  }

  // ------------------------------------------------------------------ 通知与状态（**待人工门队列**）
  out.push(surface.notificationSource({ plugin_id: me, id: 'notify.gates', title: '待人工门（授标链）',
    order: 30, poll: () => {
      const rows = host.rows('contractor')
      const last = new Map()
      for (const row of rows) {
        if (!String(row?.type ?? '').startsWith('approval/')) continue
        const body = bodyOf(row)
        const id = asText(body.approval_id)
        if (id) last.set(id, { type: row.type, scope: body.scope, ref: body.ref })
      }
      const items = []
      for (const [id, item] of last) {
        if (item.type === 'approval/granted' || item.type === 'approval/aborted') continue
        items.push({ id: `gate:${id}`, level: 'warn', at: '',
          ref: { kind: 'gate', id, view: 'contractor', title: `审批门 ${id}` },
          title: `人工门 ${id} 还在等（${item.scope}）`,
          body: `对象 ${item.ref} —— 承诺类动作没有人工批准就落不了账`,
          next_action: '点「打开 审批门 …」进这条门的对象页（可以指派/评论）；'
            + '人签在「授标与订单」里用对应动作做' })
      }
      // 供应商侧「待确认中标」：读**授标意向信封**（与 award.inbox 面板同一来源；意向不在供应商账本里，
      // 只通过信封投递 —— P3 走查实测：原来这里读的是供应商账本，导致供应商的通知中心里看不到"待你确认"）。
      const realm = realmOf('supplier')
      const envelope = host.readJson(intentFile())
      const myQuotes = new Set(host.rows('supplier').filter((row) => String(row?.type ?? '') === 'quote/submitted')
        .map((row) => asText(bodyOf(row).quote_id)))
      const confirmedIds = new Set(host.rows('supplier').filter((row) => String(row?.type ?? '') === 'award/confirmed')
        .map((row) => asText(bodyOf(row).intent_id)))
      for (const item of (Array.isArray(envelope) ? envelope : [])) {
        const intentId = asText(item.intent_id)
        if (intentId === '' || confirmedIds.has(intentId)) continue
        const delivered = (item.delivered_to ?? []).map(String)
        // 可见性：**引用的报价是我提交过的那份**，或信封投递名单含我的 realm（与 clarify 侧同一口径；
        // 只用 realm 匹配会在"信封 realm 与账本 realm 不一致"时漏掉应看到的意向）
        const mineByQuote = asText(item.quote_id) !== '' && myQuotes.has(asText(item.quote_id))
        const mineByRealm = delivered.length > 0 && realm !== '' && delivered.includes(realm)
        if (!mineByQuote && !mineByRealm) continue
        items.push({ id: `intent:${intentId}`, level: 'warn', at: '',
          title: `承包商提出了授标意向 ${intentId}`,
          body: `包 ${asText(item.package_id)} · ${(item.lines ?? []).length} 条目 · 等你确认（人签）`,
          next_action: '点下面的按钮确认（署名 = 你的会话身份）',
          action: 'award.confirm', preset: { intent_id: intentId },
          ref: asText(item.quote_id) === '' ? null : { view: 'supplier', kind: 'quote',
            id: asText(item.quote_id), title: `报价 ${asText(item.quote_id)}` } })
      }
      return items
    } }))

  out.push(surface.statusItem({ plugin_id: me, id: 'status.award', title: '授标', order: 40, read: () => {
    const rows = host.rows('contractor')
    const awards = typeRows(rows, 'award/committed').length
    const pos = typeRows(rows, 'po/issued').length
    const intents = typeRows(rows, 'award/intent-proposed').length
    return { text: `意向 ${intents} · 承诺 ${awards} · PO ${pos}`, level: awards ? 'ok' : 'warn',
      next_action: awards ? '' : '授标承诺要人签，且要有供应商确认与人工批准' }
  } }))

  // ------------------------------------------------------------------ PO 页与追溯链（DEF-027）
  const changeTool = 'src/domain/commitments/tools/change-apply.py'
  const TRACE_KEY = 'po-trace'
  const rowByType = (rows, type) => rows.filter((row) => String(row?.type ?? '') === type).map((row) => bodyOf(row))
  const posOf = (rows) => rowByType(rows, 'po/issued')
  const awardsOf = (rows) => rowByType(rows, 'award/committed')
  const intentsOf = (rows) => rowByType(rows, 'award/intent-proposed')

  /**
   * PO 的追溯链（**唯一一处**计算：行内动作与对象页 `/app/<view>/po/<id>/` 共用同一份，避免两处漂移）。
   * 返回 `null` = 本侧账本里没有这条 PO（调用方据此渲染未命中态，不编内容）。
   */
  const traceOf = (poId, view = 'contractor') => {
    const rows = host.rows(view)
    const po = posOf(rows).find((item) => asText(item.po_id) === asText(poId))
    if (!po) return null
    const award = awardsOf(rows).find((item) => asText(item.award_id) === asText(po.award_id)) ?? {}
    const intent = intentsOf(rows).find((item) => asText(item.intent_id) === asText(po.intent_id)) ?? {}
    const base = `${host.prefix}/app/${view}/`
    // **人工门那一段（谁批的 / 什么时候 / 为什么）**：门的事实就在本侧账本里（`approval/*` 行，`approval_id`
    // 与 PO 的 `approval_id` 同值）。主管/审批人从一条 PO 回溯时，这三问必须**一屏可答** ——
    // 修前只给了"批准人 + 人工门 id"两个裸值（而且门 id 不是链接，只能手敲 URL 去门对象页）；
    // 现在把门的结论、决定时刻与**意见正文**一并摊出来，并给门对象页的可点入口。
    const gateRows = rows.filter((row) => String(row?.type ?? '').startsWith('approval/')
      && asText(bodyOf(row).approval_id) === asText(po.approval_id))
    const gateFirst = gateRows[0] ?? null
    const DECIDED = ['approval/granted', 'approval/denied', 'approval/aborted']
    const gateDecided = [...gateRows].reverse().find((row) => DECIDED.includes(String(row?.type ?? ''))) ?? null
    const gateBody = bodyOf(gateDecided ?? gateFirst ?? {})
    const gateStatus = gateDecided ? String(gateDecided.type).replace('approval/', '') : (gateRows.length ? 'requested' : '')
    const gateWho = asText(gateBody.decided_by) || asText(gateBody.aborted_by)
      || (gateDecided ? asText(gateDecided.actor) : '')
    const gateWhy = asText(gateBody.comment)
    // 终止（abort/deny）在账本里只有 `reason_sha256`：**照实说**「正文不在账本里」，不编一句"为什么"
    const gateWhyLabel = gateWhy || (gateDecided
      ? (gateStatus === 'aborted'
        ? '（这条门被终止：账本里只有理由哈希，正文留在 0600 待办件里）'
        : '（这条门没留意见正文）')
      : '（还没决定）')
    const gate = { approval_id: asText(po.approval_id), status: gateStatus, decided_by: gateWho,
      decided_at: gateDecided ? String(gateDecided.ts ?? '') : '',
      comment: gateWhy, comment_label: gateWhyLabel,
      requested_by: gateFirst ? (asText(bodyOf(gateFirst).requested_by) || asText(gateFirst.actor)) : '',
      requested_at: gateFirst ? (asText(bodyOf(gateFirst).requested_at) || String(gateFirst.ts ?? '')) : '' }
    // **谁批的 vs 谁签的**（P48）：署名取**这条 PO 的账本行**的 `actor`，批准人取这一段的门的
    // `decided_by` —— 两个都从账本读，界面不推断；两者相同（旧行）就如实标「自签自批」。
    const poSigner = asText((rows.find((row) => String(row?.type ?? '') === 'po/issued'
      && asText(bodyOf(row).po_id) === asText(poId)) ?? {}).actor)
    const signoff = {
      signer: poSigner, approver: gateWho,
      differs: Boolean(poSigner) && Boolean(gateWho) && poSigner !== gateWho,
      label: !gateWho
        ? `这条 PO 的署名是 ${poSigner || '（未记录）'}；门还没决定（谁批的还答不出）`
        : (poSigner && poSigner !== gateWho
          ? `**谁批的（${gateWho}）≠ 谁签的（${poSigner}）**`
          : `**谁批的 == 谁签的**（${gateWho || '（未记录）'}：自签自批，本批之前写入的旧行是这个形状）`) }
    return {
      po_id: po.po_id, chain: po.chain, trace_mode: po.trace_mode, total_amount: po.total_amount,
      approved_by: po.approved_by, issued_at: po.issued_at, approval_id: po.approval_id,
      award_id: po.award_id, intent_id: po.intent_id, quote_id: po.quote_id, gate, signoff,
      segments: [
        { kind: 'po', id: po.po_id, label: `PO ${po.po_id}`, where: '承包商道 › 授标与订单 › 采购单',
          fact: `${(po.lines ?? []).length} 行 · 金额 ${po.total_amount} 元 · ${po.issued_at}`,
          href: `${base}po/${encodeURIComponent(asText(po.po_id))}/` },
        { kind: 'award', id: po.award_id, label: `承诺 ${po.award_id}`, where: '承包商道 › 授标与订单 › 授标链',
          fact: `批准人 ${po.approved_by} · 人工门 ${po.approval_id}`,
          href: `${base}award/${encodeURIComponent(asText(po.award_id))}/` },
        { kind: 'intent', id: po.intent_id, label: `意向 ${po.intent_id}`, where: '承包商道 › 授标与订单 › 授标链',
          fact: `中标行 ${((award.lines ?? intent.lines ?? []).length)} 条`,
          href: `${base}award/${encodeURIComponent(asText(po.intent_id))}/` },
        { kind: 'quote', id: po.quote_id, label: `报价 ${po.quote_id}`, where: '承包商道 › 报价收件箱 / 比价',
          fact: `${(intent.lines ?? []).length} 行快照`,
          href: `${base}quote/${encodeURIComponent(asText(po.quote_id))}/` },
        // **第五段：人工门**（决定 + 谁批的 / 什么时候 / 为什么）—— 点它进门的对象页。
        ...(gateRows.length ? [{ kind: 'gate', id: gate.approval_id, label: `人工门 ${gate.approval_id}`,
          where: '承包商道 › 审批队列 › 已决定的门',
          fact: `${gate.status || '还在等'} · 谁批的 ${gate.decided_by || '（还没批）'}`
            + ` · 什么时候 ${gate.decided_at || '（还没决定）'} · 为什么 ${gate.comment_label}`
            + ` · ${signoff.label}`,
          href: `${base}gate/${encodeURIComponent(gate.approval_id)}/` }] : []),
      ],
      lines: readRows(po.lines).rows.map((line) => ({ ref_line: line?.ref_line, qty: line?.qty,
        unit_price: line?.unit_price, basis: line?.basis, trace: line?.trace,
        quote_id: po.quote_id, href: `${base}quote/${encodeURIComponent(asText(po.quote_id))}/` })),
      note: '链路五段都能点（PO / 承诺 / 意向 / 报价 / 人工门——每段给出所在页面与事实摘要）；'
        + '「人工门」那一段直接答「谁批的 / 什么时候 / 为什么」（意见正文逐字来自账本 comment），'
        + '点它进门的对象页；行内 `basis` 指向中标报价条目，点报价段进「报价收件箱/比价」页核对',
    }
  }

  out.push(surface.panel({ plugin_id: me, id: 'po.list', title: '采购单（PO）：逐行可追溯',
    view: 'contractor', order: 50, kind: 'table', actions: ['po.trace'],
    data: () => {
      const rows = host.rows('contractor')
      const pos = posOf(rows)
      // 投递与回签都读**本侧账本的事实行**（`po/distributed` 是我自己写的分发登记；`po/acknowledged`
      // 是对方回签后由唯一写者写到本侧的登记）——没有就是没有，不假装已送/已回签。
      const deliveredIds = new Set(poDeliveries('contractor').map((item) => asText(item.po_id)))
      const acks = acksOf('contractor')
      if (!pos.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-po',
          next_action: 'PO 只能由承诺派生：先在「授标链」里提意向 → 对方确认 → 人签承诺 → 人签发 PO',
          columns: [{ key: 'po_id', label: 'PO' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        columns: [
          { key: 'po_id', label: 'PO', type: 'code' }, { key: 'award_id', label: '承诺', type: 'code' },
          { key: 'intent_id', label: '意向', type: 'code' }, { key: 'quote_id', label: '报价', type: 'code' },
          { key: 'line_count', label: '行数', filter: 'number' }, { key: 'trace_mode', label: '追溯模式', filter: 'enum' },
          { key: 'total_amount', label: '金额（元）', filter: 'number' },
          { key: 'approved_by', label: '门的批准人（≠ 署名者）', type: 'code' },
          { key: 'chain', label: '链路' }, { key: 'issued_at', label: '签发时刻', filter: 'date' },
          { key: 'delivered', label: '投递' }, { key: 'ack', label: '对方回签' },
        ],
        rows: pos.map((po) => ({ id: String(po.po_id), po_id: po.po_id, award_id: po.award_id,
          intent_id: po.intent_id, quote_id: po.quote_id, line_count: (po.lines ?? []).length,
          trace_mode: po.trace_mode, total_amount: po.total_amount, approved_by: po.approved_by,
          chain: po.chain, issued_at: po.issued_at,
          delivered: deliveredIds.has(asText(po.po_id)) ? '已投递' : '未投递',
          ack: acks.has(asText(po.po_id))
            ? `${asText(acks.get(asText(po.po_id)).acknowledged_by)} @ `
              + `${asText(acks.get(asText(po.po_id)).acknowledged_at)}` : '待回签',
          ref: { kind: 'po', id: String(po.po_id), title: `PO ${po.po_id}` } })),
        row_actions: ['po.trace'], counts: { po: pos.length, delivered: deliveredIds.size, acked: acks.size },
        note: '行内「打开 →」是这条 PO 的对象深链（可复制分享、刷新不丢）；'
          + '「追溯这条 PO」把链路摊到下方，两者同一份计算；'
          + '「投递/对方回签」两列读的是 `po/distributed` 与 `po/acknowledged` 事实（没投递就是"未投递"——不假装已送）'
      }
    } }))

  /**
   * **投递与已读回执（采购单）**（本批新增）：一屏回答「PO 发出去了吗 / 对方看了吗 / 回签了吗」。
   *
   *   · 「投递」半边是**账本事实**（`po/distributed`，本侧账本的投递登记：投给哪个 realm、何时投的）；
   *   · 「已读」半边是**协作面痕迹**（`<ui_shared>/receipts/deliveries.json`，0600，**不进账本**）——
   *     由**收件方打开这张 PO** 时按会话身份记下（记录方：本文件的 `po.inbox` / `po.object-received`）；
   *   · 「回签」半边仍是账本事实（`po/acknowledged`）—— 三样摆在一起，谁也不需要去群里追问。
   *   · **越侧拿不到**：这一块只给**承包商侧**（签发方）看；供应商身份（或未登录）读它被明确拒。
   */
  out.push(surface.panel({ plugin_id: me, id: 'po.receipts', title: '投递与已读回执（对方收到了吗 · 看了吗）',
    view: 'contractor', order: 52, kind: 'table',
    hint: '「投递 / 回签」= 账本事实（po/distributed / po/acknowledged）；「已读」= 协作面痕迹'
      + '（对方打开这张 PO 时记的「谁 / 何时 / 看过几次」，0600 文件，不进账本）—— 回执里没有对方的报价、'
      + '成本或任何私域字段。已读 ≠ 回签：回签是对方的人签（有义务语义），已读只是「他打开过这一页」。'
      + '这一块只对承包商侧（签发方）显示。',
    data: (ctx) => {
      const side = asText(ctx?.identity?.side)
      if (side !== 'contractor') {
        return { ok: true, kind: 'table', degraded: true,
          reason: side === '' ? 'identity-required' : 'side-mismatch',
          columns: [{ key: 'po_id', label: 'PO' }], rows: [],
          next_action: side === ''
            ? '先登录承包商侧身份：投递与已读回执是签发方（发送侧）的视图'
            : '这一块只给承包商侧（签发方）看：它是「对方看过你签发的 PO」的痕迹，供应商侧身份读不到' }
      }
      const rows = host.rows('contractor')
      const issued = new Map(posOf(rows).map((po) => [asText(po.po_id), po]))
      const delivered = new Map()
      for (const body of poDeliveries('contractor')) {
        const id = asText(body.po_id)
        if (id === '' || delivered.has(id)) continue
        delivered.set(id, body)
      }
      const acks = acksOf('contractor')
      const ids = [...new Set([...issued.keys(), ...delivered.keys()])].sort()
      if (!ids.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-po',
          columns: [{ key: 'po_id', label: 'PO' }], rows: [],
          next_action: 'PO 只能由承诺派生：先在「授标链」里提意向 → 对方确认 → 人签承诺 → 人签发 PO'
            + '（发 PO 即投递，投递之后这里才会有回执行）' }
      }
      const reads = receipts.forObjects('po', ids)
      const table = ids.map((id) => {
        const did = delivered.get(id)
        const po = issued.get(id)
        const ack = acks.get(id)
        const readers = reads.readers.get(id) ?? []
        const first = readers.length ? readers[0] : null
        const last = readers.reduce((acc, item) => (!acc || item.last_at > acc.last_at ? item : acc), null)
        const status = !did ? '未投递（账本里没有 po/distributed）'
          : (readers.length ? `已读（${readers.length} 人看过）` : '已投递 · 还没人看过')
        return { id, po_id: id,
          award_id: asText(did?.award_id) || asText(po?.award_id),
          recipients: did ? (did.recipients ?? []).map(String).sort().join(' / ') : '',
          delivered_at: did ? (asText(did.sent_at) || asText(did.delivered_at)) : '',
          readers: readers.map((item) => `${humanName(item.human)}${item.side ? `（${item.side}侧）` : ''}`)
            .join(' · '),
          first_seen: first ? first.first_at : '',
          last_seen: last ? last.last_at : '',
          seen_count: readers.reduce((sum, item) => sum + item.count, 0),
          ack: ack ? `${humanName(ack.acknowledged_by)} @ ${asText(ack.acknowledged_at)}` : '还没有',
          status,
          ref: { kind: 'po', id, title: `采购单 ${id}` } }
      })
      const broken = reads.broken
      const problems = reads.problems ?? []
      return { ok: true, kind: 'table',
        columns: [
          { key: 'po_id', label: 'PO', type: 'code', pin: 'left' },
          { key: 'award_id', label: '承诺', type: 'code' },
          { key: 'recipients', label: '投给谁（账本）', type: 'code' },
          { key: 'delivered_at', label: '投递时刻（账本）', filter: 'date' },
          { key: 'readers', label: '看过的人（回执）' },
          { key: 'first_seen', label: '首次看过', filter: 'date' },
          { key: 'last_seen', label: '最近看过', filter: 'date' },
          { key: 'seen_count', label: '看过次数', filter: 'number' },
          { key: 'ack', label: '回签（账本）' },
          { key: 'status', label: '状态' },
        ],
        rows: table,
        row_actions: ['po.trace'],
        counts: { po: table.length, delivered: delivered.size,
          read: table.filter((row) => asText(row.readers) !== '').length,
          acked: table.filter((row) => asText(row.ack) !== '还没有').length },
        note: '「投给谁 / 何时投的」逐行来自本侧账本的 `po/distributed`；「回签」来自 `po/acknowledged`'
          + '（两者都是账本事实，可逐行核）；「看过的人 / 首次 / 最近 / 次数」来自回执文件'
          + `（0600，${reads.file}，不进账本 —— 读取痕迹不是合同事实）。`
          + '看过 ≠ 回签：回签是对方的人签（有义务语义），已读只是「他打开过这一页」。'
          + (broken ? ` ⚠ 回执文件读不出来（${broken.code}）：${broken.reason} —— 不是"还没有人看过"，${broken.how_to_fix}` : '')
          + (problems.length ? ` ⚠ 有 ${problems.length} 处坏形状已跳过（原样留在文件里）` : '') }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'po.trace', title: '追溯这条 PO（五段可点：PO→承诺→意向→报价→人工门）',
    views: ['contractor'], group: '授标', order: 40, inline: true, object_kind: 'po',
    hint: '只读：把 po → 承诺 → 意向 → 报价 的链路与逐行 basis 摊开（账本零新增）',
    input: { fields: [
      { name: 'po_id', label: 'PO id', type: 'text', required: true, from_route: true,
        help: '从 PO 列表行里取（po-…）；在 PO 对象页上会自动填当前这一条' },
    ] },
    server: async (ctx, input) => {
      const poId = asText(input.po_id) || asText(ctx.route?.id)
      const trace = traceOf(poId, 'contractor')
      if (!trace) {
        return { ok: false, code: 'po-not-found', reason: `本侧账本里没有 PO ${poId}`,
          next_action: `从 PO 列表列出的真 po_id 里选一条，或直接打开对象深链 ${host.prefix}/app/contractor/po/<id>/` }
      }
      host.note.set(me, TRACE_KEY, trace)
      return { ok: true, code: 'traced',
        next_action: '链路已摊到下方「追溯链」面板：五段（含人工门：谁批的/什么时候/为什么）与逐行 basis 都能点'
          + `（也可以直接把 ${host.prefix}/app/contractor/po/${asText(poId)}/ 发给同事）`,
        result: trace }
    } }))

  // ---- **对象页**：`/app/contractor/po/<po-id>/`（刷新不丢、可复制分享；不再依赖上面那条内存便签） ----
  out.push(surface.panel({ plugin_id: me, id: 'po.object', title: 'PO 追溯（对象页）', view: 'contractor',
    order: 50, kind: 'kv', object_kind: 'po',
    data: (ctx) => {
      const poId = asText(ctx.route?.id)
      const trace = traceOf(poId, 'contractor')
      if (!trace) {
        return { ok: true, kind: 'kv', object: { found: false, title: `PO ${poId}`,
          reason: 'po-not-in-my-view',
          next_action: '这条 PO 不在承包商侧账本的投影里：回「采购单（PO）」列表，'
            + '点行内「打开 →」用真实存在的深链' }, items: [] }
      }
      return { ok: true, kind: 'kv',
        object: { title: `PO ${trace.po_id}`, subtitle: `${trace.chain} · 追溯模式 ${trace.trace_mode}`
          + ` · 签发 ${trace.issued_at}`, found: true,
          facts: [
            { key: '金额（元）', value: String(trace.total_amount) },
            { key: '行数', value: String((trace.lines ?? []).length) },
            // **署名与批准人是两件事**（P48）：署名取这条 PO 的账本行 `actor`，批准人取门的 `decided_by`
            { key: '署名（人签，账本行 actor）', value: trace.signoff?.signer || '（未记录）', code: true },
            { key: '门的批准人（人门）', value: trace.approved_by, code: true },
            { key: '人工门', value: trace.approval_id, code: true },
            // **一屏内回答三问**（主管/审批人回溯）：谁批的、什么时候、为什么（意见逐字来自账本）
            { key: '人工门（谁批 / 何时 / 为什么）', value: `${trace.gate?.status || '还在等'} · `
              + `谁批的 ${trace.gate?.decided_by || '（还没批）'} · 什么时候 ${trace.gate?.decided_at || '（还没决定）'}`
              + ` · 为什么 ${trace.gate?.comment_label || '（还没决定）'}` },
            // **谁批的 vs 谁签的**（P48）：产品主张「承诺/发 PO 必须由别人批过」——这一行就是那句主张的读数，
            // 两个值都从账本取（署名 = 这条 PO 的账本行 actor、批准人 = 门的 decided_by），界面不推断。
            { key: '谁批的 vs 谁签的（人门成立吗）', value: trace.signoff?.label || '（读不出来）' },
            { key: '报价', value: trace.quote_id, code: true },
          ],
          links: (trace.segments ?? []).filter((seg) => seg.kind !== 'po'),
          // **分享**（插件声明"对方能不能看"；机制据此写分享弹层与邮件正文）
          share: { visibility: 'both', other_side_view: 'supplier',
            requirements: ['对方要用供应商侧的身份登录（收件方）；这张 PO 只有投递到它那一侧'
              + '才会出现在它的视图里（发 PO 即投递）'],
            note: '这是承包商侧签发的原件；对方那一侧看到的是同一次投递的收件登记（逐行同源）。' } },
        items: [
          { key: '链路', value: trace.chain, code: true },
          { key: '追溯模式', value: `${trace.trace_mode}（full=逐行可回溯；ref-only=只给引用）` },
          { key: '逐行', value: `${(trace.lines ?? []).length} 行（见下方明细表）` },
          { key: '投递', value: (() => {
            const did = poDeliveries('contractor').find((row) => asText(row.po_id) === asText(trace.po_id))
            if (!did) return '未投递（这张 PO 还没有投递给对方的账本登记）'
            return `已投递给 ${(did.recipients ?? []).join(' / ')} @ ${asText(did.sent_at)}`
              + (did.delivery_window ? ` · 交期窗口 ${asText(did.delivery_window)}` : '')
              + (did.ship_to ? ` · 送货地址 ${asText(did.ship_to)}` : '')
          })() },
          { key: '对方回签', value: (() => {
            const ack = acksOf('contractor').get(asText(trace.po_id))
            return ack ? `已回签：${asText(ack.acknowledged_by)} @ ${asText(ack.acknowledged_at)}`
              + (asText(ack.note) ? ` · 备注 ${asText(ack.note)}` : '') : '还没有（对方在供应商道「确认收到采购单」人签）'
          })() },
          { key: '事实时刻', value: trace.issued_at },
        ],
        note: '这一页只看账本事实：PO 由承诺派生、逐行引用中标条目，界面上不提供任何改价入口；'
          + '投递与回签也各自是账本事实（po/distributed / po/acknowledged）' }
    } }))

  out.push(surface.panel({ plugin_id: me, id: 'po.object-lines', title: 'PO 逐行明细（单价基准可点）',
    view: 'contractor', order: 51, kind: 'table', object_kind: 'po',
    data: (ctx) => {
      const trace = traceOf(asText(ctx.route?.id), 'contractor')
      if (!trace) {
        return { ok: true, kind: 'table', degraded: true, reason: 'po-not-in-my-view',
          columns: [{ key: 'ref_line', label: 'PO 行' }], rows: [] }
      }
      // 追溯链里的行数组走唯一入口（坏行逐条计数 ⇒ `counts.dropped`）
      const lines = readRows(trace.lines)
      return { ok: true, kind: 'table',
        columns: [{ key: 'ref_line', label: 'PO 行', type: 'code' }, { key: 'qty', label: '量', filter: 'number' },
          { key: 'unit_price', label: '单价（元）' }, { key: 'basis', label: '单价基准（中标报价条目）', type: 'code' },
          { key: 'trace', label: '追溯模式' }],
        rows: lines.rows.map((line) => ({ id: String(line?.ref_line), ...line })),
        counts: { lines: lines.rows.length, dropped: lines.dropped },
        note: '每一行的 `basis` 指向中标报价里的条目；缺基准的行不会出现在 PO 里（`po-line-not-derived` 会拒绝签发）' }
    } }))

  out.push(surface.panel({ plugin_id: me, id: 'po.detail', title: '追溯链（PO → 承诺 → 意向 → 报价，全链可点）',
    view: 'contractor', order: 52, kind: 'html',
    data: () => {
      const trace = host.note.get(me, TRACE_KEY, null)
      const rows = host.rows('contractor')
      const pos = posOf(rows)
      if (!trace) {
        return { ok: true, kind: 'html', html: `<p class="q-hint">还没有选中的 PO。`
          + (pos.length ? '在上面的 PO 列表里点某一行「追溯这条 PO」或「打开 →」（对象页会显示同一条链路）。'
            : '本侧账本里还没有 PO：PO 只能由承诺派生（提意向 → 对方确认 → 人签承诺 → 人签发 PO）。')
          + `</p><p class="q-hint">深链：<code>${host.prefix}/app/contractor/po/&lt;po-id&gt;/</code>`
          + '（从列表行「打开 →」拿真 id）</p>' }
      }
      const seg = (item) => `<li><a href="${item.href}" title="去 ${item.where}">${item.label}</a>`
        + ` —— <code>${item.id}</code><br><small>${item.where} · ${item.fact}</small></li>`
      const lines = readRows(trace.lines).rows.map((line) => `<tr><td><code>${escHtml(line?.ref_line)}</code></td>`
        + `<td>${escHtml(line?.qty)}</td><td>${escHtml(line?.unit_price)}</td>`
        + `<td><a href="${escHtml(line?.href)}" title="去报价收件箱/比价核对这条基准"><code>${escHtml(line?.basis)}</code></a></td>`
        + `<td>${escHtml(line?.trace)}</td></tr>`).join('')
      const gateSeg = (trace.segments ?? []).find((item) => item.kind === 'gate') ?? null
      const gateLine = `人工门：${trace.gate?.status || '还在等'} · 谁批的 `
        + `${trace.gate?.decided_by || '（还没批）'} · 什么时候 ${trace.gate?.decided_at || '（还没决定）'}`
        + ` · 为什么 ${trace.gate?.comment_label || '（还没决定）'}`
      return { ok: true, kind: 'html', html: `<p class="q-hint"><b>${trace.chain}</b> · 追溯模式 `
        + `<code>${trace.trace_mode}</code> · 金额 ${trace.total_amount} 元 · 签发 ${trace.issued_at}`
        + ` · 人工门 ${gateSeg ? `<a href="${escHtml(gateSeg.href)}" title="进门的对象页（结论 / 谁批的 / 意见）"><code>${escHtml(trace.approval_id)}</code></a>` : `<code>${escHtml(trace.approval_id)}</code>`}（门的批准人 ${escHtml(trace.approved_by)}）</p>`
        + `<p class="q-hint">${escHtml(gateLine)}</p>`
        + `<ol class="q-list">${(trace.segments ?? []).map(seg).join('')}</ol>`
        + `<div class="q-scroll"><table class="q-table"><thead><tr><th>PO 行</th><th>量</th><th>单价</th>`
        + `<th>单价基准（可点）</th><th>追溯模式</th></tr></thead><tbody>${lines}</tbody></table></div>`
        + `<p class="q-hint">${trace.note}</p>` }
    } }))

  // ---- **对象页**：`/app/contractor/award/<awin-… 或 aw-…>/`（意向 → 确认 → 承诺 → PO 四段） ----
  out.push(surface.panel({ plugin_id: me, id: 'award.object', title: '授标（对象页：四段状态）',
    view: 'contractor', order: 41, kind: 'kv', object_kind: 'award',
    data: (ctx) => {
      const id = asText(ctx.route?.id)
      const rows = host.rows('contractor')
      const intents = intentsOf(rows)
      const awards = awardsOf(rows)
      const intent = intents.find((item) => asText(item.intent_id) === id
        || asText(item.award_id) === id) ?? intents.find((item) => {
        const award = awards.find((row) => asText(row.intent_id) === asText(item.intent_id))
        return award && asText(award.award_id) === id
      })
      if (!intent) {
        return { ok: true, kind: 'kv', object: { found: false, title: `授标 ${id}`, reason: 'award-not-in-my-view',
          next_action: '这条授标不在承包商侧投影里：回「授标链」表，点行内「打开 →」用真实存在的深链' },
          items: [] }
      }
      const intentId = asText(intent.intent_id)
      const award = awards.find((item) => asText(item.intent_id) === intentId)
      const po = award ? posOf(rows).find((item) => asText(item.award_id) === asText(award.award_id)) : null
      const confirmed = typeRows(rows, 'award/confirmed').map((row) => bodyOf(row))
        .find((row) => asText(row.intent_id) === intentId)
      const base = `${host.prefix}/app/contractor/`
      const step = (label, done, fact) => ({ key: label, value: done ? `✅ ${fact}` : `⏳ ${fact}` })
      return { ok: true, kind: 'kv',
        object: { title: `授标 ${intentId}`, subtitle: `报价 ${intent.quote_id ?? '—'} ·`
          + ` 包 ${intent.package_id ?? '—'}`, found: true,
          facts: [
            { key: '状态', value: award ? (po ? '已承诺 + 已发 PO' : '已承诺（待发 PO）') : '仅有意向（未承诺）' },
            { key: '中标行', value: String((intent.lines ?? []).length) },
            { key: '报价', value: asText(intent.quote_id), code: true },
          ],
          links: [
            { kind: 'quote', id: asText(intent.quote_id), title: `报价 ${intent.quote_id}` },
            { kind: 'package', id: asText(intent.package_id), title: `包 ${intent.package_id}` },
          ].filter((link) => link.id !== '') },
        items: [
          step('① 意向', true, `已提出（${intent.proposed_at ?? '—'}）`),
          step('② 供应商确认', Boolean(confirmed), confirmed
            ? `${confirmed.confirmed_by} @ ${confirmed.confirmed_at}` : '还没确认（对方要在它自己的界面确认）'),
          step('③ 人签承诺', Boolean(award),
            award ? `${award.award_id} · 门的批准人 ${award.approved_by}` : '还没承诺'),
          step('④ 发 PO', Boolean(po), po ? `${po.po_id}` : '还没签发'),
        ],
        note: `承诺与 PO 都必须人签且要过人工门（INV-005）；这一页只读。`
          + `${po ? ` PO 深链：${base}po/${encodeURIComponent(asText(po.po_id))}/` : ''}` }
    } }))

  // ---- **对象页**：`/app/contractor/change/<chg-…>/`（逐行差异 + 批准判定） ----
  out.push(surface.panel({ plugin_id: me, id: 'change.object', title: '变更单（对象页：逐行差异）',
    view: 'contractor', order: 61, kind: 'table', object_kind: 'change',
    data: (ctx) => {
      const id = asText(ctx.route?.id)
      const rows = host.rows('contractor')
      const change = changeRows(rows).find((item) => asText(item.change_id) === id)
      if (!change) {
        return { ok: true, kind: 'table', object: { found: false, title: `变更单 ${id}`,
          reason: 'change-not-in-my-view',
          next_action: '这条变更单不在承包商侧投影里：回「变更与价格让步」列表，点行内「打开 →」用真实存在的深链' },
          columns: [{ key: 'change_id', label: '变更' }], rows: [] }
      }
      const changeLineRead = readRows(change.lines)
      const changeLineRows = changeLineRead.rows
      const decision = changeDecisions(rows).get(asText(change.change_id))
      const status = change.status === 'approved' ? '已批准（生效）'
        : (decision?.decision === 'denied' ? `已驳回（${decision.by}）` : '待批（未生效，不计金额）')
      return { ok: true, kind: 'table',
        object: { title: `变更单 ${change.change_id}`, subtitle: `报价 ${change.quote_id} · ${status}`, found: true,
          facts: [
            { key: '差额', value: String(change.delta_amount ?? 0) },
            { key: '状态', value: status },
            { key: '批准人', value: change.approved_by ?? '—' },
            { key: '理由', value: String(change.reason ?? '') },
          ],
          links: [{ kind: 'quote', id: asText(change.quote_id), title: `报价 ${change.quote_id}` }]
            .filter((link) => link.id !== '') },
        columns: [{ key: 'ref_line', label: '行', type: 'code' }, { key: 'old_qty', label: '原量', filter: 'number' },
          { key: 'new_qty', label: '新量', filter: 'number' }, { key: 'old_unit_price', label: '原单价（只读）', filter: 'number' }],
        rows: changeLineRows.map((line, index) => ({ id: `${line.ref_line ?? line.item_id ?? index}`,
          ref_line: line.ref_line ?? line.item_id, old_qty: line.old_qty, new_qty: line.new_qty,
          old_unit_price: line.old_unit_price ?? '' })),
        counts: { lines: changeLineRows.length, dropped: changeLineRead.dropped },
        note: '未批准的变更一分钱都不计；批准/驳回都是人工门（在列表行内点，或本页工具栏的动作）'
          + (changeLineRead.dropped
            ? ` · 另有 ${changeLineRead.dropped} 条行明细读不出来（形状异常：不是对象）—— 已跳过并计数，不静默丢`
            : '') }
    } }))

  // ------------------------------------------------------------------ 变更与价格让步（DEF-018）
  const changeRows = (rows) => {
    const map = new Map()
    const order = []
    for (const row of rows) {
      const type = String(row?.type ?? '')
      if (!type.startsWith('change/')) continue
      const body = bodyOf(row)
      const id = asText(body.change_id)
      if (!id) continue
      if (!map.has(id)) order.push(id)
      const previous = map.get(id) ?? { change_id: id, quote_id: asText(body.quote_id), status: 'proposed',
        reason: '', lines: [], delta_amount: 0, refs: [], approved_by: null, approval_id: null,
        proposed_at: String(row.ts ?? ''), approved_at: '', rejected_reason: '', mirror: false }
      const next = { ...previous }
      if (type === 'change/proposed') {
        next.quote_id = asText(body.quote_id) || next.quote_id
        next.reason = body.reason ?? next.reason
        next.refs = (body.ref_quote_lines ?? next.refs)
        next.delta = body.delta ?? next.delta
        if (Array.isArray(body.lines) && body.lines.length) next.lines = body.lines
        const mirrored = asText(body.status)
        if (mirrored === 'approved') next.status = 'approved'
        else if (mirrored === 'rejected') next.status = 'rejected'
      } else if (type === 'change/priced') {
        next.lines = body.lines ?? next.lines
        next.delta_amount = body.delta_amount ?? next.delta_amount
      } else if (type === 'change/approved') {
        next.status = 'approved'; next.approved_by = body.approved_by; next.approval_id = body.approval_id
        next.approved_at = String(row.ts ?? '')
      }
      next.mirror = body.mirror === true
      map.set(id, next)
    }
    return order.map((id) => map.get(id))
  }
  const changeDecisions = (rows) => {
    const map = new Map()
    for (const row of rows) {
      if (!String(row?.type ?? '').startsWith('approval/')) continue
      const body = bodyOf(row)
      if (asText(body.scope) !== 'change.approve') continue
      const id = asText(body.ref)
      if (!id) continue
      if (asText(body.status) === 'denied') {
        map.set(id, { decision: 'denied', by: body.decided_by, comment: body.comment ?? '', at: String(row.ts ?? '') })
      } else if (asText(body.status) === 'granted' && !map.has(id)) {
        map.set(id, { decision: 'granted', by: body.decided_by, comment: body.comment ?? '', at: String(row.ts ?? '') })
      }
    }
    return map
  }

  out.push(surface.panel({ plugin_id: me, id: 'change.list', title: '变更与价格让步（提出 / 批准 / 驳回）',
    view: 'contractor', order: 60, kind: 'table', actions: ['change.approve', 'change.reject'],
    data: () => {
      const rows = host.rows('contractor')
      const changes = changeRows(rows)
      const decisions = changeDecisions(rows)
      if (!changes.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-change',
          next_action: '用「提出变更」把现场追加/减少变成一条可追溯的变更单（原单价只读、只改量）',
          columns: [{ key: 'change_id', label: '变更' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        columns: [
          { key: 'change_id', label: '变更', type: 'code' }, { key: 'quote_id', label: '报价', type: 'code' },
          { key: 'lines', label: '逐行（原量→新量 @ 原单价）' },
          { key: 'delta_amount', label: '差额（元，整数分口径见工具输出）', filter: 'number' },
          { key: 'status_label', label: '状态' }, { key: 'approved_by', label: '批准人', type: 'code' },
          { key: 'reason', label: '理由' }, { key: 'proposed_at', label: '提出 @ts', filter: 'date' },
        ],
        rows: changes.map((change) => {
          const decision = decisions.get(change.change_id)
          const status = change.status === 'approved' ? '已批准（生效）'
            : (decision?.decision === 'denied' ? `已驳回（${decision.by}）` : '待批（未生效，不计金额）')
          return { id: change.change_id, change_id: change.change_id, quote_id: change.quote_id,
            lines: linesTextOf(readRows(change.lines), (line) => `${line.ref_line ?? line.item_id}: `
              + `${line.old_qty}→${line.new_qty}`
              + `${line.old_unit_price === undefined ? '' : ` @ ${line.old_unit_price}`}`, { sep: ' · ' }),
            delta_amount: change.delta_amount, status_label: status,
            approved_by: change.approved_by ?? '', reason: change.reason, proposed_at: change.proposed_at,
            reject_comment: decision?.decision === 'denied' ? decision.comment : '',
            ref: { kind: 'change', id: String(change.change_id), title: `变更单 ${change.change_id}` } }
        }),
        row_actions: ['change.approve', 'change.reject'], counts: { changes: changes.length,
          approved: changes.filter((change) => change.status === 'approved').length },
        note: '未批准的变更一分钱都不计（`effective_total` 只算已批准项）；批准走人工门 '
          + '`change.approve`（人签），驳回走人工门 denied（理由逐字落 comment）；'
          + '缺单价基准的行会被服务拒（`change/rejected`，拒绝也留痕）' }
    } }))

  /**
   * **DEF-037**：旧的变更单列表长在**已退役**的 `/gates/` 页上（每行 `data-change-detail-link` →
   * `/<view>/changes/<id>/`），那页退役后 GUI 的变更列表面板**没有**指向**逐行明细页**的链接 ——
   * 明细页与它的门都还在、真跑（`tools/verify.sh change-detail`），只是"列表里点不过去"。
   *
   * 这里把入口补回 GUI 的同一个视图上：表格式面板的单元格是**转义文本**（塞不进链接），
   * 所以用 `html` 面板给出每一条变更的**明细入口**，href 就是那页的真地址
   * `<前缀>/<视角>/changes/<变更单 id>/`（金额口径那一页：逐行 原量×原价 → 新量×新价、
   * 行差额与小计，**整数分**、half-up 到分位；缺依据的行如实标出、不编数）。
   * 列表行内的「打开 →」（`ref.kind='change'`）指向**对象页**（逐行差异 + 批准判定），两者互补。
   */
  out.push(surface.panel({ plugin_id: me, id: 'change.detail-links',
    title: '变更单逐行明细（点进去看金额 · 整数分口径）', view: 'contractor', order: 62, kind: 'html',
    data: () => {
      const rows = changeRows(host.rows('contractor'))
      const decisions = changeDecisions(host.rows('contractor'))
      if (!rows.length) {
        return { ok: true, kind: 'html', html: '<p class="q-hint">本侧还没有变更单：变更从「可提变更的报价行」'
          + '提出（提出变更不产生义务，未批准一分钱都不计）。提出后这里会给出每一条的逐行明细入口。</p>' }
      }
      const DET = 150
      const links = rows.slice(0, DET).map((change) => {
        const id = asText(change.change_id)
        const decision = decisions.get(id)
        const status = change.status === 'approved' ? '已批准（生效）'
          : (decision?.decision === 'denied' ? `已驳回（${asText(decision.by)}）` : '待批（未生效，不计金额）')
        // 每一条只留**够用**的字节（首屏载荷是要花的钱：P13 量过）：短 title + 截断的理由
        return `<li><a href="${host.prefix}/contractor/changes/${encodeURIComponent(id)}/"`
          + ` title="逐行明细页（整数分口径）"><code>${escHtml(id)}</code> 明细 →</a>`
          + ` ${escHtml(status)}${change.reason ? ` · ${escHtml(String(change.reason).slice(0, 40))}` : ''}</li>`
      }).join('')
      return { ok: true, kind: 'html',
        html: '<p class="q-hint">每条变更都能点进它的逐行明细页（<code>'
          + `${escHtml(host.prefix)}/contractor/changes/&lt;变更单 id&gt;/</code>）：逐行 原量×原价 → 新量×新价、`
          + '行差额与小计（整数分、half-up 到分位），缺依据的行如实标出、绝不编数。'
          + '列表行内的「打开 →」是对象页（逐行差异 + 批准/驳回判定）。</p>'
          + `<ol class="q-list">${links}</ol>`
          + (rows.length > DET ? `<p class="q-hint">共 ${rows.length} 条变更，这里只列前 ${DET} 条`
            + `（其余按 id 直接打开：<code>${escHtml(host.prefix)}/contractor/changes/&lt;id&gt;/</code>）</p>` : '') }
    } }))

  out.push(surface.panel({ plugin_id: me, id: 'change.inbox', title: '承包商提出的变更（对方通知）',
    view: 'supplier', order: 80, kind: 'table',
    data: () => {
      const rows = host.rows('supplier')
      const changes = changeRows(rows)
      if (!changes.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-change',
          next_action: '承包商提出变更后这里会出现（带逐行 原量→新量 与差额）',
          columns: [{ key: 'change_id', label: '变更' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        columns: [{ key: 'change_id', label: '变更', type: 'code' }, { key: 'quote_id', label: '我的报价', type: 'code' },
          { key: 'lines', label: '逐行 原量→新量' }, { key: 'delta_amount', label: '差额', filter: 'number' },
          { key: 'status_label', label: '状态' }, { key: 'reason', label: '对方理由' }],
        rows: changes.map((change) => ({ id: change.change_id, change_id: change.change_id,
          quote_id: change.quote_id,
          lines: linesTextOf(readRows(change.lines), (line) => `${line.ref_line ?? line.item_id}: `
            + `${line.old_qty}→${line.new_qty}`, { sep: ' · ' }),
          delta_amount: change.delta_amount,
          status_label: change.status === 'approved' ? '已批准（生效）'
            : (asText(change.status) === 'rejected' ? '已驳回' : '待回应 / 待批'),
          reason: change.reason })),
        counts: { changes: changes.length },
        note: '只出本侧该看到的字段（逐行差异与差额，不含承包商内部备注）；'
          + '供应商侧的「接受/异议」由供应商道自己的变更页负责' }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'change.propose', title: '提出变更（原单价只读，只改量）',
    views: ['contractor'], group: '变更', order: 10, permission: 'human-signature',
    confirm: { required: true, message: '提出变更不产生对外义务（未批准不计金额）：确认以你的署名提出？' },
    hint: '逐行写 `item_id,新数量`；基准引用自动按 `<报价>#<条目>:unit_price` 填；全部行都没改量会被拒（no-op-change）',
    input: { fields: [
      { name: 'quote_id', label: '报价 id', type: 'text', required: true, help: '从报价收件箱/比价里取' },
      { name: 'lines', label: '逐行变更（每行 `item_id,新数量`）', type: 'textarea', required: true,
        help: '例：L-002,500' },
      { name: 'reason', label: '变更理由', type: 'textarea', required: true },
      { name: 'signature', label: '提出人（人签）', type: 'signature', required: true },
    ] },
    server: async (ctx, input) => {
      // `input.lines` 是**多行文本**（每行 `item_id,新数量`），不是行数组 ⇒ 变量名用 `piece`：
      // `line` 在本仓一律指"外部数组里的一行"，这里容易看错（逐行读属性那一类风险）
      const lines = String(input.lines ?? '').split('\n').map((piece) => piece.trim()).filter(Boolean)
        .map((piece) => {
          const [itemId, qty] = piece.split(',').map((cell) => cell.trim())
          return { item_id: itemId, new_qty: Number(qty) }
        })
      if (!lines.length) {
        return { ok: false, code: 'lines-required', reason: '没有给任何行变更',
          next_action: '每行写 `item_id,新数量`（如 L-002,500）' }
      }
      const bad = lines.filter((line) => !line.item_id || !Number.isFinite(line.new_qty))
      if (bad.length) {
        return { ok: false, code: 'line-malformed', reason: `这些行写法不对：${JSON.stringify(bad)}`,
          next_action: '每行恰好两段：`item_id,新数量`' }
      }
      const staged = host.stage('change-apply', { kind: 'change-apply', action: 'propose', view: 'contractor',
        quote_id: asText(input.quote_id), lines, actor: asText(input.signature), note: String(input.reason ?? '') })
      if (!staged.ok) return staged
      const run = host.runPython(changeTool, ['--step', 'propose', '--request', staged.path,
        '--ui-shared', host.sharedDir, '--ledger-contractor', asText(host.config?.ledger_contractor),
        '--ledger-supplier', asText(host.config?.ledger_supplier), '--now', host.now()])
      const json = cleanJson(run)
      return { ok: run.ok && json.ok === true, code: json.refusal?.code ?? (json.ok ? 'proposed' : 'writer-failed'),
        reason: json.refusal?.reason ?? run.reason ?? '',
        next_action: json.refusal?.next_action ?? json.next_action_runtime ?? '看 result 里的逐行差额与下一步',
        result: { pending: staged.file, change_id: json.change_id ?? null, delta_amount: json.delta_amount ?? null,
          preview: json.preview ?? [], ledger_added: json.ledger_added ?? 0 } }
    } }))

  const decideAction = (id, step, title, hint) => surface.action({ plugin_id: me, id, title,
    views: ['contractor'], group: '变更', order: step === 'approve' ? 20 : 25, permission: 'human-signature',
    inline: true, object_kind: 'change',
    confirm: { required: true, message: `${title}：确认以你的署名执行？（人工门 change.approve）` },
    hint, input: { fields: [
      { name: 'change_id', label: '变更 id', type: 'text', required: true, from_route: true,
        help: '从变更列表行里取（chg-…）；在变更对象页上会自动填当前这一条' },
      { name: 'signature', label: '署名（人签）', type: 'signature', required: true, help: 'human:<你的名字>' },
      { name: 'comment', label: '意见（驳回必填；逐字落 approval 记录）', type: 'textarea',
        required: step === 'reject' },
    ] },
    server: async (ctx, input) => {
      const staged = host.stage('change-apply', { kind: 'change-apply', action: step, view: 'contractor',
        change_id: asText(input.change_id), actor: asText(input.signature), note: String(input.comment ?? '') })
      if (!staged.ok) return staged
      const run = host.runPython(changeTool, ['--step', step, '--request', staged.path,
        '--ui-shared', host.sharedDir, '--ledger-contractor', asText(host.config?.ledger_contractor),
        '--ledger-supplier', asText(host.config?.ledger_supplier), '--now', host.now()])
      const json = cleanJson(run)
      return { ok: run.ok && json.ok === true, code: json.refusal?.code ?? (json.ok ? step : 'writer-failed'),
        reason: json.refusal?.reason ?? run.reason ?? '',
        next_action: json.refusal?.next_action ?? json.next_action_runtime ?? '看 result 里的账本增量',
        result: { pending: staged.file, change_id: json.change_id ?? null, status: json.status ?? null,
          delta_amount: json.delta_amount ?? null, effective_total: json.effective_total ?? null,
          ledger_added: json.ledger_added ?? 0 } }
    } })

  out.push(decideAction('change.approve', 'approve', '批准变更（人签 · 价格让步）',
    '人工门 change.approve：先落 approval/requested → granted，再落 change/approved（此后计入金额）'))
  out.push(decideAction('change.reject', 'reject', '驳回变更（人签）',
    '人工门 change.approve 的 denied：变更保持 proposed、不进金额；理由逐字落 comment'))

  out.push(surface.notificationSource({ plugin_id: me, id: 'notify.changes', title: '变更待批与对方变更',
    order: 20, poll: () => {
      const items = []
      const rowsOut = host.rows('contractor')
      const decisions = changeDecisions(rowsOut)
      for (const change of changeRows(rowsOut)) {
        if (change.status === 'approved' || decisions.get(change.change_id)?.decision === 'denied') continue
        items.push({ id: `change:${change.change_id}`, level: 'warn', at: change.proposed_at, ref: change.change_id,
          title: `待批变更 ${change.change_id}（差额 ${change.delta_amount}）`,
          body: `报价 ${change.quote_id} · ${(change.lines ?? []).length} 行 · 未批准前不计金额`,
          next_action: '去「变更与价格让步」点「批准变更」或「驳回变更」（人签）' })
      }
      for (const row of host.rows('supplier')) {
        if (String(row?.type ?? '') !== 'change/proposed') continue
        const body = bodyOf(row)
        if (body.mirror !== true) continue
        items.push({ id: `change:s:${body.change_id}:${row.ts ?? ''}`, level: 'info', at: String(row.ts ?? ''),
          title: `承包商提出变更 ${asText(body.change_id)}（差额 ${body.delta_amount}）`,
          body: `${(body.lines ?? []).length} 行 · 状态 ${asText(body.status) || 'proposed'}`,
          next_action: '看供应商道「承包商提出的变更」面板' })
      }
      return items
    } }))

  // ------------------------------------------------------------------ 导出 / 打印（`report` 声明 + 动作）
  /**
   * **PO 导出**（对象页 `/app/contractor/po/<id>/` 上的「导出 / 打印」）：行与价**全部来自账本事实**
   * （`po/issued` 的 `lines` 与追溯链），一列都不由界面拼；每行带 `basis`（单价基准）与 `trace`，
   * 表头带四段链与账本行号 ⇒ 打印出来能逐行对回账本。
   */
  out.push(surface.action({ plugin_id: me, id: 'po.export', title: '导出 / 打印采购单（人读格式）',
    views: ['contractor'], group: '授标', order: 32, icon: 'print', object_kind: 'po',
    hint: '内容 = 本侧账本 `po/issued` 的行 + 追溯链（逐行带单价基准）；外壳只做序列化',
    input: { fields: [
      { name: 'po_id', label: 'PO id', type: 'text', required: true, from_route: true,
        help: '在 PO 对象页上会自动填当前这一条' },
      { name: 'format', label: '格式（csv = 表格；html = 可直接打印）', type: 'select', required: true,
        options: ['csv', 'html'], default: 'csv' },
    ] },
    server: (ctx, input) => {
      const view = 'contractor'
      const rows = host.rows(view)
      const poId = asText(input.po_id)
      const po = posOf(rows).find((item) => asText(item.po_id) === poId) ?? null
      if (!po) {
        return { ok: false, code: 'po-not-in-my-view', reason: `本侧账本里没有这条 PO：${poId || '(空)'}`,
          next_action: '回「采购单（PO）」面板，点行内「打开 →」用真实存在的深链再导出' }
      }
      const award = awardsOf(rows).find((item) => asText(item.award_id) === asText(po.award_id)) ?? {}
      const intent = intentsOf(rows).find((item) => asText(item.intent_id) === asText(po.intent_id)) ?? {}
      const poRow = rows.filter((row) => String(row?.type ?? '') === 'po/issued')
        .find((row) => asText(bodyOf(row).po_id) === poId) ?? {}
      const lines = (po.lines ?? []).map((line, index) => ({ no: index + 1, ref_line: asText(line.ref_line),
        qty: line.qty, unit_price: line.unit_price,
        amount: Number(line.qty ?? 0) * Number(line.unit_price ?? 0), basis: asText(line.basis),
        trace: asText(line.trace), quote_id: asText(po.quote_id) }))
      return host.report({ format: asText(input.format) || 'csv', filename: `po-${poId}`,
        title: `采购单（PO）${poId}`,
        subtitle: `承包商侧导出 · ${lines.length} 行 · 追溯模式 ${asText(po.trace_mode) || '—'}`,
        facts: [
          { key: 'PO', value: poId },
          { key: '承诺（award）', value: asText(po.award_id) },
          { key: '意向（intent）', value: asText(po.intent_id) },
          { key: '报价（quote）', value: asText(po.quote_id) },
          { key: '人工门（approval）', value: asText(po.approval_id) },
          { key: '批准人（署名）', value: asText(po.approved_by) },
          { key: '签发时刻', value: asText(po.issued_at) },
          { key: '追溯链', value: asText(po.chain) },
          { key: '金额合计（元）', value: String(po.total_amount ?? '') },
          { key: '中标条目（承诺里）', value: String((award.lines ?? intent.lines ?? []).length) },
          { key: '账本行', value: poRow.seq === undefined ? '—'
            : `seq ${poRow.seq} · ${asText(poRow.entry_hash)}` },
        ],
        columns: [{ key: 'no', label: '#' }, { key: 'ref_line', label: '行项目' }, { key: 'qty', label: '数量', filter: 'number' },
          { key: 'unit_price', label: '单价（元）', filter: 'number' }, { key: 'amount', label: '行金额（元）', filter: 'number' },
          { key: 'basis', label: '单价基准（可追溯）' }, { key: 'trace', label: '追溯模式' },
          { key: 'quote_id', label: '来源报价' }],
        rows: lines,
        notes: ['行与价都由中标承诺派生（不得在界面上改价）；`basis` 指向中标报价的那一条单价。',
          `导出时刻：${host.now()}；本文件逐行可与账本 po/issued（seq ${poRow.seq ?? '—'}）核对，`
            + '合计 = 各行 数量×单价 之和。'],
        source: '承包商侧账本 po/issued（po.export，domain/commitments）',
        ledger_refs: poRow.seq === undefined ? [] : [{ type: 'po/issued', seq: poRow.seq,
          entry_hash: asText(poRow.entry_hash), chain: asText(po.chain) }] })
    } }))

  out.push(surface.report({ plugin_id: me, id: 'report.po', title: '采购单 PO（CSV / 可打印 HTML）',
    views: ['contractor'], object_kind: 'po', formats: ['csv', 'html'], action: 'po.export', order: 32,
    // `columns` = 这份导出有哪些列（**元数据**：界面拿它做「列选择」个人偏好；内容仍由 action 生成）。
    // 与 `po.export` 的 spec.columns 逐字一致 —— 改了这里就要改那里（同一份台账）。
    columns: [{ key: 'no', label: '#' }, { key: 'ref_line', label: '行项目' }, { key: 'qty', label: '数量', filter: 'number' },
      { key: 'unit_price', label: '单价（元）', filter: 'number' }, { key: 'amount', label: '行金额（元）', filter: 'number' },
      { key: 'basis', label: '单价基准（可追溯）' }, { key: 'trace', label: '追溯模式' },
      { key: 'quote_id', label: '来源报价' }],
    hint: '逐行带单价基准与来源报价；表头给四段追溯链与账本行号' }))

  // ---- **沙盘场景**：演示流程的第 ④ 段 = 授标（人签）→ 发 PO（人签）→ 供应商回签 --------------
  // **七段贡献**（同一场景 `demo.procurement`，按 `order` 与其他插件交错成一条链）。为什么拆得这么细：
  // 人门（P48 / ADR-0024）要求承诺与发 PO **消费一扇「另一个人」已经批过的门**，所以演示里必须真的走
  // 「开单 → 另一个人批 → 再署名」；而沙盘的演示身份是机制**按档位**生成的（每档一个 `demo-<档位>`，
  // 见 app-shell 的 `actors` 段），档位 = 产品的视图档（`home` / `contractor` / `supplier`，不新造视图）。
  // 于是：**开单与署名**用 `contractor` 档（会话身份就是那一侧的人），**「另一个人」**借 `home` 档
  // 生成 `demo-home`（沙盘不建名册 ⇒ 只能借档位造出同侧的第二个人；真实面里批门的是承包商侧名册里
  // 角色为 `supervisor` 的那个人 —— 沙盘演示不假装它建了名册）。
  out.push(surface.scenario({ plugin_id: me, id: 'scenario.award-propose', scenario: 'demo.procurement',
    scenario_title: '演示：包 → 报价 → 比价 → 授标 → PO → 回签',
    title: '④ 授标意向 + 供应商确认（人签）', view: 'contractor', order: 40,
    hint: '意向（不产生义务）→ 供应商人签确认；承诺与发 PO 各要一扇**别人批过的**人工门（下一步就是开单）',
    steps: [
      { action: 'award.propose', capture: 'intent', input: { package_id: 'DEMO-PKG-001',
        quote_id: '$cap.q1.quote_id', item_id: 'L-001', qty: 120, unit_price_cents: 8600,
        reason: '沙盘演示：按比价第一名提意向' } },
      { action: 'award.confirm', as: { side: 'supplier' },
        input: { intent_id: '$cap.intent.intent_id', signature: '$actor', note: '沙盘演示：供应商确认',
          confirm_ack: '1' } }] }))

  out.push(surface.scenario({ plugin_id: me, id: 'scenario.award-gate-request', scenario: 'demo.procurement',
    scenario_title: '演示：包 → 报价 → 比价 → 授标 → PO → 回签',
    title: '⑤ 开承诺的人门（请另一个人批）', view: 'contractor', order: 42,
    hint: '承包商开单（`scope=award.commit`、`ref=<意向>`）、开单时点名审批人；这一条会进审批队列',
    steps: [{ action: 'gate.request',
      input: { scope: 'award.commit', ref: '$cap.intent.intent_id', approvers: 'human:demo-home',
        summary: '沙盘演示：授标承诺要人批', signature: '$actor',
        note: '沙盘演示：请另一个演示身份批这条承诺门', confirm_ack: '1' } }] }))

  out.push(surface.scenario({ plugin_id: me, id: 'scenario.award-gate-grant', scenario: 'demo.procurement',
    scenario_title: '演示：包 → 报价 → 比价 → 授标 → PO → 回签',
    title: '⑥ 另一个人批准（人签，改判定）', view: 'home', order: 43,
    hint: '由**不是署名者**的那个演示身份批准（谁批的 ≠ 谁签的）；沙盘只有每档一个演示身份，'
      + '所以这一档就是「另一个批门的人」',
    steps: [{ action: 'gate.grant', as: { side: 'home' },
      input: { gate_id: '$last.approval_id', signature: '$actor', confirm_ack: '1',
        comment: '沙盘演示：另一个人批准（之后承诺才成立）' } }] }))

  out.push(surface.scenario({ plugin_id: me, id: 'scenario.award-commit', scenario: 'demo.procurement',
    scenario_title: '演示：包 → 报价 → 比价 → 授标 → PO → 回签',
    title: '⑦ 授标承诺（人签，消费那扇门）', view: 'contractor', order: 44,
    hint: '三样门齐备才落账：意向 + 供应商确认 + **别人批过的人门**（没有门 ⇒ 具名拒、账本零新增）',
    steps: [{ action: 'award.commit', capture: 'award', input: { intent_id: '$cap.intent.intent_id',
      signature: '$actor', reason: '沙盘演示：人工批准（三样门齐备）', comment: '沙盘演示',
      confirm_ack: '1' } }] }))

  out.push(surface.scenario({ plugin_id: me, id: 'scenario.po-gate-request', scenario: 'demo.procurement',
    scenario_title: '演示：包 → 报价 → 比价 → 授标 → PO → 回签',
    title: '⑧ 开 PO 的人门（请另一个人批）', view: 'contractor', order: 46,
    hint: '发 PO 与承诺同一条人门：`scope=po.issue`、`ref=<承诺>`，同样要另一个人批',
    steps: [{ action: 'gate.request',
      input: { scope: 'po.issue', ref: '$cap.award.award_id', approvers: 'human:demo-home',
        summary: '沙盘演示：发 PO 要人批', signature: '$actor',
        note: '沙盘演示：请另一个演示身份批这条发 PO 门', confirm_ack: '1' } }] }))

  out.push(surface.scenario({ plugin_id: me, id: 'scenario.po-gate-grant', scenario: 'demo.procurement',
    scenario_title: '演示：包 → 报价 → 比价 → 授标 → PO → 回签',
    title: '⑨ 另一个人批准发 PO（人签）', view: 'home', order: 47,
    hint: '与承诺那扇门同一条判定：署名者必须另有其人',
    steps: [{ action: 'gate.grant', as: { side: 'home' },
      input: { gate_id: '$last.approval_id', signature: '$actor', confirm_ack: '1',
        comment: '沙盘演示：另一个人批准发 PO' } }] }))

  out.push(surface.scenario({ plugin_id: me, id: 'scenario.po-issue-ack', scenario: 'demo.procurement',
    scenario_title: '演示：包 → 报价 → 比价 → 授标 → PO → 回签',
    title: '⑩ 发 PO（人签，消费那扇门）+ 供应商回签', view: 'contractor', order: 50,
    hint: '逐行派生 PO（同步投递给供应商）→ 供应商人签回签',
    steps: [
      { action: 'po.issue', capture: 'po', input: { award_id: '$cap.award.award_id', signature: '$actor',
        reason: '沙盘演示：发 PO（同步投递）', comment: '沙盘演示',
        delivery_window: '沙盘演示：2026-10-08 前到货', ship_to: '沙盘演示：苏州工业园区 A 区 3 号库',
        confirm_ack: '1' } },
      { action: 'po.acknowledge', as: { side: 'supplier' }, optional: true,
        input: { po_id: '$cap.po.po_id', signature: '$actor', note: '沙盘演示：供应商回签收到',
          confirm_ack: '1' } }] }))

  return out
}
