/**
 * 进树模块：`webui`（WebUI 插件，每方视角一个路由）。
 *
 * 用户要求（2026-09-21）：
 *   · 项目的每个功能都应由**插件**提供 → 本文件是 cordis 插件（manifest 同其它进树模块）；
 *   · WebUI 要能**从现有 dashboard 访问** → 由工作区 `ws-gateway` 以路由前缀转发（见 `docs/work/deployment-manual.md`）；
 *   · **不同 routes 提供双方视角可见的不同 UI** → `/quotagent/contractor/*` 与 `/quotagent/supplier/*`；
 *   · 私域不出 realm → 每个视角只在**自己的白名单**里投影（供应商视角永远拿不到承包商私域键）。
 *
 * 零残留（A2）：HTTP server 由 `ctx.effect()` 注册，dispose 即 `server.close()`（端口释放）。
 */
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { array, number, object, string } from '../lib/std-schema.mjs'
import { openLedger } from '../lib/ledger-view.mjs'

export const name = 'webui'

export const inject = ['ledgerView', 'projection', 'governor', 'observability', 'priceHistory', 'evidenceSummary', 'opsView', 'evolveJournal', 'supplierScorecard', 'approvalDigest', 'retentionView', 'pipelineView', 'adminGuard', 'adminView', 'pluginMarket']   // 每个都是独立插件（准入 / 观测 / 视图 / 系统管理 / 市场）

export const builtin = []   // 本模块不使用事件：声明即事实（D-015 / A1 双向断言）

export const usedServices = ['ledgerView', 'projection', 'governor', 'observability', 'priceHistory', 'evidenceSummary', 'opsView', 'evolveJournal', 'supplierScorecard', 'approvalDigest', 'retentionView', 'pipelineView', 'adminGuard', 'adminView', 'pluginMarket']

export const provides = ['webui']

export const Config = object({
  route_prefix: string().default('/quotagent'),
  listen_host: string().default('127.0.0.1'),
  port: number().default(8093),
  views: array(string()).default(['contractor', 'supplier']),
  page_title: string().default('quotagent 控制台'),
  // 每个视角**读自己的账本**（结构性隔离：对方的账本根本不在本视角的读取路径上）
  ledger_contractor: string().default(''),
  ledger_supplier: string().default(''),
  ledger_evolve: string().default(''),   // 自进化账本（运维视角读它的**归纳**，不出正文）
  retention_plan: string().default(''),  // 留存计划的**绝对路径**（生产 cwd≠仓库根，相对路径会读不到）
  pipeline_snapshot: string().default(''),  // 三域快照的**绝对路径**（同上）
  admin_snapshot: string().default(''),     // 系统管理快照（阻塞/进度）的**绝对路径**（同上）
  admin_inbox: string().default(''),        // 待处理提交目录（宿主写这里；Only Python 消费，账号不写账本）
})

const html = (title, body, prefix) => `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>${title}</title><style>body{font:14px/1.6 system-ui,sans-serif;margin:2rem;max-width:60rem}
code{background:#f3f3f3;padding:.1em .3em;border-radius:3px}table{border-collapse:collapse;width:100%}
td,th{border:1px solid #ddd;padding:.35rem .5rem;text-align:left;font-size:13px}
nav a{margin-right:1rem}</style></head><body><nav>
<a href="${prefix}/">总览</a><a href="${prefix}/contractor/">承包商视角</a><a href="${prefix}/supplier/">供应商视角</a>
<a href="${prefix}/admin/">系统管理</a><a href="${prefix}/api/status">/api/status</a><a href="${prefix}/api/health">/api/health</a>
</nav><h1>${title}</h1>${body}</body></html>`

