/**
 * `domain/compare` 的 **GUI 贡献** —— 承包商侧「比价：权重可调、贡献可解释」。
 *
 * 注册的东西：
 *   · 面板 `compare.ranking`（排名表：名次 / 报价 / 供应商 / 得分 / **五个分量各自的贡献值** / 引用链；
 *     `bulk: compare.rank` 让"选中的几家"单独排一次，权重直接改在动作表单里）；
 *   · 动作 `compare.rank`（**服务端一半**：跑只读工具 `src/domain/compare/tools/compare-rank.py`，
 *     它复用 `src/domain/compare/code/compare.py` 的 `CompareService.rank` —— 同一个实现、同权重同名次；
 *     权重存在外壳的机制便签里，面板下次直接读回来 ⇒ 界面上的名次和权重是**同一组**输入）；
 *   · 状态栏项。
 *
 * 纪律：`compare-rank.py` 是只读的（`CompareService(ledger=None)`），**账本零新增**、不取墙钟、不联网。
 */
export const plugin_id = 'domain/compare'

const DEFAULTS = { price: 0.6, delivery: 0.15, payment: 0.1, warranty: 0.05, deviation: 0.1 }
const LABELS = { price: '单价', delivery: '交期', payment: '付款条件', warranty: '质保', deviation: '偏差计数' }
const asText = (value) => (typeof value === 'string' ? value.trim() : '')
const NOTE_KEY = 'weights'

/** 「行」的最小形状：非 null 的**对象**（数组不是行）。 */
const isRow = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
/**
 * **外部行数组的唯一读数入口**（工具 JSON 的 `matrix.items` / `item.cells` 走这里）。
 * 为什么必须有它（P27 实测的根因）：数组里混进一条 `null`/字符串时读 `item.item_id` 就抛 `TypeError`，
 * 而外壳对 `panel.data()` 抛错的处理是**整块面板判 `data-failed`** —— 一条坏行打崩一整块。
 * 坏行**逐条计数**（返回值里的 `dropped`），调用方把它如实报出来、不静默丢。
 */
const readRows = (value) => {
  if (!Array.isArray(value)) return { list: false, all: 0, rows: [], dropped: 0 }
  const rows = value.filter((row) => isRow(row))
  return { list: true, all: value.length, rows, dropped: value.length - rows.length }
}

