/**
 * `domain/rfq` 的 **GUI 贡献**（把自己搬上界面）—— 承包商侧「发包」这一块。
 *
 * 它注册的东西（全部经注册面：`src/system/webui/code/ui-surface.mjs`）：
 *   · 视图容器 `rfq.workspace`（挂到 `contractor` 道）；
 *   · 面板 `rfq.published`（已发布的包：版本/条目数/截止/收件人 —— 只读本侧账本行 + 本侧包快照）；
 *   · 面板 `rfq.responses`（本侧收到的报价登记行，逐行给 quote_id/item_id/整数分单价/交期/供应商）；
 *   · 面板 `rfq.received`（发给自己的包：**供应商侧**）/ 面板 `rfq.my_drafts` 不在本文件（供应商侧归 quote-prepare）；
 *   · 动作 `rfq.publish`（**服务端一半**：落 0600 待办件 → 跑 `src/domain/rfq/tools/rfq-publish.py`
 *     这个唯一写者去落 `rfq/published` + `rfq/distributed`，并把投递信封写给被邀供应商）；
 *   · 快捷键 `p`、通知源、状态栏项。
 *   · 面板 `rfq.receipts`（**投递与已读回执**）：把「投给谁、何时投的」（账本事实 `rfq/distributed`）与
 *     「谁在何时看过这个包」（协作面痕迹 `<ui_shared>/receipts/deliveries.json`，0600，**不进账本**）
 *     摆在一起，回答采购员每天问的那句「对方收到了吗？看了吗？」。回执由**收件方打开包**时记下
 *     （记录方在 `domain/quote-prepare` 的 `quote.package` / `package.mine`），本文件**只读**它。
 *
 * 纪律：本文件**不写账本**（`host.runPython` 只是 spawn；写账本的是 Python 侧唯一写者），
 * 也不读别人的账本（只读 `host.rows(...)` 给的本视角公开投影行）。
 */
export const plugin_id = 'domain/rfq'
import { createHash } from 'node:crypto'
import { createReceiptStore } from '../../../system/attachments/code/delivery-receipts.mjs'

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
const rowsOfType = (rows, prefix) => rows.filter((row) => String(row?.type ?? '').startsWith(prefix))
/** 「行」的最小形状：非 null 的**对象**（数组不是行）。 */
const isRow = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
/**
 * **外部行数组的唯一读数入口**（工具 JSON 的 `evidence.*`、账本行里的 `lines[]` 一律走这里）。
 *
 * 为什么必须有它（P27 实测的根因）：面板直接 `for (const item of json.evidence.x ?? [])` 再读
 * `item.seq` 时，数组里**只要有一条不是对象**（`null` / 字符串 / 数字）就抛 `TypeError`；外壳对
 * `panel.data()` 抛错的处理是**整块面板判 `data-failed`** —— 一条坏行把一整块面板打崩。
 *
 * 返回 `{list, all, rows, dropped}`：坏行**逐条计数**（`dropped`，调用方如实报出来、不静默丢），
 * `list=false` 表示"源本身不是数组"（那与"一条都没有"是两回事）。
 */
const readRows = (value) => {
  if (!Array.isArray(value)) return { list: false, all: 0, rows: [], dropped: 0 }
  const rows = value.filter((row) => isRow(row))
  return { list: true, all: value.length, rows, dropped: value.length - rows.length }
}

/** 表单里的「行项目」文本 → items[]：每行 `item_id,描述,单位,数量`（逗号分隔；空行忽略）。 */
const parseItems = (text) => {
  const items = []
  const problems = []
  for (const [index, line] of String(text ?? '').split('\n').entries()) {
    const raw = line.trim()
    if (raw === '') continue
    const parts = raw.split(',').map((piece) => piece.trim())
    if (parts.length < 4) {
      problems.push({ line: index + 1, code: 'item-needs-4-fields',
        message: `第 ${index + 1} 行只给了 ${parts.length} 段：要写 \`item_id,描述,单位,数量\`` })
      continue
    }
    const qty = Number(parts[3])
    if (!Number.isFinite(qty) || qty <= 0) {
      problems.push({ line: index + 1, code: 'item-qty-invalid', message: `第 ${index + 1} 行的数量不是正数：${parts[3]}` })
      continue
    }
    items.push({ item_id: parts[0], description: parts[1], unit: parts[2], qty })
  }
  return { items, problems }
}

const parseList = (text) => String(text ?? '').split(/[,\s\n]+/).map((piece) => piece.trim())
  .filter((piece) => piece !== '')