export function apply(ctx, config) {
  const projection = ctx.projection            // 投影服务（真源在 host/modules/projection.mjs）
  const rules = projection.rules
  const prefix = config.route_prefix.replace(/\/$/, '')
  // 视角 → 账本：配了自有账本就用它（结构性隔离），否则退回注入的只读视图（fixture/单账本模式）
  const ledgerOf = (view) => {
    const own = view === 'contractor' ? config.ledger_contractor : config.ledger_supplier
    return own ? openLedger(own) : ctx.ledgerView
  }

  const rowsFor = (view) => {
    const { publicRows, audit } = projection.projectWithAudit(view, ledgerOf(view).rows())
    if (audit.length) {
      // 审计只走 stderr（宿主日志）；响应体里不得出现私域键名
      console.error(`[webui] ${view} 视角抑制 ${audit.length} 行：${audit.map((item) => item.suppressed_key).join(',')}`)
    }
    return publicRows
  }

  const governor = ctx.governor
  const server = createServer(async (req, res) => {
    try {
      // 运行期准入（独立插件 governor）：背压 → 429 + Retry-After（**可解释**）；超时 → 504；其它 → 500。
      // 默认配置（capacity 64 / timeout 5s）等价于直通，升级路径零影响。
      const key = `webui:${String(req.url ?? '/').split('?')[0]}`
      const routed = await governor.run({ key, fn: async () => handle(req, res) }).catch((err) => sendGovernorError(res, err))
      return routed === null ? undefined : routed?.result
    } catch (err) {
      // 服务不得被单个请求杀死（实测教训）：先尽量回 500，再自报日志
      console.error(`[webui] 请求处理失败 ${req.url}：${String(err).slice(0, 160)}`)
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'internal-error', detail: String(err).slice(0, 120) }) + '\n')
      } else {
        res.end()
      }
      return undefined
    }
  })

  const obs = ctx.observability   // 本地句柄（D-027：不按请求去 ctx 里查自己依赖的服务）
  const history = ctx.priceHistory
  const evidence = ctx.evidenceSummary   // 账本证据面（第二个自进化产出，T-239）
  const ops = ctx.opsView               // 运维视角（第四个自进化产出，T-243）
  const journal = ctx.evolveJournal     // 自进化流水（第五个自进化产出，T-245）
  const scorecard = ctx.supplierScorecard   // 供应商绩效记分卡（subagent 产出，T-247）
  const approvals = ctx.approvalDigest      // 人工门待批摘要（subagent 产出，T-250）
  const retention = ctx.retentionView       // 留存计划的只读聚合（subagent 产出，T-254）
  const pipeline = ctx.pipelineView         // 三域运维快照的只读聚合（subagent 产出，T-260）
  const adminGuard = ctx.adminGuard         // 管理员 token / 会话 / 冷却（subagent 产出，T-272）
  const adminView = ctx.adminView           // 系统管理快照的只读聚合（同上）
  const pluginMarket = ctx.pluginMarket      // 插件列表/市场的只读聚合（subagent 产出，T-267）

  /** 三域快照（谈判/FAQ/邮件）：由 Python 侧写入 `tmp/ui-shared/pipeline.json`，宿主只读。 */
  const pipelinePayload = () => {
    const file = String(config.pipeline_snapshot ?? '') ||
      join(String(config.ui_shared ?? 'tmp/ui-shared'), 'pipeline.json')
    try { return JSON.parse(readFileSync(file, 'utf8')) } catch (err) { return null }
  }

  /**
   * 留存计划：**判定在 Python 侧**（`services/retention.py`），由维护任务落到
   * `tmp/ui-shared/retention-plan.json`；这里只读文件并交给 `retention-view` 聚合。
   * 文件缺失或损坏 → 交给插件降级（degraded），**不自己算留存**。
   */
  const retentionPlanOf = (view) => {
    const file = String(config.retention_plan ?? '') ||
      join(String(config.ui_shared ?? 'tmp/ui-shared'), 'retention-plan.json')
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      const entry = parsed?.views?.[view]
      return entry?.plan ?? null
    } catch (err) {
      return null
    }
  }
  /**
   * 从账本行推导**当前仍待批**的事项：按 `approval_id` 取该项的**最后一条** `approval/*` 事件，
   * 若最后状态是 granted/aborted 就不算待批。只读、只用公开行（门里断言响应不含正文与私域键）。
   */
  const pendingApprovals = (view) => {
    const last = new Map()
    for (const row of ledgerOf(view).rows()) {
      const type = String(row?.type ?? '')
      if (!type.startsWith('approval/')) continue
      const id = String(row?.body?.approval_id ?? row?.approval_id ?? '')
      if (!id) continue
      last.set(id, row)
    }
    return [...last.values()].filter((row) => {
      const type = String(row.type)
      return type !== 'approval/granted' && type !== 'approval/aborted'
    })
  }
  /** 自进化账本行的只读读取（读不到就当空：运维页不能因为账本还没生成而崩） */
  const evolveRows = () => {
    if (!config.ledger_evolve) return []
    try { return openLedger(config.ledger_evolve).rows() } catch (err) { return [] }
  }
  /**
   * 价格序列的输入：**原始行**的 `body.lines[]`，但只取非私域字段（`item_id` / `unit_price`）。
   * 为什么要用原始行：投影层只保留 `seq/type/summary/ts`，价格明细会被截掉（实测 groups=0）。
   * 为什么这样仍然安全：只输出这两个字段，其中任何一个都不在本视角的 `privateKeys` 里；
   * 并且这里**额外做一次私域键过滤**（纵深防御，与本文件既有的"抑制原因对外通用"同一纪律）。
   */
  const priceRows = (view) => {
    const rule = rules[view] || { privateKeys: [] }
    return ledgerOf(view).rows().flatMap((row) => {
      const lines = row && row.body && Array.isArray(row.body.lines) ? row.body.lines : []
      return lines
        .filter((line) => line && line.item_id !== undefined && line.unit_price !== undefined
          && !Object.keys(line).some((key) => rule.privateKeys.includes(key)))
        .map((line) => ({ supplier_id: String(line.item_id), unit_price: line.unit_price }))
    })
  }
  /** price-history 插件按 `key_field` 分组；UI 侧把分组键统一叫 group（插件字段名是实现细节） */
  const seriesView = (view) => history.bySupplier(priceRows(view))
    .map((item) => ({ group: item.supplier_id, count: item.count, min: item.min, median: item.median,
      max: item.max, latest: item.latest, trend: item.trend }))
  const handle = (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) || '/' : url.pathname
    const send = (code, type, payload, extraHeaders = {}) => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...extraHeaders })
      res.end(payload)
    }
    // 回调式读体（本处理函数不是 async：不引入 await，避免吞掉异常）
    const readBody = (done) => {
      let data = ''
      req.on('data', (chunk) => { if (data.length < 16384) data += chunk })
      req.on('end', () => done(data))
      req.on('error', () => done(''))
    }
    const json = (code, payload) => send(code, 'application/json; charset=utf-8',
      JSON.stringify(payload, null, 2) + '\n')

    if (path === '/api/health') return json(200, { status: 'ok', service: 'quotagent-webui' })
    if (path === '/api/obs') {
      // 运行期观测（只读）：governor 准入 / audit 留痕 / canary 分流——双方视角都可见（不含私域）
      const snap = obs.snapshot()
      return json(200, { service: 'quotagent-webui', observability: snap, summary: obs.summary() })
    }
    if (path === '/api/status') {
      const ledgers = {}
      for (const view of config.views) {
        const ledger = ledgerOf(view)
        try {
          const report = ledger.verify()
          ledgers[view] = { path: ledger.path, count: report.count, healthy: report.ok, head: report.head }
        } catch (err) {
          ledgers[view] = { path: ledger.path, healthy: false, reason: String(err).slice(0, 80) }
        }
      }
      return json(200, { service: 'quotagent-webui', route_prefix: prefix, views: config.views,
        ledgers, routes: config.views.map((view) => `${prefix}/${view}/`) })
    }
    if (path === '/ops/' || path === '/ops') {
      // 运维视角：不属于任何一方（业务视角各读自己的账本；运维看的是"系统整体"）
      const runtime = ops.snapshot({ rows: [] })
      const perView = Object.fromEntries(config.views.filter((view) => rules[view])
        .map((view) => [view, ops.snapshot({ rows: rowsFor(view) }).evidence]))
      const rowsHtml = config.views.filter((view) => rules[view]).map((view) => {
        const ev = perView[view]
        return `<tr><td>${view}</td><td>${ev.rows}</td><td>${ev.types}</td><td>${ev.correlations}</td>`
          + `<td>${ev.rows_with_refs}</td><td>${ev.span.first ?? '—'} → ${ev.span.last ?? '—'}</td></tr>`
      }).join('')
      const g = runtime.runtime.governor
      const b = runtime.breaker.stats
      return send(200, 'text/html; charset=utf-8',
        html(`${config.page_title} · 运维视角`,
          `<p>本视角**不属于任何一方**：只看系统整体（运行期中间件状态 + 各视角账本的证据面聚合），不显示条目正文与私域键。</p>`
          + `<p>JSON：<code>${prefix}/api/ops</code></p>`
          + `<h3>运行期</h3><p>${ops.summary({ rows: [] })}</p>`
          + `<table><tr><th>governor</th><th>breaker</th></tr>`
          + `<tr><td>admitted=${g.admitted ?? 0} refused=${g.refused ?? 0} timeouts=${g.timeouts ?? 0} failed=${g.failed ?? 0}</td>`
          + `<td>allowed=${b.allowed ?? 0} refused=${b.refused ?? 0} opened=${b.opened ?? 0} closed=${b.closed ?? 0}</td></tr></table>`
          + `<h3>三域流水（谈判 / FAQ / 邮件）</h3><p>由 subagent 产出并晋升的插件 <code>pipeline-view</code> 聚合：<b>${pipeline.headline(pipelinePayload())}</b></p>`
          + `<p>邮件：运输通道 <b>${(pipeline.snapshot(pipelinePayload()).transport || {}).available ? '可用' : '不可用'}</b>（本轮无凭据，故必须报不可用）</p>`
          + `<h3>留存计划（只读）</h3><p>判定在 Python 侧（<code>services/retention.py</code>），由 subagent 产出并晋升的插件 <code>retention-view</code> 聚合：<b>${retention.headline(retentionPlanOf('contractor'))}</b></p>`
          + `<p>账本行永不销毁；销毁只作用于派生副本，不可重建物须过人工门（ADR-0018）</p>`
          + `<h3>自进化流水</h3><p>由自进化产出的插件 <code>evolve-journal</code> 归纳（只给计数，不出正文）</p>`
          + (() => {
            const ev = journal.summarize(evolveRows())
            return `<p>提案 <b>${ev.proposed}</b> / 影子 <b>${ev.shadowed}</b> / 门 <b>${ev.gated.passed}</b> 过 `
              + `<b>${ev.gated.rejected}</b> 拒 / 晋升 <b>${ev.promoted}</b> / 回滚 <b>${ev.rolled_back}</b> / `
              + `canary 进 <b>${ev.canary.entered}</b> 出 <b>${ev.canary.exited}</b>；最近 <code>${ev.last_event ?? '—'}</code></p>`
          })()
          + `<h3>各视角账本证据面（聚合）</h3>`
          + `<table><tr><th>视角</th><th>行数</th><th>类型数</th><th>关联数</th><th>带引用行</th><th>时间跨度</th></tr>${rowsHtml}</table>`,
          prefix))
    }
    if (path === '/api/ops') {
      const runtime = ops.snapshot({ rows: [] })
      const perView = Object.fromEntries(config.views.filter((view) => rules[view])
        .map((view) => [view, ops.snapshot({ rows: rowsFor(view) }).evidence]))
      return json(200, { view: 'ops', source: 'ops-view（自进化产出的插件）', summary: ops.summary({ rows: [] }),
        runtime: runtime.runtime, breaker: runtime.breaker, evidence_by_view: perView,
        evolve_journal: journal.summarize(evolveRows()),
        retention: retention.snapshot(retentionPlanOf('contractor')),
        retention_headline: retention.headline(retentionPlanOf('contractor')),
        note: '运维视角：不属于任何一方；只给聚合数字与状态，不给条目正文/私域键' })
    }
    const viewMatch = path.match(/^\/([a-z]+)\/?$/)
    if (viewMatch && rules[viewMatch[1]]) {
      const view = viewMatch[1]
      const rows = rowsFor(view)
      const table = `<table><tr><th>seq</th><th>type</th><th>摘要</th><th>ts</th></tr>${
        rows.slice(-40).reverse().map((row) => row.suppressed
          ? `<tr><td>${row.seq}</td><td>${row.type}</td><td>（已抑制：${row.reason}）</td><td></td></tr>`
          : `<tr><td>${row.seq}</td><td>${row.type}</td><td>${row.summary || ''}</td><td>${row.ts || ''}</td></tr>`).join('')}</table>`
      return send(200, 'text/html; charset=utf-8',
        html(`${config.page_title} · ${rules[view].title}`,
          `<p>本视角只显示 <code>${rules[view].types.join(' ')}</code> 的事件；`
          + `供应商视角显式拒收私域键 <code>${rules.supplier.privateKeys.join(' ')}</code>。</p>`
          + `<p>JSON：<code>${prefix}/${view}/api/events</code> · <code>${prefix}/${view}/api/history</code> · <code>${prefix}/${view}/api/evidence</code></p>`
          + (() => {
            const s = evidence.summarize(rows)
            const span = s.span
            return `<h3>账本证据面</h3><p>由自进化产出的插件 <code>evidence-summary</code> 计算：`
              + `共 <b>${s.rows}</b> 行 / <b>${s.types}</b> 种类型 / <b>${s.correlations}</b> 个关联 / `
              + `<b>${s.rows_with_refs}</b> 行带引用；时间跨度 <code>${span.first ?? '—'}</code> → <code>${span.last ?? '—'}</code></p>`
          })()
          + (() => {
            const sc = scorecard.bySupplier(ledgerOf(view).rows())
            if (!sc.length) return '<h3>供应商绩效记分卡</h3><p>（本视角暂无可聚合的供应商行）</p>'
            return `<h3>供应商绩效记分卡</h3><p>由 subagent 产出、经自进化流程晋升的插件 <code>supplier-scorecard</code> 计算</p>`
              + `<table><tr><th>供应商</th><th>报价次数</th><th>最低</th><th>中位</th><th>最高</th><th>平均交期(天)</th><th>偏差标记</th></tr>${
                sc.map((s) => `<tr><td>${s.supplier_id}</td><td>${s.quote_count}</td><td>${s.min_unit_price}</td>`
                  + `<td>${s.median_unit_price}</td><td>${s.max_unit_price}</td><td>${s.avg_lead_time_days}</td>`
                  + `<td>${s.deviation_count}</td></tr>`).join('')}</table>`
          })()
          + `<form method="post" action="${prefix}/admin/api/elevate">`
          + `<label>管理员 token（提权为系统管理）：<input name="token" type="password" autocomplete="off"></label>`
          + `<button type="submit">提权</button></form>`
          + (() => {
            const slice = ((pipelinePayload() || {}).views || {})[view] || {}
            const neg = slice.negotiate || {}
            const faq = slice.faq || {}
            const negRecent = (neg.recent || []).map((r) => `${r.thread_id}#${r.attempt_no}(${r.status ?? '—'})`).join(' · ') || '—'
            const faqRecent = (faq.recent || []).map((r) => `${r.entry_id}@rev${r.rfq_rev}`).join(' · ') || '—'
            return `<h3>谈判轮次（本视角）</h3><p>线程 <b>${neg.threads ?? 0}</b> / 轮次 <b>${neg.rounds ?? 0}</b> / 被拒 <b>${neg.rejected ?? 0}</b></p>`
              + `<p>最近：<code>${negRecent}</code></p>`
              + `<h3>FAQ（本视角）</h3><p>条目 <b>${faq.entries ?? 0}</b>（版本 ${(faq.revs || []).join('、') || '—'}）</p>`
              + `<p>最近：<code>${faqRecent}</code></p>`
          })()
          + (() => {
            const pend = approvals.digest(pendingApprovals(view))
            const oldest = approvals.oldest(pendingApprovals(view))
            return `<h3>待批事项（人工门）</h3><p>由 subagent 产出、经自进化流程晋升的插件 <code>approval-digest</code> 归纳：`
              + `共 <b>${pend.total}</b> 项待批；按等待时长 ${pend.by_age.map((b) => `${b.bucket}=${b.count}`).join(' · ')}`
              + `；超过 ${pend.limits.stale_hours}h 的 <b>${pend.stale}</b> 项</p>`
              + (oldest ? `<p>最久等待：<code>${oldest.id}</code>（${oldest.action}，${Math.round(oldest.waited_seconds / 3600)} 小时）</p>` : '')
          })()
          + `<h3>价格序列（按行项目）</h3><p>由自进化产出的插件 <code>price-history</code> 计算</p>`
          + (() => {
            const series = seriesView(view)
            if (!series.length) return '<p>（本视角账本里暂无可比价格行）</p>'
            return `<table><tr><th>行项目</th><th>次数</th><th>最低</th><th>中位</th><th>最高</th><th>最新</th><th>趋势</th></tr>${
              series.map((item) => `<tr><td>${item.group}</td><td>${item.count}</td><td>${item.min}</td>`
                + `<td>${item.median}</td><td>${item.max}</td><td>${item.latest}</td><td>${item.trend}</td></tr>`).join('')}</table>`
          })()
          + table, prefix))
    }
    const viewEvidence = path.match(/^\/([a-z]+)\/api\/evidence\/?$/)
    if (viewEvidence && rules[viewEvidence[1]]) {
      const view = viewEvidence[1]
      // 证据面只统计**公开投影后的行**（type/ts/correlation_id/refs 都在白名单内），不出正文
      const summary = evidence.summarize(rowsFor(view))
      return json(200, { view, source: 'evidence-summary（自进化产出的插件）', summary,
        note: '账本证据面：按类型计数 / 关联数 / 带引用行数 / 时间跨度；只统计公开投影后的行' })
    }
    const viewDomain = path.match(/^\/([a-z]+)\/api\/(negotiation|faq)\/?$/)
    if (viewDomain && rules[viewDomain[1]]) {
      const view = viewDomain[1]
      const domain = viewDomain[2]
      const slice = ((pipelinePayload() || {}).views || {})[view] || {}
      // URL 用业务词（negotiation/faq），快照用域键（negotiate/faq）—— 这里显式对照，别靠名字凑巧相同
      const DOMAIN_KEY = { negotiation: 'negotiate', faq: 'faq' }
      const data = slice[DOMAIN_KEY[domain]] || null
      const out = { view, domain, source: '三域快照（Python 侧写，宿主只读；判定在 services/*）',
        degraded: !data, note: '只给计数与最近事件的 id/序号/状态；不出正文与私域键' }
      if (data) {
        out.counts = Object.fromEntries(Object.entries(data).filter(([, v]) => typeof v === 'number'))
        // **按键投影**而不是原样透传：即使快照里混进正文/私域键，也不出这条路由
        // （D-033/D-053 的"不出正文与私域"在宿主侧也要成立，不能只靠写入器规矩）
        const RECENT_KEYS = { negotiation: ['thread_id', 'attempt_no', 'status'], faq: ['entry_id', 'rfq_rev'] }[domain]
        out.recent = (Array.isArray(data.recent) ? data.recent : []).slice(0, 5)
          .map((row) => Object.fromEntries(RECENT_KEYS.filter((k) => row && Object.prototype.hasOwnProperty.call(row, k)).map((k) => [k, row[k]])))
      }
      return json(200, out)
    }
    if (/^\/api\/pipeline\/?$/.test(path)) {
      const payload = pipelinePayload()
      const snap = pipeline.snapshot(payload)
      return json(200, { source: 'pipeline-view（subagent 产出、经自进化流程晋升）+ 三域服务（Python 侧写快照）',
        pipeline: snap, headline: pipeline.headline(payload),
        note: '谈判/FAQ/邮件三域只给计数与最近事件 id；**本轮没有发信能力**，故 transport.available 恒为 false' })
    }
    if (/^\/api\/retention\/?$/.test(path)) {
      const plan = retentionPlanOf('contractor') ?? retentionPlanOf('supplier')
      const snap = retention.snapshot(plan)
      return json(200, { source: 'retention-view（subagent 产出、经自进化流程晋升）+ services/retention.py（判定）',
        retention: snap, headline: retention.headline(plan),
        note: '留存计划是**判定**不是执行：账本行永不销毁；销毁只作用于派生副本且不可重建物须过人工门' })
    }
    const viewApprovals = path.match(/^\/([a-z]+)\/api\/approvals\/?$/)
    if (viewApprovals && rules[viewApprovals[1]]) {
      const view = viewApprovals[1]
      const rows = pendingApprovals(view)
      const digest = approvals.digest(rows)
      return json(200, { view, source: 'approval-digest（subagent 产出、经自进化流程晋升）',
        digest, by_policy: approvals.byPolicy(rows), oldest: approvals.oldest(rows),
        note: '当前仍待批的事项摘要（按 approval_id 取最后状态推导）；只给计数与等待时长，不出正文' })
    }
    const viewScore = path.match(/^\/([a-z]+)\/api\/scorecard\/?$/)
    if (viewScore && rules[viewScore[1]]) {
      const view = viewScore[1]
      // 与价格序列同因：投影层只留 seq/type/summary/ts，记分卡要的 supplier_id/单价会被截掉 →
      // 所以喂**原始行**，但只输出聚合（门里断言响应不含正文与私域键）
      const groups = scorecard.bySupplier(ledgerOf(view).rows())
      return json(200, { view, source: 'supplier-scorecard（subagent 产出、经自进化流程晋升）',
        groups: groups.length, scorecard: groups,
        note: '按供应商聚合的绩效面（报价次数/价格分布/交期均值/偏差标记数）；输入只来自本视角的公开投影' })
    }
    const viewHistory = path.match(/^\/([a-z]+)\/api\/history\/?$/)
    if (viewHistory && rules[viewHistory[1]]) {
      const view = viewHistory[1]
      const series = seriesView(view)
      return json(200, { view, source: 'price-history（自进化产出的插件）', groups: series.length,
        series, note: '按行项目聚合的价格序列描述统计；输入只来自本视角的公开投影' })
    }
    const viewApi = path.match(/^\/([a-z]+)\/api\/events\/?$/)
    if (viewApi && rules[viewApi[1]]) {
      const rows = rowsFor(viewApi[1])   // 一次请求只投影一次（原先算两遍：canary 采样会翻倍，实测发现）
      return json(200, { view: viewApi[1], count: rows.length, events: rows })
    }
    if (path === '/' || path === '') {
      const rows = config.views.filter((view) => rules[view]).map((view) => {
        const ledger = ledgerOf(view)
        let report = { count: 0, ok: false }
        try { report = ledger.verify() } catch (err) { report = { count: 0, ok: false, reason: String(err).slice(0, 60) } }
        return `<li><a href="${prefix}/${view}/">${rules[view].title}</a>（${report.count} 条，链自洽=${report.ok}）</li>`
      }).join('')
      return send(200, 'text/html; charset=utf-8', html(config.page_title,
        `<ul>${rows}</ul><ul><li><a href="${prefix}/ops/">运维视角</a>（系统整体：运行期中间件 + 各视角证据面聚合）</li></ul>`
        + '<p>本 UI 由 cordis 插件 <code>webui</code> 提供；每个视角读**自己的**账本，宿主不写账本。</p>', prefix))
    }
    // ---- 系统管理道（admin）：未提权一律**统一拒绝体**（缺 token / 错 token / 未启用 / 会话过期 / 冷却 五类同形） ----
    const deny = () => send(401, 'application/json; charset=utf-8', '{"error":"unauthorized"}')
    const adminHtml = (data) => {
      const rows = (data.blocks || []).map((b) => `<tr><td><code>${b.block_id}</code></td><td>${b.kind}</td>`
        + `<td>${b.reason}</td><td>${b.required_action}</td>`
        + `<td><form method="post" action="${prefix}/admin/api/blocks/${encodeURIComponent(b.block_id)}/resolve">`
        + `<input type="hidden" name="kind" value="${b.kind}">`
        + `<input name="material" type="password" autocomplete="off" placeholder="凭据/材料" size="14">`
        + `<button type="submit">提交</button></form>`
        + `<span class="dim">（提交只落待处理项；落账本要人工批准引用）</span></td></tr>`).join('')
      const switchLinks = Object.keys(rules).map((v) => `<a href="${prefix}/admin/api/switch?to=${v}">${v}</a>`).join(' · ')
      return `${data.degraded ? `<p>降级：<code>${data.reason ?? ''}</code> —— ${data.next_action ?? ''}</p>` : ''}`
        + `<p>进度：阶段 <b>${data.progress?.phase ?? '—'}</b> · 下一步 <b>${data.progress?.next_task ?? '—'}</b>`
        + ` · 已完 <b>${data.progress?.done ?? 0}</b> / 待做 <b>${data.progress?.todo ?? 0}</b></p>`
        + `<p>阻塞 <b>${data.counts?.blocked ?? 0}</b> 条（口径：${data.counts?.source ?? '—'}）</p>`
        + `<table><thead><tr><th>block</th><th>kind</th><th>原因</th><th>需要你做的事</th><th>提交材料</th></tr></thead><tbody>${rows}</tbody></table>`
        + `<p>切换视角：${switchLinks}</p>`
        + (() => { const m = pluginMarket.snapshot(); return `<h3>插件市场（只读）</h3>`
            + `<p>共 <b>${m.counts?.total ?? 0}</b> 项（人工 ${m.counts?.human ?? 0} / 自进化 ${m.counts?.evolve ?? 0} / 用户空间 ${m.counts?.user_space ?? 0}）；未装配 <b>${m.counts?.unwired ?? 0}</b>；三源一致 <b>${!m.inconsistent}</b></p>`
            + `<p>${(m.differences || []).map((d) => `<code>${d}</code>`).join(' · ') || '（无差异）'}</p>` })()
    }
    if (/^\/admin\/?$/.test(path)) {
      if (!adminGuard.authorized(req).ok) return deny()
      return send(200, 'text/html; charset=utf-8', html('系统管理', adminHtml(adminView.snapshot()), prefix))
    }
    if (/^\/admin\/api\/session\/?$/.test(path)) {
      return adminGuard.authorized(req).ok ? json(200, { ok: true, view: 'admin' }) : deny()
    }
    if (/^\/admin\/api\/elevate\/?$/.test(path) && String(req.method) === 'POST') {
      return readBody((body) => {
        const submitted = new URLSearchParams(body).get('token') ?? ''
        const out = adminGuard.elevate(submitted)
        if (!out || !out.ok) return deny()        // 失败五类同形：不区分、不泄露、不给 oracle
        send(200, 'application/json; charset=utf-8', '{"ok":true,"view":"admin"}', { 'set-cookie': out.cookie })
      })
    }
    if (/^\/admin\/api\/blocks\/?$/.test(path)) {
      if (!adminGuard.authorized(req).ok) return deny()
      return json(200, adminView.snapshot())
    }
    if (/^\/admin\/api\/blocks\/[^/]+\/resolve\/?$/.test(path) && String(req.method) === 'POST') {
      if (!adminGuard.authorized(req).ok) return deny()
      const blockId = decodeURIComponent(path.split('/')[4] ?? '')
      return readBody((body) => {
        const form = new URLSearchParams(body)
        const fields = {}
        const RESERVED = ['token', 'kind']   // 保留键：不算用户提交的字段（否则只带 kind 的空提交会被误判为有内容）
        for (const [k, v] of form.entries()) { if (!RESERVED.includes(k) && String(v) !== '') fields[k] = String(v) }
        if (Object.keys(fields).length === 0) return json(400, { error: 'no-fields', hint: '至少提交一个字段' })
        const keys = Object.keys(fields).sort()
        const canonical = JSON.stringify(Object.fromEntries(keys.map((k) => [k, fields[k]])))
        const payloadSha = createHash('sha256').update(canonical).digest('hex')
        const bytes = Buffer.byteLength(canonical)
        const record = { block_id: blockId, kind: String(form.get('kind') ?? 'other'), submitted_at: new Date().toISOString(),
          submitted_by: 'admin-session', fields, payload_sha256: payloadSha, bytes, schema: 1 }
        // 只落待处理项（0600、原子写）；**账本零新增**（宿主不写账本），也不回显任何字段值
        const dir = String(config.admin_inbox ?? '')
        if (dir === '') return json(503, { error: 'inbox-unconfigured', hint: '服务未配置 admin_inbox（宿主侧待处理目录）' })
        try {
          mkdirSync(dir, { recursive: true, mode: 0o700 })
          try { chmodSync(dir, 0o700) } catch (err) { /* 同上：FS 不支持时尽力而为 */ }
          const tmp = `${dir}/.${blockId}.${process.pid}.tmp`
          writeFileSync(tmp, JSON.stringify(record) + '\n', { mode: 0o600 })
          try { chmodSync(tmp, 0o600) } catch (err) { /* FS 不支持 POSIX 位时尽力而为 */ }
          renameSync(tmp, `${dir}/${blockId}.json`)
          try { rmSync(tmp, { force: true }) } catch (err) { /* 已 rename 成功，残留清理尽力而为 */ }
        } catch (err) {
          return json(500, { error: 'inbox-write-failed', detail: String(err).slice(0, 120) })
        }
        return send(202, 'application/json; charset=utf-8',
          JSON.stringify({ ok: true, block_id: blockId, payload_sha256: payloadSha, bytes,
            next_action: '等待 Python 侧消费：tools/admin-apply.py --approval-ref ap-NNNN --actor human:<人名>（宿主不写账本）' }))
      })
    }
    if (/^\/admin\/api\/market\/?$/.test(path)) {
      if (!adminGuard.authorized(req).ok) return deny()
      return json(200, pluginMarket.snapshot())
    }
    if (/^\/admin\/api\/switch\/?$/.test(path)) {
      if (!adminGuard.authorized(req).ok) return deny()
      const to = String(url.searchParams.get('to') ?? '')
      if (!Object.prototype.hasOwnProperty.call(rules, to)) return json(400, { error: 'unknown-view', hint: Object.keys(rules).join(' / ') })
      return send(302, 'text/plain; charset=utf-8', '', { location: `${prefix}/${to}/` })
    }
    return json(404, { error: 'not-found', path, hint: `可用：${prefix}/ / ${prefix}/contractor/ / ${prefix}/supplier/ / ${prefix}/ops/ / ${prefix}/api/status / ${prefix}/api/obs / ${prefix}/api/ops / ${prefix}/api/retention / ${prefix}/api/pipeline / ${prefix}/<view>/api/history / ${prefix}/<view>/api/evidence / ${prefix}/<view>/api/scorecard / ${prefix}/<view>/api/approvals / ${prefix}/<view>/api/negotiation / ${prefix}/<view>/api/faq / ${prefix}/admin/ / ${prefix}/admin/api/blocks / ${prefix}/admin/api/elevate / ${prefix}/admin/api/switch?to=<view>` })
  }

  // 零残留：server 是 fiber 的 effect，dispose 即关闭（端口释放）
  ctx.effect(() => () => new Promise((resolve) => server.close(resolve)))

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.listen_host, () => {
      // port=0 → 由内核分配临时端口；实际端口**必须**从 server.address() 读（fixture 靠它做 HTTP 检查）
      const port = server.address().port
      ctx.provide('webui', {
        url: `http://${config.listen_host}:${port}${prefix}/`,
        port,
        prefix,
        viewUrl: (view) => `http://${config.listen_host}:${port}${prefix}/${view}/`,
        rules,                       // 真源：projection 插件
      })
      resolve()
    })
  })
}

/**
 * 运行期错误的 HTTP 映射（**纯函数**，便于单测）：背压 → 429 + `Retry-After`；超时 → 504；其它 → 500。
 * 返回 `null` 表示"已在此处结束响应"，调用方据此短路。抽出来是为了让映射本身可被断言（不依赖慢请求）。
 */
export function sendGovernorError(res, err) {
  const code = err?.code
  const write = (status, payload, headers = {}) => {
    if (!res.headersSent) {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
      res.end(JSON.stringify(payload) + '\n')
    } else { res.end() }
  }
  if (code === 'backpressure') {
    const detail = err.detail ?? {}
    return write(429, { error: 'backpressure', reason: detail.reason, retry_after_ms: detail.retry_after_ms,
      next_action: detail.next_action },
    { 'retry-after': String(Math.ceil((detail.retry_after_ms ?? 0) / 1000)) }), null
  }
  if (code === 'timeout') return write(504, { error: 'timeout', detail: String(err.message).slice(0, 120) }), null
  return write(500, { error: 'internal-error', detail: String(err?.message).slice(0, 120) }), null
}
