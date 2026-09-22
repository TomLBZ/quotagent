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
          { key: 'supplier', label: '供应商', type: 'code' },
          { key: 'score', label: '得分（越小越前，minmax 口径）' },
          { key: 'components', label: '分量贡献（谁拉高了 / 拉低了）' },
          { key: 'citations', label: '引用链' },
        ],
        rows: ranking.map((row) => ({ id: row.quote_id, quote_id: row.quote_id, supplier: row.supplier,
          rank: row.rank, score: row.score,
          components: Object.entries(row.components ?? {}).map(([key, comp]) =>
            `${LABELS[key] ?? key}=${comp.value}`).join(' · '),
          citations: (row.citations ?? []).slice(0, 4).join(' ') })),
        bulk: 'compare.rank',
        counts: { ranked: ranking.length, ...(json.counts ?? {}) },
        note: `本次权重：${weightsText(weights)}（归一由服务保证；同权重下与 Python 侧 services/compare.py 同名次）`
          + ` · 选中若干行再点「用这组权重重排」= 只排这几家` }
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
          items: [{ level: 'info', title: '暂无可比价的报价', body: '本侧账本里还没有已送达的报价事实',
            next_action: '等供应商在 APP 里人签提交报价' }] }
      }
      return { ok: true, kind: 'list', items: ranking.slice(0, 3).map((row) => ({ level: row.rank === 1 ? 'ok' : 'info',
        title: `第 ${row.rank} 名 ${row.quote_id}（得分 ${row.score}）`,
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

  out.push(surface.panel({ plugin_id: me, id: 'compare.matrix', title: '比较矩阵（**同一行项目内**才互相比较）',
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
      for (const item of matrix.items ?? []) {
        for (const cell of item.cells ?? []) {
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
          { key: 'qty', label: '量' },
          { key: 'item_min_cents', label: '本行最低价（分）' },
          { key: 'spread_pct', label: '本行价差 %' },
          { key: 'quote_id', label: '报价', type: 'code' },
          { key: 'supplier', label: '供应商', type: 'code' },
          { key: 'unit_price_cents', label: '单价（分）' },
          { key: 'line_total_cents', label: '行合计（分）' },
          { key: 'delta_pct', label: '与本行最低价差 %' },
          { key: 'normalized', label: 'per-item 归一（0=本行最低）' },
          { key: 'contribution', label: '本行对本家价格分的贡献' },
          { key: 'cheapest', label: '本行最便宜' },
        ],
        rows, bulk: 'compare.rank', counts: { ...(matrix.counts ?? {}) },
        note: '单元格口径：`_minmax(价, **本行**最低, **本行**最高)`（per-item 归一）——'
          + '不同行项目之间**不比**（量纲不同）；量从本侧包快照的清单取；缺报的行明确标「未报此行」。'
          + '全局名次仍是跨报价 minmax 的口径（上方排名表），两者不混算。'
          + ` 当前权重来源：${weightsSource()}` }
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
        { key: 'qty', label: '量' },
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
        note: '**对比模式**：勾选上面的列组（2–3 家）= 只把这几家并排摆出来；「行项目」列固定不随横向滚动跑掉。'
          + '单元格口径是**同一行项目内**的 minmax（不同行项目不比量纲），每行最低价那格标绿；'
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
          { key: 'rank', label: '名次' }, { key: 'quote_id', label: '报价', type: 'code' },
          { key: 'score', label: '总分（越小越前）' },
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
          + '左列是跨报价的口径（决定名次），右列是**同一行项目内**的口径（解释"这一行为什么贵/便宜"）；'
          + '两者都不隐藏，页面不把它们混成一个数' }
    } }))

  out.push(surface.action({ plugin_id: me, id: 'compare.save-weights', title: '保存权重为插件配置（并落一条事实）',
    views: ['contractor'], group: '比价', order: 25,
    confirm: { required: true, message: '保存这组权重：写插件配置 + 落一条 compare/rank-computed（不改任何判定）：确认？' },
    hint: '权重存成插件配置（<ui-shared>/compare/weights.json，**下次打开还在**）+ 落 compare/rank-computed',
    input: { fields: [
      { name: 'w_price', label: '权重：单价', type: 'number', min: 0, max: 1, default: DEFAULTS.price },
      { name: 'w_delivery', label: '权重：交期', type: 'number', min: 0, max: 1, default: DEFAULTS.delivery },
      { name: 'w_payment', label: '权重：付款条件', type: 'number', min: 0, max: 1, default: DEFAULTS.payment },
      { name: 'w_warranty', label: '权重：质保', type: 'number', min: 0, max: 1, default: DEFAULTS.warranty },
      { name: 'w_deviation', label: '权重：偏差计数', type: 'number', min: 0, max: 1, default: DEFAULTS.deviation },
      { name: 'package_id', label: '包 id', type: 'text', required: true, help: '要针对哪个包存这组权重' },
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

  out.push(surface.action({ plugin_id: me, id: 'compare.export', title: '导出比价 CSV（含 per-item 矩阵）',
    views: ['contractor'], group: '比价', order: 27,
    confirm: { required: true, message: '导出会写文件并落一条 compare/table-exported（导出留痕）：确认？' },
    hint: '导出两份 CSV（排名表 + 同一行项目内的矩阵）+ 落 compare/table-exported（行数/字节数/evaluation_id）',
    input: { fields: [
      { name: 'w_price', label: '权重：单价', type: 'number', min: 0, max: 1, default: DEFAULTS.price },
      { name: 'w_delivery', label: '权重：交期', type: 'number', min: 0, max: 1, default: DEFAULTS.delivery },
      { name: 'w_payment', label: '权重：付款条件', type: 'number', min: 0, max: 1, default: DEFAULTS.payment },
      { name: 'w_warranty', label: '权重：质保', type: 'number', min: 0, max: 1, default: DEFAULTS.warranty },
      { name: 'w_deviation', label: '权重：偏差计数', type: 'number', min: 0, max: 1, default: DEFAULTS.deviation },
      { name: 'package_id', label: '包 id', type: 'text', required: true },
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
        next_action: json.refusal?.next_action ?? json.next_action_runtime ?? '看 result 里的 CSV 路径与行数',
        result: { pending: staged.file, config: json.config ?? null, ledger_added: json.ledger_added ?? 0,
          evaluation_id: json.evaluation_id ?? null, applied: json.applied ?? [] } }
    } }))

  return out
}