export async function register(surface, host) {
  const me = plugin_id
  const out = []
  const ledger = () => asText(host.config?.ledger_contractor)
  const shared = () => asText(host.sharedDir)
  /** 已读回执存储（**只读**：记回执的是**收件方**那一侧的插件，见 `domain/quote-prepare`）。 */
  const receipts = createReceiptStore({ root: host.root, sharedDir: host.sharedDir,
    log: (msg) => host.note.set(me, 'receipt-log', msg) })
  /** 显示口径：只去掉 `human:` 前缀（与协作面同一套显示口径）；**逻辑判据仍用原始值**。 */
  const humanName = (value) => String(value ?? '').replace(/^human:/, '')

  out.push(surface.view({ plugin_id: me, id: 'rfq.workspace', title: '发包工作区', order: 10,
    view: 'contractor', hint: '发布 RFQ / 看谁收到了 / 看回应' }))

  out.push(surface.panel({ plugin_id: me, id: 'rfq.published', title: '已发布的 RFQ（本侧账本事实）',
    view: 'contractor', order: 10, kind: 'table', placement: 'main',
    data: (ctx) => {
      const rows = host.rows('contractor')
      const published = rowsOfType(rows, 'rfq/published').map((row) => ({ type: row.type, ts: row.ts,
        ...bodyOf(row) }))
      const distributed = rowsOfType(rows, 'rfq/distributed')
      const recipientsOf = (packageId) => {
        const out2 = new Set()
        for (const row of distributed) {
          const body = bodyOf(row)
          if (asText(body.package_id) !== packageId) continue
          for (const who of body.recipients ?? []) out2.add(String(who))
        }
        return [...out2].sort()
      }
      const table = published.map((row) => {
        const packageId = asText(row.package_id)
        const rev = Number(row.rev ?? 0)
        return { id: `${packageId}#r${rev}`, package_id: packageId, rev, items: row.items,
          quote_by: row.quote_by ?? '', published_at: row.ts,
          recipients: recipientsOf(packageId).join(' '), snapshot_hash: row.hash ?? '',
          ref: { kind: 'package', id: packageId, title: `包 ${packageId} rev${rev}` } }
      })
      if (!table.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-published-rfq',
          next_action: '用「发布 RFQ」动作发布第一个包（发布是不产生对外义务的动作）',
          columns: [{ key: 'package_id', label: '包' }, { key: 'rev', label: '版本' }], rows: [],
          note: '本侧账本里还没有 rfq/published 行' }
      }
      return { ok: true, kind: 'table',
        columns: [{ key: 'package_id', label: '包', type: 'code' }, { key: 'rev', label: '版本', filter: 'number' },
          { key: 'items', label: '条目数', filter: 'number' }, { key: 'quote_by', label: '报价截止', filter: 'date' },
          { key: 'recipients', label: '已分发（谁收到了）' }, { key: 'snapshot_hash', label: '快照哈希', type: 'code' }],
        rows: table, counts: { published: table.length },
        note: '收件人来自 rfq/distributed 的 recipients 字段（「谁在何时收到哪个版本」按版本锚定）' }
    } }))

  /**
   * **投递与已读回执**（本批新增）：一屏回答采购员每天问的两句 ——「发出去了吗」与「对方看了吗」。
   *
   *   · 「投递」半边是**账本事实**（`rfq/distributed`：投给哪个 realm、何时投的、哪个 rev）；
   *   · 「已读」半边是**协作面痕迹**（`<ui_shared>/receipts/deliveries.json`，0600，**不进账本**）——
   *     由**收件方打开包**时按会话身份记下（记录方：`domain/quote-prepare` 的 `quote.package` /
   *     `package.mine`），本面板只读。
   *   · 回执按**包**聚合（对象页看到的是「这个包（最新一版）」；投递按 rev 记在账本上，两者都如实列出来，
   *     不把「看过 rev1」冒充成「看过 rev2」）；回执里没有对方的报价/成本/评分。
   *   · **越侧拿不到**：这一块只给**承包商侧**（发送侧）看；供应商身份（或未登录）读这一块被明确拒
   *     （`side-mismatch` / `identity-required`），不返回任何回执行。
   */
  out.push(surface.panel({ plugin_id: me, id: 'rfq.receipts',
    title: '投递与已读回执（对方收到了吗 · 看了吗）',
    view: 'contractor', order: 16, kind: 'table',
    // 注意：`hint` 会被外壳 HTML 转义 ⇒ 这里写**纯文本**（不要 markdown 记号，否则用户看到的是 `**`）。
    hint: '「投递」= 账本事实（rfq/distributed：投给谁、何时、哪个版本）；「已读」= 协作面痕迹'
      + '（对方打开这个包时记的「谁 / 何时 / 看过几次」，0600 文件，不进账本）—— 回执里没有对方的报价、'
      + '成本或任何私域字段。回执按包聚合、投递按版本记账：看到「已读」不等于「看了最新的那一版」，'
      + '要按版本确认请让对方认收（rfq/acknowledged，那是账本事实）。这一块只对承包商侧（发送侧）显示。',
    data: (ctx) => {
      const side = asText(ctx?.identity?.side)
      if (side !== 'contractor') {
        return { ok: true, kind: 'table', degraded: true,
          reason: side === '' ? 'identity-required' : 'side-mismatch',
          columns: [{ key: 'package_id', label: '包' }], rows: [],
          next_action: side === ''
            ? '先登录承包商侧身份：投递与已读回执是发包方（发送侧）的视图'
            : '这一块只给承包商侧（发包方）看：它是「对方看过你发的包」的痕迹，供应商侧身份读不到' }
      }
      const rows = host.rows('contractor')
      /** 每个包**最新一版**的发布事实（rev 与报价截止）。 */
      const published = new Map()
      for (const row of rowsOfType(rows, 'rfq/published')) {
        const body = bodyOf(row)
        const id = asText(body.package_id)
        if (id === '') continue
        const rev = Number(body.rev ?? 0)
        const known = published.get(id)
        if (!known || rev >= known.rev) {
          published.set(id, { rev, quote_by: asText(body.quote_by), at: asText(row.ts) })
        }
      }
      /** 每个包的**投递登记**（`rfq/distributed`）：投过哪几版、投给谁、最近一次何时投的。 */
      const deliveries = new Map()
      for (const row of rowsOfType(rows, 'rfq/distributed')) {
        const body = bodyOf(row)
        const id = asText(body.package_id)
        if (id === '') continue
        const item = deliveries.get(id) ?? { revs: new Set(), recipients: new Set(), sent_at: '', count: 0 }
        item.revs.add(Number(body.rev ?? 0))
        for (const who of body.recipients ?? []) item.recipients.add(String(who))
        const sentAt = asText(body.sent_at) || asText(row.ts)
        if (sentAt > item.sent_at) item.sent_at = sentAt
        item.count += 1
        deliveries.set(id, item)
      }
      const ids = [...new Set([...published.keys(), ...deliveries.keys()])].sort()
      if (!ids.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-published-rfq',
          columns: [{ key: 'package_id', label: '包' }], rows: [],
          next_action: '用「发布 RFQ」发布第一个包（发布即分发）：之后这里会同时给出投递与已读两半边' }
      }
      const reads = receipts.forObjects('package', ids)
      const rowsOut = ids.map((id) => {
        const rec = deliveries.get(id)
        const readers = reads.readers.get(id) ?? []
        const first = readers.length ? readers[0] : null
        const last = readers.reduce((acc, item) => (!acc || item.last_at > acc.last_at ? item : acc), null)
        const status = !rec ? '未投递（账本里没有 rfq/distributed）'
          : (readers.length ? `已读（${readers.length} 人看过）` : '已投递 · 还没人看过')
        return { id, package_id: id,
          rev: rec ? [...rec.revs].sort((left, right) => left - right).join(' / ') : '—',
          quote_by: published.get(id)?.quote_by ?? '',
          recipients: rec ? [...rec.recipients].sort().join(' / ') : '',
          delivered_at: rec ? rec.sent_at : '',
          deliver_count: rec ? rec.count : 0,
          readers: readers.map((item) => `${humanName(item.human)}${item.side ? `（${item.side}侧）` : ''}`)
            .join(' · '),
          first_seen: first ? first.first_at : '',
          last_seen: last ? last.last_at : '',
          seen_count: readers.reduce((sum, item) => sum + item.count, 0),
          status,
          // **诚实**：把「从哪看的」也带上（列表面板 vs 对象页），不把「列表里刷到过」说成「打开了包」
          read_source: readers.map((item) => item.source).filter((item) => item !== '').join(' / ') }
      })
      const broken = reads.broken
      const problems = reads.problems ?? []
      return { ok: true, kind: 'table',
        columns: [
          { key: 'package_id', label: '包', type: 'code', pin: 'left' },
          { key: 'rev', label: '已投递版本（账本）' },
          { key: 'recipients', label: '投给谁（账本）', type: 'code' },
          { key: 'delivered_at', label: '投递时刻（账本）', filter: 'date' },
          { key: 'readers', label: '看过的人（回执）' },
          { key: 'first_seen', label: '首次看过', filter: 'date' },
          { key: 'last_seen', label: '最近看过', filter: 'date' },
          { key: 'seen_count', label: '看过次数', filter: 'number' },
          { key: 'status', label: '状态' },
        ],
        rows: rowsOut,
        counts: { packages: rowsOut.length, delivered: deliveries.size,
          read: rowsOut.filter((row) => asText(row.readers) !== '').length,
          unread: rowsOut.filter((row) => asText(row.readers) === '').length },
        note: '「投给谁 / 哪个版本 / 何时投的」逐行来自本侧账本的 `rfq/distributed`（可与账面逐行核）；'
          + '「看过的人 / 首次 / 最近 / 次数」来自回执文件 `<ui-shared>/receipts/deliveries.json`'
          + `（0600，${reads.file}，不进账本 —— 读取痕迹不是合同事实）。`
          + '回执按包聚合、投递按版本记账：看到「已读」不等于「看了最新的那一版」，'
          + '要按版本确认请让对方认收（`exchange.ack` 落 `rfq/acknowledged`，那是账本事实）。'
          + (broken ? ` ⚠ 回执文件读不出来（${broken.code}）：${broken.reason} —— 不是"还没有人看过"，${broken.how_to_fix}` : '')
          + (problems.length ? ` ⚠ 有 ${problems.length} 处坏形状已跳过（原样留在文件里）` : '') }
    } }))

  // ================================================================== 本周汇报（只读汇总 · 可导出）
  /**
   * **本周汇报视图**：管理者/老板要的那五个数，全部由**只读汇总器**从**本侧账本**算出来。
   *
   *   · 数字的真源 = `src/domain/rfq/tools/weekly-report.py`（只读；**不取墙钟**：`as_of` 缺省 = 账本里
   *     最大的 `ts`；算不出来的行进 `amount_missing`/`gate_unmatched`，**不当 0**）；
   *   · 面板**只摆**工具给的数（外壳与插件都不自己算一遍 ⇒ 不会出现两个口径）；
   *   · **逐行对账**：每一项都带账本行号（`evidence.*.seq`），界面第二块面板把它们摊成表；
   *   · 导出（TXT / CSV / 可打印 HTML）由同一次只读结果生成 —— 文本与 CSV **就在报告里**
   *     （`text`/`csv` 字段，工具自己渲染的那一份）⇒ 导出与屏幕上的数字逐字同源，界面侧不再抄一遍；
   *   · 看哪一周：`rfq.weekly-week` 动作把「往前挪几周」记进机制便签（**内存**，不落盘、不进账本），
   *     面板与导出都读它 —— 面板自己的 `data()` 是**只读**的。
   *   · **越侧拿不到**：这一块只给**承包商侧**看（账本是承包商侧的那一份）；供应商身份或未登录 ⇒ 明确拒。
   */
  const WEEKLY_TOOL = 'src/domain/rfq/tools/weekly-report.py'
  const WEEK_KEY = 'weekly-weeks-ago'
  const weeksAgo = () => {
    const raw = Number(host.note.get(me, WEEK_KEY, 0) ?? 0)
    return Number.isFinite(raw) && raw > 0 ? Math.min(52, Math.floor(raw)) : 0
  }
  /** 跑只读汇总器（`{read:true}`：同一组参数一次渲染只 spawn 一次；**不写账本**）。 */
  const runWeekly = () => {
    const file = ledger()
    if (file === '') {
      return { json: { ok: false, code: 'ledger-unconfigured',
        reason: '宿主未配置承包商账本（`ledger_contractor`）—— 没有账本就给不出周报，也不编一个',
        next_action: '看 `./run status` 的开关，或换一个配了账本的数据目录' }, run: null }
    }
    const run = host.runPython(WEEKLY_TOOL,
      ['--ledger', file, '--format', 'json', '--weeks-ago', String(weeksAgo())], { read: true })
    if (run.json && typeof run.json === 'object') return { json: run.json, run }
    return { run, json: { ok: false, code: run.code ?? 'weekly-tool-failed',
      reason: run.reason || run.stderr || '只读汇总器没有输出 JSON',
      next_action: `直接跑一次看原因：python3 ${WEEKLY_TOOL} --ledger <账本路径> --format text（账本零新增）` } }
  }
  const WEEKLY_LABELS = [['packages_published', '① 发布包数'], ['quotes_received', '② 收报价数'],
    ['award_amount_cents', '③ 授标金额'], ['gate_avg_wait_seconds', '④ 人工门平均等待'],
    ['overdue_no_reply', '⑤ 超时未回']]
  /** 一项指标 → 人读的一句（单位与口径都摆出来；`null` 说成「没有」而不是 0）。 */
  const metricText = (metric) => {
    if (!metric) return '（报表里没有这一项）'
    const value = metric.value
    if (value === null || value === undefined) return '（这一周没有被决定的人工门）'
    if (metric.unit === '分') return `${value} 分（${metric.display ?? ''}）`
    if (metric.unit === '秒') return `${value} 秒 · ${metric.gates ?? 0} 门`
    // 「包 / 份」这两个数按**账本行**算（同一包重复发布 = 多行）⇒ 一并给出**去重后**的个数，
    // 免得读者把「4 行」读成「发了 4 个包」
    if (metric.distinct_packages !== undefined) {
      return `${value} 行（${metric.distinct_packages} 个不同的包 id）`
    }
    if (metric.distinct_quotes !== undefined) return `${value} 份（${metric.distinct_quotes} 个不同的报价 id）`
    return `${value} ${metric.unit ?? ''}`.trim()
  }
  const weeklyBlocked = (ctx) => {
    const side = asText(ctx?.identity?.side)
    if (side === 'contractor') return null
    return { ok: true, kind: 'kv', degraded: true,
      reason: side === '' ? 'identity-required' : 'side-mismatch', items: [],
      next_action: side === ''
        ? '先登录承包商侧身份：周报读的是承包商侧账本（花出去的钱、发出去的包）'
        : '这一块只给承包商侧看：它汇总的是承包商侧账本的事实（供应商侧身份读不到）' }
  }

  out.push(surface.panel({ plugin_id: me, id: 'rfq.weekly', title: '本周汇报（发布包 / 收报价 / 授标金额 / 门等待 / 超时未回）',
    view: 'contractor', order: 18, kind: 'kv',
    // 报表类面板**声明占满整行**（机制给的 `placement: 'wide'` ⇒ 客户端 `grid-column: 1 / -1`）：
    // 默认的多列网格里一格只有 ~360-460px，口径长句与金额会挤成一条一条。
    placement: 'wide',
    hint: '数字由只读汇总器从本侧账本算出（不取墙钟：事实时刻 = 账本里最大的 ts，同一份账本任何时间跑都同一组数）；'
      + '每一项都带账本行号，下方「逐行对账」面板可逐行核；导出 TXT / CSV / 打印 HTML 在「导出 / 打印」区。'
      + '空档分得清：本周没有被决定的门 ⇒ 「平均等待」显示成「没有」而不是 0 秒；算不出来的行（缺量/缺价、'
      + '审批配不上对）不进小计（在下方表里单列为「对不上」）。',
    data: (ctx) => {
      const blocked = weeklyBlocked(ctx)
      if (blocked) return blocked
      const { json } = runWeekly()
      if (json.ok !== true) {
        return { ok: true, kind: 'kv', degraded: true, reason: json.code ?? 'weekly-failed',
          items: [], next_action: `${json.reason ?? ''}${json.next_action ? ` —— ${json.next_action}` : ''}` }
      }
      const metrics = json.metrics ?? {}
      const items = [
        { key: '周窗口（口径）', value: `${json.week?.iso ?? ''} · ${json.week?.start ?? ''} — ${json.week?.end ?? ''}`
          + `（ISO 周，周一 00:00Z 起，左闭右开）` },
        { key: '事实时刻 as_of', value: `${json.as_of}（${json.as_of_basis}，不取墙钟）`, code: true },
        { key: '账本（逐行对账用）', value: String(json.ledger ?? ''), code: true },
        ...WEEKLY_LABELS.map(([key, label]) => ({ key: label, value: metricText(metrics[key]) })),
        { key: '（附加）本周发 PO', value: `${json.supporting?.po_issued?.value ?? 0} 张 · 原生金额合计 `
          + `${json.supporting?.po_issued?.total_amount_native ?? '0'}` },
      ]
      if (weeksAgo() > 0) {
        items.push({ key: '看的不是本周', value: `你把它往前挪了 ${weeksAgo()} 周（动作「看哪一周」设的；`
          + '这是内存便签，重启服务后回到本周）' })
      }
      return { ok: true, kind: 'kv', items,
        counts: { packages: metrics.packages_published?.value ?? 0, quotes: metrics.quotes_received?.value ?? 0,
          award_amount_cents: metrics.award_amount_cents?.value ?? 0,
          gates: metrics.gate_avg_wait_seconds?.gates ?? 0, overdue: metrics.overdue_no_reply?.value ?? 0 },
        note: '这五个数不是界面算的：它们逐项由只读汇总器 `src/domain/rfq/tools/weekly-report.py` 从本侧账本'
          + '按 ISO 周聚合（口径写在同一份报表的 `metrics.*.basis`）。'
          + '⚠ 空档的两种含义分得清：`人工门平均等待` 为「没有门被决定」而不是 0 秒；'
          + '算不出来的行（缺量/缺价、配不上对的审批）不进小计：见 `amount_missing` / `gate_unmatched`（下方对账表里列出）。'
          + ` ${(json.notes ?? []).slice(-1)[0] ?? ''}` }
    } }))

  out.push(surface.panel({ plugin_id: me, id: 'rfq.weekly-lines', title: '本周汇报逐行对账（每一项 → 账本行号）',
    view: 'contractor', order: 19, kind: 'table',
    hint: '这一块是「报表凭什么」：每一行 = 一条支撑某个数字的账本事实（seq 就是账本行号 —— append-only '
      + '账本里那一行的位置，拿它回账本逐行核）；金额一律整数分。表里「对不上」的行是算不出来的'
      + '（缺量/缺价、审批配不上对）—— 它们被排除出小计、不冒充 0，单独列出来给你看。',
    data: (ctx) => {
      const blocked = weeklyBlocked(ctx)
      if (blocked) {
        return { ok: true, kind: 'table', degraded: true, reason: blocked.reason, rows: [],
          columns: [{ key: 'metric', label: '指标' }], next_action: blocked.next_action }
      }
      const { json } = runWeekly()
      if (json.ok !== true) {
        return { ok: true, kind: 'table', degraded: true, reason: json.code ?? 'weekly-failed', rows: [],
          columns: [{ key: 'metric', label: '指标' }],
          next_action: `${json.reason ?? ''}${json.next_action ? ` —— ${json.next_action}` : ''}` }
      }
      const evidence = json.evidence ?? {}
      const rows = []
      for (const item of evidence.packages_published ?? []) {
        rows.push({ id: `pk-${item.seq}`, metric: '① 发布包数', seq: item.seq, ts: item.ts, event: 'rfq/published',
          object: item.package_id, amount_cents: '', detail: `rev${item.rev} · 截止 ${item.quote_by}` })
      }
      for (const item of evidence.quotes_received ?? []) {
        rows.push({ id: `qt-${item.seq}`, metric: '② 收报价数', seq: item.seq, ts: item.ts, event: 'quote/submitted',
          object: item.quote_id, amount_cents: '',
          detail: `包 ${item.package_id} · ${item.line_count} 行 · ${item.supplier}` })
      }
      const awarded = readRows(evidence.award_amount_cents)
      for (const item of awarded.rows) {
        // 行数组同样走唯一入口：坏行逐条计数、好行照列（`line.item_id` 不再裸读）
        const lineRows = readRows(item.lines).rows
        for (const line of lineRows) {
          rows.push({ id: `aw-${item.seq}-${line.item_id}`, metric: '③ 授标金额', seq: item.seq, ts: item.ts,
            event: 'award/committed', object: `${item.award_id}:${line.item_id}`, amount_cents: line.amount_cents,
            detail: line.basis })
        }
        if (!lineRows.length) {
          rows.push({ id: `aw-${item.seq}-none`, metric: '③ 授标金额', seq: item.seq, ts: item.ts,
            event: 'award/committed', object: item.award_id, amount_cents: 0,
            detail: '这份承诺没有可算的行（见下方「对不上」）' })
        }
      }
      for (const item of evidence.gate_avg_wait_seconds ?? []) {
        rows.push({ id: `gt-${item.decided_seq}`, metric: '④ 人工门平均等待', seq: item.decided_seq, ts: item.decided_ts,
          event: item.decision, object: item.approval_id, amount_cents: '',
          detail: `${item.scope} · 等 ${item.wait_seconds} 秒（请求行 ${item.request_seq} @ ${item.request_ts}）` })
      }
      for (const item of evidence.overdue_no_reply ?? []) {
        rows.push({ id: `od-${item.seq}`, metric: '⑤ 超时未回', seq: item.seq, ts: item.ts, event: 'rfq/published',
          object: item.package_id, amount_cents: '',
          detail: `rev${item.rev} · 截止 ${item.quote_by} · 已超 ${item.overdue_days} 天` })
      }
      for (const item of json.amount_missing ?? []) {
        rows.push({ id: `missing-${item.seq}-${item.item_id ?? ''}`, metric: '对不上（不计入小计）', seq: item.seq,
          ts: '', event: 'award/committed', object: `${item.award_id}:${item.item_id ?? ''}`, amount_cents: '',
          detail: `算不出金额：${item.why}` })
      }
      for (const item of json.gate_unmatched ?? []) {
        rows.push({ id: `unmatched-${item.seq}`, metric: '对不上（不计入平均）', seq: item.seq, ts: item.ts,
          event: item.type, object: item.approval_id, amount_cents: '', detail: item.why })
      }
      for (const item of evidence.po_issued ?? []) {
        rows.push({ id: `po-${item.seq}`, metric: '（附加）本周发 PO', seq: item.seq, ts: item.ts,
          event: 'po/issued', object: item.po_id, amount_cents: '',
          detail: `${item.lines} 行 · 原生金额 ${item.total_amount}` })
      }
      if (!rows.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'this-week-is-empty', rows: [],
          columns: [{ key: 'metric', label: '指标' }],
          next_action: '这一周账本里没有任何相关事实（不是"界面坏了"）：换一周看（工具 `--weeks-ago 1`），'
            + '或先用「发布 RFQ」等动作产生事实' }
      }
      return { ok: true, kind: 'table',
        columns: [{ key: 'metric', label: '指标' }, { key: 'seq', label: '账本行号', filter: 'number' },
          { key: 'ts', label: '事实时刻', filter: 'date' }, { key: 'event', label: '事件' },
          { key: 'object', label: '对象', type: 'code' }, { key: 'amount_cents', label: '金额（分）', filter: 'number' },
          { key: 'detail', label: '口径 / 明细' }],
        rows, counts: { rows: rows.length, metrics: WEEKLY_LABELS.length, dropped: awarded.dropped },
        note: '`seq` 就是账本行号（append-only 账本里那一行的位置）—— 拿它回账本逐行核即可；'
          + '金额一律整数分；「对不上」的行走的是同一条口径说明，没有被算进任何小计。'
          + (awarded.dropped ? ` 另有 ${awarded.dropped} 条授标行读不出来（形状异常：不是对象）—— 已跳过并计数，不静默丢。` : '') }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'rfq.weekly-week', title: '看哪一周（周报往前挪几周）',
    views: ['contractor'], group: '发包', order: 45,
    hint: '只读：只改"周报看哪一周"这个内存便签（0=本周）；不写账本、不落文件',
    input: { fields: [
      { name: 'weeks_ago', label: '往前挪几周（0 = 本周）', type: 'number', required: true, min: 0, max: 52,
        help: '0 = 含事实时刻（账本最大 ts）的那一周；1 = 上一周' },
    ] },
    server: async (ctx, input) => {
      if (asText(ctx?.identity?.side) !== 'contractor') {
        return { ok: false, code: asText(ctx?.identity?.side) === '' ? 'identity-required' : 'side-mismatch',
          reason: '周报只对承包商侧（本侧账本）显示', ledger_added: 0,
          next_action: '用承包商侧身份登录后再看' }
      }
      const raw = Number(input.weeks_ago)
      if (!Number.isFinite(raw) || raw < 0 || raw > 52) {
        return { ok: false, code: 'weeks-out-of-range', reason: `往前挪的周数要在 0..52 之间（收到 ${input.weeks_ago}）`,
          ledger_added: 0, next_action: '给一个 0..52 的整数（0 = 本周）' }
      }
      host.note.set(me, WEEK_KEY, Math.floor(raw))
      const { json } = runWeekly()
      const metrics = json.metrics ?? {}
      return { ok: true, code: 'week-set', ledger_added: 0,
        result_kind: 'view-preference',
        note: `周报现在看：${json.week?.iso ?? '（算不出来）'} · ${json.week?.start ?? ''} — ${json.week?.end ?? ''}`
          + `（as_of ${json.as_of ?? '—'}，${json.as_of_basis ?? '—'}）`
          + ' —— 这一步只改内存便签（不是账本事实、不落文件）',
        next_action: '上方的「本周汇报」已按这一周重算；要发给别人就用「导出 / 打印」区的 TXT / CSV / HTML',
        result: { weeks_ago: Math.floor(raw), week: json.week ?? null, as_of: json.as_of ?? null,
          metrics: Object.fromEntries(WEEKLY_LABELS.map(([key]) => [key, metrics[key]?.value ?? null])),
          ledger: String(json.ledger ?? ''), ledger_added: 0 } }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'rfq.weekly-export', title: '导出周报（TXT / CSV / 可打印 HTML）',
    views: ['contractor'], group: '发包', order: 46,
    hint: '只读导出：内容由只读汇总器给出（文本与 CSV 是它自己渲染的那一份）⇒ 与屏幕上的数字逐字同源；账本零新增',
    input: { fields: [
      { name: 'format', label: '格式', type: 'select', required: true, options: ['csv', 'txt', 'html'],
        help: 'csv = 指标表（每行带证据账本行号）；txt = 人读周报正文（可直接贴邮件）；html = 自带样式的可打印文档' },
    ] },
    server: async (ctx, input) => {
      if (asText(ctx?.identity?.side) !== 'contractor') {
        return { ok: false, code: asText(ctx?.identity?.side) === '' ? 'identity-required' : 'side-mismatch',
          reason: '周报只对承包商侧（本侧账本）显示', ledger_added: 0,
          next_action: '用承包商侧身份登录后再导出' }
      }
      const format = asText(input.format)
      if (!['csv', 'txt', 'html'].includes(format)) {
        return { ok: false, code: 'unsupported-format', reason: `周报只导出 csv / txt / html（收到 ${format || '（空）'}）`,
          ledger_added: 0, next_action: '选 csv（指标表）、txt（人读正文）或 html（可打印）' }
      }
      const { json } = runWeekly()
      if (json.ok !== true) {
        return { ok: false, code: json.code ?? 'weekly-failed', ledger_added: 0,
          reason: json.reason ?? '只读汇总器没给出报表',
          next_action: json.next_action ?? '先看「本周汇报」面板上的降级原因' }
      }
      const week = `${json.week?.iso ?? ''}_${json.week?.start ?? ''}`
      const filename = `周报_${json.week?.iso ?? 'week'}_${(json.ledger || '').split('/').slice(-2, -1)[0] || 'ledger'}`
      // ---- txt / csv：**用报告里那两个字段**（工具自己渲染的那一份；界面侧不再抄一遍口径）----
      if (format === 'txt' || format === 'csv') {
        const content = String((format === 'txt' ? json.text : json.csv) ?? '')
        if (content === '') {
          return { ok: false, code: 'report-render-missing', ledger_added: 0,
            reason: `报表里没有 ${format} 渲染结果（工具版本可能比插件旧）`,
            next_action: `用 CLI 复跑一次确认：python3 ${WEEKLY_TOOL} --ledger <账本> --format ${format}` }
        }
        return { ok: true, code: 'weekly-exported', ledger_added: 0,
          note: `导出已生成（${format}，${json.week?.iso ?? ''}）：内容 = 只读汇总器对本侧账本的聚合结果`
            + `（每一项都带账本行号）`,
          next_action: format === 'txt'
            ? '下载/复制这份正文即可发给管理者；要表格就改用 csv（或打印 HTML）'
            : 'CSV 里「证据账本行号」那一列就是逐行对账的抓手；要给人看就用 txt 或打印 HTML',
          result: { export: { filename: `${filename}.${format}`,
            format,
            content_type: format === 'csv' ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8',
            content, rows: (json.evidence?.packages_published?.length ?? 0)
              + (json.evidence?.quotes_received?.length ?? 0) + (json.evidence?.award_amount_cents?.length ?? 0),
            columns: WEEKLY_LABELS.map(([, label]) => label),
            digest: `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`,
            source: `只读汇总器 ${WEEKLY_TOOL}（本侧账本 ${json.ledger ?? ''}；as_of ${json.as_of ?? ''}）`,
            ledger_refs: Object.values(json.evidence ?? {}).flat()
              .map((item) => item?.seq).filter((seq) => typeof seq === 'number').slice(0, 200) },
            week: json.week ?? null, as_of: json.as_of ?? null, ledger: String(json.ledger ?? ''),
            ledger_added: 0 } }
      }
      // ---- html：走外壳的**序列化**（内容仍由本插件生成：行来自同一份报表）----
      const metrics = json.metrics ?? {}
      const reported = host.report({ format: 'html', filename,
        title: '本周汇报', subtitle: `${json.week?.iso ?? ''} · ${json.week?.start ?? ''} — ${json.week?.end ?? ''}`
          + ` · 事实时刻 ${json.as_of ?? ''}（${json.as_of_basis ?? ''}）`,
        facts: WEEKLY_LABELS.map(([key, label]) => ({ key: label, value: metricText(metrics[key]) }))
          .concat([{ key: '（附加）本周发 PO', value: `${json.supporting?.po_issued?.value ?? 0} 张 · 原生金额合计 `
            + `${json.supporting?.po_issued?.total_amount_native ?? '0'}` },
          { key: '账本', value: String(json.ledger ?? '') }]),
        columns: [{ key: 'metric', label: '指标' }, { key: 'seq', label: '账本行号' }, { key: 'ts', label: '事实时刻' },
          { key: 'event', label: '事件' }, { key: 'object', label: '对象' },
          { key: 'amount_cents', label: '金额（分）' }, { key: 'detail', label: '口径 / 明细' }],
        rows: [].concat(
          (json.evidence?.packages_published ?? []).map((item) => ({ metric: '① 发布包数', seq: item.seq,
            ts: item.ts, event: 'rfq/published', object: item.package_id, amount_cents: '',
            detail: `rev${item.rev} · 截止 ${item.quote_by}` })),
          (json.evidence?.quotes_received ?? []).map((item) => ({ metric: '② 收报价数', seq: item.seq,
            ts: item.ts, event: 'quote/submitted', object: item.quote_id, amount_cents: '',
            detail: `包 ${item.package_id} · ${item.line_count} 行` })),
          (json.evidence?.award_amount_cents ?? []).flatMap((item) => (item.lines ?? []).map((line) =>
            ({ metric: '③ 授标金额', seq: item.seq, ts: item.ts, event: 'award/committed',
              object: `${item.award_id}:${line.item_id}`, amount_cents: line.amount_cents, detail: line.basis }))),
          (json.evidence?.gate_avg_wait_seconds ?? []).map((item) => ({ metric: '④ 人工门平均等待',
            seq: item.decided_seq, ts: item.decided_ts, event: item.decision, object: item.approval_id,
            amount_cents: '', detail: `${item.scope} · 等 ${item.wait_seconds} 秒（请求行 ${item.request_seq}）` })),
          (json.evidence?.overdue_no_reply ?? []).map((item) => ({ metric: '⑤ 超时未回', seq: item.seq,
            ts: item.ts, event: 'rfq/published', object: item.package_id, amount_cents: '',
            detail: `截止 ${item.quote_by} · 已超 ${item.overdue_days} 天` })),
          (json.amount_missing ?? []).map((item) => ({ metric: '对不上（不计入小计）', seq: item.seq, ts: '',
            event: 'award/committed', object: `${item.award_id}:${item.item_id ?? ''}`, amount_cents: '',
            detail: `算不出金额：${item.why}` })),
          (json.gate_unmatched ?? []).map((item) => ({ metric: '对不上（不计入平均）', seq: item.seq, ts: item.ts,
            event: item.type, object: item.approval_id, amount_cents: '', detail: item.why })),
          (json.evidence?.po_issued ?? []).map((item) => ({ metric: '（附加）本周发 PO', seq: item.seq, ts: item.ts,
            event: 'po/issued', object: item.po_id, amount_cents: '',
            detail: `${item.lines} 行 · 原生金额 ${item.total_amount}` }))),
        notes: ['每一项的「账本行号」就是 append-only 账本里那一行的位置 ⇒ 可逐行回账本核。',
          '算不出来的行（缺量/缺价、审批配不上对）没有被算进任何小计：它们单独列出来。',
          '报表不取墙钟：事实时刻 = 账本里最大的 ts（同一份账本在任何时间跑都得到同一组数）。'],
        report_id: 'rfq.weekly', source: `quotagent · 本周汇报（只读汇总器 ${WEEKLY_TOOL}）`,
        generated_at: json.as_of ?? '' })
      if (!reported.ok) return { ...reported, ledger_added: 0 }
      return { ok: true, code: 'weekly-exported', ledger_added: 0, note: reported.note,
        next_action: 'HTML 可以直接打印（浏览器打印对话框里可另存 PDF）——表里的行号可逐行回账本核',
        result: { ...reported.result, week: json.week ?? null, as_of: json.as_of ?? null,
          ledger: String(json.ledger ?? ''), ledger_added: 0 } }
    } }))

  out.push(surface.report({ plugin_id: me, id: 'report.weekly', title: '本周汇报（TXT / CSV / 打印）',
    views: ['contractor'], order: 20, action: 'rfq.weekly-export', formats: ['csv', 'txt', 'html'],
    hint: '导出的是同一份只读报表：csv = 指标表（带证据账本行号）、txt = 人读正文、html = 可打印文档；'
      + '内容由 `domain/rfq` 的 `rfq.weekly-export` 生成（外壳只做序列化）',
    columns: [{ key: 'metric', label: '指标' }, { key: 'value', label: '数值' }, { key: 'unit', label: '单位' },
      { key: 'basis', label: '口径' }, { key: 'rows', label: '证据账本行号' }, { key: 'extra', label: '附加读数' }] }))

  out.push(surface.panel({ plugin_id: me, id: 'rfq.responses', title: '收到的报价（本侧登记行）',
    view: 'contractor', order: 20, kind: 'table',
    actions: ['compare.rank', 'award.propose'],
    hint: '每一行 = 一条（报价 × 行项目）登记；行内「提出授标意向」把这一行的包/报价/条目/数量/单价带进表单'
      + '（数量取自包事实 —— 缺量就会被唯一写者按 line-qty-invalid 拒）',
    data: () => {
      const rows = rowsOfType(host.rows('contractor'), 'quote/submitted').map((row) => bodyOf(row))
      if (!rows.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-quote-submitted',
          next_action: '等供应商在 APP 里备报价并人签提交（提交会同时在本侧登记一条）',
          columns: [{ key: 'quote_id', label: '报价' }], rows: [] }
      }
      const qtyIndex = itemQtyIndex(host.rows('contractor'))
      // **逐行展开**：一份报价可以有多行（`lines[]`，口径见 29 §7.5：多行报价没有"唯一那个行项目"）。
      // 面板自述就是"每一行 = 一条（报价 × 行项目）登记"—— 多行报价却展成空 item_id/单价的一行时，
      // 行内「提出授标意向」就没有可预填的条目/单价（手机上等于让人手抄 id 与金额）。这里按 `lines[]` 展开。
      const table = rows.flatMap((row) => {
        const quoteId = asText(row.quote_id)
        const packageId = asText(row.package_id)
        const lines = Array.isArray(row.lines) && row.lines.length ? row.lines
          : [{ item_id: row.item_id, unit_price_cents: row.unit_price_cents,
            lead_time_days: row.lead_time_days }]
        return lines.map((line) => {
          const itemId = asText(line.item_id ?? line.id)
          const known = qtyIndex.get(`${packageId}#${itemId}`) ?? null
          return { id: `${quoteId}#${itemId}`, quote_id: quoteId, supplier: row.supplier ?? '',
            package_id: packageId, item_id: itemId, description: line.description ?? '',
            qty: known ? known.qty : null, unit: known ? known.unit : '',
            qty_source: known ? known.source : '（包事实里读不到这一条的量）',
            unit_price_cents: line.unit_price_cents ?? row.unit_price_cents,
            lead_time_days: line.lead_time_days ?? row.lead_time_days,
            line_count: lines.length, submitted_at: row.submitted_at,
            ref: { kind: 'quote', id: quoteId, title: `报价 ${quoteId}` } }
        })
      })
      const missing = table.filter((row) => row.qty === null).length
      return { ok: true, kind: 'table',
        columns: [{ key: 'quote_id', label: '报价', type: 'code' }, { key: 'supplier', label: '供应商', filter: 'enum' },
          { key: 'item_id', label: '行项目', type: 'code' }, { key: 'qty', label: '数量（来自包事实）', filter: 'number' },
          { key: 'unit', label: '单位' }, { key: 'unit_price_cents', label: '单价（整数分）', filter: 'number' },
          { key: 'lead_time_days', label: '交期（天）', filter: 'number' }, { key: 'line_count', label: '这份报价共几行', filter: 'number' },
          { key: 'submitted_at', label: '提交时刻', filter: 'date' },
          { key: 'qty_source', label: '量的来源' }],
        rows: table, bulk: 'compare.rank',
        counts: { quotes: rows.length, lines: table.length, qty_known: table.length - missing },
        note: '一份报价可以有多行（`lines[]`）：这里逐行列，行内「提出授标意向」把这一行的包/报价/条目/'
          + '数量/单价带进表单（多行报价没有"唯一那个行项目"，所以必须逐行给入口）。'
          + '数量取自包事实（发布事实 / 投递快照的 `spec.items`，并按 `rfq/amended` 取最新一版）；'
          + '意向不产生义务，可撤回。'
          + (missing ? ` 有 ${missing} 行读不到量（数量列显示「—」）：现在提意向会被唯一写者按 \`line-qty-invalid\` 拒，`
            + '先在「包的行项目」里把这一包的条目补上（或让供应商按最新一版重报）。' : '') }
    } }))

  // ---- 工作台（首屏「我今天要做什么」）----------------------------------------------------------
  out.push(surface.panel({ plugin_id: me, id: 'home.rfq-todo', title: '承包商侧：我今天要做什么',
    view: 'home', order: 20, kind: 'list', not_data: true,
    data: (ctx) => {
      const rows = host.rows('contractor')
      const packages = rowsOfType(rows, 'rfq/published').map((row) => bodyOf(row))
      const quotes = rowsOfType(rows, 'quote/submitted').map((row) => bodyOf(row))
      const items = []
      items.push(sideScoped(ctx, 'contractor', { level: packages.length ? 'info' : 'warn',
        title: packages.length ? `承包商侧：已发布 ${packages.length} 个包` : '承包商侧：还没有发布任何 RFQ',
        body: packages.slice(-1).map((row) => `${row.package_id} rev${row.rev}（截止 ${row.quote_by ?? '—'}）`).join(''),
        next_action: packages.length ? '点按钮看最新那一包的对象页（可复制分享）' : '用「发布 RFQ」发一包（不产生对外义务）',
        action: 'rfq.publish', label: packages.length ? '再发一包' : '发布 RFQ',
        ref: packages.length ? { kind: 'package', id: asText(packages[packages.length - 1].package_id) } : null }))
      items.push(sideScoped(ctx, 'contractor', { level: quotes.length ? 'ok' : 'warn',
        title: quotes.length ? `承包商侧：收到 ${quotes.length} 条报价登记` : '承包商侧：还没有收到报价',
        body: quotes.slice(0, 3).map((row) => `${row.quote_id}：${row.item_id} @ ${row.unit_price_cents} 分`).join('；'),
        next_action: quotes.length ? '去比价（可调权重，贡献可解释）→ 授标（人签）' : '等供应商人签提交',
        action: quotes.length ? 'compare.rank' : '', label: '用当前权重排一次' }))
      return { ok: true, kind: 'list', items }
    } }))

  // ---- **对象页**：`/app/contractor/package/<pkg-id>/`（一个包的全部事实：rev / 条目 / 收件人 / 回应 / 截止） ----
  out.push(surface.panel({ plugin_id: me, id: 'package.object', title: '包（对象页：一屏事实）',
    view: 'contractor', order: 12, kind: 'kv', object_kind: 'package',
    data: (ctx) => {
      const packageId = asText(ctx.route?.id)
      const rows = host.rows('contractor')
      const published = rowsOfType(rows, 'rfq/published').map((row) => ({ ...bodyOf(row), ts: row.ts }))
        .filter((row) => asText(row.package_id) === packageId)
      if (!published.length) {
        return { ok: true, kind: 'kv', object: { found: false, title: `包 ${packageId}`,
          reason: 'package-not-in-my-view',
          next_action: '这个包不在承包商侧账本的投影里：回「已发布的 RFQ」表，点行内「打开 →」用真实存在的深链' },
          items: [] }
      }
      const latest = published[published.length - 1]
      const rev = Number(latest.rev ?? 0)
      const snapshot = snapshotOfPackage(packageId)
      const invited = (snapshot?.invited ?? []).map(String)
      const quotes = rowsOfType(rows, 'quote/submitted').map((row) => bodyOf(row))
        .filter((row) => asText(row.package_id) === packageId)
      const answered = [...new Set(quotes.map((quote) => asText(quote.supplier)))].filter(Boolean)
      const deadlines = (snapshot?.spec?.deadlines ?? snapshot?.deadlines ?? {})
      return { ok: true, kind: 'kv',
        object: { title: `包 ${packageId} rev${rev}`, subtitle: latest.subject ? String(latest.subject) : '',
          found: true,
          facts: [
            { key: '版本', value: `rev${rev}（共 ${published.length} 个版本事实）` },
            { key: '条目数', value: String(latest.items ?? (snapshot?.spec?.items ?? []).length) },
            { key: '报价截止', value: asText(latest.quote_by) || asText(deadlines.quote_by) || '—' },
            { key: '已回 / 邀请', value: `${answered.length} / ${invited.length || '—'}` },
            { key: '快照哈希', value: String(latest.hash ?? ''), code: true },
          ],
          links: [
            ...quotes.slice(0, 8).map((quote) => ({ kind: 'quote', id: asText(quote.quote_id),
              title: `报价 ${quote.quote_id}（${asText(quote.supplier)}）` })),
          ].filter((link) => link.id !== '') },
        items: [
          { key: '收件人（谁收到了）', value: invited.join(' ') || '（快照里没有名单）' },
          { key: '已回（谁报了价）', value: answered.join(' ') || '（还没人回）' },
          { key: '还没回', value: invited.filter((who) => !answered.includes(who)).join(' ') || '（都回了）' },
          { key: '上一版时间', value: String(latest.ts ?? '') },
        ],
        note: `这一页只读本侧事实；催报/发新版的入口在承包商道的工具栏与「回文时限」表（都要人签）。`
          + ` 深链可以直接发给同事：${host.prefix}/app/contractor/package/${encodeURIComponent(packageId)}/` }
    } }))

  out.push(surface.panel({ plugin_id: me, id: 'package.items', title: '包的行项目（rev 快照）',
    view: 'contractor', order: 13, kind: 'table', object_kind: 'package',
    data: (ctx) => {
      const packageId = asText(ctx.route?.id)
      const snapshot = snapshotOfPackage(packageId)
      const items = Array.isArray(snapshot?.spec?.items) ? snapshot.spec.items : []
      if (!items.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'package-snapshot-missing',
          next_action: '本机读不到这个包的快照文件：发布时唯一写者会把 `<ui-shared>/contractor/rfq-<包>-rev<n>.json`'
            + ' 落盘；读不到就如实降级（不编条目）',
          columns: [{ key: 'item_id', label: '行项目' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        columns: [{ key: 'item_id', label: '行项目', type: 'code' }, { key: 'description', label: '描述' },
          { key: 'unit', label: '单位' }, { key: 'qty', label: '数量' }],
        rows: items.map((item) => ({ id: String(item.item_id), item_id: item.item_id,
          description: item.description ?? '', unit: item.unit ?? '', qty: item.qty })),
        counts: { items: items.length },
        note: '行项目来自发布时落盘的快照文件（唯一写者写的），不是界面自己拼的' }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'rfq.publish', title: '发布 RFQ', views: ['contractor'],
    group: '发包', order: 10, icon: 'rocket', confirm: { required: true,
      message: '发布即对受邀供应商可见（可再发新版修订）；确认发布？' },
    hint: '行项目一行一条：`item_id,描述,单位,数量`；邀请对象写 realm（如 supplier:g1）',
    input: { fields: [
      { name: 'package_id', label: '包 id', type: 'text', required: true, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$',
        // **`new_value`**（机制声明）：这个 id 是**人自己起的新名字**（要新建的就是这一包），不是引用已有对象 ——
        // 不声明的话外壳会按"引用标识"算（`*_id` 的必填字段默认要有上下文），把这一颗从工具栏上摘下去。
        new_value: true,
        help: '字母数字开头，可含 . _ -（自己起一个，例如 pkg-2026-001）' },
      { name: 'subject', label: '标题', type: 'text', required: true, help: '一句话说明这一包是什么' },
      { name: 'currency', label: '币种', type: 'text', default: 'CNY' },
      { name: 'quote_by', label: '报价截止（ISO8601）', type: 'text', required: true,
        pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$', help: '如 2026-09-30T00:00:00Z' },
      { name: 'clarify_by', label: '澄清截止（可空）', type: 'text', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$' },
      { name: 'items', label: '行项目（每行：item_id,描述,单位,数量）', type: 'textarea', required: true,
        help: '例：L-001,DN100 管道,m,120' },
      { name: 'invited', label: '邀请对象（逗号分隔的 realm）', type: 'text', required: true,
        help: '例：supplier:g1' },
      { name: 'note', label: '备注（可选；只留 sha256 进待办件）', type: 'textarea' },
      { name: 'actor', label: '发言人', type: 'text', required: true, identity: true, help: 'human:<你的名字>（发包也要有人认领）' },
    ] },
    server: async (ctx, input) => {
      const parsed = parseItems(input.items)
      if (parsed.problems.length) {
        return { ok: false, code: 'validation-failed', errors: parsed.problems.map((item) => ({
          field: 'items', code: item.code, message: item.message, next_action: '按每行的正确写法改后重提' })),
          next_action: '行项目每行要写 `item_id,描述,单位,数量`（4 段）' }
      }
      const invited = parseList(input.invited)
      const actor = asText(input.actor)
      if (!actor.startsWith('human:')) {
        return { ok: false, code: 'human-required', reason: '发包的发言人必须以 human: 开头（agent 不得代人发包）',
          next_action: '写 human:<你的名字>' }
      }
      const staged = host.stage('rfq-publish', { kind: 'rfq-publish', action: 'publish', view: 'contractor',
        package_id: asText(input.package_id), subject: asText(input.subject),
        currency: asText(input.currency) || 'CNY', quote_by: asText(input.quote_by),
        clarify_by: asText(input.clarify_by), items: parsed.items, invited,
        actor, note: String(input.note ?? '') })
      if (!staged.ok) return staged
      const args = ['--request', staged.path, '--ui-shared', host.sharedDir,
        '--ledger-contractor', ledger(), '--ledger-supplier', asText(host.config?.ledger_supplier),
        '--now', host.now(), '--actor', actor]
      if (asText(host.config?.rfq_delivery)) args.push('--delivery', asText(host.config.rfq_delivery))
      const run = host.runPython('src/domain/rfq/tools/rfq-publish.py', args)
      const json = run.json ?? {}
      return { ok: run.ok && json.ok === true, code: json.refusal?.code ?? (run.ok ? 'published' : 'writer-failed'),
        reason: json.refusal?.reason ?? run.reason ?? '',
        next_action: json.next_action ?? (run.ok ? '包已发布并被分发：供应商道的「我的 RFQ 包」能看到它'
          : '看 stdout/stderr 定位唯一写者的拒绝原因（账本零新增）'),
        result: { pending: staged.file, package_id: json.package_id ?? staged.record.package_id,
          rev: json.rev ?? null, applied: json.applied ?? [], duplicates: json.duplicates ?? [],
          ledger_added: json.ledger_added ?? 0, delivery: json.delivery ?? null, writer: run.json ?? null,
          stdout: run.stdout ? run.stdout.slice(-500) : '' } }
    } }))

  out.push(surface.shortcut({ plugin_id: me, id: 'shortcut.rfq-publish', keys: 'p', action: 'rfq.publish',
    title: '发布 RFQ', order: 10 }))

  out.push(surface.statusItem({ plugin_id: me, id: 'status.rfq', title: '发包', order: 10, read: () => {
    const rows = host.rows('contractor')
    const packages = new Set(rowsOfType(rows, 'rfq/published').map((row) => asText(bodyOf(row).package_id)))
    const quotes = rowsOfType(rows, 'quote/submitted').length
    return { text: `${packages.size} 个包 · ${quotes} 条报价登记`, level: packages.size ? 'ok' : 'warn',
      next_action: packages.size ? '' : '还没有发布任何 RFQ' }
  } }))

  out.push(surface.notificationSource({ plugin_id: me, id: 'notify.rfq', title: '发包与回应', order: 10,
    poll: () => {
      const rows = host.rows('contractor')
      const published = rowsOfType(rows, 'rfq/published').map((row) => bodyOf(row))
      const quotes = rowsOfType(rows, 'quote/submitted').map((row) => bodyOf(row))
      const items = []
      for (const row of published) {
        items.push({ id: `rfq:${row.package_id}`, level: 'info', at: String(row.ts ?? ''),
          title: `包 ${row.package_id} 已发布（rev${row.rev}）`,
          body: `报价截止 ${row.quote_by ?? '—'}；条目 ${row.items ?? '—'}`,
          next_action: '等回应；催报见「回文时限」页',
          ref: { view: 'contractor', kind: 'package', id: String(row.package_id),
            title: `包 ${row.package_id}` } })
      }
      if (!quotes.length && published.length) {
        items.push({ id: 'rfq:no-quotes', level: 'warn', at: '',
          title: '还没有收到任何报价登记', body: '被邀供应商尚未提交',
          next_action: '在供应商道确认对方能看到包（「我的 RFQ 包」面板）' })
      }
      return items
    } }))

  // ------------------------------------------------------------------ 催报（DEF-013）
  const remindTool = 'src/domain/rfq/tools/rfq-remind.py'
  const clarifyTool = 'src/domain/rfq/tools/rfq-clarify-apply.py'
  const REMIND_PREFIX = '催报：'

  const packageFacts = (view) => {
    const rows = host.rows(view)
    const published = rowsOfType(rows, 'rfq/published').map((row) => ({ ...bodyOf(row), ts: row.ts }))
    const distributed = rowsOfType(rows, 'rfq/distributed')
    const quotes = rowsOfType(rows, 'quote/submitted').map((row) => bodyOf(row))
    const reminders = rowsOfType(rows, 'mail/queued').map((row) => ({ ...bodyOf(row), ts: row.ts }))
      .filter((row) => asText(row.subject).startsWith(REMIND_PREFIX))
    return { rows, published, distributed, quotes, reminders }
  }
  const recipientsOf = (distributed, packageId) => {
    const out2 = new Set()
    for (const row of distributed) {
      const body = bodyOf(row)
      if (asText(body.package_id) !== packageId) continue
      for (const who of body.recipients ?? []) out2.add(String(who))
    }
    return [...out2].sort()
  }
  const snapshotOfPackage = (packageId) => {
    for (const rev of [5, 4, 3, 2, 1]) {
      const data = host.readJson(`${host.sharedDir}/contractor/rfq-${packageId}-rev${rev}.json`)
      if (data) return data
    }
    return null
  }

  /**
   * **包的行项目量目录**（`"<包>#<条目>" → {qty, unit, source}`）：给「收到的报价」表带出 `qty`，
   * 使「从这一行提授标意向」这条链能真走通（唯一写者 `commitment-apply.py --step propose` 要求行项目
   * 逐条给量 + 整数分单价，缺量就会被**有名拒绝** `line-qty-invalid`）。
   *
   * 量的来源只取**本侧事实与投递快照**（不编数据、不猜）：
   *   ① `rfq/published` 的 `items` 是数组时（新写者）直接用；
   *   ② 投递信封（`--rfq-delivery` 那一份，本侧收到的）里的 `spec.items`；
   *   ③ 逐版快照文件 `<ui_shared>/contractor/rfq-<包>-rev<n>.json` 的 `spec.items`（①③ 都缺时的兜底）；
   *   ④ 最后按 `rfq/amended` 的 `deltas`（`field=qty`）覆盖 —— **最新一版为准**（升版改量的包不会拿旧量去授标）。
   * 读不到量 ⇒ 该行 `qty` 为 `null`（面板如实标「—」并说明会被谁拒），绝不填一个假数量。
   */
  const itemQtyIndex = (rows) => {
    const index = new Map()
    const key = (packageId, itemId) => `${packageId}#${itemId}`
    const put = (packageId, item, source) => {
      const itemId = asText(item?.item_id)
      const qty = Number(item?.qty)
      if (packageId === '' || itemId === '' || !Number.isFinite(qty)) return
      index.set(key(packageId, itemId), { qty, unit: asText(item?.unit), source })
    }
    const packages = new Set()
    for (const row of rowsOfType(rows, 'rfq/published')) {
      const body = bodyOf(row)
      const packageId = asText(body.package_id)
      if (packageId === '') continue
      packages.add(packageId)
      for (const item of (Array.isArray(body.items) ? body.items : [])) put(packageId, item, 'rfq/published')
    }
    const delivery = asText(host.config?.rfq_delivery)
    if (delivery !== '') {
      const raw = host.readJson(delivery)
      for (const envelope of (Array.isArray(raw) ? raw : (raw ? [raw] : []))) {
        const spec = envelope && typeof envelope.spec === 'object' && envelope.spec !== null ? envelope.spec : {}
        const packageId = asText(spec.package_id)
        for (const item of (Array.isArray(spec.items) ? spec.items : [])) put(packageId, item, 'delivery-envelope')
      }
    }
    for (const packageId of packages) {
      const snapshot = snapshotOfPackage(packageId)
      const items = snapshot && typeof snapshot.spec === 'object' && snapshot.spec !== null
        && Array.isArray(snapshot.spec.items) ? snapshot.spec.items : []
      for (const item of items) {
        if (!index.has(key(packageId, asText(item?.item_id)))) put(packageId, item, 'rfq-snapshot')
      }
    }
    for (const row of rowsOfType(rows, 'rfq/amended')) {
      const body = bodyOf(row)
      const packageId = asText(body.package_id)
      for (const delta of (Array.isArray(body.deltas) ? body.deltas : [])) {
        if (asText(delta?.field) !== 'qty') continue
        const itemId = asText(delta?.item_id)
        const qty = Number(delta?.after)
        if (itemId === '' || !Number.isFinite(qty)) continue
        const previous = index.get(key(packageId, itemId)) ?? { unit: '' }
        index.set(key(packageId, itemId), { qty, unit: previous.unit, source: 'rfq/amended' })
      }
    }
    return index
  }
  const remindNotices = () => {
    const data = host.readJson(`${host.sharedDir}/exchange/reminders.json`)
    return data && Array.isArray(data.reminders) ? data.reminders : []
  }

  out.push(surface.panel({ plugin_id: me, id: 'rfq.remind-board', title: '回文时限与催报（谁没回 / 已催几次）',
    view: 'contractor', order: 15, kind: 'table', actions: ['rfq.remind'],
    data: () => {
      const { published, distributed, quotes, reminders } = packageFacts('contractor')
      if (!published.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-published-rfq',
          next_action: '先用「发布 RFQ」发一包（发布不产生对外义务）', columns: [{ key: 'package_id', label: '包' }], rows: [] }
      }
      const moment = published.map((row) => String(row.ts ?? '')).sort().pop() ?? ''
      const rows = published.map((row) => {
        const packageId = asText(row.package_id)
        const snapshot = snapshotOfPackage(packageId)
        const deadlines = (snapshot && snapshot.spec ? snapshot.spec.deadlines : null) ?? snapshot?.deadlines ?? {}
        const quoteBy = asText(row.quote_by) || asText(deadlines.quote_by)
        const hoursLeft = quoteBy && moment
          ? Math.round(((Date.parse(quoteBy) - Date.parse(moment)) / 3600000) * 100) / 100 : null
        const invited = (snapshot?.invited ?? recipientsOf(distributed, packageId)).map(String)
        const answered = new Set(quotes.filter((quote) => asText(quote.package_id) === packageId)
          .map((quote) => asText(quote.supplier)))
        const mine = reminders.filter((item) => asText(item.package_id) === packageId)
        const notReplied = invited.filter((who) => !answered.has(who))
        return { id: `${packageId}#r${row.rev}`, package_id: packageId, rev: row.rev, quote_by: quoteBy,
          hours_left: hoursLeft, invited: invited.join(' '), replied: [...answered].join(' ') || '（还没人回）',
          not_replied: notReplied.join(' ') || '（都回了）', recipients: notReplied.join(' '),
          remind_count: mine.length, last_remind_at: mine.map((item) => String(item.ts ?? '')).sort().pop() ?? '',
          mail_kind: mine.length ? asText(mine[mine.length - 1].kind) : '' }
      })
      return { ok: true, kind: 'table',
        columns: [
          { key: 'package_id', label: '包', type: 'code' }, { key: 'rev', label: 'rev', filter: 'number' },
          { key: 'quote_by', label: '报价截止', filter: 'date' }, { key: 'hours_left', label: '距截止（小时，按事实时刻）', filter: 'number' },
          { key: 'invited', label: '邀请' }, { key: 'replied', label: '已回' },
          { key: 'not_replied', label: '还没回' }, { key: 'remind_count', label: '已催次数', filter: 'number' },
          { key: 'last_remind_at', label: '最后一次催报 @ts', filter: 'date' },
        ],
        rows, row_actions: ['rfq.remind'], counts: { packages: rows.length,
          not_replied: rows.reduce((sum, row) => sum + (row.not_replied.startsWith('（') ? 0 : row.not_replied.split(' ').length), 0) },
        note: `事实时刻 ${moment || '—'} · 勾选若干行（或行内）点「催报」：落本侧 \`mail/queued\`（催报本体）+`
          + `对方账本 \`mail/queued\`（对方可见）；临近/已过截止会另落 \`rfq/due-soon\`|\`rfq/overdue\`；`
          + `邮件通道不可用时绝不假装已发（如实报 mail-smtp-unconfigured，可复制正文文件）` }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'rfq.remind', title: '催报（一键 · 真落账 · 给对方出通知）',
    views: ['contractor'], group: '发包', order: 20, permission: 'human-signature', inline: true,
    confirm: { required: true, message: '催报会落账并给对方出通知（不是承诺、也不假装已发信）：确认？' },
    hint: '收件人默认「还没回的」；落 mail/queued（两侧）+ 临近/已过截止时落 rfq/due-soon|overdue；'
      + '通知正文只留 sha256 进账本，可读的一份在 exchange/reminders.json',
    input: { bulk: 'ids', fields: [
      { name: 'package_id', label: '包 id', type: 'text', required: true, help: '从表格行里取' },
      { name: 'rev', label: '版本 rev', type: 'number', min: 1, help: '空=最新已发布版本' },
      { name: 'recipients', label: '收件人（逗号分隔 realm；空=表格里「还没回」那几位）', type: 'text' },
      { name: 'subject', label: '主题', type: 'text', help: '默认「催报：<包 id>」' },
      { name: 'soon_hours', label: '临近阈值（小时）', type: 'number', min: 0, max: 8760, default: 48,
        help: '距截止小于它才算「临近」，会另落 rfq/due-soon' },
      { name: 'letter', label: '催报正文', type: 'textarea', required: true,
        help: '只留 sha256 进账本；不得含凭据/私域字段' },
      { name: 'signature', label: '催报人（人签）', type: 'signature', required: true, help: 'human:<你的名字>' },
    ] },
    server: async (ctx, input) => {
      const recipients = String(input.recipients ?? '').split(/[,\s]+/).map((piece) => piece.trim()).filter(Boolean)
      const letter = String(input.letter ?? '')
      if (letter.trim() === '') {
        return { ok: false, code: 'empty-note', reason: '催报正文为空：对方要能看懂你要他做什么',
          next_action: '写一句话再催' }
      }
      const staged = host.stage('rfq-remind', { kind: 'rfq-remind', action: 'remind', view: 'contractor',
        package_id: asText(input.package_id), rev: input.rev === undefined || input.rev === '' ? null : Number(input.rev),
        recipients, subject: asText(input.subject), soon_hours: Number(input.soon_hours ?? 48),
        actor: asText(input.signature), note: letter })
      if (!staged.ok) return staged
      const run = host.runPython(remindTool, ['--request', staged.path, '--ui-shared', host.sharedDir,
        '--ledger-contractor', asText(host.config?.ledger_contractor),
        '--ledger-supplier', asText(host.config?.ledger_supplier), '--now', host.now()])
      const json = run.json ?? {}
      return { ok: run.ok && json.ok === true, code: json.refusal?.code ?? (json.ok ? 'reminded' : 'writer-failed'),
        reason: json.refusal?.reason ?? run.reason ?? '',
        next_action: json.refusal?.next_action ?? json.next_action_runtime ?? '看 result 里的落账与传输状态',
        result: { pending: staged.file, package_id: json.package_id ?? null, rev: json.rev ?? null,
          recipients: json.recipients ?? [], applied: json.applied ?? [], fired: json.fired ?? [],
          ledger_added: json.ledger_added ?? 0, mail_transport: json.mail_transport ?? null,
          notices: json.notices ?? null, supplier_notice: json.supplier_notice ?? null } }
    } }))

  out.push(surface.panel({ plugin_id: me, id: 'rfq.remind-notices', title: '承包商给我的催报（对方通知）',
    view: 'supplier', order: 55, kind: 'table',
    data: () => {
      const letters = remindNotices()
      const rows = []
      for (const row of rowsOfType(host.rows('supplier'), 'mail/')) {
        const body = bodyOf(row)
        const subject = asText(body.subject)
        if (!subject.startsWith(REMIND_PREFIX)) continue
        const letter = (letters.filter((item) => asText(item.package_id) === asText(body.package_id)
          && asText(item.subject) === subject).slice(-1)[0] ?? {}).letter ?? ''
        rows.push({ id: `${body.message_id ?? ''}-${row.ts ?? ''}`, at: row.ts ?? '', subject,
          package_id: asText(body.package_id), rfq_rev: body.rfq_rev, letter,
          body_sha256: asText(body.body_sha256) })
      }
      if (!rows.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-reminder',
          next_action: '还没收到催报；快到截止还没回时对方会催', columns: [{ key: 'subject', label: '通知' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        columns: [{ key: 'at', label: '收到时刻' }, { key: 'subject', label: '主题', type: 'code' },
          { key: 'package_id', label: '包', type: 'code' }, { key: 'rfq_rev', label: 'rev' },
          { key: 'letter', label: '对方原话' }, { key: 'body_sha256', label: '正文哈希', type: 'code' }],
        rows, counts: { reminders: rows.length },
        note: '通知是"入队"事实（`mail/queued`）：不代表邮件真的发出（本机没有 SMTP 凭据时如实为 refused）' }
    } }))

  // ------------------------------------------------------------------ 澄清单据（DEF-014）
  const ticketsOf = (rows) => {
    const map = new Map()
    const order = []
    for (const row of rows) {
      const type = String(row?.type ?? '')
      if (!type.startsWith('clarification/')) continue
      const body = bodyOf(row)
      const id = asText(body.ticket_id)
      if (!id) continue
      if (!map.has(id)) order.push(id)
      const previous = map.get(id) ?? { ticket_id: id, status: 'open', question: '', refs: [], rfq_rev: null,
        package_id: '', asker_realm: '', answer: null, broadcast_to: [], created_at: String(row.ts ?? ''),
        answered_at: '', closed_at: '', mirror: false }
      const next = { ...previous }
      if (type === 'clarification/asked') {
        if (body.question) next.question = String(body.question)
        if (body.refs) next.refs = body.refs.item_ids ?? previous.refs
        if (body.rfq_rev) next.rfq_rev = body.rfq_rev
        if (body.package_id) next.package_id = String(body.package_id)
        if (body.asker_realm) next.asker_realm = String(body.asker_realm)
        if (asText(body.status) === 'closed') { next.status = 'closed'; next.closed_at = String(row.ts ?? '') }
        else if (asText(body.status) === 'open' && body.question) next.status = 'open'
      } else if (type === 'clarification/answered') {
        if (body.text !== undefined && body.text !== null) {
          next.answer = String(body.text)
          next.answered_at = String(row.ts ?? '')
          if (next.status !== 'closed') next.status = 'answered'
        }
        if (body.broadcast_to) { next.broadcast_to = body.broadcast_to.map(String) }
      } else if (type === 'clarification/reopened') {
        next.status = 'open'
        next.answer = previous.answer
      }
      next.mirror = body.mirror === true
      map.set(id, next)
    }
    return order.map((id) => map.get(id))
  }

  out.push(surface.panel({ plugin_id: me, id: 'clarify.queue', title: '澄清单据队列（待答 / 已答 / 已关闭）',
    view: 'contractor', order: 18, kind: 'table', actions: ['clarify.answer', 'clarify.broadcast', 'clarify.close'],
    data: () => {
      const rowsIn = host.rows('contractor')
      const tickets = ticketsOf(rowsIn)
      const moment = rowsIn.map((row) => String(row?.ts ?? '')).filter(Boolean).sort().pop() ?? ''
      if (!tickets.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-ticket',
          next_action: '供应商提问后这里会出现工单（提问方在供应商道的「我的澄清」里提）',
          columns: [{ key: 'ticket_id', label: '工单' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        columns: [
          { key: 'ticket_id', label: '工单', type: 'code' }, { key: 'package_id', label: '包', type: 'code' },
          { key: 'rfq_rev', label: 'rev' }, { key: 'refs', label: '引用条目', type: 'code' },
          { key: 'question', label: '问题' }, { key: 'status_label', label: '状态' },
          { key: 'waited', label: '未答时长（按事实时刻）' }, { key: 'answer', label: '我的答复' },
          { key: 'broadcast_label', label: '广播' }, { key: 'created_at', label: '提问 @ts' },
        ],
        rows: tickets.map((ticket) => ({ id: ticket.ticket_id, ...ticket,
          refs: (ticket.refs ?? []).join(' '),
          status_label: ticket.status === 'open' ? '待答' : (ticket.status === 'answered' ? '已答（未广播=只有提问方可见）' : '已关闭'),
          waited: ticket.status === 'open'
            ? `${Math.round((Date.parse(moment) - Date.parse(ticket.created_at)) / 3600000 * 100) / 100} 小时`
            : '—',
          broadcast_label: (ticket.broadcast_to ?? []).length ? `已广播给 ${ticket.broadcast_to.join(' ')}` : '未广播' })),
        row_actions: ['clarify.answer', 'clarify.broadcast', 'clarify.close'],
        counts: { tickets: tickets.length,
          open: tickets.filter((ticket) => ticket.status === 'open').length,
          answered: tickets.filter((ticket) => ticket.status === 'answered').length,
          closed: tickets.filter((ticket) => ticket.status === 'closed').length },
        note: `事实时刻 ${moment || '—'} · 答复必须署名 \`human:*\`；广播必须覆盖全部在册投标人`
          + `（缺一家就落 \`clarification/broadcast-incomplete\` 并拒绝），未完整广播的工单不得关闭（INV-006）` }
    } }))

  out.push(surface.panel({ plugin_id: me, id: 'clarify.mine', title: '我的澄清（我提的问题与答复）',
    view: 'supplier', order: 50, kind: 'table',
    // 入口归属 `domain/clarify`（本文件不再注册「提问澄清」这个动作 —— 见下面的合并说明）：
    // 这里的 `actions` 指的是**那个**动作，避免出现"引用了不存在的动作"的空按钮。
    actions: ['exchange.ask', 'clarify.broadcast'],
    data: () => {
      const rowList = host.rows('supplier')
      const tickets = ticketsOf(rowList)
      if (!tickets.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-ticket',
          next_action: '用「提问澄清」对某几条行项目提问（必须绑定包版本 rev 与 ≥1 个条目引用）',
          columns: [{ key: 'ticket_id', label: '工单' }], rows: [] }
      }
      return { ok: true, kind: 'table',
        columns: [{ key: 'ticket_id', label: '工单', type: 'code' }, { key: 'package_id', label: '包', type: 'code' },
          { key: 'rfq_rev', label: 'rev' }, { key: 'refs', label: '引用条目', type: 'code' },
          { key: 'question', label: '我问的' }, { key: 'status_label', label: '状态' },
          { key: 'answer', label: '承包商答复' }],
        rows: tickets.map((ticket) => ({ id: ticket.ticket_id, ...ticket, refs: (ticket.refs ?? []).join(' '),
          status_label: ticket.status === 'open' ? '待回答' : (ticket.status === 'answered' ? '已答复' : '已关闭'),
          answer: ticket.answer ?? '（还没答）' })),
        counts: { tickets: tickets.length,
          answered: tickets.filter((ticket) => ticket.answer).length },
        note: '答复在承包商侧「回答」并「广播」之后全员可见；未广播前只有提问方看得见' }
    } }))

  // 供应商侧的「提问澄清」入口**归 `domain/clarify`**（澄清域的主人：它拥有 `clarify.py` / `clarify-apply.py` /
  // 「我的澄清工单」问答串面板）。本插件原先也注册了一个同名入口（`clarify.ask`），与 `domain/clarify` 的
  // `exchange.ask` 在供应商工具栏上**并排出现两个「提问澄清」**（跨插件重复）⇒ 用户不知道该点哪个。
  // 本批按「一个入口 + 明确归属」合并：**删掉本文件的 `clarify.ask`，保留 `domain/clarify#exchange.ask`**；
  // 承包商侧的队列/回答/广播/关闭仍在本文件（它们是本视角的写动作，依赖 `rfq-clarify-apply.py`）。

  out.push(surface.action({ plugin_id: me, id: 'clarify.answer', title: '回答澄清（人签）',
    views: ['contractor'], group: '澄清', order: 10, permission: 'human-signature', inline: true,
    confirm: { required: true, message: '答复会落 `clarification/answered`（未广播前只有提问方可见）：确认？' },
    hint: '回答人必须 human:*；答复要广播给在册投标人才算完成（INV-006）',
    input: { fields: [
      { name: 'ticket_id', label: '工单 id', type: 'text', required: true },
      { name: 'text', label: '答复正文', type: 'textarea', required: true },
      { name: 'signature', label: '回答人（人签）', type: 'signature', required: true },
    ] },
    server: async (ctx, input) => {
      const staged = host.stage('clarify-apply', { kind: 'clarify-apply', action: 'answer', view: 'contractor',
        ticket_id: asText(input.ticket_id), actor: asText(input.signature), note: String(input.text ?? '') })
      if (!staged.ok) return staged
      const run = host.runPython(clarifyTool, ['--step', 'answer', '--request', staged.path, '--view', 'contractor',
        '--ui-shared', host.sharedDir, '--ledger-contractor', asText(host.config?.ledger_contractor),
        '--ledger-supplier', asText(host.config?.ledger_supplier), '--now', host.now()])
      const json = run.json ?? {}
      return { ok: run.ok && json.ok === true, code: json.refusal?.code ?? (json.ok ? 'answered' : 'writer-failed'),
        reason: json.refusal?.reason ?? run.reason ?? '',
        next_action: json.refusal?.next_action ?? json.next_action_runtime ?? '下一步：广播（覆盖全部在册投标人）',
        result: { pending: staged.file, ticket_id: json.ticket_id ?? null, status: json.status ?? null,
          ledger_added: json.ledger_added ?? 0, counterpart_notice: json.counterpart_notice ?? null } }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'clarify.broadcast', title: '广播答复（覆盖在册投标人）',
    views: ['contractor', 'supplier'], group: '澄清', order: 20, permission: 'human-signature', inline: true,
    confirm: { required: true, message: '广播后在册投标人全员可见（缺一家会被拒，工单不得关闭）：确认？' },
    hint: '默认广播给全部在册投标人（本包邀请名单）；名单不全即 `broadcast-incomplete` 并拒绝',
    input: { fields: [
      { name: 'ticket_id', label: '工单 id', type: 'text', required: true },
      { name: 'to', label: '广播名单（逗号分隔；空=全部在册投标人）', type: 'text' },
      { name: 'signature', label: '发言人（人签）', type: 'signature', required: true },
    ] },
    server: async (ctx, input) => {
      const to = String(input.to ?? '').split(/[,\s]+/).map((piece) => piece.trim()).filter(Boolean)
      const staged = host.stage('clarify-apply', { kind: 'clarify-apply', action: 'broadcast',
        view: String(ctx.view ?? 'contractor'), ticket_id: asText(input.ticket_id), to,
        actor: asText(input.signature), note: '' })
      if (!staged.ok) return staged
      const run = host.runPython(clarifyTool, ['--step', 'broadcast', '--request', staged.path,
        '--view', String(ctx.view ?? 'contractor'), '--ui-shared', host.sharedDir,
        '--ledger-contractor', asText(host.config?.ledger_contractor),
        '--ledger-supplier', asText(host.config?.ledger_supplier), '--now', host.now()])
      const json = run.json ?? {}
      return { ok: run.ok && json.ok === true, code: json.refusal?.code ?? (json.ok ? 'broadcast' : 'writer-failed'),
        reason: json.refusal?.reason ?? run.reason ?? '',
        next_action: json.refusal?.next_action ?? json.next_action_runtime ?? '广播完成后才能「关闭工单」',
        result: { pending: staged.file, ticket_id: json.ticket_id ?? null,
          broadcast_to: json.broadcast_to ?? [], registered: json.registered_bidders ?? [],
          ledger_added: json.ledger_added ?? 0 } }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'clarify.close', title: '关闭工单（前置：已完整广播）',
    views: ['contractor'], group: '澄清', order: 30, permission: 'human-signature', inline: true,
    confirm: { required: true, message: '关闭工单：未完整广播的工单会被拒（INV-006）：确认？' },
    hint: '关闭前置是"答案已完整广播给在册投标人"，否则落 broadcast-incomplete 并拒绝',
    input: { fields: [
      { name: 'ticket_id', label: '工单 id', type: 'text', required: true },
      { name: 'signature', label: '关闭人（人签）', type: 'signature', required: true },
    ] },
    server: async (ctx, input) => {
      const staged = host.stage('clarify-apply', { kind: 'clarify-apply', action: 'close', view: 'contractor',
        ticket_id: asText(input.ticket_id), actor: asText(input.signature), note: '' })
      if (!staged.ok) return staged
      const run = host.runPython(clarifyTool, ['--step', 'close', '--request', staged.path, '--view', 'contractor',
        '--ui-shared', host.sharedDir, '--ledger-contractor', asText(host.config?.ledger_contractor),
        '--ledger-supplier', asText(host.config?.ledger_supplier), '--now', host.now()])
      const json = run.json ?? {}
      return { ok: run.ok && json.ok === true, code: json.refusal?.code ?? (json.ok ? 'closed' : 'writer-failed'),
        reason: json.refusal?.reason ?? run.reason ?? '',
        next_action: json.refusal?.next_action ?? json.next_action_runtime ?? '工单已关闭',
        result: { pending: staged.file, ticket_id: json.ticket_id ?? null, status: json.status ?? null,
          ledger_added: json.ledger_added ?? 0 } }
    } }))

  out.push(surface.notificationSource({ plugin_id: me, id: 'notify.clarify', title: '澄清单据待办', order: 12,
    poll: () => {
      const items = []
      for (const ticket of ticketsOf(host.rows('contractor'))) {
        if (ticket.status !== 'open') continue
        items.push({ id: `clarify:${ticket.ticket_id}`, level: 'warn', at: ticket.created_at, ref: ticket.ticket_id,
          title: `待回答：${ticket.ticket_id}（${ticket.package_id} rev${ticket.rfq_rev}）`,
          body: `引用 ${(ticket.refs ?? []).join(' ')} · ${String(ticket.question).slice(0, 80)}`,
          next_action: '去「澄清单据队列」回答（人签），然后广播给在册投标人' })
      }
      for (const row of rowsOfType(host.rows('supplier'), 'mail/')) {
        const body = bodyOf(row)
        const subject = asText(body.subject)
        if (!subject.startsWith('报价评审：')) continue
        items.push({ id: `review:${body.message_id ?? ''}`, level: 'info', at: String(row.ts ?? ''),
          title: `承包商判定：${subject}`, body: '看「承包商对我报价的判定」面板',
          next_action: '按判定处理：退回/要补件时改后重报（人签提交）' })
      }
      return items
    } }))

  // ------------------------------------------------------------------ ⑷ 按 id / 关键字找对象（本批新增）
  // 用户诉求：手里有一个 id（或只记得一个关键字）时，**不用回终端、也不用一个个页面翻**：一个入口能搜
  // 包 / 报价 / PO / 变更单，结果给**可点、可复制的深链**。
  // 走**注册面**（面板 + 动作 + 对象深链 + 机制级便签），外壳机制一行未改：
  //   · 动作 `find.object` 的**服务端一半**做检索，并把这一组关键词记进机制级便签（`host.note`）；
  //   · 面板 `find.results-<view>`（`object_kind: 'find'`）按 `ctx.route.id`（可分享的深链）或便签渲染结果；
  //   · 每行带 `ref` ⇒ 外壳把它渲染成可点、可复制的深链（跳到对应对象页）。
  // 检索面只读**本视角的行**（`host.rows(view)`）：跨 realm 的对象在本视角根本不存在（规则 4），
  // 且只对**本视图声明过的对象类**给链接（没声明的类如实标注"不可打开"，不给死链）。
  const FIND_SOURCES = [
    { kind: 'package', types: ['rfq/published', 'rfq/amended', 'rfq/distributed'],
      id: (body) => asText(body.package_id),
      title: (body, id) => `包 ${id}${body.rev === undefined || body.rev === null ? '' : ` rev${body.rev}`}`,
      summary: (body) => [asText(body.subject),
        asText(body.quote_by) ? `报价截止 ${asText(body.quote_by)}` : '',
        (body.items !== undefined && body.items !== null && !Array.isArray(body.items)) ? `条目 ${body.items}` : '',
        (body.spec && Array.isArray(body.spec.items)) ? `条目 ${body.spec.items.length}` : '']
        .filter(Boolean).join(' · ') },
    { kind: 'quote', types: ['quote/submitted'],
      id: (body) => asText(body.quote_id),
      title: (body, id) => `报价 ${id}`,
      summary: (body) => [asText(body.supplier), asText(body.item_id),
        body.unit_price_cents === undefined || body.unit_price_cents === null ? '' : `${body.unit_price_cents} 分`,
        Array.isArray(body.lines) ? `${body.lines.length} 行` : '',
        asText(body.package_id) ? `包 ${asText(body.package_id)}` : ''].filter(Boolean).join(' · ') },
    { kind: 'award', types: ['award/intent-proposed', 'award/committed'],
      id: (body) => asText(body.award_id) || asText(body.intent_id),
      title: (body, id) => (asText(body.award_id) ? `授标承诺 ${id}` : `授标意向 ${id}`),
      summary: (body) => [asText(body.package_id) ? `包 ${asText(body.package_id)}` : '',
        asText(body.quote_id) ? `报价 ${asText(body.quote_id)}` : '',
        Array.isArray(body.lines) ? `条目 ${body.lines.length}` : ''].filter(Boolean).join(' · ') },
    { kind: 'po', types: ['po/issued', 'po/confirmed'],
      id: (body) => asText(body.po_id),
      title: (body, id) => `PO ${id}`,
      summary: (body) => [asText(body.award_id) ? `授标 ${asText(body.award_id)}` : '',
        Array.isArray(body.lines) ? `行 ${body.lines.length}` : '', asText(body.trace_mode)].filter(Boolean).join(' · ') },
    { kind: 'change', types: ['change/proposed', 'change/priced', 'change/responded', 'change/approved', 'change/rejected'],
      id: (body) => asText(body.change_id),
      title: (body, id) => `变更 ${id}`,
      summary: (body) => [asText(body.quote_id) ? `报价 ${asText(body.quote_id)}` : '',
        asText(body.approved_by) ? `批准 ${asText(body.approved_by)}` : '',
        body.delta_amount === undefined || body.delta_amount === null ? '' : `差额 ${body.delta_amount}`]
        .filter(Boolean).join(' · ') },
  ]

  /** 检索（纯读本视角的行）：命中 id / 标题 / 摘要里的关键字；同一对象的多条事实合并成一条。 */
  const findObjects = (view, query, limit) => {
    const needle = String(query ?? '').trim().toLowerCase()
    const allowed = new Set(surface.objectKindsFor(view))
    const found = new Map()
    if (needle !== '') {
      for (const row of host.rows(view)) {
        const type = String(row?.type ?? '')
        for (const source of FIND_SOURCES) {
          if (!source.types.includes(type)) continue
          const body = bodyOf(row)
          const id = source.id(body)
          if (id === '') continue
          const title = source.title(body, id)
          const summary = source.summary(body)
          if (!`${id} ${title} ${summary}`.toLowerCase().includes(needle)) continue
          const key = `${source.kind}\u0000${id}`
          const previous = found.get(key)
          if (previous === undefined) {
            found.set(key, { kind: source.kind, id, title, summary, facts: [type] })
            continue
          }
          if (title.length > previous.title.length) previous.title = title      // 标题取更具体的那条事实
          if (summary !== '' && !previous.summary.includes(summary)) {
            previous.summary = [previous.summary, summary].filter(Boolean).join(' / ')
          }
          if (!previous.facts.includes(type)) previous.facts.push(type)
        }
      }
    }
    const ordered = [...found.values()].sort((left, right) => (left.kind < right.kind ? -1
      : (left.kind > right.kind ? 1 : (left.id < right.id ? -1 : 1))))
    const size = Math.max(1, Math.min(50, Number(limit) || 10))
    return { matches: ordered.slice(0, size), total: ordered.length, kinds: [...allowed].sort() }
  }

  /** 结果面板（每个视角注册两块，同一份 data()）：
   *   · `find.inline-<view>`：**视图页**上的结果区（无 `object_kind`）—— 搜完立刻看得见，不用跳页；
   *   · `find.results-<view>`：**对象页**上的同一份结果（`object_kind: 'find'`）—— 它就是可分享的深链
   *     `/app/<view>/find/<关键字>/`，也是命令面板里「打开对象类：find」的落点。
   *  注册面按 (kind, plugin_id, id) 去重 ⇒ 两块面板 id 必须不同。 */
  const findPanel = (view, { objectKind = '' } = {}) => surface.panel({ plugin_id: me,
    id: objectKind === '' ? `find.inline-${view}` : `find.results-${view}`,
    title: '查找结果（包 / 报价 / PO / 变更）', view, order: 5, kind: 'table',
    ...(objectKind === '' ? {} : { object_kind: objectKind }),
    actions: ['find.object'],
    hint: '按 id 前缀（pkg- / qg- / po- / chg-）或关键字搜本视角的对象；每行给可点、可复制的深链',
    data: (ctx) => {
      const fromRoute = asText(ctx?.route?.id)
      const query = fromRoute !== '' ? fromRoute : asText(host.note.get(me, 'find.query', ''))
      const result = findObjects(view, query, host.note.get(me, 'find.limit', 10))
      const columns = [{ key: 'kind', label: '类' }, { key: 'object_id', label: 'id', type: 'code' },
        { key: 'title', label: '是什么' }, { key: 'summary', label: '细节' },
        { key: 'facts', label: '来自哪些事实' }, { key: 'deep_link', label: '深链（可复制）', type: 'code' }]
      if (query === '') {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-query', columns, rows: [],
          next_action: '用工具栏 / 命令面板的「按 id / 关键字找对象」搜一次；'
            + `或直接开深链 ${host.prefix}/app/${view}/find/<关键字>/` }
      }
      const rows = result.matches.map((item) => {
        const openable = result.kinds.includes(item.kind)
        return { id: `${item.kind}:${item.id}`, kind: item.kind, object_id: item.id, title: item.title,
          summary: item.summary, facts: item.facts.join(' + '),
          deep_link: openable ? `${host.prefix}/app/${view}/${item.kind}/${encodeURIComponent(item.id)}/` : '（这一类在本视图不可打开）',
          ref: openable ? { kind: item.kind, id: item.id, title: item.title } : null }
      })
      if (!rows.length) {
        return { ok: true, kind: 'table', degraded: true, reason: 'no-match', columns, rows: [],
          next_action: `「${query}」在本视角（${view}）的行里没有匹配：换个关键字，或确认这个对象是不是别的视角/别的 realm 的`
            + `（可达的对象类：${result.kinds.join(' / ') || '（无）'}）` }
      }
      return { ok: true, kind: 'table', columns, rows,
        counts: { matched: result.total, shown: rows.length },
        note: `关键词「${query}」· 深链可直接发给同事（对方视角打开只会在它自己的投影里找，找不到就如实未命中）`
          + ` · 本视图可打开的对象类：${result.kinds.join(' / ') || '（无）'}` }
    } })

  out.push(findPanel('contractor'))
  out.push(findPanel('supplier'))
  out.push(findPanel('contractor', { objectKind: 'find' }))
  out.push(findPanel('supplier', { objectKind: 'find' }))

  out.push(surface.action({ plugin_id: me, id: 'find.object',
    title: '按 id / 关键字找对象（包 · 报价 · PO · 变更）',
    views: ['contractor', 'supplier'], group: '查找', order: 1, placement: ['toolbar', 'command'],
    hint: '一个入口搜本视角的包 / 报价 / PO / 变更单：结果里有可点、可复制的深链（不用一个个页面翻）',
    input: { fields: [
      { name: 'query', label: 'id 或关键字', type: 'text', required: true,
        help: '例：pkg-g1 · qg-fresh · po-0001 · chg-0001 · L-001' },
      { name: 'limit', label: '最多几条', type: 'number', min: 1, max: 50, default: 10 },
    ] },
    server: async (ctx, input) => {
      const view = ['contractor', 'supplier'].includes(asText(ctx?.view)) ? asText(ctx.view) : 'contractor'
      const query = asText(input.query)
      if (query === '') {
        return { ok: false, code: 'query-required', reason: '空关键字：一个 id 或一个词都行，但不能空着搜',
          next_action: '写一个 id（如 pkg-g1）或一个关键字（如 chg）再搜' }
      }
      const limit = Math.max(1, Math.min(50, Number(input.limit) || 10))
      const result = findObjects(view, query, limit)
      // 机制级便签：结果面板随后按它渲染（纯内存、不落盘、不进账本；卸载插件时清空）
      host.note.set(me, 'find.query', query)
      host.note.set(me, 'find.limit', limit)
      const deepLink = `${host.prefix}/app/${view}/find/${encodeURIComponent(query)}/`
      return { ok: true, code: result.total ? 'found' : 'no-match',
        reason: result.total ? `匹配 ${result.total} 条（本视图可打开：${result.kinds.join(' / ') || '（无）'}）`
          : `「${query}」在本视角的行里没有匹配`,
        next_action: `结果在「查找结果」面板里逐行可点；这条搜索的深链可复制分享：${deepLink}`,
        result: { view, query, total: result.total,
          matches: result.matches.map((item) => ({ kind: item.kind, id: item.id, title: item.title,
            deep_link: result.kinds.includes(item.kind)
              ? `${host.prefix}/app/${view}/${item.kind}/${encodeURIComponent(item.id)}/` : null })),
          ref: { view, kind: 'find', id: query, title: `查找「${query}」` } } }
    } }))

  out.push(surface.shortcut({ plugin_id: me, id: 'shortcut.find', keys: 'f', action: 'find.object',
    title: '按 id / 关键字找对象', order: 5 }))

  // ------------------------------------------------------------------ 导出 / 打印（`report` 声明 + 动作的服务端一半）
  /**
   * 包的行项目（导出用）：**只从本侧事实与投递快照收集**，每行带 `source`（这条行是哪来的）与
   * `payload_sha256`（该版本账本事实的载荷哈希）⇒ 打印出来也能逐条对回账本。
   * 顺序 = 先账本事实（新写者把 `items` 数组写进 `rfq/published`），再投递信封，最后快照文件。
   */
  const exportItemsOf = (packageId, view) => {
    const rows = host.rows(view)
    const published = rowsOfType(rows, 'rfq/published').map((row) => ({ ...bodyOf(row), seq: row.seq,
      entry_hash: row.entry_hash, ts: row.ts })).filter((row) => asText(row.package_id) === packageId)
    const latest = published[published.length - 1] ?? {}
    const amended = rowsOfType(rows, 'rfq/amended').map((row) => bodyOf(row))
      .filter((row) => asText(row.package_id) === packageId)
    const qtyDelta = new Map()
    for (const delta of amended.flatMap((row) => (Array.isArray(row.deltas) ? row.deltas : []))) {
      if (asText(delta.field) === 'qty') qtyDelta.set(asText(delta.item_id), delta)
    }
    const items = []
    const push = (item, source, rev) => {
      const itemId = asText(item?.item_id)
      if (itemId === '' || items.some((row) => row.item_id === itemId)) return
      const delta = qtyDelta.get(itemId)
      items.push({ no: items.length + 1, item_id: itemId, description: asText(item?.description),
        unit: asText(item?.unit), qty: Number(item?.qty), spec_refs: (Array.isArray(item?.spec_refs)
          ? item.spec_refs : []).map(String).join(' '), source, rev: rev === undefined || rev === '' ? '' : rev,
        payload_sha256: asText(latest.hash),
        qty_amended: delta ? `${delta.before}→${delta.after}（rfq/amended）` : '' })
    }
    for (const item of (Array.isArray(latest.items) ? latest.items : [])) push(item, 'ledger:rfq/published', latest.rev)
    const delivery = asText(host.config?.rfq_delivery)
    if (delivery !== '') {
      const raw = host.readJson(delivery)
      for (const envelope of (Array.isArray(raw) ? raw : (raw ? [raw] : []))) {
        const spec = envelope && typeof envelope.spec === 'object' && envelope.spec !== null ? envelope.spec : {}
        if (asText(spec.package_id) !== packageId) continue
        for (const item of (Array.isArray(spec.items) ? spec.items : [])) {
          push(item, 'exchange-envelope', envelope.rev ?? '')
        }
      }
    }
    for (const item of (Array.isArray(snapshotOfPackage(packageId)?.spec?.items)
      ? snapshotOfPackage(packageId).spec.items : [])) push(item, 'snapshot-file', '')
    return { items, latest, published_count: published.length }
  }

  out.push(surface.action({ plugin_id: me, id: 'rfq.export', title: '导出 / 打印 RFQ 包（人读格式）',
    views: ['contractor', 'supplier'], group: '发包', order: 14, icon: 'print', object_kind: 'package',
    hint: '导出内容 = 本侧账本里的包版本事实 + 这次投递/快照里的行项目（逐行带来源与版本锚）；'
      + '外壳只做序列化，内容由本插件给（谁的事实谁导出）',
    input: { fields: [
      { name: 'package_id', label: '包 id', type: 'text', required: true, from_route: true,
        help: '在包的对象页上会自动填当前这一条' },
      { name: 'format', label: '格式（csv = 表格；html = 可直接打印）', type: 'select', required: true,
        options: ['csv', 'html'], default: 'csv' },
    ] },
    server: (ctx, input) => {
      const view = ['contractor', 'supplier'].includes(asText(ctx?.view)) ? asText(ctx.view) : 'contractor'
      const packageId = asText(input.package_id)
      if (packageId === '') {
        return { ok: false, code: 'package-id-required', reason: '要导出哪一个包？',
          next_action: '在包的对象页上点「导出 / 打印」（按钮会把当前这一条填好）' }
      }
      const { items, latest, published_count } = exportItemsOf(packageId, view)
      if (!items.length) {
        return { ok: false, code: 'no-exportable-lines',
          reason: `本侧（${view}）读不到包 ${packageId} 的行项目（账本事实里没有 items 数组，也没有投递信封/快照）`,
          next_action: '先让对方把包投给你（供应商）或确认发布时落了快照文件（承包商）；'
            + '行项目读不到就如实拒，不编一张空表出来' }
      }
      return host.report({ format: asText(input.format) || 'csv', filename: `rfq-${packageId}-rev${latest.rev ?? 'x'}`,
        title: `RFQ 包 ${packageId}（rev${latest.rev ?? '?'}）`,
        subtitle: `${view} 侧导出 · 行项目 ${items.length} 条 · 本侧版本事实 ${published_count} 条`,
        facts: [
          { key: '包 id', value: packageId },
          { key: '版本（账本事实）', value: `rev${latest.rev ?? '?'}` },
          { key: '报价截止', value: asText(latest.quote_by) || '—' },
          { key: '载荷哈希（账本 body.hash）', value: asText(latest.hash) || '—' },
          { key: '账本行', value: latest.seq === undefined ? '—' : `seq ${latest.seq} · ${asText(latest.entry_hash)}` },
          { key: '条目数', value: String(items.length) },
        ],
        columns: [{ key: 'no', label: '#' }, { key: 'item_id', label: '行项目' },
          { key: 'description', label: '描述' }, { key: 'unit', label: '单位' }, { key: 'qty', label: '数量' },
          { key: 'spec_refs', label: '规格引用' }, { key: 'qty_amended', label: '量变更（如有）' },
          { key: 'rev', label: '版本' }, { key: 'payload_sha256', label: '载荷哈希' },
          { key: 'source', label: '行来源' }],
        rows: items,
        notes: ['行序与来源：账本事实 → 投递信封 → 快照文件（同一 item_id 只出一次）。',
          `导出时刻：${host.now()}；本文件的行可与账本 rfq/published（seq ${latest.seq ?? '—'}）逐行核对。`],
        source: `${view} 侧账本 rfq/published + 交换信封/快照文件（rfq.export，domain/rfq）`,
        ledger_refs: latest.seq === undefined ? [] : [{ type: 'rfq/published', seq: latest.seq,
          entry_hash: asText(latest.entry_hash), payload_sha256: asText(latest.hash) }] })
    } }))

  out.push(surface.report({ plugin_id: me, id: 'report.rfq-package',
    title: 'RFQ 包（CSV / 可打印 HTML）', views: ['contractor', 'supplier'], object_kind: 'package',
    formats: ['csv', 'html'], action: 'rfq.export', order: 14,
    hint: '逐行带来源与版本锚；HTML 那一档可以直接打印或另存 PDF' }))

  // ---- **沙盘场景**（机制：`surface.scenario`，见 `ui-surface.mjs`）--------------------------------
  // 演示流程（`demo.procurement`）的第 ① 段：**发包**。这只是"声明要按顺序跑哪个动作"，
  // 真干活的是 `rfq.publish` 自己的服务端一半（同一张待办件、同一个唯一写者）—— 外壳不认识"包"是什么。
  // 入参里的 `$actor` 由机制换成这一步的**演示身份**（沙盘按侧决定，不是请求随便给的署名）。
  out.push(surface.scenario({ plugin_id: me, id: 'scenario.rfq-publish', scenario: 'demo.procurement',
    scenario_title: '演示：包 → 报价 → 比价 → 授标 → PO', title: '① 发包（承包商发起）',
    view: 'contractor', order: 10,
    hint: '发一包：包 id / 条目 / 邀请 realm 都用演示值（不产生对外义务）',
    steps: [{ action: 'rfq.publish',
      input: { package_id: 'DEMO-PKG-001', subject: '演示：厂区给排水管道更换', currency: 'CNY',
        quote_by: '2026-12-31T00:00:00Z', clarify_by: '2026-12-20T00:00:00Z',
        items: 'L-001,DN100 管道,m,120\nL-002,法兰,m,40', invited: 'supplier:g1',
        note: '沙盘演示数据（不含真实合同内容）', actor: '$actor', confirm_ack: '1' } }] }))

  // ---- **起步指引**（机制：`surface.guide`，见 `ui-surface.mjs`）------------------------------------
  // 空态（这一屏一块有数据的面板都没有）时摆在第一屏：**一句人话**（这一屏是干什么的）+ 最多 3 步
  // **真能做的下一步**（点了真开那个动作的表单）。话是插件自己写的 —— 外壳不认识"包/报价"是什么。
  out.push(surface.guide({ plugin_id: me, id: 'guide.contractor-start', view: 'contractor', order: 10,
    title: '承包商：从哪一步开始',
    summary: '这条道是承包商的活：发 RFQ 给供应商 → 收报价 → 比价排序 → 提出授标意向 → 供应商确认 →'
      + '授标承诺（人签）→ 发 PO。现在什么数据都还没有，下面这些就是能开工的下一步。',
    hint: '每一步落账都走唯一写者（界面只发起）；对外承诺一律要人签（署名 = 你的会话身份）',
    steps: [{ action: 'rfq.publish', label: '发布第一个 RFQ（发包）',
      note: '要填：包 id（自己起名）、标题、报价截止、行项目、受邀 realm（例如 supplier:g1）' }] }))

  return out
}