export async function register(surface, host) {
  const me = plugin_id
  const out = []
  const configPath = () => `${host.sharedDir}/compare/weights.json`
  /**
   * 当前权重：**插件配置** > 内存便签 > 默认值。
   * 配置文件由 `compare-apply.py --step weights`（唯一写者）落盘 ⇒ 重启、换进程后**仍然在**（DEF-012）。
   */
  const weightsFromConfig = () => {
    const data = host.readJson(configPath())
    const weights = data && typeof data.weights === 'object' && data.weights !== null ? data.weights : null
    if (!weights) return null
    const out = {}
    for (const key of Object.keys(DEFAULTS)) out[key] = Number(weights[key] ?? 0)
    return out
  }
  const weightsNow = () => {
    const saved = weightsFromConfig()
    if (saved) return saved
    return host.note.get(me, NOTE_KEY, { ...DEFAULTS })
  }
  const weightsSource = () => (weightsFromConfig() ? '插件配置（compare/weights.json，重启后仍在）' : '内存便签（本进程）')
  const weightsText = (weights) => Object.keys(DEFAULTS).map((key) => `${key}=${weights[key] ?? 0}`).join(',')

  const runRank = (weights, packageId, quoteIds) => {
    const args = ['--ui-shared', host.sharedDir,
      '--ledger-contractor', asText(host.config?.ledger_contractor),
      '--weights', weightsText(weights)]
    if (packageId) args.push('--package-id', packageId)
    // `{read:true}`：这是**只读复算**（compare-rank.py 用 CompareService(ledger=None)），
    // 所以同一组权重在一次页面渲染里只 spawn 一次（排名表/矩阵/贡献分解/状态栏共用同一个结果）。
    const run = host.runPython('src/domain/compare/tools/compare-rank.py', args, { read: true })
    const json = run.json ?? {}
    const ranking = (json.ranking ?? []).filter((row) => !quoteIds?.length || quoteIds.includes(row.quote_id))
    return { run, json, ranking }
  }

  out.push(surface.view({ plugin_id: me, id: 'compare.workspace', title: '比价', order: 20, view: 'contractor',
    hint: '权重可调；每个分量给多少分、凭什么，都写在表里' }))

  out.push(surface.panel({ plugin_id: me, id: 'compare.ranking', title: '比价排名（贡献可解释）',
    view: 'contractor', order: 30, kind: 'table', actions: ['compare.rank'],
    data: () => {
      const weights = weightsNow()
      const { json, ranking, run } = runRank(weights, '', null)
      if (!json.ok) {
        return { ok: true, kind: 'table', degraded: true, reason: json.refusal?.code ?? run.code ?? 'rank-failed',
          next_action: json.refusal?.next_action ?? '看 stdout 定位只读工具失败原因（账本零新增）',
          columns: [{ key: 'quote_id', label: '报价' }], rows: [] }
      }
      if (json.degraded || !ranking.length) {
        return { ok: true, kind: 'table', degraded: true, reason: json.reason ?? 'no-ranking',
          next_action: json.next_action ?? '等供应商提交报价（人签）后再看',
          columns: [{ key: 'quote_id', label: '报价' }], rows: [], counts: json.counts ?? {} }
      }
      return { ok: true, kind: 'table',
        columns: [
          { key: 'rank', label: '名次' },
          { key: 'quote_id', label: '报价', type: 'code' },
          // **包 id 是一列普通列**（P49）：它是「保存权重」这类动作的必填入参之一，而最小上下文集
          // 必须能被**某一行**满足（否则该动作在全视图里 0 入口）。行里有这一列 ⇒ 引导区/命令面板
          // 挑一条就把它预填进表单（不必回去手抄包 id）。
          { key: 'package_id', label: '包（挂这条事实的包 id）', type: 'code' },
          { key: 'supplier', label: '供应商', type: 'code' },
          { key: 'score', label: '得分（越小越前，minmax 口径）', filter: 'number' },
          { key: 'components', label: '分量贡献（谁拉高了 / 拉低了）' },
          { key: 'citations', label: '引用链' },
        ],
        rows: ranking.map((row) => ({ id: row.quote_id, quote_id: row.quote_id,
          // 包 id / 包版本逐行来自只读复算的上游（`compare-rank.py` 把本包 id 与 rev 逐行复述）
          package_id: row.package_id ?? '', package_rev: row.package_rev ?? '',
          supplier: row.supplier, rank: row.rank, score: row.score,
          components: Object.entries(row.components ?? {}).map(([key, comp]) =>
            `${LABELS[key] ?? key}=${comp.value}`).join(' · '),
          citations: (row.citations ?? []).slice(0, 4).join(' ') })),
        bulk: 'compare.rank',
        // **行内入口**（P49）：同一份动作也挂在行上 —— 点某一行那颗按钮 = 按那一行预填（包 id 来自行、
        // 「你看到的那一版」来自本面板的 `version_for`）。缺上下文靠"摆到能填的地方"解决，不靠藏。
        row_actions: ['compare.save-weights', 'compare.export'],
        counts: { ranked: ranking.length, ...(json.counts ?? {}) },
        // **乐观并发**：页面上声明"这一版权重是给哪个动作用的" ⇒ 打开「保存权重」时界面自动带上它
        // （行里另有 `package_id`：那份动作要的**最小上下文集**因此能被**一行**满足 —— 见 29 §23 与
        // `src/system/webui/docs/entry-policy-and-empty-state.md` §6）。
        version: host.versions.current('contractor', 'compare-weights', 'current'),
        version_for: 'compare.save-weights',
        note: `本次权重：${weightsText(weights)}（归一由服务保证；同权重下与 Python 侧 services/compare.py 同名次）`
          + ` · 选中若干行再点「用这组权重重排」= 只排这几家`
          + ` ·「保存权重」需要「包 id + 你看到的那一版」：包 id 就在这一列里（行内那颗按钮会把整行带入），`
          + `版本见「保存权重」表单里的只读字段（别人先改过就会被明确拒绝并给出差异）` }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'compare.rank', title: '用这组权重排一次', views: ['contractor'],
    group: '比价', order: 20, input: { bulk: 'ids', fields: [
      { name: 'package_id', label: '只排这个包（可空）', type: 'text' },
      { name: 'w_price', label: '权重：单价', type: 'number', min: 0, max: 1, default: DEFAULTS.price },
      { name: 'w_delivery', label: '权重：交期', type: 'number', min: 0, max: 1, default: DEFAULTS.delivery },
      { name: 'w_payment', label: '权重：付款条件', type: 'number', min: 0, max: 1, default: DEFAULTS.payment },
      { name: 'w_warranty', label: '权重：质保', type: 'number', min: 0, max: 1, default: DEFAULTS.warranty },
      { name: 'w_deviation', label: '权重：偏差计数', type: 'number', min: 0, max: 1, default: DEFAULTS.deviation },
    ] },
    hint: '只读复算：账本零新增。权重与分量口径来自 src/domain/compare/code/compare.py（同一实现）',
    server: async (ctx, input) => {
      const weights = { price: Number(input.w_price ?? DEFAULTS.price), delivery: Number(input.w_delivery ?? DEFAULTS.delivery),
        payment: Number(input.w_payment ?? DEFAULTS.payment), warranty: Number(input.w_warranty ?? DEFAULTS.warranty),
        deviation: Number(input.w_deviation ?? DEFAULTS.deviation) }
      const ids = Array.isArray(input.ids) && input.ids.length ? input.ids.map(String) : null
      host.note.set(me, NOTE_KEY, weights)
      const { json, ranking, run } = runRank(weights, asText(input.package_id), ids)
      if (!json.ok && !json.refusal) {
        return { ok: false, code: run.code ?? 'rank-failed', reason: run.reason ?? '只读工具没有给出 JSON',
          next_action: '看 result.stdout 定位（只读工具失败不改账本）', result: { stdout: run.stdout, stderr: run.stderr } }
      }
      if (json.refusal) {
        return { ok: false, code: json.refusal.code, reason: json.refusal.reason,
          next_action: json.refusal.next_action, result: { weights } }
      }
      const top = ranking[0] ?? null
      return { ok: true, code: json.degraded ? 'degraded' : 'ranked',
        reason: json.degraded ? `${json.reason ?? 'no-candidates'}` : '',
        next_action: json.degraded ? (json.next_action ?? '等报价进来再排')
          : `名次已按这组权重给出：第 1 名 ${top?.quote_id ?? '—'}（得分 ${top?.score ?? '—'}）。`
            + '要授标就用「收到的报价」表里的行内动作（授标仍需人签）',
        result: { weights, evaluated: ids ?? 'all', ranking: ranking.map((row) => ({ rank: row.rank,
          quote_id: row.quote_id, score: row.score,
          components: Object.fromEntries(Object.entries(row.components ?? {}).map(([key, comp]) => [key, comp.value])) })),
          evaluation_id: json.evaluation_id ?? null, note: json.note ?? null } }
    } }))

  // ---- 工作台：当前权重下的头名（一眼看到"该找谁谈"） --------------------------------------------
  out.push(surface.panel({ plugin_id: me, id: 'home.ranking', title: '比价（当前权重）',
    view: 'home', order: 40, kind: 'list',
    data: () => {
      const weights = weightsNow()
      const { json, ranking } = runRank(weights, '', null)
      if (!json?.ok || json.degraded || !ranking.length) {
        return { ok: true, kind: 'list', degraded: true, reason: json?.reason ?? 'no-ranking',
          next_action: json?.next_action ?? '等供应商提交报价（人签）后再排',
          items: [{ level: 'info', title: '承包商侧：暂无可比价的报价', body: '本侧账本里还没有已送达的报价事实',
            next_action: '等供应商在 APP 里人签提交报价' }] }
      }
      return { ok: true, kind: 'list', items: ranking.slice(0, 3).map((row) => ({ level: row.rank === 1 ? 'ok' : 'info',
        title: `承包商侧：第 ${row.rank} 名 ${row.quote_id}（得分 ${row.score}）`,
        body: Object.entries(row.components ?? {}).map(([key, comp]) => `${LABELS[key] ?? key}=${comp.value}`).join(' · '),
        next_action: row.rank === 1 ? '授标链：提意向 → 等供应商确认 → 人签承诺 → 人签发 PO' : '调权重看名次是否变' })) }
    } }))

  out.push(surface.shortcut({ plugin_id: me, id: 'shortcut.compare-rank', keys: 'c', action: 'compare.rank',
    title: '比价（用当前权重）', order: 30 }))

  out.push(surface.statusItem({ plugin_id: me, id: 'status.compare', title: '比价', order: 30, read: () => {
    const { json } = runRank(weightsNow(), '', null)
    return { text: json?.degraded ? '暂无可排名报价' : `${json?.counts?.quotes ?? 0} 条报价 / 排 ${json?.counts?.ranked ?? 0} 名`,
      level: json?.degraded ? 'warn' : 'ok', next_action: json?.degraded ? (json.next_action ?? '') : '' }
  } }))

  // ------------------------------------------------------------------ 比较矩阵（DEF-012）
  const applyTool = 'src/domain/compare/tools/compare-apply.py'
  const matrixOf = (weights) => {
    const { json, ranking, run } = runRank(weights, '', null)
    return { json, ranking, run, matrix: json.matrix ?? null }
  }

  out.push(surface.panel({ plugin_id: me, id: 'compare.matrix', title: '比较矩阵（同一行项目内才互相比较）',
    view: 'contractor', order: 32, kind: 'table', actions: ['compare.rank'],
    data: () => {
      const weights = weightsNow()
      const { json, matrix } = matrixOf(weights)
      if (!json.ok || json.degraded || !matrix) {
        return { ok: true, kind: 'table', degraded: true, reason: json.reason ?? 'no-matrix',
          next_action: json.next_action ?? '先让供应商提交报价（人签），再来比价',
          columns: [{ key: 'item_id', label: '行项目' }], rows: [] }
      }
      const rows = []
      // **外部行数组（工具 JSON 的 `matrix.items` / `item.cells`）走唯一入口**：坏行逐条计数、好行照列
      const matrixRead = readRows(matrix.items)
      const matrixRows = matrixRead.rows
      let droppedCells = 0
      for (const item of matrixRows) {
        const cellRead = readRows(item.cells)
        droppedCells += cellRead.dropped
        const cellRows = cellRead.rows
        for (const cell of cellRows) {
          rows.push({ id: `${item.item_id}:${cell.quote_id}`, item_id: item.item_id, qty: item.qty,
            item_min_cents: item.min_unit_price_cents, spread_pct: item.spread_pct,
            quote_id: cell.quote_id, supplier: cell.supplier,
            unit_price_cents: cell.missing ? `（未报此行）` : cell.unit_price_cents,
            line_total_cents: cell.missing ? '' : cell.line_total_cents,
            delta_pct: cell.missing ? '' : cell.delta_pct_vs_item_min,
            normalized: cell.missing ? '' : cell.normalized,
            contribution: cell.missing ? '' : cell.contribution,
            cheapest: cell.is_item_min ? '★ 本行最低' : '' })
        }
      }
      return { ok: true, kind: 'table',
        columns: [
          { key: 'item_id', label: '行项目', type: 'code', pin: 'left' },
          { key: 'qty', label: '量', filter: 'number' },
          { key: 'item_min_cents', label: '本行最低价（分）' },
          { key: 'spread_pct', label: '本行价差 %', filter: 'number' },
          { key: 'quote_id', label: '报价', type: 'code' },
          { key: 'supplier', label: '供应商', type: 'code' },
          { key: 'unit_price_cents', label: '单价（分）', filter: 'number' },
          { key: 'line_total_cents', label: '行合计（分）' },
          { key: 'delta_pct', label: '与本行最低价差 %', filter: 'number' },
          { key: 'normalized', label: 'per-item 归一（0=本行最低）' },
          { key: 'contribution', label: '本行对本家价格分的贡献' },
          { key: 'cheapest', label: '本行最便宜' },
        ],
        rows, bulk: 'compare.rank',
        counts: { ...(matrix.counts ?? {}), dropped: (matrixRead.dropped + droppedCells) },
        note: '单元格口径：`_minmax(价, 本行最低, 本行最高)`（per-item 归一）——'
          + '不同行项目之间不比（量纲不同）；量从本侧包快照的清单取；缺报的行明确标「未报此行」。'
          + '全局名次仍是跨报价 minmax 的口径（上方排名表），两者不混算。'
          + ` 当前权重来源：${weightsSource()}`
          + (droppedCells ? ` 另有 ${droppedCells} 个单元格读不出来（形状异常：不是对象）—— 已跳过并计数，不静默丢。` : '') }
    } }))

  // ---- ④ 并排对比（宽表：行=同一行项目，列=各家报价的一组列；勾 2–3 家进对比模式） ----------------
  out.push(surface.panel({ plugin_id: me, id: 'compare.side-by-side', title: '并排对比（各行项目 × 各家报价，关键列固定）',
    view: 'contractor', order: 33, kind: 'table', actions: ['compare.rank'],
    data: () => {
      const weights = weightsNow()
      const { json, matrix } = matrixOf(weights)
      if (!json.ok || json.degraded || !matrix) {
        return { ok: true, kind: 'table', degraded: true, reason: json.reason ?? 'no-matrix',
          next_action: json.next_action ?? '先让供应商提交报价（人签），再来比价',
          columns: [{ key: 'item_id', label: '行项目' }], rows: [] }
      }
      const items = matrix.items ?? []
      // 列组 = 一份报价（`group` 用 quote_id，标题带供应商）；行项目一列固定、量一列常显。
      const quotes = []
      for (const item of items) {
        for (const cell of item.cells ?? []) {
          if (quotes.some((row) => row.quote_id === String(cell.quote_id))) continue
          quotes.push({ quote_id: String(cell.quote_id), supplier: String(cell.supplier ?? '') })
        }
      }
      const columns = [
        { key: 'item_id', label: '行项目（固定列）', type: 'code', pin: 'left' },
        { key: 'qty', label: '量', filter: 'number' },
        { key: 'item_min_cents', label: '本行最低（分）', best_when: 'min' },
      ]
      for (const quote of quotes) {
        columns.push({ key: `u__${quote.quote_id}`, label: `${quote.supplier} 单价（分）`,
          group: quote.quote_id, group_label: `${quote.supplier} ${quote.quote_id}`, best_when: 'min' })
        columns.push({ key: `t__${quote.quote_id}`, label: `${quote.supplier} 行合计（分）`,
          group: quote.quote_id })
      }
      const rows = items.map((item) => {
        const row = { id: String(item.item_id), item_id: String(item.item_id), qty: item.qty,
          item_min_cents: item.min_unit_price_cents }
        for (const quote of quotes) {
          const cell = (item.cells ?? []).find((one) => String(one.quote_id) === quote.quote_id) ?? null
          row[`u__${quote.quote_id}`] = !cell ? '' : (cell.missing ? '（未报此行）' : cell.unit_price_cents)
          row[`t__${quote.quote_id}`] = !cell || cell.missing ? '' : cell.line_total_cents
        }
        return row
      })
      return { ok: true, kind: 'table', columns, rows,
        compare: { min: 2, max: 3, hint: '勾 2–3 家并排比较（勾多了先取消一个）' },
        group_totals: { key_prefix: 't__', label_suffix: '行合计总和（分）' },
        counts: { items: items.length, quotes: quotes.length, ...(matrix.counts ?? {}) },
        note: '对比模式：勾选上面的列组（2–3 家）= 只把这几家并排摆出来；「行项目」列固定不随横向滚动跑掉。'
          + '单元格口径是同一行项目内的 minmax（不同行项目不比量纲），每行最低价那格标绿；'
          + '底部给每组"行合计总和"。整表事实来源与「比较矩阵」完全相同（同一份只读复算，零新增事实）。' }
    } }))

  out.push(surface.panel({ plugin_id: me, id: 'compare.contributions', title: '贡献分解（全局五分量 vs 矩阵价格贡献）',
    view: 'contractor', order: 34, kind: 'table',
    data: () => {
      const weights = weightsNow()
      const { json, ranking, matrix } = matrixOf(weights)
      if (!json.ok || json.degraded || !ranking.length) {
        return { ok: true, kind: 'table', degraded: true, reason: json.reason ?? 'no-ranking',
          next_action: json.next_action ?? '等报价进来再分解', columns: [{ key: 'quote_id', label: '报价' }], rows: [] }
      }
      const matrixOf2 = new Map((matrix?.quote_summary ?? []).map((row) => [row.quote_id, row]))
      return { ok: true, kind: 'table',
        columns: [
          { key: 'rank', label: '名次', filter: 'number' }, { key: 'quote_id', label: '报价', type: 'code' },
          { key: 'score', label: '总分（越小越前）', filter: 'number' },
          { key: 'components', label: '五分量贡献（全局 minmax）' },
          { key: 'matrix_contribution', label: '矩阵价格贡献（per-item）' },
          { key: 'citations', label: '引用链' },
        ],
        rows: ranking.map((row) => ({ id: row.quote_id, rank: row.rank, quote_id: row.quote_id, score: row.score,
          components: Object.entries(row.components ?? {}).map(([key, comp]) => `${LABELS[key] ?? key}=${comp.value}`).join(' · '),
          matrix_contribution: matrixOf2.get(row.quote_id)?.matrix_price_contribution ?? '',
          citations: (row.citations ?? []).slice(0, 3).join(' ') })),
        counts: { ranked: ranking.length },
        note: `权重：${weightsText(weights)}（来源：${weightsSource()}）· `
          + '左列是跨报价的口径（决定名次），右列是同一行项目内的口径（解释"这一行为什么贵/便宜"）；'
          + '两者都不隐藏，页面不把它们混成一个数' }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'compare.save-weights', title: '保存权重为插件配置（并落一条事实）',
    views: ['contractor'], group: '比价', order: 25,
    confirm: { required: true, message: '保存这组权重：写插件配置 + 落一条 compare/rank-computed（不改任何判定）：确认？' },
    hint: '权重存成插件配置（<ui-shared>/compare/weights.json，下次打开还在）+ 落 compare/rank-computed',
    // **乐观并发**（机制）：这个动作保存的是"本侧当前这组比价权重"（一份全局配置，后写就盖前写）——
    // 两个同事先后改权重时，后改的人被**明确拒绝**并看到"谁在何时把哪个分量从多少改成了多少"。
    concurrency: { object_class: 'compare-weights', label: '本侧当前这组比价权重',
      object_id: () => 'current',
      state: (ctx, input) => ({ price: String(input.w_price ?? DEFAULTS.price),
        delivery: String(input.w_delivery ?? DEFAULTS.delivery),
        payment: String(input.w_payment ?? DEFAULTS.payment),
        warranty: String(input.w_warranty ?? DEFAULTS.warranty),
        deviation: String(input.w_deviation ?? DEFAULTS.deviation), by: asText(input.actor) }) },
    input: { fields: [
      { name: 'w_price', label: '权重：单价', type: 'number', min: 0, max: 1, default: DEFAULTS.price },
      { name: 'w_delivery', label: '权重：交期', type: 'number', min: 0, max: 1, default: DEFAULTS.delivery },
      { name: 'w_payment', label: '权重：付款条件', type: 'number', min: 0, max: 1, default: DEFAULTS.payment },
      { name: 'w_warranty', label: '权重：质保', type: 'number', min: 0, max: 1, default: DEFAULTS.warranty },
      { name: 'w_deviation', label: '权重：偏差计数', type: 'number', min: 0, max: 1, default: DEFAULTS.deviation },
      { name: 'package_id', label: '包 id', type: 'text', required: true, from_row: true,
        help: '要针对哪个包存这组权重（它就是「比价排名」表里的「包」那一列；行内那颗按钮会把整行带入）' },
      { name: 'actor', label: '发言人', type: 'text', required: true, identity: true, help: 'human:<你的名字>' },
    ] },
    server: async (ctx, input) => {
      const weights = { price: Number(input.w_price ?? DEFAULTS.price), delivery: Number(input.w_delivery ?? DEFAULTS.delivery),
        payment: Number(input.w_payment ?? DEFAULTS.payment), warranty: Number(input.w_warranty ?? DEFAULTS.warranty),
        deviation: Number(input.w_deviation ?? DEFAULTS.deviation) }
      const actor = asText(input.actor)
      if (!actor.startsWith('human:')) {
        return { ok: false, code: 'human-required', reason: '存权重也要有人认领：actor 以 human: 开头',
          next_action: '写 human:<你的名字>' }
      }
      const staged = host.stage('compare-apply', { kind: 'compare-apply', action: 'weights', view: 'contractor',
        package_id: asText(input.package_id), weights, actor, note: `保存权重：${weightsText(weights)}` })
      if (!staged.ok) return staged
      const run = host.runPython(applyTool, ['--step', 'weights', '--request', staged.path,
        '--ui-shared', host.sharedDir, '--ledger-contractor', asText(host.config?.ledger_contractor),
        '--now', host.now()])
      const json = run.json ?? {}
      if (json.ok === true) host.note.set(me, NOTE_KEY, weights)
      return { ok: run.ok && json.ok === true, code: json.refusal?.code ?? (json.ok ? 'weights-saved' : 'writer-failed'),
        reason: json.refusal?.reason ?? run.reason ?? '',
        next_action: json.refusal?.next_action ?? json.next_action_runtime ?? '看 result 里的配置路径与账本增量',
        result: { pending: staged.file, config: json.config ?? null, ledger_added: json.ledger_added ?? 0,
          evaluation_id: json.evaluation_id ?? null, duplicates: json.duplicates ?? [] } }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'compare.export', title: '导出比价表（排名 CSV + 矩阵 CSV + 人读 TXT）',
    views: ['contractor'], group: '比价', order: 27, object_kind: 'package',
    confirm: { required: true, message: '导出会写文件并落一条 compare/table-exported（导出留痕）：确认？' },
    hint: '导出三份文件：排名表 CSV + 同一行项目内的矩阵 CSV + 人读正文 TXT（同一份评估、不重算），'
      + '并落一条 compare/table-exported（行数/字节数/evaluation_id）。可打印的 HTML 走工具栏那条'
      + '「比价表（CSV / 可打印 HTML）」（`compare.print`：只给 csv / html **两种**格式，没有 txt）；'
      + '人读 TXT 只有这条导出会落盘。入口：包的对象页工具栏（对象地址预填「包 id」）、'
      + '「比价排名」行内那颗按钮（按整行预填）、命令面板（缺上下文时先挑一条）',
    input: { fields: [
      { name: 'w_price', label: '权重：单价', type: 'number', min: 0, max: 1, default: DEFAULTS.price },
      { name: 'w_delivery', label: '权重：交期', type: 'number', min: 0, max: 1, default: DEFAULTS.delivery },
      { name: 'w_payment', label: '权重：付款条件', type: 'number', min: 0, max: 1, default: DEFAULTS.payment },
      { name: 'w_warranty', label: '权重：质保', type: 'number', min: 0, max: 1, default: DEFAULTS.warranty },
      { name: 'w_deviation', label: '权重：偏差计数', type: 'number', min: 0, max: 1, default: DEFAULTS.deviation },
      { name: 'package_id', label: '包 id', type: 'text', required: true, from_route: true,
        help: '要导出哪一个包：**在包的对象页上会自动填当前这一条**；视图页上从「比价排名」那一行进来'
          + '（行内那颗按钮把整行带入）或从命令面板先挑一条' },
      { name: 'actor', label: '发言人', type: 'text', required: true, identity: true, help: 'human:<你的名字>' },
    ] },
    server: async (ctx, input) => {
      const weights = { price: Number(input.w_price ?? DEFAULTS.price), delivery: Number(input.w_delivery ?? DEFAULTS.delivery),
        payment: Number(input.w_payment ?? DEFAULTS.payment), warranty: Number(input.w_warranty ?? DEFAULTS.warranty),
        deviation: Number(input.w_deviation ?? DEFAULTS.deviation) }
      const actor = asText(input.actor)
      if (!actor.startsWith('human:')) {
        return { ok: false, code: 'human-required', reason: '导出要有人认领：actor 以 human: 开头',
          next_action: '写 human:<你的名字>' }
      }
      const staged = host.stage('compare-apply', { kind: 'compare-apply', action: 'export', view: 'contractor',
        package_id: asText(input.package_id), weights, actor, note: `导出比价表：${weightsText(weights)}` })
      if (!staged.ok) return staged
      const run = host.runPython(applyTool, ['--step', 'export', '--request', staged.path,
        '--ui-shared', host.sharedDir, '--ledger-contractor', asText(host.config?.ledger_contractor),
        '--now', host.now()])
      const json = run.json ?? {}
      return { ok: run.ok && json.ok === true, code: json.refusal?.code ?? (json.ok ? 'exported' : 'writer-failed'),
        reason: json.refusal?.reason ?? run.reason ?? '',
        next_action: json.refusal?.next_action ?? json.next_action_runtime ?? '看 result 里的三份文件路径与行数',
        result: { pending: staged.file, config: json.config ?? null, ledger_added: json.ledger_added ?? 0,
          evaluation_id: json.evaluation_id ?? null, applied: json.applied ?? [] } }
    } }))

  // ------------------------------------------------------------------ 导出 / 打印（`report` 声明 + 动作）
  /**
   * **比价表导出**（承包商道工具栏上的「导出 / 打印」）：内容 = 本侧账本里**已记录的那一次评估**
   * （`compare/rank-computed` 的 `ranking` / `scores` / `flag_count` / `excluded` / `evaluation_id`），
   * 名次与得分逐行来自账本事实；没有记录过评估时**如实说明**并给只读复算的那一份（绝不编一条名次）。
   */
  out.push(surface.action({ plugin_id: me, id: 'compare.print', title: '导出 / 打印比价表（人读格式）',
    views: ['contractor'], group: '比价', order: 32, icon: 'print',
    hint: '内容 = 本侧账本里已记录的那一次评估（名次/得分/偏差计数）；外壳只做序列化'
      + '（与既有的 `compare.export` 分工：那条把两份 CSV 落盘并留一条 `compare/table-exported` 事实，'
      + '这条给界面内的下载 + 打印）',
    input: { fields: [
      { name: 'format', label: '格式（csv = 表格；html = 可直接打印）', type: 'select', required: true,
        options: ['csv', 'html'], default: 'csv' },
      { name: 'package_id', label: '只看这个包（可空）', type: 'text',
        help: '包 id（如 pkg-g1）；留空 = 本侧全部已记录的评估' },
    ] },
    server: (ctx, input) => {
      const rows = host.rows('contractor')
      const wanted = asText(input.package_id)
      const recorded = rows.filter((row) => String(row?.type ?? '') === 'compare/rank-computed')
        .map((row) => ({ body: (row && typeof row.body === 'object' && row.body !== null ? row.body : {}),
          seq: row.seq, entry_hash: row.entry_hash, ts: row.ts }))
        .filter((item) => wanted === '' || asText(item.body.package_id) === wanted)
      const lines = []
      for (const item of recorded) {
        const body = item.body
        const ranking = Array.isArray(body.ranking) ? body.ranking.map(String) : []
        const scores = body.scores && typeof body.scores === 'object' ? body.scores : {}
        ranking.forEach((quoteId, index) => lines.push({ no: lines.length + 1, rank: index + 1,
          quote_id: quoteId, score: scores[quoteId] ?? '', package_id: asText(body.package_id),
          package_rev: body.package_rev ?? '', flags: body.flag_count ?? 0,
          excluded: (Array.isArray(body.excluded) ? body.excluded : []).map(String).join(' '),
          evaluation_id: asText(body.evaluation_id), ledger_seq: item.seq ?? '',
          source: 'ledger:compare/rank-computed' }))
        for (const quoteId of (Array.isArray(body.excluded) ? body.excluded : []).map(String)) {
          lines.push({ no: lines.length + 1, rank: '（排除）', quote_id: quoteId,
            score: scores[quoteId] ?? '', package_id: asText(body.package_id), package_rev: body.package_rev ?? '',
            flags: body.flag_count ?? 0, excluded: 'yes', evaluation_id: asText(body.evaluation_id),
            ledger_seq: item.seq ?? '', source: 'ledger:compare/rank-computed' })
        }
      }
      if (!lines.length) {
        return { ok: false, code: 'no-recorded-evaluation',
          reason: '本侧账本里还没有已记录的比价评估（`compare/rank-computed`）',
          next_action: '先在「比价」工作区用当前权重排一次（那条只读复算不会落账本），'
            + '或让承包商侧把评估结果落成事实；没有账面记录就不导出一张"看起来像官方表格"的东西' }
      }
      const weights = weightsNow()
      const evaluations = [...new Set(lines.map((line) => line.evaluation_id).filter(Boolean))]
      return host.report({ format: asText(input.format) || 'csv',
        filename: `compare${wanted ? `-${wanted}` : ''}`,
        title: `比价表${wanted ? `（包 ${wanted}）` : ''}`,
        subtitle: `承包商侧导出 · ${lines.length} 行 · 已记录评估 ${evaluations.length} 次`,
        facts: [
          { key: '视图', value: 'contractor（承包商侧账本）' },
          { key: '已记录的评估', value: evaluations.join(' ') || '—' },
          { key: '当前权重（只读复算口径，不落账本）', value: weightsText(weights) },
          { key: '行来源', value: 'ledger:compare/rank-computed（名次/得分/偏差计数逐行来自账本事实）' },
        ],
        columns: [{ key: 'no', label: '#' }, { key: 'rank', label: '名次' }, { key: 'quote_id', label: '报价' },
          { key: 'score', label: '得分（越小越前，minmax 口径）', filter: 'number' }, { key: 'package_id', label: '包' },
          { key: 'package_rev', label: '包版本' }, { key: 'flags', label: '偏差计数' },
          { key: 'excluded', label: '被排除' }, { key: 'evaluation_id', label: '评估 id' },
          { key: 'ledger_seq', label: '账本行号' }, { key: 'source', label: '行来源' }],
        rows: lines,
        notes: ['名次与得分来自账本里已记录的那次评估（不是我现场算的）：这就是"与账面一致"的意思。',
          `权重读数 ${weightsText(weights)} 只说明当前界面上的口径，导出内容不受它影响。`,
          `导出时刻：${host.now()}。`],
        source: '承包商侧账本 compare/rank-computed（compare.export，domain/compare）',
        ledger_refs: recorded.map((item) => ({ type: 'compare/rank-computed', seq: item.seq,
          entry_hash: asText(item.entry_hash), evaluation_id: asText(item.body.evaluation_id) })) })
    } }))

  out.push(surface.report({ plugin_id: me, id: 'report.compare', title: '比价表（CSV / 可打印 HTML）',
    views: ['contractor'], formats: ['csv', 'html'], action: 'compare.print', order: 32,
    // `columns` = 这份导出有哪些列（**元数据**：界面拿它做「列选择」个人偏好；内容仍由 action 生成）。
    // 与 `compare.print` 的 spec.columns 逐字一致 —— 改了这里就要改那里（同一份台账）。
    columns: [{ key: 'no', label: '#' }, { key: 'rank', label: '名次' }, { key: 'quote_id', label: '报价' },
      { key: 'score', label: '得分（越小越前，minmax 口径）', filter: 'number' }, { key: 'package_id', label: '包' },
      { key: 'package_rev', label: '包版本' }, { key: 'flags', label: '偏差计数' },
      { key: 'excluded', label: '被排除' }, { key: 'evaluation_id', label: '评估 id' },
      { key: 'ledger_seq', label: '账本行号' }, { key: 'source', label: '行来源' }],
    hint: '名次/得分/偏差计数逐行来自账本里已记录的那次评估' }))

  // ---- **沙盘场景**：演示流程的第 ③ 段 = **比价**（`compare.rank` 只读：账本零新增）------------------
  out.push(surface.scenario({ plugin_id: me, id: 'scenario.compare-rank', scenario: 'demo.procurement',
    scenario_title: '演示：包 → 报价 → 比价 → 授标 → PO', title: '③ 比价（排名 → 落一条评估事实）',
    view: 'contractor', order: 30, hint: '先按示例权重排一次名（只读），再把这次评估落成一条事实（导出比价表要用它）',
    steps: [{ action: 'compare.rank', input: { package_id: 'DEMO-PKG-001', w_price: 0.6, w_delivery: 0.15,
      w_payment: 0.1, w_warranty: 0.05, w_deviation: 0.1 } },
    // 排完再**把这次评估落成一条事实**（`compare/rank-computed`）：导出/打印比价表要的就是这条记录
    // （只跑 rank 只是"看一眼"，不落账；导出动作会如实说"还没有已记录的评估"）。
    // 不再是可选项：P40 修掉了写者只认单行报价形状的根因（`prepared_of` 现在按 29 §7.5 认 `lines[]`），
    // 所以多行报价在沙盘里也真能落 `compare/rank-computed` —— 这一步失败就是真失败，照实报（不吞）。
    { action: 'compare.save-weights',
      input: { w_price: 0.6, w_delivery: 0.15, w_payment: 0.1,
      w_warranty: 0.05, w_deviation: 0.1, package_id: 'DEMO-PKG-001', actor: '$actor', confirm_ack: '1' } }] }))

  return out
}
