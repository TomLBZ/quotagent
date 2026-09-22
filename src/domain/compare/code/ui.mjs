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
  const weightsNow = () => host.note.get(me, NOTE_KEY, { ...DEFAULTS })
  const weightsText = (weights) => Object.keys(DEFAULTS).map((key) => `${key}=${weights[key] ?? 0}`).join(',')

  const runRank = (weights, packageId, quoteIds) => {
    const args = ['--ui-shared', host.sharedDir,
      '--ledger-contractor', asText(host.config?.ledger_contractor),
      '--weights', weightsText(weights)]
    if (packageId) args.push('--package-id', packageId)
    const run = host.runPython('src/domain/compare/tools/compare-rank.py', args)
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
          { key: 'score', label: '得分（越高越前）' },
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

  return out
}
